import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, expect, it } from "vitest";
import { configFor, RESIZES, STATUS, TerminalFixture, WIDTHS } from "./support.ts";

const TITLE = /^ \/diff \S+\s+\d+ files?\s+\+\d+ -\d+/;
const POSITION = /(\d+)\/(\d+)\s+(\d+)-(\d+)\/(\d+)\s*$/;
const LONG_LINE = `wide_${"0123456789".repeat(50)}`;
const LONG_PATH = "docs/a/really/deeply/nested/directory/structure/that/goes/on/file_with_a_rather_long_name.txt";
let fixture: TerminalFixture;
afterEach(async () => fixture?.dispose());

/** Git fixture operations use a fixed identity and never the user's commit hooks/signing settings. */
function git(repo: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "user.name=h", "-c", "user.email=h@h", "-c", "commit.gpgsign=false", ...args], {
		cwd: repo,
		encoding: "utf8",
	});
}

/** Same five statuses, long/tab/CJK patch and hunk spacing as the live scenario. */
function makeRepo(dirty = true): string {
	const repo = join(fixture.root, "repo");
	mkdirSync(join(repo, LONG_PATH, ".."), { recursive: true });
	git(repo, "init", "-q");
	const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}\n`);
	writeFileSync(join(repo, "app.py"), lines.join(""));
	writeFileSync(join(repo, "gone.txt"), "to be deleted\n".repeat(30));
	writeFileSync(join(repo, LONG_PATH), "old\n".repeat(5));
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "init");
	if (!dirty) return repo;
	for (let i = 10; i < 300; i += 25)
		lines[i] = `changed ${i}\t${i % 50 === 10 ? "漢字かな交じり文".repeat(12) : "tab"}\n`;
	lines.push(`${LONG_LINE}\n`);
	writeFileSync(join(repo, "app.py"), lines.join(""));
	writeFileSync(join(repo, "staged.py"), "print('staged')\n".repeat(20));
	git(repo, "add", "staged.py");
	unlinkSync(join(repo, "gone.txt"));
	writeFileSync(join(repo, LONG_PATH), "new\n".repeat(5));
	writeFileSync(join(repo, "untracked.md"), `# untracked\n${LONG_LINE}\n`);
	return repo;
}

/** Every body separator, the first/last rows and display-cell bounds are terminal facts. */
function layout(files = 5): string[] {
	const host = fixture.requireHost();
	const rows = host.viewport();
	const shown = rows.join("\n");
	expect(rows, shown).toHaveLength(host.terminal.rows);
	expect(rows[0], shown).toMatch(TITLE);
	expect(rows[0]).toContain(`${files} files`);
	for (const row of rows) expect(visibleWidth(row), shown).toBeLessThanOrEqual(host.terminal.columns);
	expect(rows.at(-1), shown).toMatch(POSITION);
	expect(rows.at(-1)).toContain("q");
	const columns = rows.slice(1, -1).map((row) => row.indexOf("│"));
	expect(
		columns.every((col) => col >= 0),
		shown,
	).toBe(true);
	expect(new Set(columns).size, shown).toBe(1);
	expect(shown).not.toContain(STATUS);
	return rows;
}

/** Parse the actual help row, not component state. */
function position(): [number, number, number, number, number] {
	const match = fixture.requireHost().viewport().at(-1)?.match(POSITION);
	if (!match) throw new Error(fixture.requireHost().viewport().join("\n"));
	return match.slice(1).map(Number) as [number, number, number, number, number];
}

/** Closing restores cwd, core stats and extension status in that order. */
function footer(): void {
	const rows = fixture.requireHost().viewport();
	const shown = rows.join("\n");
	expect(
		rows.some((row) => TITLE.test(row) || POSITION.test(row)),
		shown,
	).toBe(false);
	const stats = rows.flatMap((row, i) => (/\b(?:ctx )?\d+(\.\d+)?%\/\S+ \(auto\)/.test(row) ? [i] : []));
	expect(stats, shown).toHaveLength(1);
	const at = stats[0] ?? -1;
	expect(rows.slice(at + 1).join("\n"), shown).toContain(STATUS);
	expect(rows[at - 1], shown).toContain("/");
}

it.each(WIDTHS)("diff overlay width matrix navigates and restores footer at %i", async (width) => {
	fixture = new TerminalFixture();
	await fixture.startTerminal(configFor("diff"), { cwd: makeRepo(), columns: width, rows: width === 320 ? 60 : 40 });
	await fixture.open("/diff");
	layout();
	expect(position().slice(0, 2)).toEqual([1, 5]);
	for (let file = 2; file <= 5; file++) {
		await fixture.key("n");
		expect(position()[0]).toBe(file);
		layout();
	}
	await fixture.key("n");
	expect(position()[0]).toBe(5);
	for (let file = 4; file >= 1; file--) {
		await fixture.key("p");
		expect(position()[0]).toBe(file);
	}
	await fixture.key("p");
	expect(position()[0]).toBe(1);
	const [, , first, last, total] = position();
	expect(first).toBe(1);
	expect(total).toBeGreaterThan(last);
	await fixture.key("j");
	expect(position()[2]).toBe(2);
	await fixture.key("k");
	expect(position()[2]).toBe(1);
	await fixture.key("\x1b[6~");
	expect(position()[2]).toBe(last);
	expect(last).toBeGreaterThan(1);
	await fixture.key("G");
	expect(position()[3]).toBe(total);
	layout();
	await fixture.key("\x1b[5~");
	expect(position()[2]).toBeLessThan(total);
	await fixture.key("g");
	expect(position()[2]).toBe(1);
	layout();
	await fixture.close();
	footer();
});

it("diff relayout follows virtual terminal resize", async () => {
	fixture = new TerminalFixture();
	const host = await fixture.startTerminal(configFor("diff"), { cwd: makeRepo() });
	await fixture.open("/diff");
	for (const [width, height] of RESIZES) {
		host.resize(width, height);
		await host.settle();
		layout();
	}
	await fixture.close("\x1b");
	footer();
});

it("diff lists all statuses and shortens paths", async () => {
	fixture = new TerminalFixture();
	await fixture.startTerminal(configFor("diff"), { cwd: makeRepo(), columns: 80 });
	await fixture.open("/diff");
	const shown = layout().join("\n");
	for (const label of ["M app.py", "A staged.py", "D gone.txt", "? untracked.md"]) expect(shown).toContain(label);
	expect(/file_with_a_rather_long_name.txt|…/.test(shown), shown).toBe(true);
	for (let i = 0; i < 4; i++) await fixture.key("n");
	expect(position()[0]).toBe(5);
	expect(fixture.requireHost().viewport().join("\n")).toContain("# untracked");
	await fixture.close();
	footer();
});

it("bad ref leaves overlay closed and next open works", async () => {
	fixture = new TerminalFixture();
	const host = await fixture.startTerminal(configFor("diff"), { cwd: makeRepo() });
	await host.harness.session.prompt("/diff no-such-ref-xyz");
	await host.settle();
	expect(host.viewport().join("\n")).toContain("/diff: ");
	footer();
	await fixture.open("/diff HEAD");
	layout();
	await fixture.close();
	footer();
});

it.each(["arguments", "clean", "outside"] as const)("diff %s notifies without overlay", async (kind) => {
	fixture = new TerminalFixture();
	const cwd = kind === "outside" ? fixture.root : makeRepo(kind !== "clean");
	const host = await fixture.startTerminal(configFor("diff"), { cwd });
	await host.harness.session.prompt(kind === "arguments" ? "/diff HEAD HEAD~1" : "/diff");
	await host.settle();
	expect(host.viewport().join("\n")).toContain(
		kind === "arguments" ? "usage: /diff [ref]" : kind === "clean" ? "no changes vs" : "/diff: ",
	);
	footer();
});

it("diff browsing never mutates tree or index", async () => {
	fixture = new TerminalFixture();
	const repo = makeRepo();
	const before = git(repo, "status", "--porcelain=v1");
	const patch = git(repo, "diff", "HEAD");
	const untracked = readFileSync(join(repo, "untracked.md"), "utf8");
	await fixture.startTerminal(configFor("diff"), { cwd: repo });
	await fixture.open("/diff");
	for (const key of ["n", "n", "G", "g", "p", "j", "x", "d", "u"]) await fixture.key(key);
	await fixture.close();
	expect(git(repo, "status", "--porcelain=v1")).toBe(before);
	expect(git(repo, "diff", "HEAD")).toBe(patch);
	expect(readFileSync(join(repo, "untracked.md"), "utf8")).toBe(untracked);
});
