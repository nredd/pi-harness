/**
 * worktree.ts — Git worktree isolation for agents.
 *
 * Creates a temporary git worktree so the agent works on an isolated copy of the repo.
 * On completion, if no changes were made and nothing in it would be lost, the worktree is cleaned up.
 * If changes exist, a branch is created and returned in the result.
 * If git cannot inspect, commit or remove, the worktree is kept and the result carries `error` and `path`.
 *
 * Every git call goes through `pi.exec` (async) rather than `execFileSync`: a
 * worktree copy can take seconds, and a session that spawns several isolated
 * agents at once would otherwise serialize them all on the TUI's event loop.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface WorktreeInfo {
  /** Absolute path to the worktree directory (the copied repo's root). */
  path: string;
  /** Branch name created for this worktree (if changes exist). */
  branch: string;
  /** Commit SHA that the worktree was created from. */
  baseSha: string;
  /** Resolved toplevel of the repo the worktree was created from; the result branch lands here. */
  repoRoot: string;
  /**
   * Where the agent should work inside the worktree: the equivalent of the
   * cwd the worktree was created from. Equals `path` when that cwd was the
   * repo root; points at the copied subdirectory when it was deeper (e.g. a
   * monorepo package), so the requested scoping survives isolation.
   */
  workPath: string;
}

/**
 * Project-wide switch for worktree isolation (`worktreeIsolation` in
 * subagents.json). Default `true` — unchanged behaviour.
 *
 * The `"off"` isolation value gives a model a legal way to decline a worktree,
 * but it still depends on the model choosing it. This is the deterministic half
 * of the same fix: on a large repo where every worktree costs real time and
 * disk (#184), turning it off means no caller can create one, whatever it
 * passes.
 */
let worktreeIsolationEnabled = true;

export function setWorktreeIsolationEnabled(enabled: boolean): void {
  worktreeIsolationEnabled = enabled;
}

export function isWorktreeIsolationEnabled(): boolean {
  return worktreeIsolationEnabled;
}

export interface WorktreeCleanupResult {
  /** Whether changes were found in the worktree. */
  hasChanges: boolean;
  /** Branch name if changes were committed. */
  branch?: string;
  /** Worktree path if it was kept. */
  path?: string;
  /** Cleanup failure; the worktree may contain uncommitted or unreachable work. */
  error?: string;
}

/**
 * Run git and return its trimmed stdout, throwing on failure so callers keep
 * the try/catch control flow `execFileSync` gave them.
 *
 * `pi.exec` never rejects — it reports failure in the result — and a command
 * killed by its timeout comes back as `killed` with an exit code of 0, so both
 * have to be checked to reproduce `execFileSync`'s "throws on anything but a
 * clean exit".
 */
async function git(pi: ExtensionAPI, cwd: string, args: string[], timeout: number): Promise<string> {
  const result = await pi.exec("git", args, { cwd, timeout });
  if (result.killed) throw new GitTimeoutError(`\`git ${args.join(" ")}\` timed out after ${timeout}ms in ${cwd}`);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed (exit ${result.code})`);
  }
  return result.stdout.trim();
}

/** A git call killed by its timeout — reported as-is, never as a repo-state cause. */
class GitTimeoutError extends Error {}

/**
 * Why `createWorktree` could not isolate an agent. The message names the
 * directory it tried and the specific cause, so a caller can tell "wrong
 * directory" from "repo with no commits" from a git failure.
 */
export class WorktreeError extends Error {}

/** Run one git step, rethrowing a failure as a `WorktreeError` whose message is `cause(detail)`. */
async function step(run: Promise<string>, cause: (detail: string) => string): Promise<string> {
  try {
    return await run;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new WorktreeError(err instanceof GitTimeoutError ? detail : cause(detail));
  }
}

/**
 * Create a temporary git worktree for an agent, from the repo containing `cwd`
 * (which may be any directory inside it, not just the toplevel).
 *
 * @throws WorktreeError — `cwd` is not inside a git work tree, the repo has no
 * commits yet, `git worktree add` failed, or a git call timed out.
 */
export async function createWorktree(pi: ExtensionAPI, cwd: string, agentId: string): Promise<WorktreeInfo> {
  const inside = await step(
    git(pi, cwd, ["rev-parse", "--is-inside-work-tree"], 5000),
    detail => `${cwd} is not inside a git repository (${detail})`,
  );
  // "false" with a clean exit: inside a `.git` dir or a bare repo.
  if (inside !== "true") throw new WorktreeError(`${cwd} is inside a git directory but not a work tree`);
  // realpath both sides — git emits resolved paths while cwd may arrive
  // through a symlink (macOS /tmp).
  const repoRoot = realpathSync(await step(
    git(pi, cwd, ["rev-parse", "--show-toplevel"], 5000),
    detail => `${cwd} has no git work tree toplevel (${detail})`,
  ));
  const baseSha = await step(
    git(pi, cwd, ["rev-parse", "--verify", "HEAD"], 5000),
    () => `${repoRoot} has no commits yet; commit at least once`,
  );
  // Where cwd sits inside the repo ("" at the root): the agent must work at
  // the same subdirectory inside the copy, or a monorepo-package cwd would
  // silently widen to the whole repo.
  const subdir = relative(repoRoot, realpathSync(cwd));

  const branch = `pi-agent-${agentId}`;
  const suffix = randomUUID().slice(0, 8);
  const worktreePath = join(tmpdir(), `pi-agent-${agentId}-${suffix}`);

  // Create detached worktree at HEAD
  await step(
    git(pi, cwd, ["worktree", "add", "--detach", worktreePath, "HEAD"], 30000),
    detail => `\`git worktree add\` failed in ${repoRoot}: ${detail}`,
  );
  return { path: worktreePath, branch, baseSha, repoRoot, workPath: subdir ? join(worktreePath, subdir) : worktreePath };
}

/**
 * Clean up a worktree after agent completion.
 * - If no changes: remove worktree entirely.
 * - If changes exist: create a branch, commit changes, return branch info.
 */
export async function cleanupWorktree(
  pi: ExtensionAPI,
  cwd: string,
  worktree: WorktreeInfo,
  agentDescription: string,
): Promise<WorktreeCleanupResult> {
  if (!existsSync(worktree.path)) {
    return { hasChanges: false };
  }

  let branch: string | undefined;
  try {
    // Submodule state lives in the worktree's private git dir and is deleted with it.
    await assertSubmodulesDisposable(pi, worktree.path, worktree.baseSha);
    // Check for uncommitted changes in the worktree
    const status = await dirtyState(pi, worktree.path);

    if (status) {
      // Changes exist — stage, commit, and create a branch
      await git(pi, worktree.path, ["add", "-A"], 10000);
      // `add -A` skips a moved gitlink hidden by `submodule.<name>.ignore = all`; an empty
      // commit would fail opaquely, so say why and keep the worktree.
      if (!(await git(pi, worktree.path, ["diff", "--cached", "--name-only"], 10000))) {
        throw new Error(`uncommitted changes could not be staged (a submodule \`ignore\` setting can hide a moved gitlink); worktree kept:\n${status}`);
      }
      // Truncate description for commit message (no shell sanitization needed — pi.exec uses argv)
      const safeDesc = agentDescription.slice(0, 200);
      const commitMsg = `pi-agent: ${safeDesc}`;
      await git(pi, worktree.path, ["commit", "--no-verify", "-m", commitMsg], 10000);
    } else {
      const currentSha = await git(pi, worktree.path, ["rev-parse", "HEAD"], 5000);

      if (currentSha === worktree.baseSha) {
        // No changes — remove worktree
        await removeWorktree(pi, cwd, worktree.path, worktree.baseSha);
        return { hasChanges: false };
      }
    }

    // Create a branch pointing to the worktree's HEAD.
    // If the branch already exists, append a suffix to avoid overwriting previous work.
    let branchName = worktree.branch;
    try {
      await git(pi, worktree.path, ["branch", branchName], 5000);
    } catch {
      // Branch already exists — use a unique suffix
      branchName = `${worktree.branch}-${Date.now()}`;
      await git(pi, worktree.path, ["branch", branchName], 5000);
    }
    // Update branch name in worktree info for the caller
    worktree.branch = branchName;
    branch = branchName;

    // Remove the worktree (branch persists in main repo)
    await removeWorktree(pi, cwd, worktree.path, worktree.baseSha);

    return {
      hasChanges: true,
      branch: worktree.branch,
    };
  } catch (error) {
    // A failed status means the contents are unknown, not clean. Never remove
    // the tree after a failed preservation step: even committed HEAD may have
    // no reachable branch yet.
    return {
      hasChanges: true,
      ...(branch ? { branch } : {}),
      path: worktree.path,
      error: (error instanceof Error ? error.message : String(error)) || "Unknown git failure",
    };
  }
}

/**
 * Uncommitted state of `repo`, untracked files and submodule changes included.
 * `status.showUntrackedFiles=no` in user or repo config would otherwise hide new
 * files from `status`, and `submodule.<name>.ignore` / `diff.ignoreSubmodules`
 * would hide a moved gitlink; a clean-looking tree gets removed with them.
 */
async function dirtyState(pi: ExtensionAPI, repo: string): Promise<string> {
  return await git(pi, repo, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"], 10000);
}

const GITLINK_MODE = "160000";

/**
 * Gitlinks (mode 160000) of `repo` as path -> sha: the index when `rev` is
 * omitted, else the tree of `rev`. Independent of `.gitmodules`: git refuses to
 * remove a worktree on the gitlink, not on the config file.
 */
async function gitlinks(pi: ExtensionAPI, repo: string, rev?: string): Promise<Map<string, string>> {
  const out = await git(pi, repo, rev ? ["ls-tree", "-r", "-z", rev] : ["ls-files", "-s", "-z"], 30000);
  const links = new Map<string, string>();
  for (const entry of out.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    // ls-files: `<mode> <sha> <stage>`; ls-tree: `<mode> <type> <sha>`.
    const [mode, second, third] = entry.slice(0, tab).split(" ");
    if (mode === GITLINK_MODE) links.set(entry.slice(tab + 1), rev ? (third as string) : (second as string));
  }
  return links;
}

/** What removing a repository would destroy: stashes and commits (branch, tag or HEAD) no remote-tracking ref (or `published`) contains. */
async function unpublished(pi: ExtensionAPI, gitArgs: string[], cwd: string, published: Iterable<string>): Promise<string> {
  const stash = await git(pi, cwd, [...gitArgs, "stash", "list"], 10000);
  // `--not` with an object this repository lacks would fail the whole listing.
  const known: string[] = [];
  for (const sha of published) {
    const probe = await pi.exec("git", [...gitArgs, "cat-file", "-e", `${sha}^{commit}`], { cwd, timeout: 5000 });
    if (!probe.killed && probe.code === 0) known.push(sha);
  }
  // Tags count: a local tag can be the only ref holding a commit. Offline there is
  // no telling a fetched tag from a local one, so an unpublished tagged commit fails safe.
  const commits = await git(pi, cwd, [...gitArgs, "rev-list", "--branches", "--tags", "HEAD", "--not", "--remotes", ...known], 30000);
  return [stash, commits].filter(Boolean).join("\n");
}

/**
 * Inspect the nested repository at `dir`, then the ones behind its own gitlinks.
 * `recorded` is the sha a trusted baseline pins it at (when any).
 */
async function inspectRepo(
  pi: ExtensionAPI,
  dir: string,
  label: string,
  recorded: string | undefined,
  trusted: Set<string>,
  seen: Set<string>,
  problems: string[],
): Promise<void> {
  seen.add(realpathSync(await git(pi, dir, ["rev-parse", "--absolute-git-dir"], 5000)));
  const dirty = await dirtyState(pi, dir);
  const lost = await unpublished(pi, [], dir, recorded ? [recorded] : []);
  const detail = [dirty, lost].filter(Boolean).join("\n");
  if (detail) problems.push(`${label}:\n${detail}`);
  const head = await git(pi, dir, ["rev-parse", "HEAD"], 5000);
  await inspectGitlinks(pi, dir, head === recorded ? "HEAD" : undefined, trusted, seen, problems);
  await inspectIgnoredRepos(pi, dir, dir, trusted, seen, problems);
}

/**
 * Inspect nested repositories under gitignored paths of `repo` not already
 * `seen`. Labels are relative to `root`, the worktree.
 */
async function inspectIgnoredRepos(
  pi: ExtensionAPI,
  repo: string,
  root: string,
  trusted: Set<string>,
  seen: Set<string>,
  problems: string[],
): Promise<void> {
  for (const dir of await ignoredRepoDirs(pi, repo)) {
    if (!seen.has(realpathSync(await git(pi, dir, ["rev-parse", "--absolute-git-dir"], 5000)))) {
      await inspectRepo(pi, dir, relative(root, dir), undefined, trusted, seen, problems);
    }
  }
}

/**
 * Inspect the nested repository behind every gitlink of `repo`, recursively.
 * `baseRev` is a revision whose gitlinks are already trusted as published (the
 * commit the worktree was created from): a nested HEAD at exactly that recorded
 * sha, e.g. fetched by sha during `submodule update`, is not at risk. A gitlink
 * the agent introduced has no baseline, so only remote-tracking refs vouch for it.
 * Every baseline sha seen is added to `trusted`, for repositories no gitlink reaches.
 */
async function inspectGitlinks(
  pi: ExtensionAPI,
  repo: string,
  baseRev: string | undefined,
  trusted: Set<string>,
  seen: Set<string>,
  problems: string[],
): Promise<void> {
  const base = baseRev ? await gitlinks(pi, repo, baseRev) : new Map<string, string>();
  for (const sha of base.values()) trusted.add(sha);
  for (const path of (await gitlinks(pi, repo)).keys()) {
    const dir = join(repo, path);
    if (existsSync(join(dir, ".git"))) await inspectRepo(pi, dir, path, base.get(path), trusted, seen, problems);
  }
}

/**
 * Nested repositories under gitignored paths: `add -A` skips them, so no gitlink
 * records them, yet plain removal deletes their ignored content.
 */
async function ignoredRepoDirs(pi: ExtensionAPI, worktreePath: string): Promise<string[]> {
  const out = await git(pi, worktreePath, ["status", "--porcelain", "-z", "--ignored", "--untracked-files=all", "--ignore-submodules=none"], 30000);
  // With `--untracked-files=all` git lists an ignored nested repository as its own `!! dir/` entry.
  return out
    .split("\0")
    .filter(entry => entry.startsWith("!! ") && entry.endsWith("/"))
    .map(entry => join(worktreePath, entry.slice(3)))
    .filter(dir => existsSync(join(dir, ".git")));
}

/** Git dirs under a `modules` directory, including those nested in other submodule git dirs. */
function moduleGitDirs(dir: string): string[] {
  if (existsSync(join(dir, "HEAD")) && existsSync(join(dir, "objects"))) {
    const nested = join(dir, "modules");
    return [dir, ...(existsSync(nested) ? moduleGitDirs(nested) : [])];
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? moduleGitDirs(join(dir, entry.name)) : []));
}

/** Absolute `modules` directory of the worktree's private git dir, when present. */
async function modulesDir(pi: ExtensionAPI, worktreePath: string): Promise<string | undefined> {
  const dir = resolve(worktreePath, await git(pi, worktreePath, ["rev-parse", "--git-path", "modules"], 5000));
  return existsSync(dir) ? dir : undefined;
}

/**
 * Throw unless every nested repository the removal would delete holds nothing
 * but already-published state. Git deletes submodule git dirs with the worktree,
 * so unpushed commits or uncommitted files there would be lost even after the
 * outer repo is branched. Covers every gitlink in the index, registered in
 * `.gitmodules` or not, plus any leftover repository in the worktree's `modules`
 * dir (e.g. after the agent deleted `.gitmodules`).
 */
async function assertSubmodulesDisposable(pi: ExtensionAPI, worktreePath: string, baseSha: string): Promise<void> {
  const seen = new Set<string>();
  const trusted = new Set<string>();
  const problems: string[] = [];
  await inspectGitlinks(pi, worktreePath, baseSha, trusted, seen, problems);
  await inspectIgnoredRepos(pi, worktreePath, worktreePath, trusted, seen, problems);
  const modules = await modulesDir(pi, worktreePath);
  for (const gitDir of modules ? moduleGitDirs(modules) : []) {
    if (seen.has(realpathSync(gitDir))) continue;
    const lost = await unpublished(pi, ["--git-dir", gitDir], worktreePath, trusted);
    if (lost) problems.push(`${gitDir}:\n${lost}`);
  }
  if (problems.length) throw new Error(`submodule work would be lost on removal; worktree kept:\n${problems.join("\n")}`);
}

/** Whether git would refuse plain removal for submodule state: any gitlink in the index or a `modules` dir. */
async function hasSubmoduleState(pi: ExtensionAPI, worktreePath: string): Promise<boolean> {
  return (await gitlinks(pi, worktreePath)).size > 0 || (await modulesDir(pi, worktreePath)) !== undefined;
}

/**
 * Remove only a clean worktree; git refuses newly appeared uncommitted work.
 *
 * Git also refuses any worktree with submodule state, clean or not. Whether that
 * is why removal failed is decided structurally (gitlinks, `modules` dir), never
 * from git's locale-dependent message. Only then is `--force` used, and only after
 * the outer tree and every nested repository re-verify as holding nothing unpublished.
 */
async function removeWorktree(pi: ExtensionAPI, cwd: string, worktreePath: string, baseSha: string): Promise<void> {
  try {
    // Git's own clean check honors `status.showUntrackedFiles`; pin it so config cannot hide new files.
    await git(pi, cwd, ["-c", "status.showUntrackedFiles=all", "worktree", "remove", worktreePath], 10000);
  } catch (error) {
    if (!(await hasSubmoduleState(pi, worktreePath))) throw error;
    if (await dirtyState(pi, worktreePath)) throw error;
    await assertSubmodulesDisposable(pi, worktreePath, baseSha);
    await git(pi, cwd, ["worktree", "remove", "--force", worktreePath], 10000);
  }
}

/**
 * Prune any orphaned worktrees (crash recovery).
 */
export async function pruneWorktrees(pi: ExtensionAPI, cwd: string): Promise<void> {
  try {
    await git(pi, cwd, ["worktree", "prune"], 5000);
  } catch { /* ignore */ }
}
