import type { CpuInfo } from "node:os";
import { basename } from "node:path";
import type { Metric, PsiLine } from "./types.js";

/** A >60s native interval is stale/suspend/anomaly territory for ~2s dashboard polling; warm anew.
 * Linux intervals retain their existing semantics and are not subject to this Darwin-only limit.
 */
export const MAX_NATIVE_INTERVAL_MS = 60_000;
/** sysctl vm.swapusage reports binary MiB, including fractional values. */
export const BYTES_PER_MEBIBYTE = 1024 ** 2;
/** Three separately rounded hundredth-MiB fields can disagree; preserve the existing 0.02MiB bound. */
export const SWAP_ROUNDING_TOLERANCE_BYTES = 0.02 * BYTES_PER_MEBIBYTE;
/** Each required vm_stat counter must occur exactly once; duplicates are ambiguous, not additive. */
const VM_COUNTER_OCCURRENCES = 1;

/** Internal raw process counter with a per-read monotonic timestamp. */
export interface ProcessCounter {
	pid: number;
	parentPid: number;
	name: string;
	identity: string;
	rssBytes: number;
	cpuMs: number;
	at: number;
	/** Darwin native start identity and cumulative counters were read successfully. */
	strongIdentity?: true;
	footprintBytes?: number;
}

/**
 * Copy counters immediately. Bun's `os.cpus()` returns lazy placeholders that read native counters on
 * first property access, so a stored but unread array would silently describe a later instant.
 * @param list Runtime CPU records whose lazy properties must be forced now.
 * @returns Detached per-core counter copies.
 */
export function cpuSnapshot(list: readonly CpuInfo[]): CpuInfo[] {
	return list.map(({ model, speed, times }) => ({
		model,
		speed,
		times: { user: times.user, nice: times.nice, sys: times.sys, idle: times.idle, irq: times.irq },
	}));
}

/**
 * Compute an aggregate interval, validating each core and counter before summing.
 * @param previous Previous per-core snapshot, if any.
 * @param current Current per-core snapshot.
 * @returns Host utilization in 0..100, or warming for invalid/nonadvancing counters.
 */
export function hostCpu(previous: CpuInfo[] | undefined, current: CpuInfo[]): Metric<number> {
	if (!previous || previous.length !== current.length || current.length === 0) {
		return { state: "warming", reason: "initial sample or CPU topology changed" };
	}
	let total = 0;
	let idle = 0;
	for (let i = 0; i < current.length; i++) {
		const before = previous[i];
		const after = current[i];
		if (!before || !after || before.model !== after.model) return { state: "warming", reason: "CPU topology changed" };
		for (const key of ["user", "nice", "sys", "idle", "irq"] as const) {
			const delta = after.times[key] - before.times[key];
			if (!Number.isFinite(delta) || before.times[key] < 0 || after.times[key] < 0 || delta < 0)
				return { state: "warming", reason: "CPU counter reset or invalid" };
			total += delta;
			if (key === "idle") idle += delta;
		}
	}
	return total > 0
		? { state: "available", value: ((total - idle) / total) * 100 }
		: { state: "warming", reason: "CPU counters have not advanced" };
}

/**
 * Divide CPU milliseconds by monotonic wall milliseconds, not a lifetime/decaying ps average.
 * @param previous Previous authenticated process observation, if present.
 * @param current Current cumulative CPU/identity observation.
 * @returns Interval percentage (100 per core), or warming for reuse/reset/invalid intervals.
 */
export function processCpu(previous: ProcessCounter | undefined, current: ProcessCounter): Metric<number> {
	if (
		!previous ||
		previous.identity !== current.identity ||
		(current.strongIdentity && (previous.parentPid !== current.parentPid || previous.name !== current.name))
	)
		return { state: "warming", reason: "initial sample or PID reused" };
	const elapsed = current.at - previous.at;
	const cpu = current.cpuMs - previous.cpuMs;
	if (
		!Number.isFinite(elapsed) ||
		elapsed <= 0 ||
		(current.strongIdentity && elapsed > MAX_NATIVE_INTERVAL_MS) ||
		!Number.isFinite(cpu) ||
		previous.cpuMs < 0 ||
		current.cpuMs < 0 ||
		cpu < 0
	) {
		return { state: "warming", reason: "invalid interval or counter reset" };
	}
	return { state: "available", value: (cpu / elapsed) * 100 };
}

/**
 * Bound display names by code point and replace terminal controls; discard directories.
 * @param value Untrusted executable path or basename.
 * @returns At most 128 display-safe basename code points.
 */
export function safeName(value: string): string {
	return Array.from(basename(value).replace(/[\p{C}]/gu, "?"))
		.slice(0, 128)
		.join("");
}

/**
 * Strip the kernel's unlinked-file marker from a Linux executable link.
 * @param target Untrusted /proc/PID/exe link target.
 * @returns Sanitized executable basename without the deleted suffix.
 */
export function executableName(target: string): string {
	return safeName(target.endsWith(" (deleted)") ? target.slice(0, -" (deleted)".length) : target);
}

/**
 * Parse Linux stat, skipping the parenthesized comm safely (embedded spaces and ')' characters). comm is
 * NOT a name source: processes rewrite it (`prctl(PR_SET_NAME)`, `/proc/self/comm`, Node's
 * `process.title`). `name` stays ""; callers derive it from `/proc/PID/exe`.
 * @param text Complete proc stat row.
 * @param hz Host CLK_TCK rate in ticks per second.
 * @param at Monotonic observation milliseconds.
 * @returns Parsed identity/CPU counters with unknown name/RSS, or null for invalid data.
 */
export function linuxStat(text: string, hz: number, at: number): ProcessCounter | null {
	const start = text.indexOf("(");
	const end = text.lastIndexOf(")");
	if (start < 1 || end <= start || !Number.isFinite(hz) || hz <= 0) return null;
	const pid = Number(text.slice(0, start).trim());
	const fields = text
		.slice(end + 1)
		.trim()
		.split(/\s+/);
	const parentPid = Number(fields[1]);
	const user = Number(fields[11]);
	const system = Number(fields[12]);
	const identity = fields[19];
	if (
		!identity ||
		!/^\d+$/.test(identity) ||
		![pid, parentPid, user, system].every((n) => Number.isSafeInteger(n) && n >= 0) ||
		pid === 0
	)
		return null;
	return {
		pid,
		parentPid,
		name: "",
		identity: `${pid}:${identity}`,
		rssBytes: 0,
		cpuMs: ((user + system) / hz) * 1000,
		at,
	};
}

/**
 * Read RSS from status in KiB, avoiding an assumed host page size.
 * @param text Complete proc status text.
 * @returns Resident bytes, or null when absent/invalid.
 */
export function linuxRss(text: string): number | null {
	const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(text);
	if (!match?.[1]) return null;
	const bytes = Number(match[1]) * 1024;
	return Number.isSafeInteger(bytes) ? bytes : null;
}

/**
 * Parse `ps -o pid=,ppid=,lstart=,time=,rss=,ucomm=`. `ucomm` is the kernel's `p_comm`, written only at
 * exec from the executable file name (at most 16 bytes); it is not argv[0] or the process title.
 * Darwin lstart has only one-second identity precision; do not derive interval CPU from it.
 * @param line One fixed-format C-locale ps row.
 * @param at Monotonic observation milliseconds.
 * @returns Metadata/RSS fallback with no native CPU baseline, or null for malformed data.
 */
export function darwinProcess(line: string, at: number): ProcessCounter | null {
	const match =
		/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(\d+)\s+(.*?)\s*$/.exec(line);
	if (!match?.[1] || !match[2] || !match[3] || !match[5] || match[6] === undefined) return null;
	const pid = Number(match[1]);
	const parentPid = Number(match[2]);
	const rssBytes = Number(match[5]) * 1024;
	if (![pid, parentPid, rssBytes].every(Number.isSafeInteger)) return null;
	return { pid, parentPid, rssBytes, identity: `${pid}:${match[3]}`, name: safeName(match[6]), cpuMs: 0, at };
}

/**
 * vm_stat counters are pages, with the page size in the header (16KiB on Apple Silicon).
 * App resident pages = anonymous - purgeable; add wired and physical compressor pages, NOT pages
 * stored in the compressor. Available here means total minus this used estimate, not pressure.
 * @param text C-locale vm_stat output including its page-size header.
 * @param total Host physical RAM in bytes.
 * @returns Validated App+Wired+Compressed usage and its complement, or null on invalid data.
 */
export function darwinMemory(
	text: string,
	total: number,
): {
	usedBytes: number;
	availableBytes: number;
	basis: "app+wired+compressed";
} | null {
	const [, pageSizeText] = /^Mach Virtual Memory Statistics: \(page size of (\d+) bytes\)\r?$/m.exec(text) ?? [];
	const pageSize = Number(pageSizeText);
	if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(pageSize) || pageSize <= 0) return null;
	/**
	 * Read one uniquely present unsigned page count.
	 * @param name Exact vm_stat row label, excluding the colon.
	 * @returns Page count, or null for missing/duplicate/malformed rows.
	 */
	const read = (name: string): number | null => {
		const rows = text.split("\n").filter((line) => line.startsWith(`${name}:`));
		const [row] = rows;
		const [, value] = rows.length === VM_COUNTER_OCCURRENCES ? (/^.*:\s+(\d+)\.\s*$/.exec(row ?? "") ?? []) : [];
		const count = value === undefined ? Number.NaN : Number(value);
		return Number.isSafeInteger(count) && count >= 0 ? count : null;
	};
	const anonymous = read("Anonymous pages");
	const purgeable = read("Pages purgeable");
	const wired = read("Pages wired down");
	const compressed = read("Pages occupied by compressor");
	if (anonymous === null || purgeable === null || wired === null || compressed === null || purgeable > anonymous)
		return null;
	const usedBytes = (anonymous - purgeable + wired + compressed) * pageSize;
	if (!Number.isSafeInteger(usedBytes) || usedBytes < 0 || usedBytes > total) return null;
	return { usedBytes, availableBytes: total - usedBytes, basis: "app+wired+compressed" };
}

/**
 * Parse sysctl's fixed C-locale swapusage format (binary MiB, including fractions).
 * @param text Fixed sysctl vm.swapusage output.
 * @returns Rounded used/allocated bytes, or null for malformed or inconsistent counters.
 */
export function darwinSwap(text: string): { usedBytes: number; totalBytes: number } | null {
	const match =
		/^vm\.swapusage: total = (\d+\.\d+)M\s+used = (\d+\.\d+)M\s+free = (\d+\.\d+)M(?:\s+\(encrypted\))?\s*$/.exec(text);
	if (!match) return null;
	const [, totalMebibytes, usedMebibytes, freeMebibytes] = match;
	const totalBytes = Math.round(Number(totalMebibytes) * BYTES_PER_MEBIBYTE);
	const usedBytes = Math.round(Number(usedMebibytes) * BYTES_PER_MEBIBYTE);
	const freeBytes = Math.round(Number(freeMebibytes) * BYTES_PER_MEBIBYTE);
	if (
		![totalBytes, usedBytes, freeBytes].every(Number.isSafeInteger) ||
		usedBytes > totalBytes ||
		Math.abs(totalBytes - usedBytes - freeBytes) > SWAP_ROUNDING_TOLERANCE_BYTES
	)
		return null;
	return { usedBytes, totalBytes };
}

/**
 * Parse native PSI percentages and cumulative stall microseconds.
 * @param text Linux memory pressure rows.
 * @returns Valid some/optional full counters, or null for malformed data.
 */
export function psi(text: string): { some: PsiLine; full: PsiLine | null } | null {
	const rows = new Map<string, PsiLine>();
	for (const line of text.trim().split("\n")) {
		const match = /^(some|full) avg10=(\d+(?:\.\d+)?) avg60=(\d+(?:\.\d+)?) avg300=(\d+(?:\.\d+)?) total=(\d+)$/.exec(
			line,
		);
		if (!match?.[1]) return null;
		const [avg10, avg60, avg300, total] = match.slice(2).map(Number);
		if (
			avg10 === undefined ||
			avg60 === undefined ||
			avg300 === undefined ||
			total === undefined ||
			![avg10, avg60, avg300].every((n) => Number.isFinite(n) && n >= 0 && n <= 100) ||
			!Number.isSafeInteger(total)
		)
			return null;
		rows.set(match[1], { avg10, avg60, avg300, total });
	}
	const some = rows.get("some");
	return some ? { some, full: rows.get("full") ?? null } : null;
}
