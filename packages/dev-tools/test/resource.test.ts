import { describe, expect, it } from "vitest";
import { type RunOptions, type RunResult, run } from "../src/core/index.ts";
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
	it("smokes the real host through tool execution and output schema validation", async () => {
		const mock = createMockPi();
		registerResourceTools(mock.pi);
		const result = await mock.call("resource_snapshot", { process_limit: 50 }, process.cwd());
		const snapshot = result.structuredContent as Awaited<ReturnType<typeof resourceSnapshot>>;
		expect(snapshot.cpu.logicalCpus).toBeGreaterThan(0);
		expect(snapshot.memory.totalBytes).toBeGreaterThan(0);
		if (process.platform === "darwin" || process.platform === "linux") {
			expect(snapshot.processes.status).toBe("available");
			if (snapshot.processes.status !== "available") throw new Error("missing process metadata");
			expect(snapshot.processes.entries.length).toBeGreaterThan(0);
			expect(snapshot.processes.entries.length).toBeLessThanOrEqual(50);
			expect(snapshot.processes.cpuSemantics).toContain("average");
			for (const entry of snapshot.processes.entries) {
				expect(Object.keys(entry).sort()).toEqual(["cpuPercent", "elapsed", "executable", "pid", "rssBytes"]);
				expect(entry.executable).not.toContain("/");
			}
		}
	});

	it.each(["missing", "nonzero", "timeout", "aborted"])("handles real subprocess %s failures", async (failure) => {
		const controller = new AbortController();
		if (failure === "aborted") controller.abort();
		const snapshot = await resourceSnapshot(
			1,
			{
				...linuxOptions([]),
				run: (options) =>
					run({
						...options,
						cmd: failure === "missing" ? "/nonexistent/resource-observer-test" : process.execPath,
						args: ["-e", failure === "nonzero" ? "process.exit(7)" : "setInterval(() => {}, 1000)"],
						timeoutMs: 100,
					}),
			},
			controller.signal,
		);
		expect(snapshot.processes.status).toBe("unavailable");
	});

	it.each([{ timedOut: true }, { aborted: true }, { spawnError: "missing" }, { stdoutDropped: 1 }, { exitCode: 1 }])(
		"rejects Darwin pressure from unsuccessful commands: %j",
		async (failure) => {
			const snapshot = await resourceSnapshot(1, {
				...linuxOptions([]),
				platform: () => "darwin",
				run: async () => ({ ...completed("System-wide memory free percentage: 37%\n"), ...failure }),
			});
			expect(snapshot.memory.pressure).toBeNull();
		},
	);

	it("parses Darwin pressure and metadata with executable spaces", async () => {
		const snapshot = await resourceSnapshot(1, {
			...linuxOptions([]),
			platform: () => "darwin",
			run: async (options) => {
				expect(options.env).toEqual({ LC_ALL: "C" });
				return completed(
					options.cmd === "memory_pressure"
						? "System-wide memory free percentage: 37%\n"
						: "5 2.0 50 01:00 /Applications/Activity Monitor\n",
				);
			},
		});
		expect(snapshot.memory.pressure).toEqual({ source: "memory_pressure", value: 37 });
		expect(snapshot.processes).toMatchObject({
			cpuSemantics: "ps decaying CPU average, not an interval sample",
			entries: [{ executable: "Activity Monitor" }],
		});
	});

	it.each([0, -1, 51, 1.5, NaN, Infinity])("rejects invalid direct limits %s before probing", async (limit) => {
		await expect(
			resourceSnapshot(limit, {
				platform: () => {
					throw new Error("must not probe");
				},
			}),
		).rejects.toThrow(RangeError);
	});

	it("bounds 60 rows to 50 and labels Linux lifetime averages", async () => {
		const snapshot = await resourceSnapshot(50, {
			...linuxOptions([]),
			run: async () => completed(Array.from({ length: 60 }, (_, i) => `${i + 1} ${i} 10 00:01 node`).join("\n")),
		});
		expect(snapshot.processes).toMatchObject({
			limit: 50,
			cpuSemantics: "ps lifetime CPU average, not current utilization",
			truncated: false,
		});
		if (snapshot.processes.status !== "available") throw new Error("missing metadata");
		expect(snapshot.processes.entries).toHaveLength(50);
		expect(snapshot.processes.entries[0]?.pid).toBe(60);
	});

	it("discards capped partial rows and ignores malformed or exited process rows", async () => {
		const snapshot = await resourceSnapshot(50, {
			...linuxOptions([]),
			run: async () => ({ ...completed("garbage\n4 1.0 20 00:01 node\n5 2.0 10 00:02 partial"), stdoutDropped: 20 }),
		});
		expect(snapshot.processes).toMatchObject({ truncated: true, entries: [{ pid: 4 }] });
		if (snapshot.processes.status !== "available") throw new Error("missing metadata");
		expect(snapshot.processes.entries).toHaveLength(1);
	});

	it("passes tool cancellation to both Darwin commands", async () => {
		const mock = createMockPi();
		const controller = new AbortController();
		controller.abort();
		const calls: RunOptions[] = [];
		registerResourceTools(mock.pi, {
			...linuxOptions([]),
			platform: () => "darwin",
			run: async (options) => {
				calls.push(options);
				return run({ ...options, cmd: process.execPath, args: ["-e", "process.exit(99)"] });
			},
		});
		await mock.tools.get("resource_snapshot")?.execute("cancelled", {}, controller.signal, undefined, { cwd: "/tmp" });
		expect(calls).toHaveLength(2);
		expect(calls.every((call) => call.signal === controller.signal)).toBe(true);
	});

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
