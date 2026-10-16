/**
 * Scan pi session JSONL files into compact per-call usage records, with an mtime+size cache.
 *
 * Only assistant messages are counted, attributed to the PHYSICAL `provider`/`model` that answered.
 * Skipped on purpose:
 * - tool-result `usage` (pi-subagents' parent-side report), compaction and branch-summary usage:
 *   persisted child sessions already hold subagent calls with full model attribution, so counting
 *   the report too would double the spend
 * - `router/*` rows: the subscription router's virtual model never answers itself; its rows are
 *   aborted zero-usage stubs
 * - pi's test providers and zero-token records
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { setImmediate as tick } from "node:timers/promises";
export const CACHE_VERSION = 2;

/** Stable opaque identifier: no transcript IDs or paths leave the machine. */
export const opaqueId = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Providers that never call a real API, plus the router's virtual provider. */
const EXCLUDED_PROVIDERS = new Set(["faux", "faux-provider", "fake-provider", "router"]);
/** pi-subagents names child sessions `<agent type>#<8 hex>`; core's `/resume` filter uses the same rule. */
const CHILD_NAME = /#[0-9a-f]{8}$/;
/** Entries open with `{"type":..,"id":..,"parentId":..,"timestamp":".."`: read it without a full parse. */
const LEADING_TIMESTAMP = /^.{0,200}?"timestamp"\s*:\s*"([^"]+)"/;
const YIELD_EVERY_LINES = 2000;

/** One assistant call, compact so the cache stays small: `[ms, model index, in, out, cacheRead, cacheWrite, cost]`. */
export type CallTuple = [number, number, number, number, number, number, number];

export interface FileStats {
	size: number;
	mtimeMs: number;
	/** Header timestamp. */
	startMs: number;
	/** Last entry timestamp. */
	endMs: number;
	/** A pi-subagents child: parent link plus a child name. A `/fork` has the link but not the name. */
	child: boolean;
	/** `provider/model` names, indexed by `CallTuple[1]`. */
	models: string[];
	/** Unambiguous raw provider/model pairs for new records; models remains for v1 migration. */
	modelPairs?: [string, string][];
	calls: CallTuple[];
	/** Opaque preserved entry IDs, parallel to calls; null for legacy messages. */
	entryIds?: (string | null)[];
	sessionId?: string;
	/** Lines that are not a JSON object. */
	badLines: number;
}

export interface Call {
	/** Opaque owning session ID (the oldest copy, after fork dedup). */
	session: string;
	/** Opaque preserved entry identity; absent on old transcripts. */
	entryId?: string;
	ms: number;
	provider: string;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface Session {
	/** Compatibility field name; an opaque ID, not a filesystem path. */
	path: string;
	startMs: number;
	endMs: number;
	child?: boolean;
}

export interface Loaded {
	calls: Call[];
	/** Top-level sessions with at least one counted call. Subagent children are excluded. */
	sessions: Session[];
	/** Privacy-safe metadata including children, independent of event ownership dedup. */
	sessionMetadata?: Session[];
	/** Failed session/directory reads or durable local cache writes. */
	errors: number;
	/** Lines that are not a JSON object, across all files. */
	badLines: number;
}

interface CacheDoc {
	version: number;
	files: Record<string, FileStats>;
}

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function sessionsDir(dir = agentDir()): string {
	return process.env.PI_CODING_AGENT_SESSION_DIR ?? join(dir, "sessions");
}

export function cachePath(dir = agentDir()): string {
	return join(dir, "pi-session-kit", "stats-cache.json");
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function timeOf(value: unknown): number {
	if (typeof value === "number")
		return Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000 ? value : 0;
	if (typeof value !== "string") return 0;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : 0;
}

/** Cheap structural check for lines that are not parsed: one JSON object per line. */
function looksLikeObject(line: string): boolean {
	const text = line.trim();
	return text.startsWith("{") && text.endsWith("}");
}

/** Line-at-a-time parser for one session file. */
export class SessionParser {
	private readonly out: FileStats;
	private readonly modelIndex = new Map<string, number>();
	private parent = false;
	private childName = false;
	private markedChild = false;
	private lines = 0;

	constructor(size: number, mtimeMs: number) {
		this.out = {
			size,
			mtimeMs,
			startMs: 0,
			endMs: 0,
			child: false,
			models: [],
			modelPairs: [],
			calls: [],
			entryIds: [],
			badLines: 0,
		};
	}

	accept(line: string): void {
		if (!line) return;
		// Cheap supersets, whitespace-agnostic: a false positive only costs a JSON.parse.
		const isHeader = this.lines++ === 0;
		const isAssistant = line.includes('"assistant"');
		const isInfo = line.includes('"session_info"') || line.includes('"session-kit:child"');
		if (!isHeader && !isAssistant && !isInfo) {
			// Every other entry only moves the session's end time: skip the JSON.parse, but still
			// catch the usual damage (a truncated or spliced line) by its missing braces.
			if (!looksLikeObject(line)) this.out.badLines++;
			else this.seen(timeOf(LEADING_TIMESTAMP.exec(line)?.[1]));
			return;
		}
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			this.out.badLines++;
			return;
		}
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			this.out.badLines++;
			return;
		}
		const ts = timeOf(entry.timestamp);
		this.seen(ts);
		if (entry.type === "session") {
			if (typeof entry.id === "string" && entry.id) this.out.sessionId = opaqueId(`session:${entry.id}`);
			if (this.out.startMs === 0 || (ts > 0 && ts < this.out.startMs)) this.out.startMs = ts;
			if (typeof entry.parentSession === "string" && entry.parentSession) this.parent = true;
			return;
		}
		if (entry.type === "custom" && entry.customType === "session-kit:child") {
			const data = entry.data as Record<string, unknown> | undefined;
			if (
				data?.version === 1 &&
				typeof data.sessionId === "string" &&
				opaqueId(`session:${data.sessionId}`) === this.out.sessionId
			)
				this.markedChild = true;
			return;
		}
		if (entry.type === "session_info") {
			this.childName ||= typeof entry.name === "string" && CHILD_NAME.test(entry.name);
			return;
		}
		if (entry.type !== "message") return;
		const message = entry.message as Record<string, unknown> | undefined;
		if (message?.role !== "assistant") return;
		this.call(message, ts, typeof entry.id === "string" && entry.id ? opaqueId(`entry:${entry.id}`) : null);
	}

	finish(): FileStats {
		this.out.child = this.markedChild || (this.parent && this.childName);
		return this.out;
	}

	private seen(ts: number): void {
		if (ts <= 0) return;
		if (this.out.startMs === 0) this.out.startMs = ts;
		if (ts > this.out.endMs) this.out.endMs = ts;
	}

	private call(message: Record<string, unknown>, entryTs: number, entryId: string | null): void {
		const provider = typeof message.provider === "string" ? message.provider : "";
		const model = typeof message.model === "string" ? message.model : "";
		if (!provider || !model || EXCLUDED_PROVIDERS.has(provider)) return;
		const usage = message.usage as Record<string, unknown> | undefined;
		if (!usage) return;
		if (
			[usage.input, usage.output, usage.cacheRead, usage.cacheWrite].some(
				(v) => v !== undefined && (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0),
			)
		) {
			this.out.badLines++;
			return;
		}
		const input = num(usage.input);
		const output = num(usage.output);
		const cacheRead = num(usage.cacheRead);
		const cacheWrite = num(usage.cacheWrite);
		if (input + output + cacheRead + cacheWrite === 0) return;
		const costValue = usage.cost;
		const cost =
			typeof costValue === "number" ? num(costValue) : num((costValue as Record<string, unknown> | undefined)?.total);
		if (cost < 0) {
			this.out.badLines++;
			return;
		}
		const ms = timeOf(message.timestamp) || entryTs;
		if (ms <= 0) return;
		const name = JSON.stringify([provider, model]);
		let index = this.modelIndex.get(name);
		if (index === undefined) {
			index = this.out.models.length;
			this.out.models.push(`${provider}/${model}`);
			this.out.modelPairs?.push([provider, model]);
			this.modelIndex.set(name, index);
		}
		this.out.calls.push([ms, index, input, output, cacheRead, cacheWrite, cost]);
		this.out.entryIds?.push(entryId);
	}
}

/** Parse a whole session file's text in one go (tests and small inputs). */
export function parseSession(text: string, size = text.length, mtimeMs = 0): FileStats {
	const parser = new SessionParser(size, mtimeMs);
	for (const line of text.split("\n")) parser.accept(line);
	return parser.finish();
}

/** Stream a file through `SessionParser`, yielding to the event loop every 2000 lines so the TUI keeps painting. */
export async function parseFile(path: string, size: number, mtimeMs: number): Promise<FileStats> {
	const parser = new SessionParser(size, mtimeMs);
	const rl = createInterface({
		input: createReadStream(path, { encoding: "utf8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	let n = 0;
	for await (const line of rl) {
		parser.accept(line);
		if (++n % YIELD_EVERY_LINES === 0) await tick();
	}
	return parser.finish();
}

/**
 * Every `*.jsonl` under `root`. A missing root is an empty history; any other directory that cannot
 * be listed (EACCES, ...) is counted in `errors` so partial totals are never presented as complete.
 */
async function listJsonl(root: string): Promise<{ paths: string[]; errors: number }> {
	const out: string[] = [];
	let errors = 0;
	const walk = async (dir: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			if (!(dir === root && (error as NodeJS.ErrnoException).code === "ENOENT")) errors++;
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
		}
	};
	await walk(root);
	return { paths: out.sort(), errors };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Whether a cached record has exactly the shape `flatten` relies on. */
export function isFileStats(value: unknown): value is FileStats {
	if (typeof value !== "object" || value === null) return false;
	const f = value as Record<string, unknown>;
	if (!isNum(f.size) || !isNum(f.mtimeMs) || !isNum(f.startMs) || !isNum(f.endMs) || !isNum(f.badLines)) return false;
	if (typeof f.child !== "boolean") return false;
	if (f.sessionId !== undefined && (typeof f.sessionId !== "string" || !/^[a-f0-9]{64}$/.test(f.sessionId)))
		return false;
	if (
		f.entryIds !== undefined &&
		(!Array.isArray(f.entryIds) ||
			!Array.isArray(f.calls) ||
			f.entryIds.length !== f.calls.length ||
			!f.entryIds.every((id) => id === null || (typeof id === "string" && /^[a-f0-9]{64}$/.test(id))))
	)
		return false;
	const models = f.models;
	if (!Array.isArray(models) || !models.every((m) => typeof m === "string" && m.includes("/"))) return false;
	if (
		f.modelPairs !== undefined &&
		(!Array.isArray(f.modelPairs) ||
			f.modelPairs.length !== models.length ||
			!f.modelPairs.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "string")))
	)
		return false;
	return (
		Array.isArray(f.calls) &&
		f.calls.every(
			(c) =>
				Array.isArray(c) &&
				c.length === 7 &&
				c.every(isNum) &&
				Number.isInteger(c[1]) &&
				(c[1] as number) >= 0 &&
				(c[1] as number) < models.length,
		)
	);
}

/**
 * Cached records keyed by path. Unreadable JSON, a wrong version, or a non-object `files` yields an
 * empty cache; a malformed record is dropped on its own (its file is re-parsed if still on disk).
 */
async function readCache(path: string): Promise<{ files: Record<string, FileStats>; migrate: boolean }> {
	let doc: Partial<CacheDoc> | null;
	try {
		doc = JSON.parse(await readFile(path, "utf8")) as Partial<CacheDoc> | null;
	} catch {
		return { files: {}, migrate: false };
	}
	if ((doc?.version !== CACHE_VERSION && doc?.version !== 1) || typeof doc.files !== "object" || doc.files === null)
		return { files: {}, migrate: false };
	return {
		files: Object.fromEntries(Object.entries(doc.files).filter(([, record]) => isFileStats(record))),
		migrate: doc.version === 1,
	};
}

/** Atomic write: a crash mid-write never leaves a truncated cache behind. */
async function writeCache(path: string, files: Record<string, FileStats>): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${randomUUID()}.tmp`;
	await writeFile(tmp, JSON.stringify({ version: CACHE_VERSION, files } satisfies CacheDoc));
	await rename(tmp, path);
}

/** Old caches deduplicated this tuple, without cost or entry identity. */
export function legacyKey(c: Call): string {
	return JSON.stringify([c.provider, c.model, c.ms, c.input, c.output, c.cacheRead, c.cacheWrite]);
}

/** Prefer identified records over their legacy copies, but retain distinct preserved IDs. */
export function dedupCalls(candidates: readonly Call[]): Call[] {
	const identified = new Set(candidates.filter((c) => c.entryId).map(legacyKey));
	const seen = new Set<string>();
	return [...candidates]
		.sort((a, b) => a.ms - b.ms)
		.filter((c) => {
			const legacy = legacyKey(c);
			if (!c.entryId && identified.has(legacy)) return false;
			const key = c.entryId ? JSON.stringify([c.entryId, legacy]) : legacy;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
}

export interface LoadOptions {
	root?: string;
	cache?: string;
	/** Machine views include history cached under formerly configured session roots. */
	includeAllRoots?: boolean;
	/** Called after each re-parsed file. */
	onProgress?: (done: number, total: number) => void;
}

/**
 * Load every session under `root`, re-parsing only files whose size or mtime changed. Cache entries
 * for deleted files are kept, so pruning old sessions does not erase history; entries outside `root`
 * stay cached but are not reported.
 */
export async function loadUsage(options: LoadOptions = {}): Promise<Loaded> {
	const root = resolve(options.root ?? sessionsDir());
	const cacheFile = options.cache ?? cachePath();
	const { files, migrate } = await readCache(cacheFile);
	const listed = await listJsonl(root);
	const paths = listed.paths;
	let errors = listed.errors;
	const stale: { path: string; size: number; mtimeMs: number }[] = [];
	for (const path of paths) {
		try {
			const s = await stat(path);
			const hit = files[path];
			if (!hit || hit.entryIds === undefined || hit.size !== s.size || hit.mtimeMs !== s.mtimeMs)
				stale.push({ path, size: s.size, mtimeMs: s.mtimeMs });
		} catch {
			errors++;
		}
	}
	let done = 0;
	let dirty = migrate;
	for (const { path, size, mtimeMs } of stale) {
		try {
			files[path] = await parseFile(path, size, mtimeMs);
			dirty = true;
		} catch {
			errors++;
		}
		options.onProgress?.(++done, stale.length);
	}
	if (dirty) {
		try {
			await writeCache(cacheFile, files);
		} catch {
			// The view can still render, but a producer must not claim durable history.
			errors++;
		}
	}
	// The cache is shared by every sessions dir this agent dir has used; only this root's files
	// count, deleted ones included.
	const prefix = `${resolve(root)}${sep}`;
	const scoped = Object.fromEntries(
		Object.entries(files).filter(([path]) => options.includeAllRoots || path.startsWith(prefix)),
	);
	return { ...flatten(scoped), errors };
}

/** Merge preserved session IDs, spanning all copies and propagating child attribution. */
export function mergeSessionMetadata(sessions: readonly Session[]): Map<string, Session> {
	const metadata = new Map<string, Session>();
	for (const session of sessions) {
		const old = metadata.get(session.path);
		metadata.set(session.path, {
			...session,
			startMs: Math.min(session.startMs, old?.startMs ?? session.startMs),
			endMs: Math.max(session.endMs, old?.endMs ?? session.endMs),
			child: session.child || old?.child || false,
		});
	}
	return metadata;
}

/**
 * Turn cached file stats into calls and sessions. Calls copied into a `/fork` or a branch keep their
 * timestamp, model and token counts. Preserved entry IDs distinguish identical-value calls;
 * legacy tuple copies are discarded when an identified counterpart exists. Files are visited oldest first
 * so the original session, not a later copy, owns each call.
 */
export function flatten(files: Record<string, FileStats>): Omit<Loaded, "errors"> {
	const sessions: Session[] = [];
	const candidates: Call[] = [];
	let badLines = 0;
	const ordered = Object.entries(files).sort(([pa, a], [pb, b]) => a.startMs - b.startMs || pa.localeCompare(pb));
	for (const [path, file] of ordered) {
		badLines += file.badLines ?? 0;
		const session = file.sessionId ?? opaqueId(`legacy-session:${path}`);
		for (const [i, tuple] of file.calls.entries()) {
			const [ms, index, input, output, cacheRead, cacheWrite, cost] = tuple;
			// Preserve raw attribution for dedup and export; sanitize only in display code.
			const raw = file.models[index] ?? "unknown/unknown";

			const slash = raw.indexOf("/");
			candidates.push({
				session,
				entryId: file.entryIds?.[i] ?? undefined,
				ms,
				provider: file.modelPairs?.[index]?.[0] ?? raw.slice(0, slash),
				model: file.modelPairs?.[index]?.[1] ?? raw.slice(slash + 1),
				input,
				output,
				cacheRead,
				cacheWrite,
				cost,
			});
		}
		if (file.calls.length > 0)
			sessions.push({ path: session, startMs: file.startMs, endMs: file.endMs, child: file.child });
	}
	const calls = dedupCalls(candidates);
	const owners = new Set(calls.map((c) => c.session));
	const metadata = mergeSessionMetadata(sessions);
	return {
		calls,
		sessionMetadata: [...metadata.values()],
		sessions: [...metadata.values()].filter((s) => !s.child && owners.has(s.path)),
		badLines,
	};
}
