import { ChildProcess, spawnSync } from "node:child_process";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { lstat, readFile } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
	createResourceSampler,
	type ResourceSampler,
	type ResourceSnapshot,
	type SamplerOptions,
} from "@nredd/pi-resource-sampler";
import { describe, expect, it, vi } from "vitest";
import { MonView } from "../../src/mon/component.ts";
import { MonPoll } from "../../src/mon/poll.ts";
import { createSamplerSource, toMonSnapshot } from "../../src/mon/source.ts";
import { resourceFixture } from "./resource-fixture.ts";

const theme = { fg: (_color: string, s: string) => s, bg: (_color: string, s: string) => s, bold: (s: string) => s };

/** @returns Direct child PIDs of this worker, excluding the ps helper used to ask. */
function children(): number[] {
	const ps = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
	return ps.stdout
		.split("\n")
		.map((line) => line.trim().split(/\s+/).map(Number))
		.filter(([pid, ppid]) => ppid === process.pid && pid !== ps.pid)
		.map(([pid]) => pid as number);
}

/** @returns Number of currently active timeout resources in this test worker. */
function timers(): number {
	return process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
}

/** @returns A promise for the next event loop check phase. */
function tick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Narrow a `child_process` channel message without trusting its untyped payload.
 * @param message Channel payload.
 * @returns Whether it carries a child.
 */
function isChildMessage(message: unknown): message is { process: ChildProcess } {
	return message instanceof Object && "process" in message && message.process instanceof ChildProcess;
}

/**
 * Observe the next child this worker spawns through Node's documented `child_process` channel.
 * The channel publishes from the `ChildProcess` constructor, so the promise settles in the microtask
 * after a synchronous `spawn()` returned: the PID is set and the event loop cannot have reaped it yet.
 * @returns The first child, and the disposer ending the subscription whether or not one spawned.
 */
function watchNextChild(): { spawned: Promise<ChildProcess>; stop: () => void } {
	let onChild: (message: unknown) => void = () => {};
	const spawned = new Promise<ChildProcess>((resolve) => {
		onChild = (message) => {
			if (isChildMessage(message)) resolve(message.process);
		};
	});
	subscribe("child_process", onChild);
	return { spawned, stop: () => unsubscribe("child_process", onChild) };
}

/**
 * Kill a helper and park the event loop until the kernel reports it exited, so it is an unreaped zombie
 * whatever the host load. Condition-based: no duration can pass with the helper still running.
 * @param child Helper to end.
 */
function parkUntilExited(child: ChildProcess): void {
	child.kill("SIGKILL");
	for (let i = 0; i < 1000; i++) {
		const ps = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(child.pid)], { encoding: "utf8" });
		if (ps.stdout.trim().startsWith("Z")) return;
	}
	throw new Error(`helper ${child.pid} never exited after SIGKILL`);
}

/**
 * Build a typed independent sampler fixture.
 * @param overrides Fields replacing the stable baseline fixture.
 * @returns Synthetic producer snapshot.
 */
function raw(overrides: Partial<ResourceSnapshot> = {}): ResourceSnapshot {
	return { ...resourceFixture(), ...overrides } as ResourceSnapshot;
}

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const nativeDarwinCpu =
	platform() === "darwin" &&
	(Boolean(process.versions.bun) ||
		Number(process.versions.node.split(".")[0]) > 26 ||
		(Number(process.versions.node.split(".")[0]) === 26 && Number(process.versions.node.split(".")[1]) >= 1));

describe("published sampler source on this host", () => {
	it("resolves the exact registry sampler, never the workspace copy", async () => {
		const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf8"));
		const version = manifest.dependencies["@nredd/pi-resource-sampler"];
		expect(version).toMatch(/^\d+\.\d+\.\d+$/);
		const resolved = spawnSync(
			process.execPath,
			["--input-type=module", "-e", "console.log(import.meta.resolve('@nredd/pi-resource-sampler'))"],
			{ cwd: PACKAGE_ROOT, encoding: "utf8" },
		);
		const installed = join(PACKAGE_ROOT, "node_modules", "@nredd", "pi-resource-sampler");
		expect(fileURLToPath(resolved.stdout.trim())).toBe(join(installed, "dist", "index.js"));
		expect((await lstat(installed)).isSymbolicLink()).toBe(false);
		expect(JSON.parse(await readFile(join(installed, "package.json"), "utf8")).version).toBe(version);
	});

	it("maps two actual observations: warming baseline, then measured interval CPU", async () => {
		const source = createSamplerSource();
		const signal = new AbortController().signal;
		try {
			const first = await source.sample(signal);
			// The baseline is a successful collection whose host CPU has no interval yet.
			expect(first.status).toBe("live");
			expect(first.cpuState).toBe("warming");
			expect(first.cpuPercent).toBeNull();
			expect(first.memoryTotalBytes).toBeGreaterThan(0);
			await sleep(150);
			const second = await source.sample(signal);
			expect(second.status).toBe("live");
			expect(second.cpuState).toBe("available");
			expect(second.cpuPercent).toBeGreaterThanOrEqual(0);
			expect(second.cpuPercent).toBeLessThanOrEqual(100);
			expect(second.capturedAt).toBeGreaterThan(first.capturedAt);
			expect(second.sampledAtMs - first.sampledAtMs).toBeGreaterThanOrEqual(150);
			expect(second.memoryTotalBytes).toBeGreaterThan(0);
			expect(second.scanMs).toBeGreaterThanOrEqual(0);
			const self = second.processes.find((p) => p.pid === process.pid);
			expect(self?.rssBytes).toBeGreaterThan(0);
			if (platform() === "darwin") {
				// 0.2.0 provides native interval CPU after the baseline, never a ps average.
				if (nativeDarwinCpu) {
					expect(self?.cpuPercent).toBeGreaterThanOrEqual(0);
					expect(second.processCpu).toBeUndefined();
					expect(second.hint ?? "").not.toContain("macOS: process CPU unavailable");
				} else {
					expect(second.processes.every((p) => p.cpuPercent === null)).toBe(true);
					expect(second.processCpu).toBe("unavailable");
					expect(second.hint).toContain("macOS: process CPU unavailable");
				}
				// Names come from `p_comm`, never argv or a rewritten process title.
				const node = second.processes.find((p) => p.pid === process.pid);
				expect(node?.name).toMatch(/^(node|bun)/);
				expect(second.processes.every((p) => !p.name.includes(" exec "))).toBe(true);
			} else {
				expect(self?.cpuPercent).toBeGreaterThanOrEqual(0);
				expect(second.processCpu).toBeUndefined();
			}
		} finally {
			await source.dispose();
		}
		await expect(source.sample(signal)).rejects.toThrow(/disposed/);
	});

	it.each([
		{ name: "a spawn in the first turn", delaySpawn: false, parkLoop: false },
		{ name: "a spawn two ticks late", delaySpawn: true, parkLoop: false },
		{ name: "a helper already exited", delaySpawn: false, parkLoop: true },
	])(
		"cancels an in-flight real sample on close, reaping its provider work, given $name",
		async ({ delaySpawn, parkLoop }) => {
			// Start in a check phase, so a later immediate runs only after a full poll phase, as under load.
			await tick();
			const baseline = timers();
			// Controlled seam: the real published sampler, wrapped only to observe the in-flight promise.
			let inFlight: Promise<ResourceSnapshot> | undefined;
			const create = (options?: SamplerOptions): ResourceSampler => {
				const real = createResourceSampler(options);
				return {
					sample: (signal) => {
						// Two ticks: one would still spawn before an immediate the caller scheduled in the same turn.
						inFlight = (delaySpawn ? tick().then(tick) : Promise.resolve()).then(() => real.sample(signal));
						return inFlight;
					},
					dispose: () => real.dispose(),
				};
			};
			const { spawned, stop } = watchNextChild();
			const pid = spawned.then((child) => {
				if (parkLoop) parkUntilExited(child);
				return child.pid;
			});
			const update = vi.fn();
			const poll = new MonPoll(createSamplerSource(create), update);
			poll.start();
			expect(inFlight).toBeDefined();
			const outcome = inFlight?.then(
				() => "resolved",
				(error: unknown) => (error instanceof Error ? error.name : "non-error"),
			);
			// The first helper, not any later instant: helpers run in turn and leave gaps with no child at all.
			const helper = await Promise.race([pid, outcome?.then(() => undefined)]).finally(stop);
			expect(helper, "the sample finished without spawning a helper").toBeDefined();
			// macOS: `vm_stat`, listed even once exited because nothing has reaped it yet.
			if (platform() === "darwin") expect(children()).toContain(helper);
			// Linux reads /proc in-process and spawns only `getconf`, so the child listing stays darwin-only;
			// the AbortError below is the provider's own cancellation evidence.
			await poll.dispose();
			expect(await outcome).toBe("AbortError");
			expect(update).not.toHaveBeenCalled();
			expect(children()).toEqual([]);
			expect(timers()).toBeLessThanOrEqual(baseline);
		},
	);

	it("drives a real poll for two updates, then closes cleanly", async () => {
		const updates: string[] = [];
		const before = timers();
		const poll = new MonPoll(createSamplerSource(), (s) => updates.push(`${s.status}/${s.cpuState}`), undefined, 100);
		poll.start();
		for (let i = 0; i < 100 && updates.length < 2; i++) await sleep(20);
		await poll.dispose();
		expect(updates.slice(0, 2)).toEqual(["live/warming", "live/available"]);
		expect(children()).toEqual([]);
		expect(timers()).toBeLessThanOrEqual(before);
	});

	it("awaits sampler disposal and creates one sampler per source", async () => {
		const dispose = vi.fn(async () => {});
		const create = vi.fn(() => ({ sample: vi.fn(), dispose }) as unknown as ResourceSampler);
		const source = createSamplerSource(create);
		await source.dispose();
		expect(create).toHaveBeenCalledOnce();
		expect(dispose).toHaveBeenCalledOnce();
	});
});

describe("sampler snapshot mapping", () => {
	it("keeps warming and unavailable metrics unknown, never zero", () => {
		const warming = toMonSnapshot(raw({ cpu: { state: "warming", reason: "first sample" } }));
		expect(warming.status).toBe("live");
		expect(warming.cpuState).toBe("warming");
		expect(warming.sampledAtMs).toBe(10_000);
		expect(warming.cpuPercent).toBeNull();
		expect(warming.notice).toBeUndefined();
		const frozen = toMonSnapshot(raw({ cpu: { state: "warming", reason: "CPU counters have not advanced" } }), false);
		expect(frozen.notice).toBe("Host CPU warming: CPU counters have not advanced");
		const unavailable = toMonSnapshot(raw({ cpu: { state: "unavailable", reason: "x" } }));
		expect(unavailable.status).toBe("live");
		expect(unavailable.cpuState).toBe("unavailable");
		expect(unavailable.cpuPercent).toBeNull();
		expect(unavailable.notice).toContain("Host CPU unavailable");
		const linux = toMonSnapshot(raw());
		expect(linux.processes.at(-1)?.cpuPercent).toBeNull();
		expect(linux.processCpu).toBeUndefined();
		expect(linux.notice).toBeUndefined();
	});

	it("prefers additive native memory and never falls back to total-free when that reader fails", () => {
		const input = {
			...raw({ platform: "darwin" }),
			memory: {
				totalBytes: 16 * 1024 ** 3,
				freeBytes: 1024 ** 3,
				usage: {
					state: "available" as const,
					value: { usedBytes: 12 * 1024 ** 3, availableBytes: 4 * 1024 ** 3, basis: "app+wired+compressed" as const },
				},
				swap: { state: "available" as const, value: { usedBytes: 3 * 1024 ** 3, totalBytes: 4 * 1024 ** 3 } },
			},
		};
		const mapped = toMonSnapshot(input);
		expect(mapped.memoryUsedBytes).toBe(12 * 1024 ** 3);
		expect(mapped.memoryBasis).toBe("app+wired+compressed");
		expect(mapped.swapUsedBytes).toBe(3 * 1024 ** 3);
		expect(mapped.memoryFreeBytes).toBe(1024 ** 3);
		const failed = toMonSnapshot({
			...input,
			memory: {
				...input.memory,
				usage: { state: "unavailable", reason: "budget" },
				swap: { state: "unavailable", reason: "budget" },
			},
		});
		expect(failed.memoryUsedBytes).toBeNull();
		expect(failed.swapUsedBytes).toBeNull();
		const legacy = toMonSnapshot(
			raw({ platform: "darwin", memory: { totalBytes: 16 * 1024 ** 3, freeBytes: 1024 ** 3 } }),
		);
		expect(legacy.memoryUsedBytes).toBe(15 * 1024 ** 3);
		expect(legacy.memoryBasis).toBe("total-free");
	});

	it("maps native interval CPU and footprint independently, preserving failed PID metrics as unknown", () => {
		const base = raw({ platform: "darwin" });
		const processes = base.processes.slice(0, 3).map((p, i) => ({
			...p,
			cpu: { state: "available" as const, value: 99.7 },
			footprint:
				i === 0
					? { state: "available" as const, value: 12345678 }
					: { state: "unavailable" as const, reason: "no access" },
		}));
		const mapped = toMonSnapshot({ ...base, processes });
		expect(mapped.processCpu).toBeUndefined();
		expect(mapped.processes[0]?.cpuPercent).toBe(99.7);
		expect(mapped.processes.map((p) => p.footprintBytes)).toEqual([12345678, null, null]);
		for (const value of [
			{ usedBytes: -1, totalBytes: 4 },
			{ usedBytes: 5, totalBytes: 4 },
		]) {
			const result = toMonSnapshot({ ...base, memory: { ...base.memory, swap: { state: "available", value } } });
			expect(result.swapUsedBytes).toBeNull();
			expect(result.swapTotalBytes).toBeNull();
		}
	});

	it("treats missing memory or non-finite values as unknown", () => {
		const zero = toMonSnapshot(raw({ memory: { totalBytes: 0, freeBytes: 0 }, durationMs: Number.NaN }));
		expect(zero.memoryTotalBytes).toBeNull();
		expect(zero.memoryUsedBytes).toBeNull();
		expect(zero.scanMs).toBeNull();
		const broken = toMonSnapshot(raw({ cpu: { state: "available", value: Number.POSITIVE_INFINITY } }));
		expect(broken.cpuPercent).toBeNull();
	});

	it("explains partial coverage with bounded sampler reasons", () => {
		const partial = toMonSnapshot(
			raw({
				coverage: {
					complete: false,
					enumerated: 900,
					sampled: 40,
					skipped: 3,
					bytesRead: 1,
					reasons: ["deadline", "pid-limit", "byte-limit", "fourth", "fifth"],
				},
			}),
		);
		expect(partial.notice).toBe("Partial list: 40 of 900 seen (time budget, process cap, read budget)");
		expect(partial.hint).toBeUndefined();
	});

	it("treats routine Linux skips and unreadable names as hints, not warnings", () => {
		const processes = resourceFixture().processes.map((p, i) => ({ ...p, name: i < 3 ? "" : p.name }));
		const linux = toMonSnapshot(
			raw({
				processes,
				coverage: {
					complete: false,
					enumerated: 52,
					sampled: 40,
					skipped: 12,
					bytesRead: 1,
					reasons: ["process-unreadable-or-changed"],
				},
			}),
		);
		expect(linux.notice).toBeUndefined();
		expect(linux.hint).toBe(
			"12 skipped: kernel threads, exited or unreadable · 3 names unknown (no access, e.g. other users)",
		);
		expect(linux.processes.slice(0, 4).map((p) => p.nameState)).toEqual(["unknown", "unknown", "unknown", undefined]);
		const view = new MonView({ theme, rows: () => 24, requestRender: vi.fn(), onClose: vi.fn() });
		view.update(linux);
		view.handleInput("p");
		const text = view.render(80).join("\n");
		expect(text).toContain("(unknown)");
		expect(text).toContain("12 skipped");
		expect(text).not.toContain("▲");
		// A budget limit next to the routine skip is still a warning.
		const capped = toMonSnapshot(
			raw({
				coverage: {
					complete: false,
					enumerated: 52,
					sampled: 40,
					skipped: 12,
					bytesRead: 1,
					reasons: ["process-unreadable-or-changed", "deadline"],
				},
			}),
		);
		expect(capped.notice).toBe("Partial list: 40 of 52 seen (unreadable or exited, time budget)");
	});

	it("marks macOS names that may be cut at 16 bytes, never Linux names", () => {
		const names = ["Google Chrome He", "WindowServer", "界界界界界a"];
		const processes = resourceFixture("darwin")
			.processes.slice(0, 3)
			.map((p, i) => ({ ...p, name: names[i] ?? "" }));
		const darwin = toMonSnapshot(raw({ ...resourceFixture("darwin"), processes } as Partial<ResourceSnapshot>));
		expect(darwin.processes.map((p) => p.nameState)).toEqual(["truncated", undefined, "truncated"]);
		const linux = toMonSnapshot(
			raw({ processes: resourceFixture().processes.map((p) => ({ ...p, name: names[0] ?? "" })) }),
		);
		expect(linux.processes.every((p) => p.nameState === undefined)).toBe(true);
		const view = new MonView({ theme, rows: () => 24, requestRender: vi.fn(), onClose: vi.fn() });
		view.update(darwin);
		expect(view.render(80).join("\n")).toContain("Google Chrome He…");
	});

	it("labels Darwin process CPU unavailable and defaults the view to RSS until the user sorts", () => {
		const mapped = toMonSnapshot(resourceFixture("darwin") as ResourceSnapshot);
		expect(mapped.processCpu).toBe("unavailable");
		expect(mapped.processes.every((p) => p.cpuPercent === null)).toBe(true);
		expect(mapped.cpuPercent).toBe(36.2);
		const view = new MonView({ theme, rows: () => 24, requestRender: vi.fn(), onClose: vi.fn() });
		view.update(mapped);
		expect(view.state.sort).toBe("rss");
		expect(view.render(80).join("\n")).toContain("RSS ↓");
		view.handleInput("c");
		view.update(mapped);
		expect(view.state.sort).toBe("cpu");
	});

	it("keeps CPU order stable across a Linux warming baseline", () => {
		const view = new MonView({ theme, rows: () => 24, requestRender: vi.fn(), onClose: vi.fn() });
		const warmingProcesses = resourceFixture().processes.map((p) => ({
			...p,
			cpu: { state: "warming" as const, reason: "no baseline" },
		}));
		view.update(toMonSnapshot(raw({ processes: warmingProcesses })));
		expect(view.state.sort).toBe("cpu");
		view.update(toMonSnapshot(raw()));
		expect(view.state.sort).toBe("cpu");
	});
});
