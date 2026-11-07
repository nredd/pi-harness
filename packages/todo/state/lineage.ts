/**
 * The session files a session was forked from, nearest first: its header's `parentSession`, then
 * that file's own header `parentSession`, and so on. An agent registered under one of these files
 * runs for an ancestor of this session, so it is "running for another session" rather than a dead
 * owner. Any other file belongs to an unrelated session (`/new`, `/resume` of another one).
 */

import { closeSync, openSync, readSync } from "node:fs";

/** A session header is one short JSON line; bound the read and the walk. */
const HEADER_BYTES = 8192;
const MAX_DEPTH = 64;

/** Minimal session manager surface needed here. */
export interface LineageSource {
	getHeader?: () => { parentSession?: string } | null | undefined;
}

/** The `parentSession` in the header line of `file`, or `undefined` when unreadable or absent. */
function readParentSession(file: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const buffer = Buffer.alloc(HEADER_BYTES);
		const length = readSync(fd, buffer, 0, HEADER_BYTES, 0);
		const header = JSON.parse(buffer.toString("utf8", 0, length).split("\n", 1)[0]) as Record<string, unknown>;
		return typeof header.parentSession === "string" ? header.parentSession : undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Every ancestor session file of `manager`'s session; empty for a session that is no fork. */
export function forkAncestry(manager: LineageSource): Set<string> {
	const ancestors = new Set<string>();
	let next = manager.getHeader?.()?.parentSession;
	while (next && !ancestors.has(next) && ancestors.size < MAX_DEPTH) {
		ancestors.add(next);
		next = readParentSession(next);
	}
	return ancestors;
}
