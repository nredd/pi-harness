import { describe, expect, it } from "vitest";
import { addDays, keyDate } from "../../src/stats/days.ts";
import {
	bucketColumn,
	chooseTicks,
	hourNarrow,
	hourWide,
	MAX_TICKS,
	type Tick,
	type Timescale,
	timeAxis,
} from "../../src/stats/ticks.ts";

/** `count` local hour starts from `from`. */
const hours = (count: number, from: [number, number, number, number] = [2026, 9, 13, 10]): number[] =>
	Array.from({ length: count }, (_, i) => new Date(from[0], from[1], from[2], from[3] + i).getTime());
/** `count` bucket starts, `size` days apart, the last on 2026-10-13. */
const days = (count: number, size = 1): number[] =>
	Array.from({ length: count }, (_, i) => keyDate(addDays("2026-10-13", -(count - 1 - i) * size)).getTime());

const HOUR: Timescale = { kind: "hour" };
/** 25 hourly buckets one UTC hour apart from `iso`, as the hourly series produces them. */
const utcHours = (iso: string): number[] => Array.from({ length: 25 }, (_, i) => Date.parse(iso) + i * 3_600_000);
/** Run with the process time zone set to `zone`, restoring it after. */
function inZone(zone: string, run: () => void): void {
	const before = process.env.TZ;
	try {
		process.env.TZ = zone;
		run();
	} finally {
		if (before === undefined) delete process.env.TZ;
		else process.env.TZ = before;
	}
}
const labels = (ticks: readonly Tick[]) => ticks.map((t) => t.label);

/** Every property the axis promises, whatever the scale and width. */
function expectWellFormed(ticks: readonly Tick[], count: number, width: number, even = true): void {
	expect(ticks.length).toBeLessThanOrEqual(MAX_TICKS);
	let end = -2;
	for (const t of ticks) {
		// aligned: the tick sits on its bucket's column, and its label covers that column (edges clamp)
		expect(t.column).toBe(bucketColumn(t.bucket, count, width));
		expect(t.start).toBeGreaterThanOrEqual(0);
		expect(t.start + t.label.length).toBeLessThanOrEqual(width);
		expect(t.start).toBeLessThanOrEqual(t.column);
		expect(t.start + t.label.length).toBeGreaterThan(t.column - (t.column >= width - 1 ? 1 : 0));
		// never overlapping, with air between labels
		expect(t.start).toBeGreaterThanOrEqual(end + 2);
		end = t.start + t.label.length;
	}
	if (!even || ticks.length < 3) return;
	const steps = ticks.slice(1).map((t, i) => t.bucket - (ticks[i]?.bucket ?? 0));
	expect(new Set(steps).size, `bucket steps ${steps}`).toBe(1);
}

describe("bucketColumn", () => {
	it("puts the first bucket on column 0 and the last on the last column", () => {
		expect(bucketColumn(0, 6, 40)).toBe(0);
		expect(bucketColumn(5, 6, 40)).toBe(39);
		expect(bucketColumn(1, 6, 40)).toBe(8);
		expect(bucketColumn(0, 1, 40)).toBe(0);
	});
});

describe("hour labels", () => {
	it("formats wide as HH:MM and narrow as the 12-hour form", () => {
		const at = (h: number, m = 0) => new Date(2026, 9, 13, h, m).getTime();
		expect([0, 5, 9, 12, 13, 23].map((h) => hourWide(at(h)))).toEqual([
			"00:00",
			"05:00",
			"09:00",
			"12:00",
			"13:00",
			"23:00",
		]);
		expect([0, 5, 9, 12, 13, 23].map((h) => hourNarrow(at(h)))).toEqual(["12a", "5a", "9a", "12p", "1p", "11p"]);
		expect(hourWide(at(5, 30))).toBe("05:30");
		expect(hourNarrow(at(17, 30))).toBe("17:30");
	});
});

describe("hourly ticks", () => {
	it("5h (6 buckets): every hour, wide when it fits, narrow when it does not", () => {
		const starts = hours(6);
		expect(labels(chooseTicks(starts, HOUR, 100))).toEqual(["10:00", "11:00", "12:00", "13:00", "14:00", "15:00"]);
		expect(labels(chooseTicks(starts, HOUR, 45))).toEqual(["10a", "11a", "12p", "1p", "2p", "3p"]);
		// too narrow for every hour: every second hour, still on the clock
		expect(labels(chooseTicks(starts, HOUR, 22))).toEqual(["10a", "12p", "2p"]);
	});

	it("24h (25 buckets): ticks land on the clock, 12 or fewer, wider panes get finer ones", () => {
		const starts = hours(25, [2026, 9, 12, 15]);
		const at = (width: number) => chooseTicks(starts, HOUR, width);
		expect(labels(at(160)).slice(0, 3)).toEqual(["16:00", "18:00", "20:00"]);
		expect(labels(at(100)).slice(0, 3)).toEqual(["16:00", "18:00", "20:00"]);
		expect(labels(at(60))).toEqual(["4p", "6p", "8p", "10p", "12a", "2a", "4a", "6a", "8a", "10a", "12p", "2p"]);
		expect(labels(at(40))).toEqual(["4p", "8p", "12a", "4a", "8a", "12p"]);
		expect(labels(at(20))).toEqual(["6p", "12a", "6a", "12p"]);
		expect(labels(at(12))).toEqual(["12a", "12p"]);
		for (const width of [10, 20, 30, 40, 60, 80, 100, 120, 160, 240, 320])
			expectWellFormed(at(width), starts.length, width);
	});

	it("gives hours that start at :30 their minutes", () => {
		const starts = Array.from({ length: 6 }, (_, i) => new Date(2026, 9, 13, 10 + i, 30).getTime());
		expect(labels(chooseTicks(starts, HOUR, 100))[0]).toBe("10:30");
		expect(labels(chooseTicks(starts, HOUR, 20))[0]).toBe("12:30");
	});

	it("draws no label that would be cut", () => {
		expect(chooseTicks(hours(6), HOUR, 3)).toEqual([]);
		expect(chooseTicks([], HOUR, 40)).toEqual([]);
		expect(chooseTicks(hours(6), HOUR, 0)).toEqual([]);
	});
});

describe("hourly ticks across DST", () => {
	it.each([
		["fall back, 01:00 repeats", "2026-11-01T00:00:00Z"],
		["spring forward, 02:00 skipped", "2026-03-08T00:00:00Z"],
	])("%s: ticks stay evenly spaced, starting on the clock", (_, iso) =>
		inZone("America/New_York", () => {
			const starts = utcHours(iso);
			for (const width of [60, 100, 160]) {
				const ticks = chooseTicks(starts, HOUR, width);
				expect(ticks.length).toBeGreaterThanOrEqual(3);
				expectWellFormed(ticks, starts.length, width);
				expect(new Date(starts[ticks[0]?.bucket ?? 0] ?? 0).getMinutes()).toBe(0);
			}
		}),
	);
});

describe("daily ticks", () => {
	const day = (size: number): Timescale => ({ kind: "day", size });

	it("a week of single days: weekday and date, then weekday alone", () => {
		const starts = days(7);
		expect(labels(chooseTicks(starts, day(1), 100))).toEqual([
			"Wed 7",
			"Thu 8",
			"Fri 9",
			"Sat 10",
			"Sun 11",
			"Mon 12",
			"Tue 13",
		]);
		expect(labels(chooseTicks(starts, day(1), 40))).toEqual(["Wed", "Thu", "Fri", "Sat", "Sun", "Mon", "Tue"]);
	});

	it("a month of days: dates, every other Monday and then every Monday as room grows", () => {
		const starts = days(30);
		expect(labels(chooseTicks(starts, day(1), 20))).toEqual(["Sep 14", "Oct 13"]);
		expect(labels(chooseTicks(starts, day(1), 36))).toEqual(["Sep 14", "Sep 28", "Oct 12"]);
		expect(labels(chooseTicks(starts, day(1), 60))).toEqual(["Sep 14", "Sep 21", "Sep 28", "Oct 5", "Oct 12"]);
		expect(labels(chooseTicks(starts, day(1), 240))).toEqual([
			"Sep 16",
			"Sep 19",
			"Sep 22",
			"Sep 25",
			"Sep 28",
			"Oct 1",
			"Oct 4",
			"Oct 7",
			"Oct 10",
			"Oct 13",
		]);
		for (const width of [20, 36, 60, 100, 160, 240]) expectWellFormed(chooseTicks(starts, day(1), width), 30, width);
	});

	it("60 days: Mondays, every other Monday when a week is too tight, months when both are", () => {
		const starts = days(60);
		expect(labels(chooseTicks(starts, day(1), 100)).slice(-2)).toEqual(["Oct 5", "Oct 12"]);
		expect(labels(chooseTicks(starts, day(1), 60))).toEqual(["Aug 17", "Aug 31", "Sep 14", "Sep 28", "Oct 12"]);
		expect(labels(chooseTicks(starts, day(1), 36))).toEqual(["Sep", "Oct"]);
	});

	it("multi-day buckets keep dates, aligned back from the newest bucket", () => {
		const two = chooseTicks(days(30, 2), day(2), 100);
		expect(labels(two)).toEqual(["Aug 18", "Sep 1", "Sep 15", "Sep 29", "Oct 13"]);
		expectWellFormed(two, 30, 100);
		const week = chooseTicks(days(52, 7), day(7), 160);
		expect(week.at(-1)?.label).toBe("Oct");
	});

	it("a year and more: month names, quarters and half years when tight, years only where they differ", () => {
		const weeks = days(52, 7);
		expect(labels(chooseTicks(weeks, day(7), 160)).slice(0, 3)).toEqual(["Nov '25", "Dec", "Jan '26"]);
		expect(labels(chooseTicks(weeks, day(7), 40))).toEqual(["Jan", "Apr", "Jul", "Oct"]);
		expect(labels(chooseTicks(weeks, day(7), 20))).toEqual(["Jan", "Jul"]);
		const long = days(40, 30);
		expect(labels(chooseTicks(long, day(30), 100))).toEqual(["Jan '24", "Jul", "Jan '25", "Jul", "Jan '26", "Jul"]);
		expect(labels(chooseTicks(long, day(30), 30))).toEqual(["Jan '24", "Jan '25", "Jan '26"]);
		for (const width of [20, 40, 80, 113, 120, 240]) {
			for (const [count, size] of [
				[52, 7],
				[40, 30],
				[30, 14],
				[60, 3],
			] as const)
				expectWellFormed(chooseTicks(days(count, size), day(size), width), count, width, false);
		}
	});

	it("a partial first bucket does not claim the next bucket's month", () => {
		// Weekly buckets after a one-day partial bucket on Jan 31: February starts in bucket 1, not 0,
		// so a wide pane still gets every month instead of falling back to every other one.
		const weekly = Array.from({ length: 52 }, (_, i) => keyDate(addDays("2026-02-01", i * 7)).getTime());
		const starts = [keyDate("2026-01-31").getTime(), ...weekly];
		const ticks = chooseTicks(starts, { kind: "day", size: 7 }, 160);
		expect(labels(ticks)).toEqual([
			"Feb '26",
			"Mar",
			"Apr",
			"May",
			"Jun",
			"Jul",
			"Aug",
			"Sep",
			"Oct",
			"Nov",
			"Dec",
			"Jan '27",
		]);
		expect(ticks[0]?.bucket).toBe(1);
		expectWellFormed(ticks, starts.length, 160, false);
	});

	it("handles one bucket and one that cannot fit a label", () => {
		expect(labels(chooseTicks(days(1), day(1), 40))).toEqual(["Oct 13"]);
		expect(chooseTicks(days(1), day(1), 4)).toEqual([]);
	});
});

describe("timeAxis", () => {
	it("draws a baseline with a mark under every tick and the labels under the marks", () => {
		const gutter = 8;
		const axis = timeAxis(hours(6), HOUR, 60, gutter);
		const [base, names] = axis.lines;
		expect(base?.slice(0, gutter)).toBe("       └");
		expect([...(base ?? "")].filter((c) => c === "┬")).toHaveLength(axis.ticks.length);
		for (const t of axis.ticks) {
			expect((base ?? "")[gutter + t.column]).toBe("┬");
			expect((names ?? "").slice(gutter + t.start, gutter + t.start + t.label.length)).toBe(t.label);
		}
		expect([...(base ?? "")]).toHaveLength(gutter + 60);
	});

	it("adds a date row to hourly axes: first bucket and every midnight", () => {
		const axis = timeAxis(hours(25, [2026, 9, 12, 15]), HOUR, 100, 8);
		const dates = axis.lines[2] ?? "";
		expect(dates.trim().split(/ {2,}/)).toEqual(["Oct 12", "Oct 13"]);
		const midnight = hours(25, [2026, 9, 12, 15]).findIndex((ms) => new Date(ms).getHours() === 0);
		expect(dates.indexOf("Oct 13") - 8).toBe(bucketColumn(midnight, 25, 100));
		expect(timeAxis(hours(6), HOUR, 60, 8).lines[2]?.trim()).toBe("Oct 13");
		expect(timeAxis(days(7), { kind: "day", size: 1 }, 60, 8).lines).toHaveLength(2);
	});

	it("dates every new local day in half-hour zones, where no bucket starts at midnight", () =>
		inZone("Asia/Kolkata", () => {
			// 05:30 Oct 12 to 05:30 Oct 13 IST: the day changes at the 00:30 bucket.
			const dates = timeAxis(utcHours("2026-10-12T00:00:00Z"), HOUR, 100, 8).lines[2] ?? "";
			expect(dates).toContain("Oct 12");
			expect(dates).toContain("Oct 13");
		}));

	it("keeps every date whole and apart at any width, dropping the ones that do not fit", () =>
		inZone("America/New_York", () => {
			// 23:00 Mar 7 to 01:00 Mar 9 EDT: two day changes across the spring-forward day.
			const starts = utcHours("2026-03-08T04:00:00Z");
			for (let width = 4; width <= 120; width++) {
				const dates = timeAxis(starts, HOUR, width, 8).lines[2]?.slice(8) ?? "";
				expect(dates.length, `${width}`).toBeLessThanOrEqual(width);
				expect(dates.trim().split(/ {2,}/).filter(Boolean), `${width}`).toEqual(dates.match(/Mar \d+/g) ?? []);
			}
			// Mar 8 starts one bucket in, so it wins over the first bucket's Mar 7.
			const wide = timeAxis(starts, HOUR, 100, 8).lines[2] ?? "";
			expect(wide).toMatch(/Mar 8 .*Mar 9/);
			expect(wide).not.toContain("Mar 7");
		}));

	it("is just a baseline when nothing fits", () => {
		const axis = timeAxis(hours(6), HOUR, 3, 8);
		expect(axis.ticks).toEqual([]);
		expect(axis.lines[0]).toBe("       └───");
	});
});
