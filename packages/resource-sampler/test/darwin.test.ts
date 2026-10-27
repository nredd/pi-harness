import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { Budget } from "../src/collect.js";
import { processCpu } from "../src/counters.js";
import { darwinNativeCounter, darwinNativeProcesses } from "../src/darwin.js";

/** Allowlisted numeric fields and p_comm only, captured from this Mac's native calls (no raw structs). */
const captured = JSON.parse(await readFile(new URL("./fixtures/darwin-native.json", import.meta.url), "utf8"));
function buffers() {
	const before = Buffer.alloc(96),
		after = Buffer.alloc(96),
		bsd = Buffer.alloc(136);
	bsd.writeUInt32LE(captured.pid, 12);
	bsd.writeUInt32LE(captured.parentPid, 16);
	Buffer.from(captured.nameHex, "hex").copy(bsd, 48);
	bsd.writeBigUInt64LE(BigInt(captured.seconds), 120);
	bsd.writeBigUInt64LE(BigInt(captured.micros), 128);
	for (const buffer of [before, after]) {
		buffer.writeBigUInt64LE(BigInt(captured.start), 80);
		buffer.writeBigUInt64LE(BigInt(captured.rssBytes), 64);
		buffer.writeBigUInt64LE(BigInt(captured.footprintBytes), 72);
	}
	before.writeBigUInt64LE(BigInt(captured.beforeCpuTicks), 16);
	after.writeBigUInt64LE(BigInt(captured.afterCpuTicks), 16);
	return { before, bsd, after };
}
function counter(at = 1000) {
	const { before, bsd, after } = buffers();
	const result = darwinNativeCounter(captured.pid, before, bsd, after, at, 125 / 3);
	if (!result) throw new Error("captured native fixture rejected");
	return result;
}

/** Fixed Node builtin stub for failure paths; no real library or unrelated builtin is replaced. */
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
					buffer.writeUInt32LE(pid, 12);
					return 136;
				},
			},
		}),
	};
	const builtin = vi.spyOn(process, "getBuiltinModule").mockReturnValue(ffi);
	return { close, builtin };
}
const validTimebase = (buffer: Buffer): number => {
	buffer.writeUInt32LE(125, 0);
	buffer.writeUInt32LE(3, 4);
	return 0;
};

describe("Darwin native identity and counters", () => {
	it("converts captured Apple Silicon Mach ticks, preserving RSS and physical footprint", () => {
		const row = counter();
		expect(row.name).toBe("yes");
		expect(row.cpuMs).toBeCloseTo((Number(captured.afterCpuTicks) * (125 / 3)) / 1e6, 9);
		expect(row.rssBytes).toBe(966656);
		expect(row.footprintBytes).toBe(1032408);
		expect(row.identity).toContain(`native:${captured.start}:${captured.seconds}:${captured.micros}`);
		const cpu = processCpu(row, { ...row, at: 2000, cpuMs: row.cpuMs + 1000 });
		expect(cpu.state).toBe("available");
		if (cpu.state === "available") expect(cpu.value).toBeCloseTo(100, 9);
	});
	it("REJECTS PID reuse within the same lstart second even when parent/name and CPU are nondecreasing", () => {
		const previous = counter();
		const { before, bsd, after } = buffers();
		for (const buffer of [before, after]) buffer.writeBigUInt64LE(BigInt(captured.start) + 24n, 80);
		bsd.writeBigUInt64LE(BigInt(captured.micros) + 1n, 128);
		after.writeBigUInt64LE(BigInt(captured.afterCpuTicks) + 1000000n, 16);
		const reused = darwinNativeCounter(captured.pid, before, bsd, after, 2000, 125 / 3);
		expect(reused).not.toBeNull();
		expect(reused?.cpuMs).toBeGreaterThan(previous.cpuMs);
		expect(processCpu(previous, reused ?? previous).state).toBe("warming");
	});
	it("rejects identity change between reads, exited tasks, malformed layouts and counters", () => {
		for (const change of [
			(b: ReturnType<typeof buffers>) => b.after.writeBigUInt64LE(1n, 80),
			(b: ReturnType<typeof buffers>) => b.after.writeBigUInt64LE(1n, 88),
			(b: ReturnType<typeof buffers>) => b.after.writeBigUInt64LE(0n, 16),
			(b: ReturnType<typeof buffers>) => b.bsd.writeBigUInt64LE(1000000n, 128),
			(b: ReturnType<typeof buffers>) => b.bsd.writeUInt32LE(0, 12),
		]) {
			const b = buffers();
			change(b);
			expect(darwinNativeCounter(captured.pid, b.before, b.bsd, b.after, 1000, 125 / 3)).toBeNull();
		}
		const b = buffers();
		expect(darwinNativeCounter(captured.pid, b.before, b.bsd, b.after, 1000, 0)).toBeNull();
		expect(darwinNativeCounter(captured.pid, b.before, Buffer.alloc(1), b.after, 1000, 1)).toBeNull();
	});
	it("rejects parent/name changes, negative CPU deltas and nonpositive/nonfinite/overlong native intervals", () => {
		const before = counter();
		for (const change of [
			{ parentPid: 1 },
			{ name: "different" },
			{ cpuMs: 0 },
			{ at: 1000 },
			{ at: Number.NaN },
			{ at: 62000 },
		]) {
			expect(processCpu(before, { ...before, at: 2000, ...change }).state).toBe("warming");
		}
	});
	it("keeps invalid UTF-8 names display-safe without confusing exact native identity", () => {
		const b = buffers();
		b.bsd.fill(0, 48, 64);
		b.bsd[48] = 0xff;
		const row = darwinNativeCounter(captured.pid, b.before, b.bsd, b.after, 1000, 1);
		expect(row?.name).toBe("�");
		expect(row?.identity).toMatch(/:ff$/);
	});
	it("does not call FFI beyond the native-read byte budget or deadline", () => {
		const builtin = vi.spyOn(process, "getBuiltinModule");
		try {
			const budget = new Budget(performance.now() - 1, 4096, 1, new AbortController().signal);
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
		const room = new Budget(performance.now() + 1000, 4096, 1, new AbortController().signal);
		expect(darwinNativeProcesses([fallback], room)[0]).toEqual(fallback);
		const tiny = new Budget(performance.now() + 1000, 64, 1, new AbortController().signal);
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
				try {
					const rows = [counter()];
					expect(
						darwinNativeProcesses(rows, new Budget(performance.now() + 1000, 4096, 2, new AbortController().signal)),
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
				new Budget(performance.now() + 1000, 4096, 2, new AbortController().signal),
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
				darwinNativeProcesses([counter()], new Budget(performance.now() + 1000, 4096, 1, controller.signal)),
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
			const budget = new Budget(performance.now() + 1000, 4096, 1, new AbortController().signal);
			expect(darwinNativeProcesses([row], budget)[0]).toEqual(row);
		} finally {
			builtin.mockRestore();
		}
	});
});
