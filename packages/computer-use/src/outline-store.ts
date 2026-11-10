import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { debuglog } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SerializedOutline } from "./outline.ts";

/** Newest outlines kept on disk, across all Pi sessions sharing the agent directory. */
export const OUTLINE_STORE_LIMIT = 64;

const debugLog = debuglog("pi-computer-use");
const ENTRY_NAME = /^(\d{16})-(\d{6})-([0-9a-f]{32})\.json$/;

let sequence = 0;

/** Directory holding persisted outlines: `<agent dir>/cache/pi-computer-use/outlines`. */
export function outlineStoreDir(): string {
	return path.join(getAgentDir(), "cache", "pi-computer-use", "outlines");
}

function stateKey(stateId: string): string {
	return createHash("sha256").update(stateId).digest("hex").slice(0, 32);
}

/** Entries newest first. Names sort by write time, then per-process sequence. */
function listEntries(dir: string): Array<{ name: string; key: string }> {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const entries: Array<{ name: string; key: string }> = [];
	for (const name of names) {
		const match = ENTRY_NAME.exec(name);
		if (match) entries.push({ name, key: match[3]! });
	}
	return entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

function removeQuietly(file: string): void {
	try {
		unlinkSync(file);
	} catch (error) {
		debugLog("outline store: could not remove %s: %s", file, error instanceof Error ? error.message : String(error));
	}
}

/**
 * Persist `outline` for `stateId` outside the Pi session file, then evict all but the newest
 * `limit` entries. Never throws: a failed write only means a later restore reports the state
 * as unavailable. Side effects: writes and deletes files under `outlineStoreDir()`.
 */
export function saveStoredOutline(stateId: string, outline: SerializedOutline, limit = OUTLINE_STORE_LIMIT): void {
	const dir = outlineStoreDir();
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const key = stateKey(stateId);
		const name = `${String(Date.now()).padStart(16, "0")}-${String(sequence++ % 1_000_000).padStart(6, "0")}-${key}.json`;
		const tmp = path.join(dir, `.${name}.tmp`);
		writeFileSync(tmp, JSON.stringify({ stateId, outline }), { mode: 0o600 });
		renameSync(tmp, path.join(dir, name));
		// Newest first: drop older copies of the same state, then everything past the cap.
		const seen = new Set<string>();
		for (const entry of listEntries(dir)) {
			if (seen.has(entry.key) || seen.size >= limit) removeQuietly(path.join(dir, entry.name));
			else seen.add(entry.key);
		}
	} catch (error) {
		debugLog("outline store: could not save %s: %s", stateId, error instanceof Error ? error.message : String(error));
	}
}

/** Load the outline stored for `stateId`; `undefined` when evicted, missing or unreadable. */
export function loadStoredOutline(stateId: string): SerializedOutline | undefined {
	const dir = outlineStoreDir();
	const key = stateKey(stateId);
	const entry = listEntries(dir).find((candidate) => candidate.key === key);
	if (!entry) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path.join(dir, entry.name), "utf8")) as { stateId?: unknown; outline?: SerializedOutline };
		const outline = parsed.outline;
		if (parsed.stateId !== stateId || !outline?.root || typeof outline.lookId !== "string") return undefined;
		return outline;
	} catch (error) {
		debugLog("outline store: could not read %s: %s", stateId, error instanceof Error ? error.message : String(error));
		return undefined;
	}
}
