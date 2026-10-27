import { performance } from "node:perf_hooks";
import type { Budget } from "./collect.js";
import { type ProcessCounter, safeName } from "./counters.js";

/** Stable LP64 XNU layouts: proc_bsdinfo (136), rusage_info_v0 (96). Never read argv or pbi_name. */
const BSD_BYTES = 136;
const USAGE_BYTES = 96;
const READ_BYTES = BSD_BYTES + 2 * USAGE_BYTES;

interface NativeLibrary {
	bsd(pid: number, buffer: Buffer): number;
	usage(pid: number, buffer: Buffer): number;
	ticksToNs: number;
	close(): void;
}

/** Minimal Bun builtin surface; no dependency on Bun types or an external FFI package. */
interface BunFfi {
	ptr(buffer: Buffer): number;
	dlopen(
		path: string,
		symbols: Record<string, { args: string[]; returns: string }>,
	): {
		symbols: {
			proc_pidinfo(pid: number, flavor: number, arg: bigint, pointer: number, size: number): number;
			proc_pid_rusage(pid: number, flavor: number, pointer: number): number;
			mach_timebase_info(pointer: number): number;
		};
		close(): void;
	};
}

/** Lazy, fixed native symbols only. Unsupported runtimes keep explicit unavailable process metrics. */
function nativeLibrary(): NativeLibrary | undefined {
	if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) return undefined;
	if (process.versions.bun) {
		const ffi = process.getBuiltinModule("bun:ffi") as BunFfi | undefined;
		if (!ffi) return undefined;
		const lib = ffi.dlopen("/usr/lib/libproc.dylib", {
			proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" },
			proc_pid_rusage: { args: ["i32", "i32", "ptr"], returns: "i32" },
			mach_timebase_info: { args: ["ptr"], returns: "i32" },
		});
		const timebase = Buffer.alloc(8);
		if (lib.symbols.mach_timebase_info(ffi.ptr(timebase)) !== 0 || timebase.readUInt32LE(4) === 0) {
			lib.close();
			return undefined;
		}
		return {
			ticksToNs: timebase.readUInt32LE(0) / timebase.readUInt32LE(4),
			bsd: (pid, buffer) => lib.symbols.proc_pidinfo(pid, 3, 0n, ffi.ptr(buffer), BSD_BYTES),
			usage: (pid, buffer) => lib.symbols.proc_pid_rusage(pid, 0, ffi.ptr(buffer)),
			close: () => lib.close(),
		};
	}
	const ffi = process.getBuiltinModule("node:ffi") as typeof import("node:ffi") | undefined;
	if (!ffi) return undefined;
	const lib = ffi.dlopen("/usr/lib/libproc.dylib", {
		proc_pidinfo: { arguments: ["i32", "i32", "u64", "pointer", "i32"], return: "i32" },
		proc_pid_rusage: { arguments: ["i32", "i32", "pointer"], return: "i32" },
		mach_timebase_info: { arguments: ["pointer"], return: "i32" },
	});
	const timebase = Buffer.alloc(8);
	if (lib.functions.mach_timebase_info(timebase) !== 0 || timebase.readUInt32LE(4) === 0) {
		lib.lib.close();
		return undefined;
	}
	return {
		ticksToNs: timebase.readUInt32LE(0) / timebase.readUInt32LE(4),
		bsd: (pid, buffer) => lib.functions.proc_pidinfo(pid, 3, 0n, buffer, BSD_BYTES),
		usage: (pid, buffer) => lib.functions.proc_pid_rusage(pid, 0, buffer),
		close: () => lib.lib.close(),
	};
}

/**
 * Identity-check metadata between two rusage reads. Start absolute ticks distinguish same-second PID
 * reuse; microsecond start, parent and exact p_comm bytes also participate. No sanitized-name collision
 * can authenticate a baseline. Rusage CPU counters are Mach ticks; convert with mach_timebase_info,
 * not an assumed nanosecond tick (Apple Silicon here reports 125/3 nanoseconds per tick).
 */
export function darwinNativeCounter(
	pid: number,
	before: Buffer,
	bsd: Buffer,
	after: Buffer,
	at: number,
	ticksToNs: number,
): ProcessCounter | null {
	if (!Number.isFinite(ticksToNs) || ticksToNs <= 0) return null;
	if (before.length !== USAGE_BYTES || after.length !== USAGE_BYTES || bsd.length !== BSD_BYTES) return null;
	const start = after.readBigUInt64LE(80);
	if (start === 0n || before.readBigUInt64LE(80) !== start || bsd.readUInt32LE(12) !== pid) return null;
	if (before.readBigUInt64LE(88) !== 0n || after.readBigUInt64LE(88) !== 0n) return null;
	const seconds = bsd.readBigUInt64LE(120);
	const micros = bsd.readBigUInt64LE(128);
	if (seconds === 0n || micros >= 1_000_000n) return null;
	const cpu = (buffer: Buffer) => buffer.readBigUInt64LE(16) + buffer.readBigUInt64LE(24);
	if (cpu(after) < cpu(before)) return null;
	const cpuMs = (Number(cpu(after)) * ticksToNs) / 1e6;
	const rssBytes = Number(after.readBigUInt64LE(64));
	const footprintBytes = Number(after.readBigUInt64LE(72));
	if (![rssBytes, footprintBytes].every(Number.isSafeInteger) || !Number.isFinite(cpuMs) || !Number.isFinite(at))
		return null;
	const parentPid = bsd.readUInt32LE(16);
	const rawName = bsd.subarray(48, 64);
	const nul = rawName.indexOf(0);
	const nameBytes = nul < 0 ? rawName : rawName.subarray(0, nul);
	return {
		pid,
		parentPid,
		name: safeName(nameBytes.toString("utf8")),
		identity: `${pid}:native:${start}:${seconds}:${micros}:${parentPid}:${nameBytes.toString("hex")}`,
		rssBytes,
		footprintBytes,
		cpuMs,
		at,
		strongIdentity: true,
	};
}

/**
 * Enrich bounded ps rows with cheap native counters, retaining RSS/name rows when access fails.
 * Charge all admitted fixed syscall buffers to the SAME scan budget, including unsuccessful reads.
 * Synchronous syscalls, like os.cpus(), cannot be preempted; check admission before each PID.
 */
export function darwinNativeProcesses(rows: ProcessCounter[], budget: Budget): ProcessCounter[] {
	if (!budget.ready()) return rows;
	if (budget.maxBytes - budget.bytesRead < 8) {
		budget.bytesRead = budget.maxBytes;
		budget.reasons.add("byte-limit");
		return rows;
	}
	budget.bytesRead += 8;
	let lib: NativeLibrary | undefined;
	try {
		lib = nativeLibrary();
	} catch {
		return rows;
	}
	if (!lib) return rows;
	try {
		for (let i = 0; i < rows.length; i++) {
			if (!budget.ready()) break;
			if (budget.maxBytes - budget.bytesRead < READ_BYTES) {
				budget.bytesRead = budget.maxBytes;
				budget.reasons.add("byte-limit");
				break;
			}
			budget.bytesRead += READ_BYTES;
			const row = rows[i];
			if (!row) continue;
			const before = Buffer.alloc(USAGE_BYTES);
			const bsd = Buffer.alloc(BSD_BYTES);
			const after = Buffer.alloc(USAGE_BYTES);
			if (
				lib.usage(row.pid, before) !== 0 ||
				!budget.ready() ||
				lib.bsd(row.pid, bsd) !== BSD_BYTES ||
				!budget.ready() ||
				lib.usage(row.pid, after) !== 0
			)
				continue;
			const counter = darwinNativeCounter(row.pid, before, bsd, after, performance.now(), lib.ticksToNs);
			if (counter) rows[i] = counter;
		}
		return rows;
	} finally {
		lib.close();
	}
}
