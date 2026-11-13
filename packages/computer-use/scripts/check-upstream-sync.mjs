#!/usr/bin/env node
// Compare tracked source trees, not installed output. Requires a clean detached upstream worktree, or
// `--fetch` to shallow-fetch the pinned upstream commit into a temporary directory. `--fetch-if-enabled` does the
// same only when `PI_CU_UPSTREAM_SYNC=1` (set by CI on Linux; `npm run check` stays offline elsewhere).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateUpstreamRows } from "./check-sync-ledger.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Compare actual tracked source trees; network fetches are explicit and injectable, never implicit on import. */
export function main(
	argv = process.argv.slice(2),
	deps = { exec: execFileSync, env: process.env, log: console.log, error: console.error, root },
) {
	const root = deps.root;
	let arg = argv[0];
	assert.ok(arg, "Usage: npm run test:upstream-sync -- /path/to/upstream-worktree | --fetch | --fetch-if-enabled");
	if (arg === "--fetch-if-enabled") {
		if (deps.env.PI_CU_UPSTREAM_SYNC !== "1") {
			deps.log(
				"NOT RUN upstream sync: set PI_CU_UPSTREAM_SYNC=1 to fetch the pinned upstream commit (CI does on Linux).",
			);
			return 0;
		}
		arg = "--fetch";
	}
	const ledger = JSON.parse(readFileSync(path.join(root, "sync-patches.json"), "utf8"));
	const git = (cwd, args) => deps.exec("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
	validateUpstreamRows(ledger, readFileSync(path.join(root, "UPSTREAM.md"), "utf8"));
	const FETCH_ATTEMPTS = 3;
	const FETCH_TIMEOUT_MS = 120_000;
	let scratch;
	let upstream = arg;
	try {
		if (arg === "--fetch") {
			scratch = mkdtempSync(path.join(os.tmpdir(), "cu-upstream-"));
			upstream = path.join(scratch, "upstream");
			fetchPinnedUpstream(upstream);
		}
		compare();
	} finally {
		if (scratch) rmSync(scratch, { recursive: true, force: true });
	}

	/** Shallow-fetch the pinned upstream commit into `dir`, retrying transient network failures.
	 * @param {string} dir Empty directory to initialise as a detached checkout.
	 * @returns {void}
	 * @throws {Error} "upstream fetch failed (not drift)" once every attempt fails.
	 */
	function fetchPinnedUpstream(dir) {
		const url = "https://github.com/injaneity/pi-computer-use.git";
		const run = (args) =>
			deps.exec("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe", timeout: FETCH_TIMEOUT_MS });
		let failure;
		for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
			try {
				deps.exec("git", ["init", "--quiet", dir], { timeout: FETCH_TIMEOUT_MS });
				run(["fetch", "--quiet", "--depth", "1", url, ledger.upstream]);
				run(["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
				return;
			} catch (error) {
				failure = error;
				deps.error(`upstream fetch attempt ${attempt}/${FETCH_ATTEMPTS} failed: ${error.message.split("\n")[0]}`);
			}
		}
		throw new Error(`upstream fetch failed (not drift): ${failure.message.split("\n")[0]}`);
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
		deps.log(`Upstream ${ledger.upstream}: exactly ${changed.length} declared patch files differ.`);
	}
	return 0;
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)))
	main();
