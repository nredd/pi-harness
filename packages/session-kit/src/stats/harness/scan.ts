/**
 * Incremental scan of append-mostly JSONL transcripts (Claude Code, Codex).
 *
 * Mirrors pi's `loadUsage`: files are re-parsed only when size or mtime changed, records for files
 * that later disappear are kept (Claude and Codex prune old transcripts), and one file failing
 * never hides the rest. The cache lives in memory here and is persisted by `./index.ts`.
 */

import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { feedFile, listJsonl, looksLikeObject, NUL_PADDING, timeOf } from "../jsonl.ts";
import { type Call, type CallTuple, type Harness, mergeSessionMetadata, type Session } from "../load.ts";
import { nth } from "../nth.ts";
import { asRecord, emptyScan, type HarnessScan, type QuotaObservation, unreadable } from "./common.ts";

/** One parsed transcript file, compact and free of content. */
export interface ParsedFile {
	/** File size in bytes. */
	size: number;
	mtimeMs: number;
	startMs: number;
	endMs: number;
	/** Opaque owning session ID; empty when the file held no counted call. */
	session: string;
	/** A subagent or spawned thread: counts toward tokens, not Sessions. */
	child: boolean;
	/** Raw `[provider, model]` pairs, indexed by `CallTuple[1]`. */
	models: [string, string][];
	calls: CallTuple[];
	/** Opaque entry IDs, parallel to `calls`. */
	entryIds: string[];
	/** Freshest reading per `(limitId, window)` in this file. */
	quota: QuotaObservation[];
	/** Lines that were not a JSON object, or rows with unusable counters. */
	badLines: number;
	/** Per-turn usage records are missing, so the file cannot be counted (older Codex). */
	unsupported: boolean;
}

/** Cached parsed files by harness, then absolute path. Paths never leave this process. */
export type HarnessCache = Record<string, Record<string, ParsedFile>>;

/** Line-at-a-time parser for one transcript file. */
export abstract class RowParser {
	protected readonly out: ParsedFile;
	private readonly modelIndex = new Map<string, number>();

	constructor(size: number, mtimeMs: number) {
		this.out = {
			size,
			mtimeMs,
			startMs: 0,
			endMs: 0,
			session: "",
			child: false,
			models: [],
			calls: [],
			entryIds: [],
			quota: [],
			badLines: 0,
			unsupported: false,
		};
	}

	/** Cheap, whitespace-agnostic superset test: a false positive only costs a `JSON.parse`. */
	protected abstract wanted(line: string): boolean;

	protected abstract row(row: Record<string, unknown>, ts: number): void;

	accept(line: string): void {
		if (!line || NUL_PADDING.test(line)) return;
		if (!this.wanted(line)) {
			if (!looksLikeObject(line)) this.out.badLines++;
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			this.out.badLines++;
			return;
		}
		const row = asRecord(parsed);
		if (!row) {
			this.out.badLines++;
			return;
		}
		this.row(row, timeOf(row.timestamp));
	}

	finish(): ParsedFile {
		return this.out;
	}

	/** Extend the file's time span. Callers pass a validated positive timestamp. */
	protected seen(ts: number): void {
		if (this.out.startMs === 0 || ts < this.out.startMs) this.out.startMs = ts;
		if (ts > this.out.endMs) this.out.endMs = ts;
	}

	protected addCall(
		provider: string,
		model: string,
		ms: number,
		counts: readonly number[],
		cost: number,
		entryId: string,
	): void {
		const name = JSON.stringify([provider, model]);
		let index = this.modelIndex.get(name);
		if (index === undefined) {
			index = this.out.models.length;
			this.out.models.push([provider, model]);
			this.modelIndex.set(name, index);
		}
		this.out.calls.push([ms, index, nth(counts, 0), nth(counts, 1), nth(counts, 2), nth(counts, 3), cost]);
		this.out.entryIds.push(entryId);
	}
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isHash = (v: unknown): boolean => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const isQuota = (q: unknown): boolean => {
	const r = asRecordOf(q);
	return (
		["claude", "codex", "opencode", "pi"].includes(r.harness as string) &&
		[r.provider, r.limitId, r.window].every((v) => typeof v === "string") &&
		[r.usedPercent, r.resetAt, r.durationMs, r.observedAt].every(isNum) &&
		(r.planType === null || typeof r.planType === "string")
	);
};

/** Whether a cached record has exactly the shape `flatten` relies on. Anything else is re-parsed. */
export function isParsedFile(value: unknown): value is ParsedFile {
	const f = asRecordOf(value);
	const { models, calls, entryIds, quota } = f;
	return (
		[f.size, f.mtimeMs, f.startMs, f.endMs, f.badLines].every(isNum) &&
		typeof f.session === "string" &&
		typeof f.child === "boolean" &&
		typeof f.unsupported === "boolean" &&
		Array.isArray(models) &&
		models.every((m) => Array.isArray(m) && m.length === 2 && m.every((n) => typeof n === "string")) &&
		Array.isArray(calls) &&
		calls.every(
			(c) =>
				Array.isArray(c) &&
				c.length === 7 &&
				c.every(isNum) &&
				Number.isInteger(c[1]) &&
				nth(c, 1) >= 0 &&
				nth(c, 1) < models.length,
		) &&
		Array.isArray(entryIds) &&
		entryIds.length === calls.length &&
		entryIds.every(isHash) &&
		Array.isArray(quota) &&
		quota.every(isQuota)
	);
}

/** `value` as a record, or an empty one. */
export const asRecordOf = (value: unknown): Record<string, unknown> => asRecord(value) ?? {};

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

export interface ScanOptions {
	harness: Harness;
	/** Data root: its absence means "not installed". Cached files under it are reported. */
	root: string;
	/** Directories under `root` searched for `*.jsonl`. */
	dirs: readonly string[];
	cache: HarnessCache;
	/** A fresh parser for one file; `path` is for local classification only, never projected. */
	parser: (path: string, size: number, mtimeMs: number) => RowParser;
}

/** Re-parse changed files into `cache`, then flatten everything cached under `root`. */
export async function scanJsonl(options: ScanOptions): Promise<HarnessScan> {
	const { harness, cache } = options;
	const root = resolve(options.root);
	if (!(await isDirectory(root))) return emptyScan(false);
	const files = cache[harness] ?? {};
	cache[harness] = files;
	let errors = 0;
	for (const dir of options.dirs) {
		const listed = await listJsonl(resolve(dir));
		errors += listed.errors;
		for (const path of listed.paths) {
			try {
				const s = await stat(path);
				const hit = files[path];
				if (hit && hit.size === s.size && hit.mtimeMs === s.mtimeMs) continue;
				const parser = options.parser(path, s.size, s.mtimeMs);
				await feedFile(path, parser);
				files[path] = parser.finish();
			} catch {
				// A failed stat or parse keeps the last-good record, but the history may be incomplete.
				errors++;
			}
		}
	}
	const prefix = `${root}${sep}`;
	const scoped = Object.entries(files).filter(([path]) => path.startsWith(prefix));
	const out = flatten(harness, scoped);
	const problems = [
		...(errors > 0 ? [`${harness}: ${errors} unreadable files`] : []),
		...unreadable(harness, out.badLines),
		...(out.unsupported > 0 ? [`${harness}: ${out.unsupported} files skipped, no per-turn usage records`] : []),
	];
	return {
		found: true,
		calls: out.calls,
		sessions: out.sessions,
		sessionMetadata: out.sessionMetadata,
		quota: out.quota,
		problems,
	};
}

/**
 * Cached files -> calls, sessions and quota. One API response may be written many times (Claude's
 * per-content-block rows, resumed sessions that copy history, moved Codex rollouts): rows sharing an
 * entry ID collapse to one, keeping the largest output count (streaming rows grow) and, on a tie,
 * the oldest file's copy.
 */
export function flatten(harness: Harness, files: [string, ParsedFile][]) {
	const ordered = files.sort(([pa, a], [pb, b]) => a.startMs - b.startMs || pa.localeCompare(pb));
	const best = new Map<string, Call>();
	const sessions: Session[] = [];
	const quota = new Map<string, QuotaObservation>();
	let badLines = 0;
	let unsupported = 0;
	for (const [, file] of ordered) {
		badLines += file.badLines;
		unsupported += file.unsupported ? 1 : 0;
		for (const [i, tuple] of file.calls.entries()) {
			const [ms, index, input, output, cacheRead, cacheWrite, cost] = tuple;
			const entryId = file.entryIds[i] as string;
			const [provider, model] = file.models[index] as [string, string];
			const kept = best.get(entryId);
			if (kept && kept.output >= output) continue;
			best.set(entryId, {
				harness,
				session: file.session,
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
		}
		if (file.calls.length > 0)
			sessions.push({ path: file.session, startMs: file.startMs, endMs: file.endMs, child: file.child });
		for (const q of file.quota) {
			const key = JSON.stringify([q.provider, q.limitId, q.window]);
			const prev = quota.get(key);
			if (!prev || q.observedAt >= prev.observedAt) quota.set(key, q);
		}
	}
	const calls = [...best.values()].sort((a, b) => a.ms - b.ms);
	const owners = new Set(calls.map((c) => c.session));
	const metadata = mergeSessionMetadata(sessions);
	return {
		calls,
		sessionMetadata: [...metadata.values()],
		sessions: [...metadata.values()].filter((s) => !s.child && owners.has(s.path)),
		quota: [...quota.values()],
		badLines,
		unsupported,
	};
}
