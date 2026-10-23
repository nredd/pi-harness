/** Real Plan and stats factories over native cross-machine snapshots and raw terminal input. */
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { exportStats, importStats } from "../../packages/session-kit/src/stats/snapshot.ts";
import {
	chart,
	footer,
	history,
	hourly,
	layout,
	selectFilter,
	selectTotal,
} from "../../packages/session-kit/test/scenarios/stats-support.ts";
import { configFor, RESIZES, TerminalFixture } from "../../packages/session-kit/test/scenarios/support.ts";
import { isolateStackHome, loadFork } from "./support.ts";

let home: Awaited<ReturnType<typeof isolateStackHome>>;
let fixture: TerminalFixture;
afterEach(async () => {
	await fixture?.dispose();
	await home?.cleanup();
});

/** Chart tabs retain hourly axes; Machines shows freshness before returning to Overview. */
async function hourlyTabs(): Promise<void> {
	await fixture.key("j".repeat(40));
	chart(layout(fixture));
	expect(layout(fixture)).toContain("Tokens per hour");
	await fixture.key("\t");
	chart(layout(fixture));
	expect(layout(fixture)).toContain("Tokens per hour");
	for (const key of ["\x1b[B", "\x1b[A", "j", "k"]) await fixture.key(key);
	layout(fixture);
	await fixture.key("\t");
	expect(layout(fixture)).toContain("Viewer last import:");
	expect(layout(fixture)).toContain("Local scan complete at opening");
	await fixture.key("\t");
	await fixture.key("k".repeat(60));
	expect(layout(fixture)).toContain("Total tokens ");
}

it("combined snapshots remain available in Plan mode", async () => {
	home = await isolateStackHome();
	fixture = new TerminalFixture();
	const entries = hourly(fixture.clock.now());
	const shared = join(fixture.root, "shared");
	history(fixture.agentDir, entries);
	const machines = [await exportStats(fixture.agentDir, shared)];
	for (let i = 1; i < 3; i++) {
		const dir = join(fixture.root, `work-${i}`);
		const copy = entries[i - 1];
		if (!copy) throw new Error("Missing copied call");
		history(dir, [...entries, { ...copy, id: `remote-distinct-entry-${i}` }]);
		machines.push(await exportStats(dir, shared));
	}
	expect(new Set(machines.map((m) => m.machineId)).size).toBe(3);
	for (let i = 0; i < 2; i++) {
		const imported = await importStats(fixture.agentDir, shared);
		expect(imported.problems).toEqual([]);
		expect(imported.imported).toBe(3);
	}
	const host = await fixture.startTerminal(configFor("stats"), {
		columns: 160,
		rows: 50,
		extensionFactories: [await loadFork("pi-plan-mode")],
	});
	host.input("/plan start");
	host.input("\r");
	await host.settle();
	expect(host.viewport().join("\n")).toMatch(/plan/i);
	await fixture.open("/stats", true);
	const shown = layout(fixture);
	expect(shown).toMatch(/Total tokens +624\b/);
	expect(shown).toMatch(/\b3 machines\b/);
	expect(shown).toContain("viewer last import");
	expect(shown).not.toMatch(/local.only|never.synced/i);
	for (const [total, anthropic, codex] of [
		[156, 52, 104],
		[338, 130, 208],
		[624, 260, 364],
	]) {
		if (total === undefined) throw new Error("Missing total");
		await selectTotal(fixture, total);
		if (total !== 624) await hourlyTabs();
		expect(await selectFilter(fixture, "anthropic")).toMatch(new RegExp(`Total tokens +${anthropic}\\b`));
		expect(await selectFilter(fixture, "openai-codex")).toMatch(new RegExp(`Total tokens +${codex}\\b`));
		await selectFilter(fixture, "All models");
	}
	await selectTotal(fixture, 156);
	for (const [width, height] of RESIZES) {
		host.resize(width, height);
		await host.settle();
		layout(fixture);
		await hourlyTabs();
	}
	await fixture.close();
	footer(fixture);
	expect(host.viewport().join("\n")).toMatch(/plan/i);
	await fixture.open("/stats", true);
	expect(layout(fixture)).toMatch(/Total tokens +624\b/);
	await fixture.close();
	footer(fixture);
	expect(
		host.harness.sessionManager
			.getBranch()
			.flatMap((entry) => (entry.type === "custom" && entry.customType === "plan-mode-state" ? [entry.data] : []))
			.at(-1),
	).toMatchObject({ enabled: true });
});
