/**
 * Real-parser tests for the import audit helper: every case goes through `tsgo`. The one exception
 * forces a project lookup miss on a real snapshot, which a real session never produces.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { API } from "typescript/unstable/async";
import { test, vi } from "vitest";
import { type AuditResult, auditFiles, dispatch, main } from "./import_audit.ts";

/** Write `sources` under `<root>/pkg/` and audit them in one batch. */
async function audit(sources: Record<string, string>): Promise<AuditResult> {
	const root = mkdtempSync(join(tmpdir(), "import-audit-"));
	try {
		for (const [name, text] of Object.entries(sources)) {
			const path = join(root, "pkg", name);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, text);
		}
		return await auditFiles(
			root,
			Object.keys(sources).map((name) => `pkg/${name}`),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** Run `main` in process against recording writers. */
async function runMain(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	const status = await main(args, { write: (text) => (stdout += text) }, { write: (text) => (stderr += text) });
	return { status, stdout, stderr };
}

async function one(source: string, name = "a.ts"): Promise<{ specifiers: string[]; diagnostics: string[] }> {
	const found = (await audit({ [name]: source })).files[`pkg/${name}`];
	assert.ok(found, "file missing from the audit result");
	return found;
}

test("real Node imports do not dispatch either CLI", () => {
	for (const name of ["import_audit.ts", "run-vitest.ts"]) {
		const script = join(dirname(fileURLToPath(import.meta.url)), name);
		const run = spawnSync(process.execPath, ["--input-type=module", "-e", "await import(process.argv[1])", script], {
			encoding: "utf8",
		});
		assert.equal(run.status, 0);
		assert.equal(run.stdout, "");
		assert.equal(run.stderr, "");
	}
});

test("entry dispatch runs the CLI only for the entry module", async () => {
	const argv = process.argv;
	const exitCode = process.exitCode;
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	try {
		process.argv = ["node", "import_audit.ts"];
		process.exitCode = 0;
		await dispatch(false);
		assert.equal(process.exitCode, 0);
		assert.equal(stderr.mock.calls.length, 0);
		await dispatch(true);
		assert.equal(process.exitCode, 2);
		assert.match(String(stderr.mock.calls[0]?.[0]), /usage: node import_audit/);
	} finally {
		process.argv = argv;
		process.exitCode = exitCode ?? 0;
		stderr.mockRestore();
	}
});

test("static imports, re-exports, type imports and import-equals are collected in order", async () => {
	const found = await one(
		[
			'import a from "a";',
			'import type { T } from "b";',
			'import "side-effect";',
			'import { x } from "./x.ts";',
			'export * from "c";',
			'export { y } from "d";',
			'export * as ns from "e";',
			'import fs = require("f");',
			'type U = import("g").U;',
			'const v = require("h");',
			'const w = await import("i");',
			"const z = await import(`j`);",
		].join("\n"),
	);
	assert.deepEqual(found.specifiers, ["a", "b", "side-effect", "./x.ts", "c", "d", "e", "f", "g", "h", "i", "j"]);
	assert.deepEqual(found.diagnostics, []);
});

test("import text in comments and string literals is not an import", async () => {
	const found = await one(
		[
			'// import x from "@nredd/pi-session-kit";',
			'/* const m = require("@nredd/pi-session-kit"); */',
			"const s = 'import(\"@nredd/pi-session-kit\")';",
			"const t = `require('@nredd/pi-session-kit')`;",
			'import { real } from "node:fs";',
		].join("\n"),
	);
	assert.deepEqual(found.specifiers, ["node:fs"]);
	assert.deepEqual(found.diagnostics, []);
});

test("valid local node-host imports in .mjs sources", async () => {
	const found = await one(
		'import { readFileSync } from "node:fs";\nimport { helper } from "./helper.mjs";\nexport { helper };\n',
		"cli.mjs",
	);
	assert.deepEqual(found.specifiers, ["node:fs", "./helper.mjs"]);
	assert.deepEqual(found.diagnostics, []);
});

test("a no-substitution template specifier is a literal and is classified", async () => {
	const found = await one("const m = import(`@nredd/pi-session-kit`);\nconst r = require(`left-pad`);");
	assert.deepEqual(found.specifiers, ["@nredd/pi-session-kit", "left-pad"]);
	assert.deepEqual(found.diagnostics, []);
});

test("template with substitutions, sibling templates and computed paths are rejected with locations", async () => {
	const found = await one(
		[
			"const a = import(`@nredd/\u0024{name}`);",
			'const b = import("./" + name);',
			"const c = require(name);",
			"const d = require();",
			'const e = import(cond ? "x" : "y");',
			"type F = import(`@nredd/\u0024{name}`).T;",
		].join("\n"),
	);
	assert.deepEqual(found.specifiers, []);
	assert.equal(found.diagnostics.length, 6);
	assert.match(
		found.diagnostics[0] ?? "",
		/^pkg\/a\.ts:1:11: dynamic `import\(\)` specifier is not a string literal: /,
	);
	assert.match(found.diagnostics[1] ?? "", /^pkg\/a\.ts:2:11: .*`"\.\/" \+ name`$/);
	assert.match(found.diagnostics[2] ?? "", /^pkg\/a\.ts:3:11: `require\(\)` specifier .*`name`$/);
	assert.match(found.diagnostics[3] ?? "", /^pkg\/a\.ts:4:11: .*`<missing>`$/);
	assert.match(found.diagnostics[4] ?? "", /^pkg\/a\.ts:5:11: /);
	assert.match(found.diagnostics[5] ?? "", /^pkg\/a\.ts:6:10: `import\(\)` type specifier /);
});

test("a long computed specifier is shown truncated to its first 80 characters", async () => {
	const computed = `"./" + ${"segment + ".repeat(10)}name`;
	const found = await one(`const a = import(${computed});`);
	assert.deepEqual(found.specifiers, []);
	assert.deepEqual(found.diagnostics, [
		`pkg/a.ts:1:11: dynamic \`import()\` specifier is not a string literal: \`${computed.slice(0, 80)}...\``,
	]);
});

test("parenthesized literal specifiers are unwrapped and classified", async () => {
	const found = await one(
		['const a = import(("a"));', 'const b = require((("b")));', "const c = import((`c`));"].join("\n"),
	);
	assert.deepEqual(found.specifiers, ["a", "b", "c"]);
	assert.deepEqual(found.diagnostics, []);
});

test("nested imports inside functions and classes are found", async () => {
	const found = await one('export async function f() {\n\tclass A { async m() { return import("deep"); } }\n}\n');
	assert.deepEqual(found.specifiers, ["deep"]);
});

test("ordinary calls, member requires and require look-alikes are not imports", async () => {
	const found = await one(['foo("a");', 'obj.require("b");', 'requireX("c");', 'new Function("d")();'].join("\n"));
	assert.deepEqual(found, { specifiers: [], diagnostics: [] });
});

test("a file that does not parse is reported, not trusted", async () => {
	const found = await one('import x from "ok";\nconst = ;\n');
	assert.deepEqual(found.specifiers, ["ok"]);
	assert.ok(found.diagnostics.length > 0);
	for (const diagnostic of found.diagnostics) assert.match(diagnostic, /^pkg\/a\.ts:2:\d+: syntax error: /);
});

test("the CLI batches several files and prints one JSON document", async () => {
	const root = mkdtempSync(join(tmpdir(), "import-audit-cli-"));
	try {
		mkdirSync(join(root, "pkg"));
		writeFileSync(join(root, "pkg", "a.ts"), 'import "a";');
		writeFileSync(join(root, "pkg", "b.mjs"), 'import("b");');
		const script = join(dirname(fileURLToPath(import.meta.url)), "import_audit.ts");
		const out = execFileSync(process.execPath, [script, root, "pkg/a.ts", "pkg/b.mjs"], { encoding: "utf8" });
		assert.deepEqual(JSON.parse(out), {
			files: {
				"pkg/a.ts": { specifiers: ["a"], diagnostics: [] },
				"pkg/b.mjs": { specifiers: ["b"], diagnostics: [] },
			},
		});
		assert.deepEqual(await runMain([root, "pkg/a.ts", "pkg/b.mjs"]), { status: 0, stdout: out, stderr: "" });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a listed file tsgo cannot load fails the whole audit instead of passing it empty", async () => {
	const root = mkdtempSync(join(tmpdir(), "import-audit-missing-"));
	try {
		await assert.rejects(auditFiles(root, ["pkg/missing.ts"]), /^Error: tsgo did not load 'pkg\/missing\.ts'$/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a project tsgo did not open fails the audit and still closes the session", async () => {
	const root = mkdtempSync(join(tmpdir(), "import-audit-project-"));
	const original = API.prototype.updateSnapshot;
	const snapshots = vi.spyOn(API.prototype, "updateSnapshot").mockImplementation(async function (
		this: API,
		...args: Parameters<API["updateSnapshot"]>
	) {
		const snapshot = await original.apply(this, args);
		vi.spyOn(snapshot, "getProject").mockImplementation(() => undefined);
		return snapshot;
	});
	const closes = vi.spyOn(API.prototype, "close");
	try {
		mkdirSync(join(root, "pkg"));
		writeFileSync(join(root, "pkg", "a.ts"), 'import "a";');
		await assert.rejects(auditFiles(root, ["pkg/a.ts"]), /^Error: tsgo did not open the project '.*tsconfig\.json'$/);
		assert.equal(snapshots.mock.calls.length, 1);
		assert.equal(closes.mock.calls.length, 1);
	} finally {
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	}
});

test("the CLI rejects a missing ROOT or FILE with usage and exit 2", async () => {
	const script = join(dirname(fileURLToPath(import.meta.url)), "import_audit.ts");
	for (const args of [[], ["root-only"]]) {
		const run = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
		assert.equal(run.status, 2);
		assert.equal(run.stdout, "");
		assert.equal(run.stderr, "usage: node import_audit.ts ROOT FILE...\n");
		assert.deepEqual(await runMain(args), { status: run.status, stdout: run.stdout, stderr: run.stderr });
	}
});
