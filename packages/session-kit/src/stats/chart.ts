/**
 * The "Tokens per day" line chart: an asciichart-style plot (`╭╮╰╯│─`) with nice y-axis ticks and
 * time ticks in `ticks.ts`. Pure: colours go through a `paint` callback so tests can render plain text.
 *
 * Days are bucketed (1, 2, 3, 7, 14 or 30 days) so the whole range fits the width, then sampled
 * with linear interpolation across every column so a short range draws a smooth curve rather
 * than a staircase.
 */

import { addDays, daysBetween } from "./days.ts";
import { axisLabel } from "./format.ts";

export const BUCKET_SIZES = [1, 2, 3, 7, 14, 30] as const;
const BUCKET_UNIT: Record<number, string> = {
	1: "day",
	2: "2 days",
	3: "3 days",
	7: "week",
	14: "2 weeks",
	30: "30 days",
};
/** Fixed y-axis intervals: labels land on every `height / TICKS` rows. */
export const TICKS = 5;

/** Box-drawing ports: a glyph is the set of sides its line leaves through. */
const L = 1;
const R = 2;
const U = 4;
const D = 8;
const GLYPH: Record<number, string> = {
	[L | R]: "─",
	[U | D]: "│",
	[R | D]: "╭",
	[L | D]: "╮",
	[U | R]: "╰",
	[L | U]: "╯",
	[L | R | U]: "┴",
	[L | R | D]: "┬",
	[U | D | R]: "├",
	[U | D | L]: "┤",
	[L | R | U | D]: "┼",
};
/** Y labels are right-aligned to this many columns, then ` ┤`. */
export const LABEL_WIDTH = 6;
export const GUTTER = LABEL_WIDTH + 2;
const NICE = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10] as const;

export interface Bucket {
	/** First day in the bucket. */
	start: string;
	/** Tokens per series. */
	values: number[];
}

export interface Bucketed {
	size: number;
	unit: string;
	buckets: Bucket[];
}

/**
 * Sum per-day values into buckets of the smallest size that yields at most `maxBuckets` (at least 2).
 * Buckets end on `to` so the newest bucket is always complete up to today.
 */
export function bucketize(
	from: string,
	to: string,
	perDay: (day: string) => number[],
	seriesCount: number,
	maxBuckets: number,
): Bucketed {
	const days = Math.max(1, daysBetween(from, to) + 1);
	const most = Math.max(2, maxBuckets);
	// Calendar-friendly sizes first; past 30-day buckets, whatever size makes it fit.
	const size = BUCKET_SIZES.find((s) => Math.ceil(days / s) <= most) ?? Math.ceil(days / most);
	const count = Math.ceil(days / size);
	const buckets: Bucket[] = [];
	for (let b = 0; b < count; b++) {
		const end = addDays(to, -(count - 1 - b) * size);
		const start = addDays(end, -(size - 1));
		const values = new Array<number>(seriesCount).fill(0);
		for (let i = 0; i < size; i++) {
			const day = addDays(start, i);
			if (day < from) continue;
			const v = perDay(day);
			for (let s = 0; s < seriesCount; s++) values[s] = (values[s] ?? 0) + (v[s] ?? 0);
		}
		buckets.push({ start: start < from ? from : start, values });
	}
	return { size, unit: BUCKET_UNIT[size] ?? `${size} days`, buckets };
}

/**
 * Smallest of 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 x 10^k that is >= `x`: round labels, little headroom.
 * Tokens are whole, so the step is a whole number too (never below 1, never 1.5 or 2.5).
 */
export function niceStep(x: number): number {
	if (!(x > 1)) return 1;
	const exp = 10 ** Math.floor(Math.log10(x));
	for (const m of NICE) {
		const step = m * exp;
		if (Number.isInteger(step) && step >= x - 1e-9 * exp) return step;
	}
	return 10 * exp;
}

/**
 * Stretch `values` over `columns` points: bucket `k` lands exactly on column `round(k * (columns - 1) /
 * (n - 1))` with its true value, and columns between two buckets are linearly interpolated. Every
 * bucket value, so every peak, appears unchanged. Needs `n <= columns`, which `bucketize` guarantees.
 */
export function stretch(values: readonly number[], columns: number): number[] {
	const n = values.length;
	if (n === 0) return new Array<number>(columns).fill(0);
	if (n === 1) return new Array<number>(columns).fill(values[0] ?? 0);
	const out = new Array<number>(columns).fill(0);
	const at = (k: number) => Math.round((k * (columns - 1)) / (n - 1));
	for (let k = 0; k < n - 1; k++) {
		const from = at(k);
		const to = at(k + 1);
		const a = values[k] ?? 0;
		const b = values[k + 1] ?? 0;
		for (let c = from; c <= to; c++) out[c] = to === from ? b : a + ((b - a) * (c - from)) / (to - from);
	}
	return out;
}

export interface Series<C extends string | number> {
	values: number[];
	color: C;
}

export interface PlotOptions<C extends string | number> {
	/** Plot columns, axis excluded. */
	width: number;
	/** Plot rows above the zero line; a multiple of `TICKS` gives evenly spaced labels. */
	height: number;
	paint: (color: C | "axis", text: string) => string;
}

export interface Plot {
	lines: string[];
	/** Columns before the plot area (labels + axis), for aligning the x-axis. */
	gutter: number;
	max: number;
}

/**
 * Plot `series` stretched over `width` columns. Overlapping series merge into junction glyphs and
 * the first (largest) series keeps the shared cell's colour.
 */
export function plot<C extends string | number>(series: readonly Series<C>[], options: PlotOptions<C>): Plot {
	const width = Math.max(2, Math.floor(options.width));
	const height = Math.max(1, Math.floor(options.height));
	const sampled = series.map((s) => stretch(s.values, width + 1));
	const raw = Math.max(0, ...series.flatMap((s) => s.values));
	const step = niceStep(raw / TICKS || 1);
	const max = step * TICKS;
	const labels = Array.from({ length: TICKS + 1 }, (_, i) => axisLabel(step * i));
	const labelWidth = Math.max(LABEL_WIDTH, ...labels.map((l) => l.length));
	const row = (v: number) => Math.round((v / max) * height);

	// Cells hold box-drawing ports, not glyphs: where series overlap their ports are OR-ed, so a
	// crossing becomes `┴`/`┬`/`┼` and every line stays connected. The first series keeps the colour.
	const grid: { ports: number; color?: C }[][] = Array.from({ length: height + 1 }, () =>
		Array.from({ length: width }, () => ({ ports: 0 })),
	);
	const put = (y: number, x: number, ports: number, color: C) => {
		const cell = grid[height - y]?.[x];
		if (!cell) return;
		cell.ports |= ports;
		cell.color ??= color;
	};
	for (let s = 0; s < sampled.length; s++) {
		const values = sampled[s] ?? [];
		const color = series[s]?.color as C;
		for (let x = 0; x < width; x++) {
			const y0 = row(values[x] ?? 0);
			const y1 = row(values[x + 1] ?? 0);
			if (y0 === y1) {
				put(y0, x, L | R, color);
				continue;
			}
			// enter from the left at y0, leave to the right at y1, vertical in between
			put(y0, x, L | (y1 > y0 ? U : D), color);
			put(y1, x, R | (y1 > y0 ? D : U), color);
			for (let y = Math.min(y0, y1) + 1; y < Math.max(y0, y1); y++) put(y, x, U | D, color);
		}
	}

	const perTick = height / TICKS;
	const lines: string[] = [];
	for (let r = 0; r <= height; r++) {
		const y = height - r;
		const tick = Number.isInteger(y / perTick) ? y / perTick : -1;
		const label = tick >= 0 ? (labels[tick] ?? "") : "";
		const axis = tick >= 0 ? "┤" : "│";
		let body = "";
		let run = "";
		let runColor: C | undefined;
		const flush = () => {
			if (run) body += runColor !== undefined ? options.paint(runColor, run) : run;
			run = "";
		};
		for (const cell of grid[r] ?? []) {
			if (cell.color !== runColor) {
				flush();
				runColor = cell.color;
			}
			run += GLYPH[cell.ports] ?? " ";
		}
		flush();
		lines.push(`${options.paint("axis", `${label.padStart(labelWidth)} ${axis}`)}${body}`);
	}
	return { lines, gutter: labelWidth + 2, max };
}
