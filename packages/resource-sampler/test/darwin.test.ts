import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { Budget } from "../src/collect.js";
import { MAX_NATIVE_INTERVAL_MS, processCpu } from "../src/counters.js";
import {
	DARWIN_ABI,
	DARWIN_NATIVE_READ_BYTES,
	darwinNativeCounter,
	darwinNativeProcesses,
	MICROSECONDS_PER_SECOND,
	NANOSECONDS_PER_MILLISECOND,
} from "../src/darwin.js";

/** Allowlisted numeric fields and p_comm only, captured from this Mac's native calls (no raw structs). */
const captured = JSON.parse(await readFile(new URL("./fixtures/darwin-native.json", import.meta.url), "utf8"));
/** Monotonic test baseline and one ordinary sampling step, in milliseconds. */
const BASELINE_AT_MS = 1000;
const SAMPLE_STEP_MS = 1000;
const NEXT_AT_MS = BASELINE_AT_MS + SAMPLE_STEP_MS;
/** Use the captured native ratio, never assume that a Mach tick is one nanosecond. */
const CAPTURED_TICKS_TO_NS = captured.timebaseNumerator / captured.timebaseDenominator;
/** Ample admitted time/capture space for isolated native-reader tests, not production defaults. */
const TEST_BUDGET_MS = 1000;
const TEST_BUDGET_BYTES = 4096;

/**
 * Reconstruct zero-filled LP64 frames using only the fixture's allowlisted numeric/p_comm fields.
 * No raw kernel struct, pbi_name, argv or environment is retained in the captured fixture.
 * @returns Two rusage_info_v0 buffers bracketing one proc_bsdinfo buffer, using DARWIN_ABI layouts.
 */
function buffers() {
	const before = Buffer.alloc(DARWIN_ABI.usage.bytes),
		after = Buffer.alloc(DARWIN_ABI.usage.bytes),
		bsd = Buffer.alloc(DARWIN_ABI.bsd.bytes);
	bsd.writeUInt32LE(captured.pid, DARWIN_ABI.bsd.pid);
	bsd.writeUInt32LE(captured.parentPid, DARWIN_ABI.bsd.parentPid);
	Buffer.from(captured.nameHex, "hex").copy(bsd, DARWIN_ABI.bsd.comm);
	bsd.writeBigUInt64LE(BigInt(captured.seconds), DARWIN_ABI.bsd.startSeconds);
	bsd.writeBigUInt64LE(BigInt(captured.micros), DARWIN_ABI.bsd.startMicros);
	for (const buffer of [before, after]) {
		buffer.writeBigUInt64LE(BigInt(captured.start), DARWIN_ABI.usage.startTicks);
		buffer.writeBigUInt64LE(BigInt(captured.rssBytes), DARWIN_ABI.usage.residentBytes);
		buffer.writeBigUInt64LE(BigInt(captured.footprintBytes), DARWIN_ABI.usage.footprintBytes);
	}
	before.writeBigUInt64LE(BigInt(captured.beforeCpuTicks), DARWIN_ABI.usage.userTicks);
	after.writeBigUInt64LE(BigInt(captured.afterCpuTicks), DARWIN_ABI.usage.userTicks);
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
 * Stub fixed Node FFI symbols for failure paths without opening a library or replacing other builtins.
 * @param timebase Callback writing mach_timebase_info fields or simulating an initialization failure.
 * @param usage Callback writing one rusage_info_v0 frame or simulating a per-PID failure.
 * @returns The close spy and builtin spy; callers must restore the latter in finally.
 */
function fakeNative(timebase: (buffer: Buffer) => number, usage: (pid: number, buffer: Buffer) => number) {
	const close = vi.fn();
	const ffi = {
		dlopen: () => ({
			lib: { close },
			functions: {
				mach_timebase_info: timebase,
				proc_pid_rusage: (pid: number, _flavor: number, buffer: Buffer) => usage(pid, buffer),
				proc_pidinfo: (pid: number, _flavor: number, _arg: bigint, buffer: Buffer) => {
					buffers().bsd.copy(buffer);
					buffer.writeUInt32LE(pid, DARWIN_ABI.bsd.pid);
					return DARWIN_ABI.bsd.bytes;
				},
			},
		}),
	};
	const builtin = vi.spyOn(process, "getBuiltinModule").mockReturnValue(ffi);
	return { close, builtin };
}
/**
 * Populate a successful timebase frame with the captured Apple Silicon numerator/denominator.
 * @param buffer A zero-filled DARWIN_ABI.timebase.bytes buffer supplied by the native reader.
 * @returns The native syscall success status after writing both documented uint32_t fields.
 */
const validTimebase = (buffer: Buffer): number => {
	buffer.writeUInt32LE(captured.timebaseNumerator, DARWIN_ABI.timebase.numerator);
	buffer.writeUInt32LE(captured.timebaseDenominator, DARWIN_ABI.timebase.denominator);
	return DARWIN_ABI.success;
};

describe("Darwin native identity and counters", () => {
	it("converts captured Apple Silicon Mach ticks, preserving RSS and physical footprint", () => {
		const row = counter();
		expect(row.name).toBe("yes");
		expect(row.cpuMs).toBeCloseTo(
			(Number(captured.afterCpuTicks) * CAPTURED_TICKS_TO_NS) / NANOSECONDS_PER_MILLISECOND,
			9,
		);
		expect(row.rssBytes).toBe(966656);
		expect(row.footprintBytes).toBe(1032408);
		expect(row.identity).toContain(`native:${captured.start}:${captured.seconds}:${captured.micros}`);
		const cpu = processCpu(row, { ...row, at: NEXT_AT_MS, cpuMs: row.cpuMs + SAMPLE_STEP_MS });
		expect(cpu.state).toBe("available");
		if (cpu.state === "available") expect(cpu.value).toBeCloseTo(100, 9);
	});
	it("REJECTS PID reuse within the same lstart second even when parent/name and CPU are nondecreasing", () => {
		const previous = counter();
		const { before, bsd, after } = buffers();
		for (const buffer of [before, after])
			buffer.writeBigUInt64LE(BigInt(captured.start) + 24n, DARWIN_ABI.usage.startTicks);
		bsd.writeBigUInt64LE(BigInt(captured.micros) + 1n, DARWIN_ABI.bsd.startMicros);
		after.writeBigUInt64LE(BigInt(captured.afterCpuTicks) + 1000000n, DARWIN_ABI.usage.userTicks);
		const reused = darwinNativeCounter(captured.pid, before, bsd, after, NEXT_AT_MS, CAPTURED_TICKS_TO_NS);
		expect(reused).not.toBeNull();
		expect(reused?.cpuMs).toBeGreaterThan(previous.cpuMs);
		expect(processCpu(previous, reused ?? previous).state).toBe("warming");
	});
	it("rejects identity change between reads, exited tasks, malformed layouts and counters", () => {
		for (const change of [
			(b: ReturnType<typeof buffers>) => b.after.writeBigUInt64LE(1n, DARWIN_ABI.usage.startTicks),
			(b: ReturnType<typeof buffers>) => b.after.writeBigUInt64LE(1n, DARWIN_ABI.usage.exitTicks),
			(b: ReturnType<typeof buffers>) => b.after.writeBigUInt64LE(0n, DARWIN_ABI.usage.userTicks),
			(b: ReturnType<typeof buffers>) => b.bsd.writeBigUInt64LE(MICROSECONDS_PER_SECOND, DARWIN_ABI.bsd.startMicros),
			(b: ReturnType<typeof buffers>) => b.bsd.writeUInt32LE(0, DARWIN_ABI.bsd.pid),
		]) {
			const b = buffers();
			change(b);
			expect(
				darwinNativeCounter(captured.pid, b.before, b.bsd, b.after, BASELINE_AT_MS, CAPTURED_TICKS_TO_NS),
			).toBeNull();
		}
		const b = buffers();
		expect(darwinNativeCounter(captured.pid, b.before, b.bsd, b.after, BASELINE_AT_MS, 0)).toBeNull();
		expect(
			darwinNativeCounter(captured.pid, b.before, Buffer.alloc(DARWIN_ABI.bsd.bytes - 1), b.after, BASELINE_AT_MS, 1),
		).toBeNull();
	});
	it("rejects parent/name changes, negative CPU deltas and nonpositive/nonfinite/overlong native intervals", () => {
		const before = counter();
		for (const change of [
			{ parentPid: 1 },
			{ name: "different" },
			{ cpuMs: 0 },
			{ at: BASELINE_AT_MS },
			{ at: Number.NaN },
			{ at: BASELINE_AT_MS + MAX_NATIVE_INTERVAL_MS + SAMPLE_STEP_MS },
		]) {
			expect(processCpu(before, { ...before, at: NEXT_AT_MS, ...change }).state).toBe("warming");
		}
	});
	it("keeps invalid UTF-8 names display-safe without confusing exact native identity", () => {
		const b = buffers();
		b.bsd.fill(DARWIN_ABI.nulByte, DARWIN_ABI.bsd.comm, DARWIN_ABI.bsd.comm + DARWIN_ABI.bsd.commBytes);
		b.bsd[DARWIN_ABI.bsd.comm] = 0xff;
		const row = darwinNativeCounter(captured.pid, b.before, b.bsd, b.after, BASELINE_AT_MS, 1);
		expect(row?.name).toBe("�");
		expect(row?.identity).toMatch(/:ff$/);
	});
	it("does not call FFI beyond the native-read byte budget or deadline", () => {
		const builtin = vi.spyOn(process, "getBuiltinModule");
		try {
			const budget = new Budget(performance.now() - 1, TEST_BUDGET_BYTES, 1, new AbortController().signal);
			expect(darwinNativeProcesses([counter()], budget)).toHaveLength(1);
			expect(builtin).not.toHaveBeenCalled();
		} finally {
			builtin.mockRestore();
		}
	});
	it.skipIf(
		process.platform !== "darwin" || (!process.versions.bun && Number(process.versions.node.split(".")[0]) < 26),
	)("keeps failed PID metrics absent and accounts fixed native buffers within the shared cap", () => {
		const fallback = { ...counter(), pid: 2147483647, strongIdentity: undefined, footprintBytes: undefined };
		const room = new Budget(performance.now() + TEST_BUDGET_MS, TEST_BUDGET_BYTES, 1, new AbortController().signal);
		expect(darwinNativeProcesses([fallback], room)[0]).toEqual(fallback);
		const tinyBytes = DARWIN_ABI.timebase.bytes + DARWIN_NATIVE_READ_BYTES - 1;
		const tiny = new Budget(performance.now() + TEST_BUDGET_MS, tinyBytes, 1, new AbortController().signal);
		expect(darwinNativeProcesses([fallback], tiny)[0]?.footprintBytes).toBeUndefined();
		expect(tiny.bytesRead).toBeLessThanOrEqual(tinyBytes);
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
				try {
					const rows = [counter()];
					expect(
						darwinNativeProcesses(
							rows,
							new Budget(performance.now() + TEST_BUDGET_MS, TEST_BUDGET_BYTES, 2, new AbortController().signal),
						),
					).toBe(rows);
					expect(fake.close).toHaveBeenCalledOnce();
				} finally {
					fake.builtin.mockRestore();
				}
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
		try {
			const rows = darwinNativeProcesses(
				[row, { ...row, pid: row.pid + 1 }],
				new Budget(performance.now() + TEST_BUDGET_MS, TEST_BUDGET_BYTES, 2, new AbortController().signal),
			);
			expect(rows[0]).toBe(row);
			expect(rows[1]?.strongIdentity).toBe(true);
			expect(rows[1]?.footprintBytes).toBe(1032408);
			expect(fake.close).toHaveBeenCalledOnce();
		} finally {
			fake.builtin.mockRestore();
		}
	});
	it.skipIf(process.platform !== "darwin")("propagates a native-read abort and closes the library", () => {
		const controller = new AbortController();
		const fake = fakeNative(validTimebase, () => {
			controller.abort(new Error("native read aborted"));
			return 0;
		});
		try {
			expect(() =>
				darwinNativeProcesses(
					[counter()],
					new Budget(performance.now() + TEST_BUDGET_MS, TEST_BUDGET_BYTES, 1, controller.signal),
				),
			).toThrow("native read aborted");
			expect(fake.close).toHaveBeenCalledOnce();
		} finally {
			fake.builtin.mockRestore();
		}
	});
	it("keeps ps metadata and unavailable footprint when builtin FFI is absent", () => {
		const builtin = vi.spyOn(process, "getBuiltinModule").mockReturnValue(undefined);
		try {
			const row = { ...counter(), strongIdentity: undefined, footprintBytes: undefined };
			const budget = new Budget(performance.now() + TEST_BUDGET_MS, TEST_BUDGET_BYTES, 1, new AbortController().signal);
			expect(darwinNativeProcesses([row], budget)[0]).toEqual(row);
		} finally {
			builtin.mockRestore();
		}
	});
});
