/** Resource guidance reaches real provider requests, including genuine subagent sessions. */
import { join } from "node:path";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { fauxAssistantMessage, type Harness } from "@earendil-works/pi-coding-agent/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDevTools } from "../../packages/dev-tools/src/index.ts";
import { runTools } from "../../packages/dev-tools/test/scenarios/support.ts";
import { createSubscriptionRouter, type RouterUsage } from "../../packages/subscription-router/src/index.ts";
import { agentStack, ask, closeAgentStack, jsonFile } from "./agents-support.ts";
import { isolateStackHome, loadThirdParty } from "./support.ts";

const ROUTER_USAGE: RouterUsage = {
	get: async () => ({
		provider: "anthropic",
		status: "available",
		windows: [],
		retrievedAt: 0,
		expiresAt: Number.MAX_SAFE_INTEGER,
	}),
	peek: () => ({
		provider: "anthropic",
		status: "available",
		windows: [],
		retrievedAt: 0,
		expiresAt: Number.MAX_SAFE_INTEGER,
	}),
	decisionFor: () => ({ block: false }),
	format: () => "available",
	formatForPrompt: () => "available",
};

let home: Awaited<ReturnType<typeof isolateStackHome>>;
let h: Harness;
beforeAll(async () => {
	home = await isolateStackHome();
	jsonFile(join(home.root, "agent/deferred-tools.json"), {
		promotionLifetime: "session",
		alwaysActive: ["search_tools", "Agent"],
	});
	h = await agentStack(home.root, {
		factories: [
			createDevTools(),
			await loadThirdParty("deferred"),
			createSubscriptionRouter({
				config: {
					ok: true,
					profiles: [{ id: "test", name: "test", strategy: "ordered", chain: [{ provider: "anthropic", id: "test" }] }],
				},
				usage: ROUTER_USAGE,
			}),
		],
	});
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

it("composes resource and router guidance as independent prompt sections", async () => {
	h.setResponses([
		(ctx) => {
			const system = ctx.messages.find((message) => message.role === "system");
			expect(system).toMatchObject({
				content: "",
				sections: expect.objectContaining({
					resource_awareness: expect.stringContaining("Before knowingly starting a large test or compile"),
					subscription_usage: expect.stringContaining("anthropic: available"),
				}),
			});
			return fauxAssistantMessage("COMPOSED");
		},
	]);
	await h.session.prompt("compose resource guidance");
});

it("keeps append-mode guidance singular and omits it from a restricted replace-mode child", async () => {
	const appendResult = await ask(h, "general-purpose", [
		(ctx) => {
			const prompt = JSON.stringify(ctx.messages.filter((m) => m.role === "system"));
			expect(prompt.match(/Before knowingly starting a large test or compile/gu)).toHaveLength(1);
			return fauxAssistantMessage("APPEND GUIDANCE OBSERVED");
		},
	]);
	expect(appendResult).toContain("APPEND GUIDANCE OBSERVED");

	const replaceResult = await ask(h, "code-reviewer", [
		(ctx) => {
			const prompt = JSON.stringify(ctx.messages.filter((m) => m.role === "system"));
			expect(prompt).not.toContain("Before knowingly starting a large test or compile");
			expect(getCurrentTools(ctx.messages).map((tool) => tool.name)).not.toContain("resource_snapshot");
			expect(getCurrentTools(ctx.messages).map((tool) => tool.name)).not.toContain("search_tools");
			return fauxAssistantMessage("RESTRICTED CHILD OBSERVED");
		},
	]);
	expect(replaceResult).toContain("RESTRICTED CHILD OBSERVED");
});
