/**
 * X-axis ticks for the `/stats` time-series charts, one rule for every timescale.
 *
 * A chart has `n` buckets stretched over `width` plot columns, bucket `k` on column
 * `round(k * width / (n - 1))` (see `stretch`). A tick is a bucket. Candidate tick sets run from fine
 * to coarse (every hour, every 2 hours, ... / every day, every Monday, every 14 days, ... / every
 * month, every quarter, ...), each with a wide and a narrow label format. The first set whose labels
 * all fit, with air between them and at most `MAX_TICKS` of them, wins. So ticks are evenly spaced
 * (clock- or calendar-aligned), never overlap, and are never cut: a label that cannot fit is not drawn.
 */

import { dayKey, monthName, shortDate, weekdayName } from "./days.ts";

/** What one bucket spans. `size` is days per bucket for the daily scale. */
export type Timescale = { kind: "hour" } | { kind: "day"; size: number };

export interface Tick {
	/** Bucket index. */
	bucket: number;
	/** Plot column the bucket sits on. */
	column: number;
	label: string;
	/** Column the label's first character is drawn in. */
	start: number;
}

export interface TimeAxis {
	ticks: Tick[];
	/** Baseline with a mark per tick, labels, and for hourly charts a row of dates. */
	lines: string[];
}

/** More labels than this stop reading as an axis. */
export const MAX_TICKS = 13;
/** Hours between ticks, finest first; all divide a day so ticks land on the clock. */
const HOUR_STRIDES = [1, 2, 3, 4, 6, 12, 24] as const;
/** Days between ticks for the daily scale, finest first. */
const DAY_STRIDES = [1, 2, 3, 7, 14] as const;
/** Months between ticks, finest first. */
const MONTH_STRIDES = [1, 2, 3, 6, 12] as const;
/** Weekday names label every bucket up to this many days. */
const WEEKDAY_MAX = 8;
/** Blank columns required between two labels, for the wide and the narrow variant. */
const GAP = [3, 2] as const;

interface Mark {
	bucket: number;
	/** Wide to narrow. */
	labels: string[];
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** `09:00`, or `05:30` where the zone's hours start at :30. */
export function hourWide(ms: number): string {
	const d = new Date(ms);
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** `9a`, `12p`: the short 12-hour form. Half-hour zones keep `05:30`, already as short as it gets. */
export function hourNarrow(ms: number): string {
	const d = new Date(ms);
	if (d.getMinutes()) return hourWide(ms);
	return `${d.getHours() % 12 || 12}${d.getHours() < 12 ? "a" : "p"}`;
}

/** Bucket column on a `width`-column plot, the last bucket on the last column. */
export function bucketColumn(bucket: number, count: number, width: number): number {
	if (count <= 1 || width <= 1) return 0;
	return Math.min(width - 1, Math.round((bucket * width) / (count - 1)));
}

/**
 * Every `stride`-th bucket from the first one on the clock. Stepping by bucket, not by local hour,
 * keeps ticks evenly spaced across a DST change; labels after it shift by the hour gained or lost.
 */
function hourLevels(starts: readonly number[]): Mark[][] {
	return HOUR_STRIDES.map((stride) => {
		const marks: Mark[] = [];
		const anchor = starts.findIndex((ms) => new Date(ms).getHours() % stride === 0);
		for (let bucket = anchor; anchor >= 0 && bucket < starts.length; bucket += stride) {
			const ms = starts[bucket] ?? 0;
			marks.push({ bucket, labels: [hourWide(ms), hourNarrow(ms)] });
		}
		return marks;
	});
}

/** Buckets `stride` apart counted back from the newest, so today is always labelled. */
function fromNewest(count: number, stride: number): number[] {
	const out: number[] = [];
	for (let k = count - 1; k >= 0; k -= stride) out.unshift(k);
	return out;
}

function dayLevels(starts: readonly number[], size: number): Mark[][] {
	const n = starts.length;
	const levels: Mark[][] = [];
	if (size === 1 && n <= WEEKDAY_MAX) {
		levels.push(
			starts.map((ms, bucket) => ({
				bucket,
				labels: [`${weekdayName(new Date(ms).getDay())} ${new Date(ms).getDate()}`],
			})),
		);
		levels.push(starts.map((ms, bucket) => ({ bucket, labels: [weekdayName(new Date(ms).getDay())] })));
	}
	for (const days of DAY_STRIDES) {
		if (days % size !== 0) continue;
		const stride = days / size;
		let buckets = fromNewest(n, stride);
		if (size === 1 && days % 7 === 0) {
			// Whole weeks: every `days`-th Monday, newest first.
			const newest = starts.map((ms) => new Date(ms).getDay()).lastIndexOf(1);
			buckets = newest < 0 ? [] : fromNewest(newest + 1, stride);
		}
		levels.push(buckets.map((bucket) => ({ bucket, labels: [shortDate(dayKey(starts[bucket] ?? 0))] })));
	}
	// A bucket carries the month whose first day it contains; the first label of a year carries it.
	// A bucket ends where the next starts (the first is often partial, DST days are 23 or 25 hours);
	// the last spans `size` calendar days.
	const firsts: { bucket: number; month: number; year: number }[] = [];
	starts.forEach((ms, bucket) => {
		const d = new Date(ms);
		const end = starts[bucket + 1] ?? new Date(d.getFullYear(), d.getMonth(), d.getDate() + size).getTime();
		const first = d.getDate() === 1 ? d : new Date(d.getFullYear(), d.getMonth() + 1, 1);
		if (first.getTime() < end) firsts.push({ bucket, month: first.getMonth(), year: first.getFullYear() });
	});
	for (const stride of MONTH_STRIDES) {
		const picked = firsts.filter((f) => f.month % stride === 0);
		// Years only when the ticks span more than one, on the first tick and every January; then no
		// variant drops them, so `Jan`, `Jan` never repeats unlabelled.
		const years = new Set(picked.map((f) => f.year)).size > 1;
		levels.push(
			picked.map((f, i) => {
				const plain = monthName(f.month);
				const tagged = years && (i === 0 || f.month === 0) ? `${plain} '${pad2(f.year % 100)}` : plain;
				return { bucket: f.bucket, labels: years ? [tagged] : [plain] };
			}),
		);
	}
	return levels;
}

/** Label start columns when `marks` use label variant `variant`, or `undefined` if any collide or overflow. */
function place(marks: readonly Mark[], variant: number, count: number, width: number): Tick[] | undefined {
	const gap = GAP[Math.min(variant, GAP.length - 1)] ?? 2;
	const ticks: Tick[] = [];
	let end = -gap;
	for (const m of marks) {
		const label = m.labels[Math.min(variant, m.labels.length - 1)] ?? "";
		const column = bucketColumn(m.bucket, count, width);
		if (label.length > width) return undefined;
		const start = Math.max(0, Math.min(width - label.length, column - Math.floor(label.length / 2)));
		if (start < end + gap) return undefined;
		ticks.push({ bucket: m.bucket, column, label, start });
		end = start + label.length;
	}
	return ticks;
}

/**
 * Pick the ticks for buckets starting at `starts` (local instants) on a `width`-column plot. Falls
 * back to the first and last bucket, then the last alone, when no regular set fits.
 */
export function chooseTicks(starts: readonly number[], scale: Timescale, width: number): Tick[] {
	const n = starts.length;
	if (n === 0 || width <= 0) return [];
	const levels = scale.kind === "hour" ? hourLevels(starts) : dayLevels(starts, scale.size);
	const endLabel = (b: number): Mark => ({
		bucket: b,
		labels: [scale.kind === "hour" ? hourWide(starts[b] ?? 0) : shortDate(dayKey(starts[b] ?? 0))],
	});
	const ends = [[endLabel(0), endLabel(n - 1)], [endLabel(n - 1)]];
	for (const [i, marks] of [...levels, ...ends].entries()) {
		const regular = i < levels.length;
		if (marks.length === 0 || (regular && (marks.length < 2 || marks.length > MAX_TICKS))) continue;
		if (n === 1 && marks.length > 1) continue;
		for (let variant = 0; variant < 2; variant++) {
			const ticks = place(marks, variant, n, width);
			if (ticks) return ticks;
		}
	}
	return [];
}

/** A row of `text` pieces at their start columns; callers pass non-overlapping pieces. */
function row(width: number, pieces: readonly { start: number; text: string }[]): string {
	const cells = new Array<string>(width).fill(" ");
	for (const p of pieces)
		for (let i = 0; i < p.text.length && p.start + i < width; i++) cells[p.start + i] = p.text[i] ?? " ";
	return cells.join("").trimEnd();
}

/**
 * Dates under an hourly axis: one at every bucket that starts a new local day and, room allowing, one
 * under the first bucket, so a 24h chart reads `Oct 12 ... Oct 13` across its midnight.
 */
function dateRow(starts: readonly number[], width: number): string {
	const n = starts.length;
	const pieces: { start: number; text: string }[] = [];
	const free = (start: number, len: number) =>
		pieces.every((p) => start >= p.start + p.text.length + 2 || start + len + 2 <= p.start);
	const add = (bucket: number) => {
		const text = shortDate(dayKey(starts[bucket] ?? 0));
		const column = bucketColumn(bucket, n, width);
		const start = Math.max(0, Math.min(width - text.length, column));
		if (text.length <= width && free(start, text.length)) pieces.push({ start, text });
	};
	// Every bucket on a new local day: midnight, or 00:30 in half-hour zones, wherever DST puts it.
	starts.forEach((ms, bucket) => {
		if (bucket > 0 && dayKey(ms) !== dayKey(starts[bucket - 1] ?? ms)) add(bucket);
	});
	add(0);
	return row(width, pieces);
}

/**
 * The x-axis under a plot: a baseline (`└──┬──┬──`), the tick labels, and for hourly charts the dates.
 * `gutter` is the plot's left margin (`GUTTER`); lines are plain text, painted by the caller.
 */
export function timeAxis(starts: readonly number[], scale: Timescale, width: number, gutter: number): TimeAxis {
	const ticks = chooseTicks(starts, scale, width);
	const base = new Array<string>(width).fill("─");
	for (const t of ticks) base[t.column] = "┬";
	const margin = " ".repeat(gutter);
	const lines = [`${" ".repeat(Math.max(0, gutter - 1))}└${base.join("")}`];
	if (ticks.length > 0)
		lines.push(
			margin +
				row(
					width,
					ticks.map((t) => ({ start: t.start, text: t.label })),
				),
		);
	if (scale.kind === "hour") {
		const dates = dateRow(starts, width);
		if (dates) lines.push(margin + dates);
	}
	return { ticks, lines };
}
