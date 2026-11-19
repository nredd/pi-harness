import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const baseline = JSON.parse(readFileSync(new URL("test-tempdirs-baseline.json", import.meta.url), "utf8"));
const remaining = new Set(Object.keys(baseline));
const testDirectory = /(?:^|\/)(?:test|tests|__tests__)\//;
const scriptExtension = /\.[cm]?[jt]sx?$/;
const testExtension = /\.(?:test|spec|bench)\.[cm]?[jt]sx?$/;
const helper = "tests/lib/src/temp-dir.ts";
const rawAllocation = /\bmkdtemp(?:Sync)?\b/g;
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
	cwd: root,
	encoding: "utf8",
}).split("\0");

// Count references, not just calls, so named aliases and destructuring are checked too.
for (const file of new Set(files)) {
	if (file === helper || !scriptExtension.test(file) || !(testDirectory.test(file) || testExtension.test(file))) {
		continue;
	}
	const source = join(root, file);
	if (!existsSync(source)) continue; // A tracked file may have been deleted in the working tree.
	const count = Array.from(readFileSync(source, "utf8").matchAll(rawAllocation)).length;
	const previous = baseline[file] ?? 0;
	remaining.delete(file);
	if (count > previous) {
		console.error(`${file}: ${count - previous} new raw mkdtemp/mkdtempSync reference(s); use makeTestTempDir`);
		process.exitCode = 1;
	} else if (count < previous) {
		console.error(`${file}: reduce the baseline count from ${previous} to ${count} (remove the entry at zero)`);
		process.exitCode = 1;
	}
}

for (const file of remaining) {
	console.error(`${file}: remove the stale test temp directory baseline entry`);
	process.exitCode = 1;
}
