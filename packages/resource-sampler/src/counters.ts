import type { CpuInfo } from "node:os";
import { basename } from "node:path";
import type { Metric, PsiLine } from "./types.js";

/** Internal raw process counter with a per-read monotonic timestamp. */
export interface ProcessCounter {
	pid: number;
	parentPid: number;
	name: string;
	identity: string;
	rssBytes: number;
	cpuMs: number;
	at: number;
}

/**
 * Copy counters immediately. Bun's `os.cpus()` returns lazy placeholders that read native counters on
 * first property access, so a stored but unread array would silently describe a later instant.
 */
export function cpuSnapshot(list: readonly CpuInfo[]): CpuInfo[] {
	return list.map(({ model, speed, times }) => ({
		model,
		speed,
		times: { user: times.user, nice: times.nice, sys: times.sys, idle: times.idle, irq: times.irq },
	}));
}

/** Compute an aggregate interval, validating each core and each counter before summing. */
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

/** CPU milliseconds divided by monotonic wall milliseconds, not a lifetime/decaying ps average. */
export function processCpu(previous: ProcessCounter | undefined, current: ProcessCounter): Metric<number> {
	if (!previous || previous.identity !== current.identity)
		return { state: "warming", reason: "initial sample or PID reused" };
	const elapsed = current.at - previous.at;
	const cpu = current.cpuMs - previous.cpuMs;
	if (
		!Number.isFinite(elapsed) ||
		elapsed <= 0 ||
		!Number.isFinite(cpu) ||
		previous.cpuMs < 0 ||
		current.cpuMs < 0 ||
		cpu < 0
	) {
		return { state: "warming", reason: "invalid interval or counter reset" };
	}
	return { state: "available", value: (cpu / elapsed) * 100 };
}

/** Bound display text by code point and replace terminal controls. */
function safeText(value: string): string {
	return Array.from(value.replace(/[\p{C}]/gu, "?"))
		.slice(0, 128)
		.join("");
}

/** Bounded display basename; directories never leave the parser. */
export function safeName(value: string): string {
	return safeText(basename(value));
}

/** Basename of a Linux `/proc/PID/exe` target, without the kernel's unlinked-file marker. */
export function executableName(target: string): string {
	return safeName(target.endsWith(" (deleted)") ? target.slice(0, -" (deleted)".length) : target);
}

/** Linux `PF_KTHREAD`: userspace cannot rename kernel threads (comm writes need the same thread group). */
const KERNEL_THREAD = 0x00200000;

/** Linux stat fields; `name` is set only for kernel threads because user comm is process-writable. */
export interface LinuxStat extends ProcessCounter {
	kernelThread: boolean;
}

/**
 * Parse Linux stat's parenthesized comm safely, including embedded spaces and ')' characters. A user
 * process can rewrite its own comm (`prctl(PR_SET_NAME)`, `/proc/self/comm`, Node's `process.title`),
 * so comm is only trusted as a kernel thread name. Callers derive user names from the executable.
 */
export function linuxStat(text: string, hz: number, at: number): LinuxStat | null {
	const start = text.indexOf("(");
	const end = text.lastIndexOf(")");
	if (start < 1 || end <= start || !Number.isFinite(hz) || hz <= 0) return null;
	const pid = Number(text.slice(0, start).trim());
	const fields = text
		.slice(end + 1)
		.trim()
		.split(/\s+/);
	const parentPid = Number(fields[1]);
	const flags = Number(fields[6]);
	const user = Number(fields[11]);
	const system = Number(fields[12]);
	const identity = fields[19];
	if (
		!identity ||
		!/^\d+$/.test(identity) ||
		![pid, parentPid, flags, user, system].every((n) => Number.isSafeInteger(n) && n >= 0) ||
		pid === 0
	)
		return null;
	const kernelThread = (flags & KERNEL_THREAD) !== 0;
	return {
		pid,
		parentPid,
		// Kernel thread names such as `kworker/0:1` are not paths.
		name: kernelThread ? safeText(text.slice(start + 1, end)) : "",
		kernelThread,
		identity: `${pid}:${identity}`,
		rssBytes: 0,
		cpuMs: ((user + system) / hz) * 1000,
		at,
	};
}

/** RSS comes from status in KiB, avoiding an assumed host page size. */
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

/** Parse native PSI percentages and cumulative stall microseconds, rejecting malformed values. */
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
