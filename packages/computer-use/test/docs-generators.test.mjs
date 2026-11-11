import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { main as sourceMain } from "../scripts/docs-generators/generate-source-references.mjs";
import { main as toolMain, renderToolReference } from "../scripts/docs-generators/generate-tool-reference.mjs";

const generatorDir = new URL("../scripts/docs-generators/", import.meta.url);
const toolsDoc = "docs/content/docs/reference/agent/tools.mdx";

let root;
beforeEach(() => {
	root = mkdtempSync(path.join(os.tmpdir(), "cu-docs-gen-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function put(relative, content) {
	const file = path.join(root, relative);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content);
	return file;
}

function capture() {
	const out = [];
	const err = [];
	return { out, err, deps: { root, log: (line) => out.push(line), error: (line) => err.push(line) } };
}

// ---------------------------------------------------------------- tool reference

const literal = (value) => ({ const: value });
const richTool = {
	name: "rich|tool",
	description: "Does things.",
	promptSnippet: "Snippet.",
	promptGuidelines: ["first", "second"],
	parameters: {
		type: "object",
		required: ["mode", "nested"],
		properties: {
			mode: { anyOf: [literal("a"), literal("b|c")], description: "Pick | one", default: "a" },
			either: { anyOf: [{ type: "string" }, { type: "number" }] },
			fixed: literal(7),
			list: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
			untypedList: { type: "array" },
			bare: {},
			emptyObject: { type: "object" },
			nested: {
				type: "object",
				description: "Nested.",
				properties: { inner: { type: "number", minimum: 0, maximum: 9 } },
			},
		},
	},
};

test("renders types, constraints, nesting and escaping for every schema shape", () => {
	const page = renderToolReference([richTool]);
	const rows = page.split("\n").filter((line) => line.startsWith("| `"));
	assert.deepEqual(rows, [
		"| `mode` | `a` \\| `b\\|c` | yes | Pick \\| one default: `a`. |",
		"| `either` | union | no | — |",
		"| `fixed` | `7` | no | — |",
		"| `list` | array of `string` | no | — minItems: `1`, maxItems: `3`. |",
		"| `untypedList` | array of unknown | no | — |",
		"| `bare` | `unknown` | no | — |",
		"| `emptyObject` | `object` | no | — |",
		"| `nested` | object (inner: `number`) | yes | Nested. |",
		"| `nested.inner` | `number` | no | — minimum: `0`, maximum: `9`. |",
	]);
	assert.match(page, /^## `rich\\\|tool`\n\nDoes things\.\n\n### agent guidance\n\nSnippet\.\n\n- first\n- second\n\n### parameters/m);
	assert.ok(page.startsWith("---\ntitle: 'Tool schema reference'"));
	assert.ok(page.endsWith("</details>\n"));
});

test("omits guidance when absent and tolerates missing parameters", () => {
	const page = renderToolReference([
		{ name: "plain", description: "d" },
		{ name: "snippet-only", description: "d", promptSnippet: "S", promptGuidelines: [] },
		{ name: "guidelines-only", description: "d", promptGuidelines: ["g"] },
	]);
	const sections = page.split("\n## ").slice(1);
	assert.ok(!sections[0].includes("agent guidance"));
	assert.match(sections[1], /### agent guidance\n\nS\n\n### parameters/);
	assert.match(sections[2], /### agent guidance\n\n- g\n\n### parameters/);
});

test("renders action variants as a table", () => {
	const page = renderToolReference([
		{
			name: "batch",
			description: "d",
			parameters: {
				type: "object",
				properties: {
					actions: {
						type: "array",
						items: {
							anyOf: [
								{ type: "object", required: ["x"], properties: { action: literal("click"), x: { type: "number", minimum: 1 }, y: { type: "number" } } },
								{ type: "object", properties: { action: literal("wait") } },
								{ type: "object", properties: {} },
								{ type: "object" },
							],
						},
					},
				},
			},
		},
		{ name: "noitems", description: "d", parameters: { type: "object", properties: { actions: { type: "array" } } } },
		{ name: "noanyof", description: "d", parameters: { type: "object", properties: { actions: { type: "array", items: { type: "string" } } } } },
	]);
	assert.match(page, /#### action variants\n\n\| action \| fields \|\n\| --- \| --- \|\n/);
	assert.match(page, /\| `click` \| `x`: `number` \(required\) minimum: `1`\.; `y`: `number` \(optional\) \|/);
	assert.match(page, /\| `wait` \| — \|/);
	assert.equal(page.match(/\| `unknown` \| — \|/g).length, 2, "variants without properties render as unknown");
	assert.equal(page.split("#### action variants").length, 2, "only the batch tool has variants");
});

test("generate writes the page, then --check passes, then drift fails", () => {
	const generated = capture();
	const tools = [{ name: "t", description: "d" }];
	mkdirSync(path.join(root, path.dirname(toolsDoc)), { recursive: true });
	assert.equal(toolMain([], { ...generated.deps, tools }), 0);
	assert.deepEqual(generated.out, [`Generated 1 tool references at ${toolsDoc}.`]);
	const file = path.join(root, toolsDoc);
	assert.equal(readFileSync(file, "utf8"), renderToolReference(tools));

	const clean = capture();
	assert.equal(toolMain(["--check"], { ...clean.deps, tools }), 0);
	assert.deepEqual(clean.out, ["Generated tool reference is up to date."]);

	writeFileSync(file, "stale\n");
	const drift = capture();
	assert.equal(toolMain(["--check"], { ...drift.deps, tools }), 1);
	assert.deepEqual(drift.err, ["Generated tool reference is out of date. Run `npm run docs:generate`."]);
	assert.equal(readFileSync(file, "utf8"), "stale\n", "--check never writes");

	rmSync(file);
	assert.equal(toolMain(["--check"], { ...capture().deps, tools }), 1, "a missing page is drift");
});

test("the committed tool reference matches the declared tools", () => {
	const real = capture();
	assert.equal(toolMain(["--check"], { log: real.deps.log, error: real.deps.error }), 0, real.err.join("\n"));
});

test("tool reference defaults to console and the package root", () => {
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	try {
		assert.equal(toolMain(["--check"]), 0);
		assert.deepEqual(log.mock.calls, [["Generated tool reference is up to date."]]);
	} finally {
		log.mockRestore();
	}
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		assert.equal(toolMain(["--check"], { root, tools: [] }), 1);
		assert.equal(error.mock.calls.length, 1);
	} finally {
		error.mockRestore();
	}
});

// ---------------------------------------------------------------- source references

const SOURCE_DIRS = [
	"extensions",
	"src",
	"src/platform/macos",
	"src/platform/windows",
	"src/platform/linux",
	"native/macos",
	"native/windows/bridge-rs/src",
	"native/linux/bridge-rs/src",
	"scripts/docs-generators",
];

const configSource = (extra = "") =>
	[
		"// PI_DOCS_REFERENCE_BEGIN reference/configuration",
		"Browser {{config-default:browser_use}}, managed {{config-default:managed_browser}}, headless {{config-default:headless}},",
		"cursor {{config-default:cursor_overlay}}, glow {{config-default:activity_glow}}. cite-me",
		"PI_DOCS_REFERENCE_END",
		'const DEFAULT_CONFIG: Cfg = { browser_use: true, managed_browser: false, headless: "auto", cursor_overlay: true, activity_glow: false };',
		extra,
	].join("\n");

const plainSource = "// PI_DOCS_REFERENCE_BEGIN reference/plain\nPlain body about SYMBOL.\nPI_DOCS_REFERENCE_END\n";

function baseConfig() {
	return {
		schemaVersion: 1,
		repositoryUrl: "https://example.test/blob/main/",
		pages: [
			{
				key: "reference/configuration",
				sourcePath: "src/config.ts",
				outputPath: "docs/content/docs/reference/configuration.mdx",
				title: "Config's page",
				description: "It's configuration.",
				requiredSymbols: ["DEFAULT_CONFIG"],
				requiredCitations: ["cite-me"],
			},
			{
				key: "reference/plain",
				sourcePath: "src/plain.ts",
				outputPath: "docs/content/docs/reference/plain.mdx",
				title: "Plain",
				description: "Plain page.",
				requiredSymbols: ["SYMBOL"],
			},
		],
	};
}

function fixture({ config = baseConfig(), files = {} } = {}) {
	for (const dir of SOURCE_DIRS) put(`${dir}/keep.txt`, "x");
	put("extensions/subdir/nested.txt", "ignored: directories are not listed");
	put("package.json", JSON.stringify({ scripts: { zeta: "z", alpha: "a" } }));
	put("src/config.ts", configSource());
	put("src/plain.ts", plainSource);
	put("scripts/docs-generators/reference-evidence.json", JSON.stringify(config));
	for (const output of [
		...config.pages.map((page) => path.dirname(page.outputPath)),
		"docs/content/docs/reference/agent",
		"docs/content/docs/reference/platforms/macos",
	])
		mkdirSync(path.join(root, output), { recursive: true });
	for (const [file, content] of Object.entries(files)) put(file, content);
}

const mutate = (change) => {
	const config = baseConfig();
	change(config);
	return config;
};

function failures(result) {
	return result.err.filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
}

test("generates every page, then --check is clean", () => {
	fixture();
	const generated = capture();
	assert.equal(sourceMain([], generated.deps), 0);
	assert.deepEqual(generated.out, ["Generated 11 source references."]);

	const config = readFileSync(path.join(root, "docs/content/docs/reference/configuration.mdx"), "utf8");
	assert.ok(config.startsWith("---\ntitle: 'Config''s page'\ndescription: 'It''s configuration.'\n---\n\n{/* This file is generated"));
	assert.match(config, /Browser true, managed false, headless "auto",\ncursor true, glow false\. cite-me/);
	assert.match(config, /<a href="https:\/\/example\.test\/blob\/main\/src\/config\.ts"><code>src\/config\.ts<\/code><\/a>\. The evidence check requires <code>DEFAULT_CONFIG<\/code>/);
	const plain = readFileSync(path.join(root, "docs/content/docs/reference/plain.mdx"), "utf8");
	assert.match(plain, /\n\nPlain body about SYMBOL\.\n\n<details/);

	const codebase = readFileSync(path.join(root, "docs/content/docs/reference/codebase.mdx"), "utf8");
	assert.match(codebase, /### `extensions\/`\n\n- \[`extensions\/keep\.txt`\]\(https:\/\/example\.test\/blob\/main\/extensions\/keep\.txt\)\n\n### `src\/`/);
	assert.ok(!codebase.includes("subdir"));
	assert.match(codebase, /- `npm run alpha`\n- `npm run zeta`$/m);
	const meta = JSON.parse(readFileSync(path.join(root, "docs/content/docs/reference/platforms/macos/meta.json"), "utf8"));
	assert.deepEqual(meta.pages, ["accessibility", "capture", "actions", "root-targeting"]);
	assert.ok(readFileSync(path.join(root, "docs/content/docs/reference/index.mdx"), "utf8").includes("## Agent interface"));

	const clean = capture();
	assert.equal(sourceMain(["--check"], clean.deps), 0);
	assert.deepEqual(clean.out, ["Checked 11 generated source references."]);
});

test("--check reports stale and missing pages without writing", () => {
	fixture();
	sourceMain([], capture().deps);
	const stale = path.join(root, "docs/content/docs/reference/plain.mdx");
	writeFileSync(stale, "edited\n");
	rmSync(path.join(root, "docs/content/docs/reference/index.mdx"));
	const result = capture();
	assert.equal(sourceMain(["--check"], result.deps), 1);
	assert.equal(result.err[0], "Source reference generation failed:\n");
	assert.deepEqual(failures(result), [
		"docs/content/docs/reference/plain.mdx is stale; run npm run docs:generate",
		"docs/content/docs/reference/index.mdx is stale; run npm run docs:generate",
	]);
	assert.equal(readFileSync(stale, "utf8"), "edited\n");
});

test("flags unmanaged reference pages, including nested ones, but not other files or the tools page", () => {
	fixture({
		files: {
			"docs/content/docs/reference/rogue.mdx": "x",
			"docs/content/docs/reference/platforms/deep/rogue2.mdx": "x",
			"docs/content/docs/reference/notes.md": "x",
			[toolsDoc]: "owned by the tool generator",
		},
	});
	const result = capture();
	assert.equal(sourceMain([], result.deps), 1);
	assert.deepEqual(failures(result).sort(), [
		"docs/content/docs/reference/platforms/deep/rogue2.mdx is an unmanaged reference; every reference page must have a generator owner",
		"docs/content/docs/reference/rogue.mdx is an unmanaged reference; every reference page must have a generator owner",
	]);
});

test("rejects bad schema versions and duplicate keys or output paths", () => {
	fixture({
		config: mutate((config) => {
			config.schemaVersion = 2;
			config.pages[1].key = config.pages[0].key;
			config.pages[1].outputPath = config.pages[0].outputPath;
		}),
		files: { "src/plain.ts": plainSource.replace("reference/plain", "reference/configuration") },
	});
	const result = capture();
	assert.equal(sourceMain([], result.deps), 1);
	assert.deepEqual(failures(result).slice(0, 3), [
		"unsupported reference evidence schema version 2",
		"reference evidence contains duplicate page keys",
		"reference evidence contains duplicate output paths",
	]);
});

const pageFailure = (change, files) => {
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root);
	fixture({ config: mutate(change), files });
	const result = capture();
	assert.equal(sourceMain([], result.deps), 1);
	return failures(result);
};

test("page evidence failures name the page and the missing piece", () => {
	assert.deepEqual(
		pageFailure((config) => (config.pages[1].sourcePath = "src/absent.ts")),
		["reference/plain: missing source src/absent.ts"],
	);
	assert.deepEqual(
		pageFailure((config) => config.pages[1].requiredSymbols.push("NOPE")),
		["reference/plain: evidence symbol NOPE is absent from src/plain.ts"],
	);
	assert.deepEqual(
		pageFailure((config) => (config.pages[0].requiredCitations = ["absent-citation"])),
		["reference/configuration: required authored citation absent-citation is absent from its source-owned documentation block"],
	);
});

test("documentation blocks must be present, terminated and unique", () => {
	assert.deepEqual(pageFailure(() => {}, { "src/plain.ts": "// nothing\nSYMBOL\n" }), ["missing PI_DOCS_REFERENCE_BEGIN reference/plain"]);
	assert.deepEqual(pageFailure(() => {}, { "src/plain.ts": "// PI_DOCS_REFERENCE_BEGIN reference/plain\nSYMBOL\n" }), [
		"missing PI_DOCS_REFERENCE_END after PI_DOCS_REFERENCE_BEGIN reference/plain",
	]);
	assert.deepEqual(
		pageFailure(() => {}, { "src/plain.ts": `${plainSource}// PI_DOCS_REFERENCE_BEGIN reference/plain\nSYMBOL\nPI_DOCS_REFERENCE_END\n` }),
		["duplicate PI_DOCS_REFERENCE_BEGIN reference/plain"],
	);
});

test("derived configuration facts fail loudly when the source drifts", () => {
	assert.deepEqual(pageFailure(() => {}, { "src/config.ts": configSource().replace("const DEFAULT_CONFIG", "const OTHER") }), [
		"reference/configuration: evidence symbol DEFAULT_CONFIG is absent from src/config.ts",
	]);
	assert.deepEqual(pageFailure(() => {}, { "src/config.ts": configSource().replace(/const DEFAULT_CONFIG[^\n]*/, "const DEFAULT_CONFIG = noBraces; // DEFAULT_CONFIG") }), [
		"reference/configuration: cannot extract DEFAULT_CONFIG",
	]);
	assert.deepEqual(pageFailure(() => {}, { "src/config.ts": configSource().replace("headless:", "headlessless:") }), [
		"reference/configuration: cannot extract default for headless",
	]);
});

test("unresolved derived-fact placeholders are rejected", () => {
	assert.deepEqual(pageFailure(() => {}, { "src/plain.ts": plainSource.replace("Plain body", "{{unknown-fact:x}} body") }), [
		"reference/plain: unresolved derived-fact placeholder",
	]);
});

test("source references default to console and the package root", () => {
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	try {
		assert.equal(sourceMain(["--check"]), 0);
		assert.match(log.mock.calls[0][0], /^Checked \d+ generated source references\.$/);
	} finally {
		log.mockRestore();
	}
	fixture();
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		assert.equal(sourceMain(["--check"], { root }), 1);
		assert.equal(error.mock.calls[0][0], "Source reference generation failed:\n");
	} finally {
		error.mockRestore();
	}
});

// ---------------------------------------------------------------- entry points

const entryPoints = {
	"generate-tool-reference.mjs": () => import("../scripts/docs-generators/generate-tool-reference.mjs"),
	"generate-source-references.mjs": () => import("../scripts/docs-generators/generate-source-references.mjs"),
};

test.each(Object.keys(entryPoints))("%s run as a script checks the real docs and sets the exit code", async (name) => {
	const argv = process.argv;
	const exitCode = process.exitCode;
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	try {
		process.exitCode = undefined;
		vi.resetModules();
		process.argv = [argv[0], fileURLToPath(new URL(name, generatorDir)), "--check"];
		await entryPoints[name]();
		assert.equal(process.exitCode, 0);
		assert.equal(log.mock.calls.length, 1);

		// Through a symlink (workspace node_modules, /var vs /private/var) the script must still run.
		const link = path.join(root, name);
		symlinkSync(fileURLToPath(new URL(name, generatorDir)), link);
		log.mockClear();
		process.exitCode = undefined;
		vi.resetModules();
		process.argv = [argv[0], link, "--check"];
		await entryPoints[name]();
		assert.equal(process.exitCode, 0);
		assert.equal(log.mock.calls.length, 1, "a symlinked entry path is not a silent no-op");

		log.mockClear();
		vi.resetModules();
		process.argv = [argv[0], undefined, "--check"];
		await entryPoints[name]();
		assert.equal(log.mock.calls.length, 0, "no entry script means nothing runs");
	} finally {
		process.argv = argv;
		process.exitCode = exitCode;
		log.mockRestore();
		vi.resetModules();
	}
});
