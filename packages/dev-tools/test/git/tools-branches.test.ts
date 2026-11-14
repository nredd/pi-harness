import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerGitTools } from "../../src/git/index.ts";
import { createToolHost } from "../support.ts";

const ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
};
const sh = (cwd: string, args: string[], env: NodeJS.ProcessEnv = ENV): string =>
	execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env, encoding: "utf8" }).trim();

const mock = createToolHost();
beforeAll(() => registerGitTools(mock.pi));
const roots: string[] = [];
const oldPath = process.env.PATH;
afterEach(() => {
	process.env.PATH = oldPath;
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/**
 * A clone of a bare `origin` with two pushed commits: `First` by `alice` (with a body) touching
 * `a.txt`, then `Second` by `bob` touching `b.txt`.
 */
function fixture(): { root: string; repo: string; origin: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-dev-tools-branches-"));
	roots.push(root);
	const origin = join(root, "origin.git");
	const repo = join(root, "repo");
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
	execFileSync("git", ["init", "-q", "-b", "main", repo]);
	sh(repo, ["config", "user.name", "t"]);
	sh(repo, ["config", "user.email", "t@t"]);
	sh(repo, ["config", "commit.gpgsign", "false"]);
	sh(repo, ["remote", "add", "origin", origin]);
	writeFileSync(join(repo, "a.txt"), "1\n2\n3\n4\n5\n");
	sh(repo, ["add", "a.txt"]);
	sh(repo, ["commit", "-q", "-m", "First", "-m", "Body line one\nBody line two"], {
		...ENV,
		GIT_AUTHOR_NAME: "alice",
	});
	writeFileSync(join(repo, "b.txt"), "b\n");
	sh(repo, ["add", "b.txt"]);
	sh(repo, ["commit", "-q", "-m", "Second"], { ...ENV, GIT_AUTHOR_NAME: "bob" });
	sh(repo, ["push", "-q", "-u", "origin", "main"]);
	return { root, repo, origin };
}

/** Sign `repo`'s commits with a fresh SSH key that its own allowed-signers file trusts, so `%G?` is `G`. */
function signWithSsh(root: string, repo: string): void {
	const key = join(root, "signing-key");
	execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "t@t", "-f", key]);
	const allowed = join(root, "allowed-signers");
	writeFileSync(allowed, `t@t ${readFileSync(`${key}.pub`, "utf8")}`);
	sh(repo, ["config", "gpg.format", "ssh"]);
	sh(repo, ["config", "user.signingkey", `${key}.pub`]);
	sh(repo, ["config", "gpg.ssh.allowedSignersFile", allowed]);
	sh(repo, ["config", "commit.gpgsign", "true"]);
}

/** Put a `git` on PATH that sleeps before running `sub`; every other call is real git. */
function slowGit(root: string, sub: string): void {
	const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	const bin = join(root, "bin");
	mkdirSync(bin);
	writeFileSync(
		join(bin, "git"),
		`#!/bin/sh\ncase " $* " in *" ${sub} "*) sleep 5;; esac\nexec ${JSON.stringify(realGit)} "$@"\n`,
	);
	chmodSync(join(bin, "git"), 0o755);
	process.env.PATH = `${bin}:${oldPath}`;
}

describe("git read tool options", () => {
	it("git_status honors timeout_s instead of the 60 s default", async () => {
		const { root, repo } = fixture();
		slowGit(root, "status");
		const r = await mock.call("git_status", { timeout_s: 1 }, repo);
		expect(r.isError).toBe(true);
		expect(mock.text(r)).toMatch(/^git status: timed out/);
	});

	it("git_diff honors context", async () => {
		const { repo } = fixture();
		writeFileSync(join(repo, "a.txt"), "1\n2\nthree\n4\n5\n");
		const r = await mock.call("git_diff", { context: 0 }, repo);
		expect(r.isError, mock.text(r)).toBe(false);
		expect(mock.text(r)).toContain("@@ -3 +3 @@\n-3\n+three");
		expect(mock.text(r)).not.toContain("\n 2\n");
	});

	it("git_diff relays a full diff that fails after its stat succeeded", async () => {
		const { root, repo } = fixture();
		writeFileSync(join(repo, "a.txt"), "changed\n");
		slowGit(root, "-U0");
		const r = await mock.call("git_diff", { context: 0, timeout_s: 1 }, repo);
		expect(r.isError).toBe(true);
		expect(r.structuredContent).toMatchObject({ error: expect.stringMatching(/^git diff: timed out/) });
	});

	it("git_log filters by author, since and ref, and shows bodies when oneline is false", async () => {
		const { repo } = fixture();
		const r = await mock.call(
			"git_log",
			{ author: "alice", since: "1970-01-02", ref: "main", oneline: false, paths: ["a.txt"] },
			repo,
		);
		expect(r.isError, mock.text(r)).toBe(false);
		expect((r.structuredContent as { commits: { author: string; subject: string }[] }).commits).toMatchObject([
			{ author: "alice", subject: "First" },
		]);
		expect(mock.text(r)).toMatch(/ alice: First\n {2}Body line one\n {2}Body line two$/);
	});

	it("git_log author alone keeps only that author's commits", async () => {
		const { repo } = fixture();
		const r = await mock.call("git_log", { author: "bob" }, repo);
		expect(r.isError, mock.text(r)).toBe(false);
		expect((r.structuredContent as { commits: { subject: string }[] }).commits.map((c) => c.subject)).toEqual([
			"Second",
		]);
	});

	it("git_log since alone drops every older commit", async () => {
		const { repo } = fixture();
		const r = await mock.call("git_log", { since: "2099-12-31" }, repo);
		expect(r.isError, mock.text(r)).toBe(false);
		expect(mock.text(r)).toBe("no commits");
		expect(r.structuredContent).toEqual({ commits: [] });
	});

	it("git_log drops the record a 4 MiB stdout cut left partial and still reports the cut", async () => {
		const { root, repo } = fixture();
		// 1465-byte records: the 4 MiB stream cap keeps 2863 whole ones and cuts the next inside its author field.
		const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		const bin = join(root, "bin");
		mkdirSync(bin);
		writeFileSync(
			join(bin, "git"),
			`#!/bin/sh
case " $* " in *" log "*) awk 'BEGIN { s = sprintf("%1431s", ""); gsub(/ /, "x", s); for (i = 0; i < 5000; i++) printf "%07x\\tbob\\t2026-01-01T00:00:00Z\\t%s\\n", i, s }'; exit 0;; esac\nexec ${JSON.stringify(realGit)} "$@"\n`,
		);
		chmodSync(join(bin, "git"), 0o755);
		process.env.PATH = `${bin}:${oldPath}`;
		const r = await mock.call("git_log", {}, repo);
		expect(r.isError, mock.text(r)).toBe(false);
		const commits = (r.structuredContent as { commits: { sha: string; date: string; subject: string }[] }).commits;
		expect(commits.length).toBeGreaterThan(0);
		expect(commits.length).toBeLessThan(5000);
		for (const c of commits) {
			expect(c.date).toBe("2026-01-01T00:00:00Z");
			expect(c.subject).toHaveLength(1431);
		}
		expect(mock.text(r)).toMatch(/\[output truncated at the .*\(producer dropped \d+ more bytes\)\]$/);
	});

	it("git_log names an unknown ref", async () => {
		const { repo } = fixture();
		const r = await mock.call("git_log", { ref: "no-such-branch" }, repo);
		expect(r.isError).toBe(true);
		expect(r.structuredContent).toMatchObject({ error: expect.stringMatching(/^git log: unknown revision/) });
	});

	it("git_show limits to paths and relays a failing show after the rev resolves", async () => {
		const { root, repo } = fixture();
		// Like `git show`, a path the commit does not touch hides the whole commit.
		expect(mock.text(await mock.call("git_show", { rev: "HEAD" }, repo))).toContain("b.txt");
		const limited = await mock.call("git_show", { rev: "HEAD", paths: ["a.txt"] }, repo);
		expect(limited.isError, mock.text(limited)).toBe(false);
		expect(mock.text(limited)).not.toContain("b.txt");

		const outside = await mock.call("git_show", { rev: "HEAD", paths: [root] }, repo);
		expect(outside.isError).toBe(true);
		expect(mock.text(outside)).toMatch(/^git show: exit 128\nfatal: .* is outside repository/);
	});
});

describe("git_commit edge outcomes", () => {
	it("reports a commit that timed out in a hook as abnormal, not as a hook rejection", async () => {
		const { repo } = fixture();
		writeFileSync(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
		writeFileSync(join(repo, "a.txt"), "changed\n");
		const before = sh(repo, ["rev-parse", "HEAD"]);
		const r = await mock.call("git_commit", { subject: "Slow hook", paths: ["a.txt"], timeout_s: 1 }, repo);
		expect(r.structuredContent).toMatchObject({ stage: "commit", sha: null, pushed: false });
		expect(mock.text(r)).toMatch(/^git commit: timed out/);
		expect(mock.text(r)).not.toContain("hooks run before the commit");
		expect(sh(repo, ["rev-parse", "HEAD"])).toBe(before);
	});

	it("says nothing to commit when the named path is unchanged", async () => {
		const { repo } = fixture();
		const r = await mock.call("git_commit", { subject: "No change", paths: ["a.txt"] }, repo);
		expect(r.structuredContent).toMatchObject({ stage: "commit", sha: null, pushed: false });
		expect(mock.text(r)).toMatch(/^git commit: nothing to commit for the named paths\n/);
	});

	it("commits and pushes a staged deletion with nothing left to add", async () => {
		const { repo, origin } = fixture();
		sh(repo, ["rm", "-q", "b.txt"]);
		const r = await mock.call("git_commit", { subject: "Remove b", paths: ["b.txt"] }, repo);
		expect(r.structuredContent, mock.text(r)).toMatchObject({ stage: "done", pushed: true });
		expect(mock.text(r)).toMatch(/^committed [0-9a-f]{7} and pushed in /);
		expect(sh(origin, ["log", "-1", "--format=%s", "main"])).toBe("Remove b");
	});
	it("reports a signed commit kept local with push: false", async () => {
		const { root, repo, origin } = fixture();
		signWithSsh(root, repo);
		writeFileSync(join(repo, "a.txt"), "signed\n");
		const r = await mock.call("git_commit", { subject: "Signed local", paths: ["a.txt"], push: false }, repo);
		expect(r.structuredContent, mock.text(r)).toMatchObject({ stage: "done", signed: true, pushed: false });
		expect(mock.text(r)).toMatch(/^committed [0-9a-f]{7} \(signed\), not pushed$/);
		expect(sh(origin, ["log", "-1", "--format=%s", "main"])).toBe("Second");
	});

	it("reports a signed commit that was pushed", async () => {
		const { root, repo, origin } = fixture();
		signWithSsh(root, repo);
		writeFileSync(join(repo, "a.txt"), "signed\n");
		const r = await mock.call("git_commit", { subject: "Signed push", paths: ["a.txt"] }, repo);
		expect(r.structuredContent, mock.text(r)).toMatchObject({ stage: "done", signed: true, pushed: true });
		expect(mock.text(r)).toMatch(/^committed [0-9a-f]{7} \(signed\) and pushed in /);
		expect(sh(origin, ["log", "-1", "--format=%s", "main"])).toBe("Signed push");
	});
});
