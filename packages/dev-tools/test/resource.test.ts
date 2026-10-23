import { type ChildProcess, execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFileSync, realpathSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	createResourceSampler,
	type ProcessSample,
	type ResourceSampler,
	type ResourceSnapshot,
	type SamplerOptions,
} from "@nredd/pi-resource-sampler";
import { describe, expect, it } from "vitest";
import type { RunOptions, RunResult } from "../src/core/index.ts";
import { type ResourceSnapshotOptions, registerResourceTools, resourceSnapshot } from "../src/resource/index.ts";
import { createMockPi } from "./support.ts";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INTERVAL_MS = 100;
/** What sampler 0.1.1 reports for a child exec'd from `process.execPath`: Darwin `p_comm` holds 16 bytes. */
const EXECUTABLE = basename(realpathSync(process.execPath)).slice(0, process.platform === "darwin" ? 16 : undefined);

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

function proc(pid: number, rssBytes: number, cpu: ProcessSample["cpu"], name = "node"): ProcessSample {
	return { pid, parentPid: 1, name, identity: `${pid}:1`, rssBytes, cpu };
}

const measured = (value: number): ProcessSample["cpu"] => ({ state: "available", value });
const warming: ProcessSample["cpu"] = { state: "warming", reason: "initial sample or PID reused" };
const darwinCpu: ProcessSample["cpu"] = { state: "unavailable", reason: "ps start identity precision is one second" };

function fixture(platform: string, processes: ProcessSample[], overrides: Partial<ResourceSnapshot> = {}) {
	return (monotonicTimeMs: number): ResourceSnapshot => ({
		version: 1,
		platform,
		wallTimeMs: 1_700_000_000_000 + monotonicTimeMs,
		monotonicTimeMs,
		durationMs: 5,
		cpu: monotonicTimeMs === 0 ? { state: "warming", reason: "initial" } : { state: "available", value: 37.5 },
		logicalCpus: 8,
		loadAverage: platform === "win32" ? [] : [1.25, 2.5, 3.75],
		memory: { totalBytes: 16_000, freeBytes: 4_000 },
		processes,
		coverage: {
			complete: true,
			enumerated: processes.length,
			sampled: processes.length,
			skipped: 0,
			bytesRead: 10,
			reasons: [],
		},
		pressure:
			platform === "linux"
				? {
						source: "linux-psi",
						memory: {
							state: "available",
							value: { some: { avg10: 0.42, avg60: 0.1, avg300: 0.01, total: 1 }, full: null },
						},
					}
				: { source: "unsupported", reason: "no comparable native PSI metric on this platform" },
		...overrides,
	});
}

/** Fake sampler recording its options, sample signals and disposal; `disposeFailure` makes disposal reject. */
function fakeSampler(
	make: (monotonicTimeMs: number) => ResourceSnapshot,
	fail?: Error,
	disposeFailure?: Error,
	disposeThrowsSync = false,
) {
	const state = { options: undefined as SamplerOptions | undefined, samples: 0, disposed: 0 };
	const createSampler = (options: SamplerOptions): ResourceSampler => {
		state.options = options;
		return {
			async sample(signal) {
				signal?.throwIfAborted();
				if (fail && state.samples === 1) throw fail;
				return make(state.samples++ * 120);
			},
			dispose() {
				state.disposed++;
				if (disposeFailure && disposeThrowsSync) throw disposeFailure;
				return disposeFailure ? Promise.reject(disposeFailure) : Promise.resolve();
			},
		};
	};
	return { state, createSampler };
}

function options(make: (monotonicTimeMs: number) => ResourceSnapshot, extra: ResourceSnapshotOptions = {}) {
	const fake = fakeSampler(make);
	const calls: RunOptions[] = [];
	const resolved: ResourceSnapshotOptions = {
		createSampler: fake.createSampler,
		readFile: async (path) => {
			if (path === "/proc/meminfo") return "MemAvailable:       9 kB\n";
			throw new Error("unexpected path");
		},
		run: async (runOptions) => {
			calls.push(runOptions);
			return completed("System-wide memory free percentage: 37%\n");
		},
		...extra,
	};
	return { fake, calls, resolved };
}

/** Spy on the real published sampler: its raw samples, and its disposal. */
function realSampler() {
	const state = { disposed: 0, samples: [] as ResourceSnapshot[] };
	const createSampler = (samplerOptions: SamplerOptions): ResourceSampler => {
		const sampler = createResourceSampler(samplerOptions);
		return {
			async sample(signal) {
				const sample = await sampler.sample(signal);
				state.samples.push(sample);
				return sample;
			},
			async dispose() {
				state.disposed++;
				await sampler.dispose();
			},
		};
	};
	return { state, createSampler };
}

/** Wait for this exact child's exit status, never a reusable PID probe, for at most `ms`. */
async function exitedWithin(child: ChildProcess, ms: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return true;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			once(child, "exit").then(() => true),
			new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Reap after the caller's SIGKILL with a deadline, rather than hanging the test worker. */
async function exited(child: ChildProcess): Promise<void> {
	if (child.pid === undefined) return;
	if (!(await exitedWithin(child, 2000))) throw new Error(`child ${child.pid} survived SIGKILL`);
}

/** Resolve a readiness line; reject silent, exited and unspawnable fixtures within `ms`. */
function ready(child: ChildProcess, ms: number): Promise<void> {
	return new Promise((resolve, reject) => {
		let output = "";
		const finish = (error?: Error) => {
			clearTimeout(timer);
			child.stdout?.off("data", data);
			child.off("exit", exit);
			child.off("error", finish);
			if (error) reject(error);
			else resolve();
		};
		const data = (chunk: Buffer) => {
			output += chunk.toString("utf8");
			if (output.includes("ready\n")) finish();
		};
		const exit = () => finish(new Error("child exited before readiness"));
		const timer = setTimeout(() => finish(new Error(`child not ready within ${ms} ms`)), ms);
		child.stdout?.on("data", data);
		child.once("exit", exit);
		child.once("error", finish);
	});
}

/** Own startup and work under the same cleanup boundary; preserve a simultaneous cleanup failure. */
async function supervise(child: ChildProcess, ms: number, body: () => Promise<void>): Promise<void> {
	let failure: { error: unknown } | undefined;
	try {
		await ready(child, ms);
		await body();
	} catch (error) {
		failure = { error };
	}
	try {
		child.kill("SIGKILL");
		await exited(child);
	} catch (cleanup) {
		if (failure) throw new AggregateError([failure.error, cleanup], "fixture and cleanup failed");
		throw cleanup;
	}
	if (failure) throw failure.error;
}

/** Live direct children of this process from an independent `ps`, excluding that `ps` itself. */
function directChildren(): number[] {
	const ps = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", env: { LC_ALL: "C" } });
	if (ps.status !== 0) throw new Error(`ps failed: ${ps.status}`);
	return ps.stdout
		.trim()
		.split("\n")
		.map((line) => line.trim().split(/\s+/).map(Number))
		.filter(([pid, ppid]) => ppid === process.pid && pid !== ps.pid)
		.map(([pid]) => pid as number);
}

describe("resource fixture ownership", () => {
	it.each([
		["silent", "setInterval(() => {}, 1000)"],
		["partial readiness", "process.stdout.write('rea'); setInterval(() => {}, 1000)"],
	])("reaps a real %s child after bounded readiness failure", async (_name, script) => {
		const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
		const started = performance.now();
		await expect(supervise(child, 300, async () => {})).rejects.toThrow("child not ready within 300 ms");
		expect(child.signalCode).toBe("SIGKILL");
		expect(performance.now() - started).toBeLessThan(3000);
	});

	it("handles an actual spawn error without waiting for readiness", async () => {
		const child = spawn(`/nonexistent-resource-fixture-${randomBytes(16).toString("hex")}`, [], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		await expect(supervise(child, 5000, async () => {})).rejects.toThrow("ENOENT");
		expect(child.pid).toBeUndefined();
	});

	it("reaps a real ready child when the body fails", async () => {
		const child = spawn(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		const primary = new Error("injected body failure");
		await expect(
			supervise(child, 5000, async () => {
				throw primary;
			}),
		).rejects.toBe(primary);
		expect(child.signalCode).toBe("SIGKILL");
	});
});

describe("resource_snapshot on the real host through the published sampler", () => {
	it("resolves the exact registry sampler, never the workspace copy", async () => {
		const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf8"));
		expect(manifest.dependencies).toEqual({ "@nredd/pi-resource-sampler": "0.1.1" });
		const { stdout } = await execFileAsync(
			process.execPath,
			["--input-type=module", "-e", "console.log(import.meta.resolve('@nredd/pi-resource-sampler'))"],
			{ cwd: PACKAGE_ROOT },
		);
		const resolved = fileURLToPath(stdout.trim());
		const installed = join(PACKAGE_ROOT, "node_modules", "@nredd", "pi-resource-sampler");
		expect(resolved).toBe(join(installed, "dist", "index.js"));
		expect((await lstat(installed)).isSymbolicLink()).toBe(false);
		expect(JSON.parse(await readFile(join(installed, "package.json"), "utf8")).version).toBe("0.1.1");
	});

	it("smokes the real host through tool execution and output schema validation", async () => {
		const mock = createMockPi();
		registerResourceTools(mock.pi);
		const result = await mock.call("resource_snapshot", { process_limit: 50, interval_ms: INTERVAL_MS }, "/tmp");
		const snapshot = result.structuredContent as Awaited<ReturnType<typeof resourceSnapshot>>;
		expect(snapshot.cpu.logicalCpus).toBeGreaterThan(0);
		expect(snapshot.memory.totalBytes).toBeGreaterThan(0);
		expect(snapshot.interval.requestedMs).toBe(INTERVAL_MS);
		expect(snapshot.interval.measuredMs).toBeGreaterThanOrEqual(INTERVAL_MS - 1);
		expect(snapshot.cpu.utilization.state).toBe("available");
		if (process.platform !== "darwin" && process.platform !== "linux") return;
		if (snapshot.processes.status !== "available") throw new Error("missing process metadata");
		expect(snapshot.processes.entries.length).toBeGreaterThan(0);
		expect(snapshot.processes.entries.length).toBeLessThanOrEqual(50);
		expect(snapshot.processes.ranking).toBe(process.platform === "linux" ? "interval-cpu" : "rss");
		for (const entry of snapshot.processes.entries) {
			expect(Object.keys(entry).sort()).toEqual(["cpu", "executable", "parentPid", "pid", "rssBytes"]);
			expect(entry.executable).not.toContain("/");
			if (process.platform === "darwin") expect(entry.cpu.state).toBe("unavailable");
			if (entry.cpu.state === "available") expect(entry.cpu.value).toBeGreaterThanOrEqual(0);
		}
	});

	it.runIf(process.platform === "darwin" || process.platform === "linux")(
		"discovers a real child under its real parent in the full sample, matching an independent ps read",
		async () => {
			// Idle and small: inclusion is asserted against the sampler's full unranked scan, not a host-dependent top-50
			// rank. The scan need not be complete (a process exiting mid-scan marks it partial); the known child must be
			// in it, and a miss reports the coverage so a truncated scan is never mistaken for a missing child.
			const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
			try {
				const pid = child.pid;
				if (pid === undefined) throw new Error("child did not start");
				await new Promise((resolve) => setTimeout(resolve, 300));
				const real = realSampler();
				const snapshot = await resourceSnapshot(50, { createSampler: real.createSampler }, undefined, 200);
				const raw = real.state.samples.at(-1);
				if (raw === undefined || snapshot.processes.status !== "available") throw new Error("missing process metadata");
				expect(raw.coverage.reasons).not.toContain("process-collection-unavailable");
				const found = raw.processes.find((entry) => entry.pid === pid);
				expect(
					found,
					`child ${pid} absent from ${raw.processes.length} sampled processes, coverage ${JSON.stringify(raw.coverage)}`,
				).toBeDefined();
				expect(found?.parentPid).toBe(process.pid);
				// The kernel's executable basename (`node`), not Linux comm (`node-MainThread`) or a path.
				expect(found?.name).toBe(EXECUTABLE);
				const ps = await execFileAsync("/bin/ps", ["-o", "ppid=", "-p", String(pid)], { env: { LC_ALL: "C" } });
				expect(Number(ps.stdout.trim())).toBe(found?.parentPid);
				// Present in both scans, so Linux measures it; Darwin never can.
				expect(found?.cpu.state).toBe(process.platform === "linux" ? "available" : "unavailable");
				// The bounded tool output is exactly a projection of that same scan.
				const { entries } = snapshot.processes;
				expect(entries).toHaveLength(Math.min(50, raw.processes.length));
				const byPid = new Map(raw.processes.map((entry) => [entry.pid, entry]));
				for (const entry of entries) {
					const source = byPid.get(entry.pid);
					expect(entry).toEqual({
						pid: source?.pid,
						parentPid: source?.parentPid,
						cpu: source?.cpu,
						rssBytes: source?.rssBytes,
						executable: source?.name,
					});
				}
				if (raw.processes.length <= 50) expect(entries.map((entry) => entry.pid)).toContain(pid);
			} finally {
				child.kill("SIGKILL");
				await exited(child);
			}
		},
		20_000,
	);

	it.runIf(process.platform === "darwin" || process.platform === "linux")(
		"never exposes a child's argv[0], title or Linux comm through the installed sampler or the tool",
		async () => {
			// argv[0], process title and Linux comm all hold a random secret. The 0.1.0 name source exposed it.
			const secret = randomBytes(16).toString("hex");
			const child = spawn(
				process.execPath,
				[
					"-e",
					`process.title = process.env.S;
if (process.platform === "linux") require("node:fs").writeFileSync("/proc/self/comm", process.env.S);
console.log("ready"); setInterval(() => {}, 1 << 30);`,
				],
				{ argv0: secret, env: { S: secret }, stdio: ["ignore", "pipe", "ignore"] },
			);
			await supervise(child, 5000, async () => {
				const pid = child.pid;
				if (pid === undefined) throw new Error("child did not start");
				// Negative control: Darwin `ps -c` comm (argv[0]) or Linux comm really carries the secret.
				const legacy =
					process.platform === "linux"
						? readFileSync(`/proc/${pid}/comm`, "utf8").trim() === secret.slice(0, 15)
						: execFileSync("/bin/ps", ["-c", "-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).includes(secret);
				expect(legacy).toBe(true);
				const real = realSampler();
				const mock = createMockPi();
				registerResourceTools(mock.pi, { createSampler: real.createSampler });
				const result = await mock.call("resource_snapshot", { process_limit: 50, interval_ms: INTERVAL_MS }, "/tmp");
				expect(result.isError).toBe(false);
				const found = real.state.samples.at(-1)?.processes.find((entry) => entry.pid === pid);
				expect(found?.name).toBe(EXECUTABLE);
				// Every 12-char window: shorter than the Linux comm (15 bytes) and Darwin p_comm (16 bytes) fragments.
				const text = JSON.stringify([real.state.samples, result.structuredContent, mock.text(result)]);
				for (let i = 0; i + 12 <= secret.length; i++) expect(text).not.toContain(secret.slice(i, i + 12));
			});
		},
		20_000,
	);

	it.runIf(process.platform === "darwin" || process.platform === "linux")(
		"cancels the real sampler while its first scan is in flight, then disposes and leaves no helper",
		async () => {
			const controller = new AbortController();
			const reason = new Error("cancelled mid-sample");
			const state = {
				disposed: 0,
				pendingAtAbort: false,
				sampleCalls: 0,
				inner: undefined as { status: "fulfilled" } | { status: "rejected"; reason: unknown } | undefined,
			};
			const createSampler = (samplerOptions: SamplerOptions): ResourceSampler => {
				const sampler = createResourceSampler(samplerOptions);
				return {
					sample(signal) {
						state.sampleCalls++;
						let settled = false;
						const inner = sampler.sample(signal);
						inner.then(
							() => {
								settled = true;
								state.inner = { status: "fulfilled" };
							},
							(error: unknown) => {
								settled = true;
								state.inner = { status: "rejected", reason: error };
							},
						);
						// Let the scan start its helper or reads, then abort while it is still running.
						setImmediate(() => {
							state.pendingAtAbort = !settled;
							controller.abort(reason);
						});
						return inner;
					},
					async dispose() {
						state.disposed++;
						await sampler.dispose();
					},
				};
			};
			const before = new Set(directChildren());
			await expect(resourceSnapshot(1, { createSampler }, controller.signal, INTERVAL_MS)).rejects.toBe(reason);
			expect(state.pendingAtAbort).toBe(true);
			// The sampler's own scan must reject with the reason; a scan that ignored the signal and finished would
			// leave the later interval `delay` to reject with the same reason and hide that.
			expect(state.inner).toEqual({ status: "rejected", reason });
			expect(state.inner?.status === "rejected" && state.inner.reason).toBe(reason);
			expect(state.sampleCalls).toBe(1);
			expect(state.disposed).toBe(1);
			expect(directChildren().filter((pid) => !before.has(pid))).toEqual([]);
		},
	);

	it("rejects a pre-aborted call and disposes the real sampler without optional probes", async () => {
		const real = realSampler();
		const calls: RunOptions[] = [];
		const controller = new AbortController();
		controller.abort(new Error("cancelled by caller"));
		await expect(
			resourceSnapshot(
				1,
				{
					createSampler: real.createSampler,
					run: async (o) => {
						calls.push(o);
						return completed("");
					},
				},
				controller.signal,
			),
		).rejects.toThrow("cancelled by caller");
		expect(real.state.disposed).toBe(1);
		expect(calls).toEqual([]);
	});

	it("cancels during the interval and still disposes the real sampler", async () => {
		const real = realSampler();
		const controller = new AbortController();
		const pending = resourceSnapshot(1, { createSampler: real.createSampler }, controller.signal, 5_000);
		setTimeout(() => controller.abort(), 150);
		const started = performance.now();
		await expect(pending).rejects.toThrow();
		expect(performance.now() - started).toBeLessThan(3_000);
		expect(real.state.disposed).toBe(1);
	});

	it("propagates tool cancellation as an error rather than a partial snapshot", async () => {
		const mock = createMockPi();
		registerResourceTools(mock.pi);
		const controller = new AbortController();
		controller.abort();
		await expect(
			mock.tools.get("resource_snapshot")?.execute("cancelled", {}, controller.signal, undefined, { cwd: "/tmp" }),
		).rejects.toThrow();
	});
});

describe("resource_snapshot mapping", () => {
	it("maps a Linux sample: interval CPU first, warming never ranked as zero, PSI and MemAvailable", async () => {
		const { fake, resolved } = options(
			fixture("linux", [
				proc(7, 100, measured(12.5), "tester"),
				proc(8, 1_000_000, warming),
				proc(9, 200, measured(0)),
				proc(10, 300, measured(0)),
			]),
		);
		const snapshot = await resourceSnapshot(4, resolved, undefined, INTERVAL_MS);
		expect(fake.state.options).toEqual({ maxDurationMs: 1_000 });
		expect(fake.state.disposed).toBe(1);
		expect(snapshot).toMatchObject({
			platform: "linux",
			interval: { requestedMs: INTERVAL_MS, measuredMs: 120 },
			cpu: { logicalCpus: 8, loadAverage: [1.25, 2.5, 3.75], utilization: { state: "available", value: 37.5 } },
			memory: {
				status: "available",
				totalBytes: 16_000,
				freeBytes: 4_000,
				availableBytes: 9 * 1024,
				pressure: { source: "linux-psi", value: 0.42 },
			},
			processes: { status: "available", limit: 4, ranking: "interval-cpu", truncated: false },
		});
		if (snapshot.processes.status !== "available") throw new Error("missing metadata");
		expect(snapshot.processes.entries.map((entry) => entry.pid)).toEqual([7, 10, 9, 8]);
		expect(snapshot.processes.entries[0]).toEqual({
			pid: 7,
			parentPid: 1,
			cpu: { state: "available", value: 12.5 },
			rssBytes: 100,
			executable: "tester",
		});
		expect(snapshot.processes.cpuSemantics).toContain("interval CPU");
	});

	it('keeps an unknown executable as "" and never fills it in', async () => {
		const mock = createMockPi();
		const { resolved } = options(fixture("linux", [proc(7, 200, measured(3), ""), proc(8, 100, measured(1), "bash")]));
		registerResourceTools(mock.pi, resolved);
		const result = await mock.call("resource_snapshot", { process_limit: 2, interval_ms: INTERVAL_MS }, "/tmp");
		expect(result.structuredContent).toMatchObject({
			processes: {
				entries: [
					{ pid: 7, executable: "" },
					{ pid: 8, executable: "bash" },
				],
			},
		});
		expect(mock.text(result)).toContain("\n7 1 3.0% 200 (unknown)\n8 1 1.0% 100 bash");
	});

	it("bounds 60 entries to the limit and reports incomplete coverage as truncated", async () => {
		const processes = Array.from({ length: 60 }, (_, i) => proc(i + 1, 10, measured(i)));
		const coverage = {
			complete: false,
			enumerated: 61,
			sampled: 60,
			skipped: 1,
			bytesRead: 10,
			reasons: ["process-unreadable-or-changed"],
		};
		const { resolved } = options(fixture("linux", processes, { coverage }));
		const snapshot = await resourceSnapshot(50, resolved, undefined, INTERVAL_MS);
		if (snapshot.processes.status !== "available") throw new Error("missing metadata");
		expect(snapshot.processes.entries).toHaveLength(50);
		expect(snapshot.processes.entries[0]?.pid).toBe(60);
		expect(snapshot.processes).toMatchObject({ truncated: true, coverage });
	});

	it("ranks Darwin by RSS and labels unavailable interval CPU without any average", async () => {
		const { calls, resolved } = options(
			fixture("darwin", [proc(5, 50, darwinCpu, "Activity Monitor"), proc(6, 500, darwinCpu)]),
		);
		const controller = new AbortController();
		const snapshot = await resourceSnapshot(2, resolved, controller.signal, INTERVAL_MS);
		expect(snapshot.memory).toMatchObject({ availableBytes: null, pressure: { source: "memory_pressure", value: 37 } });
		expect(calls).toEqual([
			expect.objectContaining({
				cmd: "memory_pressure",
				args: ["-Q"],
				env: { LC_ALL: "C" },
				signal: controller.signal,
			}),
		]);
		expect(snapshot.processes).toMatchObject({
			ranking: "rss",
			entries: [{ pid: 6 }, { pid: 5, executable: "Activity Monitor", cpu: darwinCpu }],
		});
		if (snapshot.processes.status !== "available") throw new Error("missing metadata");
		expect(snapshot.processes.cpuSemantics).toContain("never a ps lifetime or decaying average");
	});

	it.each([{ timedOut: true }, { aborted: true }, { spawnError: "missing" }, { stdoutDropped: 1 }, { exitCode: 1 }])(
		"rejects Darwin pressure from unsuccessful commands: %j",
		async (failure) => {
			const { resolved } = options(fixture("darwin", [proc(5, 50, darwinCpu)]), {
				run: async () => ({ ...completed("System-wide memory free percentage: 37%\n"), ...failure }),
			});
			const snapshot = await resourceSnapshot(1, resolved, undefined, INTERVAL_MS);
			expect(snapshot.memory.pressure).toBeNull();
		},
	);

	it("keeps base memory figures when optional probes throw", async () => {
		const linux = options(fixture("linux", [proc(5, 50, warming)]), {
			readFile: async () => {
				throw new Error("EACCES");
			},
		});
		expect((await resourceSnapshot(1, linux.resolved, undefined, INTERVAL_MS)).memory).toMatchObject({
			totalBytes: 16_000,
			freeBytes: 4_000,
			availableBytes: null,
			pressure: { source: "linux-psi", value: 0.42 },
		});
		const darwin = options(fixture("darwin", [proc(5, 50, darwinCpu)]), {
			run: async () => {
				throw new Error("missing");
			},
		});
		expect((await resourceSnapshot(1, darwin.resolved, undefined, INTERVAL_MS)).memory.pressure).toBeNull();
	});

	it("keeps unavailable PSI absent, not zero", async () => {
		const { resolved } = options(
			fixture("linux", [proc(5, 50, warming)], {
				pressure: { source: "linux-psi", memory: { state: "unavailable", reason: "PSI absent" } },
			}),
		);
		expect((await resourceSnapshot(1, resolved, undefined, INTERVAL_MS)).memory.pressure).toBeNull();
	});

	it("is explicit about unavailable Windows load and process metadata", async () => {
		const coverage = {
			complete: false,
			enumerated: 0,
			sampled: 0,
			skipped: 0,
			bytesRead: 0,
			reasons: ["unsupported-platform"],
		};
		const { resolved } = options(fixture("win32", [], { coverage }));
		const snapshot = await resourceSnapshot(12, resolved, undefined, INTERVAL_MS);
		expect(snapshot.cpu.loadAverage).toBeNull();
		expect(snapshot.processes).toEqual({
			status: "unavailable",
			reason: "bounded process metadata is unsupported on win32",
		});
	});

	it("reports failed process collection as unavailable with its finite reasons", async () => {
		const coverage = {
			complete: false,
			enumerated: 0,
			sampled: 0,
			skipped: 0,
			bytesRead: 0,
			reasons: ["command-failed"],
		};
		const { resolved } = options(fixture("darwin", [], { coverage }));
		expect((await resourceSnapshot(1, resolved, undefined, INTERVAL_MS)).processes).toEqual({
			status: "unavailable",
			reason: "process metadata unavailable (command-failed)",
		});
	});

	it("propagates sampler failures and always disposes", async () => {
		const fake = fakeSampler(fixture("linux", []), new Error("sampler exploded"));
		await expect(resourceSnapshot(1, { createSampler: fake.createSampler }, undefined, INTERVAL_MS)).rejects.toThrow(
			"sampler exploded",
		);
		expect(fake.state.disposed).toBe(1);
	});

	it("rejects a Darwin cancellation that lands during the pressure probe after the second sample", async () => {
		const controller = new AbortController();
		const reason = new Error("cancelled after sampling");
		const { fake, resolved } = options(fixture("darwin", [proc(5, 50, darwinCpu)]), {
			run: async () => {
				controller.abort(reason);
				return { ...completed(""), aborted: true, exitCode: null, termSignal: "SIGTERM" };
			},
		});
		await expect(resourceSnapshot(1, resolved, controller.signal, INTERVAL_MS)).rejects.toBe(reason);
		expect(fake.state.samples).toBe(2);
		expect(fake.state.disposed).toBe(1);
	});

	it("rejects a Linux cancellation that lands during the MemAvailable read after the second sample", async () => {
		const controller = new AbortController();
		const reason = new Error("cancelled after sampling");
		const { fake, resolved } = options(fixture("linux", [proc(5, 50, warming)]), {
			readFile: async () => {
				controller.abort(reason);
				throw new Error("read interrupted");
			},
		});
		await expect(resourceSnapshot(1, resolved, controller.signal, INTERVAL_MS)).rejects.toBe(reason);
		expect(fake.state.samples).toBe(2);
		expect(fake.state.disposed).toBe(1);
	});

	it("keeps the sampler failure, not a later disposal failure", async () => {
		const fake = fakeSampler(fixture("linux", []), new Error("sampler exploded"), new Error("dispose exploded"));
		await expect(resourceSnapshot(1, { createSampler: fake.createSampler }, undefined, INTERVAL_MS)).rejects.toThrow(
			"sampler exploded",
		);
		expect(fake.state.disposed).toBe(1);
	});

	it("keeps the sampler failure when an injected dispose throws synchronously", async () => {
		const fake = fakeSampler(fixture("linux", []), new Error("sampler exploded"), new Error("dispose exploded"), true);
		await expect(resourceSnapshot(1, { createSampler: fake.createSampler }, undefined, INTERVAL_MS)).rejects.toThrow(
			"sampler exploded",
		);
		expect(fake.state.disposed).toBe(1);
	});

	it("keeps the cancellation, not a later disposal failure", async () => {
		const fake = fakeSampler(fixture("linux", []), undefined, new Error("dispose exploded"));
		const controller = new AbortController();
		const reason = new Error("cancelled by caller");
		controller.abort(reason);
		await expect(
			resourceSnapshot(1, { createSampler: fake.createSampler }, controller.signal, INTERVAL_MS),
		).rejects.toBe(reason);
		expect(fake.state.disposed).toBe(1);
	});

	it("rejects with the disposal failure when the snapshot itself succeeded", async () => {
		const fake = fakeSampler(fixture("linux", [proc(5, 50, warming)]), undefined, new Error("dispose exploded"));
		const { resolved } = options(fixture("linux", []), { createSampler: fake.createSampler });
		await expect(resourceSnapshot(1, resolved, undefined, INTERVAL_MS)).rejects.toThrow("dispose exploded");
		expect(fake.state.disposed).toBe(1);
	});

	it.each([
		[0, INTERVAL_MS],
		[-1, INTERVAL_MS],
		[51, INTERVAL_MS],
		[1.5, INTERVAL_MS],
		[Number.NaN, INTERVAL_MS],
		[Number.POSITIVE_INFINITY, INTERVAL_MS],
		[1, 99],
		[1, 5_001],
		[1, 150.5],
	])("rejects invalid direct limit %s or interval %s before sampling", async (limit, interval) => {
		await expect(
			resourceSnapshot(
				limit,
				{
					createSampler: () => {
						throw new Error("must not sample");
					},
				},
				undefined,
				interval,
			),
		).rejects.toThrow(RangeError);
	});

	it("registers a read-only tool with bounded input and privacy guidance", async () => {
		const mock = createMockPi();
		const { resolved } = options(fixture("linux", [proc(7, 102_400, measured(12.5), "tester")]));
		registerResourceTools(mock.pi, resolved);
		const tool = mock.tools.get("resource_snapshot");
		expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
		expect(tool?.description).toContain(
			"never command arguments, process titles, Linux comm or environments. Whoever names the executable file chooses it",
		);
		expect(tool?.description).toContain("cannot attribute OS processes to agents");
		const result = await mock.call("resource_snapshot", { process_limit: 1, interval_ms: INTERVAL_MS }, "/tmp");
		expect(result.isError).toBe(false);
		expect(mock.text(result)).toContain("7 1 12.5% 102400 tester");
		expect(mock.text(result)).toContain("interval utilization 37.5% over 120ms");
		expect(mock.text(result)).toContain(
			"Executables are untrusted kernel-reported basenames ((unknown) when unreadable), never arguments, titles or environments; no process-to-agent attribution",
		);
		for (const params of [{ process_limit: 51 }, { process_limit: 0 }, { interval_ms: 99 }, { interval_ms: 5_001 }]) {
			await expect(mock.call("resource_snapshot", params, "/tmp")).rejects.toThrow("params rejected");
		}
	});

	it("injects awareness guidance without forcing activation", () => {
		const mock = createMockPi();
		registerResourceTools(mock.pi);
		const [hook] = mock.hooks.get("before_agent_start") ?? [];
		const result = hook?.({ systemPrompt: "base" }, {}) as { systemPrompt: string };
		expect(result.systemPrompt).toContain("Before knowingly starting a large test or compile");
		expect(result.systemPrompt).toContain("not a lock, serialization rule, or fixed threshold");
	});
});
