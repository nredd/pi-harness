import { existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Harness } from "@earendil-works/pi-coding-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import extension from "../../src/index.ts";
import { git, makeGitFixture, runTools, startSession } from "./support.ts";

const GUARD_MARKER = "pi-dev-tools blocks this git command";

describe("git tools through a real session", () => {
	const cleanups: (() => void)[] = [];

	/** A fresh git fixture and a session running the extension in its clone. */
	async function session(): Promise<{ harness: Harness; repo: string; remote: string }> {
		const fixture = makeGitFixture();
		cleanups.push(() => rmSync(dirname(fixture.repo), { recursive: true, force: true }));
		const harness = await startSession(extension, fixture.repo);
		cleanups.push(() => harness.cleanup());
		return { harness, ...fixture };
	}

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	it("reads return parsed state and compact text, and failures carry a named state", async () => {
		const { harness } = await session();
		const [status, tree, staged, log, shown, missing] = await runTools(harness, [
			{ name: "git_status", args: {} },
			{ name: "git_diff", args: {} },
			{ name: "git_diff", args: { staged: true, stat: true } },
			{ name: "git_log", args: { max_count: 5 } },
			{ name: "git_show", args: { rev: "HEAD", stat: true } },
			{ name: "git_show", args: { rev: "not-a-ref" } },
		]);

		expect(status.isError, status.text).toBe(false);
		const state = status.structured as {
			branch: string;
			staged: { path: string; from?: string }[];
			unstaged: { path: string }[];
			untracked: string[];
		};
		expect(state.branch).toBe("main");
		expect(Object.fromEntries(state.staged.map((entry) => [entry.path, entry.from]))).toEqual({
			"renamed.txt": "old.txt",
			"c.txt": undefined,
		});
		expect(state.unstaged.map((entry) => entry.path)).toEqual(["a.txt"]);
		expect(state.untracked).toEqual(["spaced name.txt"]);
		expect(status.text).toContain("R old.txt -> renamed.txt");

		expect(tree.text).toContain("+two");
		expect((tree.structured as { changed: boolean }).changed).toBe(true);
		expect(staged.text).toContain("c.txt");
		expect(staged.text).not.toContain("+two");

		expect((log.structured as { commits: { subject: string }[] }).commits.map((c) => c.subject)).toEqual(["Initial"]);

		expect(shown.isError).toBe(false);
		expect((shown.structured as { subject: string }).subject).toBe("Initial");
		expect(missing.isError).toBe(true);
		expect(missing.text.startsWith("git show: unknown revision")).toBe(true);
	});

	it("commits only the named paths in house style and pushes; the guard blocks bash bypasses", async () => {
		const { harness, repo, remote } = await session();
		const [badSubject, broad, committed, noVerify, force, lease] = await runTools(harness, [
			{ name: "git_commit", args: { subject: "lowercase subject", paths: ["a.txt"] } },
			{ name: "git_commit", args: { subject: "Sweep everything", paths: ["."] } },
			{
				name: "git_commit",
				args: { subject: "Extend a and add c", changes: ["Append two to `a.txt`"], paths: ["a.txt", "c.txt"] },
			},
			{ name: "bash", args: { command: "git commit --no-verify -m x" } },
			{ name: "bash", args: { command: "git push --force" } },
			{ name: "bash", args: { command: "git push --force-with-lease --dry-run" } },
		]);

		expect(badSubject.isError).toBe(true);
		expect((badSubject.structured as { stage: string }).stage).toBe("validate");
		expect(broad.isError).toBe(true);
		expect(broad.text).toContain("repository root");
		expect(committed.isError, committed.text).toBe(false);
		expect(committed.structured).toMatchObject({ stage: "done", pushed: true });
		expect(git(repo, "log", "-1", "--format=%B").replace(/\n+$/, "")).toBe(
			[
				"Extend a and add c",
				"",
				"Changes:",
				"- Append two to `a.txt`",
				"",
				"Co-Authored-By: Claude <noreply@anthropic.com>",
			].join("\n"),
		);
		expect(git(remote, "log", "-1", "--format=%s").trim()).toBe("Extend a and add c");
		// The rename was staged before the call and the untracked file was never named: both are untouched.
		expect(git(repo, "show", "--stat", "--format=", "HEAD")).not.toContain("renamed.txt");
		const porcelain = git(repo, "status", "--porcelain");
		expect(porcelain).toContain("R  old.txt -> renamed.txt");
		expect(porcelain).toContain("spaced name.txt");

		expect(noVerify.isError).toBe(true);
		expect(noVerify.text).toContain(GUARD_MARKER);
		expect(noVerify.text).toContain("no-verify");
		expect(force.isError).toBe(true);
		expect(force.text).toContain(GUARD_MARKER);
		expect(force.text).toContain("force-push");
		expect(lease.text).not.toContain(GUARD_MARKER);
	});

	it("commits a fully approved resolved merge without pathspecs", async () => {
		const { harness, repo } = await session();
		git(repo, "reset", "--hard", "HEAD");
		git(repo, "clean", "-fd");
		git(repo, "switch", "-qc", "topic");
		writeFileSync(join(repo, "b.txt"), "topic\n");
		git(repo, "commit", "-am", "Topic");
		git(repo, "switch", "-q", "main");
		writeFileSync(join(repo, "b.txt"), "main\n");
		git(repo, "commit", "-am", "Main");
		expect(() => git(repo, "merge", "--no-commit", "topic")).toThrow();
		writeFileSync(join(repo, "b.txt"), "resolved\n");

		const [merged] = await runTools(harness, [
			{ name: "git_commit", args: { subject: "Merge resolved topic", paths: ["b.txt"], push: false } },
		]);
		expect(merged.isError, merged.text).toBe(false);
		expect(git(repo, "show", "-s", "--format=%P", "HEAD").trim().split(" ")).toHaveLength(2);
		expect(git(repo, "show", "HEAD:b.txt").trim()).toBe("resolved");
	});

	it("worktree tools add, list, refuse and remove", async () => {
		const { harness, repo } = await session();
		const worktree = join(dirname(repo), "repo-feat-x");
		const elsewhere = join(dirname(repo), "elsewhere");

		const [added, clash] = await runTools(harness, [
			{ name: "git_worktree_add", args: { branch: "feat/x" } },
			{ name: "git_worktree_add", args: { branch: "main", path: elsewhere } },
		]);
		expect(added.isError, added.text).toBe(false);
		const created = added.structured as { created: boolean; path: string };
		expect(created.created).toBe(true);
		expect(realpathSync(created.path)).toBe(realpathSync(worktree));
		expect(clash.isError).toBe(true);
		expect(clash.text).toContain("branch checked out elsewhere");
		expect(existsSync(elsewhere)).toBe(false);

		writeFileSync(join(worktree, "scratch.txt"), "x\n");
		const [listed, dirty, main] = await runTools(harness, [
			{ name: "git_worktree_list", args: {} },
			{ name: "git_worktree_remove", args: { path: worktree } },
			{ name: "git_worktree_remove", args: { path: repo } },
		]);
		expect(listed.isError, listed.text).toBe(false);
		const byBranch = Object.fromEntries(
			(listed.structured as { worktrees: { branch: string; main: boolean }[] }).worktrees.map((w) => [
				w.branch,
				w.main,
			]),
		);
		expect(byBranch).toMatchObject({ main: true, "feat/x": false });
		expect(dirty.isError).toBe(true);
		expect(dirty.text).toContain("dirty worktree");
		expect(main.isError).toBe(true);
		expect(main.text).toContain("main worktree");

		const [removed, pruned] = await runTools(harness, [
			{ name: "git_worktree_remove", args: { path: worktree, force: true } },
			{ name: "git_worktree_prune", args: { dry_run: true } },
		]);
		expect(removed.isError, removed.text).toBe(false);
		expect(existsSync(worktree)).toBe(false);
		expect(git(repo, "branch", "--list", "feat/x").trim()).toBe("feat/x");
		expect(pruned.structured).toEqual({ dryRun: true, pruned: [] });
		expect(pruned.text).toBe("nothing to prune");
	});
});
