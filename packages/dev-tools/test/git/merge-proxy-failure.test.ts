import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const failing = vi.hoisted(() => ({ on: false }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
			if (failing.on) throw new Error("proxy write failed");
			return actual.writeFileSync(...args);
		},
	};
});

import { prepareMerge } from "../../src/git/merge.ts";

const ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.invalid",
	GIT_COMMITTER_NAME: "fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
const git = (cwd: string, args: string[]) =>
	execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: ENV });

it("removes the proxy directory when writing the hook proxy fails", async () => {
	const repo = mkdtempSync(join(tmpdir(), "pi-dev-tools-merge-fail-"));
	try {
		git(repo, ["init", "-q", "-b", "main"]);
		writeFileSync(join(repo, "a.txt"), "base\n");
		git(repo, ["add", "."]);
		git(repo, ["commit", "-qm", "Initial", "--author=f <f@example.invalid>"]);
		git(repo, ["switch", "-qc", "topic"]);
		writeFileSync(join(repo, "a.txt"), "topic\n");
		git(repo, ["commit", "-qam", "Topic"]);
		git(repo, ["switch", "-q", "main"]);
		writeFileSync(join(repo, "a.txt"), "main\n");
		git(repo, ["commit", "-qam", "Main"]);
		expect(() => git(repo, ["merge", "--no-commit", "topic"])).toThrow();
		const before = readdirSync(tmpdir()).filter((name) => name.startsWith("pi-git-merge-"));
		failing.on = true;
		await expect(prepareMerge(["a.txt"], { cwd: repo })).rejects.toThrow("proxy write failed");
		failing.on = false;
		expect(readdirSync(tmpdir()).filter((name) => name.startsWith("pi-git-merge-"))).toEqual(before);
	} finally {
		failing.on = false;
		rmSync(repo, { recursive: true, force: true });
	}
});
