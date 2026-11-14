/**
 * OpenCode usage from its SQLite database (`opencode.db`, in WAL mode).
 *
 * The schema is taken from third-party readers, not OpenCode's docs: it is verified only by this
 * package's fixtures, and any mismatch is reported as a diagnostic, never a crash. The database is
 * opened read-only with one query, no writes and no long transaction. While `-wal` exists (OpenCode
 * is running or crashed) it is a normal `mode=ro` open, so un-checkpointed WAL pages are visible.
 * A WAL-mode database with no `-wal` has nothing pending, and a plain read-only open would still
 * create `-shm`/`-wal` beside it, so that case opens `immutable=1` to leave the directory untouched.
 * A busy or locked database is retried for 2s, then reported as a generic busy diagnostic. The query projects only counters,
 * IDs, timestamps and model names, so message and part bodies, titles and directories never leave
 * SQLite. `auth.json` is never opened. OpenCode keeps no quota.
 *
 * A message whose `data` is not valid JSON is skipped.
 *
 * Unlike the JSONL readers this takes the database file (not a root) and keeps no cache: the main
 * file's mtime does not track WAL writes, so every assistant row (one row of counters each) is read
 * on each load. Very large databases cost proportionally.
 *
 * `tokens.reasoning` is reported separately from `tokens.output`, so it is billed output here.
 */

import { open, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { timeOf } from "../jsonl.ts";
import { type Call, mergeSessionMetadata, type Session } from "../load.ts";
import { nth } from "../nth.ts";
import { counters, emptyScan, entryHash, type HarnessScan, sessionHash, str, unreadable } from "./common.ts";

/** The subset of `node:sqlite` this reader uses, so tests can inject a stand-in. */
export interface SqliteModule {
	DatabaseSync: new (
		path: string,
		options: { readOnly: boolean },
	) => {
		exec(sql: string): void;
		prepare(sql: string): { all(): Record<string, unknown>[] };
		close(): void;
	};
}

export type LoadSqlite = () => Promise<SqliteModule>;

/** `node:sqlite` is absent before Node 22.5 (and flagged before 22.13): load it lazily. */
export const loadNodeSqlite: LoadSqlite = () => import("node:sqlite") as Promise<SqliteModule>;

const QUERY = `
SELECT m.id AS id, m.session_id AS sid, s.parent_id IS NOT NULL AS child,
  COALESCE(json_extract(m.data, '$.time.created'), m.time_created) AS ms,
  json_extract(m.data, '$.providerID') AS provider, json_extract(m.data, '$.modelID') AS model,
  json_extract(m.data, '$.tokens.input') AS input, json_extract(m.data, '$.tokens.output') AS output,
  json_extract(m.data, '$.tokens.reasoning') AS reasoning,
  json_extract(m.data, '$.tokens.cache.read') AS cache_read, json_extract(m.data, '$.tokens.cache.write') AS cache_write,
  json_extract(m.data, '$.cost') AS cost
FROM message m LEFT JOIN session s ON s.id = m.session_id
WHERE CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.role') = 'assistant' ELSE 0 END`;

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

/** How long a busy or locked database is retried before giving up. */
const BUSY_TIMEOUT_MS = 2000;

/** SQLite primary result codes for `SQLITE_BUSY` and `SQLITE_LOCKED` (extended codes keep them in the low byte). */
const BUSY_CODES = new Set([5, 6]);

const isBusy = (error: unknown): boolean => {
	const code = (error as { errcode?: unknown } | null)?.errcode;
	return typeof code === "number" && BUSY_CODES.has(code & 0xff);
};

/** True for a WAL-mode database (header bytes 18-19 are 2) with no `-wal` file: nothing is pending. */
async function isCheckpointedWal(path: string): Promise<boolean> {
	if (await isFile(`${path}-wal`)) return false;
	const handle = await open(path, "r");
	try {
		const header = Buffer.alloc(20);
		const { bytesRead } = await handle.read(header, 0, 20, 0);
		return bytesRead === 20 && header[18] === 2 && header[19] === 2;
	} finally {
		await handle.close();
	}
}

/** Read every assistant message from the OpenCode database at `dbPath`. Missing file is "not installed". */
export async function readOpenCode(dbPath: string, load: LoadSqlite = loadNodeSqlite): Promise<HarnessScan> {
	if (!(await isFile(dbPath))) return emptyScan(false);
	let rows: Record<string, unknown>[];
	try {
		const { DatabaseSync } = await load();
		const target = (await isCheckpointedWal(dbPath)) ? `${pathToFileURL(dbPath).href}?mode=ro&immutable=1` : dbPath;
		const db = new DatabaseSync(target, { readOnly: true });
		try {
			db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
			rows = db.prepare(QUERY).all();
		} finally {
			db.close();
		}
	} catch (error) {
		// Deliberately drops the error text: SQLite messages can quote paths.
		if (isBusy(error)) return emptyScan(true, ["opencode: database busy, skipped"]);
		return emptyScan(true, ["opencode: database unreadable (missing node:sqlite or unexpected schema), skipped"]);
	}
	const calls: Call[] = [];
	const spans = new Map<string, Session>();
	let bad = 0;
	for (const r of rows) {
		const raw = counters([r.input, r.output, r.reasoning, r.cache_read, r.cache_write]);
		const cost = r.cost ?? null;
		const [id, sid, provider, model, ms] = [str(r.id), str(r.sid), str(r.provider), str(r.model), timeOf(r.ms)];
		if (
			!raw ||
			(cost !== null && (typeof cost !== "number" || !(cost >= 0))) ||
			!id ||
			!sid ||
			!provider ||
			!model ||
			ms <= 0
		) {
			bad++;
			continue;
		}
		const [input, output, cacheRead, cacheWrite] = [nth(raw, 0), nth(raw, 1) + nth(raw, 2), nth(raw, 3), nth(raw, 4)];
		if (input + output + cacheRead + cacheWrite === 0) continue;
		const session = sessionHash("opencode", sid);
		const entryId = entryHash("opencode", id);
		calls.push({
			harness: "opencode",
			session,
			entryId,
			ms,
			provider,
			model,
			input,
			output,
			cacheRead,
			cacheWrite,
			cost,
		});
		const span = spans.get(session);
		spans.set(session, {
			path: session,
			startMs: Math.min(ms, span?.startMs ?? ms),
			endMs: Math.max(ms, span?.endMs ?? ms),
			child: Number(r.child) === 1,
		});
	}
	const sessionMetadata = [...mergeSessionMetadata([...spans.values()]).values()];
	return {
		...emptyScan(true, unreadable("opencode", bad)),
		calls: calls.sort((a, b) => a.ms - b.ms),
		sessionMetadata,
		sessions: sessionMetadata.filter((s) => !s.child),
	};
}
