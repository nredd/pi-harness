import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { findProjectRoot, registerPyTools } from "../../src/py/index.ts";
import { createMockPi } from "../support.ts";

function haveUv(): boolean {
	try {
		execSync("uv --version", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const mock = createMockPi();
let root: string;

/** A tiny uv project with one lint, one format, one type and one test failure, synced offline-ish. */
function buildProject(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-dev-tools-py-"));
	writeFileSync(
		join(dir, "pyproject.toml"),
		`[project]
name = "pt"
version = "0.0.0"
requires-python = ">=3.12"
dependencies = []

[dependency-groups]
dev = ["pytest", "ruff", "ty"]

[tool.ruff.lint]
select = ["E", "F", "I"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
`,
	);
	mkdirSync(join(dir, "src", "pt"), { recursive: true });
	writeFileSync(join(dir, "src", "pt", "__init__.py"), "");
	writeFileSync(join(dir, "src", "pt", "bad.py"), "import os,sys\ndef f( x:int )->str:\n    return x\n");
	writeFileSync(join(dir, "src", "pt", "good.py"), "def add(a: int, b: int) -> int:\n    return a + b\n");
	mkdirSync(join(dir, "tests"));
	writeFileSync(
		join(dir, "tests", "test_a.py"),
		"from pt.good import add\n\n\ndef test_ok():\n    assert add(1, 2) == 3\n\n\ndef test_fail():\n    print('hello stdout')\n    assert add(1, 2) == 4, 'math is hard'\n",
	);
	execFileSync("uv", ["sync", "--all-groups", "-q"], { cwd: dir, stdio: "ignore" });
	return dir;
}

describe.skipIf(!haveUv())("py tools against a real uv project", () => {
	beforeAll(() => {
		registerPyTools(mock.pi);
		root = buildProject();
	}, 180_000);

	it("annotates typecheck and test read-only, lint/format/uv not", () => {
		expect(mock.tools.get("py_typecheck")?.annotations?.readOnlyHint).toBe(true);
		expect(mock.tools.get("py_test")?.annotations?.readOnlyHint).toBe(true);
		for (const name of ["py_lint", "py_format", "py_uv"])
			expect(mock.tools.get(name)?.annotations?.readOnlyHint, name).toBe(false);
	});

	it("finds the project root from a subdirectory and fails cleanly outside one", async () => {
		expect(findProjectRoot(join(root, "src", "pt"))).toBe(realpathSync(root));
		const r = await mock.call("py_typecheck", {}, tmpdir());
		expect(r.isError).toBe(true);
		expect(mock.text(r)).toMatch(/no pyproject\.toml/);
	});

	it("py_lint reports findings, then fixes them when asked", async () => {
		const report = await mock.call("py_lint", {}, root);
		expect(report.isError).toBe(true);
		const s = report.structuredContent as {
			state: string;
			count: number;
			diagnostics: { code: string }[];
			unparsed: string[];
		};
		expect(s.state).toBe("findings");
		expect(s.diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining(["F401", "I001"]));
		expect(s.unparsed).toEqual([]);
		expect(mock.text(report)).toMatch(/^ruff check: \d+ findings in/);
		const fixed = await mock.call("py_lint", { fix: true }, root);
		const fs = fixed.structuredContent as { state: string; fixed: number };
		expect(fs.fixed).toBeGreaterThan(0);
		const clean = await mock.call("py_lint", {}, join(root, "src"));
		expect(clean.isError).toBe(false);
		expect(mock.text(clean)).toMatch(/^ruff check: clean/);
	});

	it("py_format checks, diffs, applies", async () => {
		const check = await mock.call("py_format", {}, root);
		expect(check.isError).toBe(true);
		expect(check.structuredContent).toMatchObject({ state: "would-reformat" });
		expect((check.structuredContent as { files: string[] }).files).toContain("src/pt/bad.py");
		expect(mock.text(check)).not.toContain("@@");
		const diff = await mock.call("py_format", { mode: "diff" }, root);
		expect(mock.text(diff)).toContain("@@");
		const apply = await mock.call("py_format", { mode: "apply" }, root);
		expect(apply.structuredContent).toMatchObject({ state: "reformatted" });
		const again = await mock.call("py_format", {}, root);
		expect(again.structuredContent).toMatchObject({ state: "clean" });
	});

	it("py_typecheck reports the type error with rule and location", async () => {
		const r = await mock.call("py_typecheck", {}, root);
		expect(r.isError).toBe(true);
		const s = r.structuredContent as { state: string; diagnostics: { code: string; file: string; severity: string }[] };
		expect(s.state).toBe("findings");
		expect(s.diagnostics).toEqual([
			expect.objectContaining({ code: "invalid-return-type", file: "src/pt/bad.py", severity: "error" }),
		]);
		expect(mock.text(r)).toMatch(/src\/pt\/bad\.py:\d+:12 error\[invalid-return-type\]/);
	});

	it("py_test maps exit codes to states and lists only failures", async () => {
		const failed = await mock.call("py_test", {}, root);
		expect(failed.isError).toBe(true);
		const s = failed.structuredContent as {
			state: string;
			exit: number;
			counts: Record<string, number>;
			failures: { nodeid: string }[];
		};
		expect(s.state).toBe("failed");
		expect(s.counts).toEqual({ failed: 1, passed: 1 });
		expect(s.failures.map((f) => f.nodeid)).toEqual(["tests/test_a.py::test_fail"]);
		expect(mock.text(failed)).toContain("hello stdout");
		expect(mock.text(failed)).not.toMatch(/test_ok.*PASSED/);

		const passed = await mock.call("py_test", { k: "test_ok" }, root);
		expect(passed.isError).toBe(false);
		expect(passed.structuredContent).toMatchObject({ state: "passed", counts: { passed: 1, deselected: 1 } });

		const none = await mock.call("py_test", { k: "nothing_matches" }, root);
		expect(none.structuredContent).toMatchObject({ state: "no-tests", exit: 5 });

		const usage = await mock.call("py_test", { targets: ["nope.py"] }, root);
		expect(usage.structuredContent).toMatchObject({ state: "usage-error", exit: 4 });

		writeFileSync(join(root, "tests", "test_c.py"), "import nonexistent_mod\n");
		const interrupted = await mock.call("py_test", {}, root);
		expect(interrupted.structuredContent).toMatchObject({ state: "interrupted", exit: 2 });
		rmSync(join(root, "tests", "test_c.py"));
		expect(existsSync(join(root, ".pytest_cache"))).toBe(false);
	});

	it("rejects option-shaped values everywhere a positional is accepted", async () => {
		for (const [tool, params] of [
			["py_lint", { paths: ["--config=/evil"] }],
			["py_lint", { select: ["--fix"] }],
			["py_format", { paths: ["--config=/evil"] }],
			["py_typecheck", { paths: ["--exit-zero"] }],
			["py_test", { targets: ["--basetemp=/tmp/victim"] }],
		] as const) {
			const r = await mock.call(tool, params, root);
			expect(r.isError, tool).toBe(true);
			expect(mock.text(r)).toMatch(/must be a plain value/);
		}
		// `-k`/`-m` values travel as `-k=EXPR`, so a leading `-` is an expression, not a flag.
		const k = await mock.call("py_test", { k: "-not-a-flag" }, root);
		expect((k.structuredContent as { state: string }).state).toMatch(/no-tests|usage-error/);
	});

	it("names uv's own failures instead of mislabelling them", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-dev-tools-nolock-"));
		writeFileSync(
			join(dir, "pyproject.toml"),
			'[project]\nname = "nl"\nversion = "0"\nrequires-python = ">=3.12"\ndependencies = []\n',
		);
		for (const tool of ["py_test", "py_lint", "py_typecheck", "py_format"]) {
			const r = await mock.call(tool, {}, dir);
			expect(r.isError, tool).toBe(true);
			expect(mock.text(r), tool).toMatch(/uv: Unable to find lockfile/);
		}
	});

	it("keeps the summary when the project forces -q through addopts", async () => {
		const pyproject = join(root, "pyproject.toml");
		const original = readFileSync(pyproject, "utf8");
		writeFileSync(pyproject, `${original}\n[tool.pytest.ini_options]\naddopts = "-q"\n`);
		try {
			const r = await mock.call("py_test", {}, root);
			const s = r.structuredContent as { summary: string | null; counts: Record<string, number> };
			expect(s.summary).toMatch(/1 failed, 1 passed/);
			expect(s.counts).toEqual({ failed: 1, passed: 1 });
		} finally {
			writeFileSync(pyproject, original);
		}
	});

	it("does not flag no-tests as an error and marks maxfail stops", async () => {
		const none = await mock.call("py_test", { k: "nothing_matches" }, root);
		expect(none.isError).toBe(false);
		const stopped = await mock.call("py_test", { maxfail: 1 }, root);
		expect((stopped.structuredContent as { stoppedEarly: boolean }).stoppedEarly).toBe(true);
		expect(mock.text(stopped)).toContain("stopped at --maxfail");
	});

	it("py_uv syncs, locks, and rejects option-shaped packages", async () => {
		const sync = await mock.call("py_uv", { action: "sync" }, root);
		expect(sync.isError, mock.text(sync)).toBe(false);
		expect(mock.text(sync)).toMatch(/^uv sync: ok/);
		const locked = await mock.call("py_uv", { action: "lock", locked: true }, root);
		expect(locked.isError).toBe(false);
		const bad = await mock.call("py_uv", { action: "add", packages: ["--index-url=http://evil"] }, root);
		expect(bad.isError).toBe(true);
		expect(mock.text(bad)).toContain("must be a plain value");
		const empty = await mock.call("py_uv", { action: "remove" }, root);
		expect(mock.text(empty)).toContain("needs at least one package");
	});

	it("serializes concurrent calls on one project and reports the wait", async () => {
		// A fake uv that logs start/end so overlap would be visible.
		const log = join(root, "uv-log.txt");
		const fakeUv = join(root, "fake-uv");
		writeFileSync(
			fakeUv,
			`#!/bin/sh\necho "start $$" >> "${log}"\nsleep 0.3\necho "end $$" >> "${log}"\necho "All checks passed!"\n`,
			{ mode: 0o755 },
		);
		const slow = createMockPi();
		registerPyTools(slow.pi, { uvBin: fakeUv });
		const updates: string[] = [];
		const tool = slow.tools.get("py_typecheck");
		const call = () =>
			tool?.execute(
				"id",
				{},
				undefined,
				((u: { content: { text: string }[] }) => updates.push(u.content[0]?.text ?? "")) as never,
				{ cwd: root },
			);
		await Promise.all([call(), call()]);
		const events = readFileSync(log, "utf8").trim().split("\n");
		expect(events.map((e) => e.split(" ")[0])).toEqual(["start", "end", "start", "end"]);
		expect(updates).toContain("waiting for another uv run on this project");
	});

	it("does not mistake a plugin's `error:` line for a uv failure", async () => {
		writeFileSync(
			join(root, "conftest.py"),
			"import sys\n\n\ndef pytest_sessionfinish(session):\n    print('error: boom from plugin', file=sys.stderr)\n",
		);
		try {
			const r = await mock.call("py_test", {}, root);
			expect((r.structuredContent as { state: string }).state).toBe("failed");
		} finally {
			rmSync(join(root, "conftest.py"));
		}
	});

	it("names a tool missing from the environment", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-dev-tools-notool-"));
		writeFileSync(
			join(dir, "pyproject.toml"),
			'[project]\nname = "nt"\nversion = "0"\nrequires-python = ">=3.12"\ndependencies = []\n',
		);
		execFileSync("uv", ["lock", "-q"], { cwd: dir });
		const r = await mock.call("py_test", {}, dir);
		expect(r.isError).toBe(true);
		expect(mock.text(r)).toMatch(/uv: Failed to spawn.*dev dependencies/);
	});
});
