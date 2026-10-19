import { fauxAssistantMessage, type Harness } from "@earendil-works/pi-coding-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { configFor, FakeClock, heldResponse, nextEvent, ScenarioFixture, spoken, tick } from "./support.ts";

describe("loops through a real session", () => {
	let fixture: ScenarioFixture;
	let clock: FakeClock;
	let harness: Harness;
	let notices: string[];

	/** Capture only the UI boundary; scheduling and prompt dispatch belong to the real kit and host. */
	async function start() {
		fixture = new ScenarioFixture();
		clock = new FakeClock();
		notices = [];
		harness = await fixture.start(configFor("loop"), { kit: { clock }, ui: { notify: (text) => notices.push(text) } });
		harness.setResponses(Array.from({ length: 30 }, (_, i) => fauxAssistantMessage(`tick ${i + 1}`)));
	}

	afterEach(async () => {
		await fixture?.shutdown();
		expect(clock.pending).toBe(0);
		fixture?.cleanup();
	});

	it("loop stops at its run cap", async () => {
		await start();
		await harness.session.prompt("/loop 30s ping --max 2");
		await tick(harness, clock);
		await tick(harness, clock);
		expect(spoken(harness)).toEqual(["tick 1", "tick 2"]);
		expect(notices).toContain("loop 1 finished: 2 runs");
		clock.advance(300_000);
		await harness.session.prompt("/loop list");
		expect(notices.at(-1)).toBe("no loops");
		expect(clock.pending).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(28);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
	});

	it("stop cancels future loop prompts", async () => {
		await start();
		await harness.session.prompt("/loop 30s ping");
		await tick(harness, clock);
		await harness.session.prompt("/loop stop 1");
		expect(notices.at(-1)).toBe("stopped 1");
		const seen = spoken(harness);
		clock.advance(300_000);
		await harness.session.prompt("/loop list");
		expect(spoken(harness)).toEqual(seen);
		expect(seen).toEqual(["tick 1"]);
		expect(notices.at(-1)).toBe("no loops");
		expect(clock.pending).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(29);
	});

	it("busy loop ticks skip rather than queue", async () => {
		await start();
		const held = heldResponse("tick 1");
		harness.setResponses([held.response, fauxAssistantMessage("SHOULD NOT RUN")]);
		await harness.session.prompt("/loop 30s slow");
		expect(notices.at(-1)).toContain("loop 1: every 30s");
		const settled = nextEvent(harness, "agent_settled");
		clock.advance(30_000);
		await held.entered;
		expect(harness.session.isIdle).toBe(false);
		clock.advance(120_000);
		await harness.session.prompt("/loop list");
		expect(notices.at(-1)).toBe("1: every 30s, 1/50 runs, 4 skipped: slow");
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		await harness.session.prompt("/loop stop all");
		expect(notices.at(-1)).toBe("stopped 1");
		held.release();
		await settled;
		await harness.session.waitForIdle();
		clock.advance(300_000);
		expect(spoken(harness)).toEqual(["tick 1"]);
		expect(harness.getPendingResponseCount()).toBe(1);
		await harness.session.prompt("/loop list");
		expect(notices.at(-1)).toBe("no loops");
	});
});
