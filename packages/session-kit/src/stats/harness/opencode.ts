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
 * This takes the database file (not a root). The parsed result is cached per session (in the shared
 * harness cache, no paths) under a stamp of the main file plus `-wal` (summed sizes, newest mtime):
 * the main file's mtime alone does not track WAL writes. A changed stamp re-reads everything, in
 * keyset-paged queries of `PAGE_ROWS` rows that yield to the event loop between pages, so a cold
 * read of a large database never blocks the UI for the whole scan.
 *
 * `tokens.reasoning` is reported separately from `tokens.output`, so it is billed output here.
 */

import { open, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { timeOf } from "../jsonl.ts";
import { nth } from "../nth.ts";
import { counters, emptyScan, entryHash, type HarnessScan, probeStat, sessionHash, str, unreadable } from "./common.ts";
import { flattenHarness, type HarnessCache, type ParsedFile } from "./scan.ts";

/** The subset of `node:sqlite` this reader uses, so tests can inject a stand-in. */
export interface SqliteModule {
	DatabaseSync: new (
		path: string,
		options: { readOnly: boolean },
	) => {
		exec(sql: string): void;
		prepare(sql: string): { all(...params: (string | number)[]): Record<string, unknown>[] };
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
WHERE m.id > ? AND CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.role') = 'assistant' ELSE 0 END
ORDER BY m.id LIMIT ?`;

/** Rows per query: bounds the time the event loop is held between yields. */
export const PAGE_ROWS = 2000;

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

export interface OpenCodeOptions {
	/** Shared harness cache; without one nothing is cached. */
	cache?: HarnessCache;
	/** Rows per query; tests shrink it. */
	pageRows?: number;
	/** Called with the running row count after each page, so a caller can show progress. */
	onRows?: (rows: number) => void;
}

/** Cache key of everything read from the database at `dbPath`; the marker entry carries the stamp. */
const entryKey = (dbPath: string, name: string): string => `${dbPath}#${name}`;
const MARKER = "stamp";

/** Main file plus `-wal`: summed size, newest mtime. */
async function stampOf(main: { size: number; mtimeMs: number }, dbPath: string): Promise<Stamp> {
	const wal = await stat(`${dbPath}-wal`).catch(() => null);
	return { size: main.size + (wal?.size ?? 0), mtimeMs: Math.max(main.mtimeMs, wal?.mtimeMs ?? 0) };
}

interface Stamp {
	size: number;
	mtimeMs: number;
}

const yieldToLoop = (): Promise<void> => new Promise((done) => setImmediate(done));

/** Read every assistant row, a keyset page at a time, yielding between pages. */
function* pages(
	prepared: { all(...params: (string | number)[]): Record<string, unknown>[] },
	size: number,
): Generator<Record<string, unknown>[]> {
	let after = "";
	for (;;) {
		const page = prepared.all(after, size);
		if (page.length > 0) yield page;
		if (page.length < size) return;
		const next = str(page.at(-1)?.id);
		// An unusable last ID would refetch the same page forever.
		if (!next || next === after) return;
		after = next;
	}
}

/** Read every assistant message from the OpenCode database at `dbPath`. Missing file is "not installed". */
export async function readOpenCode(
	dbPath: string,
	load: LoadSqlite = loadNodeSqlite,
	options: OpenCodeOptions = {},
): Promise<HarnessScan> {
	const { state: dbState, ...main } = await probeStat(dbPath, "file");
	if (dbState !== "found")
		return emptyScan(
			dbState === "unreadable",
			dbState === "unreadable" ? ["opencode: database inaccessible, skipped"] : [],
		);
	const cache = options.cache ?? {};
	const files = cache.opencode ?? {};
	cache.opencode = files;
	const stamp = await stampOf(main, dbPath);
	const prefix = entryKey(dbPath, "");
	const marker = files[entryKey(dbPath, MARKER)];
	if (marker && marker.size === stamp.size && marker.mtimeMs === stamp.mtimeMs)
		return scanOf(Object.entries(files).filter(([key]) => key.startsWith(prefix)));
	const rows: Record<string, unknown>[] = [];
	try {
		const { DatabaseSync } = await load();
		const target = (await isCheckpointedWal(dbPath)) ? `${pathToFileURL(dbPath).href}?mode=ro&immutable=1` : dbPath;
		const db = new DatabaseSync(target, { readOnly: true });
		try {
			db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
			const prepared = db.prepare(QUERY);
			for (const page of pages(prepared, options.pageRows ?? PAGE_ROWS)) {
				rows.push(...page);
				options.onRows?.(rows.length);
				await yieldToLoop();
			}
		} finally {
			db.close();
		}
	} catch (error) {
		// Deliberately drops the error text: SQLite messages can quote paths.
		if (isBusy(error)) return emptyScan(true, ["opencode: database busy, skipped"]);
		return emptyScan(true, ["opencode: database unreadable (missing node:sqlite or unexpected schema), skipped"]);
	}
	const parsed = parseRows(rows, stamp);
	for (const key of Object.keys(files)) if (key.startsWith(prefix)) delete files[key];
	for (const [name, file] of parsed) files[entryKey(dbPath, name)] = file;
	return scanOf(parsed.map(([name, file]) => [entryKey(dbPath, name), file]));
}

/** One cached record per session, plus the marker holding the stamp and the unreadable-row count. */
function parseRows(
	rows: readonly Record<string, unknown>[],
	stamp: { size: number; mtimeMs: number },
): [string, ParsedFile][] {
	const blank = (): ParsedFile => ({
		...stamp,
		startMs: 0,
		endMs: 0,
		session: "",
		child: false,
		models: [],
		calls: [],
		entryIds: [],
		quota: [],
		badLines: 0,
		unsupportedTurns: 0,
	});
	const marker = blank();
	const bySession = new Map<string, ParsedFile>();
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
			marker.badLines++;
			continue;
		}
		const [input, output, cacheRead, cacheWrite] = [nth(raw, 0), nth(raw, 1) + nth(raw, 2), nth(raw, 3), nth(raw, 4)];
		if (input + output + cacheRead + cacheWrite === 0) continue;
		const session = sessionHash("opencode", sid);
		let file = bySession.get(session);
		if (!file) {
			file = { ...blank(), session, startMs: ms, endMs: ms };
			bySession.set(session, file);
		}
		file.startMs = Math.min(file.startMs, ms);
		file.endMs = Math.max(file.endMs, ms);
		file.child = Number(r.child) === 1;
		let index = file.models.findIndex(([p, m]) => p === provider && m === model);
		if (index < 0) index = file.models.push([provider, model]) - 1;
		file.calls.push([ms, index, input, output, cacheRead, cacheWrite, cost]);
		file.entryIds.push(entryHash("opencode", id));
	}
	return [[MARKER, marker], ...[...bySession].map(([session, file]): [string, ParsedFile] => [session, file])];
}

function scanOf(files: [string, ParsedFile][]): HarnessScan {
	const out = flattenHarness("opencode", files);
	return {
		...emptyScan(true, unreadable("opencode", out.badLines)),
		calls: out.calls,
		sessionMetadata: out.sessionMetadata,
		sessions: out.sessions,
	};
}
