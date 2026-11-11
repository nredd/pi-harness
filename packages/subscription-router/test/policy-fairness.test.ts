/** Conditional fairness, plus explicit counterexamples, never unconditional no-starvation claims. */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { FairnessSimulation, type ReplayFrame } from "./fairness-simulator.js";

it("remaining balance serves every persistently eligible member under fresh independent equal-debit prompts", async () => {
	for (const members of [2, 3, 5]) {
		const simulation = new FairnessSimulation(Array<number>(members).fill(64), {
			version: 1,
			kind: "remaining-balanced",
			stickiness: "none",
		});
		for (let request = 0; request < members * 20; request++) {
			await simulation.step({ incumbent: false });
			expect(Math.max(...simulation.debits) - Math.min(...simulation.debits)).toBeLessThanOrEqual(1);
			if (request >= members - 1) expect(simulation.debits.every((debit) => debit > 0)).toBe(true);
		}
	}
});
it("fixed snapshots and indefinite continuation can starve positive headroom", async () => {
	for (const continuation of [false, true]) {
		const simulation = new FairnessSimulation([100, 100], { version: 1, kind: "remaining-balanced" });
		for (let i = 0; i < 20; i++)
			await simulation.step({
				fresh: continuation,
				reason: continuation && i ? "continuation" : "user",
			});
		expect(simulation.dispatches).toEqual(Array<number>(20).fill(0));
	}
});
it("replays reset discontinuities, outside debits, synthetic cost and stale observations offline", async () => {
	const frames = JSON.parse(
		readFileSync(new URL("./fixtures/policy-replay.json", import.meta.url), "utf8"),
	) as ReplayFrame[];
	const before = structuredClone(frames);
	const simulation = new FairnessSimulation([100, 100], { version: 1, kind: "remaining-balanced" });
	expect(await simulation.replay(frames)).toEqual({
		counts: [1, 2],
		switches: 1,
		unknownExposures: 1,
		normalizedRemainingSkew: 0.010000000000000009,
	});
	expect(frames).toEqual(before);
	expect(simulation.usage.reads).toEqual([]);
});
