/** Admission refusals traverse the real subagents RPC client and router policy. */
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	registerFauxProvider,
} from "@earendil-works/pi-coding-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { GoalStack, outcomes, spoken, tool } from "./goal-support.ts";

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

	for (const policy of ["wait", "fail", "capped"] as const) {
		it(
			policy === "capped"
				? "max wait cap refuses distant reset"
				: `${policy} policy ${policy === "wait" ? "parks" : "refuses"} exhausted child`,
			async () => {
				stack = new GoalStack();
				for (const { provider, id } of CHAIN) {
					stack.usage.set(provider, 100);
					physical.push(registerFauxProvider({ provider, models: [{ id }] }));
				}
				const scheduled: unknown[] = [];
				const started: unknown[] = [];
				const h = await stack.start(
					[
						await stack.subagents(),
						stack.router(CHAIN, {
							exhaustion: policy === "capped" ? { policy: "wait", maxWaitMs: 1_800_000 } : { policy },
						}),
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
				expect(result[0]?.isError).toBe(policy !== "wait");
				expect(result[0]?.text).toContain(policy === "wait" ? "Queued" : "was not started");
				expect(result[0]?.text).not.toContain(policy === "wait" ? "was not started" : "Queued");
				expect(spoken(h)).toEqual(["DRIVER DONE"]);
				if (policy === "wait") {
					expect(scheduled).toMatchObject([
						{
							type: "added",
							job: {
								quotaParked: true,
								enabled: true,
								schedule: new Date(stack.clock.now() + 3_660_000).toISOString(),
							},
						},
					]);
				} else expect(scheduled).toEqual([]);
				expect(started).toEqual([]);
				expect(physical.map((p) => p.state.callCount)).toEqual([0, 0]);
				expect(h.getPendingResponseCount()).toBe(0);
				stack.clock.advance(150_000);
				await h.session.waitForIdle();
				expect(h.eventsOfType("agent_start")).toHaveLength(1);
				expect(physical.map((p) => p.state.callCount)).toEqual([0, 0]);
			},
		);
	}
});
