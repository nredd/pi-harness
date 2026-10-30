/** Complete-index approval for merge commits, including checks around the repository's own hooks. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type GitRunOptions, git, gitFailure } from "./run.ts";

interface Approval {
	root: string;
	mergePath: string;
	mergeHead: string;
	head: string;
	paths: string[];
	hooks: string;
}

/** Execute a compact, uncapped Git fact query. A failure must reject the merge. */
function fact(approval: Approval, args: string[]): string {
	return execFileSync("git", ["--no-pager", "--literal-pathspecs", ...args], {
		cwd: approval.root,
		encoding: "utf8",
		timeout: 30_000,
	});
}

/** Reject changed merge identity, unresolved entries and every unapproved index endpoint. */
export function checkMergeIndex(approval: Approval): void {
	if (
		readFileSync(approval.mergePath, "utf8") !== approval.mergeHead ||
		fact(approval, ["rev-parse", "HEAD"]).trim() !== approval.head
	)
		throw new Error("Merge identity changed; review the merge again");
	if (fact(approval, ["ls-files", "--unmerged", "-z"])) throw new Error("Merge has unresolved conflicts");
	const changed = fact(approval, ["diff", "--cached", "--no-renames", "--name-only", "-z", "HEAD", "--"])
		.split("\0")
		.filter(Boolean);
	const outside = changed.filter((path) => !approval.paths.includes(path));
	if (outside.length)
		throw new Error(`Merge index contains unapproved paths: ${outside.map((path) => JSON.stringify(path)).join(", ")}`);
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
const approval = ${JSON.stringify(approval)};
function fact(args) {
	return execFileSync("git", ["--no-pager", "--literal-pathspecs", ...args], { cwd: approval.root, encoding: "utf8", timeout: 30000 });
}
function check() {
	if (readFileSync(approval.mergePath, "utf8") !== approval.mergeHead || fact(["rev-parse", "HEAD"]).trim() !== approval.head)
		throw new Error("Merge identity changed; review the merge again");
	if (fact(["ls-files", "--unmerged", "-z"])) throw new Error("Merge has unresolved conflicts");
	const changed = fact(["diff", "--cached", "--no-renames", "--name-only", "-z", "HEAD", "--"]).split("\\0").filter(Boolean);
	const outside = changed.filter((path) => !approval.paths.includes(path));
	if (outside.length) throw new Error(\`Merge index contains unapproved paths: \${outside.map((path) => JSON.stringify(path)).join(", ")}\`);
}
const hook = process.argv[2];
try {
	if (hook !== "post-commit") check();
	const original = \`${approval.hooks}/\${hook}\`;
	try {
		accessSync(original, constants.X_OK);
		const result = spawnSync(original, process.argv.slice(3), { cwd: approval.root, stdio: "inherit" });
		if (result.error) throw result.error;
		if (result.status !== 0) process.exit(result.status ?? 1);
	} catch (error) {
		if ((error)?.code !== "ENOENT" && (error)?.code !== "EACCES") throw error;
	}
	if (hook !== "post-commit") check();
} catch (error) {
	console.error(\`git_commit merge approval: \${error.message}\`);
	process.exitCode = 1;
}
`,
		{ mode: 0o600 },
	);
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	for (const hook of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]) {
		writeFileSync(
			join(directory, hook),
			`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(runner)} ${quote(hook)} "$@"\n`,
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
): Promise<{ check: () => void; args: string[]; cleanup: () => void } | undefined> {
	const query = async (args: string[]) => {
		const result = await git(args, opts);
		const failure = gitFailure(result, "git merge approval");
		if (failure || result.stdoutDropped) throw new Error(failure ?? "Git merge approval output truncated");
		return result.stdout.trimEnd();
	};
	const mergePath = await query(["rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"]);
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
	const root = await query(["rev-parse", "--show-toplevel"]);
	const approved = paths.map((path) => {
		const name = relative(root, resolve(opts.cwd, path));
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
			check: () => checkMergeIndex(approval),
			args: ["-c", `core.hooksPath=${directory}`],
			cleanup: () => rmSync(directory, { recursive: true, force: true }),
		};
	} catch (error) {
		rmSync(directory, { recursive: true, force: true });
		throw error;
	}
}
