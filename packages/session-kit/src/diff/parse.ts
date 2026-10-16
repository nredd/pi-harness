/** Unified diff text -> per-file sections with status, counts and per-line kinds. */

export type FileStatus = "modified" | "added" | "deleted" | "renamed" | "copied" | "binary" | "mode" | "untracked";
export type LineKind = "meta" | "hunk" | "added" | "removed" | "context";

export interface DiffFile {
	/** Path to show (the new path for renames). */
	path: string;
	oldPath?: string;
	status: FileStatus;
	/** Raw patch lines, header first, without line terminators. */
	lines: string[];
	/** Index into `lines` of the first hunk header, or `lines.length` when there is none. */
	hunkStart: number;
	additions: number;
	deletions: number;
	/** Set when `lines` was cut at the per-file cap; additions/deletions still count everything. */
	notice?: string;
}

export const PER_FILE_BYTES = 200 * 1024;

/** Decode a git C-style quoted path (`"a\tb"`, octal escapes are UTF-8 bytes). */
export function unquoteC(s: string): string {
	if (!(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))) return s;
	const bytes: number[] = [];
	const body = s.slice(1, -1);
	const simple: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };
	for (let i = 0; i < body.length; i++) {
		const ch = body[i] as string;
		if (ch !== "\\") {
			bytes.push(...Buffer.from(ch, "utf8"));
			continue;
		}
		const next = body[i + 1] ?? "";
		const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1, i + 4));
		if (octal) {
			bytes.push(Number.parseInt(octal[0], 8));
			i += octal[0].length;
		} else if (next in simple) {
			bytes.push(simple[next] as number);
			i += 1;
		} else {
			bytes.push(92);
		}
	}
	return Buffer.from(bytes).toString("utf8");
}

function stripPrefix(p: string): string {
	const bare = unquoteC(p.replace(/\t.*$/, ""));
	return bare.replace(/^[ab]\//, "");
}

/** Paths from the `diff --git a/x b/y` line alone (used when no ---/+++ lines exist). */
function headerPaths(line: string): { oldPath: string; newPath: string } {
	const rest = line.slice("diff --git ".length);
	const quoted = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(rest);
	if (quoted) return { oldPath: stripPrefix(quoted[1] as string), newPath: stripPrefix(quoted[2] as string) };
	const n = (rest.length - 5) / 2;
	if (Number.isInteger(n) && n > 0 && rest.slice(2, 2 + n) === rest.slice(rest.length - n)) {
		const p = rest.slice(rest.length - n);
		return { oldPath: p, newPath: p };
	}
	const m = /^a\/(.*) b\/(.*)$/.exec(rest);
	return m ? { oldPath: m[1] as string, newPath: m[2] as string } : { oldPath: rest, newPath: rest };
}

function finishFile(lines: string[], overflow: { lines: number } | undefined, capBytes: number): DiffFile {
	const first = lines[0] ?? "";
	const hdr = headerPaths(first);
	let status: FileStatus = "modified";
	let oldPath = hdr.oldPath;
	let newPath = hdr.newPath;
	let hunkStart = lines.length;
	let additions = 0;
	let deletions = 0;
	let sawMode = false;
	let sawContent = false;
	for (let i = 1; i < lines.length; i++) {
		const l = lines[i] as string;
		if (hunkStart === lines.length) {
			if (l.startsWith("@@")) {
				hunkStart = i;
				sawContent = true;
				continue;
			}
			if (l.startsWith("new file mode")) status = "added";
			else if (l.startsWith("deleted file mode")) status = "deleted";
			else if (l.startsWith("rename from ")) {
				status = "renamed";
				oldPath = unquoteC(l.slice("rename from ".length));
			} else if (l.startsWith("rename to ")) newPath = unquoteC(l.slice("rename to ".length));
			else if (l.startsWith("copy from ")) {
				status = "copied";
				oldPath = unquoteC(l.slice("copy from ".length));
			} else if (l.startsWith("copy to ")) newPath = unquoteC(l.slice("copy to ".length));
			else if (l.startsWith("Binary files ") || l.startsWith("GIT binary patch")) {
				status = "binary";
				sawContent = true;
			} else if (l.startsWith("old mode") || l.startsWith("new mode")) sawMode = true;
			else if (l.startsWith("--- ") && l !== "--- /dev/null") oldPath = stripPrefix(l.slice(4));
			else if (l.startsWith("+++ ") && l !== "+++ /dev/null") newPath = stripPrefix(l.slice(4));
		} else if (l.startsWith("+")) additions++;
		else if (l.startsWith("-")) deletions++;
	}
	if (status === "modified" && sawMode && !sawContent) status = "mode";
	if (status === "deleted") newPath = oldPath;
	const file: DiffFile = {
		path: newPath,
		status,
		lines,
		hunkStart,
		additions,
		deletions,
	};
	if (oldPath !== newPath) file.oldPath = oldPath;
	if (overflow) {
		file.notice = `patch truncated: ${overflow.lines} more lines not shown (${Math.round(capBytes / 1024)}KB per-file cap)`;
		// Counts of the lines we dropped are unknown to the loop above; recount happens in parseUnifiedDiff.
	}
	return file;
}

/** Parse `git diff` output. `perFileBytes` bounds the lines kept per file; counts stay exact. */
export function parseUnifiedDiff(text: string, perFileBytes = PER_FILE_BYTES): DiffFile[] {
	const files: DiffFile[] = [];
	if (!text) return files;
	const all = text.split("\n");
	if (all.at(-1) === "") all.pop();
	let current: string[] | undefined;
	let bytes = 0;
	let dropped = 0;
	let extra = { additions: 0, deletions: 0 };
	let inHunk = false;

	const flush = () => {
		if (!current) return;
		const file = finishFile(current, dropped > 0 ? { lines: dropped } : undefined, perFileBytes);
		file.additions += extra.additions;
		file.deletions += extra.deletions;
		files.push(file);
	};

	for (const line of all) {
		if (line.startsWith("diff --git ")) {
			flush();
			current = [line];
			bytes = line.length + 1;
			dropped = 0;
			extra = { additions: 0, deletions: 0 };
			inHunk = false;
			continue;
		}
		if (!current) continue;
		if (line.startsWith("@@")) inHunk = true;
		if (bytes + line.length + 1 > perFileBytes) {
			dropped++;
			if (inHunk && line.startsWith("+")) extra.additions++;
			else if (inHunk && line.startsWith("-")) extra.deletions++;
			continue;
		}
		bytes += line.length + 1;
		current.push(line);
	}
	flush();
	return files;
}

/** Kind of every line of a file section, for colouring. */
export function classifyLines(file: DiffFile): LineKind[] {
	return file.lines.map((line, i) => {
		if (i < file.hunkStart) return "meta";
		if (line.startsWith("@@")) return "hunk";
		if (line.startsWith("+")) return "added";
		if (line.startsWith("-")) return "removed";
		if (line.startsWith("\\")) return "meta";
		return "context";
	});
}
