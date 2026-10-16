import { describe, expect, it } from "vitest";
import {
	dailySeries,
	HOUR_MS,
	hourLabel,
	hourlySeries,
	inRange,
	modelTotals,
	overview,
	tokensOf,
} from "../../src/stats/aggregate.ts";
import { dayKey } from "../../src/stats/days.ts";
import { call } from "./fixtures.ts";

const base = Date.parse("2026-10-02T02:30:00Z");
const c = (ms: number, input = 1) =>
	call("2026-10-02", "p", "m", input, 2, { ms, cacheRead: 3, cacheWrite: 4, cost: 0.25 });

describe("hourly stats", () => {
	it("filters exact rolling boundaries, midnight and future instants identically for all totals", () => {
		const calls = [
			c(base - 5 * HOUR_MS - 1, 99),
			c(base - 5 * HOUR_MS, 10),
			c(base - HOUR_MS, 20),
			c(base, 30),
			c(base + 1, 999),
		];
		const filtered = calls.filter((c) => inRange("5h", dayKey(base), c.ms, base));
		expect(filtered.map((c) => c.input)).toEqual([10, 20, 30]);
		const points = hourlySeries(calls, "5h", base);
		expect(points).toHaveLength(6);
		expect(points[0]?.day).toContain("partial");
		expect(points.at(-1)?.day).toContain("partial");
		expect(points.filter((p) => !p.total)).toHaveLength(3);
		const total = filtered.reduce((n, c) => n + tokensOf(c), 0);
		expect(points.reduce((n, p) => n + p.total, 0)).toBe(total);
		expect(modelTotals(filtered).reduce((n, m) => n + tokensOf(m), 0)).toBe(total);
		expect(overview(filtered, [], "5h", dayKey(base), []).totalTokens).toBe(total);
		expect(inRange("all", dayKey(base), base + 1, base)).toBe(false);
		expect(inRange("7d", dayKey(base), base + 1, base)).toBe(false);
	});
	it("zero fills inactive exact-hour buckets, with inclusive start/end and partial last edge", () => {
		const now = Math.floor(base / HOUR_MS) * HOUR_MS;
		const points = hourlySeries([c(now - 24 * HOUR_MS), c(now - 1), c(now), c(now + 1)], "24h", now);
		expect(points).toHaveLength(25);
		expect(points[0]?.day).not.toContain("partial");
		expect(points.at(-1)?.day).toContain("partial");
		expect(points.filter((p) => p.total)).toHaveLength(3);
		expect(points.reduce((n, p) => n + p.total, 0)).toBe(30);
	});
	it("daily and hourly totals are invariant for the same retained calls", () => {
		const calls = Array.from({ length: 40 }, (_, i) => c(base - i * 30 * 60000, i));
		const points = hourlySeries(calls, "24h", base);
		const daily = dailySeries(calls, dayKey(calls.at(-1)?.ms ?? base), dayKey(base));
		expect(points.reduce((n, p) => n + p.total, 0)).toBe(daily.reduce((n, p) => n + p.total, 0));
	});
	it("labels repeated DST hours with different UTC offsets and never merges them", () => {
		const before = process.env.TZ;
		try {
			process.env.TZ = "America/New_York";
			const first = Date.parse("2026-11-01T05:00:00Z");
			const second = Date.parse("2026-11-01T06:00:00Z");
			expect(hourLabel(first)).toContain("01:00 UTC-04:00");
			expect(hourLabel(second)).toContain("01:00 UTC-05:00");
			const points = hourlySeries([c(first, 1), c(second, 2)], "5h", second + 30 * 60000);
			expect(points.filter((p) => p.total).map((p) => p.total)).toEqual([10, 11]);
			process.env.TZ = "Asia/Kolkata";
			expect(hourLabel(first)).toContain("10:30 UTC+05:30");
		} finally {
			if (before === undefined) delete process.env.TZ;
			else process.env.TZ = before;
		}
	});
});
