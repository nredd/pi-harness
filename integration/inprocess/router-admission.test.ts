/** Admission refusals traverse the real subagents RPC client and router policy. */
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	registerFauxProvider,
} from "@earendil-works/pi-coding-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { GoalStack, outcomes, spoken, tool } from "./goal-support.ts";
import { loadFork } from "./support.ts";

const CHAIN = [
	{ provider: "spike-a", id: "sonnet-a" },
	{ provider: "spike-b", id: "terra-b" },
];

describe("router/subagents admission", () => {
	let stack: GoalStack;
	let physical: FauxProviderRegistration[] = [];
	afterEach(async () => {
		await stack?.cleanup();
		for (const p of physical) p.unregister();
		physical = [];
	});

	for (const capped of [false, true]) {
		it(capped ? "max wait cap refuses distant reset" : "fail policy refuses exhausted child", async () => {
			stack = new GoalStack();
			for (const { provider, id } of CHAIN) {
				stack.usage.set(provider, 100);
				physical.push(registerFauxProvider({ provider, models: [{ id }] }));
			}
			const scheduled: unknown[] = [];
			const started: unknown[] = [];
			const h = await stack.start(
				[
					await loadFork("pi-subagents"),
					stack.router(CHAIN, { exhaustion: capped ? { policy: "wait", maxWaitMs: 1_800_000 } : { policy: "fail" } }),
					(pi) => {
						pi.events.on("subagents:scheduled", (event) => scheduled.push(event));
						pi.events.on("subagents:started", (event) => started.push(event));
					},
				],
				{ useModelRuntimeStream: true },
			);
			for (const p of physical) {
				const model = p.getModel();
				h.session.modelRuntime.registerProvider(model.provider, {
					baseUrl: model.baseUrl,
					apiKey: "faux",
					api: p.api,
					models: p.models,
				});
				expect(await h.session.modelRuntime.getAuth(model)).toBeDefined();
				p.setResponses([fauxAssistantMessage("ANSWERED on physical provider")]);
			}
			h.setResponses([
				tool("Agent", {
					subagent_type: "general-purpose",
					description: "quota admission",
					prompt: "say hi",
					model: "router/spike",
					run_in_background: true,
				}),
				fauxAssistantMessage("DRIVER DONE"),
			]);
			await h.session.prompt("run the tool");
			const result = outcomes(h, "Agent");
			expect(result).toHaveLength(1);
			expect(result[0]?.isError).toBe(true);
			expect(result[0]?.text).toContain("was not started");
			expect(result[0]?.text).not.toContain("Queued");
			expect(spoken(h)).toEqual(["DRIVER DONE"]);
			expect(scheduled).toEqual([]);
			expect(started).toEqual([]);
			expect(physical.map((p) => p.state.callCount)).toEqual([0, 0]);
			expect(h.getPendingResponseCount()).toBe(0);
			stack.clock.advance(150_000);
			await h.session.waitForIdle();
			expect(h.eventsOfType("agent_start")).toHaveLength(1);
			expect(physical.map((p) => p.state.callCount)).toEqual([0, 0]);
		});
	}
});
