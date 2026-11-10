import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

/** `git worktree remove`, wherever `-c` options put it in argv. */
const isWorktreeRemove = (args: string[]) => args.includes("worktree") && args.includes("remove");

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
 * A pi whose exec decodes stdout like the host's: every `chunkSize`-byte chunk on its own,
 * so a multibyte character split across chunks becomes U+FFFD (a real `pi.exec` does this
 * at 64KB; a tiny chunk makes every non-ASCII byte hit the boundary).
 */
function chunkedPi(chunkSize = 1): ExtensionAPI {
  return {
    exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
      const decode = (data: Buffer | string) => {
        const bytes = Buffer.from(data);
        let text = "";
        for (let i = 0; i < bytes.length; i += chunkSize) text += bytes.subarray(i, i + chunkSize).toString();
        return text;
      };
      try {
        const stdout = execFileSync(command, args, { cwd: options?.cwd, stdio: ["pipe", "pipe", "pipe"], timeout: options?.timeout });
        return { stdout: decode(stdout), stderr: "", code: 0, killed: false };
      } catch (err) {
        const failure = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
        return { stdout: decode(failure.stdout ?? ""), stderr: String(failure.stderr ?? ""), code: failure.status ?? 1, killed: false };
      }
    },
  } as unknown as ExtensionAPI;
}

/**
 * A pi whose exec answers one git subcommand with a canned failure result and
 * runs everything else for real. `match` sees the argv git is called with.
 */
function failingPi(match: (args: string[]) => boolean, failure: { code: number; killed: boolean }, stderr = "boom"): ExtensionAPI {
  const real = mockPi();
  return {
    exec: vi.fn(async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
      if (match(args)) return { stdout: "", stderr, ...failure };
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

    it("names the failed git command when a non-zero exit has no stderr", async () => {
      await expect(createWorktree(
        failingPi(args => args[0] === "worktree" && args[1] === "add", { code: 128, killed: false }, "  \n"),
        repoDir,
        "add-fails-quiet",
      )).rejects.toThrow(/git worktree add --detach .* HEAD failed \(exit 128\)/);
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
        args => isWorktreeRemove(args),
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
      const result = await cleanupWorktree(failingPi(args => isWorktreeRemove(args), { code: 1, killed: false }), repoDir, wt, "remove fails");
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
        if (isWorktreeRemove(args)) writeFileSync(join(wt.path, "late.txt"), "late work");
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
        if (isWorktreeRemove(args)) writeFileSync(join(wt.path, "late.txt"), "late");
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

describe("cleanupWorktree — nested repositories git refuses to remove", () => {
  let repoDir: string;
  let subDir: string;
  let pi: ExtensionAPI;
  const cleanups: string[] = [];

  const run = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "protocol.file.allow=always", "-c", "user.email=t@t.com", "-c", "user.name=T", ...args], {
      cwd,
      stdio: "pipe",
    })
      .toString()
      .trim();

  beforeEach(() => {
    pi = mockPi();
    subDir = initGitRepo();
    repoDir = initGitRepo();
    run(repoDir, "config", "protocol.file.allow", "always");
  });

  afterEach(() => {
    for (const path of cleanups.splice(0)) {
      if (existsSync(path)) execFileSync("git", ["worktree", "remove", "--force", path], { cwd: repoDir });
    }
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(subDir, { recursive: true, force: true });
  });

  /** A worktree holding a nested clone `dep` with a commit that exists nowhere else. */
  async function worktreeWithLocalOnlyNestedRepo(id: string) {
    const wt = await createWorktree(pi, repoDir, id);
    cleanups.push(wt.path);
    run(wt.path, "clone", subDir, "dep");
    const dep = join(wt.path, "dep");
    writeFileSync(join(dep, "precious.txt"), "unpublished");
    run(dep, "add", "precious.txt");
    run(dep, "commit", "-m", "local only");
    return { wt, dep, sha: run(dep, "rev-parse", "HEAD") };
  }

  it("keeps a worktree whose agent recorded a nested clone as a gitlink with no .gitmodules", async () => {
    const { wt, dep, sha } = await worktreeWithLocalOnlyNestedRepo("gitlink-committed");
    run(wt.path, "add", "-A");
    run(wt.path, "commit", "-m", "record dep");
    expect(run(wt.path, "status", "--porcelain")).toBe("");
    const result = await cleanupWorktree(pi, repoDir, wt, "gitlink");
    expect(result.path).toBe(wt.path);
    expect(result.error).toMatch(/submodule work would be lost/);
    expect(run(dep, "rev-parse", "HEAD")).toBe(sha);
  });

  it("keeps a worktree when its own preservation commit records the nested clone", async () => {
    const { wt, dep, sha } = await worktreeWithLocalOnlyNestedRepo("gitlink-uncommitted");
    const result = await cleanupWorktree(pi, repoDir, wt, "gitlink");
    expect(result.path).toBe(wt.path);
    expect(result.error).toMatch(/submodule work would be lost/);
    expect(run(dep, "rev-parse", "HEAD")).toBe(sha);
  });

  async function worktreeWithSubmodule(id: string) {
    run(repoDir, "submodule", "add", subDir, "sub");
    run(repoDir, "commit", "-m", "add submodule");
    const wt = await createWorktree(pi, repoDir, id);
    cleanups.push(wt.path);
    run(wt.path, "submodule", "update", "--init", "--recursive");
    const sub = join(wt.path, "sub");
    writeFileSync(join(sub, "precious.txt"), "unpublished");
    run(sub, "add", "precious.txt");
    run(sub, "commit", "-m", "local only");
    return { wt, sub, sha: run(sub, "rev-parse", "HEAD") };
  }

  it("detects unpublished commits in a submodule at a non-ASCII path when stdout is decoded chunk by chunk", async () => {
    run(repoDir, "submodule", "add", subDir, "d\u00e9p");
    run(repoDir, "commit", "-m", "add submodule");
    const wt = await createWorktree(pi, repoDir, "gitlink-accent");
    cleanups.push(wt.path);
    run(wt.path, "submodule", "update", "--init", "--recursive");
    const sub = join(wt.path, "d\u00e9p");
    writeFileSync(join(sub, "precious.txt"), "unpublished");
    run(sub, "add", "precious.txt");
    run(sub, "commit", "-m", "local only");
    const sha = run(sub, "rev-parse", "HEAD");
    const result = await cleanupWorktree(chunkedPi(), repoDir, wt, "gitlink accent");
    expect(result.path).toBe(wt.path);
    expect(result.error).toMatch(/submodule work would be lost[\s\S]*d\u00e9p/);
    expect(run(sub, "rev-parse", "HEAD")).toBe(sha);
  });

  it("keeps the worktree when the agent deleted .gitmodules over a submodule with unpushed commits", async () => {
    const { wt, sub, sha } = await worktreeWithSubmodule("no-gitmodules");
    rmSync(join(wt.path, ".gitmodules"));
    const result = await cleanupWorktree(pi, repoDir, wt, "gitmodules gone");
    expect(result.path).toBe(wt.path);
    expect(result.error).toMatch(/submodule work would be lost/);
    expect(run(sub, "rev-parse", "HEAD")).toBe(sha);
  });

  it("keeps the worktree when a deinitialized submodule leaves unpushed commits in the modules dir", async () => {
    const { wt } = await worktreeWithSubmodule("deinit");
    run(wt.path, "submodule", "deinit", "-f", "sub");
    const result = await cleanupWorktree(pi, repoDir, wt, "deinit");
    expect(result.path).toBe(wt.path);
    expect(result.error).toMatch(/submodule work would be lost/);
    const modules = run(wt.path, "rev-parse", "--path-format=absolute", "--git-path", "modules/sub");
    expect(existsSync(modules)).toBe(true);
  });

  it("removes a deinitialized submodule that holds nothing unpublished", async () => {
    run(repoDir, "submodule", "add", subDir, "sub");
    run(repoDir, "commit", "-m", "add submodule");
    const wt = await createWorktree(pi, repoDir, "deinit-clean");
    cleanups.push(wt.path);
    run(wt.path, "submodule", "update", "--init", "--recursive");
    run(wt.path, "submodule", "deinit", "-f", "sub");
    expect(await cleanupWorktree(pi, repoDir, wt, "deinit clean")).toEqual({ hasChanges: false });
    expect(existsSync(wt.path)).toBe(false);
  });

  it("keeps the worktree when a submodule nested inside a submodule holds an unpushed commit", async () => {
    const innerDir = initGitRepo();
    try {
      run(subDir, "submodule", "add", innerDir, "inner");
      run(subDir, "commit", "-m", "add inner");
      run(repoDir, "submodule", "add", subDir, "sub");
      run(repoDir, "commit", "-m", "add sub");
      const wt = await createWorktree(pi, repoDir, "nested-nested");
      cleanups.push(wt.path);
      run(wt.path, "submodule", "update", "--init", "--recursive");
      const inner = join(wt.path, "sub", "inner");
      writeFileSync(join(inner, "precious.txt"), "unpublished");
      run(inner, "add", "precious.txt");
      run(inner, "commit", "-m", "local only");
      const sha = run(inner, "rev-parse", "HEAD");
      const result = await cleanupWorktree(pi, repoDir, wt, "nested nested");
      expect(result.path).toBe(wt.path);
      expect(result.error).toMatch(/inner/);
      expect(run(inner, "rev-parse", "HEAD")).toBe(sha);
    } finally {
      rmSync(innerDir, { recursive: true, force: true });
    }
  });

  it("decides the forced removal structurally, not from git's English message", async () => {
    run(repoDir, "submodule", "add", subDir, "sub");
    run(repoDir, "commit", "-m", "add submodule");
    const wt = await createWorktree(pi, repoDir, "locale");
    cleanups.push(wt.path);
    run(wt.path, "submodule", "update", "--init", "--recursive");
    const german = {
      exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
        const result = await pi.exec(command, args, options);
        if (isWorktreeRemove(args) && result.code !== 0) {
          return { ...result, stderr: "fatal: Arbeitsverzeichnisse mit Submodulen koennen nicht verschoben werden" };
        }
        return result;
      },
    } as unknown as ExtensionAPI;
    expect(await cleanupWorktree(german, repoDir, wt, "locale")).toEqual({ hasChanges: false });
    expect(existsSync(wt.path)).toBe(false);
  });

  it("rethrows a removal failure that has nothing to do with submodules", async () => {
    const wt = await createWorktree(pi, repoDir, "plain-failure");
    cleanups.push(wt.path);
    const result = await cleanupWorktree(failingPi(isWorktreeRemove, { code: 1, killed: false }), repoDir, wt, "plain");
    expect(result).toMatchObject({ path: wt.path, error: "boom" });
  });

  it("refuses the forced removal when the outer tree is dirty", async () => {
    run(repoDir, "submodule", "add", subDir, "sub");
    run(repoDir, "commit", "-m", "add submodule");
    const wt = await createWorktree(pi, repoDir, "late-dirty");
    cleanups.push(wt.path);
    run(wt.path, "submodule", "update", "--init", "--recursive");
    const late = {
      exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
        const result = await pi.exec(command, args, options);
        if (isWorktreeRemove(args)) writeFileSync(join(wt.path, "late.txt"), "late");
        return result;
      },
    } as unknown as ExtensionAPI;
    const result = await cleanupWorktree(late, repoDir, wt, "late");
    expect(result.path).toBe(wt.path);
    expect(existsSync(join(wt.path, "late.txt"))).toBe(true);
  });

  it("removes a clean worktree whose submodule HEAD was fetched by sha and no remote ref contains", async () => {
    run(subDir, "config", "uploadpack.allowAnySHA1InWant", "true");
    run(repoDir, "submodule", "add", subDir, "sub");
    const main = run(subDir, "rev-parse", "--abbrev-ref", "HEAD");
    run(subDir, "checkout", "--detach");
    writeFileSync(join(subDir, "side.txt"), "side");
    run(subDir, "add", "side.txt");
    run(subDir, "commit", "-m", "unreachable from any branch");
    const side = run(subDir, "rev-parse", "HEAD");
    run(subDir, "checkout", main);
    run(repoDir, "update-index", "--cacheinfo", `160000,${side},sub`);
    run(repoDir, "commit", "-m", "add submodule at side commit");
    const wt = await createWorktree(pi, repoDir, "by-sha");
    cleanups.push(wt.path);
    run(wt.path, "submodule", "update", "--init", "--recursive");
    expect(run(join(wt.path, "sub"), "rev-parse", "HEAD")).toBe(side);
    expect(run(join(wt.path, "sub"), "branch", "-r", "--contains", side)).toBe("");
    expect(await cleanupWorktree(pi, repoDir, wt, "by sha")).toEqual({ hasChanges: false });
    expect(existsSync(wt.path)).toBe(false);
  });

  it("keeps the worktree when a submodule carries a tag on a commit no remote branch holds (fails safe offline)", async () => {
    run(repoDir, "submodule", "add", subDir, "sub");
    run(repoDir, "commit", "-m", "add submodule");
    const wt = await createWorktree(pi, repoDir, "tag");
    cleanups.push(wt.path);
    run(wt.path, "submodule", "update", "--init", "--recursive");
    const sub = join(wt.path, "sub");
    const main = run(subDir, "rev-parse", "--abbrev-ref", "HEAD");
    run(subDir, "checkout", "--detach");
    run(subDir, "commit", "--allow-empty", "-m", "tagged, on no branch");
    run(subDir, "tag", "--no-sign", "-m", "release", "v1");
    run(subDir, "checkout", main);
    run(sub, "fetch", "--tags");
    expect(run(sub, "rev-list", "--tags", "--not", "--remotes")).not.toBe("");
    const result = await cleanupWorktree(pi, repoDir, wt, "tag");
    expect(result.error).toMatch(/submodule work would be lost/);
    expect(existsSync(wt.path)).toBe(true);
  });

  it("keeps the worktree when a nested clone holds a commit only a local tag reaches", async () => {
    const { wt, dep, sha } = await worktreeWithLocalOnlyNestedRepo("local-tag");
    const branch = run(dep, "rev-parse", "--abbrev-ref", "HEAD");
    run(dep, "tag", "--no-sign", "-m", "keep", "precious");
    run(dep, "checkout", "--detach", "HEAD~1");
    run(dep, "branch", "-D", branch);
    expect(run(dep, "rev-list", "--branches", "HEAD", "--not", "--remotes")).toBe("");
    run(wt.path, "add", "-A");
    const result = await cleanupWorktree(pi, repoDir, wt, "local tag");
    expect(result.error).toMatch(/submodule work would be lost/);
    expect(run(dep, "cat-file", "-t", sha)).toBe("commit");
    expect(existsSync(wt.path)).toBe(true);
  });

  it("keeps the worktree when a gitignored nested clone holds an unpushed commit", async () => {
    writeFileSync(join(repoDir, ".gitignore"), "vendor/\n");
    run(repoDir, "add", ".gitignore");
    run(repoDir, "commit", "-m", "ignore vendor");
    const wt = await createWorktree(pi, repoDir, "ignored-clone");
    cleanups.push(wt.path);
    mkdirSync(join(wt.path, "vendor"));
    run(join(wt.path, "vendor"), "clone", subDir, "dep");
    const dep = join(wt.path, "vendor", "dep");
    writeFileSync(join(dep, "precious.txt"), "unpublished");
    run(dep, "add", "precious.txt");
    run(dep, "commit", "-m", "local only");
    expect(run(wt.path, "status", "--porcelain")).toBe("");
    const result = await cleanupWorktree(pi, repoDir, wt, "ignored clone");
    expect(result.error).toMatch(/submodule work would be lost[\s\S]*vendor\/dep/);
    expect(existsSync(join(dep, "precious.txt"))).toBe(true);
  });

  it("removes a clean worktree with a gitignored nested clone holding nothing unpublished", async () => {
    writeFileSync(join(repoDir, ".gitignore"), "vendor/\n");
    run(repoDir, "add", ".gitignore");
    run(repoDir, "commit", "-m", "ignore vendor");
    const wt = await createWorktree(pi, repoDir, "ignored-clean");
    cleanups.push(wt.path);
    mkdirSync(join(wt.path, "vendor"));
    run(join(wt.path, "vendor"), "clone", subDir, "dep");
    expect(await cleanupWorktree(pi, repoDir, wt, "ignored clean")).toEqual({ hasChanges: false });
    expect(existsSync(wt.path)).toBe(false);
  });

  /** Commit a `.gitignore` in the nested-repo source, before anything clones it. */
  function ignoreInSource(patterns: string): void {
    writeFileSync(join(subDir, ".gitignore"), patterns);
    run(subDir, "add", ".gitignore");
    run(subDir, "commit", "-m", "ignore");
  }

  /** Register `subDir` as submodule `sub` of the outer repo. */
  function addSubmodule(): void {
    run(repoDir, "submodule", "add", subDir, "sub");
    run(repoDir, "commit", "-m", "add submodule");
  }

  async function populatedWorktree(id: string) {
    const wt = await createWorktree(pi, repoDir, id);
    cleanups.push(wt.path);
    run(wt.path, "submodule", "update", "--init", "--recursive");
    return wt;
  }

  it("keeps the worktree when a gitignored nested clone inside a submodule holds an unpushed commit", async () => {
    ignoreInSource("vendor/\n");
    addSubmodule();
    const wt = await populatedWorktree("ignored-in-sub");
    const vendor = join(wt.path, "sub", "vendor");
    mkdirSync(vendor);
    run(vendor, "clone", subDir, "x");
    const x = join(vendor, "x");
    writeFileSync(join(x, "precious.txt"), "unpublished");
    run(x, "add", "precious.txt");
    run(x, "commit", "-m", "local only");
    expect(run(wt.path, "status", "--porcelain")).toBe("");
    expect(run(join(wt.path, "sub"), "status", "--porcelain")).toBe("");
    const result = await cleanupWorktree(pi, repoDir, wt, "ignored in sub");
    expect(result.error).toMatch(/submodule work would be lost[\s\S]*vendor\/x/);
    expect(existsSync(join(x, "precious.txt"))).toBe(true);
  });

  it("keeps the worktree when a gitignored clone nested inside a gitignored clone holds an unpushed commit", async () => {
    ignoreInSource("build/\n");
    writeFileSync(join(repoDir, ".gitignore"), "vendor/\n");
    run(repoDir, "add", ".gitignore");
    run(repoDir, "commit", "-m", "ignore vendor");
    const wt = await createWorktree(pi, repoDir, "ignored-in-ignored");
    cleanups.push(wt.path);
    mkdirSync(join(wt.path, "vendor"));
    run(join(wt.path, "vendor"), "clone", subDir, "a");
    const build = join(wt.path, "vendor", "a", "build");
    mkdirSync(build);
    run(build, "clone", subDir, "b");
    const b = join(build, "b");
    writeFileSync(join(b, "precious.txt"), "unpublished");
    run(b, "add", "precious.txt");
    run(b, "commit", "-m", "local only");
    expect(run(join(wt.path, "vendor", "a"), "status", "--porcelain")).toBe("");
    const result = await cleanupWorktree(pi, repoDir, wt, "ignored in ignored");
    expect(result.error).toMatch(/submodule work would be lost[\s\S]*build\/b/);
    expect(existsSync(join(b, "precious.txt"))).toBe(true);
  });

  it("ignores a stray file in the modules dir while checking submodule git dirs", async () => {
    addSubmodule();
    const wt = await populatedWorktree("stray-module-file");
    const modules = run(wt.path, "rev-parse", "--path-format=absolute", "--git-path", "modules");
    writeFileSync(join(modules, "stray.txt"), "not a git dir");
    expect(await cleanupWorktree(pi, repoDir, wt, "stray")).toEqual({ hasChanges: false });
    expect(existsSync(wt.path)).toBe(false);
  });

  it("does not count another submodule's sha against a deinitialized git dir that lacks the object", async () => {
    addSubmodule();
    const otherDir = initGitRepo();
    try {
      // Identical fixtures can hash to the same commit within one second; rewrite the root so the shas differ.
      run(otherDir, "commit", "--amend", "--allow-empty", "-m", "unrelated root");
      run(repoDir, "submodule", "add", otherDir, "other");
      run(repoDir, "commit", "-m", "add second submodule");
      const wt = await populatedWorktree("unknown-published");
      const otherSha = run(join(wt.path, "other"), "rev-parse", "HEAD").trim();
      run(wt.path, "submodule", "deinit", "-f", "sub");
      // `sub` keeps its git dir under `modules` but is no longer inspected through a gitlink,
      // so it is probed against the trusted sha of `other`, an object it does not hold.
      const orphan = join(run(wt.path, "rev-parse", "--path-format=absolute", "--git-path", "modules").trim(), "sub");
      expect(() => run(wt.path, "--git-dir", orphan, "cat-file", "-e", `${otherSha}^{commit}`)).toThrow();
      expect(await cleanupWorktree(pi, repoDir, wt, "unknown published")).toEqual({ hasChanges: false });
      expect(existsSync(wt.path)).toBe(false);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("inspects an ignored directory that points at an already inspected git dir only once", async () => {
    ignoreInSource("alias/\n");
    addSubmodule();
    const wt = await populatedWorktree("ignored-alias");
    const gitDir = run(join(wt.path, "sub"), "rev-parse", "--absolute-git-dir").trim();
    const alias = join(wt.path, "sub", "alias");
    mkdirSync(alias);
    writeFileSync(join(alias, ".git"), `gitdir: ${gitDir}\n`);
    const inAlias: string[][] = [];
    const real = pi.exec.bind(pi);
    pi.exec = (async (command: string, args: string[], options?: { cwd?: string }) => {
      if (options?.cwd && resolve(options.cwd) === alias) inAlias.push(args);
      return await real(command, args, options as never);
    }) as typeof pi.exec;
    expect(await cleanupWorktree(pi, repoDir, wt, "ignored alias")).toEqual({ hasChanges: false });
    expect(existsSync(wt.path)).toBe(false);
    // The identity lookup reads `.git` itself and finds it already `seen`: never status, probe or `HEAD`.
    expect(inAlias).toEqual([]);
  });

  it("does not let submodule ignore=all hide a bumped gitlink", async () => {
    addSubmodule();
    writeFileSync(join(repoDir, ".gitmodules"), `${readFileSync(join(repoDir, ".gitmodules"), "utf8")}\tignore = all\n`);
    run(repoDir, "add", ".gitmodules");
    run(repoDir, "commit", "-m", "ignore all");
    const wt = await populatedWorktree("ignore-all");
    const sub = join(wt.path, "sub");
    writeFileSync(join(subDir, "next.txt"), "next");
    run(subDir, "add", "next.txt");
    run(subDir, "commit", "-m", "published next");
    run(sub, "fetch", "-q", "origin");
    run(sub, "checkout", "-q", "FETCH_HEAD");
    const next = run(sub, "rev-parse", "HEAD").trim();
    expect(run(wt.path, "status", "--porcelain")).toBe("");
    const result = await cleanupWorktree(pi, repoDir, wt, "ignore all");
    expect(result.hasChanges).toBe(true);
    expect(result.branch).toBeUndefined();
    expect(result.path).toBe(wt.path);
    expect(result.error).toMatch(/could not be staged[\s\S]*sub/);
    expect(existsSync(wt.path)).toBe(true);
    expect(run(join(wt.path, "sub"), "rev-parse", "HEAD")).toBe(next);
  });

  it("removes a clean worktree whose deinitialized submodule is pinned to a sha-fetched commit", async () => {
    run(subDir, "config", "uploadpack.allowAnySHA1InWant", "true");
    run(repoDir, "submodule", "add", subDir, "sub");
    const main = run(subDir, "rev-parse", "--abbrev-ref", "HEAD");
    run(subDir, "checkout", "--detach");
    writeFileSync(join(subDir, "side.txt"), "side");
    run(subDir, "add", "side.txt");
    run(subDir, "commit", "-m", "unreachable from any branch");
    const side = run(subDir, "rev-parse", "HEAD");
    run(subDir, "checkout", main);
    run(repoDir, "update-index", "--cacheinfo", `160000,${side},sub`);
    run(repoDir, "commit", "-m", "add submodule at side commit");
    const wt = await createWorktree(pi, repoDir, "deinit-by-sha");
    cleanups.push(wt.path);
    run(wt.path, "submodule", "update", "--init", "--recursive");
    run(wt.path, "submodule", "deinit", "-f", "sub");
    expect(await cleanupWorktree(pi, repoDir, wt, "deinit by sha")).toEqual({ hasChanges: false });
    expect(existsSync(wt.path)).toBe(false);
  });
});

describe("cleanupWorktree — status.showUntrackedFiles=no", () => {
  let repoDir: string;
  let pi: ExtensionAPI;
  beforeEach(() => {
    pi = mockPi();
    repoDir = initGitRepo();
    execFileSync("git", ["config", "status.showUntrackedFiles", "no"], { cwd: repoDir });
  });
  afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

  it("preserves a worktree whose only change is an untracked file", async () => {
    const wt = await createWorktree(pi, repoDir, "untracked-hidden");
    writeFileSync(join(wt.path, "new.txt"), "agent work");
    const result = await cleanupWorktree(pi, repoDir, wt, "untracked hidden");
    expect(result.hasChanges).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.branch).toBeDefined();
    const kept = execFileSync("git", ["show", `${result.branch}:new.txt`], { cwd: repoDir }).toString();
    expect(kept).toBe("agent work");
    expect(existsSync(wt.path)).toBe(false);
  });

  it("refuses to remove an untracked file written after the status check", async () => {
    const wt = await createWorktree(pi, repoDir, "late-untracked");
    const late = {
      exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
        if (isWorktreeRemove(args)) writeFileSync(join(wt.path, "late.txt"), "late work");
        return pi.exec(command, args, options);
      },
    } as unknown as ExtensionAPI;
    const result = await cleanupWorktree(late, repoDir, wt, "late untracked");
    expect(result.path).toBe(wt.path);
    expect(result.error).toBeDefined();
    expect(existsSync(join(wt.path, "late.txt"))).toBe(true);
    execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir });
  });

  it("keeps a nested clone whose only dirt is an untracked file", async () => {
    const subDir = initGitRepo();
    try {
      const wt = await createWorktree(pi, repoDir, "nested-untracked");
      const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" });
      git(wt.path, "clone", subDir, "dep");
      git(join(wt.path, "dep"), "config", "status.showUntrackedFiles", "no");
      writeFileSync(join(wt.path, "dep", "scratch.txt"), "agent work");
      const result = await cleanupWorktree(pi, repoDir, wt, "nested untracked");
      expect(result.error).toMatch(/submodule work would be lost[\s\S]*scratch\.txt/);
      expect(existsSync(join(wt.path, "dep", "scratch.txt"))).toBe(true);
      execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir });
    } finally {
      rmSync(subDir, { recursive: true, force: true });
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

describe("cleanupWorktree — index bits and ignored path decoding (#596)", () => {
  let repoDir: string;
  let subDir: string;
  let pi: ExtensionAPI;
  const cleanups: string[] = [];

  const run = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "protocol.file.allow=always", "-c", "user.email=t@t.com", "-c", "user.name=T", ...args], {
      cwd,
      stdio: "pipe",
    })
      .toString()
      .trim();

  beforeEach(() => {
    pi = mockPi();
    subDir = initGitRepo();
    repoDir = initGitRepo();
    writeFileSync(join(repoDir, "tracked.txt"), "original");
    writeFileSync(join(repoDir, "run.sh"), "#!/bin/sh\n");
    run(repoDir, "add", "tracked.txt", "run.sh");
    run(repoDir, "commit", "-m", "tracked");
  });

  afterEach(() => {
    for (const path of cleanups.splice(0)) {
      if (existsSync(path)) execFileSync("git", ["worktree", "remove", "--force", path], { cwd: repoDir });
    }
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(subDir, { recursive: true, force: true });
  });

  async function worktree(id: string) {
    const wt = await createWorktree(pi, repoDir, id);
    cleanups.push(wt.path);
    return wt;
  }

  it.each([
    ["assume-unchanged", "--assume-unchanged"],
    ["skip-worktree", "--skip-worktree"],
  ])("preserves an edit hidden by %s", async (id, flag) => {
    const wt = await worktree(id);
    run(wt.path, "update-index", flag, "tracked.txt");
    writeFileSync(join(wt.path, "tracked.txt"), "agent edit");
    expect(run(wt.path, "status", "--porcelain")).toBe("");
    const result = await cleanupWorktree(pi, repoDir, wt, id);
    expect(result.error).toBeUndefined();
    expect(result.hasChanges).toBe(true);
    expect(run(repoDir, "show", `${result.branch}:tracked.txt`)).toBe("agent edit");
    expect(existsSync(wt.path)).toBe(false);
  });

  it("preserves an edit hidden by both assume-unchanged and skip-worktree", async () => {
    const wt = await worktree("both-bits");
    run(wt.path, "update-index", "--assume-unchanged", "--skip-worktree", "tracked.txt");
    writeFileSync(join(wt.path, "tracked.txt"), "agent edit");
    const result = await cleanupWorktree(pi, repoDir, wt, "both bits");
    expect(result.error).toBeUndefined();
    expect(run(repoDir, "show", `${result.branch}:tracked.txt`)).toBe("agent edit");
  });

  it("preserves a staged mode change from update-index --chmod", async () => {
    const wt = await worktree("chmod");
    run(wt.path, "update-index", "--chmod=+x", "run.sh");
    const result = await cleanupWorktree(pi, repoDir, wt, "chmod");
    expect(result.error).toBeUndefined();
    expect(result.hasChanges).toBe(true);
    expect(run(repoDir, "ls-tree", result.branch as string, "run.sh")).toMatch(/^100755 /);
  });

  it("preserves an index-only chmod on a newly staged file", async () => {
    const wt = await worktree("chmod-new");
    writeFileSync(join(wt.path, "new.sh"), "#!/bin/sh\n");
    run(wt.path, "add", "new.sh");
    run(wt.path, "update-index", "--chmod=+x", "new.sh");
    const result = await cleanupWorktree(pi, repoDir, wt, "chmod new");
    expect(result.error).toBeUndefined();
    expect(run(repoDir, "ls-tree", result.branch as string, "new.sh")).toMatch(/^100755 /);
  });

  it("keeps a later chmod on a newly added file", async () => {
    const wt = await worktree("chmod-after-add");
    writeFileSync(join(wt.path, "new.sh"), "#!/bin/sh\n");
    run(wt.path, "add", "new.sh");
    chmodSync(join(wt.path, "new.sh"), 0o755);
    const result = await cleanupWorktree(pi, repoDir, wt, "chmod after add");
    expect(result.error).toBeUndefined();
    expect(run(repoDir, "ls-tree", result.branch as string, "new.sh")).toMatch(/^100755 /);
  });

  it("keeps a chmod made after an edit of a newly added file", async () => {
    const wt = await worktree("edit-then-chmod");
    writeFileSync(join(wt.path, "new.sh"), "#!/bin/sh\n");
    run(wt.path, "add", "new.sh");
    writeFileSync(join(wt.path, "new.sh"), "#!/bin/sh\necho edited\n");
    chmodSync(join(wt.path, "new.sh"), 0o755);
    const result = await cleanupWorktree(pi, repoDir, wt, "edit then chmod");
    expect(result.error).toBeUndefined();
    expect(run(repoDir, "ls-tree", result.branch as string, "new.sh")).toMatch(/^100755 /);
    expect(run(repoDir, "show", `${result.branch}:new.sh`)).toContain("edited");
  });

  it("keeps a leading-space filename and its index-only chmod", async () => {
    const wt = await worktree("space-name");
    writeFileSync(join(wt.path, " lead.sh"), "#!/bin/sh\n");
    run(wt.path, "add", "--", " lead.sh");
    run(wt.path, "update-index", "--chmod=+x", "--", " lead.sh");
    const result = await cleanupWorktree(pi, repoDir, wt, "space name");
    expect(result.error).toBeUndefined();
    expect(run(repoDir, "ls-tree", result.branch as string, "--", " lead.sh")).toMatch(/^100755 /);
  });

  it("removes a worktree whose staged +x the agent reverted on disk", async () => {
    const wt = await worktree("chmod-after-stage");
    chmodSync(join(wt.path, "run.sh"), 0o755);
    run(wt.path, "add", "run.sh");
    chmodSync(join(wt.path, "run.sh"), 0o644);
    expect(await cleanupWorktree(pi, repoDir, wt, "chmod after stage")).toEqual({ hasChanges: false });
    expect(existsSync(wt.path)).toBe(false);
  });

  it("preserves a staged mode removal (--chmod=-x)", async () => {
    const wt = await worktree("chmod-minus");
    chmodSync(join(wt.path, "run.sh"), 0o755);
    run(wt.path, "add", "run.sh");
    run(wt.path, "commit", "-m", "exec");
    run(wt.path, "update-index", "--chmod=-x", "run.sh");
    const result = await cleanupWorktree(pi, repoDir, wt, "chmod minus");
    expect(result.error).toBeUndefined();
    expect(run(repoDir, "ls-tree", result.branch as string, "run.sh")).toMatch(/^100644 /);
  });

  it("preserves a deletion of a file whose mode change was staged", async () => {
    const wt = await worktree("chmod-delete");
    run(wt.path, "update-index", "--chmod=+x", "run.sh");
    rmSync(join(wt.path, "run.sh"));
    const result = await cleanupWorktree(pi, repoDir, wt, "chmod delete");
    expect(result.error).toBeUndefined();
    expect(run(repoDir, "ls-tree", "--name-only", result.branch as string)).not.toMatch(/run\.sh/);
  });

  it.each([
    ["accent", "caf\u00e9.txt"],
    ["newline", "a\nb.txt"],
    ["leading dash", "-dash.txt"],
    ["quote and backslash", 'say "hi" \\ x.txt'],
    ["real U+FFFD", "a\uFFFDb.txt"],
    ["emoji", "\u{1F600} z.txt"],
  ])("classifies a %s filename correctly when stdout is decoded chunk by chunk", async (id, name) => {
    writeFileSync(join(repoDir, name), "original");
    run(repoDir, "add", "--", name);
    run(repoDir, "commit", "-m", "name");
    const wt = await worktree(`name-${id.replace(/\W/g, "")}`);
    run(wt.path, "update-index", "--skip-worktree", "--", name);
    writeFileSync(join(wt.path, name), "agent edit");
    const result = await cleanupWorktree(chunkedPi(), repoDir, wt, id);
    expect(result.error).toBeUndefined();
    expect(run(repoDir, "show", `${result.branch}:${name}`)).toBe("agent edit");
    expect(existsSync(wt.path)).toBe(false);
  });

  it("restores an index-only chmod on a non-ASCII filename under chunked decoding", async () => {
    const wt = await worktree("chmod-accent");
    writeFileSync(join(wt.path, "n\u00e9w.sh"), "#!/bin/sh\n");
    run(wt.path, "add", "n\u00e9w.sh");
    run(wt.path, "update-index", "--chmod=+x", "n\u00e9w.sh");
    const result = await cleanupWorktree(chunkedPi(), repoDir, wt, "chmod accent");
    expect(result.error).toBeUndefined();
    expect(run(repoDir, "ls-tree", "--name-only", "-z", result.branch as string)).toContain("n\u00e9w.sh");
    expect(run(repoDir, "ls-tree", result.branch as string, "--", "n\u00e9w.sh")).toMatch(/^100755 /);
  });

  it("preserves a skip-worktree file replaced by a symlink", async () => {
    const wt = await worktree("skip-symlink");
    run(wt.path, "update-index", "--skip-worktree", "tracked.txt");
    rmSync(join(wt.path, "tracked.txt"));
    symlinkSync("README.md", join(wt.path, "tracked.txt"));
    const result = await cleanupWorktree(pi, repoDir, wt, "skip symlink");
    expect(result.error).toBeUndefined();
    expect(run(repoDir, "ls-tree", result.branch as string, "tracked.txt")).toMatch(/^120000 /);
  });

  it("removes a worktree whose skip-worktree file is simply absent", async () => {
    const wt = await worktree("sparse");
    run(wt.path, "update-index", "--skip-worktree", "tracked.txt");
    rmSync(join(wt.path, "tracked.txt"));
    expect(await cleanupWorktree(pi, repoDir, wt, "sparse")).toEqual({ hasChanges: false });
    expect(existsSync(wt.path)).toBe(false);
  });

  it("removes a worktree whose index bits hide no edit", async () => {
    const wt = await worktree("bits-clean");
    run(wt.path, "update-index", "--assume-unchanged", "tracked.txt");
    expect(await cleanupWorktree(pi, repoDir, wt, "bits clean")).toEqual({ hasChanges: false });
    expect(existsSync(wt.path)).toBe(false);
  });

  it("keeps a nested clone whose edit is hidden by assume-unchanged", async () => {
    const wt = await worktree("nested-bits");
    run(wt.path, "clone", subDir, "dep");
    const dep = join(wt.path, "dep");
    run(dep, "update-index", "--assume-unchanged", "README.md");
    writeFileSync(join(dep, "README.md"), "agent edit");
    const result = await cleanupWorktree(pi, repoDir, wt, "nested bits");
    expect(result.error).toMatch(/submodule work would be lost[\s\S]*README\.md/);
    expect(readFileSync(join(dep, "README.md"), "utf8")).toBe("agent edit");
  });

  /** An ignored nested clone with an unpublished commit, under an awkwardly named ignored directory. */
  async function worktreeWithIgnoredClone(id: string, ignoredDir: string) {
    writeFileSync(join(repoDir, ".gitignore"), "vendor/\n");
    run(repoDir, "add", ".gitignore");
    run(repoDir, "commit", "-m", "ignore vendor");
    const wt = await worktree(id);
    const parent = join(wt.path, "vendor", ignoredDir);
    mkdirSync(parent, { recursive: true });
    run(parent, "clone", subDir, "dep");
    const dep = join(parent, "dep");
    writeFileSync(join(dep, "precious.txt"), "unpublished");
    run(dep, "add", "precious.txt");
    run(dep, "commit", "-m", "local only");
    return { wt, dep };
  }

  it.each([
    ["spaces", "my dir"],
    ["unicode", "d\u00e9p\u00f4t \u2603"],
    ["quotes", 'say "hi" \\ it\'s'],
  ])("keeps an ignored nested clone under a path with %s", async (id, name) => {
    const { wt, dep } = await worktreeWithIgnoredClone(`ignored-${id}`, name);
    const result = await cleanupWorktree(pi, repoDir, wt, id);
    expect(result.error).toMatch(/submodule work would be lost/);
    expect(existsSync(join(dep, "precious.txt"))).toBe(true);
  });

  it("finds an ignored nested clone under a non-ASCII path when stdout is decoded chunk by chunk", async () => {
    const { wt, dep } = await worktreeWithIgnoredClone("ignored-chunked", "d\u00e9p\u00f4t");
    const result = await cleanupWorktree(chunkedPi(), repoDir, wt, "ignored chunked");
    expect(result.error).toMatch(/submodule work would be lost/);
    expect(result.path).toBe(wt.path);
    expect(existsSync(join(dep, "precious.txt"))).toBe(true);
  });
});
