/**
 * Real-parser tests for the vacuous `toMatchObject` guard (#1299): every scan goes through `tsgo`.
 * The premise test pins the Vitest behavior the guard exists for, on both engines.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { API } from "typescript/unstable/async";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { makeTestTempDir } from "../../tests/lib/src/temp-dir.ts";
import { checkFiles, checkTestMatchers, dispatch } from "../check-test-matchers.ts";

/** Every parse-only project directory `checkFiles` writes a config into, and an optional failure for that write. */
const projects = vi.hoisted(() => ({ made: [] as string[], writeError: undefined as Error | undefined }));

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
			const path = String(args[0]);
			if (basename(path) === "tsconfig.json" && basename(dirname(path)).startsWith("pi-test-matchers-")) {
				projects.made.push(dirname(path));
				if (projects.writeError) throw projects.writeError;
			}
			fs.writeFileSync(...args);
		},
	};
});

afterEach(() => {
	projects.made.length = 0;
	projects.writeError = undefined;
	vi.restoreAllMocks();
});

/** The one parse-only project directory the last `checkFiles` call wrote its config into. */
function onlyProject(): string {
	expect(projects.made).toHaveLength(1);
	return projects.made[0] as string;
}

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

/** A regex the guard cannot see through: it does not follow helper calls. */
function regex(): RegExp {
	return /x/;
}

test("premise: Vitest toMatchObject ignores a RegExp value, stringMatching and toEqual do not", () => {
	// Reached through a call, which the syntactic guard does not follow, so this file passes its own guard.
	const bare = regex();
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
		'expect(a)["toMatchObject"]({ n: /n/ });',
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
		"a.test.ts:7:33: bare /n/ in toMatchObject",
		"a.test.ts:10:12: bare /m/ in toMatchObject",
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
		"expect(a)[toMatchObject]({ message: /j/ });",
		'expect(a)["toEqual"]({ message: /j/ });',
		"expect(a).toMatchObject({ ...(/n/), ...(flag ? /o/ : /q/), ...(/p/ as object) });",
		"toMatchObject({ message: /k/ });",
		"await assert.rejects(run, { code: 'x', message: /l/ });",
		"const regex = { message: /m/ };",
	].join("\n");
	expect(await scan(source)).toEqual([]);
});

test("follows a uniquely bound local const in the same or an enclosing scope (#1302)", async () => {
	const source = [
		"const re = /a/;",
		"expect(x).toMatchObject({ message: re });",
		"const expected = { message: /b/ } as const;",
		"expect(x).toMatchObject(expected);",
		"const message = /c/;",
		"expect(x).toMatchObject({ message });",
		"const inner = /d/, outer = { list: [inner] };",
		"test('t', () => {",
		"\texpect(x).toMatchObject(outer);",
		"\t{ const local = { m: /e/ }; expect(x).toMatchObject({ ...local }); }",
		"});",
	].join("\n");
	expect(await scan(source)).toEqual([
		"a.test.ts:1:12: bare /a/ in toMatchObject via `re` at 2:36",
		"a.test.ts:3:29: bare /b/ in toMatchObject via `expected` at 4:25",
		"a.test.ts:5:17: bare /c/ in toMatchObject via `message` at 6:27",
		"a.test.ts:7:15: bare /d/ in toMatchObject via `outer` at 9:26",
		"a.test.ts:10:23: bare /e/ in toMatchObject via `local` at 10:59",
	]);
});

test("leaves a name alone unless one const binding in scope holds it (#1302)", async () => {
	const source = [
		"let mutable = /a/;",
		"var hoisted = /b/;",
		"using disposable = /c/;",
		"const shadowed = /d/;",
		"function f(shadowed) { expect(x).toMatchObject({ m: shadowed }); }",
		"const blocked = /e/;",
		"{ const blocked = 'e'; expect(x).toMatchObject({ m: blocked }); }",
		"{ const hidden = /f/; }",
		"const { picked } = { picked: /g/ };",
		"const loop = { m: loop }, ping = pong, pong = ping;",
		"const spread = /h/;",
		"namespace N { export const own = /i/; expect(x).toMatchObject({ m: own }); }",
		"declare const ambient: RegExp;",
		"expect(x).toMatchObject({ m: early });",
		"{ const early = /j/; }",
		"for (const looped = /k/; ; ) { expect(x).toMatchObject({ m: looped }); break; }",
		"for (const each of [/l/]) expect(x).toMatchObject({ m: each });",
		"expect(x).toMatchObject({ mutable, hoisted, disposable, hidden, picked, ambient, imported, global });",
		"expect(x).toMatchObject({ loop, ping, ...spread });",
		'import { imported } from "./other";',
	].join("\n");
	expect(await scan(source)).toEqual([]);
});

test("resolves a name reused across scopes to its nearest const (#1315)", async () => {
	const source = [
		'test("a", () => { const expected = { message: /x/ }; expect(a).toMatchObject(expected); });',
		'test("b", () => { const expected = { message: "y" }; expect(b).toMatchObject(expected); });',
		'test("c", () => { const expected = { message: /z/ }; expect(c).toMatchObject(expected); });',
		"const outer = /o/;",
		"{ const outer = 'ok'; }",
		"expect(x).toMatchObject({ m: outer });",
		'test("d", () => { const outer = { m: "ok" }; expect(x).toMatchObject(outer); });',
		"const re = /p/;",
		"{ list.map((re) => expect(x).toMatchObject({ m: re })); expect(y).toMatchObject({ m: re }); }",
		"switch (k) { case 1: const cased = /c/; default: expect(x).toMatchObject({ m: cased }); }",
		"switch (k) { default: const fallback = /f/; expect(x).toMatchObject({ m: fallback }); }",
		"with ({}) { const inside = /w/; expect(x).toMatchObject({ m: inside }); }",
	].join("\n");
	expect(await scan(source)).toEqual([
		"a.test.ts:1:47: bare /x/ in toMatchObject via `expected` at 1:78",
		"a.test.ts:3:47: bare /z/ in toMatchObject via `expected` at 3:78",
		"a.test.ts:4:15: bare /o/ in toMatchObject via `outer` at 6:30",
		"a.test.ts:8:12: bare /p/ in toMatchObject via `re` at 9:86",
		"a.test.ts:10:36: bare /c/ in toMatchObject via `cased` at 10:79",
		"a.test.ts:11:40: bare /f/ in toMatchObject via `fallback` at 11:74",
		"a.test.ts:12:28: bare /w/ in toMatchObject via `inside` at 12:62",
	]);
});

test("does not follow a const past a nearer binding of the name it does not model (#1315)", async () => {
	// One file per case: a binding the resolver over-approximates to the whole file would mask the others.
	const cases = [
		"function hoisted() { { var expected = 'ok'; } expect(x).toMatchObject({ m: expected }); }",
		"function annexB() { { function expected() {} } expect(x).toMatchObject({ m: expected }); }",
		"const named = function expected() { expect(x).toMatchObject({ m: expected }); };",
		"const klass = class expected { m() { expect(x).toMatchObject({ m: expected }); } };",
		"try {} catch (expected) { expect(x).toMatchObject({ m: expected }); }",
		"for (const expected of []) expect(x).toMatchObject({ m: expected });",
		"(function ({ expected }) { expect(x).toMatchObject({ m: expected }); });",
		"class C { static { var expected = 'ok'; expect(x).toMatchObject({ m: expected }); } }",
		"enum E { expected = 1, other = expect(x).toMatchObject({ m: expected }) }",
		"namespace N { export const expected = 'ok'; }\nnamespace N { expect(x).toMatchObject({ m: expected }); }",
		"{ let expected = 'ok'; expect(x).toMatchObject({ m: expected }); }",
		"{ { const expected = 'ok'; } with (o) { expect(x).toMatchObject({ m: expected }); } }",
		"{ const expected = /d/; const expected = 'ok'; expect(x).toMatchObject({ m: expected }); }",
		"function g() { for (var expected of []) {} expect(x).toMatchObject({ m: expected }); }",
		"function g() { { var { expected } = { expected: 'ok' }; } expect(x).toMatchObject({ m: expected }); }",
		"namespace N { export const { expected } = { expected: 'ok' }; }\nnamespace N { expect(x).toMatchObject({ m: expected }); }",
		"declare namespace N { const expected = 'ok'; }\nnamespace N { expect(x).toMatchObject({ m: expected }); }",
		"declare namespace N { const expected = { m: /x/ }; const used = expect(x).toMatchObject(expected); }",
		"namespace N { const expected = 'ok'; expect(x).toMatchObject({ m: expected }); }",
		"export {};\n{ function expected() {} expect(x).toMatchObject({ m: expected }); }",
		"{ class expected {} expect(x).toMatchObject({ m: expected }); }",
		"{ enum expected { A } expect(x).toMatchObject({ m: expected }); }",
		"namespace O { namespace expected {} expect(x).toMatchObject({ m: expected }); }",
		"enum E { expected = 1 }\nenum E { other = expect(x).toMatchObject({ m: expected }) }",
		"namespace N { export enum E { expected = 1 } }\nnamespace N { export enum E { other = expect(x).toMatchObject({ m: expected }) } }",
		"namespace N { export class expected {} }\nnamespace N { expect(x).toMatchObject({ m: expected }); }",
		"declare namespace N { class expected {} }\nnamespace N { expect(x).toMatchObject({ m: expected }); }",
	];
	const control = "{ { const expected = 'ok'; } expect(x).toMatchObject({ m: expected }); }";
	const found = [];
	for (const body of [control, ...cases]) found.push(...(await scan(`const expected = /a/;\n${body}`)));
	expect(found).toEqual(["a.test.ts:1:18: bare /a/ in toMatchObject via `expected` at 2:59"]);
});

test("follows a local namespace-block const and scopes catch, for header and destructured bindings exactly (#1334)", async () => {
	const source = [
		"namespace N { const spaced = /i/; expect(x).toMatchObject({ m: spaced }); }",
		"namespace O.P { const deep = /q/; expect(x).toMatchObject({ m: deep }); }",
		"const caught = /c/;",
		"try {} catch (caught) {} try {} catch ({ caught }) {}",
		"const header = /h/;",
		"for (let header = 0; ; ) break; for (const header in {}); for (const { header } of []); for (using header of []);",
		"const picked = /p/;",
		"{ const { picked } = { picked: 'ok' }; } switch (k) { case 1: let [picked] = []; } namespace Q { const { picked } = {}; }",
		"for (const body of [1]) { const body = /b/; expect(x).toMatchObject({ m: body }); }",
		"expect(x).toMatchObject({ m: caught, header, picked });",
	].join("\n");
	expect(await scan(source)).toEqual([
		"a.test.ts:1:30: bare /i/ in toMatchObject via `spaced` at 1:64",
		"a.test.ts:2:30: bare /q/ in toMatchObject via `deep` at 2:64",
		"a.test.ts:9:40: bare /b/ in toMatchObject via `body` at 9:74",
		"a.test.ts:3:16: bare /c/ in toMatchObject via `caught` at 10:30",
		"a.test.ts:5:16: bare /h/ in toMatchObject via `header` at 10:38",
		"a.test.ts:7:16: bare /p/ in toMatchObject via `picked` at 10:46",
	]);
});

test("scopes class, enum, namespace, expression and module function names to their statement (#1334)", async () => {
	const source = [
		"export {};",
		"const klass = /k/, kenum = /e/, member = /m/, space = /s/, named = /n/, block = /b/;",
		"{ class klass {} enum kenum { A } enum E { member } function block() {} }",
		"switch (k) { case 1: function block() {} } namespace Outer { namespace space {} class klass {} }",
		"const fn = function named() {}, cls = class named {};",
		"expect(x).toMatchObject({ klass, kenum, member, space, named, block });",
	].join("\n");
	expect(await scan(source)).toEqual([
		"a.test.ts:2:15: bare /k/ in toMatchObject via `klass` at 6:27",
		"a.test.ts:2:28: bare /e/ in toMatchObject via `kenum` at 6:34",
		"a.test.ts:2:42: bare /m/ in toMatchObject via `member` at 6:41",
		"a.test.ts:2:55: bare /s/ in toMatchObject via `space` at 6:49",
		"a.test.ts:2:68: bare /n/ in toMatchObject via `named` at 6:56",
		"a.test.ts:2:81: bare /b/ in toMatchObject via `block` at 6:63",
	]);
	// CommonJS is sloppy even where `tsgo` calls it a module, so a block function there may be hoisted.
	const sloppy =
		"const expected = /a/;\nfunction g() { { function expected() {} } expect(x).toMatchObject({ m: expected }); }";
	expect(await scan(sloppy, "a.test.cjs")).toEqual([]);
	expect(await scan(`export {};\n${sloppy}`, "a.test.cts")).toEqual([]);
	expect(await scan(sloppy, "a.test.mts")).toEqual([
		"a.test.mts:1:18: bare /a/ in toMatchObject via `expected` at 2:72",
	]);
});

test("vetoes a const only for writes inside its scope (#1334)", async () => {
	const source = [
		'test("a", () => { const expected = { m: /x/ }; expect(a).toMatchObject(expected); });',
		'test("b", () => { const expected = { m: /y/ }; expected.m = "ok"; expect(b).toMatchObject(expected); });',
		"const outer = { m: /o/ };",
		"function f(outer) { outer.m = 'ok'; }",
		"const looped = { m: /l/ }; for (looped.m of ['ok']); for (const each in looped);",
		"const each = { m: /e/ }, keyed = { m: /k/ }; for (keyed.k in { a: 1 });",
		"expect(x).toMatchObject({ outer, looped, each, keyed });",
		// The pattern records the later `expected.z` before the walk reaches the earlier write inside the arrow.
		"[x[(() => { const expected = { m: /w/ }; expected.m = 'ok'; expect(a).toMatchObject(expected); })()], expected.z] = [];",
	].join("\n");
	// `outer` stays vetoed: the write inside its scope hits a parameter, but resolving writes would add machinery.
	expect(await scan(source)).toEqual([
		"a.test.ts:1:41: bare /x/ in toMatchObject via `expected` at 1:72",
		"a.test.ts:6:19: bare /e/ in toMatchObject via `each` at 7:42",
	]);
	// A write at position 0 starts exactly where the file scope does.
	expect(await scan("expected.m = 'ok'; const expected = { m: /s/ }; expect(x).toMatchObject(expected);")).toEqual([]);
});

test("skips arguments across a function and the object of a with statement (#1315)", async () => {
	// A sloppy script may declare `arguments`, but the matcher gets the function's implicit arguments object.
	const sloppy = [
		"{ const arguments = /x/; (function () { expect(x).toMatchObject({ m: arguments }); })('ok'); }",
		"{ const arguments = 'unused'; }",
	].join("\n");
	expect(await scan(sloppy, "a.test.cjs")).toEqual([]);
	// The object is evaluated before it can shadow anything; skipping it anyway can only cause a miss.
	expect(await scan("const re = /x/; with (expect(a).toMatchObject({ m: re })) {}", "a.test.cjs")).toEqual([]);
});

test("resolves many sibling tests reusing one name without rescanning every declaration (#1315)", async () => {
	const lines = [];
	for (let index = 0; index < 400; index++) {
		const value = index % 2 === 0 ? "/r/" : "'ok'";
		lines.push(`test("${index}", () => { const expected = { m: ${value} }; expect(a).toMatchObject(expected); });`);
	}
	const found = await scan(lines.join("\n"));
	expect(found).toHaveLength(200);
	expect(found[0]).toBe("a.test.ts:1:41: bare /r/ in toMatchObject via `expected` at 1:72");
	expect(found[199]).toBe("a.test.ts:399:43: bare /r/ in toMatchObject via `expected` at 399:74");
});

test("vetoes per scope across many sibling tests that each write their own name (#1334)", async () => {
	// Pins behavior, not complexity: the per-use write lookup is a binary search, a linear scan gives the same findings.
	const lines = [];
	for (let index = 0; index < 400; index++) {
		const write = index % 2 === 0 ? " expected.n = 1;" : "";
		lines.push(`test("${index}", () => { const expected = { m: /r/ };${write} expect(a).toMatchObject(expected); });`);
	}
	const found = await scan(lines.join("\n"));
	expect(found).toHaveLength(200);
	expect(found[0]).toBe("a.test.ts:2:41: bare /r/ in toMatchObject via `expected` at 2:72");
	expect(found[199]).toBe("a.test.ts:400:43: bare /r/ in toMatchObject via `expected` at 400:74");
});

/** `const a0 = /x/` and `depth` levels of `const aN = [aN-1, aN-1]`, matched on the last: 2^depth paths, one regex. */
function doubling(depth: number): string {
	const lines = ["const a0 = /x/;"];
	for (let level = 1; level <= depth; level++) lines.push(`const a${level} = [a${level - 1}, a${level - 1}];`);
	lines.push(`expect(x).toMatchObject(a${depth});`);
	return lines.join("\n");
}

test("walks each shared initializer once per matcher call and stored mode (#1302)", async () => {
	// The shallow chain fails fast (8 copies) if initializers are rewalked; the deep one would never finish.
	expect(await scan(doubling(3))).toEqual(["a.test.ts:1:12: bare /x/ in toMatchObject via `a3` at 5:25"]);
	expect(await scan(doubling(40))).toEqual(["a.test.ts:1:12: bare /x/ in toMatchObject via `a40` at 42:25"]);
	const source = [
		"const re = /y/;",
		"expect(x).toMatchObject({ ...re, m: re, n: re });",
		"expect(x).toMatchObject([re]);",
	].join("\n");
	expect(await scan(source)).toEqual([
		"a.test.ts:1:12: bare /y/ in toMatchObject via `re` at 2:37",
		"a.test.ts:1:12: bare /y/ in toMatchObject via `re` at 3:26",
	]);
});

test("does not follow a const the file writes into, or a name used inside a with body (#1302)", async () => {
	const source = [
		"const assigned = { m: /a/ }; assigned.m = 'ok';",
		"const element = [/b/]; element[0] = 'ok';",
		"const compound = { m: /c/ }; compound.n += 1;",
		"const merged = { m: /d/ }; Object.assign(merged, { m: 'ok' });",
		"const defined = { m: /e/ }; Object.defineProperty((defined satisfies object)!, 'm', { value: 'ok' });",
		"const removed = { m: /f/ }; delete removed.m;",
		"const counted = { m: /g/ }; counted.n++;",
		"const lowered = { m: /h/ }; --(lowered as { n: number }).n;",
		"const pattern = { m: /i/ }; [pattern.m] = ['ok'];",
		"const nested = { m: { n: /j/ } }; nested.m.n = 'ok';",
		"const kept = { m: /k/ }; -kept.n; kept.n + 1; 'n' in kept; Object.keys(kept); Object.assign(); other.m = 1;",
		"with ({ re: 'ok' }) { expect(x).toMatchObject({ m: re }); }",
		"const re = /l/;",
		"expect(x).toMatchObject({ assigned, element, compound, merged, defined, removed, counted, lowered });",
		"expect(x).toMatchObject({ pattern, nested });",
		"expect(x).toMatchObject({ kept, m: re });",
	].join("\n");
	expect(await scan(source)).toEqual([
		"a.test.ts:11:19: bare /k/ in toMatchObject via `kept` at 16:27",
		"a.test.ts:13:12: bare /l/ in toMatchObject via `re` at 16:36",
	]);
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
	expect(await checkFiles("/nonexistent", [])).toEqual([]);
	expect(session).not.toHaveBeenCalled();
	expect(projects.made).toEqual([]);
	const root = fixture({ "a.test.ts": "expect(a).toMatchObject({ m: /a/ });" });
	expect(await checkFiles(root, ["a.test.ts"])).toHaveLength(1);
	expect(readdirSync(root)).toEqual(["a.test.ts"]);
	const project = onlyProject();
	expect(session).toHaveBeenCalledWith({ openProject: join(project, "tsconfig.json") });
	expect(existsSync(project)).toBe(false);
});

test("a failed config write removes the project directory without starting tsgo", async () => {
	const root = fixture({ "a.test.ts": "" });
	const session = vi.spyOn(API.prototype, "updateSnapshot");
	projects.writeError = new Error("disk full");
	await expect(checkFiles(root, ["a.test.ts"])).rejects.toThrow(/^disk full$/);
	expect(session).not.toHaveBeenCalled();
	expect(existsSync(onlyProject())).toBe(false);
});

test("a rejected session close still removes the project directory", async () => {
	const root = fixture({ "a.test.ts": "" });
	const original = API.prototype.close;
	vi.spyOn(API.prototype, "close").mockImplementation(async function (this: API) {
		await original.call(this);
		throw new Error("close failed");
	});
	await expect(checkFiles(root, ["a.test.ts"])).rejects.toThrow(/^close failed$/);
	expect(existsSync(onlyProject())).toBe(false);
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
	await expect(checkFiles(root, ["a.test.ts"])).rejects.toThrow(/^tsgo did not open the project '.*tsconfig\.json'$/);
	expect(closes).toHaveBeenCalledTimes(1);
	expect(existsSync(onlyProject())).toBe(false);
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
