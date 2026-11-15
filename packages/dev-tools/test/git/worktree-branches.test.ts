/**
 * Worktree tool branches the main suite leaves untaken: parser/formatter edge records, non-repo
 * preflight per mutating tool, and git failing at each step after the preflight (via a PATH shim
 * that delegates everything else to real git).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerGitTools } from "../../src/git/index.ts";
import { formatWorktrees, parseWorktrees } from "../../src/git/worktree.ts";
import { createToolHost } from "../support.ts";

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
};
/** `maintenance.auto=false`: a late background `worktree prune` must not race the assertions. */
function sh(cwd: string, ...args: string[]): string {
	const config = ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-c", "maintenance.auto=false"];
	return execFileSync("git", [...config, ...args], { cwd, env: GIT_ENV, encoding: "utf8" });
}

const mock = createToolHost();
registerGitTools(mock.pi);

let root: string;
let repo: string;
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "pi-dev-tools-wtb-")));
	repo = join(root, "repo");
	mkdirSync(repo);
	sh(repo, "init", "-q");
	writeFileSync(join(repo, "a.txt"), "one\n");
	sh(repo, "add", "a.txt");
	sh(repo, "commit", "-q", "-m", "Initial");
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("parseWorktrees and formatWorktrees edge records", () => {
	it("skips fields before the first worktree and unknown keys; formats reasonless and branchless entries", () => {
		const out = [
			"HEAD ffffffffffffffffffffffffffffffffffffffff",
			"",
			"worktree /r/main",
			"HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"branch refs/heads/main",
			"some-future-key value",
			"",
			"worktree /r/orphan",
			"HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			"prunable",
			"",
			"",
		].join("\0");
		const list = parseWorktrees(out);
		expect(list.map((w) => w.path)).toEqual(["/r/main", "/r/orphan"]);
		expect(list[0]).toMatchObject({ head: "a".repeat(40), branch: "main", main: true });
		expect(list[1]).toMatchObject({ branch: null, detached: false, prunable: true, prunableReason: null });
		expect(formatWorktrees(list).split("\n")).toEqual([
			"/r/main  main  aaaaaaa  [main]",
			"/r/orphan  (none)  bbbbbbb  [prunable]",
		]);
	});
});

describe("mutating tools outside a repository", () => {
	it.each([
		["git_worktree_add", { branch: "x" }, "git worktree add"],
		["git_worktree_remove", { path: "wt" }, "git worktree remove"],
		["git_worktree_prune", {}, "git worktree prune"],
	])("%s names a non-repo before taking the lock", async (tool, params, what) => {
		const plain = join(root, "plain");
		mkdirSync(plain);
		const r = await mock.call(tool, params, plain);
		expect(r.isError).toBe(true);
		expect(mock.text(r)).toMatch(new RegExp(`^${what}: not a git repository`));
		expect(existsSync(join(plain, ".git"))).toBe(false);
	});
});

describe("real-git edge paths", () => {
	it("add refuses a target that is a file, not a directory", async () => {
		const file = join(root, "file");
		writeFileSync(file, "x");
		const r = await mock.call("git_worktree_add", { branch: "x", path: file }, repo);
		expect(mock.text(r)).toBe(`git worktree add: path exists and is not an empty directory: ${file}`);
		expect(sh(repo, "branch", "--list", "x")).toBe("");
	});

	it("remove resolves a relative path from cwd and reports a detached worktree without a branch", async () => {
		const wt = join(root, "det");
		sh(repo, "worktree", "add", "-q", "--detach", wt);
		const r = await mock.call("git_worktree_remove", { path: "../det" }, repo);
		expect(r.isError, mock.text(r)).toBe(false);
		expect(mock.text(r)).toBe(`removed ${wt}`);
		expect(r.structuredContent).toEqual({ path: wt, branch: null });
		expect(existsSync(wt)).toBe(false);
	});

	it("remove names a lock that has no reason", async () => {
		const wt = join(root, "held");
		sh(repo, "worktree", "add", "-q", "-b", "held", wt);
		sh(repo, "worktree", "lock", wt);
		const r = await mock.call("git_worktree_remove", { path: wt, force: true }, repo);
		expect(mock.text(r)).toBe("git worktree remove: locked worktree: unlock it first");
		expect(existsSync(wt)).toBe(true);
	});
});

describe("git failing after the preflight", () => {
	const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	const oldPath = process.env.PATH;
	/** `SHIM` picks the one invocation that misbehaves; every other call is real git. */
	beforeEach(() => {
		const bin = join(root, "bin");
		mkdirSync(bin);
		writeFileSync(
			join(bin, "git"),
			`#!/bin/sh
case "$SHIM:$*" in
  ref-format-killed:*check-ref-format*) kill -KILL $$;;
  list-fail:*"worktree list"*) echo "fatal: list boom" >&2; exit 128;;
  list-empty:*"worktree list"*) exit 0;;
  base-killed:*"^{commit}"*) kill -KILL $$;;
  add-fail:*"worktree add"*) echo "fatal: add boom" >&2; exit 128;;
  status-fail:*"status --porcelain"*) echo "fatal: status boom" >&2; exit 128;;
  remove-fail:*"worktree remove"*) echo "fatal: remove boom" >&2; exit 128;;
  prune-fail:*"worktree prune"*) echo "fatal: prune boom" >&2; exit 128;;
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

	const add = async (shim: string, params: Record<string, unknown> = { branch: "x" }) => {
		process.env.SHIM = shim;
		const r = await mock.call("git_worktree_add", params, repo);
		expect(r.isError).toBe(true);
		expect(existsSync(join(root, "repo-x"))).toBe(false);
		return mock.text(r);
	};

	it("add: a killed branch-name check is not read as an invalid name", async () => {
		expect(await add("ref-format-killed")).toBe("git worktree add: killed by SIGKILL");
	});

	it("add: a failing worktree list inside the lock is named", async () => {
		expect(await add("list-fail")).toBe("git worktree list: exit 128\nfatal: list boom");
	});

	it("add: an empty worktree list has no main worktree to place the default path beside", async () => {
		expect(await add("list-empty")).toBe("git worktree add: no main worktree found");
	});

	it("add: a killed base lookup is not read as an unknown revision", async () => {
		expect(await add("base-killed", { branch: "x", base: "main" })).toBe("git worktree add: killed by SIGKILL");
	});

	it("add: git refusing the add itself is named with its output", async () => {
		expect(await add("add-fail")).toBe("git worktree add: exit 128\nfatal: add boom");
		expect(sh(repo, "branch", "--list", "x")).toBe("");
	});

	describe("remove and prune", () => {
		let wt: string;
		beforeEach(() => {
			wt = join(root, "wt");
			sh(repo, "worktree", "add", "-q", "-b", "wt", wt);
		});
		const remove = async (shim: string) => {
			process.env.SHIM = shim;
			const r = await mock.call("git_worktree_remove", { path: wt }, repo);
			expect(r.isError).toBe(true);
			expect(existsSync(wt)).toBe(true);
			return mock.text(r);
		};

		it("remove: a failing worktree list inside the lock is named", async () => {
			expect(await remove("list-fail")).toBe("git worktree list: exit 128\nfatal: list boom");
		});

		it("remove: a failing dirty check is an error, not 'clean'", async () => {
			expect(await remove("status-fail")).toBe("git worktree remove: exit 128\nfatal: status boom");
		});

		it("remove: git refusing the removal itself is named with its output", async () => {
			expect(await remove("remove-fail")).toBe("git worktree remove: exit 128\nfatal: remove boom");
		});

		it("prune: git failing is named and nothing is reported pruned", async () => {
			rmSync(wt, { recursive: true, force: true });
			process.env.SHIM = "prune-fail";
			const r = await mock.call("git_worktree_prune", {}, repo);
			expect(r.isError).toBe(true);
			expect(mock.text(r)).toBe("git worktree prune: exit 128\nfatal: prune boom");
			delete process.env.SHIM;
			expect(sh(repo, "worktree", "list", "--porcelain")).toContain("prunable");
		});
	});
});
