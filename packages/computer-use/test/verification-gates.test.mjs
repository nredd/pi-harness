import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test, vi } from "vitest";
import { main as docs } from "../scripts/check-docs.mjs";
import { main as platforms } from "../scripts/check-docs-platform.mjs";

const temporary = [];
const quiet = { log() {}, error() {} };
const symbols = [
	"AXIsProcessTrustedWithOptions",
	"CGPreflightScreenCaptureAccess",
	"CGRequestScreenCaptureAccess",
	"CGWindowListCopyWindowInfo",
	"SCScreenshotManager.captureImage",
	"VNRecognizeTextRequest",
	"AXUIElementPerformAction",
	"AXUIElementSetAttributeValue",
	"postToPid",
	"cghidEventTap",
	"/usr/sbin/screencapture",
	"AgentCursor",
	"ax_only",
];
const reference = "docs/content/docs/reference/platforms/macos/implementation.mdx";
function scratch() {
	const root = mkdtempSync(path.join(os.tmpdir(), "verification-gates-"));
	temporary.push(root);
	return root;
}
function write(root, name, source) {
	const file = path.join(root, name);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, source);
}
function fixture() {
	const root = scratch();
	for (const mode of ["tutorials", "how-to-guides", "explanation", "reference"])
		mkdirSync(path.join(root, "docs/content/docs", mode), { recursive: true });
	for (const name of ["README.md", "CONTRIBUTING.md"]) write(root, name, "Documentation");
	write(root, "docs/README.md", "cd packages/computer-use\nnpm install --prefix docs");
	write(root, "docs/content/docs/tutorials/getting-started.mdx", "pi install npm:@nredd/pi-computer-use");
	write(
		root,
		"docs/content/docs/how-to-guides/develop-and-validate.mdx",
		"The harness root `.github/workflows/publish.yml` owns releases",
	);
	write(
		root,
		"docs/content/docs/how-to-guides/troubleshooting.mdx",
		"PI_COMPUTER_USE_ALLOW_BUILD=1 node scripts/setup-helper.mjs --platform linux --runtime",
	);
	write(
		root,
		reference,
		`{/* This file is generated */}\n${symbols.join("\n")}\nhttps://developer.apple.com/documentation/\nhttps://github.com/injaneity/pi-computer-use/blob/main/native/macos/bridge.swift#L1`,
	);
	for (const name of [
		"native/macos/bridge.swift",
		"native/macos/agent_cursor.swift",
		"src/platform/macos/helper.ts",
		"scripts/setup-helper.mjs",
	])
		write(root, name, symbols.join("\n"));
	return root;
}
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("documentation gate accepts a real package and a complete synthetic tree", () => {
	assert.equal(docs(), 0);
	assert.equal(docs([fixture()], quiet), 0);
});

test("documentation gate refuses each required instruction, missing section and non-directory section", () => {
	for (const name of [
		"docs/README.md",
		"docs/content/docs/tutorials/getting-started.mdx",
		"docs/content/docs/how-to-guides/develop-and-validate.mdx",
		"docs/content/docs/how-to-guides/troubleshooting.mdx",
	]) {
		const root = fixture();
		write(root, name, "wrong instruction");
		assert.equal(docs([root], quiet), 1, name);
	}
	for (const replacement of [false, true]) {
		const root = fixture();
		const section = "docs/content/docs/explanation";
		rmSync(path.join(root, section), { recursive: true });
		if (replacement) write(root, section, "not a directory");
		assert.equal(docs([root], quiet), 1);
	}
});

test("documentation gate checks generated ownership, links, fragments and all candidate suffixes", () => {
	const root = fixture();
	write(root, "docs/content/docs/explanation/notes.txt", "ignored [broken](missing)");
	const targets = ["plain", "markdown.md", "extended.mdx", "folder/index.md", "other/index.mdx", "space name.md"];
	for (const target of targets) write(root, `docs/content/docs/explanation/${target}`, "target");
	const links = [
		"plain",
		"markdown",
		"extended",
		"folder",
		"other",
		"space%20name",
		"/explanation/plain",
		"plain?query=1#part",
		"#fragment",
		"https://example.com",
		"",
		"<plain>",
	];
	write(root, "docs/content/docs/explanation/links.md", links.map((link) => `[link](${link})`).join("\n"));
	assert.equal(docs([root], quiet), 0);
	write(root, "docs/content/docs/reference/manual.mdx", "not generated");
	write(root, "docs/content/docs/explanation/broken.mdx", "[link](missing)");
	const errors = [];
	assert.equal(docs([root], { ...quiet, error: (line) => errors.push(line) }), 1);
	assert.match(errors.join("\n"), /every reader-facing reference page must be generated/);
	assert.match(errors.join("\n"), /broken local link missing/);
});

test("documentation gate refuses missing implementation, symbols, source and citation coverage", () => {
	for (const name of [reference, "native/macos/bridge.swift"]) {
		const root = fixture();
		if (name === reference) rmSync(path.join(root, reference));
		else
			for (const source of [
				name,
				"native/macos/agent_cursor.swift",
				"src/platform/macos/helper.ts",
				"scripts/setup-helper.mjs",
			])
				write(root, source, "missing symbols");
		assert.equal(docs([root], quiet), 1);
	}
	const root = fixture();
	write(root, reference, "{/* This file is generated */}");
	const errors = [];
	assert.equal(docs([root], { ...quiet, error: (line) => errors.push(line) }), 1);
	for (const symbol of symbols)
		assert.ok(errors.some((line) => line.includes(`missing implementation coverage for ${symbol}`)));
	assert.ok(errors.some((line) => line.includes("platform claims need Apple documentation links")));
	assert.ok(errors.some((line) => line.includes("implementation claims need source links")));
});

test("documentation gate rejects every stale macOS claim and propagates unreadable trees", () => {
	for (const claim of [
		"never in the agent's own observations",
		"ScreenCaptureKit probe (authoritative)",
		"already listed in both settings panes",
		"setup-helper.mjs --force",
		"TCC keys grant",
	]) {
		const root = fixture();
		write(root, "README.md", claim);
		assert.equal(docs([root], quiet), 1, claim);
	}
	assert.throws(() => docs([scratch()], quiet), /ENOENT/);
});

test("platform gate runs both real offline generators and refuses launch errors or divergence", () => {
	assert.equal(platforms(), 0);
	for (const result of [
		{ error: new Error("spawn refused"), status: null },
		{ error: undefined, status: 1, stdout: "stale", stderr: "details" },
		{ error: undefined, status: null, stdout: "", stderr: "signal" },
	]) {
		assert.throws(() => platforms([], { ...quiet, spawn: () => result }));
	}
	const calls = [];
	assert.equal(
		platforms([], {
			...quiet,
			spawn: (...args) => {
				calls.push(args);
				return { status: 0 };
			},
		}),
		0,
	);
	assert.equal(calls.length, 2);
	for (const [index, call] of calls.entries()) {
		assert.equal(call[0], process.execPath);
		assert.equal(call[2].timeout, 30_000);
		assert.match(call[1].at(-1), new RegExp(index === 0 ? '"linux"' : '"darwin"'));
	}
});

test("CLI entries dispatch in process and ordinary imports remain inert", async () => {
	const argv = process.argv;
	const exitCode = process.exitCode;
	try {
		for (const name of ["check-docs", "check-docs-platform"]) {
			const url = new URL(`../scripts/${name}.mjs`, import.meta.url);
			process.argv = [process.execPath];
			vi.resetModules();
			await import(url.href);
			process.argv = [process.execPath, fileURLToPath(url)];
			vi.resetModules();
			await import(url.href);
		}
	} finally {
		process.argv = argv;
		process.exitCode = exitCode;
	}
});

test("platform CLI dispatches through symlinked paths", () => {
	for (const [name, args, expected] of [["check-docs-platform", [], /host-independent/]]) {
		const link = path.join(scratch(), `${name}.mjs`);
		symlinkSync(fileURLToPath(new URL(`../scripts/${name}.mjs`, import.meta.url)), link);
		const result = spawnSync(process.execPath, [link, ...args], { cwd: os.tmpdir(), encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, expected);
	}
});

test("CLI docs refusal follows a symlinked entrypoint from outside the package", () => {
	const root = fixture();
	write(root, "docs/README.md", "cd .\nnpm install --prefix docs");
	const link = path.join(scratch(), "check-docs.mjs");
	symlinkSync(fileURLToPath(new URL("../scripts/check-docs.mjs", import.meta.url)), link);
	const result = spawnSync(process.execPath, [link, root], { cwd: os.tmpdir(), encoding: "utf8" });
	assert.equal(result.status, 1, result.stdout);
	assert.match(result.stderr, /website commands must enter packages\/computer-use/);
});

test("CLI docs refusal preserves nonzero exit and useful diagnostics", () => {
	const root = fixture();
	write(root, "README.md", "setup-helper.mjs --force");
	const result = spawnSync(
		process.execPath,
		[fileURLToPath(new URL("../scripts/check-docs.mjs", import.meta.url)), root],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /nonexistent setup-helper --force option/);
});
