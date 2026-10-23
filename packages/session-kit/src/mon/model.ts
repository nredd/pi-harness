/** Presentation-only resource values. The sampler adapter owns measurement and validity. */
export interface MonProcess {
	/** Stable sampler identity, not PID alone (PIDs can be reused). */
	identity: string;
	pid: number;
	name: string;
	cpuPercent: number | null;
	rssBytes: number | null;
}

/** No process arguments, environment, working directories or host identifiers enter the view. */
export interface MonSnapshot {
	cpuPercent: number | null;
	logicalCpus: number;
	memoryUsedBytes: number | null;
	memoryTotalBytes: number | null;
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
	/** Safe, bounded diagnostic supplied by the adapter. */
	notice?: string;
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
 * after the first capture without a CPU value are real gaps (`·`), never interpolated CPU; columns
 * before it are blank because no history exists yet. The latest sample in a bucket wins.
 */
export function timeHistory(history: readonly MonHistoryPoint[], width: number): string {
	const first = history[0];
	const last = history.at(-1);
	if (!first || !last || width < 1) return "";
	const span = last.sampledAtMs - first.sampledAtMs;
	if (span <= 0) return sparkline([last.value], 1).padStart(width);
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
	return " ".repeat(oldest) + sparkline(buckets.slice(oldest), width - oldest);
}

/** Fixed 0..100 host CPU scale: a quiet history must not look saturated. */
export function sparkline(history: readonly (number | null)[], width: number): string {
	const ticks = "▁▂▃▄▅▆▇█";
	const values = history.slice(-Math.max(0, width));
	return values
		.map((n) => (n === null || !Number.isFinite(n) ? "·" : ticks[Math.min(7, Math.max(0, Math.round((n * 7) / 100)))]))
		.join("");
}
