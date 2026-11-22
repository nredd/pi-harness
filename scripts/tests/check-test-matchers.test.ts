/**
 * Real-parser tests for the vacuous `toMatchObject` guard (#1299): every scan goes through `tsgo`.
 * The premise test pins the Vitest behavior the guard exists for, on both engines.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { API } from "typescript/unstable/async";
import { expect, onTestFinished, test, vi } from "vitest";
import { makeTestTempDir } from "../../tests/lib/src/temp-dir.ts";
import { checkFiles, checkTestMatchers, dispatch } from "../check-test-matchers.ts";

/** Write `sources` under a fresh root and return it. */
function fixture(sources: Record<string, string>): string {
	const root = makeTestTempDir("pi-test-matchers-fixture-", onTestFinished);
	for (const [name, text] of Object.entries(sources)) {
		const path = join(root, name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
	}
	return root;
}

/** Scan one source named `a.test.ts` and return its findings without the shared suffix. */
async function scan(source: string, name = "a.test.ts"): Promise<string[]> {
	const problems = await checkFiles(fixture({ [name]: source }), [name]);
	return problems.map((problem) =>
		problem.replace(/ matches any value; use expect\.stringMatching\(\.\.\.\) or an exact value$/, ""),
	);
}

test("premise: Vitest toMatchObject ignores a RegExp value, stringMatching and toEqual do not", () => {
	// Built at runtime so this file passes its own guard.
	const bare = /x/;
	expect({ message: "zzz" }).toMatchObject({ message: bare });
	expect({ list: [{ message: "zzz" }] }).toMatchObject({ list: [{ message: bare }] });
	expect({ message: /y/ }).toMatchObject({ message: bare });
	expect(() => expect({}).toMatchObject({ message: bare })).toThrow();
	expect(() => expect({ message: "zzz" }).toMatchObject({ message: expect.stringMatching(bare) })).toThrow();
	expect(() => expect({ message: "xxx" }).toEqual({ message: bare })).toThrow();
	expect(() => expect({ message: "xxx" }).toStrictEqual({ message: bare })).toThrow();
	expect(() => expect({ message: "xxx" }).toEqual(expect.objectContaining({ message: bare }))).toThrow();
	expect(() => expect(["xxx"]).toEqual(expect.arrayContaining([bare]))).toThrow();
});

test("flags a bare regex reached through literals in any toMatchObject argument", async () => {
	const source = [
		"expect(a).toMatchObject({ message: /a/ });",
		"expect(a).toMatchObject({ nested: { deep: /b/ }, list: [1, /c/] });",
		"expect(a).toMatchObject([{ m: /d/ }, ...[/e/]]);",
		"expect(a).toMatchObject({ ...{ f: /f/ }, g: (/g/), h: /h/ as unknown, i: /i/ satisfies RegExp });",
		"await expect(p).rejects.toMatchObject({ message: /j/i });",
		"expect(a).toMatchObject(flag ? { k: /k/ } : { l: /l/ });",
		"expect(a).toMatchObject(",
		"\t{",
		"\t\tmessage: /m/,",
		"\t},",
		");",
	].join("\n");
	expect(await scan(source)).toEqual([
		"a.test.ts:1:36: bare /a/ in toMatchObject",
		"a.test.ts:2:43: bare /b/ in toMatchObject",
		"a.test.ts:2:60: bare /c/ in toMatchObject",
		"a.test.ts:3:31: bare /d/ in toMatchObject",
		"a.test.ts:3:42: bare /e/ in toMatchObject",
		"a.test.ts:4:35: bare /f/ in toMatchObject",
		"a.test.ts:4:46: bare /g/ in toMatchObject",
		"a.test.ts:4:55: bare /h/ in toMatchObject",
		"a.test.ts:4:74: bare /i/ in toMatchObject",
		"a.test.ts:5:50: bare /j/i in toMatchObject",
		"a.test.ts:6:37: bare /k/ in toMatchObject",
		"a.test.ts:6:50: bare /l/ in toMatchObject",
		"a.test.ts:9:12: bare /m/ in toMatchObject",
	]);
});

test("allows matchers that really check a regex, and regexes outside toMatchObject", async () => {
	const source = [
		"expect(a).toMatchObject({ message: expect.stringMatching(/a/) });",
		"expect(a).toMatchObject({ m: expect.objectContaining({ n: /b/ }), o: check(/c/) });",
		"expect(a).toMatchObject({ message, method() { return /d/; }, get e() { return /e/; } });",
		"expect(a).toMatchObject(expected);",
		"expect(a).toEqual({ pattern: /f/ });",
		"expect(a).toStrictEqual({ pattern: /g/ });",
		"expect(a).toEqual(expect.objectContaining({ pattern: /h/ }));",
		"expect(a).toMatch(/i/);",
		'expect(a)["toMatchObject"]({ message: /j/ });',
		"toMatchObject({ message: /k/ });",
		"await assert.rejects(run, { code: 'x', message: /l/ });",
		"const regex = { message: /m/ };",
	].join("\n");
	expect(await scan(source)).toEqual([]);
});

test("checks JavaScript sources and reports syntax errors instead of trusting a partial parse", async () => {
	expect(await scan("expect(a).toMatchObject({ message: /a/ });\n", "b.test.mjs")).toEqual([
		"b.test.mjs:1:36: bare /a/ in toMatchObject",
	]);
	const problems = await scan("expect(a).toMatchObject({ message: ");
	expect(problems.length).toBeGreaterThan(0);
	for (const problem of problems) expect(problem).toMatch(/^a\.test\.ts:1:\d+: syntax error: /);
});

test("an empty file list skips tsgo, and the parse-only project never lands in the checkout", async () => {
	const session = vi.spyOn(API.prototype, "updateSnapshot");
	try {
		expect(await checkFiles("/nonexistent", [])).toEqual([]);
		expect(session).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
	}
	const root = fixture({ "a.test.ts": "expect(a).toMatchObject({ m: /a/ });" });
	expect(await checkFiles(root, ["a.test.ts"])).toHaveLength(1);
	expect(readdirSync(root)).toEqual(["a.test.ts"]);
	expect(
		readdirSync(tmpdir()).filter((name) => name.startsWith("pi-test-matchers-") && !name.includes("fixture")),
	).toEqual([]);
});

test("a listed file tsgo cannot load fails the check instead of passing it empty", async () => {
	const root = makeTestTempDir("pi-test-matchers-missing-", onTestFinished);
	await expect(checkFiles(root, ["missing.test.ts"])).rejects.toThrow(/^tsgo did not load 'missing\.test\.ts'$/);
});

test("a project tsgo did not open fails the check and still closes the session", async () => {
	const root = fixture({ "a.test.ts": "" });
	const original = API.prototype.updateSnapshot;
	vi.spyOn(API.prototype, "updateSnapshot").mockImplementation(async function (
		this: API,
		...args: Parameters<API["updateSnapshot"]>
	) {
		const snapshot = await original.apply(this, args);
		vi.spyOn(snapshot, "getProject").mockImplementation(() => undefined);
		return snapshot;
	});
	const closes = vi.spyOn(API.prototype, "close");
	try {
		await expect(checkFiles(root, ["a.test.ts"])).rejects.toThrow(/^tsgo did not open the project '.*tsconfig\.json'$/);
		expect(closes).toHaveBeenCalledTimes(1);
	} finally {
		vi.restoreAllMocks();
	}
});

test("scans owned tracked and untracked test sources only", async () => {
	const bad = "expect(a).toMatchObject({ m: /a/ });\n";
	const root = fixture({
		"packages/x/tests/tracked.test.ts": bad,
		"packages/x/test/helper.mjs": bad,
		"scripts/tool.test.ts": bad,
		"packages/x/src/runtime.ts": bad,
		"forks/pi/tests/fork.test.ts": bad,
		"tests/notes.txt": bad,
	});
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
	git("init", "-q");
	git("add", "packages/x/tests/tracked.test.ts");
	const found = (await checkTestMatchers(root)).map((problem) => problem.split(":")[0]).sort();
	expect(found).toEqual(["packages/x/test/helper.mjs", "packages/x/tests/tracked.test.ts", "scripts/tool.test.ts"]);
});

test("sets the CLI exit status from the findings", async () => {
	const previous = process.exitCode;
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		const check = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(["a.test.ts:1:1: finding"]);
		await dispatch(false, check);
		await dispatch(false); // Exercise the default scanner binding without scanning the outer checkout.
		expect(check).not.toHaveBeenCalled();
		await dispatch(true, check);
		expect(check).toHaveBeenLastCalledWith(expect.any(String));
		expect(process.exitCode).toBe(0);
		await dispatch(true, check);
		expect(process.exitCode).toBe(1);
		expect(error).toHaveBeenCalledWith("a.test.ts:1:1: finding");
	} finally {
		process.exitCode = previous;
		error.mockRestore();
	}
});
