import { describe, expect, it } from "vitest";
import { BUCKET_SIZES, bucketize, GUTTER, niceStep, plot, stretch, xAxis } from "../../src/stats/chart.ts";
import { addDays, daysBetween } from "../../src/stats/days.ts";
import { axisLabel, duration, formatTokens, money, percent } from "../../src/stats/format.ts";
import { danglingPorts } from "./ports.ts";

const plain = (_c: string, s: string) => s;

describe("format", () => {
	it.each([
		[0, "0"],
		[999, "999"],
		[999.4, "999"],
		[999.6, "1k"],
		[1000, "1k"],
		[12_345, "12k"],
		[999_000, "999k"],
		[999_600, "1M"],
		[1_000_000, "1M"],
		[1_234_567, "1.2M"],
		[3_400_000_000, "3.4B"],
	])("formatTokens(%d) = %s", (n, label) => {
		expect(formatTokens(n)).toBe(label);
	});

	it("keeps a decimal on axis ticks that formatTokens would round", () => {
		expect(axisLabel(2500)).toBe("2.5k");
		expect(axisLabel(1500)).toBe("1.5k");
		expect(axisLabel(3000)).toBe("3k");
		expect(axisLabel(7_500_000)).toBe("7.5M");
		expect(axisLabel(12_500_000)).toBe("12.5M");
		expect(axisLabel(0)).toBe("0");
	});

	it("formats money, durations and percentages", () => {
		expect(money(0.4)).toBe("$0.40");
		expect(money(1234)).toBe("$1.2k");
		expect(duration(27_000)).toBe("27s");
		expect(duration(14 * 60_000)).toBe("14m");
		expect(duration((3 * 60 + 5) * 60_000)).toBe("3h 5m");
		expect(duration(93 * 3600_000)).toBe("3d 21h");
		expect(percent(1, 3)).toBe("33.3%");
		expect(percent(1, 0)).toBe("0.0%");
	});
});

describe("bucketize", () => {
	const ones = (day: string) => [1, day.endsWith("-01") ? 10 : 0];

	it.each([
		[7, 40],
		[7, 80],
		[7, 120],
		[30, 40],
		[30, 80],
		[30, 120],
		[400, 40],
		[400, 80],
		[400, 120],
	])("%d days into <= %d buckets loses no day and no token", (days, width) => {
		const to = "2026-10-13";
		const from = addDays(to, -(days - 1));
		const b = bucketize(from, to, ones, 2, width);
		expect(b.buckets.length).toBeLessThanOrEqual(width);
		expect(b.buckets.reduce((n, x) => n + (x.values[0] ?? 0), 0)).toBe(days);
		expect(BUCKET_SIZES).toContain(b.size);
		// the smallest size that fits
		const smaller = BUCKET_SIZES.filter((s) => s < b.size);
		for (const s of smaller) expect(Math.ceil(days / s)).toBeGreaterThan(width);
		expect(b.buckets[0]?.start).toBe(from);
		expect(daysBetween(b.buckets[b.buckets.length - 1]?.start ?? from, to)).toBe(b.size - 1);
	});

	it("falls back past 30-day buckets so long histories still sum into the width", () => {
		const to = "2026-10-13";
		const from = addDays(to, -999);
		const b = bucketize(from, to, () => [1], 1, 10);
		expect(b.buckets.length).toBeLessThanOrEqual(10);
		expect(b.size).toBe(100);
		expect(b.unit).toBe("100 days");
		expect(b.buckets.reduce((n, x) => n + (x.values[0] ?? 0), 0)).toBe(1000);
	});

	it("names the bucket in the title unit", () => {
		expect(bucketize("2026-10-01", "2026-10-07", ones, 1, 80).unit).toBe("day");
		expect(bucketize("2025-10-14", "2026-10-13", ones, 1, 80).unit).toBe("week");
	});
});

describe("plot", () => {
	it("rounds the y axis up to a nice top with little headroom", () => {
		expect(niceStep(2.6e6)).toBe(3e6);
		expect(niceStep(2e6)).toBe(2e6);
		expect(niceStep(0.7)).toBe(1);
		expect(niceStep(0)).toBe(1);
		expect(niceStep(1.2)).toBe(2);
		expect(niceStep(2.2)).toBe(3);
		expect(niceStep(14)).toBe(15);
	});

	it("stretches buckets over columns, every bucket value landing exactly on a column", () => {
		expect(stretch([0, 10], 5)).toEqual([0, 2.5, 5, 7.5, 10]);
		expect(stretch([7], 3)).toEqual([7, 7, 7]);
		expect(stretch([], 2)).toEqual([0, 0]);
		const values = Array.from({ length: 51 }, (_, i) => (i === 25 ? 100 : 0));
		for (const columns of [51, 52, 77, 121]) {
			const out = stretch(values, columns);
			expect(out).toHaveLength(columns);
			expect(Math.max(...out)).toBe(100);
		}
	});

	it("never cuts an isolated peak: the axis top and the line both reach it", () => {
		const values = Array.from({ length: 51 }, (_, i) => (i === 25 ? 100 : 0));
		const p = plot([{ values, color: "a" }], { width: 50, height: 5, paint: plain });
		expect(p.max).toBeGreaterThanOrEqual(100);
		// the peak row (100 -> row 5 of a 0..100 axis) is drawn
		expect(p.lines[0]).toMatch(/^ {3}100 ┤.*╭╮/);
	});

	it("draws one series as rounded joins (golden)", () => {
		const p = plot([{ values: [0, 5, 5, 0], color: "a" }], { width: 6, height: 5, paint: plain });
		expect(p.gutter).toBe(GUTTER);
		expect(p.lines).toEqual([
			"     5 ┤ ╭──╮ ",
			"     4 ┤ │  │ ",
			"     3 ┤╭╯  ╰╮",
			"     2 ┤│    │",
			"     1 ┤│    │",
			"     0 ┼╯    ╰",
		]);
	});

	it("draws three series, the first on top, each in its own colour (golden)", () => {
		const tag = (c: string, s: string) => (c === "axis" ? s : `<${c}>${s}`);
		const p = plot(
			[
				{ values: [4, 4], color: "A" },
				{ values: [2, 2], color: "B" },
				{ values: [0, 4], color: "C" },
			],
			{ width: 4, height: 5, paint: tag },
		);
		expect(p.lines).toEqual([
			"     5 ┤    ",
			// C climbs one row per column; crossing B and joining A merge into junctions in their colour
			"     4 ┤<A>───┬",
			"     3 ┤  <C>╭╯",
			"     2 ┤<B>─┬┴─",
			"     1 ┤<C>╭╯  ",
			"     0 ┼<C>╯   ",
		]);
	});

	it("labels every row of a 5-row plot and every other row of a 10-row plot", () => {
		const ten = plot([{ values: [0, 9_000_000], color: "a" }], { width: 10, height: 10, paint: plain });
		expect(ten.lines).toHaveLength(11);
		expect(ten.lines[0]).toMatch(/^ {3}10M ┤/);
		expect(ten.lines[1]).toMatch(/^ {7}│/);
		expect(ten.lines[10]).toMatch(/^ {5}0 ┼/);
		for (const line of ten.lines) expect([...line].length).toBe(GUTTER + 10);
	});
});

describe("plot connectivity (regression: crossing series left broken joins like `╰╰`)", () => {
	const body = (lines: readonly string[]) => lines.map((l) => [...l].slice(GUTTER).join(""));

	it("keeps every line connected where two series overlap", () => {
		const p = plot(
			[
				{ values: [0, 0, 3, 3, 0, 0, 5, 1], color: "a" },
				{ values: [0, 1, 1, 0, 0, 1, 1, 0], color: "b" },
			],
			{ width: 20, height: 5, paint: plain },
		);
		expect(danglingPorts(body(p.lines))).toEqual([]);
	});

	it("stays connected at the edges: unequal lengths, more buckets than columns, empty series, height 0", () => {
		const cases: [number[][], number, number][] = [
			[[[0, 9, 0, 9], [5]], 10, 5],
			[
				[
					[0, 9, 0, 9, 0, 9, 0, 9, 0, 9, 0, 9],
					[3, 0, 3, 0, 3, 0, 3],
				],
				5,
				5,
			],
			[[[], [4, 0, 4]], 12, 5],
			[
				[
					[1, 5, 2],
					[5, 1, 5],
				],
				8,
				0,
			],
			[
				[
					[0, 0, 0],
					[0, 0, 0],
				],
				8,
				5,
			],
		];
		for (const [values, width, height] of cases) {
			const p = plot(
				values.map((v, i) => ({ values: v, color: `s${i}` })),
				{ width, height, paint: plain },
			);
			expect(danglingPorts(body(p.lines)), p.lines.join("\n")).toEqual([]);
		}
	});

	it("never leaves a dangling join for random 1-3 series at any size", () => {
		// deterministic LCG so a failure reproduces
		let seed = 42;
		const rand = () => {
			seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
			return seed / 2 ** 31;
		};
		for (let round = 0; round < 300; round++) {
			const count = 1 + Math.floor(rand() * 3);
			const n = 2 + Math.floor(rand() * 60);
			const width = Math.max(n, 20 + Math.floor(rand() * 100));
			const height = [5, 10, 15, 20][Math.floor(rand() * 4)] ?? 5;
			const series = Array.from({ length: count }, (_, s) => ({
				values: Array.from({ length: n }, () => (rand() < 0.3 ? 0 : Math.round(rand() * 10 ** (6 - s)))),
				color: `s${s}`,
			}));
			const p = plot(series, { width, height, paint: plain });
			const dangling = danglingPorts(body(p.lines));
			expect(dangling, `round ${round}\n${p.lines.join("\n")}`).toEqual([]);
		}
	});
});

describe("xAxis", () => {
	const buckets = (n: number) => Array.from({ length: n }, (_, i) => ({ start: addDays("2026-01-01", i), values: [] }));

	it.each([20, 40, 80, 113, 120])(
		"puts 2-5 labels, first and last included, never overlapping, inside %d columns",
		(width) => {
			const line = xAxis(buckets(365), width, GUTTER);
			const labels = line.trim().split(/ {2,}/);
			expect(labels.length).toBeGreaterThanOrEqual(2);
			expect(labels.length).toBeLessThanOrEqual(5);
			expect(labels[0]).toBe("Jan 1");
			expect(labels[labels.length - 1]).toBe("Dec 31");
			expect(line.length).toBeLessThanOrEqual(GUTTER + width);
			expect(line.slice(0, GUTTER).trim()).toBe("");
		},
	);

	it("handles a single bucket and an empty plot", () => {
		expect(xAxis(buckets(1), 40, 2).trim()).toBe("Jan 1");
		expect(xAxis([], 40, 2)).toBe("");
	});
});
