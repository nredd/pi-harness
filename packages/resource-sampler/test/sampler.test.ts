import { EventEmitter } from "node:events";
import { mkdtemp, opendir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { type CpuInfo, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Budget, command, darwinHostMemory, linuxProcesses, pressure } from "../src/collect.js";
import {
	cpuSnapshot,
	darwinMemory,
	darwinProcess,
	darwinSwap,
	executableName,
	hostCpu,
	linuxRss,
	linuxStat,
	type ProcessCounter,
	processCpu,
	psi,
	safeName,
} from "../src/counters.js";
import { createResourceSampler } from "../src/index.js";

/**
 * Build one synthetic logical core with all non-user/idle counters zero.
 * @param user Cumulative user CPU milliseconds.
 * @param idle Cumulative idle milliseconds.
 * @returns An independent CpuInfo fixture, not a host reading.
 */
const core = (user: number, idle: number): CpuInfo => ({
	model: "fixture",
	speed: 1000,
	times: { user, idle, sys: 0, nice: 0, irq: 0 },
});
/**
 * Build one stable synthetic process baseline.
 * @param cpuMs Cumulative process CPU milliseconds.
 * @param at Monotonic observation milliseconds.
 * @param identity PID/start identity used to test reuse.
 * @returns A process counter with fixed parent/name/RSS.
 */
const proc = (cpuMs: number, at: number, identity = "12:50"): ProcessCounter => ({
	pid: 12,
	parentPid: 1,
	name: "fixture",
	identity,
	rssBytes: 1024,
	cpuMs,
	at,
});

describe("honest counters", () => {
	it("warms first sample, topology changes, rollback and non-advancing counters", () => {
		expect(hostCpu(undefined, [core(1, 1)]).state).toBe("warming");
		expect(hostCpu([core(1, 1)], [core(2, 2), core(1, 1)]).state).toBe("warming");
		expect(hostCpu([core(2, 2)], [core(1, 10)]).state).toBe("warming");
		expect(hostCpu([core(2, 2)], [core(2, 2)]).state).toBe("warming");
		expect(hostCpu([core(2, 2)], [core(Number.NaN, 2)]).state).toBe("warming");
	});
	it("normalizes aggregate CPU but preserves multi-core process CPU", () => {
		expect(hostCpu([core(0, 0), core(0, 0)], [core(100, 100), core(0, 200)])).toEqual({
			state: "available",
			value: 25,
		});
		expect(processCpu(proc(100, 100), proc(500, 200))).toEqual({ state: "available", value: 400 });
		expect(processCpu(proc(100, 100), proc(100, 200))).toEqual({ state: "available", value: 0 });
	});
	it("snapshots Bun-style lazy os.cpus() placeholders when called, not when first read", () => {
		let now = 0;
		// Mirrors Bun's lazyCpus wrapper: the first property access on any element reads native counters.
		/** @returns Bun-like lazy cores that resolve counters at first property access. */
		const lazy = (): CpuInfo[] => {
			const array: CpuInfo[] = [];
			/** @returns Nothing; replace placeholders with current synthetic counters. */
			const populate = () => {
				for (let i = 0; i < 2; i++) array[i] = core(now, now);
			};
			for (let i = 0; i < 2; i++) {
				/** @returns Current core, forcing population on the first placeholder read. */
				const read = (): CpuInfo => {
					if (array[i] === instance) populate();
					return array[i] as CpuInfo;
				};
				const instance: CpuInfo = {
					get model() {
						return read().model;
					},
					get speed() {
						return read().speed;
					},
					get times() {
						return read().times;
					},
				};
				array[i] = instance;
			}
			return array;
		};
		const stale = lazy();
		const before = cpuSnapshot(lazy());
		now = 100;
		const after = cpuSnapshot(lazy());
		expect(hostCpu(before, after)).toEqual({ state: "available", value: 50 });
		// The 0.1.0 failure: an unread stored array describes the later instant, never the earlier one.
		expect(hostCpu(stale, after)).toEqual({ state: "warming", reason: "CPU counters have not advanced" });
	});
	it("does not fabricate zero for PID reuse, first sample, reset or invalid time", () => {
		for (const before of [undefined, proc(100, 100, "12:49"), proc(101, 50), proc(90, 100), proc(90, Number.NaN)]) {
			expect(processCpu(before, proc(100, 100)).state).toBe("warming");
		}
	});
});

describe("privacy-safe native parsers", () => {
	it("parses Linux parentheses and exact start identity without assuming page size", () => {
		const fields = Array<string>(22).fill("0");
		fields[0] = "S";
		fields[1] = "1";
		fields[11] = "20";
		fields[12] = "30";
		fields[19] = "987654321987654321";
		const parsed = linuxStat(`12 (npm exec secret) ${fields.join(" ")}`, 100, 123);
		// User comm is process-writable (process.title, PR_SET_NAME): never reported as a name.
		expect(parsed).toMatchObject({
			pid: 12,
			parentPid: 1,
			name: "",
			identity: "12:987654321987654321",
			cpuMs: 500,
			at: 123,
		});
		expect(executableName("/usr/lib/node/bin/node (deleted)")).toBe("node");
		expect(executableName("/opt/a b/\u001b[2Jtool")).toBe("?[2Jtool");
		expect(safeName("\u{1F9A9}".repeat(200))).toHaveLength(256);
		expect(linuxRss("VmRSS:\t42 kB\n")).toBe(43008);
		expect(linuxRss("no RSS")).toBeNull();
		expect(linuxStat("12 malformed", 100, 1)).toBeNull();
		expect(linuxStat(`0 (name) ${fields.join(" ")}`, 100, 1)).toBeNull();
		expect(linuxStat(`12 (name) ${fields.join(" ")}`, 0, 1)).toBeNull();
	});
	it("parses measured Darwin ps precision and strips control characters", () => {
		expect(darwinProcess("    1 0 Sat Oct  3 01:49:05 2026 185:32.40 17648 launchd         ", 12)).toMatchObject({
			pid: 1,
			identity: "1:Sat Oct  3 01:49:05 2026",
			rssBytes: 18071552,
			name: "launchd",
		});
		expect(darwinProcess("48488 48487 Thu Oct 22 20:28:58 2026 0:00.41 14384 ", 12)?.name).toBe("");
		expect(darwinProcess("truncated row", 1)).toBeNull();
		expect(safeName("/bin/test\u001b[2J")).toBe("test?[2J");
	});
	it("keeps native PSI semantics and rejects impossible or malformed values", () => {
		expect(
			psi("some avg10=1.25 avg60=0.00 avg300=0.05 total=42\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n")?.some,
		).toEqual({ avg10: 1.25, avg60: 0, avg300: 0.05, total: 42 });
		expect(psi("some avg10=101 avg60=0 avg300=0 total=2")).toBeNull();
		expect(psi("unknown")).toBeNull();
	});
});

describe("Darwin host memory", () => {
	it("parses captured Apple Silicon pages, not free-only RAM or uncompressed page equivalents", async () => {
		const vm = await readFile(new URL("./fixtures/darwin-vm-stat.txt", import.meta.url), "utf8");
		// Captured pages: anonymous 241117 - purgeable 2046 + wired 180763 + compressor 393195.
		// The fixture header independently reports 16384 bytes/page, not a production page-size default.
		const usedBytes = (241117 - 2046 + 180763 + 393195) * 16384;
		expect(darwinMemory(vm, 16 * 1024 ** 3)).toEqual({
			usedBytes,
			availableBytes: 16 * 1024 ** 3 - usedBytes,
			basis: "app+wired+compressed",
		});
		for (const broken of [
			vm.replace("16384", "0"),
			vm.replace("241117", "-1"),
			vm.replace("2046", "999999"),
			`${vm}Anonymous pages: 1.\n`,
			vm.replace("Pages occupied by compressor:", "missing:"),
		]) {
			expect(darwinMemory(broken, 16 * 1024 ** 3)).toBeNull();
		}
		expect(darwinMemory(vm, 1)).toBeNull();
		expect(darwinMemory(vm, Number.NaN)).toBeNull();
		const comparison = await readFile(new URL("./fixtures/darwin-comparison.txt", import.meta.url), "utf8");
		const swap = comparison.split("\n").find((line) => line.startsWith("vm.swapusage:")) ?? "";
		expect(darwinSwap(swap)).toEqual({
			usedBytes: Math.round(3079.44 * 1024 ** 2),
			totalBytes: 4096 * 1024 ** 2,
		});
		for (const broken of [
			"",
			swap.replace("3079.44", "99999.00"),
			swap.replace("1016.56", "0.00"),
			swap.replace("4096.00", "Infinity"),
		])
			expect(darwinSwap(broken)).toBeNull();
	});
	it("parses the same-second AM-style kernel capture and measured fixed ps fallback rows", async () => {
		const text = await readFile(new URL("./fixtures/darwin-kernel-window.txt", import.meta.url), "utf8");
		// (203941 anonymous - 2859 purgeable + 171285 wired + 363787 compressor) * 16384 bytes/page.
		expect(darwinMemory(text, 16 * 1024 ** 3)?.usedBytes).toBe(12061147136);
		/**
		 * Extract a page count from the same-second kernel capture, without a page-size assumption.
		 * @param name Exact vm_stat field label in the captured C-locale fixture.
		 * @returns The captured number of pages, or NaN if the fixture field is absent/malformed.
		 */
		const pages = (name: string): number =>
			Number(
				text
					.split("\n")
					.find((line) => line.startsWith(`${name}:`))
					?.match(/:\s+(\d+)\./)?.[1],
			);
		expect({
			app: (pages("Anonymous pages") - pages("Pages purgeable")) * 16384,
			wired: pages("Pages wired down") * 16384,
			compressed: pages("Pages occupied by compressor") * 16384,
			cached: (pages("File-backed pages") + pages("Pages purgeable")) * 16384,
		}).toEqual({ app: 3294527488, wired: 2806333440, compressed: 5960286208, cached: 3607904256 });
		const times = (text.split("\n")[0] ?? "").split(" ").map((value) => Date.parse(value));
		expect(Math.floor((times[0] ?? 0) / 1000)).toBe(Math.floor((times[1] ?? 0) / 1000));
		expect((times[1] ?? 0) - (times[0] ?? 0)).toBe(4);
		expect(text).toContain("System-wide memory free percentage: 47%");
		expect(darwinSwap(text.split("\n").find((line) => line.startsWith("vm.swapusage:")) ?? "")?.usedBytes).toBe(
			Math.round(3490.88 * 1024 ** 2),
		);
		const ps = await readFile(new URL("./fixtures/darwin-ps.txt", import.meta.url), "utf8");
		const rows = ps
			.trim()
			.split("\n")
			.map((line) => darwinProcess(line, 1));
		expect(rows.map((row) => row?.name)).toEqual(["node", "node", "node"]);
		expect(rows.map((row) => row?.strongIdentity)).toEqual([undefined, undefined, undefined]);
	});
	it("does not spawn native readers after byte or deadline admission fails; absence is never zero", async () => {
		for (const budget of [
			new Budget(performance.now() - 1, 4096, 1, new AbortController().signal),
			new Budget(performance.now() + 1000, 0, 1, new AbortController().signal),
		]) {
			const memory = await darwinHostMemory(budget, 16 * 1024 ** 3);
			expect(memory.usage?.state).toBe("unavailable");
			expect(memory.swap?.state).toBe("unavailable");
			expect(budget.bytesRead).toBe(0);
		}
	});
});

describe("bounded child lifecycle", () => {
	it("reaps the child on cancellation before returning", async () => {
		const controller = new AbortController();
		const budget = new Budget(performance.now() + 3000, 4096, 10, controller.signal);
		const pending = command(process.execPath, ["-e", "console.log(process.pid); setInterval(() => {}, 1000)"], budget);
		const readyDeadline = performance.now() + 2000;
		while (budget.bytesRead === 0 && performance.now() < readyDeadline) await delay(10);
		controller.abort();
		const result = await pending;
		const pid = Number(result.text.trim());
		expect(pid).toBeGreaterThan(0);
		expect(result.complete).toBe(false);
		expect(() => process.kill(pid, 0)).toThrow();
	});
	it("bounds bytes and duration for a noisy child", async () => {
		const budget = new Budget(performance.now() + 2000, 4096, 10, new AbortController().signal);
		const result = await command(
			process.execPath,
			["-e", "setInterval(() => process.stdout.write('x'.repeat(8192)), 1)"],
			budget,
		);
		expect(result.complete).toBe(false);
		expect(budget.bytesRead).toBe(4096);
		expect(budget.reasons.has("byte-limit")).toBe(true);
	});
	it("kills a silent child at the deadline and handles spawn failure", async () => {
		const budget = new Budget(performance.now() + 100, 4096, 10, new AbortController().signal);
		expect((await command(process.execPath, ["-e", "setInterval(() => {}, 1000)"], budget)).complete).toBe(false);
		expect(budget.reasons.has("deadline")).toBe(true);
		const failed = new Budget(performance.now() + 1000, 4096, 10, new AbortController().signal);
		expect((await command("/nonexistent-resource-sampler-fixture", [], failed)).complete).toBe(false);
		expect(failed.reasons.has("command-unavailable")).toBe(true);
	});
});

// Real readlink, except where a test forces a runtime result no real symlink can produce.
vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return { ...actual, opendir: vi.fn(actual.opendir), readlink: vi.fn(actual.readlink) };
});

describe("bounded executable links", () => {
	it("charges readlink to the remaining byte budget and drops names beyond it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "resource-sampler-"));
		try {
			const target = `/opt/${"d".repeat(100)}/tool`;
			const link = join(dir, "exe");
			await symlink(target, link);
			const roomy = new Budget(performance.now() + 2000, 4096, 10, new AbortController().signal);
			expect(await roomy.executable(link)).toBe("tool");
			expect(roomy.bytesRead).toBe(target.length);
			const tight = new Budget(performance.now() + 2000, 4096, 10, new AbortController().signal);
			tight.bytesRead = 4096 - 50;
			expect(await tight.executable(link)).toBe("");
			expect(tight.bytesRead).toBe(4096);
			expect([...tight.reasons]).toEqual(["byte-limit"]);
			// The scan's next `status` read is refused, so the whole process is skipped, not kept unnamed.
			await expect(tight.read(link)).rejects.toThrow("budget exhausted");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it("drops a target that fills Node's PATH_MAX readlink buffer, which may be truncated", async () => {
		vi.mocked(readlink).mockResolvedValueOnce(Buffer.alloc(4096, "a"));
		const budget = new Budget(performance.now() + 2000, 1 << 20, 10, new AbortController().signal);
		expect(await budget.executable("/proc/1/exe")).toBe("");
		expect(budget.bytesRead).toBe(4096);
		expect([...budget.reasons]).toEqual(["file-byte-limit"]);
	});
});

describe("bounded proc reads and Linux process collection", () => {
	it("reads complete proc data, rejects a full bounded read, and preserves byte accounting", async () => {
		const dir = await mkdtemp(join(tmpdir(), "resource-sampler-read-"));
		try {
			const short = join(dir, "short");
			const full = join(dir, "full");
			await writeFile(short, "ok");
			await writeFile(full, "x".repeat(4096));
			const complete = new Budget(performance.now() + 1000, 4096, 1, new AbortController().signal);
			expect(await complete.read(short)).toBe("ok");
			expect(complete.bytesRead).toBe(2);
			const truncated = new Budget(performance.now() + 1000, 4096, 1, new AbortController().signal);
			await expect(truncated.read(full)).rejects.toThrow("proc file may be truncated");
			expect(truncated.bytesRead).toBe(4096);
			expect([...truncated.reasons]).toContain("file-byte-limit");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it("drops an unreadable executable link without leaking its failure", async () => {
		vi.mocked(readlink).mockRejectedValueOnce(new Error("ptrace denied"));
		const budget = new Budget(performance.now() + 1000, 4096, 1, new AbortController().signal);
		expect(await budget.executable("/proc/1/exe")).toBe("");
		expect(budget.bytesRead).toBe(0);
	});
	it("captures stderr limits and nonzero helper exits", async () => {
		const noisy = new Budget(performance.now() + 1000, 4096, 1, new AbortController().signal);
		expect(await command(process.execPath, ["-e", "process.stderr.write('x'.repeat(8192))"], noisy)).toMatchObject({
			complete: false,
			text: "",
		});
		expect([...noisy.reasons]).toContain("byte-limit");
		const failed = new Budget(performance.now() + 1000, 4096, 1, new AbortController().signal);
		expect(await command(process.execPath, ["-e", "process.exit(7)"], failed)).toMatchObject({ complete: false });
		expect([...failed.reasons]).toContain("command-failed");
	});
	it("returns parsed Linux PSI instead of a fabricated unavailable metric", async () => {
		const budget = new Budget(performance.now() + 1000, 4096, 1, new AbortController().signal);
		vi.spyOn(budget, "read").mockResolvedValue("some avg10=1.25 avg60=0 avg300=0 total=42\n");
		expect(await pressure(budget, "linux")).toEqual({
			source: "linux-psi",
			memory: { state: "available", value: { some: { avg10: 1.25, avg60: 0, avg300: 0, total: 42 }, full: null } },
		});
	});
	it("keeps valid Linux identity-bracketed rows and skips changed rows", async () => {
		const entries = [{ name: "not-a-pid" }, { name: "12" }, { name: "13" }];
		vi.mocked(opendir).mockResolvedValueOnce({
			async *[Symbol.asyncIterator]() {
				yield* entries;
			},
		} as never);
		const fields = Array<string>(22).fill("0");
		fields[0] = "S";
		fields[1] = "1";
		fields[11] = "20";
		fields[12] = "30";
		fields[19] = "77";
		const stat = `12 (kernel-owned name) ${fields.join(" ")}`;
		const budget = new Budget(performance.now() + 1000, 8192, 3, new AbortController().signal);
		vi.spyOn(budget, "read")
			.mockResolvedValueOnce(stat)
			.mockResolvedValueOnce("VmRSS:\t42 kB\n")
			.mockResolvedValueOnce(stat)
			.mockResolvedValueOnce("bad");
		vi.spyOn(budget, "executable").mockResolvedValueOnce("node");
		const rows = await linuxProcesses(budget, 100);
		expect(rows).toEqual([
			expect.objectContaining({ pid: 12, parentPid: 1, name: "node", identity: "12:77", rssBytes: 43008, cpuMs: 500 }),
		]);
		expect(budget.skipped).toBe(1);
		expect([...budget.reasons]).toContain("process-unreadable-or-changed");
	});
	it("stops enumeration at the PID cap and rejects a changed second identity", async () => {
		vi.mocked(opendir).mockResolvedValueOnce({
			async *[Symbol.asyncIterator]() {
				yield { name: "12" };
			},
		} as never);
		const capped = new Budget(performance.now() + 1000, 4096, 0, new AbortController().signal);
		expect(await linuxProcesses(capped, 100)).toEqual([]);
		expect([...capped.reasons]).toContain("pid-limit");

		vi.mocked(opendir).mockResolvedValueOnce({
			async *[Symbol.asyncIterator]() {
				yield { name: "12" };
			},
		} as never);
		const fields = Array<string>(22).fill("0");
		fields[0] = "S";
		fields[1] = "1";
		fields[11] = "20";
		fields[12] = "30";
		fields[19] = "77";
		const changed = new Budget(performance.now() + 1000, 4096, 1, new AbortController().signal);
		vi.spyOn(changed, "read")
			.mockResolvedValueOnce(`12 (name) ${fields.join(" ")}`)
			.mockResolvedValueOnce("VmRSS:\t42 kB\n")
			.mockResolvedValueOnce(`12 (name) ${fields.map((field, index) => (index === 19 ? "78" : field)).join(" ")}`);
		vi.spyOn(changed, "executable").mockResolvedValue("node");
		expect(await linuxProcesses(changed, 100)).toEqual([]);
		expect(changed.skipped).toBe(1);
	});
});

describe("platform dispatch", () => {
	async function samplerFor(platformName: string, helperOutput?: string) {
		vi.resetModules();
		vi.doMock("node:os", async () => {
			const actual = await vi.importActual<typeof import("node:os")>("node:os");
			return { ...actual, platform: () => platformName };
		});
		if (helperOutput !== undefined) {
			vi.doMock("node:child_process", () => ({
				spawn: () => {
					const child = Object.assign(new EventEmitter(), {
						kill: () => true,
						stderr: new EventEmitter(),
						stdout: new EventEmitter(),
					});
					queueMicrotask(() => {
						child.stdout.emit("data", Buffer.from(helperOutput));
						child.emit("close", 0);
					});
					return child;
				},
			}));
		}
		return (await import("../src/index.js")).createResourceSampler({ maxDurationMs: 1000 });
	}
	afterEach(() => {
		vi.doUnmock("node:child_process");
		vi.doUnmock("node:os");
		vi.resetModules();
	});
	it("collects the Linux-only /proc path with the runtime's real counters", async () => {
		const sampler = await samplerFor("linux");
		try {
			const snapshot = await sampler.sample();
			expect(snapshot.platform).toBe("linux");
			expect(snapshot.pressure.source).toBe("linux-psi");
			expect(snapshot.coverage.reasons).not.toContain("unsupported-platform");
		} finally {
			await sampler.dispose();
		}
	});
	it("records malformed Darwin ps metadata without inventing a process row", async () => {
		const sampler = await samplerFor("darwin", "malformed helper output\n");
		try {
			const snapshot = await sampler.sample();
			expect(snapshot.processes).toEqual([]);
			expect(snapshot.coverage.reasons).toContain("malformed-process-row");
		} finally {
			await sampler.dispose();
		}
	});
	it("reports unavailable clock ticks when the fixed lookup cannot supply a safe integer", async () => {
		const sampler = await samplerFor("linux", "not-a-clock-rate\n");
		try {
			const snapshot = await sampler.sample();
			expect(snapshot.processes).toEqual([]);
			expect(snapshot.coverage.reasons).toContain("clock-ticks-unavailable");
		} finally {
			await sampler.dispose();
		}
	});
	it("reports non-Linux, non-Darwin process collection as explicitly unsupported", async () => {
		const sampler = await samplerFor("freebsd");
		try {
			const snapshot = await sampler.sample();
			expect(snapshot.platform).toBe("freebsd");
			expect(snapshot.processes).toEqual([]);
			expect(snapshot.coverage.reasons).toContain("unsupported-platform");
			expect(snapshot.pressure).toEqual({
				source: "unsupported",
				reason: "no comparable native PSI metric on this platform",
			});
		} finally {
			await sampler.dispose();
		}
	});
});

describe("reloaded native decoder", () => {
	it("rejects cumulative CPU counters that move backwards", async () => {
		const { darwinNativeCounter } = await import("../src/darwin.js");
		const before = Buffer.alloc(96);
		const after = Buffer.alloc(96);
		const bsd = Buffer.alloc(136);
		bsd.writeUInt32LE(12, 12);
		bsd.writeBigUInt64LE(1n, 120);
		before.writeBigUInt64LE(2n, 16);
		before.writeBigUInt64LE(1n, 80);
		after.writeBigUInt64LE(1n, 80);
		expect(darwinNativeCounter(12, before, bsd, after, 1, 1)).toBeNull();
	});
});

describe("real local sampler", () => {
	it("samples the actual host twice with explicit platform semantics", async () => {
		const sampler = createResourceSampler({ maxDurationMs: 2000 });
		try {
			const first = await sampler.sample();
			expect(first.cpu.state).toBe("warming");
			await delay(60);
			const second = await sampler.sample();
			expect(second.wallTimeMs).toBeGreaterThan(0);
			expect(second.monotonicTimeMs).toBeGreaterThan(first.monotonicTimeMs);
			expect(second.cpu.state).toBe("available");
			if (second.cpu.state === "available") {
				expect(second.cpu.value).toBeGreaterThanOrEqual(0);
				expect(second.cpu.value).toBeLessThanOrEqual(100);
			}
			expect(second.processes.some((entry) => entry.pid === process.pid)).toBe(true);
			const own = second.processes.find((entry) => entry.pid === process.pid);
			const native =
				process.platform === "darwin" &&
				(Boolean(process.versions.bun) || Number(process.versions.node.split(".")[0]) >= 26);
			expect(own?.cpu.state).toBe(process.platform === "linux" || native ? "available" : "unavailable");
			if (native) expect(own?.footprint?.state).toBe("available");
			expect(second.coverage.bytesRead).toBeLessThanOrEqual(2_097_152);
			if (process.platform === "darwin") {
				expect(second.memory.usage?.state).toBe("available");
				expect(second.memory.swap?.state).toBe("available");
			} else {
				expect(second.memory.usage).toBeUndefined();
				expect(second.memory.swap).toBeUndefined();
			}
			console.info(
				JSON.stringify({
					platform: second.platform,
					durationMs: second.durationMs,
					coverage: second.coverage,
					cpu: second.cpu,
					ownProcessCpu: own?.cpu,
				}),
			);
		} finally {
			await sampler.dispose();
		}
	});
	it("exposes partial PID coverage, rejects overlap/cancellation and awaits disposal", async () => {
		const sampler = createResourceSampler({ maxPids: 1 });
		const first = sampler.sample();
		await expect(sampler.sample()).rejects.toThrow("active sample");
		const result = await first;
		expect(result.processes.length).toBeLessThanOrEqual(1);
		expect(result.coverage.complete).toBe(false);
		expect(result.coverage.reasons).toContain("pid-limit");
		const controller = new AbortController();
		controller.abort();
		await expect(sampler.sample(controller.signal)).rejects.toThrow();
		const pending = sampler.sample();
		const rejected = expect(pending).rejects.toThrow();
		await sampler.dispose();
		await rejected;
		await sampler.dispose();
		await expect(sampler.sample()).rejects.toThrow("disposed");
	});
	it("rejects unsafe budgets before doing I/O", () => {
		for (const maxPids of [0, -1, 1.5, Number.NaN, 16385])
			expect(() => createResourceSampler({ maxPids })).toThrow(RangeError);
		expect(() => createResourceSampler({ maxBytes: 1 })).toThrow(RangeError);
		expect(() => createResourceSampler({ maxDurationMs: Number.POSITIVE_INFINITY })).toThrow(RangeError);
	});
});
