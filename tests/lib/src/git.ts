/** Disposable git repositories with a fixed identity and no signing, for real-git scenarios. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GIT_IDENTITY = ["-c", "user.name=h", "-c", "user.email=h@h", "-c", "commit.gpgsign=false"];

/** Run git in `cwd` with a fixed identity and no signing; returns stdout. */
export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", [...GIT_IDENTITY, "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
}

/**
 * A clone of a bare remote holding one of every working-tree state: an unstaged edit (`a.txt`), a
 * staged add (`c.txt`), a staged rename (`old.txt` -> `renamed.txt`) and an untracked file with a space.
 */
export function makeGitFixture(): { repo: string; remote: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-test-git-"));
	const remote = join(root, "remote.git");
	const repo = join(root, "repo");
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
	git(root, "clone", "-q", remote, repo);
	for (const [key, value] of [
		["user.name", "h"],
		["user.email", "h@h"],
		["commit.gpgsign", "false"],
	] as const)
		git(repo, "config", key, value);
	writeFileSync(join(repo, "a.txt"), "one\n");
	writeFileSync(join(repo, "b.txt"), "b\n");
	writeFileSync(join(repo, "old.txt"), "same\n");
	git(repo, "add", "a.txt", "b.txt", "old.txt");
	git(repo, "commit", "-q", "-m", "Initial");
	git(repo, "push", "-q", "-u", "origin", "main");
	writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
	writeFileSync(join(repo, "c.txt"), "c\n");
	writeFileSync(join(repo, "spaced name.txt"), "n\n");
	git(repo, "mv", "old.txt", "renamed.txt");
	git(repo, "add", "c.txt");
	return { repo, remote };
}
