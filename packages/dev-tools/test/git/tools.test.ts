import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { registerGitTools } from "../../src/git/index.ts";
import { createMockPi } from "../support.ts";

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
};
function sh(cwd: string, args: string[]): string {
	return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
		cwd,
		env: GIT_ENV,
		encoding: "utf8",
	});
}

let repo: string;
let remote: string;
const mock = createMockPi();

beforeAll(() => {
	registerGitTools(mock.pi);
	const root = mkdtempSync(join(tmpdir(), "pi-dev-tools-git-"));
	remote = join(root, "remote.git");
	repo = join(root, "repo");
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
	execFileSync("git", ["clone", "-q", remote, repo], { env: GIT_ENV });
	sh(repo, ["config", "commit.gpgsign", "false"]);
	sh(repo, ["config", "user.name", "t"]);
	sh(repo, ["config", "user.email", "t@t"]);
	writeFileSync(join(repo, "a.txt"), "one\n");
	writeFileSync(join(repo, "b.txt"), "b\n");
	sh(repo, ["add", "a.txt", "b.txt"]);
	sh(repo, ["commit", "-q", "-m", "Initial"]);
	sh(repo, ["push", "-q", "-u", "origin", "main"]);
	writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
	writeFileSync(join(repo, "c.txt"), "c\n");
	writeFileSync(join(repo, "new file.txt"), "n\n");
	writeFileSync(join(repo, "prestaged.txt"), "p\n");
	sh(repo, ["add", "c.txt", "prestaged.txt"]);
});

describe("git read tools", () => {
	it("registers reads as read-only and commit as mutating", () => {
		for (const name of ["git_status", "git_diff", "git_log", "git_show"]) {
			expect(mock.tools.get(name)?.annotations?.readOnlyHint, name).toBe(true);
		}
		expect(mock.tools.get("git_commit")?.annotations?.readOnlyHint).toBe(false);
	});

	it("git_status reports staged, unstaged and untracked with spaces intact", async () => {
		const r = await mock.call("git_status", {}, repo);
		expect(r.isError).toBe(false);
		const s = r.structuredContent as {
			branch: string;
			staged: { path: string }[];
			unstaged: { path: string }[];
			untracked: string[];
		};
		expect(s.branch).toBe("main");
		expect(s.staged.map((e) => e.path)).toEqual(["c.txt", "prestaged.txt"]);
		expect(s.unstaged.map((e) => e.path)).toEqual(["a.txt"]);
		expect(s.untracked).toEqual(["new file.txt"]);
		expect(mock.text(r)).toContain("main (origin/main in sync)");
	});

	it("git_diff returns stat then diff, staged separately, stat-only on request", async () => {
		const tree = await mock.call("git_diff", {}, repo);
		expect(mock.text(tree)).toMatch(/a\.txt \|\s+1 \+/);
		expect(mock.text(tree)).toContain("+two");
		const staged = await mock.call("git_diff", { staged: true }, repo);
		expect(mock.text(staged)).toContain("c.txt");
		expect(mock.text(staged)).not.toContain("a.txt");
		const stat = await mock.call("git_diff", { stat: true }, repo);
		expect(mock.text(stat)).not.toContain("+two");
		const none = await mock.call("git_diff", { paths: ["b.txt"] }, repo);
		expect(mock.text(none)).toBe("no changes");
		expect((none.structuredContent as { changed: boolean }).changed).toBe(false);
	});

	it("git_log is one line per commit with structured fields", async () => {
		const r = await mock.call("git_log", { max_count: 5 }, repo);
		const c = (r.structuredContent as { commits: { sha: string; subject: string; date: string }[] }).commits;
		expect(c).toHaveLength(1);
		expect(c[0]?.subject).toBe("Initial");
		expect(c[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(mock.text(r)).toMatch(/^[0-9a-f]{7} \d{4}-\d{2}-\d{2} t: Initial$/);
	});

	it("git_show shows metadata, stat and patch, and rejects flag-like revs", async () => {
		const r = await mock.call("git_show", { rev: "HEAD" }, repo);
		expect(mock.text(r)).toContain("Initial");
		expect(mock.text(r)).toContain("+one");
		const statOnly = await mock.call("git_show", { rev: "HEAD", stat: true }, repo);
		expect(mock.text(statOnly)).not.toContain("+one");
		const bad = await mock.call("git_show", { rev: "--output=/tmp/x" }, repo);
		expect(bad.isError).toBe(true);
	});

	it("names git failures instead of a bare exit code, with error-shaped structured content", async () => {
		const r = await mock.call("git_show", { rev: "nope-not-a-ref" }, repo);
		expect(r.isError).toBe(true);
		expect(mock.text(r)).toMatch(/^git show: unknown revision/);
		expect(r.structuredContent).toMatchObject({ error: expect.stringContaining("unknown revision") });
		const outside = await mock.call("git_status", {}, tmpdir());
		expect(outside.isError).toBe(true);
		expect(mock.text(outside)).toMatch(/^git status: not a git repository/);
		const badDiff = await mock.call("git_diff", { base: "nope-not-a-ref" }, repo);
		expect(mock.text(badDiff)).toMatch(/^git diff: unknown revision/);
		const badLog = await mock.call("git_log", { paths: ["nope.txt"] }, repo);
		expect(badLog.isError).toBe(false);
		expect(mock.text(badLog)).toBe("no commits");
	});

	it("refuses option-like refs on every read and keeps refs after --end-of-options", async () => {
		for (const [tool, params] of [
			["git_diff", { base: "--output=/tmp/pi-dev-tools-evil" }],
			["git_log", { ref: "--output=/tmp/pi-dev-tools-evil" }],
			["git_show", { rev: "--output=/tmp/pi-dev-tools-evil" }],
		] as const) {
			const r = await mock.call(tool, params, repo);
			expect(r.isError, tool).toBe(true);
			expect(mock.text(r)).toMatch(/must not start with '-'/);
		}
		expect(existsSync("/tmp/pi-dev-tools-evil")).toBe(false);
	});

	it("treats globs and pathspec magic as literal file names", async () => {
		const r = await mock.call("git_diff", { paths: ["*"] }, repo);
		expect(mock.text(r)).toBe("no changes");
		const log = await mock.call("git_log", { paths: [":/"] }, repo);
		expect(mock.text(log)).toBe("no commits");
	});

	it("git_diff against a base ref works with stat, staged and paths", async () => {
		writeFileSync(join(repo, "base.txt"), "x\n");
		sh(repo, ["add", "base.txt"]);
		sh(repo, ["commit", "-q", "-m", "Base commit"]);
		const r = await mock.call("git_diff", { base: "HEAD~1" }, repo);
		expect(r.isError, mock.text(r)).toBe(false);
		expect(mock.text(r)).toContain("base.txt");
		const statOnly = await mock.call("git_diff", { base: "HEAD~1", stat: true, paths: ["base.txt"] }, repo);
		expect(mock.text(statOnly)).toMatch(/base\.txt \|/);
		expect(mock.text(statOnly)).not.toContain("+x");
		const staged = await mock.call("git_diff", { base: "HEAD~1", staged: true }, repo);
		expect(staged.isError, mock.text(staged)).toBe(false);
		sh(repo, ["reset", "-q", "--soft", "HEAD~1"]);
		sh(repo, ["reset", "-q", "base.txt"]);
		rmSync(join(repo, "base.txt"));
	});

	it("git_show names a blob or tree rev as not a commit", async () => {
		const r = await mock.call("git_show", { rev: "HEAD:a.txt" }, repo);
		expect(r.isError).toBe(true);
		expect(mock.text(r)).toMatch(/is not a commit/);
	});

	it("git_show peels an annotated tag to its commit", async () => {
		sh(repo, ["tag", "-a", "v0", "-m", "tag msg"]);
		const r = await mock.call("git_show", { rev: "v0", stat: true }, repo);
		expect(r.isError).toBe(false);
		expect((r.structuredContent as { sha: string; subject: string }).subject).toBe("Initial");
		expect((r.structuredContent as { sha: string }).sha).toMatch(/^[0-9a-f]{40}$/);
	});
});

describe("git_commit", () => {
	it("rejects bad subjects and broad paths before touching git", async () => {
		for (const [params, re] of [
			[{ subject: "lowercase", paths: ["a.txt"] }, /capital/],
			[{ subject: "Ok", paths: ["."] }, /repository root/],
			[{ subject: "Ok", paths: ["./"] }, /repository root/],
			[{ subject: "Ok", paths: ["./."] }, /repository root/],
			[{ subject: "Ok", paths: ["-A"] }, /looks like a flag/],
			[{ subject: "Ok", paths: ["--all"] }, /looks like a flag/],
			[{ subject: "Ok", paths: ["src/.."] }, /climbs/],
			[{ subject: "Ok", paths: [":/"] }, /pathspec magic/],
			[{ subject: "Ok", paths: [":(top)a.txt"] }, /pathspec magic/],
			[{ subject: "Ok", paths: ["*"] }, /too broad/],
		] as const) {
			const r = await mock.call("git_commit", params, repo);
			expect(r.isError).toBe(true);
			expect(mock.text(r)).toMatch(re);
			expect((r.structuredContent as { stage: string }).stage).toBe("validate");
		}
	});

	it("commits the named paths in house style and pushes", async () => {
		const r = await mock.call(
			"git_commit",
			{ subject: "Add c and extend a", changes: ["Add `c.txt`", "Append two to `a.txt`"], paths: ["a.txt", "c.txt"] },
			repo,
		);
		expect(r.isError, mock.text(r)).toBe(false);
		const s = r.structuredContent as { stage: string; sha: string; pushed: boolean };
		expect(s.stage).toBe("done");
		expect(s.pushed).toBe(true);
		const msg = sh(repo, ["log", "-1", "--format=%B"]).trimEnd().concat("\n");
		expect(msg).toBe(
			"Add c and extend a\n\nChanges:\n- Add `c.txt`\n- Append two to `a.txt`\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n",
		);
		// prestaged.txt was in the index but not named, so it is still staged and not in HEAD.
		expect(sh(repo, ["status", "--porcelain", "-z"])).toBe("A  prestaged.txt\0?? new file.txt\0");
		expect(sh(repo, ["show", "--stat", "--format=", "HEAD"])).not.toContain("prestaged");
		expect(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: remote, encoding: "utf8" }).trim()).toBe(
			"Add c and extend a",
		);
	});

	it("relays a failing hook and flags hook-modified files", async () => {
		const hooks = join(repo, ".git", "hooks");
		mkdirSync(hooks, { recursive: true });
		writeFileSync(
			join(hooks, "pre-commit"),
			"#!/bin/sh\necho 'nope check...Failed' >&2\necho '- files were modified by this hook' >&2\nexit 1\n",
			{ mode: 0o755 },
		);
		writeFileSync(join(repo, "b.txt"), "b2\n");
		const r = await mock.call("git_commit", { subject: "Change b", paths: ["b.txt"] }, repo);
		expect(r.isError).toBe(true);
		const s = r.structuredContent as { stage: string; hookModifiedFiles: boolean; sha: null };
		expect(s.stage).toBe("commit");
		expect(s.hookModifiedFiles).toBe(true);
		expect(s.sha).toBeNull();
		expect(mock.text(r)).toContain("nope check...Failed");
		expect(mock.text(r)).toContain("re-stage");
		expect(sh(repo, ["log", "-1", "--format=%s"]).trim()).toBe("Add c and extend a");
		execFileSync("rm", [join(hooks, "pre-commit")]);
	});

	it("reports a push failure without re-committing", async () => {
		sh(repo, ["remote", "set-url", "origin", join(tmpdir(), "does-not-exist.git")]);
		const r = await mock.call("git_commit", { subject: "Change b for real", paths: ["b.txt"] }, repo);
		expect(r.isError).toBe(true);
		const s = r.structuredContent as { stage: string; sha: string; pushed: boolean };
		expect(s.stage).toBe("push");
		expect(s.sha).toMatch(/^[0-9a-f]{40}$/);
		expect(s.pushed).toBe(false);
		expect(mock.text(r)).toContain("do NOT commit again");
		sh(repo, ["remote", "set-url", "origin", remote]);
	});

	it("can skip the push", async () => {
		writeFileSync(join(repo, "b.txt"), "b3\n");
		const r = await mock.call("git_commit", { subject: "Change b again", paths: ["b.txt"], push: false }, repo);
		expect(r.isError).toBe(false);
		expect(mock.text(r)).toContain("not pushed");
	});
});

describe("bash guard hook", () => {
	it("blocks hook-skipping and force pushes, names git_commit, leaves everything else alone", () => {
		const noVerify = mock.toolCall("bash", { command: "git commit --no-verify -m x" }) as {
			block: boolean;
			reason: string;
		};
		expect(noVerify.block).toBe(true);
		expect(noVerify.reason).toMatch(/^pi-dev-tools blocks this git command \(no-verify\)/);
		expect(noVerify.reason).toContain("git_commit");
		const force = mock.toolCall("bash", { command: "git push --force" }) as { block: boolean; reason: string };
		expect(force.block).toBe(true);
		expect(force.reason).toContain("git_commit");
		expect(mock.toolCall("bash", { command: "git push --force-with-lease" })).toBeUndefined();
		expect(mock.toolCall("bash", { command: "ls" })).toBeUndefined();
		expect(mock.toolCall("bash", { nope: 1 })).toBeUndefined();
		expect(mock.toolCall("read", { path: "x" })).toBeUndefined();
	});
});
