/** Real interactive host + real published sampler. Only the kit's scheduling clock is faked. */
import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	createResourceSampler,
	type ResourceSampler,
	type ResourceSnapshot,
	type SamplerOptions,
} from "@nredd/pi-resource-sampler";
import { afterEach, expect, it } from "vitest";
import { registerMon } from "../../src/mon/index.ts";
import { createSamplerSource } from "../../src/mon/source.ts";
import { configFor, deferred, TerminalFixture } from "./support.ts";

const SIZES = [
	[40, 12],
	[60, 20],
	[80, 24],
	[120, 40],
] as const;
const nativeDarwinCpu =
	platform() === "darwin" &&
	(Boolean(process.versions.bun) ||
		Number(process.versions.node.split(".")[0]) > 26 ||
		(Number(process.versions.node.split(".")[0]) === 26 && Number(process.versions.node.split(".")[1]) >= 1));
let fixture: TerminalFixture | undefined;
afterEach(async () => {
	await fixture?.dispose();
	fixture = undefined;
});

/** Direct children of this test process, excluding the `ps` used to ask. */
function children(): number[] {
	const ps = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
	return ps.stdout
		.split("\n")
		.map((line) => line.trim().split(/\s+/).map(Number))
		.filter(([pid, ppid]) => ppid === process.pid && pid !== ps.pid)
		.map(([pid]) => pid as number);
}

/**
 * The real published sampler behind the real `/mon` command, observed rather than replaced. Each
 * resolved scan is the event a frame waits on: the scan's own 250ms budget is load dependent, so a
 * loaded host can legitimately report `0 of 0 seen (time budget)`, and only a fake clock tick ever
 * polls again. Frames are checked against the scan that produced them, never polled for a hoped one.
 */
function observedMon(): { factory: ExtensionFactory; next: () => Promise<ResourceSnapshot> } {
	let scan = deferred<ResourceSnapshot>();
	const create = (options?: SamplerOptions): ResourceSampler => {
		const real = createResourceSampler(options);
		return {
			sample: async (signal) => {
				const snapshot = await real.sample(signal);
				scan.resolve(snapshot);
				return snapshot;
			},
			dispose: () => real.dispose(),
		};
	};
	return {
		factory: (pi) => registerMon(pi, { createSource: () => createSamplerSource(create), clock: fixture?.clock }),
		/** Resolve with the next completed scan once `/mon` rendered it and scheduled the next poll. */
		next: async () => {
			const snapshot = await scan.promise;
			scan = deferred<ResourceSnapshot>();
			// The poll consumes the scan in microtasks; one macrotask turn drains them all.
			await new Promise((resolve) => setImmediate(resolve));
			expect(fixture?.clock.pending, "the poll consumed the scan and scheduled the next").toBe(1);
			await fixture?.requireHost().settle();
			return snapshot;
		},
	};
}

/** Start the terminal with the observed real `/mon` and open it on its first scan. */
async function openObserved(): Promise<{ next: () => Promise<ResourceSnapshot> }> {
	fixture = new TerminalFixture();
	const mon = observedMon();
	await fixture.startTerminal(configFor(), { extensionFactories: [mon.factory] });
	return mon;
}

/** Assert the frame renders exactly this scan's process coverage, including a budget notice. */
function rendersScan(screen: string, snapshot: ResourceSnapshot): void {
	expect(screen).toContain("LIVE");
	expect(screen).toContain(` PROCESSES  ${snapshot.processes.length} sampled`);
	// Nonempty, or the sampler itself says why not: an empty complete scan would be a collector bug.
	expect(snapshot.processes.length > 0 || snapshot.coverage.reasons.includes("deadline"), screen).toBe(true);
	const { complete, enumerated, reasons, sampled } = snapshot.coverage;
	if (complete) expect(screen).not.toContain("Partial list");
	// The notice joins reasons in scan order, so an unreadable-process reason can come before the budget one.
	if (reasons.includes("deadline"))
		expect(screen).toMatch(new RegExp(`Partial list: ${sampled} of ${enumerated} seen \\([^)]*time budget`));
}

function layout(width: number, height: number): string[] {
	const rows = fixture?.requireHost().viewport() ?? [];
	const shown = rows.join("\n");
	expect(rows, shown).toHaveLength(height);
	for (const row of rows) expect(visibleWidth(row), shown).toBeLessThanOrEqual(width);
	expect(shown).toContain(" MON");
	expect(
		rows.some((row) => row.includes("q/Esc close")),
		shown,
	).toBe(true);
	return rows;
}

it("/mon shows two real observations, every size, then releases sampling on close", async () => {
	const mon = await openObserved();
	const host = fixture?.requireHost();
	if (!fixture || !host) throw new Error("No host");
	await fixture.open("/mon");
	const baseline = await mon.next();
	const warming = host.viewport().join("\n");
	expect(warming).toContain("-- warming");
	rendersScan(warming, baseline);
	// Real time, not a fake tick: host CPU counters must advance for the second scan to measure an interval.
	await sleep(150);
	fixture.clock.advance(2000);
	// Sampler 0.2.0 copies Bun's lazy `os.cpus()` counters, so Node and Bun both measure the interval.
	const second = await mon.next();
	const live = host.viewport().join("\n");
	expect(live).toMatch(/\d+\.\d%/);
	rendersScan(live, second);
	// macOS without native counters has no process CPU, so the view sorts by RSS until the user sorts.
	const cpuless = platform() === "darwin" && !nativeDarwinCpu && second.processes.length > 0;
	expect(live).toContain(cpuless ? "RSS ↓" : "CPU ↓");
	if (platform() === "darwin") expect(live.includes("macOS: process CPU unavailable")).toBe(cpuless);
	for (const [width, height] of SIZES) {
		host.resize(width, height);
		await host.settle();
		layout(width, height);
	}
	await fixture.close();
	expect(fixture.clock.pending).toBe(0);
	expect(children()).toEqual([]);
	expect(host.viewport().join("\n")).not.toContain(" PROCESSES ");
});

it("/mon releases an in-flight real sample on session shutdown", async () => {
	fixture = new TerminalFixture();
	await fixture.startTerminal(configFor("mon"));
	await fixture.open("/mon");
	await fixture.requireHost().dispose();
	expect(fixture.clock.pending).toBe(0);
	expect(children()).toEqual([]);
});

it("/mon closed before its first real sample completes schedules nothing", async () => {
	fixture = new TerminalFixture();
	await fixture.startTerminal(configFor("mon"));
	await fixture.open("/mon");
	await fixture.close();
	expect(fixture.clock.pending).toBe(0);
	expect(children()).toEqual([]);
});

it("/mon reopens after close with a fresh warming baseline", async () => {
	const mon = await openObserved();
	if (!fixture) throw new Error("No host");
	for (let round = 0; round < 2; round++) {
		await fixture.open("/mon");
		const baseline = await mon.next();
		const warming = fixture.requireHost().viewport().join("\n");
		expect(warming).toContain("-- warming");
		rendersScan(warming, baseline);
		await fixture.close(round ? "\x1b" : "q");
		expect(fixture.clock.pending).toBe(0);
	}
	expect(children()).toEqual([]);
});

it.each([
	["mon", true],
	["diff", false],
] as const)("/mon registration follows the %s feature switch", async (feature, registered) => {
	fixture = new TerminalFixture();
	const host = await fixture.startTerminal(configFor(feature));
	expect(Boolean(host.harness.session.extensionRunner.getCommand("mon"))).toBe(registered);
});
