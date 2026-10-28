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
/** Ample admitted time/capture space for isolated native-reader tests, not production defaults. */
const TEST_BUDGET_MS = 1000;
const TEST_BUDGET_BYTES = 4096;

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
	it.skipIf(process.platform !== "darwin")("rejects a budget just below 8 + 328 bytes without a PID call", () => {
		const usage = vi.fn(() => 0);
		const fake = fakeNative(validTimebase, usage);
		const row = { ...counter(), strongIdentity: undefined, footprintBytes: undefined };
		const budget = new Budget(performance.now() + TEST_BUDGET_MS, 335, 1, new AbortController().signal);
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
	it("does not call FFI beyond the native-read byte budget or deadline", () => {
		const load = vi.fn(() => undefined);
		const budget = new Budget(performance.now() - 1, TEST_BUDGET_BYTES, 1, new AbortController().signal);
		expect(darwinNativeProcesses([counter()], budget, load)).toHaveLength(1);
		expect(load).not.toHaveBeenCalled();
	});
	it.skipIf(
		process.platform !== "darwin" || (!process.versions.bun && Number(process.versions.node.split(".")[0]) < 26),
	)("keeps failed PID metrics absent and accounts fixed native buffers within the shared cap", () => {
		const fallback = { ...counter(), pid: ABSENT_PID, strongIdentity: undefined, footprintBytes: undefined };
		const room = new Budget(performance.now() + TEST_BUDGET_MS, TEST_BUDGET_BYTES, 1, new AbortController().signal);
		expect(darwinNativeProcesses([fallback], room)[0]).toEqual(fallback);
		// Retain the original 64-byte cap, far below the independent 8 + 328-byte admission charge.
		const tiny = new Budget(performance.now() + TEST_BUDGET_MS, 64, 1, new AbortController().signal);
		expect(darwinNativeProcesses([fallback], tiny)[0]?.footprintBytes).toBeUndefined();
		expect(tiny.bytesRead).toBeLessThanOrEqual(64);
		expect([...tiny.reasons]).toContain("byte-limit");
	});
	it.skipIf(process.platform !== "darwin")(
		"closes a loaded library when timebase initialization throws or fails",
		() => {
			for (const initialize of [
				(_buffer: Buffer): number => {
					throw new Error("timebase runtime failure");
				},
				(_buffer: Buffer): number => -1,
				(_buffer: Buffer): number => 0,
			]) {
				const fake = fakeNative(initialize, () => 0);
				const rows = [counter()];
				expect(
					darwinNativeProcesses(
						rows,
						new Budget(performance.now() + TEST_BUDGET_MS, TEST_BUDGET_BYTES, 2, new AbortController().signal),
						fake.load,
					),
				).toBe(rows);
				expect(fake.load).toHaveBeenCalledOnce();
				expect(fake.close).toHaveBeenCalledOnce();
			}
		},
	);
	it.skipIf(process.platform !== "darwin")("retains a PID whose FFI read throws and still samples the next PID", () => {
		const row = { ...counter(), strongIdentity: undefined, footprintBytes: undefined };
		const fake = fakeNative(validTimebase, (pid, buffer) => {
			if (pid === row.pid) throw new Error("per-PID native failure");
			buffers().after.copy(buffer);
			return 0;
		});
		const rows = darwinNativeProcesses(
			[row, { ...row, pid: row.pid + 1 }],
			new Budget(performance.now() + TEST_BUDGET_MS, TEST_BUDGET_BYTES, 2, new AbortController().signal),
			fake.load,
		);
		expect(rows[0]).toBe(row);
		expect(rows[1]?.strongIdentity).toBe(true);
		expect(rows[1]?.footprintBytes).toBe(CAPTURED_FOOTPRINT_BYTES);
		expect(fake.load).toHaveBeenCalledOnce();
		expect(fake.close).toHaveBeenCalledOnce();
	});
	it.skipIf(process.platform !== "darwin")("propagates a native-read abort and closes the library", () => {
		const controller = new AbortController();
		const fake = fakeNative(validTimebase, () => {
			controller.abort(new Error("native read aborted"));
			return 0;
		});
		expect(() =>
			darwinNativeProcesses(
				[counter()],
				new Budget(performance.now() + TEST_BUDGET_MS, TEST_BUDGET_BYTES, 1, controller.signal),
				fake.load,
			),
		).toThrow("native read aborted");
		expect(fake.load).toHaveBeenCalledOnce();
		expect(fake.close).toHaveBeenCalledOnce();
	});
	it("keeps ps metadata and unavailable footprint when builtin FFI is absent", () => {
		const load = vi.fn(() => undefined);
		const row = { ...counter(), strongIdentity: undefined, footprintBytes: undefined };
		const budget = new Budget(performance.now() + TEST_BUDGET_MS, TEST_BUDGET_BYTES, 1, new AbortController().signal);
		expect(darwinNativeProcesses([row], budget, load)[0]).toEqual(row);
		expect(load).toHaveBeenCalledOnce();
	});
});
