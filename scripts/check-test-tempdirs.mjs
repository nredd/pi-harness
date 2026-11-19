import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const testDirectory = /(?:^|\/)(?:test|tests|__tests__)\//;
const scriptExtension = /\.[cm]?[jt]sx?$/;
const testExtension = /\.(?:test|spec|bench)\.[cm]?[jt]sx?$/;
const helper = "tests/lib/src/temp-dir.ts";
const baselinePath = "scripts/test-tempdirs-baseline.json";
const rawAllocation = /\bmkdtemp(?:Sync)?\b/g;

/** Check literal temp directory references in owned JS/TS tests, not Python or the `forks/pi` Gitlink. */
export function checkTestTempdirs(cwd, compareRef) {
	const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
	const baseline = JSON.parse(readFileSync(join(cwd, baselinePath), "utf8"));
	const remaining = new Set(Object.keys(baseline));
	const problems = [];
	// Match package_layout.py: ratchet against the merge base, not an unrelated advance on main.
	const base = git("merge-base", "--end-of-options", "HEAD", compareRef).trim();
	// On first introduction the merge base predates the baseline. Other Git failures still fail closed.
	if (git("ls-tree", "--name-only", base, "--", baselinePath)) {
		const baseCounts = JSON.parse(git("show", `${base}:${baselinePath}`));
		for (const [file, count] of Object.entries(baseline)) {
			if (!Object.hasOwn(baseCounts, file)) {
				problems.push(`${file}: new temp directory baseline entry vs ${base}`);
			} else if (count > baseCounts[file]) {
				problems.push(`${file}: temp directory baseline grew from ${baseCounts[file]} to ${count} vs ${base}`);
			}
		}
	}
	const files = git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0");

	// Count references, not just calls, so named aliases and destructuring are checked too.
	for (const file of new Set(files)) {
		if (
			file === helper ||
			file.startsWith("forks/pi/") ||
			!scriptExtension.test(file) ||
			!(testDirectory.test(file) || testExtension.test(file))
		) {
			continue;
		}
		const source = join(cwd, file);
		if (!existsSync(source)) continue; // A tracked file may have been deleted in the working tree.
		const count = Array.from(readFileSync(source, "utf8").matchAll(rawAllocation)).length;
		const previous = baseline[file] ?? 0;
		remaining.delete(file);
		if (count > previous) {
			problems.push(`${file}: ${count - previous} new raw mkdtemp/mkdtempSync reference(s); use makeTestTempDir`);
		} else if (count !== previous) {
			problems.push(`${file}: reduce the baseline count from ${previous} to ${count} (remove the entry at zero)`);
		}
	}

	for (const file of remaining) problems.push(`${file}: remove the stale test temp directory baseline entry`);
	return problems;
}

/** Apply the contract at the CLI boundary. */
export function dispatch(isMain, check = checkTestTempdirs) {
	if (!isMain) return;
	const problems = check(root, process.argv[2] || "origin/main");
	for (const problem of problems) console.error(problem);
	process.exitCode = problems.length ? 1 : 0;
}

// The repository tooling uses Node 26 as pinned in .node-version, not the published package engines.
dispatch(import.meta.main);
