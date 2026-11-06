import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupWorktree,
  createWorktree as createUntrackedWorktree,
  isWorktreeIsolationEnabled,
  pruneWorktrees,
  setWorktreeIsolationEnabled,
  WorktreeError,
} from "../src/worktree.js";

/** Every worktree path this file created, checked for leaks once the file finishes. */
const createdWorktreePaths: string[] = [];

/**
 * `createWorktree`, recording the `$TMPDIR/pi-agent-*` path it made. Removing
 * the repo and pruning drops a worktree's registration but never its
 * directory, so a test that forgets to remove one leaks it on every run (#366).
 */
async function createWorktree(...args: Parameters<typeof createUntrackedWorktree>): ReturnType<typeof createUntrackedWorktree> {
  const wt = await createUntrackedWorktree(...args);
  createdWorktreePaths.push(wt.path);
  return wt;
}

afterAll(() => {
  const leaked = createdWorktreePaths.filter(path => existsSync(path));
  for (const path of leaked) rmSync(path, { recursive: true, force: true });
  expect(leaked, "tests left these worktree directories in $TMPDIR").toEqual([]);
});

/**
 * Minimal stand-in for pi.exec(): runs the command for real, and — like the
 * host's implementation — REPORTS failure in the result instead of rejecting.
 * The source has to read `code`/`killed` rather than rely on a throw, so a stub
 * that threw would hide the branch that matters.
 */
function mockPi(): ExtensionAPI {
  return {
    exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
      try {
        const stdout = execFileSync(command, args, {
          cwd: options?.cwd,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: options?.timeout,
        });
        return { stdout, stderr: "", code: 0, killed: false };
      } catch (err: any) {
        return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.status ?? 1, killed: false };
      }
    },
  } as unknown as ExtensionAPI;
}

/**
 * A pi whose exec answers one git subcommand with a canned failure result and
 * runs everything else for real. `match` sees the argv git is called with.
 */
function failingPi(match: (args: string[]) => boolean, failure: { code: number; killed: boolean }): ExtensionAPI {
  const real = mockPi();
  return {
    exec: vi.fn(async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
      if (match(args)) return { stdout: "", stderr: "boom", ...failure };
      return real.exec(command, args, options);
    }),
  } as unknown as ExtensionAPI;
}

/**
 * Helper: create a temporary git repo with an initial commit.
 */
function initGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-test-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# Test repo");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "pipe" });
  return dir;
}

describe("worktree", () => {
  let repoDir: string;
  let pi: ExtensionAPI;

  beforeEach(() => {
    repoDir = initGitRepo();
    pi = mockPi();
  });

  afterEach(async () => {
    // Clean up any lingering worktrees first, then remove repo
    try { await pruneWorktrees(pi, repoDir); } catch { /* ignore */ }
    rmSync(repoDir, { recursive: true, force: true });
  });

  describe("createWorktree", () => {
    it("creates a worktree in tmpdir", async () => {
      const wt = await createWorktree(pi, repoDir, "test-id-1");
      expect(wt).toBeDefined();
      expect(existsSync(wt!.path)).toBe(true);
      expect(wt!.branch).toBe("pi-agent-test-id-1");
      expect(wt!.baseSha).toBe(execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim());

      // Verify it's a valid worktree with the repo's files
      expect(existsSync(join(wt!.path, "README.md"))).toBe(true);

      // Cleanup
      try { execFileSync("git", ["worktree", "remove", "--force", wt!.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    // Each failure names the directory it tried and its specific cause: the
    // old single message ("not a git repo, no commits yet, or `git worktree
    // add` failed") left the caller guessing which directory and which of three.
    it("throws naming the directory for a non-git directory", async () => {
      const nonGit = mkdtempSync(join(tmpdir(), "pi-wt-nongit-"));
      try {
        const err = await createWorktree(pi, nonGit, "test-id-2").catch(e => e);
        expect(err).toBeInstanceOf(WorktreeError);
        expect(err.message).toContain(`${nonGit} is not inside a git repository`);
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });

    it("throws naming the repo for a git repo with no commits", async () => {
      const emptyRepo = mkdtempSync(join(tmpdir(), "pi-wt-empty-"));
      try {
        execFileSync("git", ["init"], { cwd: emptyRepo, stdio: "pipe" });
        mkdirSync(join(emptyRepo, "sub"));
        // From a subdirectory: the message names the toplevel, not the cwd.
        await expect(createWorktree(pi, join(emptyRepo, "sub"), "no-commits"))
          .rejects.toThrow(`${realpathSync(emptyRepo)} has no commits yet`);
      } finally {
        rmSync(emptyRepo, { recursive: true, force: true });
      }
    });

    it("throws for a cwd inside the .git directory", async () => {
      // rev-parse --is-inside-work-tree exits 0 there but prints "false".
      await expect(createWorktree(pi, join(repoDir, ".git"), "in-git-dir"))
        .rejects.toThrow("is inside a git directory but not a work tree");
    });

    it("throws with git's stderr when `git worktree add` reports a non-zero exit", async () => {
      // pi.exec resolves with a failure code instead of throwing, so a port that
      // only caught exceptions would hand back a worktree path that isn't there.
      await expect(createWorktree(
        failingPi(args => args[0] === "worktree" && args[1] === "add", { code: 128, killed: false }),
        repoDir,
        "add-fails",
      )).rejects.toThrow(`\`git worktree add\` failed in ${realpathSync(repoDir)}: boom`);
    });

    it("throws a timeout, not a repo-state cause, when a git call is killed", async () => {
      // A killed process reports code 0 with killed: true — the one failure
      // shape that looks like success if only the exit code is checked. And it
      // says nothing about the repo, so it must not read as "no commits yet".
      const err = await createWorktree(
        failingPi(args => args[0] === "rev-parse" && args[2] === "HEAD", { code: 0, killed: true }),
        repoDir,
        "timed-out",
      ).catch(e => e);
      expect(err).toBeInstanceOf(WorktreeError);
      expect(err.message).toContain("timed out");
      expect(err.message).not.toContain("no commits");
    });

    it("records the resolved repo toplevel, from any directory inside it", async () => {
      mkdirSync(join(repoDir, "deep", "er"), { recursive: true });
      writeFileSync(join(repoDir, "deep", "er", "x.txt"), "x");
      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "deep"], { cwd: repoDir, stdio: "pipe" });

      const wt = await createWorktree(pi, join(repoDir, "deep", "er"), "root-of");
      expect(wt.repoRoot).toBe(realpathSync(repoDir));
      expect(wt.workPath).toBe(join(wt.path, "deep", "er"));
      try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("workPath equals path when created from the repo root", async () => {
      const wt = (await createWorktree(pi, repoDir, "root-wp"))!;
      expect(wt.workPath).toBe(wt.path);
      try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("workPath preserves subdirectory scoping (monorepo package cwd)", async () => {
      mkdirSync(join(repoDir, "packages", "api"), { recursive: true });
      writeFileSync(join(repoDir, "packages", "api", "index.ts"), "export {}");
      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "add package"], { cwd: repoDir, stdio: "pipe" });

      const wt = (await createWorktree(pi, join(repoDir, "packages", "api"), "subdir-wp"))!;
      expect(wt).toBeDefined();
      expect(wt.workPath).toBe(join(wt.path, "packages", "api"));
      expect(existsSync(wt.workPath)).toBe(true);
      try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("uses unique paths for multiple worktrees", async () => {
      const wt1 = await createWorktree(pi, repoDir, "multi-1");
      const wt2 = await createWorktree(pi, repoDir, "multi-2");
      expect(wt1).toBeDefined();
      expect(wt2).toBeDefined();
      expect(wt1!.path).not.toBe(wt2!.path);

      // Cleanup
      try { execFileSync("git", ["worktree", "remove", "--force", wt1!.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
      try { execFileSync("git", ["worktree", "remove", "--force", wt2!.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("creates worktrees concurrently — the git calls do not serialize on one another", async () => {
      // The reason for the port: several isolated agents can start at once, so
      // no call may block the caller until the previous one has finished.
      const order: string[] = [];
      const tracking = {
        exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
          order.push(`start:${args[0]}`);
          const result = await pi.exec(command, args, options);
          order.push(`end:${args[0]}`);
          return result;
        },
      } as unknown as ExtensionAPI;

      const [a, b] = await Promise.all([
        createWorktree(tracking, repoDir, "par-1"),
        createWorktree(tracking, repoDir, "par-2"),
      ]);
      expect(a).toBeDefined();
      expect(b).toBeDefined();

      // Interleaving proves the two chains ran together: with blocking calls the
      // log would be strictly start/end paired.
      const interleaved = order.some((entry, i) => entry.startsWith("start:") && order[i + 1]?.startsWith("start:"));
      expect(interleaved).toBe(true);

      for (const wt of [a!, b!]) {
        try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
      }
    });
  });

  describe("cleanupWorktree", () => {
    it("removes worktree when no changes made", async () => {
      const wt = (await createWorktree(pi, repoDir, "clean-1"))!;
      expect(wt).toBeDefined();

      const result = await cleanupWorktree(pi, repoDir, wt, "test cleanup");
      expect(result.hasChanges).toBe(false);
      expect(result.branch).toBeUndefined();
      expect(existsSync(wt.path)).toBe(false);
    });

    it("commits changes and creates branch when changes exist", async () => {
      const wt = (await createWorktree(pi, repoDir, "dirty-1"))!;
      expect(wt).toBeDefined();

      // Make a change in the worktree
      writeFileSync(join(wt.path, "new-file.txt"), "agent wrote this");

      const result = await cleanupWorktree(pi, repoDir, wt, "added new file");
      expect(result.hasChanges).toBe(true);
      expect(result.branch).toBeDefined();
      expect(result.branch).toContain("pi-agent-dirty-1");

      // Verify the branch exists in the main repo
      const branches = execFileSync("git", ["branch", "--list", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      expect(branches).toContain(result.branch!);

      // Verify the commit message
      const log = execFileSync("git", ["log", "--oneline", "-1", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      expect(log).toContain("pi-agent: added new file");

      // Cleanup branch
      try { execFileSync("git", ["branch", "-D", result.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("commits changes even when a pre-commit hook rejects (--no-verify)", async () => {
      // A failing pre-commit hook in the main repo also applies to its
      // worktrees — without --no-verify it would abort the preservation commit.
      const hookPath = join(repoDir, ".git", "hooks", "pre-commit");
      writeFileSync(hookPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

      const wt = (await createWorktree(pi, repoDir, "hooked-1"))!;
      expect(wt).toBeDefined();
      writeFileSync(join(wt.path, "hooked-file.txt"), "agent wrote this");

      const result = await cleanupWorktree(pi, repoDir, wt, "hook should not block");
      expect(result.hasChanges).toBe(true);
      expect(result.branch).toBe("pi-agent-hooked-1");

      // Cleanup branch
      try { execFileSync("git", ["branch", "-D", result.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("creates branch when worktree is clean but HEAD moved", async () => {
      const wt = (await createWorktree(pi, repoDir, "committed-1"))!;
      expect(wt).toBeDefined();

      writeFileSync(join(wt.path, "committed-file.txt"), "agent committed this");
      execFileSync("git", ["add", "committed-file.txt"], { cwd: wt.path, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "agent commit"], { cwd: wt.path, stdio: "pipe" });
      const agentCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: wt.path, stdio: "pipe",
      }).toString().trim();

      const result = await cleanupWorktree(pi, repoDir, wt, "already committed");
      expect(result.hasChanges).toBe(true);
      expect(result.branch).toBeDefined();
      expect(result.branch).toBe("pi-agent-committed-1");

      const branchCommit = execFileSync("git", ["rev-parse", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      expect(branchCommit).toBe(agentCommit);
      expect(existsSync(wt.path)).toBe(false);

      // Cleanup branch
      try { execFileSync("git", ["branch", "-D", result.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("does not force-overwrite existing branch", async () => {
      // Create first worktree, make changes, cleanup → creates branch
      const wt1 = (await createWorktree(pi, repoDir, "conflict-1"))!;
      writeFileSync(join(wt1.path, "file1.txt"), "first run");
      const result1 = await cleanupWorktree(pi, repoDir, wt1, "first");
      expect(result1.branch).toBe("pi-agent-conflict-1");

      // Create second worktree with same agent ID, make changes
      const wt2 = (await createWorktree(pi, repoDir, "conflict-1"))!;
      writeFileSync(join(wt2.path, "file2.txt"), "second run");
      const result2 = await cleanupWorktree(pi, repoDir, wt2, "second");

      // Should use a different branch name (timestamp suffix)
      expect(result2.hasChanges).toBe(true);
      expect(result2.branch).toBeDefined();
      expect(result2.branch).not.toBe("pi-agent-conflict-1");
      expect(result2.branch).toContain("pi-agent-conflict-1-");

      // Both branches should exist
      const branches = execFileSync("git", ["branch", "--list", "pi-agent-conflict-1*"], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      expect(branches).toContain("pi-agent-conflict-1");
      expect(branches).toContain(result2.branch!);

      // Cleanup
      try { execFileSync("git", ["branch", "-D", result1.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
      try { execFileSync("git", ["branch", "-D", result2.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("lands the branch in the repo the worktree came from when cleaned up from a subdirectory", async () => {
      // The manager passes the caller's cwd, which may sit deep in the repo.
      mkdirSync(join(repoDir, "pkg"));
      writeFileSync(join(repoDir, "pkg", "a.ts"), "export {};");
      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "pkg"], { cwd: repoDir, stdio: "pipe" });
      const sub = join(repoDir, "pkg");

      const wt = await createWorktree(pi, sub, "from-sub");
      writeFileSync(join(wt.workPath, "new.txt"), "agent wrote this");
      const result = await cleanupWorktree(pi, sub, wt, "from subdir");

      expect(result.hasChanges).toBe(true);
      expect(existsSync(wt.path)).toBe(false);
      const files = execFileSync("git", ["ls-tree", "-r", "--name-only", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString();
      expect(files).toContain("pkg/new.txt");
      expect(existsSync(join(sub, "new.txt"))).toBe(false);
      expect(execFileSync("git", ["worktree", "list"], { cwd: repoDir, stdio: "pipe" }).toString().trim().split("\n")).toHaveLength(1);
    });

    it("handles already-deleted worktree gracefully", async () => {
      const wt = (await createWorktree(pi, repoDir, "gone-1"))!;
      // Manually delete the worktree directory
      rmSync(wt.path, { recursive: true, force: true });

      const result = await cleanupWorktree(pi, repoDir, wt, "already gone");
      expect(result.hasChanges).toBe(false);
    });

    it("truncates commit message at 200 chars", async () => {
      const wt = (await createWorktree(pi, repoDir, "long-msg"))!;
      writeFileSync(join(wt.path, "change.txt"), "something");
      const longDesc = "x".repeat(300);
      const result = await cleanupWorktree(pi, repoDir, wt, longDesc);
      expect(result.hasChanges).toBe(true);

      const log = execFileSync("git", ["log", "--oneline", "-1", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      // "pi-agent: " prefix (10 chars) + 200 chars of x = 210 total max
      expect(log.length).toBeLessThanOrEqual(220); // some slack for hash prefix

      // Cleanup
      try { execFileSync("git", ["branch", "-D", result.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("reports the retained path when `git worktree remove` fails", async () => {
      const wt = (await createWorktree(pi, repoDir, "remove-fails"))!;
      const failing = failingPi(
        args => args[0] === "worktree" && args[1] === "remove",
        { code: 1, killed: false },
      );

      try {
        const result = await cleanupWorktree(failing, repoDir, wt, "removal fails");
        expect(result.path).toBe(wt.path);
        expect(result.error).toBe("boom");
        expect(existsSync(wt.path)).toBe(true);
      } finally {
        if (existsSync(wt.path)) execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir });
      }
    });
  });

  describe("pruneWorktrees", () => {
    it("does not reject on a clean repo", async () => {
      await expect(pruneWorktrees(pi, repoDir)).resolves.toBeUndefined();
    });

    it("does not reject on non-git directory", async () => {
      const nonGit = mkdtempSync(join(tmpdir(), "pi-wt-nongit-"));
      try {
        await expect(pruneWorktrees(pi, nonGit)).resolves.toBeUndefined();
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });
  });
});

describe("cleanupWorktree — failure path", () => {
  let repoDir: string;
  let pi: ExtensionAPI;

  beforeEach(() => { repoDir = initGitRepo(); pi = mockPi(); });
  afterEach(async () => {
    try { await pruneWorktrees(pi, repoDir); } catch { /* ignore */ }
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("short-circuits when the worktree directory is already gone", async () => {
    // Hits the existsSync guard at the top of cleanupWorktree, not the outer
    // catch — cleanup can be called twice (settle path plus dispose), so it has
    // to be idempotent rather than throw on the second call.
    const wt = (await createWorktree(pi, repoDir, "vanished"))!;
    expect(wt).toBeDefined();
    rmSync(wt.path, { recursive: true, force: true });

    const result = await cleanupWorktree(pi, repoDir, wt, "agent that vanished");

    expect(result.hasChanges).toBe(false);
    expect(result.branch).toBeUndefined();
  });

  it("reports the path when git cannot inspect a worktree", async () => {
    // The outer catch. The directory exists — so the existsSync guard above
    // does not fire — but git cannot operate in it, which is what a corrupted
    // or externally-detached worktree looks like. What matters is that cleanup
    // does not reject out of the manager's settle path and take the whole
    // record down with it.
    const wt = (await createWorktree(pi, repoDir, "corrupt"))!;
    writeFileSync(join(wt.path, "work.txt"), "agent output");
    // Break the worktree's link back to the repo.
    writeFileSync(join(wt.path, ".git"), "gitdir: /nonexistent/path/that/is/not/a/repo");

    try {
      const result = await cleanupWorktree(pi, repoDir, wt, "corrupted agent");
      expect(result.path).toBe(wt.path);
      expect(existsSync(join(wt.path, "work.txt"))).toBe(true);
    } finally {
      rmSync(wt.path, { recursive: true, force: true });
    }
  });

  it("preserves uncommitted work when the preservation commit fails", async () => {
    // `git commit` failing resolves with a non-zero code rather than throwing,
    // so the outer catch is only reached if the result is inspected.
    const wt = (await createWorktree(pi, repoDir, "commit-fails"))!;
    writeFileSync(join(wt.path, "work.txt"), "agent output");

    try {
      const result = await cleanupWorktree(
        failingPi(args => args[0] === "commit", { code: 1, killed: false }),
        repoDir,
        wt,
        "commit fails",
      );
      expect(result.hasChanges).toBe(true);
      expect(result.path).toBe(wt.path);
      expect(existsSync(join(wt.path, "work.txt"))).toBe(true);
    } finally {
      if (existsSync(wt.path)) execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir });
    }
  });

  it("reports a non-Error rejection without removing the worktree", async () => {
    const wt = await createWorktree(pi, repoDir, "status-rejection");
    const failing = { exec: async () => { throw "status unavailable"; } } as unknown as ExtensionAPI;
    try {
      const result = await cleanupWorktree(failing, repoDir, wt, "status fails");
      expect(result.path).toBe(wt.path);
      expect(result.error).toBe("status unavailable");
      expect(existsSync(wt.path)).toBe(true);
    } finally {
      if (existsSync(wt.path)) execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir });
    }
  });

  it("reports an empty rejection as a cleanup failure", async () => {
    const wt = await createWorktree(pi, repoDir, "empty-rejection");
    const failing = { exec: async () => { throw ""; } } as unknown as ExtensionAPI;
    try {
      const result = await cleanupWorktree(failing, repoDir, wt, "status fails");
      expect(result.path).toBe(wt.path);
      expect(result.error).toBe("Unknown git failure");
    } finally {
      if (existsSync(wt.path)) execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir });
    }
  });

  it("keeps committed work when both branch creation attempts fail", async () => {
    const wt = await createWorktree(pi, repoDir, "branch-fails");
    writeFileSync(join(wt.path, "work.txt"), "agent output");
    try {
      const result = await cleanupWorktree(failingPi(args => args[0] === "branch", { code: 1, killed: false }), repoDir, wt, "branch fails");
      expect(result.path).toBe(wt.path);
      expect(result.error).toBe("boom");
      expect(result.branch).toBeUndefined();
      expect(execFileSync("git", ["show", "HEAD:work.txt"], { cwd: wt.path, encoding: "utf8" })).toBe("agent output");
    } finally {
      if (existsSync(wt.path)) execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir });
    }
  });

  it("reports both branch and retained path when removal fails after a commit", async () => {
    const wt = await createWorktree(pi, repoDir, "remove-dirty");
    writeFileSync(join(wt.path, "work.txt"), "agent output");
    try {
      const result = await cleanupWorktree(failingPi(args => args[0] === "worktree" && args[1] === "remove", { code: 1, killed: false }), repoDir, wt, "remove fails");
      expect(result.path).toBe(wt.path);
      expect(result.branch).toBe(wt.branch);
      expect(result.error).toBe("boom");
      expect(execFileSync("git", ["show", `${wt.branch}:work.txt`], { cwd: repoDir, encoding: "utf8" })).toBe("agent output");
    } finally {
      if (existsSync(wt.path)) execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir });
    }
  });

  it("refuses to remove work written after the status check", async () => {
    const wt = await createWorktree(pi, repoDir, "late-change");
    const late = {
      exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
        if (args[0] === "worktree" && args[1] === "remove") writeFileSync(join(wt.path, "late.txt"), "late work");
        return pi.exec(command, args, options);
      },
    } as unknown as ExtensionAPI;
    try {
      const result = await cleanupWorktree(late, repoDir, wt, "late change");
      expect(result.path).toBe(wt.path);
      expect(result.error).toBeDefined();
      expect(existsSync(join(wt.path, "late.txt"))).toBe(true);
    } finally {
      if (existsSync(wt.path)) execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir });
    }
  });

  it("creates the branch BEFORE removing the worktree, so a removal failure cannot lose commits", async () => {
    // Ordering is the actual safety property. If a refactor moved
    // removeWorktree above the `git branch` call, the commits would be
    // unreachable the moment removal succeeded and branching failed.
    const wt = (await createWorktree(pi, repoDir, "ordered"))!;
    writeFileSync(join(wt.path, "work.txt"), "agent output");

    const result = await cleanupWorktree(pi, repoDir, wt, "ordered agent");

    expect(result.hasChanges).toBe(true);
    expect(result.branch).toBeDefined();
    // The branch must exist in the MAIN repo after the worktree is gone —
    // that is what makes the agent's work recoverable.
    const branches = execFileSync("git", ["branch", "--list", result.branch!], {
      cwd: repoDir, stdio: "pipe",
    }).toString();
    expect(branches).toContain(result.branch!);
    expect(existsSync(wt.path)).toBe(false);
    // And the commit is reachable from that branch.
    const files = execFileSync("git", ["ls-tree", "--name-only", result.branch!], {
      cwd: repoDir, stdio: "pipe",
    }).toString();
    expect(files).toContain("work.txt");
  });
});

describe("cleanupWorktree — submodules", () => {
  let repoDir: string;
  let subDir: string;
  let pi: ExtensionAPI;

  const run = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "protocol.file.allow=always", ...args], { cwd, stdio: "pipe" }).toString();

  beforeEach(() => {
    pi = mockPi();
    subDir = initGitRepo();
    repoDir = initGitRepo();
    run(repoDir, "submodule", "add", subDir, "sub");
    run(repoDir, "commit", "-m", "add submodule");
    // Worktree submodules clone via the file transport, same as the fixture above.
    run(repoDir, "config", "protocol.file.allow", "always");
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(subDir, { recursive: true, force: true });
  });

  async function populatedWorktree(id: string) {
    const wt = await createWorktree(pi, repoDir, id);
    run(wt.path, "submodule", "update", "--init", "--recursive");
    return wt;
  }

  it("removes a clean worktree whose submodule is populated", async () => {
    const wt = await populatedWorktree("clean-sub");
    const result = await cleanupWorktree(pi, repoDir, wt, "clean sub");
    expect(result).toEqual({ hasChanges: false });
    expect(existsSync(wt.path)).toBe(false);
  });

  it("keeps the worktree with a distinct error when a submodule has uncommitted work", async () => {
    const wt = await populatedWorktree("dirty-sub");
    writeFileSync(join(wt.path, "sub", "agent.txt"), "unsaved");
    try {
      const result = await cleanupWorktree(pi, repoDir, wt, "dirty sub");
      expect(result.path).toBe(wt.path);
      expect(result.error).toMatch(/submodule work would be lost/);
      expect(existsSync(join(wt.path, "sub", "agent.txt"))).toBe(true);
    } finally {
      if (existsSync(wt.path)) execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir });
    }
  });

  it("keeps the worktree when a submodule holds an unpushed commit", async () => {
    const wt = await populatedWorktree("unpushed-sub");
    const sub = join(wt.path, "sub");
    writeFileSync(join(sub, "x.txt"), "x");
    run(sub, "add", "x.txt");
    run(sub, "-c", "user.email=t@t.com", "-c", "user.name=T", "commit", "-m", "local only");
    try {
      const result = await cleanupWorktree(pi, repoDir, wt, "unpushed sub");
      expect(result.path).toBe(wt.path);
      expect(result.error).toMatch(/submodule work would be lost/);
    } finally {
      if (existsSync(wt.path)) execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir });
    }
  });

  it("keeps the worktree when outer work appears before the forced submodule removal", async () => {
    const wt = await populatedWorktree("late-sub");
    const late = {
      exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
        const result = await pi.exec(command, args, options);
        if (args[0] === "worktree" && args[1] === "remove") writeFileSync(join(wt.path, "late.txt"), "late");
        return result;
      },
    } as unknown as ExtensionAPI;
    try {
      const result = await cleanupWorktree(late, repoDir, wt, "late sub");
      expect(result.path).toBe(wt.path);
      expect(result.error).toBeDefined();
      expect(existsSync(join(wt.path, "late.txt"))).toBe(true);
    } finally {
      if (existsSync(wt.path)) execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir });
    }
  });
});

/**
 * The project switch itself (`worktreeIsolation`, #184). Its consumers —
 * agent-manager, both tool schemas, the invocation resolver — all mock this
 * module, so without this block the real singleton is never executed and its
 * default is never exercised. That default is what every "worktree isolation
 * still behaves as before" claim rests on.
 */
describe("worktree isolation switch", () => {
  afterEach(() => setWorktreeIsolationEnabled(true));

  it("defaults to enabled", () => {
    expect(isWorktreeIsolationEnabled()).toBe(true);
  });

  it("round-trips both ways", () => {
    setWorktreeIsolationEnabled(false);
    expect(isWorktreeIsolationEnabled()).toBe(false);
    setWorktreeIsolationEnabled(true);
    expect(isWorktreeIsolationEnabled()).toBe(true);
  });

  // The switch gates callers; it deliberately does not disarm createWorktree
  // itself, so a caller that has already decided (agent-manager checks first)
  // still gets a real worktree rather than a silent no-op.
  it("does not disable createWorktree directly", async () => {
    const repoDir = initGitRepo();
    const pi = mockPi();
    try {
      setWorktreeIsolationEnabled(false);
      const wt = await createWorktree(pi, repoDir, "switch-test");
      expect(existsSync(wt.path)).toBe(true);
      await cleanupWorktree(pi, repoDir, wt, "switch test");
    } finally {
      await pruneWorktrees(pi, repoDir);
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
