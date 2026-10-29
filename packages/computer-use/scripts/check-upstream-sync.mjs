#!/usr/bin/env node
// Compare tracked source trees, not installed output. Requires a clean detached upstream worktree.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const upstream = process.argv[2];
assert.ok(upstream, "Usage: npm run test:upstream-sync -- /path/to/upstream-worktree");
const ledger = JSON.parse(readFileSync(path.join(root, "sync-patches.json"), "utf8"));
const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
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
