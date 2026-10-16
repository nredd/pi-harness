/** Real-parser tests for the import audit helper: every case goes through `tsgo`, nothing is mocked. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { type AuditResult, auditFiles } from "./import_audit.ts";

/** Write `sources` under `<root>/pkg/` and audit them in one batch. */
function audit(sources: Record<string, string>): AuditResult {
	const root = mkdtempSync(join(tmpdir(), "import-audit-"));
	try {
		for (const [name, text] of Object.entries(sources)) {
			const path = join(root, "pkg", name);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, text);
		}
		return auditFiles(
			root,
			Object.keys(sources).map((name) => `pkg/${name}`),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function one(source: string, name = "a.ts"): { specifiers: string[]; diagnostics: string[] } {
	const found = audit({ [name]: source }).files[`pkg/${name}`];
	assert.ok(found, "file missing from the audit result");
	return found;
}

test("static imports, re-exports, type imports and import-equals are collected in order", () => {
	const found = one(
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

test("import text in comments and string literals is not an import", () => {
	const found = one(
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

test("valid local node-host imports in .mjs sources", () => {
	const found = one(
		'import { readFileSync } from "node:fs";\nimport { helper } from "./helper.mjs";\nexport { helper };\n',
		"cli.mjs",
	);
	assert.deepEqual(found.specifiers, ["node:fs", "./helper.mjs"]);
	assert.deepEqual(found.diagnostics, []);
});

test("a no-substitution template specifier is a literal and is classified", () => {
	const found = one("const m = import(`@nredd/pi-session-kit`);\nconst r = require(`left-pad`);");
	assert.deepEqual(found.specifiers, ["@nredd/pi-session-kit", "left-pad"]);
	assert.deepEqual(found.diagnostics, []);
});

test("template with substitutions, sibling templates and computed paths are rejected with locations", () => {
	const found = one(
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

test("nested imports inside functions and classes are found", () => {
	const found = one('export async function f() {\n\tclass A { async m() { return import("deep"); } }\n}\n');
	assert.deepEqual(found.specifiers, ["deep"]);
});

test("a file that does not parse is reported, not trusted", () => {
	const found = one('import x from "ok";\nconst = ;\n');
	assert.ok(found.diagnostics.some((d) => d.startsWith("pkg/a.ts:") && d.includes("syntax error")));
});

test("the CLI batches several files and prints one JSON document", () => {
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
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
