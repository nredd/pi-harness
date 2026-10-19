/** Slash-command composition through the real Plan and kit interactive factories. */
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, expect, it } from "vitest";
import { git } from "../../packages/dev-tools/test/scenarios/support.ts";
import { configFor, STATUS, TerminalFixture } from "../../packages/session-kit/test/scenarios/support.ts";
import { isolateStackHome, loadFork } from "./support.ts";

let home: Awaited<ReturnType<typeof isolateStackHome>>;
let fixture: TerminalFixture;
afterEach(async () => {
	await fixture?.dispose();
	await home?.cleanup();
});

it("Plan permits diff command overlay", async () => {
	home = await isolateStackHome();
	fixture = new TerminalFixture();
	const repo = join(fixture.root, "repo");
	mkdirSync(repo);
	git(repo, "init", "-q");
	for (const name of ["app.py", "gone.txt", "long.txt"]) writeFileSync(join(repo, name), "old\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "Initial");
	for (const name of ["app.py", "long.txt", "staged.py", "untracked.md"]) writeFileSync(join(repo, name), "new\n");
	git(repo, "add", "staged.py");
	unlinkSync(join(repo, "gone.txt"));
	const host = await fixture.startTerminal(configFor("diff"), {
		cwd: repo,
		extensionFactories: [await loadFork("pi-plan-mode")],
	});
	host.input("/plan start");
	host.input("\r");
	await host.settle();
	expect(host.viewport().join("\n")).toMatch(/plan/i);
	await fixture.open("/diff", true);
	const rows = host.viewport();
	const shown = rows.join("\n");
	expect(rows).toHaveLength(40);
	expect(rows[0], shown).toMatch(/^ \/diff \S+\s+5 files\s+\+\d+ -\d+/);
	for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(120);
	expect(rows.at(-1), shown).toMatch(/\d+\/\d+\s+\d+-\d+\/\d+\s*$/);
	expect(rows.at(-1)).toContain("q");
	const columns = rows.slice(1, -1).map((row) => row.indexOf("│"));
	expect(
		columns.every((column) => column >= 0),
		shown,
	).toBe(true);
	expect(new Set(columns).size).toBe(1);
	expect(shown).not.toContain(STATUS);
	await fixture.close();
	const closed = host.viewport().join("\n");
	expect(closed).toContain(STATUS);
	expect(closed).not.toMatch(/^ \/diff \S+\s+\d+ files?/m);
	expect(closed).toMatch(/plan/i);
	expect(
		host.harness.sessionManager
			.getBranch()
			.flatMap((entry) => (entry.type === "custom" && entry.customType === "plan-mode-state" ? [entry.data] : []))
			.at(-1),
	).toMatchObject({ enabled: true });
});
