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
	/** Local display time, never persisted. */
	capturedAt: number;
	status: "live" | "warming" | "stale";
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

/** Fixed 0..100 host CPU scale: a quiet history must not look saturated. */
export function sparkline(history: readonly (number | null)[], width: number): string {
	const ticks = "▁▂▃▄▅▆▇█";
	const values = history.slice(-Math.max(0, width));
	return values
		.map((n) => (n === null || !Number.isFinite(n) ? "·" : ticks[Math.min(7, Math.max(0, Math.round((n * 7) / 100)))]))
		.join("");
}
