/** #454: a parent asked to kill a subagent found no stop tool through `search_tools`; the real deferred stack now offers one. */
import { join } from "node:path";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { fauxAssistantMessage, type Harness } from "@earendil-works/pi-coding-agent/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runTools } from "../../packages/dev-tools/test/scenarios/support.ts";
import { agentStack, closeAgentStack, jsonFile } from "./agents-support.ts";
import { isolateStackHome, loadThirdParty } from "./support.ts";

let home: Awaited<ReturnType<typeof isolateStackHome>>;
let h: Harness;
beforeAll(async () => {
	home = await isolateStackHome();
	jsonFile(join(home.root, "agent/deferred-tools.json"), {
		promotionLifetime: "session",
		alwaysActive: ["search_tools", "Agent", "get_subagent_result", "steer_subagent"],
	});
	h = await agentStack(home.root, { factories: [await loadThirdParty("deferred")] });
});
afterAll(async () => {
	try {
		if (h) await closeAgentStack(h);
	} finally {
		await home.cleanup();
	}
});

it("finds stop_subagent for the query from #454 and promotes it next to steer_subagent", async () => {
	h.setResponses([
		(ctx) => {
			expect(getCurrentTools(ctx.messages).map((t) => t.name)).not.toContain("stop_subagent");
			return fauxAssistantMessage("DEFERRED");
		},
	]);
	await h.session.prompt("before search");
	const [searched] = await runTools(h, [
		{ name: "search_tools", args: { query: "stop or cancel a running subagent", kind: "tool" } },
	]);
	expect(searched.isError, searched.text).toBe(false);
	expect(searched.text).toContain("stop_subagent");
	const [stopped] = await runTools(h, [{ name: "stop_subagent", args: { agent_id: "nope" } }]);
	expect(stopped.text).toBe('No agent or workflow "nope", so there is nothing to stop.\nNothing is running or queued.');
});
