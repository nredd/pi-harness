/** The real child loop reaches its cap; the real deferred engine cannot rearm report tools. */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { nextEvent, toolCall } from "@nredd/pi-test-lib/faux";
import { fauxAssistantMessage, fauxToolCall, getMessageText, type Harness } from "@nredd/pi-test-lib/harness";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agentStack, ask, closeAgentStack, jsonFile, type Step } from "./agents-support.ts";
import { isolateStackHome, loadThirdParty } from "./support.ts";

let home: Awaited<ReturnType<typeof isolateStackHome>>;
let h: Harness;
beforeAll(async () => {
	home = await isolateStackHome();
	jsonFile(join(home.root, "agent/deferred-tools.json"), {
		alwaysActive: ["Agent", "bash", "get_subagent_result"],
		neverDefer: ["Agent", "bash", "get_subagent_result"],
	});
	h = await agentStack(home.root, {
		factories: [await loadThirdParty("deferred")],
		packages: [fileURLToPath(new URL("./", import.meta.resolve("pi-deferred-context-engine")))],
	});
});
afterAll(async () => {
	if (h) await closeAgentStack(h);
	await home.cleanup();
});

it.each([undefined, 1, 99])(
	"built-in Explore overrides caller max_turns=%s and forces a tool-free report",
	async (max_turns) => {
		const schemas: string[][] = [];
		const steeringSeen: number[] = [];
		const steps: Step[] = Array.from({ length: 17 }, (_, index) => (ctx) => {
			if (ctx.messages.some((message) => getMessageText(message).includes("You have reached your turn limit"))) {
				steeringSeen.push(index + 1);
			}
			schemas.push(getCurrentTools(ctx.messages).map((t) => t.name));
			return fauxAssistantMessage([fauxToolCall("ls", { path: home.root })], { stopReason: "toolUse" });
		});
		steps.push((ctx) => {
			schemas.push(getCurrentTools(ctx.messages).map((t) => t.name));
			return fauxAssistantMessage("INCOMPLETE: src/example.ts:7 -- bounded search findings");
		});
		const answer = await ask(h, "Explore", steps, { max_turns });
		expect(answer).toContain("INCOMPLETE: src/example.ts:7");
		expect(schemas).toHaveLength(18);
		expect(steeringSeen[0]).toBe(13);
		for (const before of schemas.slice(0, -1)) expect(before).toContain("ls");
		expect(schemas.at(-1)).toEqual([]);
	},
);

it("clips an Explore notice but keeps its head, tail and full-result pointer", async () => {
	const body = `src/first.ts:1 ${"x".repeat(6_000)} src/last.ts:9`;
	const response: Step = (ctx) =>
		fauxAssistantMessage(getCurrentTools(ctx.messages).some((tool) => tool.name === "Agent") ? "PARENT DONE" : body);
	let notice = "";
	const settled = nextEvent(h, (event) => {
		if (
			event.type === "message_end" &&
			event.message.role === "custom" &&
			event.message.customType === "subagent-notification"
		) {
			notice = getMessageText(event.message);
		}
		return notice !== "" && event.type === "agent_settled";
	});
	h.setResponses([
		toolCall("Agent", {
			subagent_type: "Explore",
			description: "bounded search",
			prompt: "quick search",
			model: `${h.getModel().provider}/${h.getModel().id}`,
			run_in_background: true,
		}),
		response,
		response,
		response,
	]);
	await h.session.prompt("search in background");
	await settled;
	expect(notice).toContain("src/first.ts:1");
	expect(notice).toContain("src/last.ts:9");
	expect(notice).toContain("truncated:");
	expect(notice).toContain("use get_subagent_result for full output");
	const carried = notice.slice(notice.indexOf("<result>") + 8, notice.indexOf("</result>"));
	expect(carried.replace(/\n\.\.\.\(truncated[^\n]*\n/, "")).toHaveLength(4_000);
	const spawned = h
		.eventsOfType("tool_execution_end")
		.filter((event) => event.toolName === "Agent")
		.at(-1);
	const details = spawned?.result.details as { agentId: string };
	h.setResponses([
		toolCall("get_subagent_result", { agent_id: details.agentId }),
		fauxAssistantMessage("FULL RESULT READ"),
	]);
	await h.session.prompt("read the unclipped result");
	const read = h
		.eventsOfType("tool_execution_end")
		.filter((event) => event.toolName === "get_subagent_result")
		.at(-1);
	if (!read) throw new Error("Missing get_subagent_result completion");
	expect(read.isError).toBe(false);
	expect(getMessageText(read.result)).toContain(body);
});

it("forced child report cannot regain deferred tools", async () => {
	const schemas: string[][] = [];
	const steps: Step[] = Array.from({ length: 7 }, (_, index) => (ctx) => {
		schemas.push(getCurrentTools(ctx.messages).map((t) => t.name));
		const tool =
			index === 0
				? fauxToolCall("search_tools", { query: "git status", kind: "tool" })
				: fauxToolCall("bash", { command: "echo loop" });
		return fauxAssistantMessage([{ type: "text", text: "Now let me check one more thing" }, tool], {
			stopReason: "toolUse",
		});
	});
	steps.push((ctx) => {
		schemas.push(getCurrentTools(ctx.messages).map((t) => t.name));
		return fauxAssistantMessage("FINAL REPORT 11: every finding, with paths");
	});
	const answer = await ask(h, "general-purpose", steps, { max_turns: 2 });
	expect(answer).toContain("FINAL REPORT 11");
	expect(answer).not.toContain("Now let me check");
	expect(answer.toLowerCase()).not.toContain("aborted");
	expect(schemas).toHaveLength(8);
	for (const before of schemas.slice(0, -1)) expect(before).toContain("bash");
	expect(schemas.at(-1)).toEqual([]);
});
