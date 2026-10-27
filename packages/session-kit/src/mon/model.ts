/** Presentation-only resource values. The sampler adapter owns measurement and validity. */
export interface MonProcess {
	/** Stable sampler identity, not PID alone (PIDs can be reused). */
	identity: string;
	pid: number;
	/** Untrusted executable basename; "" when the OS gave none. */
	name: string;
	/** `unknown`: no name was readable. `truncated`: the OS limit may have cut it (macOS 16 bytes). */
	nameState?: "unknown" | "truncated";
	cpuPercent: number | null;
	rssBytes: number | null;
}

/** No process arguments, environment, working directories or host identifiers enter the view. */
export interface MonSnapshot {
	cpuPercent: number | null;
	logicalCpus: number;
	memoryUsedBytes: number | null;
	memoryTotalBytes: number | null;
	/** Explicit measurement basis; older fixtures/producers default to total-free. */
	memoryBasis?: "total-free" | "app+wired+compressed";
	memoryFreeBytes?: number | null;
	swapUsedBytes?: number | null;
	swapTotalBytes?: number | null;
	load: readonly number[];
	processes: readonly MonProcess[];
	/** Wall-clock capture time, for display only (it can jump). Never persisted. */
	capturedAt: number;
	/** Monotonic capture time; history spacing uses this, never wall time. */
	sampledAtMs: number;
	/** Collection time of this capture, when the adapter measured it. */
	scanMs?: number | null;
	/** Collector outcome: `live` is a successful collection even when host CPU has no value yet. */
	status: "live" | "stale";
	/** Host interval CPU state, independent of collector success. */
	cpuState: "available" | "warming" | "unavailable";
	/** Process interval CPU cannot exist for this platform; the view then defaults to RSS order. */
	processCpu?: "unavailable";
	/** Safe, bounded warning supplied by the adapter: something limits what the view can show. */
	notice?: string;
	/** Safe, bounded platform note (expected limits, e.g. macOS process CPU); rendered muted. */
	hint?: string;
}

export type MonSort = "cpu" | "rss" | "pid";
export const SORTS: readonly MonSort[] = ["cpu", "rss", "pid"];

/** Unknown/non-finite measurements sort last; ties are deterministic across refreshes. */
export function sortProcesses(processes: readonly MonProcess[], sort: MonSort): MonProcess[] {
	return [...processes].sort((a, b) => {
		const av = sort === "cpu" ? a.cpuPercent : sort === "rss" ? a.rssBytes : a.pid;
		const bv = sort === "cpu" ? b.cpuPercent : sort === "rss" ? b.rssBytes : b.pid;
		const au = av === null || !Number.isFinite(av);
		const bu = bv === null || !Number.isFinite(bv);
		if (au !== bu) return au ? 1 : -1;
		if (!au && !bu && av !== bv) return sort === "pid" ? av - bv : bv - av;
		return a.pid - b.pid || a.identity.localeCompare(b.identity);
	});
}

export function percent(value: number | null): string {
	return value === null || !Number.isFinite(value) ? "--" : `${value.toFixed(1)}%`;
}

/** Process share of total RAM, from the same sample's RSS and total. */
export function share(part: number | null, total: number | null): string {
	if (part === null || total === null || !Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return "--";
	return `${((part / total) * 100).toFixed(1)}`;
}

export function bytes(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return "--";
	return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)}G` : `${(value / 1024 ** 2).toFixed(0)}M`;
}

export interface MonHistoryPoint {
	/** Monotonic milliseconds, so wall-clock steps cannot invent or hide gaps. */
	sampledAtMs: number;
	value: number | null;
}

/**
 * Time-proportional buckets, newest on the right. A column is the typical sampling interval (lower
 * median of consecutive captures), widened only when the history spans more than the width. Columns
 * after the first capture without a CPU value are real gaps (`null`), never interpolated CPU; the
 * leading `blank` columns precede the first capture because no history exists yet. The latest sample
 * in a bucket wins.
 */
function historyBuckets(
	history: readonly MonHistoryPoint[],
	width: number,
): { blank: number; buckets: (number | null)[] } {
	const first = history[0];
	const last = history.at(-1);
	if (!first || !last || width < 1) return { blank: Math.max(0, width), buckets: [] };
	const span = last.sampledAtMs - first.sampledAtMs;
	if (span <= 0) return { blank: width - 1, buckets: [last.value] };
	const deltas = history
		.slice(1)
		.map((point, i) => point.sampledAtMs - (history[i]?.sampledAtMs ?? point.sampledAtMs))
		.filter((delta) => delta > 0)
		.sort((a, b) => a - b);
	const typical = deltas[Math.floor((deltas.length - 1) / 2)] ?? span;
	const step = Math.max(typical, span / Math.max(1, width - 1));
	const buckets: (number | null)[] = Array.from({ length: width }, () => null);
	let oldest = width - 1;
	for (const point of history) {
		const index = width - 1 - Math.round((last.sampledAtMs - point.sampledAtMs) / step);
		if (index < 0 || index >= width) continue;
		buckets[index] = point.value;
		oldest = Math.min(oldest, index);
	}
	return { blank: oldest, buckets: buckets.slice(oldest) };
}

/** One-row history: blank before data, `·` for gaps. */
export function timeHistory(history: readonly MonHistoryPoint[], width: number): string {
	if (!history.length || width < 1) return "";
	const { blank, buckets } = historyBuckets(history, width);
	return " ".repeat(blank) + sparkline(buckets, buckets.length);
}

/**
 * Multi-row history (top row first), `rows * 8` levels on the same fixed 0..100 scale. A gap is `·`
 * on the bottom row only; zero keeps a `▁` baseline so a quiet host never looks like missing data.
 */
export function timeHistoryRows(history: readonly MonHistoryPoint[], width: number, rows: number): string[] {
	if (rows <= 1) return [timeHistory(history, width)];
	const lines = Array.from({ length: rows }, () => "");
	if (!history.length || width < 1) return lines;
	const { blank, buckets } = historyBuckets(history, width);
	const ticks = "▁▂▃▄▅▆▇█";
	for (let row = 0; row < rows; row++) lines[row] = " ".repeat(blank);
	for (const value of buckets) {
		const level =
			value === null || !Number.isFinite(value)
				? -1
				: Math.max(0, Math.min(rows * 8, Math.round((value * rows * 8) / 100)));
		for (let row = 0; row < rows; row++) {
			// Row 0 is the top; `fill` is how many eighths this row holds.
			const floor = (rows - 1 - row) * 8;
			const fill = level - floor;
			const bottom = row === rows - 1;
			lines[row] +=
				level < 0 ? (bottom ? "·" : " ") : fill >= 8 ? "█" : fill > 0 ? (ticks[fill - 1] ?? " ") : bottom ? "▁" : " ";
		}
	}
	return lines;
}

/** Fixed 0..100 host CPU scale: a quiet history must not look saturated. */
export function sparkline(history: readonly (number | null)[], width: number): string {
	const ticks = "▁▂▃▄▅▆▇█";
	const values = history.slice(-Math.max(0, width));
	return values
		.map((n) => (n === null || !Number.isFinite(n) ? "·" : ticks[Math.min(7, Math.max(0, Math.round((n * 7) / 100)))]))
		.join("");
}
