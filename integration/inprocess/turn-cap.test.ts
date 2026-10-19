/** The real child loop reaches its cap; the real deferred engine cannot rearm report tools. */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { fauxAssistantMessage, fauxToolCall, type Harness } from "@earendil-works/pi-coding-agent/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agentStack, ask, closeAgentStack, jsonFile, type Step } from "./agents-support.ts";
import { isolateStackHome, loadThirdParty } from "./support.ts";

let home: ReturnType<typeof isolateStackHome>;
let h: Harness;
beforeAll(async () => {
	home = isolateStackHome();
	jsonFile(join(home.root, "agent/deferred-tools.json"), {
		alwaysActive: ["Agent", "bash"],
		neverDefer: ["Agent", "bash"],
	});
	h = await agentStack(home.root, {
		factories: [await loadThirdParty("deferred")],
		packages: [fileURLToPath(new URL("./", import.meta.resolve("pi-deferred-context-engine")))],
		subagents: { graceTurns: 1 },
	});
});
afterAll(async () => {
	if (h) await closeAgentStack(h);
	home.cleanup();
});

it("forced child report cannot regain deferred tools", async () => {
	const schemas: string[][] = [];
	const steps: Step[] = Array.from({ length: 3 }, (_, index) => (ctx) => {
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
	expect(schemas).toHaveLength(4);
	for (const before of schemas.slice(0, -1)) expect(before).toContain("bash");
	expect(schemas.at(-1)).toEqual([]);
});
