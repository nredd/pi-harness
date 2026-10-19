import { fauxAssistantMessage, getMessageText } from "@earendil-works/pi-coding-agent/testing";
import { afterEach, expect, it } from "vitest";
import { configFor, FakeClock, goalStates, heldResponse, nextEvent, ScenarioFixture, spoken, tick } from "./support.ts";

let fixture: ScenarioFixture | undefined;
afterEach(async () => {
	await fixture?.shutdown();
	fixture?.cleanup();
});

it("same-cwd sessions isolate goals and loops", async () => {
	fixture = new ScenarioFixture();
	const clock = new FakeClock();
	const aNotices: string[] = [];
	const bNotices: string[] = [];
	const a = await fixture.start(configFor("goal", "loop"), {
		kit: { clock },
		ui: { notify: (text) => aNotices.push(text) },
	});
	const b = await fixture.start(configFor("goal", "loop"), {
		kit: { clock },
		modelRuntime: a.session.modelRuntime,
		ui: { notify: (text) => bNotices.push(text) },
	});
	expect(a.cwd).toBe(fixture.root);
	expect(b.cwd).toBe(a.cwd);
	expect(a.sessionManager.getSessionId()).not.toBe(b.sessionManager.getSessionId());
	const aSecond = heldResponse("A turn 2");
	const aThird = heldResponse("A turn 3");
	const bFirst = heldResponse("tick 1");
	a.setResponses([fauxAssistantMessage("A turn 1"), aSecond.response, aThird.response]);
	b.setResponses([
		bFirst.response,
		fauxAssistantMessage("tick 2"),
		fauxAssistantMessage("tick 3"),
		fauxAssistantMessage("SHOULD NOT RUN"),
	]);
	await a.session.prompt("/goal alpha work --turns 50");
	const aRun = a.session.prompt("go");
	await aSecond.entered;
	await b.session.prompt("/loop 30s beta --max 3");
	const bSettled = nextEvent(b, "agent_settled");
	clock.advance(30_000);
	await b.session.prompt("/loop list");
	expect(bNotices.at(-1)).toBe("1: every 30s, 1/3 runs, 0 skipped: beta");
	await bFirst.entered;
	// A's goal continues while B is busy; B's loop dispatched despite A's active goal.
	aSecond.release();
	await aThird.entered;
	expect(spoken(a)).toEqual(["A turn 1", "A turn 2"]);
	expect(b.session.isIdle).toBe(false);
	await b.session.prompt("/goal status");
	expect(bNotices.at(-1)).toContain("no goal.");
	await a.session.prompt("/loop list");
	expect(aNotices.at(-1)).toBe("no loops");
	expect(goalStates(a).at(-1)).toMatchObject({ status: "active", objective: "alpha work", turns: 2 });
	expect(goalStates(b)).toEqual([]);
	await a.session.prompt("/goal pause");
	expect(aNotices.at(-1)).toContain("goal paused");
	aThird.release();
	await aRun;
	bFirst.release();
	await bSettled;
	await b.session.waitForIdle();
	await tick(b, clock);
	await tick(b, clock);
	expect(spoken(b)).toEqual(["tick 1", "tick 2", "tick 3"]);
	expect(bNotices).toContain("loop 1 finished: 3 runs");
	await b.session.prompt("/goal status");
	expect(bNotices.at(-1)).toContain("no goal.");
	await b.session.prompt("/loop list");
	expect(bNotices.at(-1)).toBe("no loops");
	expect([...bNotices, ...b.session.messages.map(getMessageText)].join("\n")).not.toContain("alpha work");
	expect([...aNotices, ...a.session.messages.map(getMessageText)].join("\n")).not.toContain("beta");
	expect(harnessPromptTexts(b)).toEqual(["beta", "beta", "beta"]);
	expect(b.getPendingResponseCount()).toBe(1);
	expect(clock.pending).toBe(0);
});

/** Only dispatched user messages, excluding command notifications and goal snapshots. */
function harnessPromptTexts(harness: Awaited<ReturnType<ScenarioFixture["start"]>>): string[] {
	return harness.session.messages.filter((message) => message.role === "user").map(getMessageText);
}
