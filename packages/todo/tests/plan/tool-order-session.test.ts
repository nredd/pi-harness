/**
 * Empty-list work counting through a real `AgentSession`: parallel tool completions reach
 * extensions in completion order and each event awaits the earlier extensions' handlers, so an
 * extension registered before todo can delay todo's view of one completion past a later one.
 * The counter follows the tool-result messages instead, which core emits serially in assistant
 * source order, and reads each one's name and outcome from its completion, which no `message_end`
 * replacement reaches.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ExtensionFactory, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	createHarness,
	createTestUiContext,
	fauxAssistantMessage,
	fauxToolCall,
	type Harness,
} from "@nredd/pi-test-lib/harness";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { EMPTY_REMINDER_MESSAGE_TYPE, TOOL_NAME } from "../../src/tool/types.ts";
import registerTodo from "../fixtures/home-fixtures.ts";
import { TEST_HOME } from "../fixtures/setup.ts";

const config = join(TEST_HOME, ".config", "rpiv-todo", "config.json");
const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	rmSync(config, { force: true });
});

/**
 * Holds todo's completion until the probe's completion has passed every handler, so todo sees
 * the probe first whichever tool finished first. No timers. The hold runs in an extension
 * registered before todo; the release runs in the probe's own handler, registered after todo.
 */
function heldTodo(): { hold: ExtensionFactory; probe: ExtensionFactory } {
	let release!: () => void;
	const probeDone = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		hold: (pi) => {
			pi.on("tool_execution_end", async (event) => {
				if (event.toolName === TOOL_NAME) await probeDone;
			});
		},
		/** A non-todo tool, so the parent does work without a list. */
		probe: (pi) => {
			pi.registerTool({
				name: "probe",
				label: "probe",
				description: "Test probe",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
			});
			pi.on("tool_execution_end", (event) => {
				if (event.toolName === "probe") release();
			});
		},
	};
}

/** Registered before todo: renames every `todo` tool-result message before todo's handler sees it. */
const renameTodoResult: ExtensionFactory = (pi) => {
	pi.on("message_end", (event) => {
		const { message } = event;
		if (message.role === "toolResult" && message.toolName === TOOL_NAME)
			return { message: { ...message, toolName: "renamed" } };
	});
};

async function run(calls: ReturnType<typeof fauxToolCall>[], before: ExtensionFactory[] = []): Promise<Harness> {
	mkdirSync(dirname(config), { recursive: true });
	writeFileSync(config, JSON.stringify({ emptyAfterToolCalls: 1, emptyReminderCooldownSettles: 1 }));
	const { hold, probe } = heldTodo();
	const harness = await createHarness({
		sessionManager: SessionManager.inMemory(),
		extensionFactories: [...before, hold, (pi) => registerTodo(pi), probe],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({ mode: "tui", uiContext: createTestUiContext() });
	harness.setResponses([fauxAssistantMessage(calls), fauxAssistantMessage("done"), fauxAssistantMessage("listed")]);
	await harness.session.prompt("Work");
	return harness;
}

const markers = (harness: Harness) =>
	harness.sessionManager
		.getBranch()
		.filter((entry) => "customType" in entry && entry.customType === EMPTY_REMINDER_MESSAGE_TYPE);

it("counts work after a todo call in the same parallel batch, even when todo's completion arrives last", async () => {
	const harness = await run([fauxToolCall(TOOL_NAME, { action: "list" }), fauxToolCall("probe", {})]);
	expect(markers(harness)).toHaveLength(1);
	expect(harness.getPendingResponseCount()).toBe(0);
});

it("lets a todo call reset work that came before it in the same parallel batch", async () => {
	const harness = await run([fauxToolCall("probe", {}), fauxToolCall(TOOL_NAME, { action: "list" })]);
	expect(markers(harness)).toEqual([]);
	expect(harness.getPendingResponseCount()).toBe(1);
});

it("resets on a todo call whose result message an earlier extension renamed", async () => {
	const harness = await run(
		[fauxToolCall("probe", {}), fauxToolCall(TOOL_NAME, { action: "list" })],
		[renameTodoResult],
	);
	expect(markers(harness)).toEqual([]);
	expect(harness.getPendingResponseCount()).toBe(1);
});
