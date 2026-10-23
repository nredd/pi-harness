/** Real interactive host + real published sampler. Only the kit's scheduling clock is faked. */
import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, expect, it } from "vitest";
import { configFor, TerminalFixture } from "./support.ts";

const SIZES = [
	[40, 12],
	[60, 20],
	[80, 24],
	[120, 40],
] as const;
/** A real process sample arrived; the empty view also says "0 sampled". */
const SAMPLED = /BUSY PROCESSES {2}[1-9]\d* sampled/;
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

/** Wait on actual terminal frames; real sampling is asynchronous host work, bounded to 10s. */
async function until(predicate: (screen: string) => boolean): Promise<string> {
	const host = fixture?.requireHost();
	if (!host) throw new Error("No host");
	let screen = "";
	for (let i = 0; i < 500; i++) {
		await host.settle();
		screen = host.viewport().join("\n");
		if (predicate(screen)) return screen;
		await sleep(20);
	}
	throw new Error(`Timed out waiting for /mon frame:\n${screen}`);
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
	fixture = new TerminalFixture();
	const host = await fixture.startTerminal(configFor("mon"));
	await fixture.open("/mon");
	await until((s) => s.includes("WARMING") && SAMPLED.test(s));
	expect(fixture.clock.pending).toBe(1);
	await sleep(150);
	fixture.clock.advance(2000);
	// Bun's `os.cpus()` counters are cached on macOS (observed with 1.3.14 and 1.4.3): usually frozen,
	// so the sampler keeps host CPU warming with its reason, occasionally a coarse jump. Shipped Pi
	// runs on Node, where the interval is measured; Bun only proves the explanation path.
	const measured = (s: string) => s.includes("LIVE") && /\d+\.\d%/.test(s);
	const bun = "bun" in process.versions;
	const live = await until((s) =>
		bun ? measured(s) || s.includes("Host CPU warming: CPU counters have not advanced") : measured(s),
	);
	expect(live).toMatch(SAMPLED);
	if (platform() === "darwin") {
		expect(live).toContain("RSS ↓");
		expect(live).toContain("macOS: process CPU unavailable");
	} else expect(live).toContain("CPU ↓");
	for (const [width, height] of SIZES) {
		host.resize(width, height);
		await host.settle();
		layout(width, height);
	}
	await fixture.close();
	expect(fixture.clock.pending).toBe(0);
	expect(children()).toEqual([]);
	expect(host.viewport().join("\n")).not.toContain("BUSY PROCESSES");
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
	fixture = new TerminalFixture();
	await fixture.startTerminal(configFor("mon"));
	for (let round = 0; round < 2; round++) {
		await fixture.open("/mon");
		await until((s) => s.includes("WARMING") && SAMPLED.test(s));
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
