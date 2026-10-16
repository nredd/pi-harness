import { describe, expect, it } from "vitest";
import { heatmap, level, monthRow, quartiles, weeksFor } from "../../src/stats/heatmap.ts";

const plain = (_c: string, s: string) => s;

describe("heatmap", () => {
	it("shades by quartiles of the non-zero days", () => {
		const q = quartiles([0, 1, 2, 3, 4, 5, 6, 7, 8]);
		expect(q).toEqual([3, 5, 7]);
		expect([0, 1, 3, 5, 7, 100].map((v) => level(v, q))).toEqual([0, 1, 2, 3, 4, 4]);
		expect(quartiles([0, 0])).toBeUndefined();
		expect(level(5, undefined)).toBe(0);
	});

	it("fills the width, one week per column", () => {
		expect(weeksFor(200)).toBe(196);
		expect(weeksFor(30)).toBe(26);
		expect(weeksFor(1)).toBe(1);
	});

	it("labels months that have room, and always the newest one", () => {
		// 2025-10-19 is a Sunday; Oct gets two weeks, too few for "Oct " so Nov is labelled instead
		const row = monthRow("2025-10-19", 52);
		expect(row.startsWith("  Nov")).toBe(true);
		expect(row.trimEnd().endsWith("Oct")).toBe(true);
		expect(row.split(/\s+/).filter(Boolean)).toEqual([
			"Nov",
			"Dec",
			"Jan",
			"Feb",
			"Mar",
			"Apr",
			"May",
			"Jun",
			"Jul",
			"Aug",
			"Sep",
			"Oct",
		]);
	});

	it("renders a fixed today (golden), with future days blank", () => {
		// Tue 2026-10-13, 8 week columns: Sundays Aug 23 .. Oct 11. Aug has 2 columns, too few for a label.
		// Quartiles of [10, 20, 30, 40] are 20/30/40, so 10 -> ░, 20 -> ▒, 30 -> ▓, 40 -> █.
		const daily = new Map([
			["2026-10-13", 40],
			["2026-10-12", 30],
			["2026-10-07", 20],
			["2026-09-01", 10],
		]);
		const lines = heatmap(daily, "2026-10-13", 12, plain);
		expect(lines).toEqual([
			"      Sep Oct",
			"    ········",
			"Mon ·······▓",
			"    ·░·····█",
			"Wed ······▒ ",
			"    ······· ",
			"Fri ······· ",
			"    ······· ",
			"    Less ░ ▒ ▓ █ More",
		]);
	});
});
