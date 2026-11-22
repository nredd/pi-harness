import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import type { AgentRecord } from "./types.ts";

export const RECENT_CHILD_WRITE_SECONDS = 120;
/**
 * A transcript dated in the future (clock skew, NFS, a synced or restored
 * volume) is indistinguishable from a live writer on a clock ahead of ours, so
 * it stays possibly running until our clock passes it by
 * `RECENT_CHILD_WRITE_SECONDS`. Past this wait the refusal stops counting down
 * and says to reset the timestamp instead.
 */
export const FUTURE_WRITE_WAIT_CAP_SECONDS = 24 * 60 * 60;
const MAX_HEADER_BYTES = 64 * 1024;
/** Header lines are short; read this much per step so a row costs one small read, not 64 KiB. */
const HEADER_CHUNK_BYTES = 4 * 1024;
let headerBuffer: Buffer | undefined;

type SavedChildCheck =
	| { file: string; recent?: never }
	| { refusal: string; recent?: never }
	| { file: string; refusal: string; recent: true };

/** The transcript spellings a saved row carries: as written, and canonical at write time. */
export interface SavedChildPaths {
	sessionFile?: string;
	canonicalSessionFile?: string;
}

/** Inputs for `checkSavedChild`; `canonical` is shared across the rows of one startup. */
export interface SavedChildCheckOptions {
	file: string;
	/** The directory the child was created in, when journaled, and the one current settings give. */
	directories: readonly (string | undefined)[];
	parentFile: string | undefined;
	status: AgentRecord["status"];
	now: number;
	savedCwd?: string;
	/**
	 * The canonical transcript this row must still resolve to: the one journaled
	 * at write time, or the one startup bound when a dispatch rechecks it.
	 */
	boundFile?: string;
	/** Resolves directories and the parent file; pass one `canonicalPaths()` per batch of checks. */
	canonical?: (path: string) => string;
}

function validChildPath(file: string): boolean {
	return isAbsolute(file) && !file.split(/[\\/]/).includes("..");
}

/**
 * A memoized `realpathSync` for paths the rows of one startup share (child
 * session directories, the parent file a header names). A failure is cached
 * too and rethrown, so a missing directory costs one lookup, not one per row.
 */
export function canonicalPaths(): (path: string) => string {
	const resolved = new Map<string, { canonical: string } | { error: unknown }>();
	return (path) => {
		let entry = resolved.get(path);
		if (entry === undefined) {
			try {
				entry = { canonical: realpathSync(path) };
			} catch (error) {
				entry = { error };
			}
			resolved.set(path, entry);
		}
		if ("error" in entry) throw entry.error;
		return entry.canonical;
	};
}

/**
 * The canonical spelling of a child transcript, journaled when its row is
 * written so a later startup can link rows after the file is gone. Falls back
 * to the canonical directory when the session has not been flushed yet.
 */
export function canonicalChildPath(file: string): string | undefined {
	if (!validChildPath(file)) return undefined;
	try {
		return realpathSync(file);
	} catch {
		try {
			return join(realpathSync(dirname(file)), basename(file));
		} catch {
			return undefined;
		}
	}
}

/**
 * Whether two saved rows name the same transcript: the same spelling, either
 * row's write-time canonical form matching the other's spelling or canonical
 * form, or (legacy rows, file still present) both spellings resolving to one
 * file now. A reopen can journal the canonical spelling of a predecessor's
 * symlinked transcript.
 */
export function sameSavedChild(previous: SavedChildPaths, next: SavedChildPaths): boolean {
	if (!previous.sessionFile || !next.sessionFile) return false;
	// Keep exact or write-time canonical links even when the transcript has since disappeared.
	const forms = [next.sessionFile, next.canonicalSessionFile];
	if (forms.includes(previous.sessionFile)) return true;
	if (previous.canonicalSessionFile && forms.includes(previous.canonicalSessionFile)) return true;
	if (!validChildPath(previous.sessionFile) || !validChildPath(next.sessionFile)) return false;
	try {
		return realpathSync(previous.sessionFile) === realpathSync(next.sessionFile);
	} catch {
		return false;
	}
}

/** The first line of an open transcript, read in small steps, or undefined past the header cap. */
function readHeaderLine(fd: number): string | undefined {
	headerBuffer ??= Buffer.allocUnsafe(MAX_HEADER_BYTES);
	let length = 0;
	while (length < MAX_HEADER_BYTES) {
		const bytes = readSync(fd, headerBuffer, length, Math.min(HEADER_CHUNK_BYTES, MAX_HEADER_BYTES - length), length);
		if (bytes === 0) return undefined;
		const newline = headerBuffer.subarray(length, length + bytes).indexOf(10);
		if (newline !== -1) return headerBuffer.toString("utf8", 0, length + newline);
		length += bytes;
	}
	return undefined;
}

/**
 * When a transcript was written too recently (or in the future) to rule out a
 * live writer: the write's age and how long to wait. Undefined once it is old enough.
 */
function lastWrite(mtimeMs: number, now: number): string | undefined {
	if (mtimeMs > now) {
		const skew = Math.ceil((mtimeMs - now) / 1000);
		const wait = skew + RECENT_CHILD_WRITE_SECONDS;
		const retry =
			wait <= FUTURE_WRITE_WAIT_CAP_SECONDS
				? `retry in ${wait} s`
				: `retry in more than ${FUTURE_WRITE_WAIT_CAP_SECONDS} s, or reset its timestamp once no process writes it`;
		return `last write ${skew}s in the future, possibly clock skew; ${retry}`;
	}
	const age = Math.floor((now - mtimeMs) / 1000);
	return age < RECENT_CHILD_WRITE_SECONDS
		? `last write ${age}s ago; retry in ${RECENT_CHILD_WRITE_SECONDS - age} s`
		: undefined;
}

/**
 * Whether `canonicalFile` lies in one of `directories`, or `"unresolved"` when
 * none holds it and one did not resolve (the caller keeps the "missing or
 * unreadable" refusal an unresolvable configured directory always had).
 */
function insideDirectory(
	canonicalFile: string,
	directories: readonly (string | undefined)[],
	canonical: (path: string) => string,
): boolean | "unresolved" {
	let inside: boolean | "unresolved" = false;
	for (const directory of directories) {
		if (directory === undefined) continue;
		try {
			if (canonicalFile.startsWith(canonical(directory).replace(/[\\/]?$/, sep))) return true;
		} catch {
			inside = "unresolved";
		}
	}
	return inside;
}

/** Check the saved file without opening a writable SessionManager on untrusted history. */
export function checkSavedChild(options: SavedChildCheckOptions): SavedChildCheck {
	const { file, parentFile, status, now, savedCwd, canonical = realpathSync } = options;
	if (!validChildPath(file)) {
		return { refusal: `invalid child session path: ${file}` };
	}
	try {
		const canonicalFile = realpathSync(file);
		const inside = insideDirectory(canonicalFile, options.directories, canonical);
		if (inside === "unresolved") return { refusal: `child session is missing or unreadable: ${file}` };
		if (!inside) return { refusal: `child session is outside its configured directory: ${file}` };
		// A retargeted link inside the directory must not swap in another (valid) transcript.
		if (options.boundFile !== undefined && canonicalFile !== options.boundFile) {
			return { refusal: `child session no longer resolves to its recorded transcript: ${file}` };
		}
		const stats = statSync(canonicalFile);
		if (!stats.isFile()) return { refusal: `child session is not a regular file: ${file}` };
		const fd = openSync(canonicalFile, "r");
		let header: { type?: string; parentSession?: string; cwd?: string } | null;
		try {
			const line = readHeaderLine(fd);
			if (line === undefined) return { refusal: `child session has no readable header: ${file}` };
			header = JSON.parse(line);
		} finally {
			closeSync(fd);
		}
		const wrongParent = { refusal: `child session does not belong to this parent: ${file}` };
		if (!parentFile || header?.type !== "session" || !header.parentSession) return wrongParent;
		let parentPath = header.parentSession;
		try {
			const recordedParent = canonical(parentPath);
			parentPath = parentFile;
			if (recordedParent !== canonical(parentPath)) return wrongParent;
		} catch {
			return { refusal: `parent session is missing or unreadable: ${parentPath}` };
		}
		if (savedCwd !== undefined && header.cwd !== savedCwd) {
			return { refusal: `child session does not match its saved working directory: ${file}` };
		}
		// Any status: a journal row can be lost (a failed or truncated append), so
		// only the transcript's write age can say no process still drives it.
		const write = lastWrite(stats.mtimeMs, now);
		if (write) {
			const recorded = status === "running" ? "" : `last recorded status ${status}, `;
			return {
				file: canonicalFile,
				recent: true,
				refusal: `may still be running in another process (${recorded}${write}): ${file}`,
			};
		}
		return { file: canonicalFile };
	} catch {
		return { refusal: `child session is missing or unreadable: ${file}` };
	}
}
