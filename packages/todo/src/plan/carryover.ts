/**
 * Open todos a fresh session can see from the session before it. Read-only: nothing is imported,
 * so the new session's ids, `nextId` and owners never mix with the old ones.
 *
 * Which session counts as previous:
 * - `/new`: the session `/new` replaced, as its live branch stood at `session_shutdown`. Core can move
 *   that branch's leaf (`/tree` without a summary) without writing anything, so its file is not read.
 *   The capture lives in this module, which the extension loader keeps across `/new`; a `/new` with
 *   no capture, a different predecessor, or a predecessor whose header has another cwd shows nothing.
 * - Process `startup`: the most recently written `.jsonl` in the session directory whose header
 *   has this cwd and no `parentSession` (persisted subagents and forks carry one). With parallel
 *   sessions in one cwd that is whichever wrote last, so the list names it and says it may still run.
 */

import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ownerLabel } from "../agents.ts";
import { replayFromBranch } from "../state/replay.ts";
import { sanitizeTerminalText } from "../tool/sanitize.ts";
import type { Task } from "../tool/types.ts";

/** The previous session's open todos, as it last recorded them. */
export interface CarriedTodos {
	sessionId: string;
	tasks: Task[];
}

/** What to show: the `/new` predecessor's captured todos, or a directory scan at process startup. */
export type PreviousSession = { carried: CarriedTodos } | { sessionDir: string; cwd: string; currentId: string };

/** The parts of a session manager the choice reads; optional like `forkAncestry`'s, so a host without them carries nothing. */
export interface FreshSessionManager {
	getSessionId(): string;
	getBranch(): readonly unknown[];
	getHeader?: () => { parentSession?: string; cwd?: string } | null | undefined;
	getCwd?: () => string;
	getSessionDir?: () => string;
	getSessionFile?: () => string | undefined;
}

/** A session `/new` replaced: its file, its header cwd and its open todos at shutdown. */
interface Outgoing {
	file: string;
	cwd: unknown;
	carried: CarriedTodos | undefined;
}

/** Captures keyed by the new session's file, which `session_shutdown` names as its target. */
const outgoing = new Map<string, Outgoing>();

function openTodosOf(sessionId: string, branch: readonly unknown[]): CarriedTodos | undefined {
	const state = replayFromBranch({ sessionManager: { getBranch: () => branch } });
	const tasks = state.tasks.filter((t) => t.status === "pending" || t.status === "in_progress");
	return tasks.length ? { sessionId, tasks } : undefined;
}

/**
 * Capture the open todos of a session `/new` is replacing, from its live branch. Called on
 * `session_shutdown`; every other reason, an in-memory session, or a manager that cannot be read
 * records nothing, so the next session shows nothing rather than a guess.
 */
export function recordOutgoing(
	event: { reason: string; targetSessionFile?: string },
	manager: FreshSessionManager,
): void {
	if (event.reason !== "new" || !event.targetSessionFile) return;
	try {
		const file = manager.getSessionFile?.();
		if (!file) return;
		const carried = openTodosOf(manager.getSessionId(), manager.getBranch());
		outgoing.set(event.targetSessionFile, { file, cwd: manager.getHeader?.()?.cwd, carried });
	} catch {
		// A disposed or stale manager: no capture, so the fresh session gets no list.
	}
}

/** Take (and drop) the capture for `file`, the session `/new` just started. */
function takeOutgoing(file: string | undefined): Outgoing | undefined {
	if (file === undefined) return undefined;
	const capture = outgoing.get(file);
	outgoing.delete(file);
	return capture;
}

/**
 * The previous session to read for a `session_start`, or `undefined` when this is not a fresh
 * session: only `new` and `startup` with an empty branch and no `parentSession`, so `/resume`,
 * `/fork`, `/reload`, `--continue` and persisted subagent sessions never qualify. An in-memory
 * session (no session directory) has nothing to scan at startup.
 */
export function previousSessionOf(
	event: { reason: string; previousSessionFile?: string },
	manager: FreshSessionManager,
): PreviousSession | undefined {
	const capture = event.reason === "new" ? takeOutgoing(manager.getSessionFile?.()) : undefined;
	if (event.reason !== "new" && event.reason !== "startup") return undefined;
	if (manager.getBranch().length || manager.getHeader?.()?.parentSession) return undefined;
	if (event.reason === "new") {
		// Refuse rather than guess: the capture must be of this `/new`'s predecessor, in this cwd.
		if (!capture?.carried || capture.file !== event.previousSessionFile || capture.cwd !== manager.getCwd?.())
			return undefined;
		return { carried: capture.carried };
	}
	const sessionDir = manager.getSessionDir?.();
	const cwd = manager.getCwd?.();
	return sessionDir && cwd ? { sessionDir, cwd, currentId: manager.getSessionId() } : undefined;
}

/** Header lines are short; one that does not fit here is not a session file this reads. */
const HEADER_BYTES = 64 * 1024;

interface Header {
	id: string;
	cwd?: unknown;
	parentSession?: unknown;
}

function asHeader(value: unknown): Header | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const header = value as Record<string, unknown>;
	return header.type === "session" && typeof header.id === "string" ? (header as unknown as Header) : undefined;
}

function parseLine(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		// A concurrent writer can leave a partial last line.
		return undefined;
	}
}

async function readHeader(path: string): Promise<Header | undefined> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(HEADER_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
		const text = buffer.subarray(0, bytesRead).toString("utf8");
		const end = text.indexOf("\n");
		return end < 0 ? undefined : asHeader(parseLine(text.slice(0, end)));
	} finally {
		await handle.close();
	}
}

/** The newest top-level same-cwd session file other than `currentId`, with its id, or `undefined`. */
async function newestSibling(
	sessionDir: string,
	cwd: string,
	currentId: string,
): Promise<{ path: string; id: string } | undefined> {
	const names = (await readdir(sessionDir)).filter((name) => name.endsWith(".jsonl"));
	const files = await Promise.all(
		names.map(async (name) => {
			const path = join(sessionDir, name);
			// A file another process removes mid-scan, or a dangling link, is no candidate.
			const mtime = await stat(path).then(
				(s) => s.mtimeMs,
				() => undefined,
			);
			return mtime === undefined ? [] : [{ path, mtime }];
		}),
	);
	// Newest first; the name breaks mtime ties so the choice is deterministic.
	const candidates = files.flat().sort((a, b) => b.mtime - a.mtime || b.path.localeCompare(a.path));
	for (const { path } of candidates) {
		// An unreadable entry is skipped here; once one is chosen, a failed read never falls back.
		const header = await readHeader(path).catch(() => undefined);
		if (!header || header.id === currentId || header.cwd !== cwd || header.parentSession) continue;
		return { path, id: header.id };
	}
	return undefined;
}

/** The persisted branch of a session file: the last entry and its ancestors, root first. */
function branchOf(text: string): unknown[] {
	const lines = text.split("\n").filter(Boolean).map(parseLine);
	const byId = new Map<string, { id: string; parentId?: unknown }>();
	let leaf: string | undefined;
	for (const entry of lines.slice(1)) {
		if (entry === null || typeof entry !== "object") continue;
		const id = (entry as { id?: unknown }).id;
		if (typeof id !== "string") continue;
		byId.set(id, entry as { id: string });
		leaf = id;
	}
	const branch: unknown[] = [];
	const seen = new Set<string>();
	for (let id = leaf; id !== undefined && !seen.has(id); ) {
		seen.add(id);
		const entry = byId.get(id);
		if (!entry) break;
		branch.push(entry);
		id = typeof entry.parentId === "string" ? entry.parentId : undefined;
	}
	return branch.reverse();
}

/**
 * Read the previous session's open todos. `undefined` when there is no such session, it has none
 * open, or it cannot be read: a fresh session then gets no list, never a claim that none were open.
 */
export async function loadPreviousOpenTodos(previous: PreviousSession): Promise<CarriedTodos | undefined> {
	if ("carried" in previous) return previous.carried;
	try {
		const sibling = await newestSibling(previous.sessionDir, previous.cwd, previous.currentId);
		return sibling && openTodosOf(sibling.id, branchOf(await readFile(sibling.path, "utf8")));
	} catch {
		// Best effort: a missing directory, a file removed mid-scan or an unreadable file shows nothing.
		return undefined;
	}
}

/** The one-shot hidden message for the first request of a fresh session. */
export function formatCarriedTodos(carried: CarriedTodos): string {
	return [
		`[rpiv-todo] This is a fresh session. The previous session in this directory (${sanitizeTerminalText(carried.sessionId)}) last recorded these open todos. Nothing was imported into this session's list: those ids belong to that session, no agent owner there is running for you here, and that session may still be running elsewhere.`,
		...carried.tasks.map((t) => {
			const owner = ownerLabel(t.owner);
			return `- #${t.id} ${t.status} ${sanitizeTerminalText(t.subject)}${owner ? ` (was ${owner})` : ""}`;
		}),
		"If this request continues that work, recreate the todos it still needs with `todo`. Otherwise ignore this list.",
	].join("\n");
}
