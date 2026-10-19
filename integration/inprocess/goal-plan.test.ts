/** Plan/goal command and execution policy through both real factories. */
import { getCurrentTools } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage } from "@earendil-works/pi-coding-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { complete, GoalStack, goalStates, nudges, outcomes, spoken } from "./goal-support.ts";
import { loadFork } from "./support.ts";

describe("goals and Plan mode", () => {
	let stack: GoalStack;
	afterEach(async () => {
		await stack?.cleanup();
	});
	async function start() {
		stack = await GoalStack.create();
		return stack.start([await loadFork("pi-plan-mode"), stack.kit()]);
	}

	it("Plan refuses goal creation", async () => {
		const h = await start();
		h.setResponses([fauxAssistantMessage("planning"), fauxAssistantMessage("SHOULD NOT RUN")]);
		await h.session.prompt("/plan start");
		await h.session.prompt("/goal ship it");
		await h.session.prompt("plan it");
		stack.clock.advance(120_000);
		await h.session.waitForIdle();
		expect(spoken(h)).toEqual(["planning"]);
		expect(h.getPendingResponseCount()).toBe(1);
		expect(goalStates(h)).toEqual([]);
		expect(nudges(h)).toEqual([]);
		expect(h.session.getSteeringMessages()).toEqual([]);
		expect(stack.notifications.join("\n")).toContain("refused: Plan mode is active");
	});

	it("idle Plan excursion pauses goal", async () => {
		const h = await start();
		h.setResponses([
			fauxAssistantMessage("after plan"),
			fauxAssistantMessage("resumed"),
			complete(),
			fauxAssistantMessage("end"),
		]);
		await h.session.prompt("/goal ship it");
		await h.session.prompt("/plan start");
		await h.session.prompt("/plan exit");
		await h.session.prompt("next");
		stack.clock.advance(120_000);
		await h.session.waitForIdle();
		expect(spoken(h)).toEqual(["after plan"]);
		expect(nudges(h)).toEqual([]);
		expect(goalStates(h).map((s) => [s?.status, s?.reason])).toEqual([
			["active", undefined],
			["paused", "plan mode"],
		]);
		await h.session.prompt("/goal resume");
		await h.session.prompt("go");
		expect(nudges(h)).toHaveLength(1);
		expect(goalStates(h).at(-1)?.status).toBe("complete");
		expect(spoken(h)).toEqual(["after plan", "resumed", "end"]);
		expect(h.getPendingResponseCount()).toBe(0);
	});

	it("Plan blocks goal execution and premature resume", async () => {
		const h = await start();
		const offered: string[][] = [];
		h.setResponses([
			(ctx) => {
				offered.push(getCurrentTools(ctx.messages).map((t) => t.name));
				return fauxAssistantMessage("TOOLS");
			},
			complete(),
			fauxAssistantMessage("plan turn done"),
			fauxAssistantMessage("resumed work"),
			complete(),
			fauxAssistantMessage("end"),
		]);
		await h.session.prompt("/goal ship it --turns 10");
		await h.session.prompt("/plan start");
		await h.session.prompt("plan it");
		await h.session.prompt("plan again");
		expect(offered).toHaveLength(1);
		expect(offered[0]).not.toContain("goal_update");
		expect(outcomes(h, "goal_update")).toMatchObject([{ isError: true }]);
		const before = goalStates(h);
		await h.session.prompt("/goal resume");
		expect(goalStates(h)).toEqual(before);
		expect(nudges(h)).toEqual([]);
		await h.session.prompt("/plan exit");
		await h.session.prompt("/goal resume");
		expect(
			goalStates(h)
				.slice(0, 3)
				.map((s) => [s?.status, s?.reason]),
		).toEqual([
			["active", undefined],
			["paused", "plan mode"],
			["active", undefined],
		]);
		await h.session.prompt("go");
		expect(outcomes(h, "goal_update").map((o) => o.isError)).toEqual([true, false]);
		expect(goalStates(h).at(-1)?.status).toBe("complete");
		expect(nudges(h)).toHaveLength(1);
		expect(h.getPendingResponseCount()).toBe(0);
	});
});
