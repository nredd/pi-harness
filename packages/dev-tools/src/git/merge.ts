/** Complete-index approval for merge commits, including checks around the repository's own hooks. */
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type GitRunOptions, git, gitFailure } from "./run.ts";

interface Approval {
	root: string;
	mergePath: string;
	mergeHead: string;
	head: string;
	paths: string[];
	hooks: string;
}

/** Reject changed merge identity, unresolved entries and every unapproved index endpoint. */
async function checkMergeIndex(approval: Approval, opts: GitRunOptions): Promise<void> {
	const query = async (args: string[], cwd = opts.cwd) => {
		const result = await git(args, { ...opts, cwd });
		const failure = gitFailure(result, "git merge approval");
		if (failure || result.stdoutDropped) throw new Error(failure ?? "Git merge approval output truncated");
		return result.stdout;
	};
	if (
		readFileSync(approval.mergePath, "utf8") !== approval.mergeHead ||
		(await query(["rev-parse", "HEAD"])).trim() !== approval.head
	)
		throw new Error("Merge identity changed; review the merge again");
	// Index-wide: from a subdirectory a bare `ls-files` would only list that subdirectory's conflicts.
	if (await query(["ls-files", "--unmerged", "-z"], approval.root)) throw new Error("Merge has unresolved conflicts");
	const changed = (
		await query([
			"diff",
			"--cached",
			"--no-relative",
			"--no-renames",
			"--ignore-submodules=none",
			"--name-only",
			"-z",
			"HEAD",
			"--",
		])
	)
		.split("\0")
		.filter(Boolean);
	const outside = changed.filter((path) => !approval.paths.includes(path));
	if (outside.length)
		throw new Error(`Merge index contains unapproved paths: ${outside.map((path) => JSON.stringify(path)).join(", ")}`);
}

/** Hooks proxied even when absent (they carry the index checks), plus every entry of the real hooks directory. */
function proxiedHooks(hooksDir: string): string[] {
	let present: string[] = [];
	try {
		present = readdirSync(hooksDir);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
	}
	const names = new Set(["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "reference-transaction"]);
	for (const name of present) if (name !== "run.mjs" && /^[A-Za-z0-9_-]+$/.test(name)) names.add(name);
	return [...names];
}

/** Resolve symlinks in the parent directory only: the file itself may be deleted by the merge or be a symlink. */
function canonicalPath(path: string): string {
	let parent = dirname(path);
	const tail: string[] = [basename(path)];
	for (;;) {
		try {
			return join(realpathSync(parent), ...tail);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
			tail.unshift(basename(parent));
			parent = dirname(parent);
		}
	}
}

/**
 * Write a plain-Node hook proxy. It delegates to the repository's configured hook and checks the
 * merge index immediately before and after every pre-commit hook Git invokes. This avoids a
 * pathspec merge commit while still preserving hooks, signing and their real exit status.
 */
function writeHookProxy(directory: string, approval: Approval): void {
	const runner = join(directory, "run.mjs");
	writeFileSync(
		runner,
		`import { accessSync, constants, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
const approval = ${JSON.stringify(approval)};
function fact(args) {
	return execFileSync("git", ["--no-pager", "--literal-pathspecs", ...args], { cwd: approval.root, encoding: "utf8", timeout: 30000 });
}
function check() {
	if (readFileSync(approval.mergePath, "utf8") !== approval.mergeHead || fact(["rev-parse", "HEAD"]).trim() !== approval.head)
		throw new Error("Merge identity changed; review the merge again");
	if (fact(["ls-files", "--unmerged", "-z"])) throw new Error("Merge has unresolved conflicts");
	const changed = fact(["diff", "--cached", "--no-relative", "--no-renames", "--ignore-submodules=none", "--name-only", "-z", "HEAD", "--"]).split("\\0").filter(Boolean);
	const outside = changed.filter((path) => !approval.paths.includes(path));
	if (outside.length) throw new Error(\`Merge index contains unapproved paths: \${outside.map((path) => JSON.stringify(path)).join(", ")}\`);
}
const hook = process.argv[2];
try {
	const commitTreeHook = ["pre-commit", "prepare-commit-msg", "commit-msg"].includes(hook);
	if (commitTreeHook) check();
	const original = join(approval.hooks, hook);
	let executable = true;
	try {
		accessSync(original, constants.X_OK);
	} catch (error) {
		if ((error)?.code !== "ENOENT" && (error)?.code !== "ENOTDIR" && (error)?.code !== "EACCES") throw error;
		executable = false;
	}
	if (executable) {
		const result = spawnSync(original, process.argv.slice(3), { cwd: approval.root, stdio: "inherit" });
		if (result.error) throw result.error;
		if (result.status !== 0) process.exit(result.status ?? 1);
	}
	if (commitTreeHook) check();
} catch (error) {
	console.error(\`git_commit merge approval: \${error.message}\`);
	process.exitCode = 1;
}
`,
		{ mode: 0o600 },
	);
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	for (const hook of proxiedHooks(approval.hooks)) {
		writeFileSync(
			join(directory, hook),
			`#!/bin/sh\nexec env BUN_BE_BUN=1 ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} ${quote(runner)} ${quote(hook)} "$@"\n`,
			{
				mode: 0o700,
			},
		);
	}
}

/** Discover real worktree merge state before staging; invalid state never falls back to a partial commit. */
export async function prepareMerge(
	paths: string[],
	opts: GitRunOptions,
): Promise<{ check: () => Promise<void>; args: string[]; cleanup: () => void } | undefined> {
	const query = async (args: string[]) => {
		const result = await git(args, opts);
		const failure = gitFailure(result, "git merge approval");
		if (failure || result.stdoutDropped) throw new Error(failure ?? "Git merge approval output truncated");
		return result.stdout.trimEnd();
	};
	let mergePath: string;
	try {
		mergePath = await query(["rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"]);
	} catch {
		// No usable repository state: not a merge. The ordinary `add`/`commit` path reports the real failure.
		return undefined;
	}
	let mergeHead: string;
	try {
		mergeHead = readFileSync(mergePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const parents = mergeHead.trimEnd().split("\n");
	if (!parents.length || parents.some((parent) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(parent)))
		throw new Error("Invalid MERGE_HEAD");
	for (const parent of parents)
		if ((await query(["cat-file", "-t", parent])) !== "commit") throw new Error("MERGE_HEAD must name commits");
	const root = realpathSync(await query(["rev-parse", "--show-toplevel"]));
	const cwd = realpathSync(opts.cwd);
	const approved = paths.map((path) => {
		const name = relative(root, canonicalPath(resolve(cwd, path)));
		if (!name || name === ".." || name.startsWith(`..${sep}`) || isAbsolute(name))
			throw new Error("Merge paths must name complete files inside the worktree");
		return name.split(sep).join("/");
	});
	const approval: Approval = {
		root,
		mergePath,
		mergeHead,
		head: await query(["rev-parse", "HEAD"]),
		paths: approved,
		hooks: await query(["rev-parse", "--path-format=absolute", "--git-path", "hooks"]),
	};
	const directory = mkdtempSync(join(tmpdir(), "pi-git-merge-"));
	try {
		writeHookProxy(directory, approval);
		return {
			check: () => checkMergeIndex(approval, opts),
			args: ["-c", `core.hooksPath=${directory}`],
			cleanup: () => rmSync(directory, { recursive: true, force: true }),
		};
	} catch (error) {
		rmSync(directory, { recursive: true, force: true });
		throw error;
	}
}
