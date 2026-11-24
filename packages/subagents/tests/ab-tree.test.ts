// ab.mjs must benchmark the base ref at the SAME package-relative path as the
// working tree (#1378): in the monorepo the package is a subdirectory, so the
// base tree has to be exported whole and entered at the package prefix, without
// registering a worktree in the shared repository.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { describe, expect, it, onTestFinished } from "vitest";
import { exportTree, linkDependencies, parseBenchReport, resolveLayout } from "./fixtures/ab-tree.mjs";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
		cwd,
		encoding: "utf-8",
	}).trim();

function makeRepo(nested: boolean) {
	const root = makeTestTempDir("pi-ab-repo-", onTestFinished);
	git(root, "init", "-q");
	const pkg = nested ? join(root, "packages", "demo") : root;
	mkdirSync(join(pkg, "tests"), { recursive: true });
	writeFileSync(join(root, "root.txt"), "root-file");
	writeFileSync(join(pkg, "tests", "a.txt"), "package-file");
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "init");
	return { root, pkg };
}

describe("ab-tree layout", () => {
	it("resolves a nested package prefix from the repo toplevel", () => {
		const { pkg, root } = makeRepo(true);
		const layout = resolveLayout(pkg);
		expect(layout.prefix).toBe(join("packages", "demo"));
		expect(layout.root).toBe(
			execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf-8" }).trim(),
		);
	});

	it("resolves an empty prefix when the package is the repo root", () => {
		const { pkg } = makeRepo(false);
		expect(resolveLayout(pkg).prefix).toBe("");
	});

	it("exports the base tree at the package path without adding a worktree", () => {
		const { pkg, root } = makeRepo(true);
		const dest = makeTestTempDir("pi-ab-dest-", onTestFinished);
		const layout = resolveLayout(pkg);
		const baseDir = exportTree(layout, git(root, "rev-parse", "HEAD"), dest);
		expect(baseDir).toBe(join(dest, "packages", "demo"));
		expect(readFileSync(join(baseDir, "tests", "a.txt"), "utf-8")).toBe("package-file");
		expect(readFileSync(join(dest, "root.txt"), "utf-8")).toBe("root-file");
		expect(git(root, "worktree", "list").split("\n")).toHaveLength(1);
	});

	it("links hoisted and package-level node_modules, skipping missing ones", () => {
		const { pkg, root } = makeRepo(true);
		const dest = makeTestTempDir("pi-ab-dest-", onTestFinished);
		const layout = resolveLayout(pkg);
		mkdirSync(join(layout.root, "node_modules"));
		exportTree(layout, git(root, "rev-parse", "HEAD"), dest);
		linkDependencies(layout, dest);
		expect(lstatSync(join(dest, "node_modules")).isSymbolicLink()).toBe(true);
		expect(existsSync(join(dest, "packages", "demo", "node_modules"))).toBe(false);

		mkdirSync(join(layout.root, "packages", "demo", "node_modules"));
		const dest2 = makeTestTempDir("pi-ab-dest-", onTestFinished);
		exportTree(layout, git(root, "rev-parse", "HEAD"), dest2);
		linkDependencies(layout, dest2);
		expect(lstatSync(join(dest2, "packages", "demo", "node_modules")).isSymbolicLink()).toBe(true);
	});

	it("links only the root node_modules when the package is the repo root", () => {
		const { pkg, root } = makeRepo(false);
		const dest = makeTestTempDir("pi-ab-dest-", onTestFinished);
		const layout = resolveLayout(pkg);
		mkdirSync(join(pkg, "node_modules"));
		exportTree(layout, git(root, "rev-parse", "HEAD"), dest);
		linkDependencies(layout, dest);
		expect(lstatSync(join(dest, "node_modules")).isSymbolicLink()).toBe(true);
	});
});

describe("parseBenchReport", () => {
	it("maps benchmark tasks to their median latency", () => {
		const report = {
			testResults: [
				{
					assertionResults: [
						{ benchmarks: [{ name: "g > a", tasks: [{ latency: { p50: 0.5, mean: 9 } }] }] },
						{ benchmarks: [{ name: "g > b", tasks: [{ latency: { mean: 2 } }, { latency: {} }] }] },
						{},
					],
				},
				{},
			],
		};
		expect([...parseBenchReport(report)]).toEqual([
			["g > a", 0.5],
			["g > b", 2],
		]);
		expect(parseBenchReport({}).size).toBe(0);
	});
});
