import { describe, expect, it } from "vitest";
import {
	chartSeries,
	dailySeries,
	dailyTotals,
	filterCycle,
	inRange,
	matches,
	modelTotals,
	overview,
	rangeStart,
	streaks,
	tokensOf,
} from "../../src/stats/aggregate.ts";
import { addDays, dayKey, dayRange, daysBetween, shortDate } from "../../src/stats/days.ts";
import { at, call } from "./fixtures.ts";

const calls = [
	call("2026-10-01", "anthropic", "opus", 100, 10, { cacheWrite: 1000, cacheRead: 5000, cost: 1, session: "/a" }),
	call("2026-10-02", "openai-codex", "sol", 500, 50, { cacheRead: 100, cost: 0.5, session: "/a" }),
	call("2026-10-02", "anthropic", "sonnet", 10, 5, { cacheWrite: 100, session: "/a" }),
	call("2026-10-05", "openai-codex", "terra", 50, 5, { session: "/b" }),
];

describe("days", () => {
	it("keys by the LOCAL calendar, so 23:59 and 00:01 are different days", () => {
		expect(dayKey(new Date(2026, 9, 1, 23, 59))).toBe("2026-10-01");
		expect(dayKey(new Date(2026, 9, 2, 0, 1))).toBe("2026-10-02");
	});
	it("does day arithmetic across month ends and DST changes", () => {
		expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
		expect(addDays("2026-03-07", 2)).toBe("2026-03-09");
		expect(daysBetween("2026-11-01", "2026-11-03")).toBe(2);
		expect(dayRange("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
		expect(dayRange("2026-10-02", "2026-10-01")).toEqual([]);
		expect(shortDate("2026-10-03")).toBe("Oct 3");
	});
});

describe("aggregate", () => {
	it("counts all throughput (in + out + cache read + cache write)", () => {
		expect(tokensOf({ input: 1, output: 2, cacheRead: 8, cacheWrite: 4 })).toBe(15);
		const totals = modelTotals(calls);
		expect(totals.map((t) => [t.name, tokensOf(t)])).toEqual([
			["anthropic/opus", 6110],
			["openai-codex/sol", 650],
			["anthropic/sonnet", 115],
			["openai-codex/terra", 55],
		]);
		expect(totals[0]).toMatchObject({ cacheRead: 5000, cost: 1, calls: 1 });
	});

	it("cycles All, then providers, then models, each by tokens", () => {
		expect(filterCycle(calls)).toEqual([
			{ kind: "all" },
			{ kind: "provider", provider: "anthropic" },
			{ kind: "provider", provider: "openai-codex" },
			{ kind: "model", name: "anthropic/opus" },
			{ kind: "model", name: "openai-codex/sol" },
			{ kind: "model", name: "anthropic/sonnet" },
			{ kind: "model", name: "openai-codex/terra" },
		]);
		expect(calls.filter((c) => matches({ kind: "provider", provider: "anthropic" }, c))).toHaveLength(2);
		expect(calls.filter((c) => matches({ kind: "model", name: "openai-codex/sol" }, c))).toHaveLength(1);
	});

	it("charts providers under All and models under a filter", () => {
		expect(chartSeries({ kind: "all" }, calls, 3)).toEqual({
			by: "provider",
			keys: [
				{ key: "anthropic", tokens: 6225 },
				{ key: "openai-codex", tokens: 705 },
			],
		});
		const scoped = calls.filter((c) => c.provider === "anthropic");
		expect(chartSeries({ kind: "provider", provider: "anthropic" }, scoped, 1).keys).toEqual([
			{ key: "anthropic/opus", tokens: 6110 },
		]);
	});

	it("builds zero-filled daily series and totals", () => {
		const series = dailySeries(calls, "2026-09-30", "2026-10-03");
		expect(series.map((p) => [p.day, p.total])).toEqual([
			["2026-09-30", 0],
			["2026-10-01", 6110],
			["2026-10-02", 765],
			["2026-10-03", 0],
		]);
		expect(series[2]?.byKey.get("openai-codex/sol")).toBe(650);
		expect([...dailyTotals(calls)]).toEqual([
			["2026-10-01", 6110],
			["2026-10-02", 765],
			["2026-10-05", 55],
		]);
	});

	it("bounds ranges by local day", () => {
		expect(rangeStart("all", "2026-10-13")).toBeUndefined();
		expect(rangeStart("7d", "2026-10-13")).toBe("2026-10-07");
		expect(rangeStart("30d", "2026-10-13")).toBe("2026-09-14");
		expect(inRange("7d", "2026-10-13", at("2026-10-07", 0))).toBe(true);
		expect(inRange("7d", "2026-10-13", at("2026-10-06", 23))).toBe(false);
		// clock skew: a call dated after today is in no range
		expect(inRange("7d", "2026-10-13", at("2026-10-14", 1))).toBe(false);
		expect(inRange("all", "2026-10-13", at("2026-10-14", 1))).toBe(false);
	});

	it("finds the longest streak and a current one that survives until tomorrow", () => {
		const days = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-05", "2026-10-06"];
		expect(streaks(days, "2026-10-06")).toEqual({ longest: 3, current: 2 });
		expect(streaks(days, "2026-10-07")).toEqual({ longest: 3, current: 2 });
		expect(streaks(days, "2026-10-08")).toEqual({ longest: 3, current: 0 });
		expect(streaks([], "2026-10-08")).toEqual({ longest: 0, current: 0 });
		expect(streaks(["2026-10-31", "2026-11-01"], "2026-11-01").longest).toBe(2);
		// future days do not make a streak current
		expect(streaks(["2026-10-01", "2026-10-20"], "2026-10-08")).toEqual({ longest: 1, current: 0 });
	});

	it("summarises a range for the Overview", () => {
		const sessions = [
			{ path: "/a", startMs: at("2026-10-01", 9), endMs: at("2026-10-01", 11) },
			{ path: "/b", startMs: at("2026-10-05", 9), endMs: at("2026-10-05", 9) + 27_000 },
		];
		const all = overview(calls, sessions, "all", "2026-10-06", dailyTotals(calls).keys());
		expect(all).toMatchObject({
			totalTokens: 6930,
			cacheRead: 5100,
			cacheWrite: 1100,
			cost: 1.5,
			favorite: "anthropic/opus",
			sessions: 2,
			longestSessionMs: 2 * 3600_000,
			activeDays: 3,
			rangeDays: 6,
			mostActiveDay: "2026-10-01",
			longestStreak: 2,
			currentStreak: 1,
		});
		const week = overview(
			calls.filter((c) => inRange("7d", "2026-10-11", c.ms)),
			sessions,
			"7d",
			"2026-10-11",
			[],
		);
		expect(week).toMatchObject({ sessions: 1, rangeDays: 7, activeDays: 1, longestSessionMs: 27_000 });
		// a model filter narrows Sessions and Longest session to the sessions that used it
		const terra = overview(
			calls.filter((c) => c.model === "terra"),
			sessions,
			"all",
			"2026-10-06",
			[],
		);
		expect(terra).toMatchObject({ sessions: 1, longestSessionMs: 27_000 });
		// a child session's calls count, but the child is not in `sessions`
		const child = overview(
			[call("2026-10-05", "a", "m", 1, 1, { session: "/child" })],
			sessions,
			"all",
			"2026-10-06",
			[],
		);
		expect(child).toMatchObject({ sessions: 0, longestSessionMs: 0, totalTokens: 2 });
	});
});
