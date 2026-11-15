import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createHarness, fauxAssistantMessage, type Harness } from "@earendil-works/pi-coding-agent/testing";
import { Type } from "typebox";
import { afterEach, expect, test } from "vitest";
import { nextEvent, outcomes, settled, text, toolCall, toolCalls } from "../src/faux.ts";

const factory: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "echo",
		label: "Echo",
		description: "Echo the value, failing on `boom`",
		parameters: Type.Object({ value: Type.String() }),
		async execute(_id, params) {
			if (params.value === "boom") throw new Error("exploded");
			return { content: [{ type: "text", text: `echo ${params.value}` }], details: {} };
		},
	});
};

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function start(): Promise<Harness> {
	const harness = await createHarness({ extensionFactories: [factory], settings: { retry: { enabled: false } } });
	harnesses.push(harness);
	return harness;
}

test("builders script real tool-use turns", () => {
	const one = toolCall("echo", { value: "a" });
	expect(one.stopReason).toBe("toolUse");
	expect(one.content).toHaveLength(1);
	const many = toolCalls({ name: "echo", args: { value: "a" } }, { name: "echo", args: { value: "b" } });
	expect(many.content.map((part) => part.type)).toEqual(["toolCall", "toolCall"]);
	expect(toolCalls().content).toEqual([]);
});

test("text extracts every shape a host message or result takes", () => {
	expect(text(undefined)).toBe("");
	expect(text("plain")).toBe("");
	expect(text({})).toBe("");
	expect(text({ content: "direct" })).toBe("direct");
	expect(text({ content: 4 })).toBe("");
	expect(
		text({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text" }, { type: "text", text: "b" }] }),
	).toBe("a\n\n\nb");
});

test("settled and outcomes report settled results in request order with args, including failures", async () => {
	const harness = await start();
	harness.setResponses([
		toolCalls({ name: "echo", args: { value: "one" } }, { name: "echo", args: { value: "boom" } }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("go");
	const results = settled(harness, "echo");
	expect(results.map(({ args, text: body, isError }) => ({ args, body, isError }))).toEqual([
		{ args: { value: "one" }, body: "echo one", isError: false },
		{ args: { value: "boom" }, body: "exploded", isError: true },
	]);
	expect(outcomes(harness, "echo")).toEqual([
		{ text: "echo one", isError: false },
		{ text: "exploded", isError: true },
	]);
	expect(settled(harness, "missing")).toEqual([]);
});

test("settled skips a call that never settled", () => {
	const events = {
		tool_execution_start: [
			{ toolCallId: "1", toolName: "slow", args: {} },
			{ toolCallId: "2", toolName: "other", args: {} },
		],
		tool_execution_end: [],
	};
	const stub = { eventsOfType: (type: keyof typeof events) => events[type] } as unknown as Pick<
		Harness,
		"eventsOfType"
	>;
	expect(settled(stub, "slow")).toEqual([]);
});

test("nextEvent resolves on the first event of a type or the first one a predicate accepts", async () => {
	const harness = await start();
	harness.setResponses([fauxAssistantMessage("hello")]);
	const started = nextEvent(harness, "agent_start");
	const ended = nextEvent(harness, (event) => event.type === "message_end" && event.message.role === "assistant");
	await harness.session.prompt("hi");
	expect((await started).type).toBe("agent_start");
	expect((await ended).type).toBe("message_end");
});
