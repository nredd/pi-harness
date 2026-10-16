/**
 * Read-only git access for `/diff`. Every call is an argv spawn (no shell) with `--no-pager
 * --literal-pathspecs`, `GIT_OPTIONAL_LOCKS=0` so a diff never takes the index lock another pi
 * session may be holding, a hard output cap and a timeout.
 */

import { spawn } from "node:child_process";
import { lstat, open, readlink } from "node:fs/promises";
import { join } from "node:path";
import { type DiffFile, PER_FILE_BYTES, parseUnifiedDiff } from "./parse.ts";

export const TOTAL_BYTES = 2 * 1024 * 1024;
export const MAX_UNTRACKED_FILES = 500;
const GIT_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 2_000;
/** After SIGKILL, how long to wait for `close` before resolving with what we have. */
const CLOSE_GRACE_MS = 1_000;
const SNIFF_BYTES = 8000;

export interface GitOutput {
	stdout: Buffer;
	stderr: string;
	code: number | null;
	/** Output hit `maxBytes`; git was stopped. */
	truncated: boolean;
	spawnError?: string;
}

/** Signal only the detached group; a reaped leader's bare pid may already have been reused. */
function killTree(pid: number, sig: NodeJS.Signals): void {
	try {
		process.kill(-pid, sig);
	} catch {
		// already gone
	}
}

/**
 * Run git in its own process group so a timeout or the output cap stops the whole tree (hooks,
 * filter drivers, ssh). SIGTERM first, SIGKILL after `KILL_GRACE_MS`, then a hard resolve
 * `CLOSE_GRACE_MS` later so a grandchild holding the pipes cannot hang the caller.
 */
export function runGit(
	args: readonly string[],
	opts: { cwd: string; maxBytes?: number; timeoutMs?: number; cmd?: string },
): Promise<GitOutput> {
	const maxBytes = opts.maxBytes ?? TOTAL_BYTES;
	return new Promise((resolve) => {
		const child = spawn(
			opts.cmd ?? "git",
			["--no-pager", "--literal-pathspecs", "-c", "core.quotepath=false", "-c", "color.ui=false", ...args],
			{
				cwd: opts.cwd,
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
				env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
			},
		);
		const chunks: Buffer[] = [];
		let size = 0;
		let truncated = false;
		let stderr = "";
		let done = false;
		let stopping = false;
		let escalated = false;
		let closed = false;
		const timers: NodeJS.Timeout[] = [];
		const finish = (code: number | null, spawnError?: string) => {
			if (done || (stopping && !escalated)) return;
			done = true;
			for (const t of timers) clearTimeout(t);
			child.stdout.destroy();
			child.stderr.destroy();
			resolve({ stdout: Buffer.concat(chunks), stderr, code, truncated, spawnError });
		};
		const stop = () => {
			if (stopping || done || child.pid === undefined) return;
			stopping = true;
			const pid = child.pid;
			killTree(pid, "SIGTERM");
			timers.push(
				setTimeout(() => {
					if (done) return;
					killTree(pid, "SIGKILL");
					escalated = true;
					if (closed) finish(child.exitCode);
					else timers.push(setTimeout(() => finish(child.exitCode), CLOSE_GRACE_MS));
				}, KILL_GRACE_MS),
			);
		};
		timers.push(setTimeout(stop, opts.timeoutMs ?? GIT_TIMEOUT_MS));
		child.stdout.on("data", (chunk: Buffer) => {
			if (truncated) return;
			const room = maxBytes - size;
			if (chunk.length > room) {
				chunks.push(chunk.subarray(0, room));
				size = maxBytes;
				truncated = true;
				stop();
			} else {
				chunks.push(chunk);
				size += chunk.length;
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 4096) stderr += chunk.toString("utf8");
		});
		child.once("error", (e) => finish(null, e.message));
		child.once("close", (code) => {
			closed = true;
			// Closed pipes do not prove the process group is gone. Await escalation when stopping.
			finish(code);
		});
	});
}

export type LoadResult =
	| { ok: true; files: DiffFile[]; label: string; notices: string[]; root: string }
	| { ok: false; error: string };

const BAD_REF = /^(-|$)|[\s\0]/;

function firstLine(text: string): string {
	return text.trim().split("\n")[0] ?? "";
}

/** Resolve the repo root, or explain why this is not a usable work tree. */
export async function repoRoot(cwd: string): Promise<{ root: string } | { error: string }> {
	const r = await runGit(["rev-parse", "--show-toplevel"], { cwd, maxBytes: 4096 });
	if (r.spawnError) return { error: `cannot run git: ${r.spawnError}` };
	if (r.code !== 0) return { error: "not a git repository (or no work tree here)" };
	return { root: r.stdout.toString("utf8").trim() };
}

/** The ref to diff the work tree against: `ref`, else HEAD, else the empty tree in a repo with no commits. */
async function resolveBase(
	root: string,
	ref: string | undefined,
): Promise<{ base: string; label: string } | { error: string }> {
	if (ref !== undefined) {
		if (BAD_REF.test(ref)) return { error: `invalid ref ${JSON.stringify(ref)}` };
		return { base: ref, label: ref };
	}
	const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { cwd: root, maxBytes: 4096 });
	if (head.code === 0) return { base: "HEAD", label: "HEAD" };
	const empty = await runGit(["hash-object", "-t", "tree", "/dev/null"], { cwd: root, maxBytes: 4096 });
	const hash = empty.stdout.toString("utf8").trim();
	if (empty.code !== 0 || !hash) return { error: "cannot resolve HEAD or the empty tree" };
	return { base: hash, label: "empty tree (no commits yet)" };
}

/** Tracked changes (work tree + index vs base) and untracked files, parsed and capped. */
export async function loadDiff(cwd: string, ref?: string): Promise<LoadResult> {
	const repo = await repoRoot(cwd);
	if ("error" in repo) return { ok: false, error: repo.error };
	const root = repo.root;
	const resolved = await resolveBase(root, ref);
	if ("error" in resolved) return { ok: false, error: resolved.error };

	const diff = await runGit(
		["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", resolved.base, "--"],
		{ cwd: root },
	);
	if (diff.spawnError) return { ok: false, error: `cannot run git: ${diff.spawnError}` };
	if (diff.code !== 0 && !diff.truncated) {
		const why = firstLine(diff.stderr) || `git diff exited with ${diff.code}`;
		return { ok: false, error: ref ? `bad ref ${JSON.stringify(ref)}: ${why}` : why };
	}
	const notices: string[] = [];
	const files = parseUnifiedDiff(diff.stdout.toString("utf8"));
	if (diff.truncated) {
		notices.push(`diff output cut at ${TOTAL_BYTES / 1024 / 1024}MB; later files are missing`);
		const last = files.at(-1);
		if (last && !last.notice) last.notice = "patch cut by the total output cap";
	}

	// Untracked files only make sense against the work tree, not for a `a..b` commit range.
	if (ref === undefined || !ref.includes("..")) {
		const budget = Math.max(0, TOTAL_BYTES - diff.stdout.length);
		files.push(...(await untrackedFiles(root, budget, notices)));
	}
	return { ok: true, files, label: resolved.label, notices, root };
}

async function untrackedFiles(root: string, budget: number, notices: string[]): Promise<DiffFile[]> {
	const ls = await runGit(["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root });
	if (ls.code !== 0) {
		notices.push(`could not list untracked files: ${firstLine(ls.stderr)}`);
		return [];
	}
	const paths = ls.stdout.toString("utf8").split("\0").filter(Boolean).sort();
	const out: DiffFile[] = [];
	let remaining = budget;
	for (const path of paths.slice(0, MAX_UNTRACKED_FILES)) {
		const file = await untrackedPatch(root, path, Math.min(PER_FILE_BYTES, remaining));
		remaining -= file.lines.reduce((n, l) => n + l.length + 1, 0);
		out.push(file);
	}
	if (paths.length > MAX_UNTRACKED_FILES) {
		notices.push(`${paths.length - MAX_UNTRACKED_FILES} more untracked files not listed`);
	}
	return out;
}

/** A synthetic "new file" patch for an untracked path, size-capped, binary and symlink aware. */
export async function untrackedPatch(root: string, path: string, capBytes: number): Promise<DiffFile> {
	const header = [`diff --git a/${path} b/${path}`, "new file (untracked)", "--- /dev/null", `+++ b/${path}`];
	const base = { path, status: "untracked" as const, hunkStart: header.length, additions: 0, deletions: 0 };
	const note = (lines: string[], notice?: string): DiffFile => ({ ...base, lines: [...header, ...lines], notice });
	const full = join(root, path);
	try {
		const st = await lstat(full);
		if (st.isSymbolicLink()) {
			const target = await readlink(full);
			return { ...base, lines: [...header, "@@ -0,0 +1 @@", `+-> ${target}`], additions: 1 };
		}
		if (!st.isFile())
			return { ...base, status: "untracked", hunkStart: header.length, lines: [...header, "\\ not a regular file"] };
		if (capBytes <= 0) return note(["\\ content omitted: output budget exhausted"]);
		const handle = await open(full, "r");
		let buf: Buffer;
		try {
			buf = Buffer.alloc(Math.min(st.size, capBytes + 1));
			const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
			buf = buf.subarray(0, bytesRead);
		} finally {
			await handle.close();
		}
		if (buf.subarray(0, SNIFF_BYTES).includes(0)) {
			return { ...base, status: "untracked", lines: [...header, `\\ binary file (${st.size} bytes)`] };
		}
		if (st.size === 0) return note(["\\ empty file"]);
		let cut = buf.length > capBytes;
		const text = buf.subarray(0, Math.min(buf.length, capBytes)).toString("utf8");
		const lines = text.split("\n");
		if (lines.at(-1) === "") lines.pop();
		// The `+` prefix and newline add bytes, so the cap is applied to the patch lines themselves.
		const body: string[] = [];
		let bytes = 0;
		for (const l of lines) {
			bytes += l.length + 2;
			if (bytes > capBytes) {
				cut = true;
				break;
			}
			body.push(`+${l}`);
		}
		const shown = body.length;
		const missingNewline = !cut && !text.endsWith("\n");
		const hunk = `@@ -0,0 +1,${shown} @@`;
		return {
			...base,
			lines: [...header, hunk, ...body, ...(missingNewline ? ["\\ No newline at end of file"] : [])],
			additions: shown,
			notice: cut ? `file truncated at ${Math.round(capBytes / 1024)}KB (${st.size} bytes total)` : undefined,
		};
	} catch (error) {
		return note([`\\ unreadable: ${(error as Error).message}`]);
	}
}

/** `git diff --stat` for the tracked changes plus `?? path` lines, for non-TUI output. */
export async function loadStat(
	cwd: string,
	ref?: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
	const repo = await repoRoot(cwd);
	if ("error" in repo) return { ok: false, error: repo.error };
	const resolved = await resolveBase(repo.root, ref);
	if ("error" in resolved) return { ok: false, error: resolved.error };
	const stat = await runGit(["diff", "--no-color", "--no-ext-diff", "--stat", resolved.base, "--"], {
		cwd: repo.root,
		maxBytes: 256 * 1024,
	});
	if (stat.code !== 0 && !stat.truncated) {
		const why = firstLine(stat.stderr) || `git diff exited with ${stat.code}`;
		return { ok: false, error: ref ? `bad ref ${JSON.stringify(ref)}: ${why}` : why };
	}
	let text = stat.stdout.toString("utf8").trimEnd();
	if (ref === undefined || !ref.includes("..")) {
		const ls = await runGit(["ls-files", "--others", "--exclude-standard", "-z"], {
			cwd: repo.root,
			maxBytes: 256 * 1024,
		});
		const untracked = ls.stdout.toString("utf8").split("\0").filter(Boolean).sort();
		if (untracked.length > 0) text += `${text ? "\n" : ""}${untracked.map((p) => `?? ${p}`).join("\n")}`;
	}
	return { ok: true, text };
}
