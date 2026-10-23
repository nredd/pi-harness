import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
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

/** Direct children of this worker, excluding the `ps` used to ask. */
function children(): number[] {
	const ps = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
	return ps.stdout
		.split("\n")
		.map((line) => line.trim().split(/\s+/).map(Number))
		.filter(([pid, ppid]) => ppid === process.pid && pid !== ps.pid)
		.map(([pid]) => pid as number);
}

function timers(): number {
	return process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
}

function raw(overrides: Partial<ResourceSnapshot> = {}): ResourceSnapshot {
	return { ...resourceFixture(), ...overrides } as ResourceSnapshot;
}

describe("published sampler source on this host", () => {
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
				// Unavailable stays unknown; it never becomes 0%.
				expect(second.processes.every((p) => p.cpuPercent === null)).toBe(true);
				expect(second.processCpu).toBe("unavailable");
				expect(second.notice).toContain("macOS: process CPU unavailable");
			} else {
				expect(self?.cpuPercent).toBeGreaterThanOrEqual(0);
				expect(second.processCpu).toBeUndefined();
			}
		} finally {
			await source.dispose();
		}
		await expect(source.sample(signal)).rejects.toThrow(/disposed/);
	});

	it("cancels an in-flight real sample on close, reaping its provider work", async () => {
		const before = timers();
		// Controlled seam: the real published sampler, wrapped only to observe the in-flight promise.
		let inFlight: Promise<ResourceSnapshot> | undefined;
		const create = (options?: SamplerOptions): ResourceSampler => {
			const real = createResourceSampler(options);
			return {
				sample: (signal) => {
					inFlight = real.sample(signal);
					return inFlight;
				},
				dispose: () => real.dispose(),
			};
		};
		const update = vi.fn();
		const poll = new MonPoll(createSamplerSource(create), update);
		poll.start();
		expect(inFlight).toBeDefined();
		const outcome = inFlight?.then(
			() => "resolved",
			(error: unknown) => (error instanceof Error ? error.name : "non-error"),
		);
		// Let the sampler reach its provider: on macOS that is a spawned `ps` child.
		await new Promise((resolve) => setImmediate(resolve));
		const during = children();
		if (platform() === "darwin") expect(during.length).toBeGreaterThan(0);
		// Linux reads /proc in-process (one `getconf` child on the first sample, possibly already gone), so
		// no child is asserted there; the AbortError below is the provider's own cancellation evidence.
		await poll.dispose();
		expect(await outcome).toBe("AbortError");
		expect(update).not.toHaveBeenCalled();
		expect(children()).toEqual([]);
		expect(timers()).toBeLessThanOrEqual(before);
	});

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
		expect(partial.notice).toBe("Partial: 40 of 900 seen processes (deadline, pid-limit, byte-limit)");
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
