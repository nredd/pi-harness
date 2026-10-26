import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerGitTools } from "../../src/git/index.ts";
import { createMockPi } from "../support.ts";

const ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
};
const sh = (cwd: string, args: string[]): string =>
	execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
		cwd,
		env: ENV,
		encoding: "utf8",
	}).trim();

const mock = createMockPi();
beforeAll(() => registerGitTools(mock.pi));
const roots: string[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A clone with `upstream` and `fork` bare remotes, one initial commit on `main` pushed to both. */
function fixture(): { repo: string; upstream: string; fork: string; root: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-dev-tools-remote-"));
	roots.push(root);
	const upstream = join(root, "upstream.git");
	const fork = join(root, "fork.git");
	const repo = join(root, "repo");
	for (const bare of [upstream, fork]) execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
	execFileSync("git", ["init", "-q", "-b", "main", repo]);
	sh(repo, ["config", "user.name", "t"]);
	sh(repo, ["config", "user.email", "t@t"]);
	sh(repo, ["remote", "add", "upstream", upstream]);
	sh(repo, ["remote", "add", "fork", fork]);
	writeFileSync(join(repo, "a.txt"), "a\n");
	writeFileSync(join(repo, "gone.txt"), "g\n");
	sh(repo, ["add", "."]);
	sh(repo, ["commit", "-q", "-m", "Initial"]);
	sh(repo, ["push", "-q", "upstream", "main"]);
	sh(repo, ["push", "-q", "fork", "main"]);
	sh(repo, ["branch", "--set-upstream-to=upstream/main", "main"]);
	return { repo, upstream, fork, root };
}
const subjectOn = (bare: string) => sh(bare, ["log", "-1", "--format=%s", "main"]);
const change = (repo: string, n: number) => writeFileSync(join(repo, "a.txt"), `a${n}\n`);

describe("git_commit push target", () => {
	it("pushes to branch.<n>.pushRemote, not the upstream remote", async () => {
		const { repo, upstream, fork } = fixture();
		sh(repo, ["config", "branch.main.pushRemote", "fork"]);
		change(repo, 1);
		const r = await mock.call("git_commit", { subject: "Push to fork", paths: ["a.txt"] }, repo);
		expect(r.isError, mock.text(r)).toBe(false);
		expect(subjectOn(fork)).toBe("Push to fork");
		expect(subjectOn(upstream)).toBe("Initial");
		// A configured remote is pushed to without `-u`: tracking stays on upstream/main.
		expect(sh(repo, ["rev-parse", "--abbrev-ref", "@{u}"])).toBe("upstream/main");
	});

	it("falls back to remote.pushDefault before branch.<n>.remote", async () => {
		const { repo, upstream, fork } = fixture();
		sh(repo, ["config", "remote.pushDefault", "fork"]);
		change(repo, 2);
		const r = await mock.call("git_commit", { subject: "Push default", paths: ["a.txt"] }, repo);
		expect(r.isError, mock.text(r)).toBe(false);
		expect(subjectOn(fork)).toBe("Push default");
		expect(subjectOn(upstream)).toBe("Initial");
	});

	it("uses branch.<n>.remote when nothing else is configured", async () => {
		const { repo, upstream } = fixture();
		change(repo, 3);
		const r = await mock.call("git_commit", { subject: "Push upstream", paths: ["a.txt"] }, repo);
		expect(r.isError, mock.text(r)).toBe(false);
		expect(subjectOn(upstream)).toBe("Push upstream");
	});

	it("fails closed with several remotes and no configured target", async () => {
		const { repo, upstream, fork } = fixture();
		sh(repo, ["branch", "--unset-upstream"]);
		change(repo, 4);
		const r = await mock.call("git_commit", { subject: "Ambiguous push", paths: ["a.txt"] }, repo);
		expect(r.isError).toBe(true);
		expect((r.structuredContent as { stage: string; sha: string }).stage).toBe("push");
		expect((r.structuredContent as { sha: string }).sha).toMatch(/^[0-9a-f]{40}$/);
		expect(mock.text(r)).toMatch(/ambiguous|pushRemote/);
		expect(subjectOn(upstream)).toBe("Initial");
		expect(subjectOn(fork)).toBe("Initial");
	});

	it("uses the only remote when there is exactly one, even if it is not origin", async () => {
		const { repo, upstream } = fixture();
		sh(repo, ["branch", "--unset-upstream"]);
		sh(repo, ["remote", "remove", "fork"]);
		change(repo, 5);
		const r = await mock.call("git_commit", { subject: "Only remote", paths: ["a.txt"] }, repo);
		expect(r.isError, mock.text(r)).toBe(false);
		expect(subjectOn(upstream)).toBe("Only remote");
		expect(sh(repo, ["rev-parse", "--abbrev-ref", "@{u}"])).toBe("upstream/main");
	});
});

describe("git_commit push target failures", () => {
	it("fails closed on a detached HEAD", async () => {
		const { repo, upstream } = fixture();
		sh(repo, ["checkout", "-q", "--detach"]);
		change(repo, 7);
		const r = await mock.call("git_commit", { subject: "Detached push", paths: ["a.txt"] }, repo);
		expect(r.isError).toBe(true);
		expect(mock.text(r)).toContain("detached");
		expect((r.structuredContent as { stage: string; sha: string }).stage).toBe("push");
		expect(subjectOn(upstream)).toBe("Initial");
	});

	it("treats branch.<n>.remote = . as unconfigured, never `git push . HEAD`", async () => {
		const { repo, upstream, fork } = fixture();
		sh(repo, ["config", "branch.main.remote", "."]);
		sh(repo, ["config", "branch.main.merge", "refs/heads/main"]);
		change(repo, 8);
		const r = await mock.call("git_commit", { subject: "Dot remote", paths: ["a.txt"] }, repo);
		expect(r.isError).toBe(true);
		expect(mock.text(r)).toContain("local branch");
		expect((r.structuredContent as { stage: string; sha: string }).stage).toBe("push");
		expect(subjectOn(upstream)).toBe("Initial");
		expect(subjectOn(fork)).toBe("Initial");
	});

	it("still honors pushRemote when branch.<n>.remote is .", async () => {
		const { repo, fork } = fixture();
		sh(repo, ["config", "branch.main.remote", "."]);
		sh(repo, ["config", "branch.main.pushRemote", "fork"]);
		change(repo, 9);
		const r = await mock.call("git_commit", { subject: "Dot with push remote", paths: ["a.txt"] }, repo);
		expect(r.isError, mock.text(r)).toBe(false);
		expect(subjectOn(fork)).toBe("Dot with push remote");
	});

	it("never pushes when the config is unreadable, and relays git's stderr", async () => {
		// Corrupt config trips whichever git step reads it first, so this proves the fail-closed
		// outcome end to end; the exit-1-only `config()` rule is covered by the unset-key cases above.
		const { repo, upstream } = fixture();
		const cfg = join(repo, ".git", "config");
		writeFileSync(cfg, `${readFileSync(cfg, "utf8")}[branch "main"\n`);
		change(repo, 10);
		const r = await mock.call("git_commit", { subject: "Corrupt config", paths: ["a.txt"] }, repo);
		expect(r.isError).toBe(true);
		expect(mock.text(r)).toMatch(/bad config|fatal/i);
		expect((r.structuredContent as { pushed: boolean }).pushed).toBe(false);
		expect(subjectOn(upstream)).toBe("Initial");
	});
});

describe("git_commit deletions", () => {
	it("commits a deleted path together with a modified one", async () => {
		const { repo, upstream } = fixture();
		rmSync(join(repo, "gone.txt"));
		change(repo, 6);
		const r = await mock.call("git_commit", { subject: "Delete and modify", paths: ["gone.txt", "a.txt"] }, repo);
		expect(r.isError, mock.text(r)).toBe(false);
		expect(sh(repo, ["show", "--name-status", "--format=", "HEAD"]).split("\n").sort()).toEqual([
			"D\tgone.txt",
			"M\ta.txt",
		]);
		expect(subjectOn(upstream)).toBe("Delete and modify");
	});

	it("commits a deletion that was already staged with git rm", async () => {
		const { repo } = fixture();
		sh(repo, ["rm", "-q", "gone.txt"]);
		const r = await mock.call("git_commit", { subject: "Remove gone", paths: ["gone.txt"], push: false }, repo);
		expect(r.isError, mock.text(r)).toBe(false);
		expect(sh(repo, ["show", "--name-status", "--format=", "HEAD"])).toBe("D\tgone.txt");
	});

	it("commits only the named paths when a staged deletion sits next to other staged files", async () => {
		const { repo } = fixture();
		writeFileSync(join(repo, "other.txt"), "o\n");
		sh(repo, ["add", "other.txt"]);
		change(repo, 12);
		sh(repo, ["add", "a.txt"]);
		sh(repo, ["rm", "-q", "gone.txt"]);
		const r = await mock.call("git_commit", { subject: "Remove gone only", paths: ["gone.txt"], push: false }, repo);
		expect(r.isError, mock.text(r)).toBe(false);
		expect(sh(repo, ["show", "--name-status", "--format=", "HEAD"])).toBe("D\tgone.txt");
		expect(sh(repo, ["diff", "--cached", "--name-status"]).split("\n").sort()).toEqual(["A\tother.txt", "M\ta.txt"]);
	});
});
