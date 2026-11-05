import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { Budget } from "../src/collect.js";
import {
	BYTES_PER_MEBIBYTE,
	MAX_NATIVE_INTERVAL_MS,
	processCpu,
	SWAP_ROUNDING_TOLERANCE_BYTES,
} from "../src/counters.js";
import {
	DARWIN_ABI,
	DARWIN_NATIVE_READ_BYTES,
	darwinNativeCounter,
	darwinNativeProcesses,
	MICROSECONDS_PER_SECOND,
	NANOSECONDS_PER_MILLISECOND,
	type NativeCalls,
	type NativeHost,
	nativeCalls,
} from "../src/darwin.js";

/** Allowlisted numeric fields and p_comm only, captured from this Mac's native calls (no raw structs). */
const captured = JSON.parse(await readFile(new URL("./fixtures/darwin-native.json", import.meta.url), "utf8"));
/** Monotonic test baseline and one ordinary sampling step, in milliseconds. */
const BASELINE_AT_MS = 1000;
const SAMPLE_STEP_MS = 1000;
const NEXT_AT_MS = BASELINE_AT_MS + SAMPLE_STEP_MS;
/** Independent observation: 62_000 - 1000 baseline = 61_000 ms, above MAX_NATIVE_INTERVAL_MS's
 * documented 60_000 ms strong-identity window. Never derive this oracle from the production limit.
 */
const OVERLONG_AT_MS = 62_000;
/** Signed int32 maximum: an absent Darwin PID for exercising failed native access. */
const ABSENT_PID = 2_147_483_647;
/** Independent Apple Silicon capture: 125 nanoseconds / 3 Mach ticks. */
const CAPTURED_TICKS_TO_NS = 125 / 3;
/** Captured RSS: 944 KiB * 1024 bytes/KiB = 966656 bytes. */
const CAPTURED_RSS_BYTES = 966656;
/** Captured footprint: 1008 KiB * 1024 + 216 residual bytes = 1032408 bytes. */
const CAPTURED_FOOTPRINT_BYTES = 1032408;
/** Reuse advances start by 24 Mach ticks * 125/3 ns/tick = 1000 ns (one microsecond). */
const REUSED_START_TICKS = 24n;
/** Advance CPU by 1000000 Mach ticks * 125/3 ns/tick = 41.6666667 ms. */
const REUSED_CPU_TICKS = 1_000_000n;
/** Nine places allow conversion noise below 0.5 * 10^-9 ms or percentage points. */
const DECIMAL_PRECISION = 9;
/** Ample admitted capture space for isolated native-reader tests, not a production default. */
const TEST_BUDGET_BYTES = 4096;
/** Independent SDK ABI literals for adapter forwarding assertions. */
const PROC_PIDTBSDINFO_FLAVOR = 3;
const RUSAGE_INFO_V0_FLAVOR = 0;
const PROC_PIDINFO_ARGUMENT = 0n;
const PROC_BSDINFO_BYTES = 136;
const RUSAGE_INFO_V0_BYTES = 96;
const MACH_TIMEBASE_BYTES = 8;
/** Independent charges: one 8-byte timebase frame, then 136 + 2 * 96 bytes per admitted PID. */
const TIMEBASE_CHARGE_BYTES = 8;
const PID_CHARGE_BYTES = 328;
/** Fixed system library path from the Darwin SDK, asserted independently of production. */
const LIBPROC_PATH = "/usr/lib/libproc.dylib";
/** Nonzero status a failing proc_pid_rusage or mach_timebase_info returns. */
const NATIVE_FAILURE = -1;
/** One byte below `mach_timebase_info`'s independent eight-byte ABI layout. */
const BELOW_TIMEBASE_BYTES = 7;
/** Native counter regression fixture values, in Mach ticks. */
const ROLLBACK_BEFORE_TICKS = 9n;
const ROLLBACK_AFTER_TICKS = 0n;

/**
 * Reconstruct zero-filled LP64 frames using only the fixture's allowlisted numeric/p_comm fields.
 * No raw kernel struct, pbi_name, argv or environment is retained in the captured fixture.
 * @returns Two rusage_info_v0 buffers bracketing proc_bsdinfo, using independent SDK literal layouts.
 */
function buffers() {
	// SDK byte sizes: rusage_info_v0 = 96, proc_bsdinfo = 136 (independent of production constants).
	const before = Buffer.alloc(96),
		after = Buffer.alloc(96),
		bsd = Buffer.alloc(136);
	// proc_bsdinfo byte offsets: PID 12, PPID 16, p_comm 48, start seconds 120, start usec 128.
	bsd.writeUInt32LE(captured.pid, 12);
	bsd.writeUInt32LE(captured.parentPid, 16);
	Buffer.from(captured.nameHex, "hex").copy(bsd, 48);
	bsd.writeBigUInt64LE(BigInt(captured.seconds), 120);
	bsd.writeBigUInt64LE(BigInt(captured.micros), 128);
	// rusage_info_v0 byte offsets: start ticks 80, resident bytes 64, physical footprint bytes 72.
	for (const buffer of [before, after]) {
		buffer.writeBigUInt64LE(BigInt(captured.start), 80);
		buffer.writeBigUInt64LE(BigInt(captured.rssBytes), 64);
		buffer.writeBigUInt64LE(BigInt(captured.footprintBytes), 72);
	}
	// rusage_info_v0 user CPU Mach ticks occupy the uint64_t at byte offset 16.
	before.writeBigUInt64LE(BigInt(captured.beforeCpuTicks), 16);
	after.writeBigUInt64LE(BigInt(captured.afterCpuTicks), 16);
	return { before, bsd, after };
}
/**
 * Decode the captured frames with their real Mach timebase, failing if the fixture contract drifts.
 * @param at Monotonic observation time in milliseconds, independent of captured wall-clock identity.
 * @returns A validated strong-identity ProcessCounter with captured RSS and physical footprint.
 * @throws If the reconstructed allowlisted fixture is rejected by the native decoder.
 */
function counter(at = BASELINE_AT_MS) {
	const { before, bsd, after } = buffers();
	const result = darwinNativeCounter(captured.pid, before, bsd, after, at, CAPTURED_TICKS_TO_NS);
	if (!result) throw new Error("captured native fixture rejected");
	return result;
}

/**
 * Admit native reads without a wall-clock deadline, so no assertion depends on host load.
 * @param maxBytes Shared byte cap charged by the native reader.
 * @param signal Caller-owned cancellation signal.
 * @returns A Budget whose only limits are bytes and cancellation.
 */
function admitted(maxBytes = TEST_BUDGET_BYTES, signal = new AbortController().signal): Budget {
	return new Budget(Number.POSITIVE_INFINITY, maxBytes, 1, signal);
}
/**
 * Build a fallback ps row without native-only fields, so enrichment is observable.
 * @param pid Process identifier; defaults to the captured fixture PID.
 * @returns A weak-identity row with an absent physical footprint.
 */
function fallbackRow(pid: number = captured.pid) {
	return { ...counter(), pid, strongIdentity: undefined, footprintBytes: undefined };
}

/**
 * Inject fixed native bindings through the production loader seam, without runtime builtin mocks.
 * @param timebase Callback writing mach_timebase_info fields or simulating an initialization failure.
 * @param usage Callback writing one rusage_info_v0 frame or simulating a per-PID failure.
 * @returns Owned binding fake and loader spy, usable even when builtin FFI is unavailable.
 */
function fakeNative(timebase: (buffer: Buffer) => number, usage: (pid: number, buffer: Buffer) => number) {
	const close = vi.fn();
	const calls: NativeCalls = {
		close,
		timebase,
		usage,
		bsd: (pid, buffer) => {
			buffers().bsd.copy(buffer);
			buffer.writeUInt32LE(pid, 12);
			return 136; // Successful proc_pidinfo returns sizeof(proc_bsdinfo), in bytes.
		},
	};
	return { close, load: vi.fn(() => calls) };
}
/** One scripted native answer: a status overrides the call, undefined falls through to the fixture. */
type Script = (pid: number, buffer: Buffer, call: number) => number | undefined;
/**
 * Record every native call in order, answering each from a scripted handler or the captured fixture.
 * @param script Per-call overrides keyed by syscall; `call` counts that syscall per PID from zero.
 * @returns The fake bindings' loader, ordered call log and close spy.
 */
function scriptedNative(script: { usage?: Script; bsd?: Script } = {}) {
	const log: string[] = [];
	const counts = new Map<string, number>();
	const close = vi.fn();
	/** @returns This syscall's zero-based call index for this PID, after logging it. */
	const record = (name: string, pid: number) => {
		const key = `${name}:${pid}`;
		const call = counts.get(key) ?? 0;
		counts.set(key, call + 1);
		log.push(key);
		return call;
	};
	const calls: NativeCalls = {
		close,
		timebase: validTimebase,
		usage: (pid, buffer) => {
			const call = record("usage", pid);
			const status = script.usage?.(pid, buffer, call);
			if (status !== undefined) return status;
			(call === 0 ? buffers().before : buffers().after).copy(buffer);
			return 0;
		},
		bsd: (pid, buffer) => {
			const call = record("bsd", pid);
			const status = script.bsd?.(pid, buffer, call);
			if (status !== undefined) return status;
			buffers().bsd.copy(buffer);
			buffer.writeUInt32LE(pid, 12);
			return PROC_BSDINFO_BYTES;
		},
	};
	return { close, log, load: vi.fn(() => calls) };
}
/**
 * Populate a successful timebase frame with the captured Apple Silicon numerator/denominator.
 * @param buffer An eight-byte timebase buffer supplied by the native reader.
 * @returns The native syscall success status after writing both documented uint32_t fields.
 */
const validTimebase = (buffer: Buffer): number => {
	// Independent mach_timebase_info uint32_t byte offsets: numerator 0, denominator 4.
	buffer.writeUInt32LE(125, 0);
	buffer.writeUInt32LE(3, 4);
	return 0;
};

describe("Darwin native identity and counters", () => {
	it("pins every shared ABI, unit and policy constant to its documented literal", () => {
		expect(DARWIN_ABI).toEqual({
			success: 0,
			unsetTime: 0n,
			nulByte: 0,
			bsd: {
				bytes: 136,
				flavor: 3,
				argument: 0n,
				pid: 12,
				parentPid: 16,
				comm: 48,
				commBytes: 16,
				startSeconds: 120,
				startMicros: 128,
			},
			usage: {
				bytes: 96,
				flavor: 0,
				userTicks: 16,
				systemTicks: 24,
				residentBytes: 64,
				footprintBytes: 72,
				startTicks: 80,
				exitTicks: 88,
			},
			timebase: { bytes: 8, numerator: 0, denominator: 4 },
		});
		expect(DARWIN_NATIVE_READ_BYTES).toBe(328);
		expect(NANOSECONDS_PER_MILLISECOND).toBe(1_000_000);
		expect(MICROSECONDS_PER_SECOND).toBe(1_000_000n);
		expect(MAX_NATIVE_INTERVAL_MS).toBe(60_000);
		expect(BYTES_PER_MEBIBYTE).toBe(1024 ** 2);
		expect(SWAP_ROUNDING_TOLERANCE_BYTES).toBe(0.02 * 1024 ** 2);
	});
	it("also rejects the one-byte-short metadata boundary", () => {
		const b = buffers();
		expect(darwinNativeCounter(captured.pid, b.before, Buffer.alloc(135), b.after, BASELINE_AT_MS, 1)).toBeNull();
	});
	it("rejects a budget just below 8 + 328 bytes without a PID call", () => {
		const usage = vi.fn(() => 0);
		const fake = fakeNative(validTimebase, usage);
		const row = fallbackRow();
		const budget = admitted(335);
		expect(darwinNativeProcesses([row], budget, fake.load)[0]).toBe(row);
		expect(fake.load).toHaveBeenCalledOnce();
		expect(usage).not.toHaveBeenCalled();
		expect(budget.bytesRead).toBeLessThanOrEqual(335);
		expect([...budget.reasons]).toContain("byte-limit");
		expect(fake.close).toHaveBeenCalledOnce();
	});
	it("converts captured Apple Silicon Mach ticks, preserving RSS and physical footprint", () => {
		const row = counter();
		expect(row.name).toBe("yes");
		// Mach ticks * 125/3 ns/tick / 1_000_000 ns/ms, independent of production conversion units.
		expect(row.cpuMs).toBeCloseTo((Number(captured.afterCpuTicks) * (125 / 3)) / 1e6, DECIMAL_PRECISION);
		expect(row.rssBytes).toBe(CAPTURED_RSS_BYTES);
		expect(row.footprintBytes).toBe(CAPTURED_FOOTPRINT_BYTES);
		expect(row.identity).toContain(`native:${captured.start}:${captured.seconds}:${captured.micros}`);
		const cpu = processCpu(row, { ...row, at: NEXT_AT_MS, cpuMs: row.cpuMs + SAMPLE_STEP_MS });
		expect(cpu.state).toBe("available");
		if (cpu.state === "available") expect(cpu.value).toBeCloseTo(100, DECIMAL_PRECISION);
	});
	it("REJECTS PID reuse within the same lstart second even when parent/name and CPU are nondecreasing", () => {
		const previous = counter();
		const { before, bsd, after } = buffers();
		for (const buffer of [before, after]) buffer.writeBigUInt64LE(BigInt(captured.start) + REUSED_START_TICKS, 80);
		// Advance the wall-clock start by one microsecond within the same second (byte offset 128).
		bsd.writeBigUInt64LE(BigInt(captured.micros) + 1n, 128);
		after.writeBigUInt64LE(BigInt(captured.afterCpuTicks) + REUSED_CPU_TICKS, 16);
		const reused = darwinNativeCounter(captured.pid, before, bsd, after, NEXT_AT_MS, CAPTURED_TICKS_TO_NS);
		expect(reused).not.toBeNull();
		expect(reused?.cpuMs).toBeGreaterThan(previous.cpuMs);
		expect(processCpu(previous, reused ?? previous).state).toBe("warming");
	});
	it("rejects identity change between reads, exited tasks, malformed layouts and counters", () => {
		// Independent mutations: changed start ticks, nonzero exit ticks, CPU rollback,
		// invalid one-second microsecond field, and a mismatched zero PID, at SDK byte offsets.
		for (const change of [
			(b: ReturnType<typeof buffers>) => b.after.writeBigUInt64LE(1n, 80),
			(b: ReturnType<typeof buffers>) => b.after.writeBigUInt64LE(1n, 88),
			(b: ReturnType<typeof buffers>) => b.after.writeBigUInt64LE(0n, 16),
			(b: ReturnType<typeof buffers>) => b.bsd.writeBigUInt64LE(1_000_000n, 128),
			(b: ReturnType<typeof buffers>) => b.bsd.writeUInt32LE(0, 12),
		]) {
			const b = buffers();
			change(b);
			expect(
				darwinNativeCounter(captured.pid, b.before, b.bsd, b.after, BASELINE_AT_MS, CAPTURED_TICKS_TO_NS),
			).toBeNull();
		}
		const b = buffers();
		expect(darwinNativeCounter(captured.pid, b.before, b.bsd, b.after, BASELINE_AT_MS, 0)).toBeNull();
		expect(darwinNativeCounter(captured.pid, b.before, Buffer.alloc(1), b.after, BASELINE_AT_MS, 1)).toBeNull();
	});
	it("rejects parent/name changes, negative CPU deltas and nonpositive/nonfinite/overlong native intervals", () => {
		const before = counter();
		for (const change of [
			{ parentPid: 1 },
			{ name: "different" },
			{ cpuMs: 0 },
			{ at: BASELINE_AT_MS },
			{ at: Number.NaN },
			{ at: OVERLONG_AT_MS },
		]) {
			expect(processCpu(before, { ...before, at: NEXT_AT_MS, ...change }).state).toBe("warming");
		}
	});
	it("keeps invalid UTF-8 names display-safe without confusing exact native identity", () => {
		const b = buffers();
		// Clear the 16-byte p_comm span [48, 64), then inject one invalid UTF-8 byte (0xff).
		b.bsd.fill(0, 48, 64);
		b.bsd[48] = 0xff;
		const row = darwinNativeCounter(captured.pid, b.before, b.bsd, b.after, BASELINE_AT_MS, 1);
		expect(row?.name).toBe("�");
		expect(row?.identity).toMatch(/:ff$/);
	});
	it("keeps a full 16-byte p_comm with no NUL terminator, never reading into the adjacent pbi_name", () => {
		const b = buffers();
		// MAXCOMLEN = 16: a maximal p_comm fills [48, 64) with no terminator; pbi_name starts at byte 64.
		const comm = "sixteen-byte-cmd";
		b.bsd.write(comm, 48, "latin1");
		b.bsd.write("adjacent-pbi_name", 64, "latin1");
		const row = darwinNativeCounter(captured.pid, b.before, b.bsd, b.after, BASELINE_AT_MS, 1);
		expect(row?.name).toBe(comm);
		expect(row?.identity).toMatch(new RegExp(`:${Buffer.from(comm).toString("hex")}$`));
	});
	it("does not call FFI beyond the native-read byte budget or deadline", () => {
		const load = vi.fn(() => undefined);
		const budget = new Budget(performance.now() - 1, TEST_BUDGET_BYTES, 1, new AbortController().signal);
		expect(darwinNativeProcesses([counter()], budget, load)).toHaveLength(1);
		expect(load).not.toHaveBeenCalled();
	});
	it.skipIf(
		process.platform !== "darwin" || (!process.versions.bun && Number(process.versions.node.split(".")[0]) < 26),
	)("keeps failed PID metrics absent and accounts fixed native buffers within the shared cap", () => {
		const fallback = fallbackRow(ABSENT_PID);
		expect(darwinNativeProcesses([fallback], admitted())[0]).toEqual(fallback);
		// Retain the original 64-byte cap, far below the independent 8 + 328-byte admission charge.
		const tiny = admitted(64);
		expect(darwinNativeProcesses([fallback], tiny)[0]?.footprintBytes).toBeUndefined();
		expect(tiny.bytesRead).toBeLessThanOrEqual(64);
		expect([...tiny.reasons]).toContain("byte-limit");
	});
	it("closes a loaded library when timebase initialization throws or fails", () => {
		for (const initialize of [
			(_buffer: Buffer): number => {
				throw new Error("timebase runtime failure");
			},
			(_buffer: Buffer): number => NATIVE_FAILURE,
			(_buffer: Buffer): number => 0,
			// Zero denominator only: numerator 125 at byte 0, denominator left 0 at byte 4.
			(buffer: Buffer): number => {
				buffer.writeUInt32LE(125, 0);
				return 0;
			},
		]) {
			const fake = fakeNative(initialize, () => 0);
			const rows = [counter()];
			expect(darwinNativeProcesses(rows, admitted(), fake.load)).toBe(rows);
			expect(fake.load).toHaveBeenCalledOnce();
			expect(fake.close).toHaveBeenCalledOnce();
		}
	});
	it("retains rows without closing anything when opening the library throws", () => {
		const rows = [fallbackRow()];
		const budget = admitted();
		const load = vi.fn((): NativeCalls | undefined => {
			throw new Error("dlopen failed");
		});
		expect(darwinNativeProcesses(rows, budget, load)).toBe(rows);
		expect(rows[0]?.strongIdentity).toBeUndefined();
		expect(budget.bytesRead).toBe(TIMEBASE_CHARGE_BYTES);
	});
	it("retains a PID whose FFI read throws and still samples the next PID", () => {
		const row = fallbackRow();
		const fake = fakeNative(validTimebase, (pid, buffer) => {
			if (pid === row.pid) throw new Error("per-PID native failure");
			buffers().after.copy(buffer);
			return 0;
		});
		const rows = darwinNativeProcesses([row, { ...row, pid: row.pid + 1 }], admitted(), fake.load);
		expect(rows[0]).toBe(row);
		expect(rows[1]?.strongIdentity).toBe(true);
		expect(rows[1]?.footprintBytes).toBe(CAPTURED_FOOTPRINT_BYTES);
		expect(fake.load).toHaveBeenCalledOnce();
		expect(fake.close).toHaveBeenCalledOnce();
	});
	it("propagates a native-read abort and closes the library", () => {
		const controller = new AbortController();
		const fake = fakeNative(validTimebase, () => {
			controller.abort(new Error("native read aborted"));
			return 0;
		});
		expect(() => darwinNativeProcesses([counter()], admitted(TEST_BUDGET_BYTES, controller.signal), fake.load)).toThrow(
			"native read aborted",
		);
		expect(fake.load).toHaveBeenCalledOnce();
		expect(fake.close).toHaveBeenCalledOnce();
	});
	it("keeps ps metadata and unavailable footprint when builtin FFI is absent", () => {
		const load = vi.fn(() => undefined);
		const row = fallbackRow();
		expect(darwinNativeProcesses([row], admitted(), load)[0]).toEqual(row);
		expect(load).toHaveBeenCalledOnce();
	});
	it("does not load FFI when even the fixed timebase frame exceeds the byte cap", () => {
		const load = vi.fn(() => undefined);
		const budget = admitted(BELOW_TIMEBASE_BYTES);
		expect(darwinNativeProcesses([counter()], budget, load)).toHaveLength(1);
		expect(load).not.toHaveBeenCalled();
		expect([...budget.reasons]).toContain("byte-limit");
	});
	it("rejects a native CPU rollback after all identity fields validate", () => {
		const b = buffers();
		b.before.writeBigUInt64LE(ROLLBACK_BEFORE_TICKS, 16);
		b.before.writeBigUInt64LE(ROLLBACK_BEFORE_TICKS, 24);
		b.after.writeBigUInt64LE(ROLLBACK_AFTER_TICKS, 16);
		b.after.writeBigUInt64LE(ROLLBACK_AFTER_TICKS, 24);
		expect(darwinNativeCounter(captured.pid, b.before, b.bsd, b.after, BASELINE_AT_MS, 1)).toBeNull();
	});
});

/**
 * Build a fake `process` for the adapter selector, recording which builtins it hands out.
 * @param builtins Builtin modules by id; a missing id models a runtime without that FFI.
 * @param overrides Platform, architecture or runtime versions replacing a supported Darwin host.
 * @returns The injectable host and its builtin loader spy.
 */
function fakeHost(builtins: Record<string, unknown>, overrides: Partial<NativeHost> = {}) {
	const getBuiltinModule = vi.fn((id: string): unknown => builtins[id]);
	const host: NativeHost = { platform: "darwin", arch: "arm64", versions: {}, getBuiltinModule, ...overrides };
	return { host, getBuiltinModule };
}
/**
 * Model `bun:ffi`: `ptr` hands out opaque numeric pointers, symbols resolve them back to Buffers.
 * @returns The fake module, its symbols, close spy and pointer resolver.
 */
function fakeBunFfi() {
	const pointers = new Map<number, Buffer>();
	/** @returns The Buffer a fake pointer names; throws for a pointer `ptr` never issued. */
	const resolve = (pointer: number): Buffer => {
		const target = pointers.get(pointer);
		if (!target) throw new Error(`unissued pointer ${pointer}`);
		return target;
	};
	let usageCalls = 0;
	const close = vi.fn();
	const symbols = {
		mach_timebase_info: vi.fn((pointer: number) => validTimebase(resolve(pointer))),
		proc_pidinfo: vi.fn((pid: number, _flavor: number, _argument: bigint, pointer: number, _bytes: number) => {
			buffers().bsd.copy(resolve(pointer));
			resolve(pointer).writeUInt32LE(pid, 12);
			return PROC_BSDINFO_BYTES;
		}),
		proc_pid_rusage: vi.fn((_pid: number, _flavor: number, pointer: number) => {
			(usageCalls++ === 0 ? buffers().before : buffers().after).copy(resolve(pointer));
			return 0;
		}),
	};
	const ffi = {
		ptr: vi.fn((target: Buffer) => {
			const pointer = pointers.size + 1;
			pointers.set(pointer, target);
			return pointer;
		}),
		dlopen: vi.fn(() => ({ symbols, close })),
	};
	return { ffi, symbols, close, resolve };
}
/**
 * Model `node:ffi`: `dlopen` returns `{ lib, functions }` and functions take Buffers directly.
 * @returns The fake module, its functions and the owning library's close spy.
 */
function fakeNodeFfi() {
	let usageCalls = 0;
	const close = vi.fn();
	const functions = {
		mach_timebase_info: vi.fn((target: Buffer) => validTimebase(target)),
		proc_pidinfo: vi.fn((pid: number, _flavor: number, _argument: bigint, target: Buffer, _bytes: number) => {
			buffers().bsd.copy(target);
			target.writeUInt32LE(pid, 12);
			return PROC_BSDINFO_BYTES;
		}),
		proc_pid_rusage: vi.fn((_pid: number, _flavor: number, target: Buffer) => {
			(usageCalls++ === 0 ? buffers().before : buffers().after).copy(target);
			return 0;
		}),
	};
	const ffi = { dlopen: vi.fn(() => ({ lib: { close }, functions })) };
	return { ffi, functions, close };
}

describe("Darwin FFI adapter selection on any host", () => {
	it("refuses unsupported platforms and architectures before loading any builtin", () => {
		for (const overrides of [
			{ platform: "linux" },
			{ platform: "win32", arch: "x64" },
			{ arch: "ia32" },
			{ arch: "arm" },
			{ platform: "linux", versions: { bun: "1.4.4" } },
			{ arch: "ia32", versions: { bun: "1.4.4" } },
		]) {
			const { host, getBuiltinModule } = fakeHost(
				{ "bun:ffi": fakeBunFfi().ffi, "node:ffi": fakeNodeFfi().ffi },
				overrides,
			);
			expect(nativeCalls(host)).toBeUndefined();
			expect(getBuiltinModule).not.toHaveBeenCalled();
		}
	});
	it("returns undefined when the selected runtime has no FFI builtin", () => {
		const bun = fakeHost({ "node:ffi": fakeNodeFfi().ffi }, { versions: { bun: "1.4.4" } });
		expect(nativeCalls(bun.host)).toBeUndefined();
		expect(bun.getBuiltinModule).toHaveBeenCalledExactlyOnceWith("bun:ffi");
		const node = fakeHost({ "bun:ffi": fakeBunFfi().ffi });
		expect(nativeCalls(node.host)).toBeUndefined();
		expect(node.getBuiltinModule).toHaveBeenCalledExactlyOnceWith("node:ffi");
	});
	it("binds bun:ffi to libproc's fixed signatures on both architectures and forwards ABI arguments", () => {
		for (const arch of ["arm64", "x64"]) {
			const bun = fakeBunFfi();
			const { host, getBuiltinModule } = fakeHost(
				{ "bun:ffi": bun.ffi, "node:ffi": fakeNodeFfi().ffi },
				{ arch, versions: { bun: "1.4.4" } },
			);
			const calls = nativeCalls(host);
			expect(getBuiltinModule).toHaveBeenCalledExactlyOnceWith("bun:ffi");
			expect(bun.ffi.dlopen).toHaveBeenCalledExactlyOnceWith(LIBPROC_PATH, {
				proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" },
				proc_pid_rusage: { args: ["i32", "i32", "ptr"], returns: "i32" },
				mach_timebase_info: { args: ["ptr"], returns: "i32" },
			});
			const row = fallbackRow();
			const budget = admitted();
			const [result] = darwinNativeProcesses([row], budget, () => calls);
			expect(result).toMatchObject({
				pid: captured.pid,
				strongIdentity: true,
				footprintBytes: CAPTURED_FOOTPRINT_BYTES,
			});
			expect(budget.bytesRead).toBe(TIMEBASE_CHARGE_BYTES + PID_CHARGE_BYTES);
			expect(bun.symbols.mach_timebase_info).toHaveBeenCalledOnce();
			expect(bun.resolve(bun.symbols.mach_timebase_info.mock.calls[0]?.[0] ?? 0)).toHaveLength(MACH_TIMEBASE_BYTES);
			expect(bun.symbols.proc_pidinfo).toHaveBeenCalledExactlyOnceWith(
				captured.pid,
				PROC_PIDTBSDINFO_FLAVOR,
				PROC_PIDINFO_ARGUMENT,
				expect.any(Number),
				PROC_BSDINFO_BYTES,
			);
			expect(bun.resolve(bun.symbols.proc_pidinfo.mock.calls[0]?.[3] ?? 0)).toHaveLength(PROC_BSDINFO_BYTES);
			expect(bun.symbols.proc_pid_rusage).toHaveBeenCalledTimes(2);
			for (const [pid, flavor, pointer] of bun.symbols.proc_pid_rusage.mock.calls) {
				expect([pid, flavor]).toEqual([captured.pid, RUSAGE_INFO_V0_FLAVOR]);
				expect(bun.resolve(pointer)).toHaveLength(RUSAGE_INFO_V0_BYTES);
			}
			// One pointer per native buffer: timebase, rusage, bsdinfo, rusage.
			expect(bun.ffi.ptr).toHaveBeenCalledTimes(4);
			expect(bun.close).toHaveBeenCalledOnce();
		}
	});
	it("binds node:ffi to libproc's fixed signatures and closes the owning library", () => {
		const node = fakeNodeFfi();
		const { host, getBuiltinModule } = fakeHost({ "bun:ffi": fakeBunFfi().ffi, "node:ffi": node.ffi }, { arch: "x64" });
		const calls = nativeCalls(host);
		expect(getBuiltinModule).toHaveBeenCalledExactlyOnceWith("node:ffi");
		expect(node.ffi.dlopen).toHaveBeenCalledExactlyOnceWith(LIBPROC_PATH, {
			proc_pidinfo: { arguments: ["i32", "i32", "u64", "pointer", "i32"], return: "i32" },
			proc_pid_rusage: { arguments: ["i32", "i32", "pointer"], return: "i32" },
			mach_timebase_info: { arguments: ["pointer"], return: "i32" },
		});
		expect(node.close).not.toHaveBeenCalled();
		const budget = admitted();
		const [result] = darwinNativeProcesses([fallbackRow()], budget, () => calls);
		expect(result).toMatchObject({ pid: captured.pid, strongIdentity: true, footprintBytes: CAPTURED_FOOTPRINT_BYTES });
		expect(budget.bytesRead).toBe(TIMEBASE_CHARGE_BYTES + PID_CHARGE_BYTES);
		expect(node.functions.mach_timebase_info).toHaveBeenCalledExactlyOnceWith(expect.any(Buffer));
		expect(node.functions.mach_timebase_info.mock.calls[0]?.[0]).toHaveLength(MACH_TIMEBASE_BYTES);
		expect(node.functions.proc_pidinfo).toHaveBeenCalledExactlyOnceWith(
			captured.pid,
			PROC_PIDTBSDINFO_FLAVOR,
			PROC_PIDINFO_ARGUMENT,
			expect.any(Buffer),
			PROC_BSDINFO_BYTES,
		);
		expect(node.functions.proc_pidinfo.mock.calls[0]?.[3]).toHaveLength(PROC_BSDINFO_BYTES);
		expect(node.functions.proc_pid_rusage).toHaveBeenCalledTimes(2);
		for (const [pid, flavor, target] of node.functions.proc_pid_rusage.mock.calls) {
			expect([pid, flavor]).toEqual([captured.pid, RUSAGE_INFO_V0_FLAVOR]);
			expect(target).toHaveLength(RUSAGE_INFO_V0_BYTES);
		}
		expect(node.close).toHaveBeenCalledOnce();
	});
});

describe("Darwin per-PID native loop on any host", () => {
	it("enriches every admitted row, charging fixed buffers and closing the library once", () => {
		const native = scriptedNative();
		const rows = [fallbackRow(), fallbackRow(captured.pid + 1)];
		const budget = admitted();
		expect(darwinNativeProcesses(rows, budget, native.load)).toBe(rows);
		expect(rows.map((row) => [row.pid, row.strongIdentity, row.footprintBytes])).toEqual([
			[captured.pid, true, CAPTURED_FOOTPRINT_BYTES],
			[captured.pid + 1, true, CAPTURED_FOOTPRINT_BYTES],
		]);
		expect(native.log).toEqual([
			`usage:${captured.pid}`,
			`bsd:${captured.pid}`,
			`usage:${captured.pid}`,
			`usage:${captured.pid + 1}`,
			`bsd:${captured.pid + 1}`,
			`usage:${captured.pid + 1}`,
		]);
		expect(budget.bytesRead).toBe(TIMEBASE_CHARGE_BYTES + 2 * PID_CHARGE_BYTES);
		expect([...budget.reasons]).toEqual([]);
		expect(native.close).toHaveBeenCalledOnce();
	});
	it("retains a row at each failing step of the native read chain and stops at mid-row exhaustion", () => {
		const first = captured.pid;
		const second = captured.pid + 1;
		const full = [`usage:${first}`, `bsd:${first}`, `usage:${first}`];
		/** Each case fails only the first PID; `exhausts` cases must also leave the second PID unread. */
		const cases: {
			name: string;
			script: (budget: Budget) => { usage?: Script; bsd?: Script };
			log: string[];
			exhausts: boolean;
		}[] = [
			{
				name: "first rusage fails",
				script: () => ({ usage: (pid, _buffer, call) => (pid === first && call === 0 ? NATIVE_FAILURE : undefined) }),
				log: [`usage:${first}`],
				exhausts: false,
			},
			{
				name: "budget exhausted after first rusage",
				script: (budget) => ({
					usage: (pid) => {
						if (pid === first) budget.bytesRead = budget.maxBytes;
						return undefined;
					},
				}),
				log: [`usage:${first}`],
				exhausts: true,
			},
			{
				name: "short proc_pidinfo",
				script: () => ({ bsd: (pid) => (pid === first ? PROC_BSDINFO_BYTES - 1 : undefined) }),
				log: [`usage:${first}`, `bsd:${first}`],
				exhausts: false,
			},
			{
				name: "budget exhausted after proc_pidinfo",
				script: (budget) => ({
					bsd: (pid) => {
						if (pid === first) budget.bytesRead = budget.maxBytes;
						return undefined;
					},
				}),
				log: [`usage:${first}`, `bsd:${first}`],
				exhausts: true,
			},
			{
				name: "second rusage fails",
				script: () => ({ usage: (pid, _buffer, call) => (pid === first && call === 1 ? NATIVE_FAILURE : undefined) }),
				log: full,
				exhausts: false,
			},
			{
				name: "start ticks change between rusage reads",
				script: () => ({
					usage: (pid, buffer, call) => {
						if (pid !== first || call !== 1) return undefined;
						buffers().after.copy(buffer);
						// rusage_info_v0 ri_proc_start_abstime at byte offset 80: a reused PID.
						buffer.writeBigUInt64LE(BigInt(captured.start) + REUSED_START_TICKS, 80);
						return 0;
					},
				}),
				log: full,
				exhausts: false,
			},
		];
		for (const { name, script, log, exhausts } of cases) {
			const budget = admitted();
			const native = scriptedNative(script(budget));
			const rows = [fallbackRow(first), fallbackRow(second)];
			const [failed, next] = rows;
			expect(darwinNativeProcesses(rows, budget, native.load), name).toBe(rows);
			expect(rows[0], name).toBe(failed);
			expect(rows[0]?.footprintBytes, name).toBeUndefined();
			if (exhausts) {
				expect(native.log, name).toEqual(log);
				expect(rows[1], name).toBe(next);
				expect([...budget.reasons], name).toEqual(["byte-limit"]);
			} else {
				expect(native.log, name).toEqual([...log, `usage:${second}`, `bsd:${second}`, `usage:${second}`]);
				expect(rows[1]?.strongIdentity, name).toBe(true);
				expect([...budget.reasons], name).toEqual([]);
			}
			expect(native.close, name).toHaveBeenCalledOnce();
		}
	});
	it("stops before a PID whose fixed buffers no longer fit, pinning the budget at its cap", () => {
		const native = scriptedNative();
		const rows = [fallbackRow(), fallbackRow(captured.pid + 1)];
		const [, second] = rows;
		// Room for the timebase and one PID, one byte short of the second PID's fixed buffers.
		const budget = admitted(TIMEBASE_CHARGE_BYTES + 2 * PID_CHARGE_BYTES - 1);
		darwinNativeProcesses(rows, budget, native.load);
		expect(rows[0]?.strongIdentity).toBe(true);
		expect(rows[1]).toBe(second);
		expect(native.log).not.toContain(`usage:${captured.pid + 1}`);
		expect(budget.bytesRead).toBe(budget.maxBytes);
		expect([...budget.reasons]).toEqual(["byte-limit"]);
		expect(native.close).toHaveBeenCalledOnce();
	});
	it("retains a throwing PID, then rethrows only once the shared signal is aborted", () => {
		const controller = new AbortController();
		const native = scriptedNative({
			usage: (pid) => {
				if (pid === captured.pid + 1) controller.abort(new Error("aborted after a per-PID throw"));
				throw new Error("per-PID native failure");
			},
		});
		const rows = [fallbackRow(), fallbackRow(captured.pid + 1), fallbackRow(captured.pid + 2)];
		const [first] = rows;
		expect(() => darwinNativeProcesses(rows, admitted(TEST_BUDGET_BYTES, controller.signal), native.load)).toThrow(
			"aborted after a per-PID throw",
		);
		expect(rows[0]).toBe(first);
		expect(native.log).toEqual([`usage:${captured.pid}`, `usage:${captured.pid + 1}`]);
		expect(native.close).toHaveBeenCalledOnce();
	});
});
