/**
 * GitHub-style activity heatmap, Claude Code's layout: one column per week (Sunday first), Mon/Wed/Fri
 * labels, month names over the week they start in, and four intensity levels at the quartiles of
 * the non-zero days.
 */

import { addDays, keyDate, monthName } from "./days.ts";

/** A year: the heatmap shows at least this many weeks whenever the pane fits them. */
export const YEAR_WEEKS = 52;
export const DAY_LABEL_WIDTH = 4;
const LEVEL_CHARS = ["·", "░", "▒", "▓", "█"] as const;

export type HeatColor = "heat" | "empty" | "label";

export function quartiles(values: Iterable<number>): [number, number, number] | undefined {
	const sorted = [...values].filter((v) => v > 0).sort((a, b) => a - b);
	if (sorted.length === 0) return undefined;
	const at = (q: number) => sorted[Math.floor(sorted.length * q)] ?? 0;
	return [at(0.25), at(0.5), at(0.75)];
}

export function level(value: number, q: [number, number, number] | undefined): 0 | 1 | 2 | 3 | 4 {
	if (value <= 0 || !q) return 0;
	if (value >= q[2]) return 4;
	if (value >= q[1]) return 3;
	if (value >= q[0]) return 2;
	return 1;
}

/**
 * Month names over the week each month starts in. A month whose columns cannot hold its name plus
 * a space (the clipped month at the left edge) goes unlabelled rather than crowding out the next;
 * the newest month is always labelled, even when its name runs past the last column.
 */
export function monthRow(start: string, weeks: number): string {
	const starts: { week: number; month: number }[] = [];
	for (let w = 0; w < weeks; w++) {
		const month = keyDate(addDays(start, w * 7)).getMonth();
		if (starts[starts.length - 1]?.month !== month) starts.push({ week: w, month });
	}
	const row = new Array<string>(weeks).fill(" ");
	starts.forEach(({ week, month }, i) => {
		const name = monthName(month);
		const next = starts[i + 1]?.week;
		// The newest month may run past the grid's right edge; the others need their name plus a space.
		if (next !== undefined && next - week < name.length + 1) return;
		for (let c = 0; c < name.length; c++) row[week + c] = name[c] ?? " ";
	});
	return row.join("").trimEnd();
}

/** How many week columns fit `width`: one per column after the day labels, so wider shows more history. */
export function weeksFor(width: number): number {
	return Math.max(1, width - DAY_LABEL_WIDTH);
}

/**
 * Render the heatmap for `daily` (tokens per day key) ending at `today`. Returns 7 day rows plus the
 * month row on top and a legend row at the bottom.
 */
export function heatmap(
	daily: ReadonlyMap<string, number>,
	today: string,
	width: number,
	paint: (color: HeatColor, text: string) => string,
): string[] {
	const weeks = weeksFor(width);
	const q = quartiles(daily.values());
	const todayDate = keyDate(today);
	const weekStart = addDays(today, -todayDate.getDay());
	const start = addDays(weekStart, -(weeks - 1) * 7);

	const rows: string[][] = Array.from({ length: 7 }, () => []);
	const months = monthRow(start, weeks);
	for (let w = 0; w < weeks; w++) {
		const sunday = addDays(start, w * 7);
		for (let d = 0; d < 7; d++) {
			const day = addDays(sunday, d);
			if (day > today) {
				rows[d]?.push(" ");
				continue;
			}
			const lv = level(daily.get(day) ?? 0, q);
			rows[d]?.push(lv === 0 ? paint("empty", LEVEL_CHARS[0]) : paint("heat", LEVEL_CHARS[lv]));
		}
	}

	const labels = ["   ", "Mon", "   ", "Wed", "   ", "Fri", "   "];
	const out = [`${" ".repeat(DAY_LABEL_WIDTH)}${paint("label", months)}`];
	for (let d = 0; d < 7; d++) out.push(`${paint("label", `${labels[d]} `)}${(rows[d] ?? []).join("")}`);
	out.push(
		`${" ".repeat(DAY_LABEL_WIDTH)}${paint("label", "Less ")}${[1, 2, 3, 4]
			.map((lv) => paint("heat", LEVEL_CHARS[lv] ?? ""))
			.join(" ")}${paint("label", " More")}`,
	);
	return out;
}
