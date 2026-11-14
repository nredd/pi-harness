import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecordingContext } from "@nredd/pi-test-lib/pi";
import { afterEach, describe, expect, it } from "vitest";
import { withLock } from "../../src/core/index.ts";
import { findProjectRoot, registerPyTools } from "../../src/py/index.ts";
import { createToolHost } from "../support.ts";
import { wrapperFixture } from "../wrapper-fixture.ts";

const fixtures: ReturnType<typeof wrapperFixture>[] = [];
afterEach(() => {
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});
function setup() {
	const fixture = wrapperFixture("pyproject.toml");
	fixtures.push(fixture);
	const mock = createToolHost();
	registerPyTools(mock.pi, { uvBin: fixture.bin });
	return { ...fixture, ...mock };
}
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "..", "fixtures", "py", name), "utf8");
/** `/bin/sh` body that appends its argv, one argument per line and a blank line after each call. */
const RECORD_ARGV = `for a in "$@"; do printf '%s\\n' "$a"; done >> argv.log; echo >> argv.log`;
const argvLog = (root: string): string[][] =>
	readFileSync(join(root, "argv.log"), "utf8")
		.trimEnd()
		.split("\n\n")
		.map((call) => call.split("\n"));
const TOOLS = ["py_lint", "py_format", "py_typecheck", "py_test", "py_uv"] as const;
const minimal = (name: string) => (name === "py_uv" ? { action: "sync" } : {});

describe("uv executable boundary", () => {
	it("reports unknown output, tool errors, and mixed parsed/unparsed findings", async () => {
		const f = setup();
		f.script('console.log("future diagnostic format"); process.exit(1);');
		const unknown = await f.call("py_lint", {}, f.root);
		expect(unknown.structuredContent).toMatchObject({
			state: "unparsed",
			count: 0,
			unparsed: ["future diagnostic format"],
		});
		expect(unknown.isError).toBe(true);
		f.script('console.log("a.py:1:2: F401 unused import"); console.log("future extra"); process.exit(1);');
		const mixed = await f.call("py_lint", {}, f.root);
		expect(mixed.structuredContent).toMatchObject({ state: "findings", count: 1, unparsed: ["future extra"] });
		expect(f.text(mixed)).toContain("unparsed output (1 lines)");
		f.script('console.error("tool invocation rejected"); process.exit(2);');
		for (const name of ["py_lint", "py_format"]) {
			const result = await f.call(name, {}, f.root);
			expect(result.isError).toBe(true);
			expect(f.text(result)).toContain("tool error (exit 2)");
		}
	});

	it("rejects drifted apply summaries and keeps failed uv management output", async () => {
		const f = setup();
		f.script('console.log("future format summary");');
		const format = await f.call("py_format", { mode: "apply" }, f.root);
		expect(format.isError).toBe(true);
		expect(f.text(format)).toContain("could not read the summary line");
		f.script('console.error("dependency resolution failed"); process.exit(2);');
		const result = await f.call("py_uv", { action: "sync" }, f.root);
		expect(result.isError).toBe(true);
		expect(f.text(result)).toContain("uv sync: exit 2\ndependency resolution failed");
	});

	it("preserves an unchanged apply result and passes dependency groups as separate argv", async () => {
		const f = setup();
		f.script('console.log("1 file left unchanged");');
		const unchanged = await f.call("py_format", { mode: "apply" }, f.root);
		expect(unchanged.structuredContent).toEqual({ state: "clean", files: [], reformatted: 0 });
		f.script('console.log("Added " + JSON.stringify(process.argv.slice(2)));');
		for (const action of ["add", "remove"]) {
			const result = await f.call("py_uv", { action, packages: ["fixture>=1"], group: "test", dev: true }, f.root);
			expect(result.isError).toBe(false);
			expect(result.structuredContent).toMatchObject({
				action,
				state: "ok",
				summary: `Added ${JSON.stringify([action, "--dev", "--group", "test", "--", "fixture>=1"])}`,
			});
		}
	});

	it("maps unexpected pytest exits instead of claiming test failure", async () => {
		const f = setup();
		f.script('console.error("internal plugin problem"); process.exit(3);');
		const result = await f.call("py_test", {}, f.root);
		expect(result.isError).toBe(true);
		expect(f.text(result)).toContain("pytest: unexpected exit 3");
		expect(f.text(result)).toContain("internal plugin problem");
		expect(findProjectRoot("/does-not-exist/dev-tools-fixture")).toBeUndefined();
	});

	it("maps signal exits for every uv wrapper", async () => {
		const f = setup();
		f.script('process.kill(process.pid, "SIGTERM");');
		for (const name of ["py_lint", "py_format", "py_typecheck", "py_test", "py_uv"]) {
			const result = await f.call(name, name === "py_uv" ? { action: "sync" } : {}, f.root);
			expect(result.isError).toBe(true);
			expect(f.text(result)).toContain("SIGTERM");
		}
	});

	it.each([false, true])("cancels a queued uv call and publishes waiting feedback (symlink: %s)", async (symlink) => {
		const f = setup();
		const cwd = symlink ? join(f.root, "alias") : f.root;
		if (symlink) symlinkSync(f.root, cwd, "dir");
		f.script('require("node:fs").writeFileSync("started", "wrong"); throw new Error("must not start");');
		const controller = new AbortController();
		const updates: unknown[] = [];
		// Match the wrapper's canonical project identity, even when TMPDIR or cwd is a symlink.
		await withLock(`uv:${realpathSync(f.root)}`, async () => {
			const pending = f.tools.get("py_lint")?.execute(
				"id",
				{},
				controller.signal,
				((value: unknown) => {
					updates.push(value);
					// Cancel only once the contended lock has actually published waiting feedback.
					controller.abort();
				}) as never,
				createRecordingContext({ cwd }).ctx,
			);
			expect(await pending).toMatchObject({ isError: true });
		});
		expect(JSON.stringify(updates)).toContain("waiting for another uv run");
		expect(existsSync(join(f.root, "started"))).toBe(false);
	});

	it("names a missing project from either cwd without starting uv", async () => {
		const f = setup();
		f.script("touch started", "/bin/sh");
		// `tmpdir()` has no pyproject.toml at or above it, so both the explicit and the session cwd miss.
		const message = `no pyproject.toml found at or above ${tmpdir()} (within the repository)`;
		for (const name of TOOLS) {
			expect(f.text(await f.call(name, { ...minimal(name), cwd: tmpdir() }, f.root)), name).toBe(message);
			expect(f.text(await f.call(name, minimal(name), tmpdir())), name).toBe(message);
		}
		expect(existsSync(join(f.root, "started"))).toBe(false);
	});

	it("stops the project walk at a repository boundary", () => {
		const repo = mkdtempSync(join(tmpdir(), "dev-tools-git-boundary-"));
		try {
			mkdirSync(join(repo, ".git"));
			mkdirSync(join(repo, "pkg", "src"), { recursive: true });
			expect(findProjectRoot(join(repo, "pkg", "src"))).toBeUndefined();
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("maps paths and every optional flag to uv's argv", async () => {
		const f = setup();
		f.script(`${RECORD_ARGV}; echo 'All checks passed!'`, "/bin/sh");
		const lint = await f.call("py_lint", { paths: ["a.py"], fix: true }, f.root);
		// ruff prints no `(N fixed, M remaining)` trailer when there was nothing to fix.
		expect(lint.structuredContent).toEqual({ state: "clean", count: 0, diagnostics: [], unparsed: [] });
		await f.call("py_format", { paths: ["a.py"] }, f.root);
		await f.call("py_typecheck", { paths: ["a.py"] }, f.root);
		await f.call("py_test", { last_failed: true, markers: "slow", coverage: true }, f.root);
		await f.call("py_uv", { action: "sync", all_extras: false, all_groups: false }, f.root);
		await f.call("py_uv", { action: "add", packages: ["fixture"] }, f.root);
		expect(argvLog(f.root)).toEqual([
			[
				"run",
				"--frozen",
				"ruff",
				"check",
				"--output-format",
				"concise",
				"--no-cache",
				"--fix",
				"--ignore-noqa",
				"--",
				"a.py",
			],
			["run", "--frozen", "ruff", "format", "--no-cache", "--diff", "--", "a.py"],
			["run", "--frozen", "ty", "check", "--output-format", "concise", "--", "a.py"],
			[
				"run",
				"--frozen",
				"pytest",
				"--verbosity=-1",
				"--tb=short",
				"--lf",
				"--maxfail=5",
				"-m=slow",
				"--cov=src",
				"--cov-report=term-missing",
			],
			["sync"],
			["add", "--", "fixture"],
		]);
	});

	it("passes each `select` rule to ruff as its own --select flag", async () => {
		const f = setup();
		f.script(`${RECORD_ARGV}; echo 'All checks passed!'`, "/bin/sh");
		await f.call("py_lint", { select: ["E501", "F401"], paths: ["a.py"] }, f.root);
		expect(argvLog(f.root)).toEqual([
			[
				"run",
				"--frozen",
				"ruff",
				"check",
				"--output-format",
				"concise",
				"--no-cache",
				"--select=E501",
				"--select=F401",
				"--",
				"a.py",
			],
		]);
	});

	it("shows stdout for a tool error that wrote nothing to stderr", async () => {
		const f = setup();
		f.script("echo \"error: unexpected argument '--bogus' found\"; exit 2", "/bin/sh");
		const result = await f.call("py_typecheck", {}, f.root);
		expect(f.text(result)).toBe("ty check: tool error (exit 2)\nerror: unexpected argument '--bogus' found");
	});

	it("reads ruff format's single-file summaries", async () => {
		const f = setup();
		f.script("echo '1 file reformatted, 2 files left unchanged' >&2", "/bin/sh");
		const applied = await f.call("py_format", { mode: "apply" }, f.root);
		expect(f.text(applied)).toBe("ruff format: 1 file reformatted");
		expect(applied.structuredContent).toEqual({ state: "reformatted", files: [], reformatted: 1 });
		f.script(
			`process.stdout.write(${JSON.stringify(fixture("ruff-format-diff-one.txt"))}); console.error("1 file would be reformatted, 2 files already formatted"); process.exit(1);`,
		);
		const check = await f.call("py_format", {}, f.root);
		expect(f.text(check)).toBe("ruff format: 1 file would be reformatted\n  src/pt/good.py");
		expect(check.structuredContent).toEqual({ state: "would-reformat", files: ["src/pt/good.py"] });
	});

	it("keeps pytest-cov's TOTAL line on a passing run", async () => {
		const f = setup();
		f.script(`process.stdout.write(${JSON.stringify(fixture("pytest-cov-passed.txt"))});`);
		const result = await f.call("py_test", { coverage: true }, f.root);
		expect(f.text(result)).toMatch(/^pytest: passed \(1 passed in 0\.02s\) in \d+\.\ds\nTOTAL {20}2 {6}0 {3}100%$/);
		expect(result.structuredContent).toMatchObject({ state: "passed", exit: 0, counts: { passed: 1 } });
	});

	it("reports a uv run that changed nothing without an empty summary", async () => {
		const f = setup();
		f.script("echo 'Checked 9 packages in 0.56ms' >&2", "/bin/sh");
		const result = await f.call("py_uv", { action: "sync" }, f.root);
		expect(f.text(result)).toMatch(/^uv sync: ok in \d+\.\ds$/);
		expect(result.structuredContent).toEqual({ action: "sync", state: "ok", summary: "" });
	});

	it("propagates a spawn failure that is not a lock abort", async () => {
		const f = setup();
		f.script("touch started", "/bin/sh");
		// Node and Bun both reject NUL in argv synchronously, before any process exists.
		await expect(f.call("py_test", { k: "a\0b" }, f.root)).rejects.toThrow(/null bytes|NUL|\\0/i);
		expect(existsSync(join(f.root, "started"))).toBe(false);
	});
});
