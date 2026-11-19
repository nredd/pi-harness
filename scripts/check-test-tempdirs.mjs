import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const testDirectory = /(?:^|\/)(?:test|tests|__tests__)\//;
const scriptExtension = /\.[cm]?[jt]sx?$/;
const testExtension = /\.(?:test|spec|bench)\.[cm]?[jt]sx?$/;
const helper = "tests/lib/src/temp-dir.ts";
const rawAllocation = /\bmkdtemp(?:Sync)?\b/g;

/** Report raw temp directory references added to test sources and stale migration counts. */
export function checkTestTempdirs(cwd) {
	const baseline = JSON.parse(readFileSync(join(cwd, "scripts/test-tempdirs-baseline.json"), "utf8"));
	const remaining = new Set(Object.keys(baseline));
	const problems = [];
	const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
		cwd,
		encoding: "utf8",
	}).split("\0");

	// Count references, not just calls, so named aliases and destructuring are checked too.
	for (const file of new Set(files)) {
		if (file === helper || !scriptExtension.test(file) || !(testDirectory.test(file) || testExtension.test(file))) {
			continue;
		}
		const source = join(cwd, file);
		if (!existsSync(source)) continue; // A tracked file may have been deleted in the working tree.
		const count = Array.from(readFileSync(source, "utf8").matchAll(rawAllocation)).length;
		const previous = baseline[file] ?? 0;
		remaining.delete(file);
		if (count > previous) {
			problems.push(`${file}: ${count - previous} new raw mkdtemp/mkdtempSync reference(s); use makeTestTempDir`);
		} else if (count < previous) {
			problems.push(`${file}: reduce the baseline count from ${previous} to ${count} (remove the entry at zero)`);
		}
	}

	for (const file of remaining) problems.push(`${file}: remove the stale test temp directory baseline entry`);
	return problems;
}

/** Apply the contract at the CLI boundary. */
export function dispatch(isMain, check = checkTestTempdirs) {
	if (!isMain) return;
	const problems = check(root);
	for (const problem of problems) console.error(problem);
	process.exitCode = problems.length ? 1 : 0;
}

dispatch(import.meta.main);
