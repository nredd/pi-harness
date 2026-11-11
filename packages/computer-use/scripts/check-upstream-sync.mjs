#!/usr/bin/env node
// Compare tracked source trees, not installed output. Requires a clean detached upstream worktree, or
// `--fetch` to shallow-fetch the pinned upstream commit into a temporary directory (CI).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateUpstreamRows } from "./check-sync-ledger.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = process.argv[2];
assert.ok(arg, "Usage: npm run test:upstream-sync -- /path/to/upstream-worktree | --fetch");
const ledger = JSON.parse(readFileSync(path.join(root, "sync-patches.json"), "utf8"));
const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
validateUpstreamRows(ledger, readFileSync(path.join(root, "UPSTREAM.md"), "utf8"));
let scratch;
let upstream = arg;
if (arg === "--fetch") {
	scratch = mkdtempSync(path.join(os.tmpdir(), "cu-upstream-"));
	upstream = path.join(scratch, "upstream");
	execFileSync("git", ["init", "--quiet", upstream]);
	const url = "https://github.com/injaneity/pi-computer-use.git";
	git(upstream, ["fetch", "--quiet", "--depth", "1", url, ledger.upstream]);
	git(upstream, ["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
}
try {
	compare();
} finally {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
}

function compare() {
	assert.equal(git(upstream, ["rev-parse", "HEAD"]), ledger.upstream, "wrong upstream base");
	assert.equal(git(upstream, ["status", "--porcelain"]), "", "upstream tree must be clean");
	const files = (cwd) =>
		git(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "."]).split("\n").filter(Boolean);
	const changed = [...new Set([...files(upstream), ...files(root)])]
		.filter((file) => {
			const a = path.join(upstream, file);
			const b = path.join(root, file);
			return !existsSync(a) || !existsSync(b) || !readFileSync(a).equals(readFileSync(b));
		})
		.sort();
	assert.deepEqual(
		changed,
		[...ledger.files].sort(),
		"undeclared drift or absorbed patch: update the carried patch ledger deliberately",
	);
	console.log(`Upstream ${ledger.upstream}: exactly ${changed.length} declared patch files differ.`);
}
