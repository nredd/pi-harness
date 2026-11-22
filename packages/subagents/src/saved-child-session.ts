import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import type { AgentRecord } from "./types.ts";

export const RECENT_CHILD_WRITE_SECONDS = 120;
/** A write this far ahead of the clock is skew (NFS, a synced volume, a restore), not a live writer. */
export const FUTURE_WRITE_TOLERANCE_MS = 5_000;
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
	/** Resolves directories and the parent file; pass one `canonicalPaths()` per batch of checks. */
	canonical?: (path: string) => string;
}

function validChildPath(file: string): boolean {
	return isAbsolute(file) && !file.split(/[\\/]/).includes("..");
}

/**
 * A memoized `realpathSync` for paths every row of one startup shares (child
 * session directories, the parent file). Failures are not cached and rethrow.
 */
export function canonicalPaths(): (path: string) => string {
	const resolved = new Map<string, string>();
	return (path) => {
		let canonical = resolved.get(path);
		if (canonical === undefined) {
			canonical = realpathSync(path);
			resolved.set(path, canonical);
		}
		return canonical;
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

/** A reopen can journal the canonical spelling of a predecessor's symlinked transcript. */
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

/** Check the saved file without opening a writable SessionManager on untrusted history. */
export function checkSavedChild(options: SavedChildCheckOptions): SavedChildCheck {
	const { file, parentFile, status, now, savedCwd, canonical = realpathSync } = options;
	if (!validChildPath(file)) {
		return { refusal: `invalid child session path: ${file}` };
	}
	try {
		const canonicalFile = realpathSync(file);
		const inside = options.directories.some((directory) => {
			if (directory === undefined) return false;
			try {
				return canonicalFile.startsWith(canonical(directory).replace(/[\\/]?$/, sep));
			} catch {
				return false;
			}
		});
		if (!inside) {
			return { refusal: `child session is outside its configured directory: ${file}` };
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
			const recordedParent = realpathSync(parentPath);
			parentPath = parentFile;
			if (recordedParent !== canonical(parentPath)) return wrongParent;
		} catch {
			return { refusal: `parent session is missing or unreadable: ${parentPath}` };
		}
		if (savedCwd !== undefined && header.cwd !== savedCwd) {
			return { refusal: `child session does not match its saved working directory: ${file}` };
		}
		if (status === "running" && stats.mtimeMs - now <= FUTURE_WRITE_TOLERANCE_MS) {
			const age = Math.max(0, Math.floor((now - stats.mtimeMs) / 1000));
			if (age < RECENT_CHILD_WRITE_SECONDS) {
				return {
					file: canonicalFile,
					recent: true,
					refusal: `may still be running in another process (last write ${age}s ago; retry in ${RECENT_CHILD_WRITE_SECONDS - age} s): ${file}`,
				};
			}
		}
		return { file: canonicalFile };
	} catch {
		return { refusal: `child session is missing or unreadable: ${file}` };
	}
}
