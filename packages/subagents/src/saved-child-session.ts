import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, sep } from "node:path";

export const RECENT_CHILD_WRITE_SECONDS = 120;
const MAX_HEADER_BYTES = 64 * 1024;

type SavedChildCheck = { file: string } | { refusal: string; recent?: true };

/** Check the saved file without opening a writable SessionManager on untrusted history. */
export function checkSavedChild(
	file: string,
	directory: string,
	parentFile: string | undefined,
	lastStatus: string,
	now: number,
): SavedChildCheck {
	if (!isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
		return { refusal: `invalid child session path: ${file}` };
	}
	try {
		const canonicalFile = realpathSync(file);
		const prefix = realpathSync(directory).replace(/[\\/]?$/, sep);
		if (!canonicalFile.startsWith(prefix)) {
			return { refusal: `child session is outside its configured directory: ${file}` };
		}
		const stats = statSync(canonicalFile);
		if (!stats.isFile()) return { refusal: `child session is not a regular file: ${file}` };
		const fd = openSync(canonicalFile, "r");
		let header: { type?: string; parentSession?: string } | null;
		try {
			const buffer = Buffer.allocUnsafe(MAX_HEADER_BYTES);
			const bytes = readSync(fd, buffer, 0, buffer.length, 0);
			const newline = buffer.subarray(0, bytes).indexOf(10);
			if (newline === -1) return { refusal: `child session has no readable header: ${file}` };
			header = JSON.parse(buffer.toString("utf8", 0, newline));
		} finally {
			closeSync(fd);
		}
		if (!parentFile || header?.type !== "session" || header.parentSession !== parentFile) {
			return { refusal: `child session does not belong to this parent: ${file}` };
		}
		const age = Math.max(0, Math.floor((now - stats.mtimeMs) / 1000));
		if (lastStatus === "running" && age < RECENT_CHILD_WRITE_SECONDS) {
			return { recent: true, refusal: `may still be running in another process (last write ${age}s ago): ${file}` };
		}
		return { file: canonicalFile };
	} catch {
		return { refusal: `child session is missing or unreadable: ${file}` };
	}
}
