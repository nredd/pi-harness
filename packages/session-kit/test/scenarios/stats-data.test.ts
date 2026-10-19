import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { exportStats, importStats } from "../../src/stats/snapshot.ts";
import { assistant, footer, history, hourly, layout, seed, start } from "./stats-support.ts";
import { TerminalFixture } from "./support.ts";

let fixture: TerminalFixture;
afterEach(async () => fixture?.dispose());

it("stats reopening uses versioned cache with unchanged totals", async () => {
	fixture = new TerminalFixture();
	seed(fixture);
	await start(fixture);
	await fixture.open("/stats");
	const first = layout(fixture);
	const cache = join(fixture.agentDir, "pi-session-kit", "stats-cache.json");
	expect(existsSync(cache)).toBe(true);
	expect(JSON.parse(readFileSync(cache, "utf8")).version).toBe(2);
	await fixture.close();
	footer(fixture);
	await fixture.open("/stats");
	const second = layout(fixture);
	const before = first.match(/Total tokens: \S+/)?.[0];
	const after = second.match(/Total tokens: \S+/)?.[0];
	expect(before, first).toBeDefined();
	expect(after, second).toBeDefined();
	expect(after).toBe(before);
	await fixture.close();
});

it("empty history notifies without overlay", async () => {
	fixture = new TerminalFixture();
	await start(fixture);
	const host = fixture.requireHost();
	await host.harness.session.prompt("/stats");
	await host.settle();
	expect(host.viewport().join("\n")).toContain("/stats: no usage recorded yet");
	footer(fixture);
});

it("corrupt import retains remote totals and fresh local usage", async () => {
	fixture = new TerminalFixture();
	const entries = hourly(fixture.clock.now());
	history(fixture.agentDir, entries);
	const shared = join(fixture.root, "shared");
	const machines = [await exportStats(fixture.agentDir, shared)];
	for (let i = 1; i < 3; i++) {
		const dir = join(fixture.root, `work-${i}`);
		const copy = entries[i - 1];
		if (!copy || typeof copy !== "object") throw new Error("Missing copied call");
		history(dir, [...entries, { ...copy, id: `remote-distinct-entry-${i}` }]);
		machines.push(await exportStats(dir, shared));
	}
	expect(new Set(machines.map((machine) => machine.machineId)).size).toBe(3);
	await importStats(fixture.agentDir, shared);
	const corrupt = machines[1];
	if (!corrupt) throw new Error("Missing remote machine");
	writeFileSync(join(corrupt.snapshotDir, "manifest.json"), "{not valid json\n");
	const result = await importStats(fixture.agentDir, shared);
	expect(result.retained).toBe(1);
	expect(result.problems.join("\n")).toMatch(/invalid|corrupt|incomplete|json|manifest/i);
	history(
		fixture.agentDir,
		[assistant(fixture.clock.now() - 5 * 60_000, "anthropic", "claude-opus-5-5", 2)],
		"fresh-local",
	);
	await start(fixture, 160, 50);
	await fixture.open("/stats");
	const shown = layout(fixture);
	expect(shown).toMatch(/Total tokens: 676\b/);
	expect(shown).toMatch(/incomplete/i);
	expect(shown).toMatch(/last remote sync|remote sync|last sync/i);
	await fixture.close();
	footer(fixture);
});
