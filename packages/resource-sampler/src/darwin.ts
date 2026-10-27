import { performance } from "node:perf_hooks";
import type { Budget } from "./collect.js";
import { type ProcessCounter, safeName } from "./counters.js";

/** Fixed Darwin LP64 ABI from sys/proc_info.h, sys/resource.h and mach/mach_time.h. */
export const DARWIN_ABI = {
	/** proc_pid_rusage and mach_timebase_info return zero on success. */
	success: 0,
	/** Kernel start/exit time zero means unset; a live process must have a nonzero start. */
	unsetTime: 0n,
	/** C p_comm terminates at the first NUL byte, not the end of its fixed buffer. */
	nulByte: 0,
	bsd: {
		/** sizeof(struct proc_bsdinfo), including fields we deliberately never decode. */
		bytes: 136,
		/** PROC_PIDTBSDINFO flavor for proc_pidinfo. */
		flavor: 3,
		/** This flavor has no auxiliary argument. */
		argument: 0n,
		/** uint32_t pbi_pid byte offset. */
		pid: 12,
		/** uint32_t pbi_ppid byte offset. */
		parentPid: 16,
		/** char pbi_comm[MAXCOMLEN] starts here; pbi_name is NOT a name source. */
		comm: 48,
		/** MAXCOMLEN bytes, excluding any adjacent pbi_name field. */
		commBytes: 16,
		/** uint64_t pbi_start_tvsec byte offset. */
		startSeconds: 120,
		/** uint64_t pbi_start_tvusec byte offset. */
		startMicros: 128,
	},
	usage: {
		/** sizeof(struct rusage_info_v0); later flavors are not requested. */
		bytes: 96,
		/** RUSAGE_INFO_V0 flavor, providing CPU, footprint and start/exit identity. */
		flavor: 0,
		/** uint64_t ri_user_time (Mach ticks) byte offset. */
		userTicks: 16,
		/** uint64_t ri_system_time (Mach ticks) byte offset. */
		systemTicks: 24,
		/** uint64_t ri_resident_size byte offset. */
		residentBytes: 64,
		/** uint64_t ri_phys_footprint byte offset. */
		footprintBytes: 72,
		/** uint64_t ri_proc_start_abstime byte offset. */
		startTicks: 80,
		/** uint64_t ri_proc_exit_abstime byte offset. */
		exitTicks: 88,
	},
	timebase: {
		/** sizeof(mach_timebase_info_data_t), two uint32_t fields. */
		bytes: 8,
		/** uint32_t numer byte offset. */
		numerator: 0,
		/** uint32_t denom byte offset. */
		denominator: 4,
	},
} as const;

/** Rusage reads bracket the single metadata read to reject identity changes during collection. */
const RUSAGE_READS_PER_PID = 2;
/** Charge every admitted fixed buffer, including failed syscalls, against the shared scan budget. */
export const DARWIN_NATIVE_READ_BYTES = DARWIN_ABI.bsd.bytes + RUSAGE_READS_PER_PID * DARWIN_ABI.usage.bytes;
/** Convert native Mach-derived nanoseconds into the sampler's cumulative CPU milliseconds. */
export const NANOSECONDS_PER_MILLISECOND = 1_000_000;
/** The pbi_start_tvusec field must be strictly smaller than one second of microseconds. */
export const MICROSECONDS_PER_SECOND = 1_000_000n;

interface NativeCalls {
	bsd(pid: number, buffer: Buffer): number;
	usage(pid: number, buffer: Buffer): number;
	timebase(buffer: Buffer): number;
	close(): void;
}
interface NativeLibrary extends NativeCalls {
	ticksToNs: number;
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
function nativeCalls(): NativeCalls | undefined {
	if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) return undefined;
	if (process.versions.bun) {
		const ffi = process.getBuiltinModule("bun:ffi") as BunFfi | undefined;
		if (!ffi) return undefined;
		const lib = ffi.dlopen("/usr/lib/libproc.dylib", {
			proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" },
			proc_pid_rusage: { args: ["i32", "i32", "ptr"], returns: "i32" },
			mach_timebase_info: { args: ["ptr"], returns: "i32" },
		});
		return {
			timebase: (buffer) => lib.symbols.mach_timebase_info(ffi.ptr(buffer)),
			bsd: (pid, buffer) =>
				lib.symbols.proc_pidinfo(
					pid,
					DARWIN_ABI.bsd.flavor,
					DARWIN_ABI.bsd.argument,
					ffi.ptr(buffer),
					DARWIN_ABI.bsd.bytes,
				),
			usage: (pid, buffer) => lib.symbols.proc_pid_rusage(pid, DARWIN_ABI.usage.flavor, ffi.ptr(buffer)),
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
	return {
		timebase: (buffer) => lib.functions.mach_timebase_info(buffer),
		bsd: (pid, buffer) =>
			lib.functions.proc_pidinfo(pid, DARWIN_ABI.bsd.flavor, DARWIN_ABI.bsd.argument, buffer, DARWIN_ABI.bsd.bytes),
		usage: (pid, buffer) => lib.functions.proc_pid_rusage(pid, DARWIN_ABI.usage.flavor, buffer),
		close: () => lib.lib.close(),
	};
}

/** Close a successfully opened library on every failed initialization, including runtime throws. */
function nativeLibrary(): NativeLibrary | undefined {
	const lib = nativeCalls();
	if (!lib) return undefined;
	let initialized = false;
	try {
		const timebase = Buffer.alloc(DARWIN_ABI.timebase.bytes);
		if (
			lib.timebase(timebase) !== DARWIN_ABI.success ||
			timebase.readUInt32LE(DARWIN_ABI.timebase.numerator) === 0 ||
			timebase.readUInt32LE(DARWIN_ABI.timebase.denominator) === 0
		)
			return undefined;
		initialized = true;
		return {
			...lib,
			ticksToNs:
				timebase.readUInt32LE(DARWIN_ABI.timebase.numerator) / timebase.readUInt32LE(DARWIN_ABI.timebase.denominator),
		};
	} finally {
		if (!initialized) lib.close();
	}
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
	if (
		before.length !== DARWIN_ABI.usage.bytes ||
		after.length !== DARWIN_ABI.usage.bytes ||
		bsd.length !== DARWIN_ABI.bsd.bytes
	)
		return null;
	const start = after.readBigUInt64LE(DARWIN_ABI.usage.startTicks);
	if (
		start === DARWIN_ABI.unsetTime ||
		before.readBigUInt64LE(DARWIN_ABI.usage.startTicks) !== start ||
		bsd.readUInt32LE(DARWIN_ABI.bsd.pid) !== pid
	)
		return null;
	if (
		before.readBigUInt64LE(DARWIN_ABI.usage.exitTicks) !== DARWIN_ABI.unsetTime ||
		after.readBigUInt64LE(DARWIN_ABI.usage.exitTicks) !== DARWIN_ABI.unsetTime
	)
		return null;
	const seconds = bsd.readBigUInt64LE(DARWIN_ABI.bsd.startSeconds);
	const micros = bsd.readBigUInt64LE(DARWIN_ABI.bsd.startMicros);
	if (seconds === DARWIN_ABI.unsetTime || micros >= MICROSECONDS_PER_SECOND) return null;
	/** Sum cumulative user/system Mach ticks from one fixed rusage layout. */
	const cpu = (buffer: Buffer) =>
		buffer.readBigUInt64LE(DARWIN_ABI.usage.userTicks) + buffer.readBigUInt64LE(DARWIN_ABI.usage.systemTicks);
	if (cpu(after) < cpu(before)) return null;
	const cpuMs = (Number(cpu(after)) * ticksToNs) / NANOSECONDS_PER_MILLISECOND;
	const rssBytes = Number(after.readBigUInt64LE(DARWIN_ABI.usage.residentBytes));
	const footprintBytes = Number(after.readBigUInt64LE(DARWIN_ABI.usage.footprintBytes));
	if (![rssBytes, footprintBytes].every(Number.isSafeInteger) || !Number.isFinite(cpuMs) || !Number.isFinite(at))
		return null;
	const parentPid = bsd.readUInt32LE(DARWIN_ABI.bsd.parentPid);
	const rawName = bsd.subarray(DARWIN_ABI.bsd.comm, DARWIN_ABI.bsd.comm + DARWIN_ABI.bsd.commBytes);
	const nul = rawName.indexOf(DARWIN_ABI.nulByte);
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
	if (budget.maxBytes - budget.bytesRead < DARWIN_ABI.timebase.bytes) {
		budget.bytesRead = budget.maxBytes;
		budget.reasons.add("byte-limit");
		return rows;
	}
	budget.bytesRead += DARWIN_ABI.timebase.bytes;
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
			if (budget.maxBytes - budget.bytesRead < DARWIN_NATIVE_READ_BYTES) {
				budget.bytesRead = budget.maxBytes;
				budget.reasons.add("byte-limit");
				break;
			}
			budget.bytesRead += DARWIN_NATIVE_READ_BYTES;
			const row = rows[i];
			if (!row) continue;
			const before = Buffer.alloc(DARWIN_ABI.usage.bytes);
			const bsd = Buffer.alloc(DARWIN_ABI.bsd.bytes);
			const after = Buffer.alloc(DARWIN_ABI.usage.bytes);
			try {
				if (
					lib.usage(row.pid, before) !== DARWIN_ABI.success ||
					!budget.ready() ||
					lib.bsd(row.pid, bsd) !== DARWIN_ABI.bsd.bytes ||
					!budget.ready() ||
					lib.usage(row.pid, after) !== DARWIN_ABI.success
				)
					continue;
				const counter = darwinNativeCounter(row.pid, before, bsd, after, performance.now(), lib.ticksToNs);
				if (counter) rows[i] = counter;
			} catch {
				// Runtime FFI failures belong to this PID, not the entire already-collected ps list.
				budget.signal.throwIfAborted();
			}
		}
		return rows;
	} finally {
		lib.close();
	}
}
