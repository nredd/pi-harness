import { describe, expect, it } from "vitest";
import { formatScore, type QuotaScore, STALE_GRACE_MS, scoreQuota, selectCandidate } from "../src/selection.js";
import { parseAnthropic, parseCodex, type UsageSnapshot, type UsageWindow } from "../src/usage.js";

const NOW = 1_700_000_000_000;
const model = { provider: "third", id: "claude-sonnet-5" };
const window = (usedPercent = 50, overrides: Partial<UsageWindow> = {}): UsageWindow => ({
	name: "short",
	usedPercent,
	resetAt: NOW + 500,
	durationMs: 1000,
	scope: "provider",
	...overrides,
});
const snapshot = (windows: UsageWindow[], overrides: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
	provider: model.provider,
	status: "available",
	windows,
	retrievedAt: NOW,
	expiresAt: NOW + 60_000,
	...overrides,
});
const measured = (score: number): QuotaScore => ({ kind: "measured", score, window: "test" });
const fallback: QuotaScore = { kind: "fallback", reason: "usage missing" };

describe("scoreQuota", () => {
	it("uses the minimum of short and weekly windows, without mutating input", () => {
		const data = snapshot([window(), window(90, { name: "weekly", durationMs: 2000, resetAt: NOW + 2000 })]);
		const before = structuredClone(data);
		expect(scoreQuota(model, data, NOW)).toMatchObject({
			kind: "measured",
			score: expect.closeTo(0.1),
			window: "weekly",
		});
		expect(data).toEqual(before);
		expect(scoreQuota(model, snapshot([window(90), window(10, { name: "weekly" })]), NOW)).toMatchObject({
			window: "short",
		});
	});
	it("clamps time left at 5% and 100%, ignores passed resets", () => {
		expect(scoreQuota(model, snapshot([window(50, { resetAt: NOW + 1 })]), NOW)).toMatchObject({ score: 10 });
		expect(scoreQuota(model, snapshot([window(50, { resetAt: NOW + 2000 })]), NOW)).toMatchObject({ score: 0.5 });
		expect(scoreQuota(model, snapshot([window(100, { resetAt: NOW }), window()]), NOW)).toMatchObject({ score: 1 });
		expect(scoreQuota(model, snapshot([window(100, { resetAt: NOW - 1 })]), NOW).kind).toBe("fallback");
	});
	it.each([
		{ resetAt: undefined },
		{ durationMs: undefined },
		{ durationMs: 0 },
		{ durationMs: -1 },
		{ durationMs: Number.NaN },
		{ resetAt: Number.NaN },
	])("uses full time without usable timing: %j", (overrides) => {
		expect(scoreQuota(model, snapshot([window(50, overrides)]), NOW)).toMatchObject({ score: 0.5 });
	});
	it("applies matching family limits only, including weekly-only plans", () => {
		const data = snapshot([
			window(10),
			window(90, { name: "opus", scope: "model", families: ["opus"] }),
			window(80, { name: "sonnet", scope: "model", families: ["sonnet"] }),
		]);
		expect(scoreQuota(model, data, NOW)).toMatchObject({ window: "sonnet", score: expect.closeTo(0.4) });
		expect(scoreQuota({ ...model, id: "magnopus" }, data, NOW)).toMatchObject({ window: "short", score: 1.8 });
		expect(scoreQuota(model, snapshot([window(25, { name: "weekly" })]), NOW)).toMatchObject({ score: 1.5 });
	});
	it("ranks only fresh data, handles empty/unlimited/invalid data and formats diagnostics", () => {
		const old = NOW - STALE_GRACE_MS - 1;
		for (const status of ["stale", "error", "unavailable"] as const) {
			expect(scoreQuota(model, snapshot([window()], { status, retrievedAt: old }), NOW)).toEqual({
				kind: "fallback",
				reason: `usage ${status}`,
			});
		}
		expect(scoreQuota(model, undefined, NOW)).toEqual(fallback);
		expect(scoreQuota(model, snapshot([window()], { expiresAt: NOW, retrievedAt: old }), NOW)).toEqual({
			kind: "fallback",
			reason: "usage stale",
		});
		expect(scoreQuota(model, snapshot([]), NOW).kind).toBe("fallback");
		expect(scoreQuota(model, snapshot([window(Number.NaN)]), NOW).kind).toBe("fallback");
		expect(scoreQuota(model, snapshot([], { credits: { available: true, unlimited: true } }), NOW)).toEqual({
			kind: "unlimited",
		});
		expect(formatScore(measured(0.5))).toBe("score 0.500, limiting test");
		expect(formatScore(fallback)).toBe("fallback: usage missing");
		expect(formatScore({ kind: "unlimited" })).toBe("unlimited");
	});
});

describe("recently expired snapshots", () => {
	const aged = (ageMs: number, overrides: Partial<UsageSnapshot> = {}) =>
		snapshot([window(10)], { status: "stale", retrievedAt: NOW - ageMs, expiresAt: NOW, ...overrides });

	it("score as measured with a stale marker inside the grace window", () => {
		expect(scoreQuota(model, aged(6 * 60_000), NOW)).toMatchObject({
			kind: "measured",
			score: expect.closeTo(1.8),
			stale: 6 * 60_000,
		});
		expect(scoreQuota(model, aged(STALE_GRACE_MS), NOW)).toMatchObject({ kind: "measured" });
		// An available snapshot past its TTL is the same case, before `peek` relabels it.
		expect(
			scoreQuota(model, snapshot([window(10)], { retrievedAt: NOW - 6 * 60_000, expiresAt: NOW }), NOW),
		).toMatchObject({ kind: "measured", stale: 6 * 60_000 });
		expect(formatScore(scoreQuota(model, aged(6 * 60_000), NOW))).toContain("stale 6m");
	});
	it("stay fallback past the grace window, on failed reads and without windows", () => {
		expect(scoreQuota(model, aged(STALE_GRACE_MS + 1), NOW).kind).toBe("fallback");
		for (const status of ["error", "unavailable"] as const)
			expect(scoreQuota(model, aged(1000, { status }), NOW).kind).toBe("fallback");
		expect(scoreQuota(model, aged(1000, { windows: [] }), NOW).kind).toBe("fallback");
	});
	it("never count as unlimited", () => {
		const data = aged(1000, { windows: [], credits: { available: true, unlimited: true } });
		expect(scoreQuota(model, data, NOW).kind).toBe("fallback");
	});
	it("lets a higher-scored stale provider beat a lower-scored fresh one, and vice versa", () => {
		// Regression: stale A (10% used) used to rank below fresh B (60% used) as fallback.
		const staleA = scoreQuota(model, aged(6 * 60_000), NOW);
		const freshB = scoreQuota(model, snapshot([window(60)]), NOW);
		expect(selectCandidate([staleA, freshB], "balanced")).toBe(0);
		const staleBusy = scoreQuota(model, aged(6 * 60_000, { windows: [window(90)] }), NOW);
		expect(selectCandidate([staleBusy, freshB], "balanced")).toBe(1);
	});
});

describe("selectCandidate", () => {
	it("supports N providers and chain-order ties; ordered ignores scores/incumbent", () => {
		const scores = [fallback, measured(0.1), measured(0.8), measured(0.8)];
		expect(selectCandidate(scores, "balanced")).toBe(2);
		expect(selectCandidate(scores, "ordered", 3)).toBe(0);
		expect(selectCandidate([], "balanced")).toBe(-1);
	});
	it("requires strictly more than 20% improvement", () => {
		expect(selectCandidate([measured(1), measured(1.2)], "balanced", 0)).toBe(0);
		expect(selectCandidate([measured(1), measured(1.200001)], "balanced", 0)).toBe(1);
		expect(selectCandidate([measured(1.1), measured(1)], "balanced", 1)).toBe(1);
		expect(selectCandidate([measured(0), measured(0.001)], "balanced", 0)).toBe(1);
		// 50% vs 40% used yields a rounded 0.6000000000000001 after normalization.
		const incumbent = scoreQuota(model, snapshot([window(50)]), NOW);
		const boundary = scoreQuota(model, snapshot([window(40)]), NOW);
		expect(selectCandidate([incumbent, boundary], "balanced", 0)).toBe(0);
		expect(selectCandidate([incumbent, scoreQuota(model, snapshot([window(39.999)]), NOW)], "balanced", 0)).toBe(1);
	});
	it.each([
		[50, 40],
		[75, 70],
		[90, 88],
		[99, 98.8],
		[99.9, 99.88],
		[99.99, 99.988],
	])("keeps mathematical 20 percent ties sticky for %s and %s utilization", (used, boundaryUsed) => {
		for (const resetAt of [NOW + 1, NOW + 500, NOW + 1000]) {
			const incumbent = scoreQuota(model, snapshot([window(used, { resetAt })]), NOW);
			const boundary = scoreQuota(model, snapshot([window(boundaryUsed, { resetAt })]), NOW);
			expect(selectCandidate([incumbent, boundary], "balanced", 0)).toBe(0);
			const better = scoreQuota(model, snapshot([window(boundaryUsed - 0.000001, { resetAt })]), NOW);
			expect(selectCandidate([incumbent, better], "balanced", 0)).toBe(1);
		}
	});
	it("retains precision for tiny direct scores and promotes positive headroom from zero", () => {
		expect(selectCandidate([measured(1e-20), measured(1.2e-20)], "balanced", 0)).toBe(0);
		expect(selectCandidate([measured(1e-20), measured(2e-20)], "balanced", 0)).toBe(1);
		expect(selectCandidate([measured(0), measured(1e-20)], "balanced", 0)).toBe(1);
	});
	it("does not let stale unlimited outrank fresh measured and preserves fresh unlimited incumbent", () => {
		const staleUnlimited = scoreQuota(
			model,
			snapshot([], { status: "stale", credits: { available: true, unlimited: true } }),
			NOW,
		);
		const freshUnlimited = scoreQuota(model, snapshot([], { credits: { available: true, unlimited: true } }), NOW);
		expect(selectCandidate([staleUnlimited, measured(0.01)], "balanced", 0)).toBe(1);
		expect(selectCandidate([freshUnlimited, measured(20)], "balanced", 0)).toBe(0);
	});
	it("promotes fallback to measured to unlimited and retains all-fallback incumbent", () => {
		expect(selectCandidate([fallback, fallback, fallback], "balanced", 2)).toBe(2);
		expect(selectCandidate([fallback, measured(0.01)], "balanced", 0)).toBe(1);
		expect(selectCandidate([measured(100), { kind: "unlimited" }], "balanced", 0)).toBe(1);
		expect(selectCandidate([{ kind: "unlimited" }, { kind: "unlimited" }], "balanced", 1)).toBe(1);
		expect(selectCandidate([measured(0.5), fallback], "balanced", -1)).toBe(0);
	});
});

describe("normalized durations", () => {
	it("assigns known Anthropic durations to provider and family windows", () => {
		const parsed = parseAnthropic({
			five_hour: { utilization: 10 },
			seven_day: { utilization: 20 },
			seven_day_opus: { utilization: 30 },
			seven_day_sonnet: { utilization: 40 },
		});
		expect(parsed?.windows.map((w) => w.durationMs)).toEqual([18_000_000, 604_800_000, 604_800_000, 604_800_000]);
	});
	it("normalizes reported Codex durations and legacy positional fallbacks", () => {
		const parse = (primary: unknown, secondary?: unknown) =>
			parseCodex({ rate_limit: { primary_window: primary, secondary_window: secondary } });
		expect(parse({ used_percent: 25, limit_window_seconds: 604800 })?.windows[0]).toMatchObject({
			name: "7d",
			durationMs: 604_800_000,
		});
		expect(parse({ used_percent: 25, limit_window_seconds: 3600 })?.windows[0]).toMatchObject({
			name: "3600s",
			durationMs: 3_600_000,
		});
		expect(parse({ used_percent: 25 }, { used_percent: 40 })?.windows.map((w) => w.durationMs)).toEqual([
			18_000_000, 604_800_000,
		]);
	});
});
