/** The router alone owns parked/refused work, including explicit kit resume attempts. */
import { fauxAssistantMessage } from "@earendil-works/pi-coding-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { GoalStack, goalStates, nudges, outcomes, spoken, tool } from "./goal-support.ts";

const CHAIN = [
	{ provider: "spike-a", id: "sonnet-a" },
	{ provider: "spike-b", id: "terra-b" },
];

describe("quota admission and kit coordination", () => {
	let stack: GoalStack;
	afterEach(async () => {
		await stack?.cleanup();
	});

	for (const policy of ["wait", "fail"] as const) {
		it(`router admission owns parked and refused work (${policy})`, async () => {
			stack = new GoalStack();
			const physical = stack.registerPhysical(CHAIN, 100);
			const resetAt = stack.clock.now() + 3_600_000;
			const scheduled: unknown[] = [];
			const started: unknown[] = [];
			const h = await stack.start(
				[
					await stack.subagents(),
					stack.router(CHAIN, { exhaustion: { policy } }),
					stack.kit(),
					(pi) => {
						pi.events.on("subagents:scheduled", (event) => scheduled.push(event));
						pi.events.on("subagents:started", (event) => started.push(event));
					},
				],
				{ useModelRuntimeStream: true },
			);
			for (const p of physical) {
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
				fauxAssistantMessage("ADMISSION SETTLED"),
				fauxAssistantMessage("SHOULD NOT CONTINUE AFTER QUOTA ADMISSION"),
			]);
			await h.session.prompt("/loop 30s quota-loop --max 10");
			await h.session.prompt("/goal wait for quota work --turns 10");
			await h.session.prompt("go");
			stack.clock.advance(150_000);
			await h.session.waitForIdle();
			const result = outcomes(h, "Agent");
			expect(result).toHaveLength(1);
			expect(result[0]?.isError).toBe(policy === "fail");
			// The native admission timeout fails open; only a router reply yields this block.
			expect(result[0]?.text).toContain(
				`Subscription quota for router/spike is exhausted; it resets at ${new Date(resetAt).toISOString()}.`,
			);
			expect(result[0]?.text).toContain(policy === "wait" ? "Queued" : "was not started");
			expect(physical.map((p) => p.state.callCount)).toEqual([0, 0]);
			expect(started).toEqual([]);
			expect(nudges(h)).toEqual([]);
			expect(spoken(h)).toEqual(["ADMISSION SETTLED"]);
			const reason = policy === "wait" ? "quota parked" : "quota refused";
			expect(goalStates(h).at(-1)).toMatchObject({ status: "paused", reason });
			expect(h.eventsOfType("agent_start")).toHaveLength(1);
			await h.session.prompt("/loop list");
			expect(stack.notifications.at(-1)).toContain("0/10 runs");
			expect(stack.notifications.at(-1)).toContain(`paused: ${reason}`);
			if (policy === "wait") {
				expect(scheduled).toMatchObject([
					{
						type: "added",
						job: {
							quotaParked: true,
							enabled: true,
							schedule: new Date(resetAt + 60_000).toISOString(),
						},
					},
				]);
				await h.session.prompt("/goal resume");
				await h.session.prompt("/loop resume all");
				stack.clock.advance(150_000);
				await h.session.waitForIdle();
				expect(stack.notifications.filter((text) => text.includes("quota dispatch is still parked"))).toHaveLength(2);
				expect(goalStates(h).at(-1)).toMatchObject({ status: "paused", reason });
				expect(nudges(h)).toEqual([]);
				expect(h.eventsOfType("agent_start")).toHaveLength(1);
				expect(scheduled).toHaveLength(1);
			} else expect(scheduled).toEqual([]);
			expect(h.getPendingResponseCount()).toBe(1);
			expect(physical.map((p) => p.state.callCount)).toEqual([0, 0]);
		});
	}
});
