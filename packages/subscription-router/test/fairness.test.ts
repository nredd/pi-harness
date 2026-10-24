/** Conditional fairness properties and constructive exclusions, against actual Router dispatch. */
import { describe, expect, it } from "vitest";
import { FairnessSimulation } from "./fairness-simulator.js";

describe("normalized quota fairness (not request equality)", () => {
	it("splits symmetric fresh independent prompts equally, up to one debit", async () => {
		const sim = new FairnessSimulation([128, 128, 128]);
		for (let n = 1; n <= 192; n++) {
			await sim.step({ incumbent: false });
			expect(Math.max(...sim.debits) - Math.min(...sim.debits)).toBeLessThanOrEqual(1);
			if (n % 3 === 0) expect(new Set(sim.debits).size).toBe(1);
		}
		expect(sim.debits).toEqual([64, 64, 64]);
	});

	it("equalizes normalized consumption, not counts, for unequal capacities", async () => {
		const sim = new FairnessSimulation([64, 128]);
		for (let n = 0; n < 96; n++) {
			await sim.step({ incumbent: false });
			expect(Math.abs((sim.debits[0] ?? 0) / 64 - (sim.debits[1] ?? 0) / 128)).toBeLessThanOrEqual(1 / 64);
		}
		expect(sim.debits).toEqual([32, 64]);
	});

	it("characterizes incumbent recurrence: eleven initial debits, bounded skew, not alternation", async () => {
		const sim = new FairnessSimulation([64, 64]);
		for (let n = 0; n < 96; n++) {
			await sim.step();
			// h/(1+h) + one normalized debit, for this fixed common-time, two-account model.
			expect(Math.abs((sim.debits[0] ?? 0) - (sim.debits[1] ?? 0)) / 64).toBeLessThanOrEqual(1 / 6 + 1 / 64);
		}
		expect(sim.dispatches.slice(0, 12)).toEqual([...Array<number>(11).fill(0), 1]);
	});

	it("G1: exhaustively maximizes fresh eligible scores without incumbent on a bounded grid", () => {
		const sim = new FairnessSimulation([16, 16, 16]);
		for (let a = 0; a <= 16; a++) {
			for (let b = 0; b <= 16; b++) {
				for (let c = 0; c <= 16; c++) {
					sim.debits.splice(0, 3, a, b, c);
					sim.publish();
					const result = sim.router.pick(sim.profile, sim.env);
					const minimum = Math.min(a, b, c);
					if (minimum === 16) expect(result.ok).toBe(false);
					else {
						expect(result.ok).toBe(true);
						if (result.ok) expect(result.entry.provider).toBe(`quota-${[a, b, c].indexOf(minimum)}`);
					}
				}
			}
		}
	});

	it("exhaustively bounds the incumbent's pre-dispatch deficit on the same grid", () => {
		const sim = new FairnessSimulation([16, 16]);
		for (let a = 0; a < 16; a++) {
			for (let b = 0; b < 16; b++) {
				sim.debits.splice(0, 2, a, b);
				sim.publish();
				for (const incumbent of sim.profile.chain) {
					const result = sim.router.pick(sim.profile, sim.env, incumbent);
					expect(result.ok).toBe(true);
					if (result.ok) {
						const remaining = result.entry.provider === "quota-0" ? 16 - a : 16 - b;
						expect(remaining * 1.2).toBeGreaterThanOrEqual(Math.max(16 - a, 16 - b));
						const current = incumbent.provider === "quota-0" ? 16 - a : 16 - b;
						const best = Math.max(16 - a, 16 - b);
						if ((current === 5 && best === 6) || (current === 10 && best === 12))
							expect(result.entry).toEqual(incumbent);
					}
				}
			}
		}
	});
});

describe("limits of fairness", () => {
	it("independent routers herd on a shared unchanged snapshot, with no reservation", async () => {
		const clients = Array.from({ length: 16 }, () => new FairnessSimulation([8, 8]));
		const selected = await Promise.all(clients.map((sim) => sim.step({ fresh: false })));
		expect(selected).toEqual(Array<number>(16).fill(0));
		// Sixteen real account debits would oversubscribe capacity eight before telemetry catches up.
	});

	it("lag permits exhaustion before the reset; refreshing only redirects later work", async () => {
		const sim = new FairnessSimulation([8, 8]);
		for (let i = 0; i < 12; i++) await sim.step({ fresh: false });
		expect(sim.debits).toEqual([12, 0]);
		expect(await sim.step()).toBe(1);
	});

	it("outside usage, not local counts, changes the next independent dispatch", async () => {
		const sim = new FairnessSimulation([64, 64]);
		sim.debits[0] = 48;
		expect(await sim.step({ incumbent: false })).toBe(1);
		expect(sim.dispatches).toEqual([1]);
	});

	it("ordered routing and long continuations have no balanced allocation bound", async () => {
		const ordered = new FairnessSimulation([64, 64], "ordered");
		const sticky = new FairnessSimulation([64, 64]);
		await sticky.step();
		for (let i = 0; i < 31; i++) {
			await ordered.step();
			await sticky.step({ reason: "continuation" });
		}
		expect(ordered.debits).toEqual([31, 0]);
		expect(sticky.debits).toEqual([32, 0]);
		expect(await sticky.step({ reason: "direct" })).toBe(0);
	});

	it("a large debit exceeds the unit-cost premise; fresh feedback redirects the next prompt", async () => {
		const sim = new FairnessSimulation([64, 64]);
		await sim.step({ cost: 128 });
		expect(Math.abs((sim.debits[0] ?? 0) - (sim.debits[1] ?? 0)) / 64).toBeGreaterThan(1 / 6 + 1 / 64);
		expect(await sim.step({ incumbent: false })).toBe(1);
	});

	it("fresh unlimited dominates finite accounts, while stale and missing are fallbacks", async () => {
		const sim = new FairnessSimulation([64, 64]);
		const first = sim.usage.peek("quota-0");
		if (!first) throw new Error("Missing fixture");
		first.credits = { available: true, unlimited: true };
		for (let i = 0; i < 32; i++) await sim.step({ fresh: false, incumbent: false });
		expect(sim.debits).toEqual([32, 0]);
		first.status = "stale";
		expect(await sim.step({ fresh: false })).toBe(1);
		sim.usage.snapshots.delete("quota-1");
		expect(await sim.step({ fresh: false })).toBe(1); // all-fallback incumbent
	});

	it("reset discontinuity removes an exhausted window; it does not synthesize new quota", () => {
		const sim = new FairnessSimulation([64, 64]);
		sim.debits[0] = 64;
		sim.publish();
		const entry = sim.profile.chain[0];
		if (!entry) throw new Error("Missing entry");
		expect(sim.router.blockedBy(entry)).toBeDefined();
		sim.clock.advance(3_600_000);
		// Keep observations fresh without replacing their passed windows or utilization.
		for (const snapshot of sim.usage.snapshots.values()) snapshot.expiresAt = sim.clock.now() + 60_000;
		expect(sim.router.blockedBy(entry)).toBeUndefined();
		const picked = sim.router.pick(sim.profile, sim.env);
		expect(picked.ok && picked.candidates.map((candidate) => candidate.score)).toEqual([
			{ kind: "fallback", reason: "no applicable active windows" },
			{ kind: "fallback", reason: "no applicable active windows" },
		]);
	});

	it("the limiting applicable model window and reset pace defeat raw percent comparisons", () => {
		const sim = new FairnessSimulation([64, 64]);
		const first = sim.usage.peek("quota-0");
		const second = sim.usage.peek("quota-1");
		if (!first || !second) throw new Error("Missing fixtures");
		const modelWindow = { name: "sonnet", scope: "model" as const, families: ["sonnet"], usedPercent: 75 };
		const providerWindow = second.windows[0];
		if (!providerWindow) throw new Error("Missing window");
		first.windows.push(modelWindow);
		providerWindow.usedPercent = 50;
		let picked = sim.router.pick(sim.profile, sim.env);
		expect(picked.ok && picked.entry.provider).toBe("quota-1");
		modelWindow.families = ["opus"];
		picked = sim.router.pick(sim.profile, sim.env);
		expect(picked.ok && picked.entry.provider).toBe("quota-0");
		providerWindow.resetAt = sim.clock.now() + 3_600_000 / 4;
		picked = sim.router.pick(sim.profile, sim.env);
		expect(picked.ok && picked.entry.provider).toBe("quota-1"); // 0.5/0.25 > 1
	});
});
