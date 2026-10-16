import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerGitTools } from "../../src/git/index.ts";
import { branchSlug, formatWorktrees, parseWorktrees } from "../../src/git/worktree.ts";
import { createMockPi } from "../support.ts";

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
};
function sh(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
		cwd,
		env: GIT_ENV,
		encoding: "utf8",
	});
}

const mock = createMockPi();
registerGitTools(mock.pi);

interface Wt {
	path: string;
	branch: string | null;
	head: string | null;
	detached: boolean;
	main: boolean;
	locked: boolean;
	lockReason: string | null;
	prunable: boolean;
}
const worktrees = (r: { structuredContent: unknown }) => (r.structuredContent as { worktrees: Wt[] }).worktrees;
const error = (r: { structuredContent: unknown }) => (r.structuredContent as { error: string }).error;

let root: string;
let repo: string;
const spawned: ChildProcess[] = [];
/** Remove every temp root (restoring modes tests may have stripped) and prove no child outlived its test. */
afterEach(() => {
	for (const p of spawned.splice(0)) {
		expect(p.exitCode === null && p.signalCode === null && p.pid !== undefined && alive(p.pid), `leaked ${p.pid}`).toBe(
			false,
		);
		p.kill("SIGKILL");
	}
	if (root) {
		try {
			execFileSync("chmod", ["-R", "u+rwX", root]);
		} catch {
			// already gone
		}
		rmSync(root, { recursive: true, force: true });
	}
});
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
/** A fresh repo named `repo` under a fresh temp dir, so default sibling paths never collide. */
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "pi-dev-tools-wt-")));
	repo = join(root, "repo");
	mkdirSync(repo);
	sh(repo, "init", "-q");
	writeFileSync(join(repo, "a.txt"), "one\n");
	sh(repo, "add", "a.txt");
	sh(repo, "commit", "-q", "-m", "Initial");
});

describe("parseWorktrees", () => {
	it("parses main, branch, detached, locked, prunable and bare records, spaces intact", () => {
		const out = [
			"worktree /r/my repo",
			"HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"branch refs/heads/main",
			"",
			"worktree /r/det ached",
			"HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			"detached",
			"locked",
			"",
			"worktree /r/gone",
			"HEAD cccccccccccccccccccccccccccccccccccccccc",
			"branch refs/heads/feat/x",
			"locked in use",
			"prunable gitdir file points to non-existent location",
			"",
			"worktree /r/bare",
			"bare",
			"",
			"",
		].join("\0");
		const list = parseWorktrees(out);
		expect(list.map((w) => w.path)).toEqual(["/r/my repo", "/r/det ached", "/r/gone", "/r/bare"]);
		expect(list[0]).toMatchObject({ branch: "main", main: true, detached: false, locked: false, prunable: false });
		expect(list[1]).toMatchObject({ branch: null, detached: true, locked: true, lockReason: null, main: false });
		expect(list[2]).toMatchObject({
			branch: "feat/x",
			lockReason: "in use",
			prunable: true,
			prunableReason: "gitdir file points to non-existent location",
		});
		expect(list[3]).toMatchObject({ bare: true, head: null });
		expect(formatWorktrees(list)).toContain("/r/det ached  (detached)  bbbbbbb  [locked]");
	});

	it("returns nothing for empty output", () => {
		expect(parseWorktrees("")).toEqual([]);
	});

	it("slugs branches", () => {
		expect(branchSlug("Feature/Add#X_y")).toBe("feature-add-x_y");
		expect(branchSlug("v1.2_rc-1")).toBe("v1.2_rc-1");
	});
});

describe("registration", () => {
	it("annotates only list as read-only", () => {
		expect(mock.tools.get("git_worktree_list")?.annotations?.readOnlyHint).toBe(true);
		for (const name of ["git_worktree_add", "git_worktree_remove", "git_worktree_prune"]) {
			expect(mock.tools.get(name)?.annotations?.readOnlyHint, name).toBe(false);
		}
	});
});

describe("git_worktree_list", () => {
	it("lists main, a detached worktree, a locked one and a prunable one in a spaced path", async () => {
		const spaced = join(root, "with space");
		sh(repo, "worktree", "add", "-q", "-b", "spaced", spaced);
		const det = join(root, "det");
		sh(repo, "worktree", "add", "-q", "--detach", det);
		const lock = join(root, "lock");
		sh(repo, "worktree", "add", "-q", "-b", "lockme", lock);
		sh(repo, "worktree", "lock", "--reason", "in use", lock);
		const gone = join(root, "gone");
		sh(repo, "worktree", "add", "-q", "-b", "gone", gone);
		execFileSync("rm", ["-rf", gone]);

		const r = await mock.call("git_worktree_list", {}, repo);
		expect(r.isError).toBe(false);
		const by = Object.fromEntries(worktrees(r).map((w) => [w.path, w]));
		expect(by[repo]).toMatchObject({ main: true, branch: "main" });
		expect(by[spaced]).toMatchObject({ branch: "spaced", main: false });
		expect(by[det]).toMatchObject({ detached: true, branch: null });
		expect(by[lock]).toMatchObject({ locked: true, lockReason: "in use" });
		expect(by[gone]).toMatchObject({ prunable: true });
		expect(mock.text(r).split("\n")).toHaveLength(5);
	});

	it("names a non-repo", async () => {
		const r = await mock.call("git_worktree_list", {}, tmpdir());
		expect(r.isError).toBe(true);
		expect(mock.text(r)).toMatch(/^git worktree list: not a git repository/);
	});
});

describe("git_worktree_add", () => {
	it("creates a new branch at the default sibling path", async () => {
		const r = await mock.call("git_worktree_add", { branch: "Feat/New#Thing" }, repo);
		expect(r.isError, mock.text(r)).toBe(false);
		const path = join(root, "repo-feat-new-thing");
		expect(r.structuredContent).toMatchObject({ path, branch: "Feat/New#Thing", created: true });
		expect(existsSync(join(path, "a.txt"))).toBe(true);
		expect(sh(path, "branch", "--show-current").trim()).toBe("Feat/New#Thing");
	});

	it("branches from base and from a linked worktree still lands beside the main one", async () => {
		writeFileSync(join(repo, "b.txt"), "b\n");
		sh(repo, "add", "b.txt");
		sh(repo, "commit", "-q", "-m", "Second");
		const r = await mock.call("git_worktree_add", { branch: "old", base: "HEAD~1" }, repo);
		expect(r.isError, mock.text(r)).toBe(false);
		const old = join(root, "repo-old");
		expect(existsSync(join(old, "b.txt"))).toBe(false);
		const r2 = await mock.call("git_worktree_add", { branch: "other" }, old);
		expect(r2.isError, mock.text(r2)).toBe(false);
		expect(existsSync(join(root, "repo-other"))).toBe(true);
	});

	it("checks out an existing branch and honours an explicit relative path", async () => {
		sh(repo, "branch", "exists");
		const r = await mock.call("git_worktree_add", { branch: "exists", path: "../custom" }, repo);
		expect(r.isError, mock.text(r)).toBe(false);
		expect(r.structuredContent).toMatchObject({ path: join(root, "custom"), created: false });
	});

	it("refuses an existing branch that is checked out elsewhere, naming where", async () => {
		const r = await mock.call("git_worktree_add", { branch: "main" }, repo);
		expect(r.isError).toBe(true);
		expect(mock.text(r)).toMatch(/^git worktree add: branch checked out elsewhere/);
		expect(error(r)).toContain(repo);
		expect(existsSync(join(root, "repo-main"))).toBe(false);
	});

	it("refuses a base for an existing branch", async () => {
		sh(repo, "branch", "exists");
		const r = await mock.call("git_worktree_add", { branch: "exists", base: "main" }, repo);
		expect(r.isError).toBe(true);
		expect(mock.text(r)).toContain("already exists");
	});

	it("names a bad base, a bad branch name, and option-like refs", async () => {
		const badBase = await mock.call("git_worktree_add", { branch: "x", base: "nope" }, repo);
		expect(mock.text(badBase)).toMatch(/^git worktree add: unknown revision 'nope'/);
		const badName = await mock.call("git_worktree_add", { branch: "a..b" }, repo);
		expect(mock.text(badName)).toMatch(/invalid branch name/);
		for (const params of [{ branch: "--detach" }, { branch: "x", base: "--output=/tmp/x" }]) {
			const r = await mock.call("git_worktree_add", params, repo);
			expect(r.isError).toBe(true);
			expect(mock.text(r)).toMatch(/must not start with '-'/);
		}
		expect(existsSync(join(root, "repo-x"))).toBe(false);
	});

	it("refuses a path that exists and is not empty, but accepts an empty directory", async () => {
		mkdirSync(join(root, "taken"));
		writeFileSync(join(root, "taken", "f"), "x");
		const r = await mock.call("git_worktree_add", { branch: "x", path: join(root, "taken") }, repo);
		expect(r.isError).toBe(true);
		expect(mock.text(r)).toMatch(/^git worktree add: path exists/);
		expect(sh(repo, "branch", "--list", "x")).toBe("");
		mkdirSync(join(root, "empty"));
		const ok = await mock.call("git_worktree_add", { branch: "x", path: join(root, "empty") }, repo);
		expect(ok.isError, mock.text(ok)).toBe(false);
	});

	it("serializes concurrent adds on the common dir", async () => {
		const results = await Promise.all(
			["c1", "c2", "c3", "c4"].map((branch) => mock.call("git_worktree_add", { branch }, repo)),
		);
		for (const r of results) expect(r.isError, mock.text(r)).toBe(false);
		const list = await mock.call("git_worktree_list", {}, repo);
		expect(worktrees(list)).toHaveLength(5);
	});

	it("queues racing adds of one branch: one wins, the loser gets the named state, not a git race", async () => {
		const [a, b] = await Promise.all([
			mock.call("git_worktree_add", { branch: "race", path: "../race-a" }, repo),
			mock.call("git_worktree_add", { branch: "race", path: "../race-b" }, repo),
		]);
		expect([a.isError, b.isError].sort()).toEqual([false, true]);
		const loser = a.isError ? a : b;
		expect(mock.text(loser)).toMatch(/^git worktree add: branch checked out elsewhere/);
	});

	it("shares one lock between linked worktrees of the same repo", async () => {
		const a = await mock.call("git_worktree_add", { branch: "a" }, repo);
		expect(a.isError).toBe(false);
		const linked = join(root, "repo-a");
		const results = await Promise.all([
			mock.call("git_worktree_add", { branch: "b" }, repo),
			mock.call("git_worktree_add", { branch: "c" }, linked),
		]);
		for (const r of results) expect(r.isError, mock.text(r)).toBe(false);
		expect(worktrees(await mock.call("git_worktree_list", {}, repo))).toHaveLength(4);
	});
});

describe("git_worktree_remove", () => {
	const add = async (branch: string) => {
		const r = await mock.call("git_worktree_add", { branch }, repo);
		expect(r.isError, mock.text(r)).toBe(false);
		return join(root, `repo-${branch}`);
	};

	it("removes a clean worktree and keeps its branch", async () => {
		const path = await add("clean");
		const r = await mock.call("git_worktree_remove", { path }, repo);
		expect(r.isError, mock.text(r)).toBe(false);
		expect(existsSync(path)).toBe(false);
		expect(mock.text(r)).toContain("branch clean kept");
		expect(sh(repo, "branch", "--list", "clean")).toContain("clean");
	});

	it("refuses dirty (modified and untracked) unless forced", async () => {
		const path = await add("dirty");
		writeFileSync(join(path, "new.txt"), "x");
		const r = await mock.call("git_worktree_remove", { path }, repo);
		expect(r.isError).toBe(true);
		expect(mock.text(r)).toMatch(/^git worktree remove: dirty worktree/);
		expect(existsSync(path)).toBe(true);
		const forced = await mock.call("git_worktree_remove", { path, force: true }, repo);
		expect(forced.isError, mock.text(forced)).toBe(false);
		expect(existsSync(path)).toBe(false);
	});

	it("refuses the main worktree", async () => {
		const r = await mock.call("git_worktree_remove", { path: repo, force: true }, repo);
		expect(r.isError).toBe(true);
		expect(mock.text(r)).toMatch(/^git worktree remove: main worktree/);
		expect(existsSync(repo)).toBe(true);
	});

	it("refuses the cwd and any parent of cwd, even forced", async () => {
		const path = await add("here");
		const inner = join(path, "sub");
		mkdirSync(inner);
		for (const cwd of [path, inner]) {
			const r = await mock.call("git_worktree_remove", { path, force: true }, cwd);
			expect(r.isError).toBe(true);
			expect(mock.text(r)).toMatch(/^git worktree remove: cwd is inside/);
		}
		// params.cwd counts too, not just the session cwd.
		const viaParam = await mock.call("git_worktree_remove", { path, force: true, cwd: inner }, repo);
		expect(mock.text(viaParam)).toMatch(/cwd is inside/);
		expect(existsSync(path)).toBe(true);
	});

	it("refuses a locked worktree even when forced, and an unknown path", async () => {
		const path = await add("locked");
		sh(repo, "worktree", "lock", "--reason", "keep", path);
		const r = await mock.call("git_worktree_remove", { path, force: true }, repo);
		expect(mock.text(r)).toMatch(/^git worktree remove: locked worktree \(keep\)/);
		const unknown = await mock.call("git_worktree_remove", { path: join(root, "nope") }, repo);
		expect(mock.text(unknown)).toMatch(/not a worktree of this repository/);
	});

	it("points a prunable worktree at prune", async () => {
		const path = await add("gone");
		execFileSync("rm", ["-rf", path]);
		const r = await mock.call("git_worktree_remove", { path }, repo);
		expect(r.isError).toBe(true);
		expect(mock.text(r)).toContain("git_worktree_prune");
	});
});

describe("git_worktree_prune", () => {
	it("dry run reports and keeps the record; a real run removes it", async () => {
		const path = join(root, "gone");
		sh(repo, "worktree", "add", "-q", "-b", "gone", path);
		execFileSync("rm", ["-rf", path]);

		const dry = await mock.call("git_worktree_prune", { dry_run: true }, repo);
		expect(dry.isError, mock.text(dry)).toBe(false);
		expect(dry.structuredContent).toMatchObject({ dryRun: true, pruned: [{ name: "worktrees/gone" }] });
		expect(mock.text(dry)).toMatch(/^would prune 1/);
		expect(worktrees(await mock.call("git_worktree_list", {}, repo))).toHaveLength(2);

		const real = await mock.call("git_worktree_prune", {}, repo);
		expect(mock.text(real)).toMatch(/^pruned 1/);
		expect(worktrees(await mock.call("git_worktree_list", {}, repo))).toHaveLength(1);

		const none = await mock.call("git_worktree_prune", {}, repo);
		expect(mock.text(none)).toBe("nothing to prune");
	});
});

describe("bounded output", () => {
	it("caps a huge worktree list at the shared limit and spills the rest", async () => {
		// Fabricate records instead of 2300 real checkouts: admin dirs for worktrees that are gone.
		const head = sh(repo, "rev-parse", "HEAD").trim();
		for (let i = 0; i < 2300; i++) {
			const admin = join(repo, ".git", "worktrees", `w${i}`);
			mkdirSync(admin, { recursive: true });
			writeFileSync(join(admin, "HEAD"), `${head}\n`);
			writeFileSync(join(admin, "commondir"), "../..\n");
			writeFileSync(join(admin, "gitdir"), `${join(root, `gone-${i}`, ".git")}\n`);
		}
		const r = await mock.call("git_worktree_list", {}, repo);
		expect(r.isError, mock.text(r)).toBe(false);
		expect(mock.text(r)).toMatch(/\[output truncated at the end; rest in .*git-worktree-list-\d+\.txt/);
		expect(mock.text(r).split("\n").length).toBeLessThanOrEqual(2000);
		expect(worktrees(r).length).toBe(2301);

		const p = await mock.call("git_worktree_prune", { dry_run: true }, repo);
		expect(mock.text(p)).toMatch(/\[output truncated/);
		expect(mock.text(p).split("\n").length).toBeLessThanOrEqual(2000);
		expect((p.structuredContent as { pruned: unknown[] }).pruned).toHaveLength(2300);
	});
});

describe("abnormal git outcomes in preflight", () => {
	let bin: string;
	const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	const oldPath = process.env.PATH;
	/** A `git` shim: `SHIM` picks which subcommand misbehaves; everything else is real git. */
	beforeEach(() => {
		bin = join(root, "bin");
		mkdirSync(bin);
		writeFileSync(
			join(bin, "git"),
			`#!/bin/sh
case "$SHIM:$*" in
  show-ref-hang:*show-ref*) sleep 5; exit 0;;
  show-ref-128:*show-ref*) echo "fatal: boom" >&2; exit 128;;
  base-128:*"^{commit}"*) echo "fatal: boom" >&2; exit 128;;
  head-empty:*"rev-parse HEAD") exit 0;;
  head-fail:*"rev-parse HEAD") echo "fatal: boom" >&2; exit 128;;
esac
exec ${realGit} "$@"
`,
		);
		chmodSync(join(bin, "git"), 0o755);
		process.env.PATH = `${bin}:${oldPath}`;
	});
	afterEach(() => {
		process.env.PATH = oldPath;
		delete process.env.SHIM;
	});

	it("a timed-out branch lookup is a timeout, not 'branch absent'", async () => {
		process.env.SHIM = "show-ref-hang";
		const r = await mock.call("git_worktree_add", { branch: "x", timeout_s: 1 }, repo);
		expect(r.isError).toBe(true);
		expect(mock.text(r)).toMatch(/^git worktree add: timed out/);
		expect(sh(repo, "branch", "--list", "x")).toBe("");
	});

	it("an unexpected show-ref exit is an error, not 'branch absent'", async () => {
		process.env.SHIM = "show-ref-128";
		const r = await mock.call("git_worktree_add", { branch: "x" }, repo);
		expect(mock.text(r)).toMatch(/^git worktree add: exit 128/);
		expect(existsSync(join(root, "repo-x"))).toBe(false);
	});

	it("an unexpected base lookup exit is an error, not 'unknown revision'", async () => {
		process.env.SHIM = "base-128";
		const r = await mock.call("git_worktree_add", { branch: "x", base: "main" }, repo);
		expect(mock.text(r)).toMatch(/^git worktree add: exit 128/);
		expect(mock.text(r)).not.toContain("unknown revision");
	});

	it("a failing or empty final HEAD lookup names head-unreadable instead of succeeding with no sha", async () => {
		for (const shim of ["head-empty", "head-fail"]) {
			process.env.SHIM = shim;
			const r = await mock.call("git_worktree_add", { branch: shim }, repo);
			expect(r.isError, shim).toBe(true);
			expect(mock.text(r), shim).toMatch(/head-unreadable: the worktree WAS created/);
			expect(error(r)).toBeTruthy();
		}
	});
});

describe("filesystem errors stay inside the { error } contract", () => {
	it("names an unreadable target directory", async () => {
		const locked = join(root, "locked");
		mkdirSync(locked);
		writeFileSync(join(locked, "f"), "x");
		chmodSync(locked, 0o000);
		try {
			const r = await mock.call("git_worktree_add", { branch: "x", path: locked }, repo);
			expect(r.isError).toBe(true);
			expect(mock.text(r)).toMatch(/^git worktree add: path unreadable \(EACCES\)/);
			expect(sh(repo, "branch", "--list", "x")).toBe("");
		} finally {
			chmodSync(locked, 0o755);
		}
	});

	it("names an unreadable PARENT (EACCES on stat)", async () => {
		const parent = join(root, "parent");
		mkdirSync(join(parent, "child"), { recursive: true });
		chmodSync(parent, 0o000);
		try {
			const r = await mock.call("git_worktree_add", { branch: "x", path: join(parent, "child") }, repo);
			expect(r.isError).toBe(true);
			expect(mock.text(r)).toMatch(/path unreadable \(EACCES\)/);
		} finally {
			chmodSync(parent, 0o755);
		}
	});

	it("treats a missing path (ENOENT, e.g. removed concurrently) as free", async () => {
		const r = await mock.call("git_worktree_add", { branch: "x", path: join(root, "not", "there", "yet") }, repo);
		expect(r.isError, mock.text(r)).toBe(false);
	});
});

describe("cross-process lock", () => {
	const CHILD = fileURLToPath(new URL("./worktree-child.ts", import.meta.url));
	const lockDir = () => join(repo, ".git", "pi-dev-tools-worktree.lock");

	function child(branch: string, path: string, startAt: number) {
		return new Promise<{ isError: boolean; text: string }>((resolveChild, reject) => {
			const p = spawn(process.execPath, [CHILD, repo, branch, path, String(startAt)], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			spawned.push(p);
			let out = "";
			let err = "";
			p.stdout.on("data", (d) => {
				out += d;
			});
			p.stderr.on("data", (d) => {
				err += d;
			});
			p.on("close", (code) => {
				try {
					resolveChild(JSON.parse(out));
				} catch {
					reject(new Error(`child exited ${code}: ${err || out}`));
				}
			});
		});
	}

	it("two real processes racing on one branch: exactly one wins, the loser gets a named state", async () => {
		const at = Date.now() + 1500;
		const [a, b] = await Promise.all([child("race", join(root, "ra"), at), child("race", join(root, "rb"), at)]);
		expect([a.isError, b.isError].sort()).toEqual([false, true]);
		const loser = a.isError ? a : b;
		expect(loser.text).toMatch(/^git worktree add: (branch checked out elsewhere|branch exists)/);
		const list = await mock.call("git_worktree_list", {}, repo);
		expect(worktrees(list)).toHaveLength(2);
		expect(existsSync(lockDir())).toBe(false);
	});

	it("real processes adding different branches all succeed with a consistent worktree list", async () => {
		const at = Date.now() + 1500;
		const names = ["d1", "d2", "d3", "d4"];
		const results = await Promise.all(names.map((n) => child(n, join(root, n), at)));
		for (const r of results) expect(r.isError, r.text).toBe(false);
		const list = worktrees(await mock.call("git_worktree_list", {}, repo));
		expect(list.map((w) => w.branch).sort()).toEqual(["d1", "d2", "d3", "d4", "main"]);
		expect(sh(repo, "worktree", "list", "--porcelain")).not.toMatch(/prunable/);
		expect(existsSync(lockDir())).toBe(false);
	});

	it("reclaims a lock left by a dead pid", async () => {
		const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
		const pid = dead.pid ?? 0;
		await new Promise((r) => dead.once("close", r));
		mkdirSync(lockDir());
		writeFileSync(join(lockDir(), "owner.json"), JSON.stringify({ pid, startedAt: Date.now(), token: "dead" }));
		const r = await mock.call("git_worktree_add", { branch: "after-crash" }, repo);
		expect(r.isError, mock.text(r)).toBe(false);
		expect(existsSync(lockDir())).toBe(false);
	});

	it("fails with lock-timeout while a live process holds the lock, and succeeds once it lets go", async () => {
		const holder = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" });
		try {
			mkdirSync(lockDir());
			writeFileSync(
				join(lockDir(), "owner.json"),
				JSON.stringify({ pid: holder.pid, startedAt: Date.now(), token: "live" }),
			);
			const t0 = Date.now();
			const r = await mock.call("git_worktree_prune", {}, repo);
			expect(r.isError).toBe(true);
			expect(mock.text(r)).toMatch(/^git worktree prune: lock-timeout: .*held by pid \d+/);
			expect(Date.now() - t0).toBeGreaterThanOrEqual(14_000);
			expect(existsSync(join(lockDir(), "owner.json"))).toBe(true);
		} finally {
			holder.kill("SIGKILL");
		}
	}, 30_000);
});
