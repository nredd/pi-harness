/**
 * OpenCode usage from its SQLite database (`opencode.db`, in WAL mode).
 *
 * The schema is taken from third-party readers, not OpenCode's docs: it is verified only by this
 * package's fixtures, and any mismatch is reported as a diagnostic, never a crash. The database is
 * opened read-only (a normal `mode=ro` open, never `immutable=1`, so un-checkpointed WAL pages are
 * visible), with one query, no writes and no long transaction. The query projects only counters,
 * IDs, timestamps and model names, so message and part bodies, titles and directories never leave
 * SQLite. `auth.json` is never opened. OpenCode keeps no quota.
 *
 * `tokens.reasoning` is reported separately from `tokens.output`, so it is billed output here.
 */

import { stat } from "node:fs/promises";
import { timeOf } from "../jsonl.ts";
import { type Call, mergeSessionMetadata, type Session } from "../load.ts";
import { nth } from "../nth.ts";
import { counters, emptyScan, entryHash, type HarnessScan, sessionHash, str } from "./common.ts";

/** The subset of `node:sqlite` this reader uses, so tests can inject a stand-in. */
export interface SqliteModule {
	DatabaseSync: new (
		path: string,
		options: { readOnly: boolean },
	) => {
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
WHERE json_extract(m.data, '$.role') = 'assistant'`;

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

/** Read every assistant message from the OpenCode database at `dbPath`. Missing file is "not installed". */
export async function readOpenCode(dbPath: string, load: LoadSqlite = loadNodeSqlite): Promise<HarnessScan> {
	if (!(await isFile(dbPath))) return emptyScan(false);
	let rows: Record<string, unknown>[];
	try {
		const { DatabaseSync } = await load();
		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			rows = db.prepare(QUERY).all();
		} finally {
			db.close();
		}
	} catch {
		// Deliberately drops the error text: SQLite messages can quote paths.
		return emptyScan(true, ["opencode: database unreadable (missing node:sqlite or unexpected schema), skipped"]);
	}
	const calls: Call[] = [];
	const spans = new Map<string, Session>();
	let bad = 0;
	for (const r of rows) {
		const raw = counters([r.input, r.output, r.reasoning, r.cache_read, r.cache_write]);
		const cost = r.cost ?? 0;
		const [id, sid, provider, model, ms] = [str(r.id), str(r.sid), str(r.provider), str(r.model), timeOf(r.ms)];
		if (!raw || typeof cost !== "number" || cost < 0 || !id || !sid || !provider || !model || ms <= 0) {
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
		...emptyScan(true, bad > 0 ? [`opencode: ! ${bad} unreadable lines`] : []),
		calls: calls.sort((a, b) => a.ms - b.ms),
		sessionMetadata,
		sessions: sessionMetadata.filter((s) => !s.child),
	};
}
