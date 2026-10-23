import { describe, expect, it } from "vitest";
import type { RunOptions, RunResult } from "../src/core/index.ts";
import { type ResourceSnapshotOptions, registerResourceTools, resourceSnapshot } from "../src/resource/index.ts";
import { createMockPi } from "./support.ts";

function completed(stdout: string): RunResult {
	return {
		exitCode: 0,
		termSignal: null,
		stdout,
		stderr: "",
		stdoutDropped: 0,
		stderrDropped: 0,
		timedOut: false,
		aborted: false,
		durationMs: 1,
	};
}

function linuxOptions(calls: RunOptions[]): ResourceSnapshotOptions {
	return {
		platform: () => "linux",
		availableParallelism: () => 8,
		loadavg: () => [1.25, 2.5, 3.75],
		totalmem: () => 16_000,
		freemem: () => 4_000,
		readFile: async (path) => {
			if (path === "/proc/meminfo") return "MemAvailable:       9 kB\n";
			if (path === "/proc/pressure/memory") return "some avg10=0.42 avg60=0.10 avg300=0.01 total=1\n";
			throw new Error("unexpected path");
		},
		run: async (options) => {
			calls.push(options);
			return completed("  7  12.5  100 00:10:00 /usr/local/bin/tester\n  8   1.0  200 00:00:03 node\n");
		},
	};
}

describe("resource_snapshot", () => {
	it("collects bounded Linux metadata without command arguments or environments", async () => {
		const calls: RunOptions[] = [];
		const snapshot = await resourceSnapshot(1, linuxOptions(calls));
		expect(snapshot).toMatchObject({
			platform: "linux",
			cpu: { logicalCpus: 8, loadAverage: [1.25, 2.5, 3.75] },
			memory: {
				status: "available",
				availableBytes: 9 * 1024,
				pressure: { source: "linux-psi", value: 0.42 },
			},
			processes: {
				status: "available",
				limit: 1,
				entries: [{ pid: 7, cpuPercent: 12.5, rssBytes: 100 * 1024, elapsed: "00:10:00", executable: "tester" }],
			},
		});
		expect(calls).toEqual([
			expect.objectContaining({
				cmd: "ps",
				args: ["-A", "--sort=-pcpu", "-o", "pid=,pcpu=,rss=,etime=,comm="],
				timeoutMs: 3_000,
				maxBytes: 128 * 1024,
			}),
		]);
	});

	it("keeps base memory metrics and reports optional probes as absent on failures", async () => {
		const snapshot = await resourceSnapshot(12, {
			platform: () => "darwin",
			availableParallelism: () => 10,
			loadavg: () => [0, 0, 0],
			totalmem: () => 100,
			freemem: () => 25,
			readFile: async () => "",
			run: async (options) => {
				if (options.cmd === "memory_pressure") throw new Error("missing");
				return { ...completed(""), exitCode: 1 };
			},
		});
		expect(snapshot.memory).toMatchObject({ status: "available", totalBytes: 100, freeBytes: 25, pressure: null });
		expect(snapshot.processes).toEqual({ status: "unavailable", reason: "process metadata command unavailable" });
	});

	it("is explicit about unavailable Windows load and process metadata", async () => {
		const snapshot = await resourceSnapshot(12, {
			platform: () => "win32",
			availableParallelism: () => 4,
			loadavg: () => [0, 0, 0],
			totalmem: () => 100,
			freemem: () => 50,
			readFile: async () => "",
			run: async () => completed(""),
		});
		expect(snapshot.cpu).toEqual({ logicalCpus: 4, loadAverage: null });
		expect(snapshot.processes).toEqual({
			status: "unavailable",
			reason: "bounded process metadata is unsupported on win32",
		});
	});

	it("registers a read-only tool with bounded input and privacy guidance", async () => {
		const mock = createMockPi();
		registerResourceTools(mock.pi, linuxOptions([]));
		expect(mock.tools.get("resource_snapshot")?.annotations?.readOnlyHint).toBe(true);
		expect(mock.tools.get("resource_snapshot")?.description).toContain(
			"never returns command arguments or environments",
		);
		const result = await mock.call("resource_snapshot", { process_limit: 1 }, "/tmp");
		expect(result.isError).toBe(false);
		expect(mock.text(result)).toContain("7 12.5 102400 00:10:00 tester");
		expect(mock.text(result)).toContain("No arguments, environments, or process-to-agent attribution");
		await expect(mock.call("resource_snapshot", { process_limit: 51 }, "/tmp")).rejects.toThrow("params rejected");
	});
});
