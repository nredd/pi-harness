/** Resource guidance reaches real provider requests, including genuine subagent sessions. */
import { join } from "node:path";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { fauxAssistantMessage, type Harness } from "@earendil-works/pi-coding-agent/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDevTools } from "../../packages/dev-tools/src/index.ts";
import { runTools } from "../../packages/dev-tools/test/scenarios/support.ts";
import { agentStack, ask, closeAgentStack, jsonFile } from "./agents-support.ts";
import { isolateStackHome, loadThirdParty } from "./support.ts";

let home: Awaited<ReturnType<typeof isolateStackHome>>;
let h: Harness;
beforeAll(async () => {
	home = await isolateStackHome();
	jsonFile(join(home.root, "agent/deferred-tools.json"), {
		promotionLifetime: "session",
		alwaysActive: ["search_tools", "Agent"],
	});
	h = await agentStack(home.root, { factories: [createDevTools(), await loadThirdParty("deferred")] });
});
afterAll(async () => {
	try {
		if (h) await closeAgentStack(h);
	} finally {
		await home.cleanup();
	}
});

it("guides the parent while deferred, then discovers and executes the real observer", async () => {
	h.setResponses([
		(ctx) => {
			const prompt = JSON.stringify(ctx.messages.filter((m) => m.role === "system"));
			expect(prompt).toContain("Before knowingly starting a large test or compile");
			expect(prompt).toContain("tool-search facility first");
			expect(getCurrentTools(ctx.messages).map((t) => t.name)).not.toContain("resource_snapshot");
			return fauxAssistantMessage("OBSERVED");
		},
	]);
	await h.session.prompt("inspect resource guidance");
	const [searched] = await runTools(h, [
		{ name: "search_tools", args: { query: "read-only host resource observer resource_snapshot", kind: "tool" } },
	]);
	expect(searched.isError, searched.text).toBe(false);
	expect(searched.text).toContain("resource_snapshot");
	const [snapshot] = await runTools(h, [{ name: "resource_snapshot", args: { process_limit: 1 } }]);
	expect(snapshot.isError, snapshot.text).toBe(false);
	expect(snapshot.text).toContain("no process-to-agent attribution");
});

it("puts resource guidance in a genuine child provider request", async () => {
	const result = await ask(h, "general-purpose", [
		(ctx) => {
			const prompt = JSON.stringify(ctx.messages.filter((m) => m.role === "system"));
			expect(prompt).toContain("Before knowingly starting a large test or compile");
			expect(prompt).toContain("OS process metadata cannot identify agents");
			return fauxAssistantMessage("CHILD GUIDANCE OBSERVED");
		},
	]);
	expect(result).toContain("CHILD GUIDANCE OBSERVED");
});
