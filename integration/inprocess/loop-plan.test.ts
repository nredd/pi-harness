/** Loop scheduling yields to the actual Plan-mode branch state, not a stub flag. */
import { fauxAssistantMessage } from "@earendil-works/pi-coding-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { GoalStack, spoken, tick } from "./goal-support.ts";
import { loadFork } from "./support.ts";

describe("loop and Plan mode", () => {
	let stack: GoalStack;
	afterEach(async () => {
		await stack?.cleanup();
	});

	it("Plan suspension skips loop ticks until exit", async () => {
		stack = new GoalStack();
		const h = await stack.start([await loadFork("pi-plan-mode"), stack.kit()]);
		h.setResponses([fauxAssistantMessage("tick 1"), fauxAssistantMessage("SHOULD NOT RUN")]);
		await h.session.prompt("/plan start");
		await h.session.prompt("/loop 30s ping --max 5");
		stack.clock.advance(90_000);
		await h.session.waitForIdle();
		await h.session.prompt("/loop list");
		expect(stack.notifications.at(-1)).toContain("1: every 30s, 0/5 runs, 3 skipped");
		expect(spoken(h)).toEqual([]);
		expect(h.eventsOfType("agent_start")).toHaveLength(0);
		await h.session.prompt("/plan exit");
		await tick(h, stack.clock);
		expect(spoken(h)).toEqual(["tick 1"]);
		await h.session.prompt("/loop list");
		expect(stack.notifications.at(-1)).toContain("1: every 30s, 1/5 runs, 3 skipped");
		await h.session.prompt("/loop stop all");
		stack.clock.advance(90_000);
		await h.session.waitForIdle();
		expect(spoken(h)).toEqual(["tick 1"]);
	});
});
