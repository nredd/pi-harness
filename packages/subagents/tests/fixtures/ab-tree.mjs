/**
 * Base-tree helpers for ab.mjs: locate the package inside its git repository and
 * export another ref's tree without touching the shared repository state.
 */
import { execFileSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import { join, relative } from "node:path";

const git = (cwd, args, options = {}) => execFileSync("git", args, { cwd, encoding: "utf-8", ...options }).trim();

/**
 * Resolve where `cwd` sits in its repository: the repo `root` and the package
 * `prefix` relative to it ("" when the package is the repo root).
 */
export function resolveLayout(cwd) {
	const root = git(cwd, ["rev-parse", "--show-toplevel"]);
	return { root, prefix: relative(root, cwd) };
}

/**
 * Export the whole tree of `sha` into `dest` with `git archive`, so no worktree
 * is registered in the shared repository and cleanup is a plain directory
 * removal. Returns the exported package directory (`dest/<prefix>`).
 */
export function exportTree(layout, sha, dest) {
	const archive = execFileSync("git", ["archive", "--format=tar", sha], {
		cwd: layout.root,
		maxBuffer: 1 << 30,
	});
	execFileSync("tar", ["-x", "-C", dest], { input: archive });
	return join(dest, layout.prefix);
}

/**
 * Share installed dependencies with the exported tree. npm workspaces hoist to
 * the repo root, so link that; also link a package-level `node_modules` when one
 * exists. Dependencies are identical for both sides by construction.
 */
export function linkDependencies(layout, dest) {
	const links = [join(layout.root, "node_modules")];
	if (layout.prefix) links.push(join(layout.root, layout.prefix, "node_modules"));
	for (const source of links) {
		if (!existsSync(source)) continue;
		symlinkSync(source, join(dest, relative(layout.root, source)), "dir");
	}
}

/**
 * Reduce a Vitest 5 JSON-reporter report to task name -> median ms per sample.
 * Benchmarks are test results now: `assertionResults[].benchmarks[].tasks[]`
 * carry `latency.p50` (median, not mean: the spawn task does real disk I/O and
 * throws occasional outliers that drag a mean around).
 */
export function parseBenchReport(report) {
	const out = new Map();
	for (const file of report.testResults ?? []) {
		for (const result of file.assertionResults ?? []) {
			for (const bench of result.benchmarks ?? []) {
				for (const task of bench.tasks ?? []) {
					const median = task.latency?.p50 ?? task.latency?.mean;
					if (median != null) out.set(`${bench.name}`, median);
				}
			}
		}
	}
	return out;
}
