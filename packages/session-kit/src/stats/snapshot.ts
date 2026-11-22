/** Privacy-only monthly snapshots and offline, atomic last-good imports. Node builtins only. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { agentDir } from "../agent-dir.ts";
import { compareFreshness, mergeQuota, type QuotaObservation } from "./harness/common.ts";
import {
	EXTERNAL_HARNESSES,
	type ExternalHarness,
	type HarnessRoots,
	harnessCachePath,
	loadHarnesses,
} from "./harness/index.ts";
import type { LoadSqlite } from "./harness/opencode.ts";
import {
	type Call,
	cachePath,
	checkEntryIds,
	dedupCalls,
	HARNESSES,
	type Harness,
	type Loaded,
	loadUsage,
	mergeSessionMetadata,
	opaqueId,
	type Session,
	sessionsDir,
} from "./load.ts";
import { nth } from "./nth.ts";

/** v3 stores compact deterministic gzip; expanded v1/v2 remain readable. */
export const SNAPSHOT_VERSION = 3;
const VERSIONS: readonly number[] = [1, 2, 3];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_SEALED_SHARDS = 32;
const SHARD_FILE = /^\d{4}-\d{2}-[a-f0-9]{64}\.json(?:\.gz)?$/;
export interface Identity {
	machineId: string;
	label: string;
}
export interface SnapshotEvent {
	id: string;
	/** Absent in v1 shards, where it means `pi`. */
	harness?: Harness;
	entryId: string | null;
	sessionId: string;
	ms: number;
	provider: string;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** `null` when the harness records no cost. */
	cost: number | null;
}
/** A quota reading as exported; same shape as the readers' observation. */
export type SnapshotQuota = QuotaObservation;
export interface SnapshotSession {
	id: string;
	startMs: number;
	endMs: number;
	child: boolean;
}
export interface Shard {
	version: number;
	machineId: string;
	month: string;
	events: SnapshotEvent[];
	sessions: SnapshotSession[];
	/** v2 only; each reading lives in the UTC month of its `observedAt`. */
	quota?: SnapshotQuota[];
}
type CompactShard = Shard & { version: 3; quota: SnapshotQuota[] };

export interface Manifest extends Identity {
	version: number;
	exportedAt: number;
	/**
	 * v2 only: per harness in this snapshot, when its data was last read cleanly. Equal to `exportedAt`
	 * unless the harness failed and its previous contents were carried, which leaves it behind.
	 */
	lastGoodAt?: Partial<Record<Harness, number>>;
	shards: { month: string; file: string; sha256: string; bytes: number }[];
}
export interface MachineSnapshot {
	manifest: Manifest;
	shards: Shard[];
	/** v3 imported cache only: authenticated producer bytes, independent of the viewer's zlib build. */
	wire?: string[];
}
export interface GlobalCache {
	version: number;
	importedAt: number;
	machines: Record<string, MachineSnapshot>;
	problems: string[];
}
/** Known sources only, including failed imports with no last-good snapshot. */
/** What one machine knows of one harness. Counts and timestamps only. */
export interface HarnessStatus {
	/** Local machine only: whether the harness's data root exists (absent means not installed). */
	found?: boolean;
	/** Newest event this machine contributed for the harness. */
	lastEventMs?: number;
	/** Imported machines only: when the harness was last read cleanly (see `Manifest.lastGoodAt`). */
	lastGoodAt?: number;
	/** Imported machines only: `lastGoodAt` lags the export by more than `STALE_AFTER_MS`. */
	stale?: boolean;
	/** Count-only diagnostics from the scan, e.g. `claude: ! 3 unreadable lines`. */
	problems: string[];
}
export interface MachineCoverage extends Identity {
	local: boolean;
	exportedAt?: number;
	incomplete: boolean;
	/** Per harness; absent when nothing beyond a plain pi scan is known. */
	harnesses?: Partial<Record<Harness, HarnessStatus>>;
}
export interface Coverage {
	sources?: MachineCoverage[];
	machines: number;
	remoteMachines: number;
	importedAt?: number;
	incomplete: boolean;
	problems: string[];
}
export interface Combined extends Loaded {
	coverage: Coverage;
	/** Imported quota readings, freshest per `(provider, limitId, window)`. */
	quota: QuotaObservation[];
	/** Diagnostics from this machine's own scans of other harnesses, count-only. */
	harnessProblems: string[];
}

/** Which other harnesses `loadCombined` reads on this machine, and where. Default: none (pi only). */
export interface CombinedOptions {
	harnesses?: readonly ExternalHarness[];
	roots?: Partial<HarnessRoots>;
	env?: Record<string, string | undefined>;
	home?: string;
	loadSqlite?: LoadSqlite;
	/** Status text while other harnesses are read, for a loading line. */
	onHarnessProgress?: (status: string) => void;
}

/** Atomic replacement, also safe against concurrent writers' temporary-file collisions. */
export async function atomicJson(path: string, value: unknown): Promise<void> {
	await atomicContents(path, JSON.stringify(value));
}

/** Publish complete JSON or gzip bytes through one same-directory atomic rename. */
async function atomicContents(path: string, contents: string | Uint8Array): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(tmp, contents, { mode: 0o600 });
		await rename(tmp, path);
	} catch (error) {
		// Cleanup is best effort; preserve the actual publication failure for diagnostics.
		await unlink(tmp).catch(() => {});
		throw error;
	}
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function exact(v: unknown, keys: string[]): asserts v is Record<string, unknown> {
	if (!record(v) || Object.keys(v).length !== keys.length || !Object.keys(v).every((key) => keys.includes(key)))
		throw new Error("Unexpected snapshot fields");
}
const positive = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 8640000000000000;
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const hash = (v: unknown): v is string => typeof v === "string" && HASH.test(v);
const name = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 1024;
const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

function validateIdentity(value: unknown): Identity {
	exact(value, ["machineId", "label"]);
	if (typeof value.machineId !== "string" || !UUID.test(value.machineId) || !name(value.label))
		throw new Error("Invalid installation identity");
	return value as unknown as Identity;
}

/**
 * Create-or-read one installation file. First use publishes atomically and exclusively (hard link), so
 * concurrent first readers agree and never see partial JSON; a corrupt file fails rather than being replaced.
 */
async function installationFile<T>(path: string, fresh: () => object, validate: (value: unknown) => T): Promise<T> {
	try {
		return validate(await jsonFile(path));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${randomUUID()}.tmp`;
	await writeFile(tmp, JSON.stringify(fresh()), { flag: "wx", mode: 0o600 });
	try {
		await link(tmp, path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	} finally {
		await unlink(tmp);
	}
	return validate(await jsonFile(path));
}

/** An installation identity belongs to the agent dir, never to the sync checkout. */
export async function machineIdentity(dir = agentDir()): Promise<Identity> {
	return installationFile(
		join(dir, "pi-session-kit", "machine.json"),
		() => ({ machineId: randomUUID(), label: "Pi machine" }),
		validateIdentity,
	);
}

/** Local export state, never synced: the secret salt and the harness set last published. */
export interface ExportState {
	/** Keys the account discriminators on quota readings. Never leaves the machine. */
	salt: string;
	/** What the last successful export published; `null` before any export recorded it. */
	harnesses: Harness[] | null;
	/** Consecutive exports whose scan of a harness failed and carried its old data; absent means 0. */
	failures: Partial<Record<Harness, number>>;
	/** Recovery is unresolved, but only the frozen recoveryFiles set is protected from pruning. */
	recoveryPending: boolean;
	/** Files frozen at a read failure; null denotes an older state that has not captured its set yet. */
	recoveryFiles: string[] | null;
	/** Only these harnesses had unavailable history; empty enrolled harnesses are not lost. */
	lostHarnesses: Harness[];
	/** Harnesses with published events/quota; null for legacy states without this knowledge. */
	historyHarnesses: Harness[] | null;
}
const harnessList = (value: unknown): value is Harness[] =>
	Array.isArray(value) && value.every((h) => HARNESSES.includes(h as Harness)) && new Set(value).size === value.length;
const shardFileList = (value: unknown): value is string[] =>
	Array.isArray(value) &&
	value.every((file) => typeof file === "string" && SHARD_FILE.test(file)) &&
	new Set(value).size === value.length;
const stateFile = (dir: string): string => join(dir, "pi-session-kit", "export-state.json");
function validateState(value: unknown): ExportState {
	const optional = ["recoveryPending", "recoveryFiles", "lostHarnesses", "historyHarnesses"].filter(
		(key) => record(value) && Object.hasOwn(value, key),
	);
	exact(value, ["version", "salt", "harnesses", "failures", ...optional]);
	const harnesses = value.harnesses;
	const failures = value.failures;
	if (
		value.version !== 1 ||
		("recoveryPending" in value && typeof value.recoveryPending !== "boolean") ||
		("recoveryFiles" in value && value.recoveryFiles !== null && !shardFileList(value.recoveryFiles)) ||
		("lostHarnesses" in value && !harnessList(value.lostHarnesses)) ||
		("historyHarnesses" in value && value.historyHarnesses !== null && !harnessList(value.historyHarnesses)) ||
		typeof value.salt !== "string" ||
		!/^[a-f0-9]{32}$/.test(value.salt) ||
		!(harnesses === null || harnessList(harnesses)) ||
		!record(failures) ||
		!Object.entries(failures).every(([h, n]) => HARNESSES.includes(h as Harness) && count(n) && n > 0)
	)
		throw new Error("Invalid export state");
	return {
		salt: value.salt,
		harnesses: harnesses as Harness[] | null,
		failures: failures as ExportState["failures"],
		recoveryPending: value.recoveryPending === true,
		recoveryFiles: (value.recoveryFiles as string[] | null | undefined) ?? null,
		lostHarnesses: (value.lostHarnesses as Harness[] | undefined) ?? [],
		historyHarnesses: (value.historyHarnesses as Harness[] | null | undefined) ?? null,
	};
}
/** Created on first use with a fresh salt and no recorded set. */
async function exportState(dir: string): Promise<ExportState> {
	return installationFile(
		stateFile(dir),
		() => ({
			version: 1,
			salt: randomBytes(16).toString("hex"),
			harnesses: null,
			failures: {},
			recoveryPending: false,
			recoveryFiles: [],
			lostHarnesses: [],
			historyHarnesses: [],
		}),
		validateState,
	);
}

/**
 * Canonical event fingerprint: identity, timestamp, raw attribution and every counter. v2 adds the
 * harness so a pi row and a Codex row can never collide; v1 shards keep their original formula.
 */
export function eventId(event: Omit<SnapshotEvent, "id">, version: number = SNAPSHOT_VERSION): string {
	const lead = version >= 2 ? [event.harness ?? "pi"] : [];
	const counters = [event.input, event.output, event.cacheRead, event.cacheWrite];
	if (event.entryId === null)
		return opaqueId(JSON.stringify([...lead, event.provider, event.model, event.ms, ...counters]));
	return opaqueId(JSON.stringify([...lead, event.entryId, event.ms, event.provider, event.model, ...counters]));
}

/** Session metadata including children when the loader provided it. */
const sessionsOf = (loaded: Loaded): Session[] => loaded.sessionMetadata ?? loaded.sessions;

/** Allowlist projection. No source objects, paths, names or message payloads are serialized. */
export function makeSnapshot(
	loaded: Loaded,
	identity: Identity,
	exportedAt = Date.now(),
	quota: readonly QuotaObservation[] = [],
	lastGoodAt: Manifest["lastGoodAt"] = {},
): Omit<MachineSnapshot, "shards"> & { shards: CompactShard[] } {
	checkEntryIds(loaded.calls);
	const shards = new Map<string, CompactShard>();
	const shard = (month: string): CompactShard => {
		let s = shards.get(month);
		if (!s) {
			s = { version: SNAPSHOT_VERSION, machineId: identity.machineId, month, events: [], sessions: [], quota: [] };
			shards.set(month, s);
		}
		return s;
	};
	const sessionId = (value: string): string => (HASH.test(value) ? value : opaqueId(`session:${value}`));
	for (const c of loaded.calls) {
		const e = {
			harness: c.harness,
			entryId: c.entryId?.slice(0, 24) ?? null,
			sessionId: sessionId(c.session),
			ms: c.ms,
			provider: c.provider,
			model: c.model,
			input: c.input,
			output: c.output,
			cacheRead: c.cacheRead,
			cacheWrite: c.cacheWrite,
			cost: c.cost,
		};
		shard(monthOf(c.ms)).events.push({ id: eventId(e), ...e });
	}
	for (const q of mergeQuota(quota, exportedAt))
		shard(monthOf(q.observedAt)).quota.push({
			harness: q.harness,
			provider: q.provider,
			limitId: q.limitId,
			window: q.window,
			usedPercent: q.usedPercent,
			resetAt: q.resetAt,
			durationMs: q.durationMs,
			observedAt: q.observedAt,
			planType: q.planType,
			account: q.account,
		});
	for (const s of sessionsOf(loaded))
		shard(monthOf(s.startMs)).sessions.push({
			id: sessionId(s.path),
			startMs: s.startMs,
			endMs: s.endMs,
			child: s.child ?? false,
		});
	return {
		manifest: {
			version: SNAPSHOT_VERSION,
			machineId: identity.machineId,
			label: identity.label,
			exportedAt,
			lastGoodAt,
			shards: [],
		},
		shards: [...shards.values()].sort((a, b) => a.month.localeCompare(b.month)),
	};
}

/** Hash the actual published bytes, including the gzip header. */
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const packedId = (id: string): string => Buffer.from(id, "hex").toString("base64");
function unpackedId(value: unknown, length = 32): string {
	if (typeof value !== "string") throw new Error("Invalid compact identity");
	const bytes = Buffer.from(value, "base64");
	if (bytes.length !== length || bytes.toString("base64") !== value) throw new Error("Invalid compact identity");
	return bytes.toString("hex");
}

/** Locale-independent UTF-16 code-unit ordering, matching Array.sort() on the wire tables. */
const codeUnits = (a: string, b: string): number => Number(a > b) - Number(a < b);

/** Canonical compact JSON, independent of gzip implementation and compression level. */
function compactJson(shard: Shard): string {
	const ids = [...new Set([...shard.sessions.map((s) => s.id), ...shard.events.map((e) => e.sessionId)])].sort();
	const pairs = [...new Set(shard.events.map((e) => JSON.stringify([e.provider, e.model])))].sort();
	const sessions = new Map(ids.map((id, i) => [id, i]));
	const models = new Map(pairs.map((pair, i) => [pair, i]));
	const epoch = Date.parse(`${shard.month}-01T00:00:00Z`);
	const compact = {
		v: 3,
		m: shard.machineId,
		t: shard.month,
		s: ids.map(packedId),
		p: pairs.map((pair) => JSON.parse(pair) as [string, string]),
		d: [...shard.sessions]
			.sort((a, b) => codeUnits(a.id, b.id))
			.map((s) => [sessions.get(s.id), s.startMs - epoch, s.endMs - s.startMs, s.child ? 1 : 0]),
		e: [...shard.events]
			.sort((a, b) => a.ms - b.ms || codeUnits(a.id, b.id))
			.map((e) => [
				sessions.get(e.sessionId),
				HARNESSES.indexOf(e.harness as Harness),
				e.entryId === null ? null : packedId(e.entryId),
				e.ms - epoch,
				models.get(JSON.stringify([e.provider, e.model])),
				e.input,
				e.output,
				e.cacheRead,
				e.cacheWrite,
				e.cost,
			]),
		q: shard.quota,
	};
	return JSON.stringify(compact);
}

/** zlib emits a zero mtime; canonical JSON and a fixed compression level make producer bytes stable. */
const gzipCanonical = (text: string): Buffer => gzipSync(text, { level: 9 });

/** Canonical v3 wire encoding. Collision-checked 96-bit entry identities deduplicate across versions. */
export function encodeShard(shard: Shard): Buffer {
	if (shard.version !== 3) return Buffer.from(JSON.stringify(shard));
	const text = compactJson(shard);
	if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("Shard exceeds 128 MiB");
	return gzipCanonical(text);
}

/** Decode bounded wire bytes into the existing strict, privacy-only aggregation schema. */
export function decodeShard(bytes: Buffer, manifest: Manifest, month: string): Shard {
	return decodeWithinBudget(bytes, manifest, month, MAX_BYTES).shard;
}

/** Charge actual wire bytes before parsing another shard or publishing its reference. */
function expandWithinBudget(
	bytes: Buffer,
	version: number,
	remaining: number,
): { text: string; expandedBytes: number } {
	if (remaining <= 0) throw new Error("Machine snapshot exceeds 128 MiB expanded");
	let text: string;
	try {
		text = (version === 3 ? gunzipSync(bytes, { maxOutputLength: remaining }) : bytes).toString("utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE")
			throw new Error("Machine snapshot exceeds 128 MiB expanded", { cause: error });
		throw error;
	}
	return { text, expandedBytes: chargeExpansion(Buffer.byteLength(text), remaining) };
}

function chargeExpansion(expandedBytes: number, remaining: number): number {
	if (expandedBytes > remaining) throw new Error("Machine snapshot exceeds 128 MiB expanded");
	return expandedBytes;
}

function decodeWithinBudget(
	bytes: Buffer,
	manifest: Manifest,
	month: string,
	remaining: number,
): { shard: Shard; expandedBytes: number } {
	const { text, expandedBytes } = expandWithinBudget(bytes, manifest.version, remaining);
	if (manifest.version !== 3) {
		const shard = validateShard(JSON.parse(text) as unknown, manifest, month);
		if (JSON.stringify(shard) !== text) throw new Error("Noncanonical shard JSON");
		return { shard, expandedBytes };
	}
	const value: unknown = JSON.parse(text);
	exact(value, ["v", "m", "t", "s", "p", "d", "e", "q"]);
	if (
		value.v !== 3 ||
		value.m !== manifest.machineId ||
		value.t !== month ||
		!Array.isArray(value.s) ||
		!Array.isArray(value.p) ||
		!Array.isArray(value.d) ||
		!Array.isArray(value.e)
	)
		throw new Error("Invalid compact shard");
	const ids = value.s.map((id: unknown) => unpackedId(id));
	const pairs = value.p.map((pair: unknown) => {
		if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(name)) throw new Error("Invalid model table");
		return pair as [string, string];
	});
	const index = <T>(table: readonly T[], at: unknown): T => {
		if (!count(at) || at >= table.length) throw new Error("Invalid compact index");
		return nth(table, at);
	};
	const row = (value: unknown, length: number): unknown[] => {
		if (!Array.isArray(value) || value.length !== length) throw new Error("Invalid compact row");
		return value;
	};
	const epoch = Date.parse(`${month}-01T00:00:00Z`);
	const sessions = value.d.map((data: unknown) => {
		const r = row(data, 4);
		if (!count(r[1]) || !count(r[2]) || (r[3] !== 0 && r[3] !== 1)) throw new Error("Invalid compact session");
		return { id: index(ids, r[0]), startMs: epoch + r[1], endMs: epoch + r[1] + r[2], child: r[3] === 1 };
	});
	const events = value.e.map((data: unknown) => {
		const r = row(data, 10);
		if (!count(r[3])) throw new Error("Invalid compact timestamp");
		const [provider, model] = index(pairs, r[4]);
		const e = {
			harness: index(HARNESSES, r[1]),
			entryId: r[2] === null ? null : unpackedId(r[2], 12),
			sessionId: index(ids, r[0]),
			ms: epoch + r[3],
			provider,
			model,
			input: r[5],
			output: r[6],
			cacheRead: r[7],
			cacheWrite: r[8],
			cost: r[9],
		};
		return { id: eventId(e as Omit<SnapshotEvent, "id">), ...e };
	});
	const shard = validateShard(
		{ version: 3, machineId: value.m, month: value.t, events, sessions, quota: value.q },
		manifest,
		month,
	);
	if (compactJson(shard) !== text) throw new Error("Noncanonical compact shard");
	return { shard, expandedBytes };
}

/** Only bounded regular files with manifest-authenticated bytes reach decompression/schema validation. */
async function readShard(
	base: string,
	manifest: Manifest,
	ref: Manifest["shards"][number],
	remaining: number,
): Promise<{ shard: Shard; bytes: Buffer; expandedBytes: number }> {
	const path = join(base, ref.file);
	const info = await lstat(path);
	if (!info.isFile() || info.size !== ref.bytes || info.size > MAX_BYTES) throw new Error("Invalid shard size/type");
	const bytes = await readFile(path);
	if (digest(bytes) !== ref.sha256) throw new Error("Shard digest mismatch");
	return { ...decodeWithinBudget(bytes, manifest, ref.month, remaining), bytes };
}

export function validateManifest(value: unknown): Manifest {
	const v2 = !(record(value) && value.version === 1);
	exact(value, ["version", "machineId", "label", "exportedAt", ...(v2 ? ["lastGoodAt"] : []), "shards"]);
	if (
		!VERSIONS.includes(value.version as number) ||
		typeof value.machineId !== "string" ||
		!UUID.test(value.machineId) ||
		!name(value.label) ||
		!positive(value.exportedAt) ||
		!Array.isArray(value.shards)
	)
		throw new Error("Invalid or unsupported manifest");
	if (v2) {
		const good = value.lastGoodAt;
		if (
			!record(good) ||
			!Object.entries(good).every(
				([h, at]) => HARNESSES.includes(h as Harness) && positive(at) && at <= (value.exportedAt as number),
			)
		)
			throw new Error("Invalid harness freshness");
	}
	const months = new Set<string>();
	const files = new Set<string>();
	for (const ref of value.shards) {
		exact(ref, ["month", "file", "sha256", "bytes"]);
		if (
			typeof ref.month !== "string" ||
			!MONTH.test(ref.month) ||
			((value.version as number) < 3 && months.has(ref.month)) ||
			!hash(ref.sha256) ||
			ref.file !== `${ref.month}-${ref.sha256}.json${value.version === 3 ? ".gz" : ""}` ||
			files.has(ref.file as string) ||
			!count(ref.bytes) ||
			ref.bytes > MAX_BYTES
		)
			throw new Error("Invalid shard reference");
		months.add(ref.month);
		files.add(ref.file as string);
	}
	return value as unknown as Manifest;
}
const SHARD_KEYS = ["version", "machineId", "month", "events", "sessions"];
const quotaKey = (q: SnapshotQuota): string => JSON.stringify([q.provider, q.limitId, q.window, q.account]);
function validateQuota(q: unknown, month: string): void {
	exact(q, [
		"harness",
		"provider",
		"limitId",
		"window",
		"usedPercent",
		"resetAt",
		"durationMs",
		"observedAt",
		"planType",
		"account",
	]);
	if (
		!HARNESSES.includes(q.harness as Harness) ||
		![q.provider, q.limitId, q.window].every(name) ||
		typeof q.usedPercent !== "number" ||
		!Number.isFinite(q.usedPercent) ||
		q.usedPercent < 0 ||
		!positive(q.resetAt) ||
		!positive(q.durationMs) ||
		!positive(q.observedAt) ||
		monthOf(q.observedAt) !== month ||
		!(q.planType === null || name(q.planType)) ||
		!(q.account === "" || hash(q.account))
	)
		throw new Error("Invalid snapshot quota");
}
export function validateShard(value: unknown, manifest: Manifest, month: string): Shard {
	const v2 = manifest.version >= 2;
	exact(value, v2 ? [...SHARD_KEYS, "quota"] : SHARD_KEYS);
	if (
		value.version !== manifest.version ||
		value.machineId !== manifest.machineId ||
		value.month !== month ||
		!Array.isArray(value.events) ||
		!Array.isArray(value.sessions) ||
		(v2 && !Array.isArray(value.quota))
	)
		throw new Error("Invalid shard header");
	const seenEvents = new Set<string>();
	for (const e of value.events) {
		exact(e, [
			"id",
			...(v2 ? ["harness"] : []),
			"entryId",
			"sessionId",
			"ms",
			"provider",
			"model",
			"input",
			"output",
			"cacheRead",
			"cacheWrite",
			"cost",
		]);
		if (
			!hash(e.id) ||
			(v2 && !HARNESSES.includes(e.harness as Harness)) ||
			seenEvents.has(e.id) ||
			!(
				e.entryId === null ||
				(manifest.version === 3 ? typeof e.entryId === "string" && /^[a-f0-9]{24}$/.test(e.entryId) : hash(e.entryId))
			) ||
			!hash(e.sessionId) ||
			!positive(e.ms) ||
			monthOf(e.ms) !== month ||
			!name(e.provider) ||
			!name(e.model) ||
			["router", "faux", "faux-provider", "fake-provider"].includes(e.provider as string) ||
			![e.input, e.output, e.cacheRead, e.cacheWrite].every(count) ||
			(e.input as number) + (e.output as number) + (e.cacheRead as number) + (e.cacheWrite as number) === 0 ||
			!(e.cost === null ? v2 : typeof e.cost === "number" && Number.isFinite(e.cost) && e.cost >= 0) ||
			eventId(e as unknown as SnapshotEvent, manifest.version) !== e.id
		)
			throw new Error("Invalid snapshot event");
		seenEvents.add(e.id);
	}
	const seenSessions = new Set<string>();
	for (const s of value.sessions) {
		exact(s, ["id", "startMs", "endMs", "child"]);
		if (
			!hash(s.id) ||
			seenSessions.has(s.id) ||
			!positive(s.startMs) ||
			!positive(s.endMs) ||
			s.endMs < s.startMs ||
			monthOf(s.startMs) !== month ||
			typeof s.child !== "boolean"
		)
			throw new Error("Invalid snapshot session");
		seenSessions.add(s.id);
	}
	if (v2) {
		const seen = new Set<string>();
		for (const q of value.quota as SnapshotQuota[]) {
			validateQuota(q, month);
			if (seen.has(quotaKey(q))) throw new Error("Duplicate quota window");
			seen.add(quotaKey(q));
		}
	}
	return value as unknown as Shard;
}

/** Cross-shard session references and identifiers are validated as one machine transaction. */
export function validateSnapshot(snapshot: MachineSnapshot): void {
	const metadata = new Map<string, SnapshotSession>();
	const events = new Set<string>();
	const quota = new Set<string>();
	for (const s of snapshot.shards) {
		for (const session of s.sessions) {
			const prior = metadata.get(session.id);
			if (
				prior &&
				(snapshot.manifest.version < 3 || prior.startMs !== session.startMs || prior.child !== session.child)
			)
				throw new Error("Duplicate session metadata");
			metadata.set(session.id, session);
		}
		for (const e of s.events) {
			if (events.has(e.id)) throw new Error("Duplicate event identity");
			events.add(e.id);
		}
		for (const q of s.quota ?? []) {
			if (snapshot.manifest.version < 3 && quota.has(quotaKey(q))) throw new Error("Duplicate quota window");
			quota.add(quotaKey(q));
		}
	}
	for (const s of snapshot.shards)
		for (const e of s.events) if (!metadata.has(e.sessionId)) throw new Error("Missing session metadata");
}

/** Which harnesses an export reads, and where. Default is pi only: other tools are opt-in. */
export interface ExportOptions {
	harnesses?: readonly Harness[];
	/** Allow publishing a narrower harness set than last time, dropping the missing harnesses' history. */
	replaceHarnesses?: boolean;
	roots?: Partial<HarnessRoots>;
	env?: Record<string, string | undefined>;
	home?: string;
	loadSqlite?: LoadSqlite;
}
/**
 * Per requested non-pi harness: whether its data root exists, plus count-only diagnostics. `failed` means
 * the scan was incomplete: `kept` carried what this machine last published for it over unchanged (or there
 * was nothing), `lost` could not read the previous snapshot, so the harness is missing from this one.
 */
export type HarnessReport = Partial<
	Record<
		ExternalHarness,
		{ found: boolean; problems: string[]; failed?: "kept" | "lost"; consecutiveFailures?: number }
	>
>;

/**
 * Diagnostics that mean the history may be incomplete, so publishing the scan would replace a good snapshot
 * with a worse one: a cache that did not persist, transcript files or a data root that could not be read,
 * or an OpenCode database that was busy or unreadable (it has no cache to fall back on).
 */
const fatalProblem = (p: string): boolean =>
	p.endsWith(": cache not written") ||
	p.includes(" unreadable files") ||
	p.endsWith(": root unreadable") ||
	p.startsWith("opencode: database ");

/** What a harness contributes to a snapshot. */
interface Contribution {
	calls: Call[];
	sessions: Session[];
	quota: QuotaObservation[];
}
const emptyContribution = (): Contribution => ({ calls: [], sessions: [], quota: [] });

/** This machine's last published snapshot: `null` if there is none, `"unreadable"` if it cannot be trusted. */
type Previous = (MachineSnapshot & { expandedSizes: number[] }) | null | "unreadable";

/** A readable manifest whose history is not: the unreadable shard files, empty when only their union is invalid. */
interface Damaged {
	damaged: string[];
}

async function loadPrevious(snapshotDir: string): Promise<Previous | Damaged> {
	let manifest: Manifest;
	try {
		manifest = validateManifest(await jsonFile(join(snapshotDir, "manifest.json")));
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
	}
	const shards: Shard[] = [];
	const expandedSizes: number[] = [];
	const damaged: string[] = [];
	let remaining = MAX_BYTES;
	// Read every reference so the owner learns all the files to restore, not just the first.
	for (const ref of manifest.shards) {
		try {
			const read = await readShard(snapshotDir, manifest, ref, remaining);
			shards.push(read.shard);
			expandedSizes.push(read.expandedBytes);
			remaining -= read.expandedBytes;
		} catch {
			damaged.push(ref.file);
		}
	}
	if (damaged.length > 0) return { damaged };
	try {
		validateSnapshot({ manifest, shards });
	} catch {
		return { damaged: [] };
	}
	return { manifest, shards, expandedSizes };
}

/**
 * Publishing over a readable manifest with unreadable shards would evict its intact history from the
 * active snapshot. Keep it, naming what to restore, unless the owner explicitly asks for replacement.
 */
function intactPrevious(previous: Previous | Damaged, replace: boolean): Previous {
	if (previous === null || previous === "unreadable" || !("damaged" in previous)) return previous;
	if (replace) return "unreadable";
	const what = previous.damaged.length > 0 ? previous.damaged.join(", ") : "shards inconsistent with each other";
	throw new Error(
		`Published usage history is unreadable (${what}); restore it from the sync checkout, ` +
			"or pass --replace-harnesses to publish without it",
	);
}

/**
 * The harnesses a previous snapshot holds data or freshness for. A pi-era (v1) manifest is a pi export even
 * when empty; one that cannot be read is assumed to be that too, the only set every kit has published.
 */
function publishedSet(previous: Previous): Harness[] {
	if (previous === null) return [];
	if (previous === "unreadable") return ["pi"];
	const seen = new Set<string>(Object.keys(previous.manifest.lastGoodAt ?? {}));
	if (previous.manifest.version === 1) seen.add("pi");
	for (const shard of previous.shards) {
		for (const e of shard.events) seen.add(e.harness ?? "pi");
		for (const q of shard.quota ?? []) seen.add(q.harness);
	}
	return HARNESSES.filter((h) => seen.has(h));
}

/** What `harness` contributed to the previous snapshot; `null` if that cannot be read. */
function carried(previous: Previous, harness: Harness): Contribution | null {
	if (previous === null) return emptyContribution();
	if (previous === "unreadable") return null;
	const out = emptyContribution();
	const sessionIds = new Set<string>();
	const sessions: SnapshotSession[] = [];
	for (const shard of previous.shards) {
		for (const e of shard.events) {
			if ((e.harness ?? "pi") !== harness) continue;
			sessionIds.add(e.sessionId);
			out.calls.push({
				harness,
				session: e.sessionId,
				entryId: e.entryId ?? undefined,
				ms: e.ms,
				provider: e.provider,
				model: e.model,
				input: e.input,
				output: e.output,
				cacheRead: e.cacheRead,
				cacheWrite: e.cacheWrite,
				cost: e.cost,
			});
		}
		out.quota.push(...(shard.quota ?? []).filter((q) => q.harness === harness));
		sessions.push(...shard.sessions);
	}
	for (const s of sessions)
		if (sessionIds.has(s.id)) out.sessions.push({ path: s.id, startMs: s.startMs, endMs: s.endMs, child: s.child });
	out.sessions = [...mergeSessionMetadata(out.sessions).values()];
	return out;
}

/** Retire sealed generations only when a physical call or session identity was corrected. */
function revisedMonths(previous: MachineSnapshot, next: MachineSnapshot): Set<string> {
	const revised = new Set<string>();
	const entries = new Map<string, { id: string; month: string }[]>();
	const entryKey = (e: SnapshotEvent): string => JSON.stringify([e.harness, e.sessionId, e.entryId]);
	for (const shard of previous.shards)
		for (const event of shard.events) {
			if (event.entryId === null) continue;
			const key = entryKey(event);
			const known = entries.get(key) ?? [];
			known.push({ id: event.id, month: shard.month });
			entries.set(key, known);
		}
	for (const shard of next.shards)
		for (const event of shard.events) {
			if (event.entryId === null) continue;
			for (const prior of entries.get(entryKey(event)) ?? [])
				if (prior.id !== event.id) {
					revised.add(prior.month);
					revised.add(shard.month);
				}
		}
	const sessions = new Map(next.shards.flatMap((s) => s.sessions.map((session) => [session.id, session] as const)));
	for (const shard of previous.shards)
		for (const prior of shard.sessions) {
			const current = sessions.get(prior.id);
			if (current && (current.startMs !== prior.startMs || current.child !== prior.child)) {
				revised.add(shard.month);
				revised.add(monthOf(current.startMs));
			}
		}
	return revised;
}

/** Compact late updates without rewriting the base or consulting the current transcript scan. */
function compactDeltas(base: CompactShard, deltas: readonly CompactShard[]): CompactShard[] {
	const baseSessions = new Map(base.sessions.map((session) => [session.id, session]));
	const sessions = new Map(baseSessions);
	for (const delta of deltas)
		for (const session of delta.sessions) {
			const prior = sessions.get(session.id);
			if (!prior || prior.endMs < session.endMs) sessions.set(session.id, session);
		}
	const byKey = new Map<string, SnapshotQuota[]>();
	const baseRows = new Set(base.quota);
	for (const { quota } of [base, ...deltas])
		for (const q of quota) {
			const key = quotaKey(q);
			const rows = byKey.get(key) ?? [];
			rows.push(q);
			byKey.set(key, rows);
		}
	const compacted: CompactShard[] = [
		{
			...base,
			events: deltas.flatMap((delta) => delta.events),
			sessions: [...sessions.values()].filter((session) => session !== baseSessions.get(session.id)),
			quota: [],
		},
	];
	for (const rows of byKey.values()) {
		// The freshest row wins once all are expired. Before then, every less fresh row
		// is dominated unless it stays active beyond all higher-ranked rows.
		rows.sort((a, b) => compareFreshness(b, a));
		let latestReset = 0;
		let slot = 0;
		for (const q of rows) {
			if (q.resetAt <= latestReset) continue;
			latestReset = q.resetAt;
			// The base can dominate deltas without occupying a delta slot itself.
			if (baseRows.has(q)) continue;
			const shard = compacted[slot] ?? { ...base, events: [], sessions: [], quota: [] };
			shard.quota.push(q);
			compacted[slot++] = shard;
		}
	}
	// Do not silently throw away a candidate just to fit the cap.
	if (compacted.length >= MAX_SEALED_SHARDS) throw new Error("Sealed month quota history exceeds shard limit");
	return compacted.filter(nonempty);
}

const nonempty = (shard: CompactShard): boolean => shard.events.length + shard.sessions.length + shard.quota.length > 0;

function monthDelta(full: CompactShard, old: readonly CompactShard[]): CompactShard | undefined {
	const events = new Set(old.flatMap((shard) => shard.events.map((event) => event.id)));
	const ends = new Map<string, number>();
	for (const shard of old)
		for (const session of shard.sessions) ends.set(session.id, Math.max(ends.get(session.id) ?? 0, session.endMs));
	const quotas = new Set(old.flatMap((shard) => shard.quota.map((q) => JSON.stringify(q))));
	const delta = {
		...full,
		events: full.events.filter((event) => !events.has(event.id)),
		sessions: full.sessions.filter((session) => session.endMs > (ends.get(session.id) ?? 0)),
		quota: full.quota.filter((q) => !quotas.has(JSON.stringify(q))),
	};
	return nonempty(delta) ? delta : undefined;
}

/** Best-effort cleanup of only unreferenced, unprotected content-addressed files. */
async function pruneOutbox(snapshotDir: string, keep: ReadonlySet<string>): Promise<string[]> {
	const cleanupErrors = new Map<string, number>();
	const recordCleanupError = (error: unknown): void => {
		const raw = (error as NodeJS.ErrnoException | null | undefined)?.code;
		const code = typeof raw === "string" && /^E[A-Z0-9_]{1,23}$/.test(raw) ? raw : "UNKNOWN";
		cleanupErrors.set(code, (cleanupErrors.get(code) ?? 0) + 1);
	};
	const entries = await readdir(snapshotDir, { withFileTypes: true }).catch((error: unknown) => {
		recordCleanupError(error);
		return [];
	});
	for (const entry of entries) {
		if (entry.isFile() && SHARD_FILE.test(entry.name) && !keep.has(entry.name)) {
			try {
				await unlink(join(snapshotDir, entry.name));
			} catch (error) {
				if ((error as NodeJS.ErrnoException | null | undefined)?.code !== "ENOENT") recordCleanupError(error);
			}
		}
	}
	return cleanupErrors.size
		? [
				`obsolete shard cleanup failed: ${[...cleanupErrors]
					.sort(([a], [b]) => codeUnits(a, b))
					.map(([code, count]) => `${code}=${count}`)
					.join(", ")}`,
			]
		: [];
}

/** What an export that published a snapshot reports. `warnings` are things that did not stop publication. */
export interface ExportResult {
	machineId: string;
	snapshotDir: string;
	harnesses?: HarnessReport;
	warnings?: string[];
}

/** Write only this machine's immutable shards, publishing its manifest last under an exclusive local lock. */
export async function exportStats(
	dir: string,
	output: string,
	root = sessionsDir(dir),
	options: ExportOptions = {},
): Promise<ExportResult> {
	const identity = await machineIdentity(dir);
	const snapshotDir = join(output, "machines", identity.machineId);
	const lock = join(snapshotDir, ".export.lock");
	await mkdir(snapshotDir, { recursive: true });
	// The portable kit cannot import the dev-tools lock. Fail closed on contention or a
	// crashed writer; never infer that another writer is dead from the age of the lock.
	await mkdir(lock).catch(async (error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") throw error;
		// A winner can release the lock before stat (ENOENT). Still reject this attempt; retry from scratch.
		const info = await lstat(lock).catch((cause: NodeJS.ErrnoException) => {
			if (cause.code === "ENOENT") return undefined;
			throw Object.assign(
				new Error(
					`Export lock exists at ${JSON.stringify(lock)} but could not be inspected (${cause.code}); verify no export is running before removing the lock directory`,
					{ cause },
				),
				{ code: cause.code, path: lock },
			);
		});
		const age = info && Math.max(0, Math.floor((Date.now() - info.mtimeMs) / 1000));
		const details = `${JSON.stringify(lock)} (age ${age === undefined ? "unknown" : `${age}s`})`;
		const message =
			age !== undefined && age >= 3600
				? `Suspected stale export lock ${details}; verify no export is running before removing the lock directory, then retry`
				: `Export lock is held at ${details}; retry after the other export finishes. If this persists, verify no export is running before removing the lock directory`;
		throw Object.assign(new Error(message, { cause: error }), { code: error.code, path: lock });
	});
	let outcome: { ok: true; result: ExportResult } | { ok: false; error: unknown };
	try {
		outcome = { ok: true, result: await publishStats(dir, snapshotDir, root, options, identity) };
	} catch (error) {
		outcome = { ok: false, error };
	}
	try {
		await rmdir(lock);
	} catch (unlockError) {
		const warning = `could not release export lock ${JSON.stringify(lock)}; check permissions and remove it only after verifying no export is running`;
		// Never turn an already-visible publish into a failure, nor hide the primary publication error.
		if (!outcome.ok)
			throw new AggregateError([outcome.error, unlockError], `${String(outcome.error)}\n${warning}`, {
				cause: outcome.error,
			});
		outcome.result.warnings = [...(outcome.result.warnings ?? []), warning];
	}
	if (!outcome.ok) throw outcome.error;
	return outcome.result;
}

async function publishStats(
	dir: string,
	snapshotDir: string,
	root: string,
	options: ExportOptions,
	identity: Identity,
): Promise<ExportResult> {
	const wanted = new Set<Harness>(options.harnesses ?? ["pi"]);
	const state = await exportState(dir);
	const previous = intactPrevious(await loadPrevious(snapshotDir), options.replaceHarnesses === true);
	// The recorded set can lag the snapshot (state not written after a publish) or be missing: check against
	// both, so neither a lost nor a stale state file can hide a narrowing.
	const last = new Set([...(state.harnesses ?? []), ...publishedSet(previous)]);
	const dropped = HARNESSES.filter((h) => last.has(h) && !wanted.has(h));
	if (dropped.length > 0 && !options.replaceHarnesses)
		throw new Error(
			`Refusing to publish a narrower harness set than last published (missing: ${dropped.join(", ")}); ` +
				"add them to --harness, or pass --replace-harnesses to drop their history",
		);
	// With neither a readable snapshot nor a recorded set, what was last published cannot be established.
	if (previous === "unreadable" && state.harnesses === null && !options.replaceHarnesses)
		throw new Error(
			"Cannot establish which harnesses were last published (unreadable snapshot, no recorded set); " +
				"pass --replace-harnesses to publish anyway",
		);
	const loaded = wanted.has("pi")
		? await loadUsage({ root, cache: cachePath(dir), includeAllRoots: true })
		: { calls: [], sessions: [], errors: 0, badLines: 0, diagnostics: [] };
	if (loaded.errors || loaded.badLines) {
		// Fixed, bounded stderr protocol for local callers. Never serialize Loaded or raw exceptions:
		// both can contain transcript-derived values. JSON quoting prevents terminal/newline injection.
		const details = loaded.diagnostics.map(
			(diagnostic) =>
				`pi-stats-scan: ${JSON.stringify({
					...diagnostic,
					path: diagnostic.path
						.slice(0, 1024)
						.replace(/[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "\ufffd"),
				})}`,
		);
		throw new Error(
			[`Incomplete local scan: ${loaded.errors} errors, ${loaded.badLines} bad lines`, ...details].join("\n"),
		);
	}
	const external = EXTERNAL_HARNESSES.filter((h) => wanted.has(h));
	const exportedAt = Date.now();
	// Sealing follows the wall clock: behind the published export, months it sealed would reopen as
	// the active month, be replaced by the scan and pruned. Refuse before anything is written.
	const publishedAt = previous !== null && previous !== "unreadable" ? previous.manifest.exportedAt : 0;
	if (exportedAt < publishedAt && !options.replaceHarnesses)
		throw new Error(
			`Clock is behind the last published export (${new Date(exportedAt).toISOString()} < ` +
				`${new Date(publishedAt).toISOString()}); refusing to reopen sealed months. Fix the clock, ` +
				"or pass --replace-harnesses to publish anyway",
		);
	const scans = await loadHarnesses({
		now: exportedAt,
		harnesses: external,
		roots: options.roots,
		env: options.env,
		home: options.home,
		cache: harnessCachePath(dir),
		loadSqlite: options.loadSqlite,
		salt: state.salt,
	});
	const report: HarnessReport = {};
	const calls = [...loaded.calls];
	const sessionMetadata = [...sessionsOf(loaded)];
	const quota: QuotaObservation[] = [];
	const lastGoodAt: Manifest["lastGoodAt"] = wanted.has("pi") ? { pi: exportedAt } : {};
	const failures: ExportState["failures"] = {};
	for (const h of external) {
		const scan = scans[h];
		const old = carried(previous, h);
		// A harness that cannot be read, or that vanished while we hold data for it, keeps its last published
		// contents: it must not take the pi export down, nor be replaced by an empty or partial scan.
		const wasLost = state.lostHarnesses.includes(h);
		const hasCarriedHistory = old !== null && old.calls.length + old.quota.length > 0;
		const gone =
			!scan.found &&
			!options.replaceHarnesses &&
			(wasLost || (old === null ? (state.historyHarnesses?.includes(h) ?? false) : hasCarriedHistory));
		const missingHistory = old === null || (wasLost && !hasCarriedHistory);
		const failed = scan.problems.some(fatalProblem) || gone;
		const use = failed ? (old ?? emptyContribution()) : { ...scan, sessions: scan.sessionMetadata };
		const problems = [
			...scan.problems,
			...(gone ? [`${h}: not found, but data was published before`] : []),
			...(failed && missingHistory ? [`${h}: last published contents unreadable`] : []),
		];
		if (failed) failures[h] = (state.failures[h] ?? 0) + 1;
		// Carried data is as fresh as it was: the previous snapshot's own mark, else when it was published.
		const was = previous !== null && previous !== "unreadable" ? previous.manifest : undefined;
		const lastGood = !failed ? exportedAt : missingHistory ? undefined : (was?.lastGoodAt?.[h] ?? was?.exportedAt);
		// Never after the export itself: a carried mark from a snapshot written under a faster clock must stay valid.
		if (lastGood !== undefined) lastGoodAt[h] = Math.min(lastGood, exportedAt);
		report[h] = {
			found: scan.found,
			problems,
			...(failed
				? { failed: missingHistory ? ("lost" as const) : ("kept" as const), consecutiveFailures: failures[h] }
				: {}),
		};
		calls.push(...use.calls);
		sessionMetadata.push(...use.sessions);
		quota.push(...use.quota);
	}
	const snapshot = makeSnapshot({ ...loaded, calls, sessionMetadata }, identity, exportedAt, quota, lastGoodAt);
	validateSnapshot(snapshot);
	const reportedLost = EXTERNAL_HARNESSES.filter((h) => report[h]?.failed === "lost");
	const lostHarnesses = options.replaceHarnesses
		? []
		: HARNESSES.filter(
				(h) =>
					reportedLost.some((lost) => lost === h) ||
					(state.lostHarnesses.includes(h) && (h === "pi" || !(report[h]?.found && !report[h]?.failed))),
			);
	const recoveryPending =
		!options.replaceHarnesses && (state.recoveryPending || previous === "unreadable" || reportedLost.length > 0);
	const protectedFiles = new Set(options.replaceHarnesses ? [] : (state.recoveryFiles ?? []));
	const captureRecovery = recoveryPending && (previous === "unreadable" || state.recoveryFiles === null);
	if (captureRecovery) {
		for (const entry of await readdir(snapshotDir, { withFileTypes: true }))
			if (entry.isFile() && SHARD_FILE.test(entry.name)) protectedFiles.add(entry.name);
	}
	const recoveryFiles = [...protectedFiles].sort();
	// Freeze recovery scope BEFORE replacing unreadable history. Ordinary exports never add newly
	// superseded files to this set, so subsequent active generations still prune automatically.
	if (recoveryPending && (captureRecovery || !state.recoveryPending))
		await atomicJson(stateFile(dir), { version: 1, ...state, recoveryPending, recoveryFiles, lostHarnesses });
	// Uncorrected past months stay sealed. An explicit replacement drops their old generations.
	const sealed =
		previous !== null && previous !== "unreadable" && previous.manifest.version === 3 && !options.replaceHarnesses
			? previous
			: null;
	const current = monthOf(exportedAt);
	const revised = sealed ? revisedMonths(sealed, snapshot) : new Set<string>();
	const prior = new Map<string, { ref: Manifest["shards"][number]; shard: CompactShard; expandedBytes: number }[]>();
	if (sealed)
		for (const [i, shard] of sealed.shards.entries()) {
			if (shard.month >= current || revised.has(shard.month)) continue;
			const refs = prior.get(shard.month) ?? [];
			// loadPrevious authenticated and validated every shard against this v3 manifest.
			refs.push({
				ref: nth(sealed.manifest.shards, i),
				shard: shard as CompactShard,
				expandedBytes: nth(sealed.expandedSizes, i),
			});
			prior.set(shard.month, refs);
		}
	const fresh = new Map(snapshot.shards.map((shard) => [shard.month, shard]));
	const publishedShards: CompactShard[] = [];
	const writes: { file: string; bytes: Buffer }[] = [];
	let remaining = MAX_BYTES;
	for (const month of [...new Set([...prior.keys(), ...fresh.keys()])].sort()) {
		let old = prior.get(month) ?? [];
		const full = fresh.get(month);
		const delta =
			full &&
			monthDelta(
				full,
				old.map(({ shard }) => shard),
			);
		let deltas = delta ? [delta] : [];
		if (old.length + deltas.length > MAX_SEALED_SHARDS) {
			const base = nth(old, 0);
			deltas = compactDeltas(base.shard, [...old.slice(1).map(({ shard }) => shard), ...deltas]);
			old = [base];
		}
		for (const { ref, shard, expandedBytes } of old) {
			remaining -= chargeExpansion(expandedBytes, remaining);
			snapshot.manifest.shards.push(ref);
			publishedShards.push(shard);
		}
		for (const shard of deltas) {
			validateShard(shard, snapshot.manifest, month);
			// Charge the canonical text first: one oversized shard is the same machine-budget failure.
			const text = compactJson(shard);
			const expandedBytes = chargeExpansion(Buffer.byteLength(text), remaining);
			const bytes = gzipCanonical(text);
			if (bytes.length > MAX_BYTES) throw new Error("Shard exceeds 128 MiB");
			remaining -= expandedBytes;
			const sha256 = digest(bytes);
			const file = `${month}-${sha256}.json.gz`;
			writes.push({ file, bytes });
			snapshot.manifest.shards.push({ month, file, sha256, bytes: bytes.length });
			publishedShards.push(shard);
		}
	}
	validateSnapshot({ manifest: snapshot.manifest, shards: publishedShards });
	validateManifest(snapshot.manifest);
	for (const { file, bytes } of writes) {
		// Valid content-addressed bytes are immutable; repair an existing corrupt file atomically.
		try {
			await writeFile(join(snapshotDir, file), bytes, { flag: "wx", mode: 0o600 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (!(await readFile(join(snapshotDir, file))).equals(bytes))
				await atomicContents(join(snapshotDir, file), bytes);
		}
	}
	await atomicJson(join(snapshotDir, "manifest.json"), snapshot.manifest);
	// Serialized outbox writers only. Readers racing collection retain last-good. Keep recovery
	// copies if this export could not read the previous history; never turn post-publication cleanup
	// failure into a failed export or skip recording the now-published harness set.
	const warnings = recoveryPending ? ["recovery files retained: explicit replacement required"] : [];
	const keep = new Set([...snapshot.manifest.shards.map((ref) => ref.file), ...recoveryFiles]);
	warnings.push(...(await pruneOutbox(snapshotDir, keep)));
	// Recorded only once published: a failed export leaves the previous set, so the next run is still checked.
	const published = HARNESSES.filter((h) => wanted.has(h));
	// The snapshot is out by now: failing to record it is a warning, not a failed export. The next run
	// derives the set from the snapshot itself, so a widening is still protected.
	const stateWarnings = await atomicJson(stateFile(dir), {
		version: 1,
		salt: state.salt,
		harnesses: published,
		failures,
		recoveryPending,
		recoveryFiles,
		lostHarnesses,
		historyHarnesses: HARNESSES.filter((h) =>
			publishedShards.some(
				(shard) => shard.events.some((event) => event.harness === h) || shard.quota.some((q) => q.harness === h),
			),
		),
	}).then(
		() => [],
		() => ["export state not recorded"],
	);
	warnings.push(...stateWarnings);
	return {
		machineId: identity.machineId,
		snapshotDir,
		...(external.length ? { harnesses: report } : {}),
		...(warnings.length ? { warnings } : {}),
	};
}

const globalPath = (dir: string): string => join(dir, "pi-session-kit", "stats-global.json");
async function jsonFile(path: string): Promise<unknown> {
	const info = await lstat(path);
	if (!info.isFile() || info.size > MAX_BYTES) throw new Error("Not a bounded regular snapshot file");
	return JSON.parse(await readFile(path, "utf8")) as unknown;
}
/** Validate even the local cache: tampering never reaches aggregation. */
export async function readGlobal(dir: string): Promise<GlobalCache> {
	const empty: GlobalCache = { version: SNAPSHOT_VERSION, importedAt: 0, machines: {}, problems: [] };
	try {
		const v = await jsonFile(globalPath(dir));
		exact(v, ["version", "importedAt", "machines", "problems"]);
		if (
			!VERSIONS.includes(v.version as number) ||
			!count(v.importedAt) ||
			!record(v.machines) ||
			!Array.isArray(v.problems) ||
			!v.problems.every((p) => typeof p === "string")
		)
			throw new Error("Invalid global cache");
		for (const [id, machine] of Object.entries(v.machines)) {
			exact(
				machine,
				record(machine) && record(machine.manifest) && machine.manifest.version === 3
					? ["manifest", "shards", "wire"]
					: ["manifest", "shards"],
			);
			const m = validateManifest(machine.manifest);
			if (m.machineId !== id || !Array.isArray(machine.shards) || machine.shards.length !== m.shards.length)
				throw new Error("Invalid cached machine");
			const wire = machine.wire;
			if (m.version === 3 && (!Array.isArray(wire) || wire.length !== m.shards.length))
				throw new Error("Invalid cached wire bytes");
			for (const [i, s] of machine.shards.entries()) {
				// The length check above pairs every cached shard with its manifest reference.
				const ref = nth(m.shards, i);
				validateShard(s, m, ref.month);
				if (m.version === 3) {
					const encoded: unknown = (wire as unknown[])[i];
					if (typeof encoded !== "string") throw new Error("Invalid cached wire bytes");
					const bytes = Buffer.from(encoded, "base64");
					if (bytes.toString("base64") !== encoded || bytes.length !== ref.bytes || digest(bytes) !== ref.sha256)
						throw new Error("Cached shard digest mismatch");
					if (JSON.stringify(decodeShard(bytes, m, ref.month)) !== JSON.stringify(s))
						throw new Error("Cached shard projection mismatch");
				} else if (digest(encodeShard(s as Shard)) !== ref.sha256) throw new Error("Cached shard digest mismatch");
			}
			validateSnapshot(machine as unknown as MachineSnapshot);
		}
		return v as unknown as GlobalCache;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
		return { ...empty, problems: ["Unreadable global cache"] };
	}
}

/** A harness is stale when its data is this much older than the snapshot that carries it. */
export const STALE_AFTER_MS = 2 * 24 * 60 * 60 * 1000;
export interface StaleHarness {
	machineId: string;
	harness: Harness;
	lastGoodAt: number;
}
/** Harnesses of `manifest` whose last clean read lags its export by more than `STALE_AFTER_MS`. */
export function staleHarnesses(manifest: Manifest): StaleHarness[] {
	return Object.entries(manifest.lastGoodAt ?? {})
		.filter(([, at]) => manifest.exportedAt - at > STALE_AFTER_MS)
		.map(([harness, lastGoodAt]) => ({ machineId: manifest.machineId, harness: harness as Harness, lastGoodAt }));
}

/** Independent machine transactions: invalid/missing machines retain last-good data; one atomic publication. */
export async function importStats(
	dir: string,
	input: string,
): Promise<{
	imported: number;
	retained: number;
	problems: string[];
	importedAt: number;
	stale: StaleHarness[];
}> {
	const previous = await readGlobal(dir);
	const machines = { ...previous.machines };
	const problems: string[] = [];
	let imported = 0;
	const present = new Set<string>();
	try {
		for (const entry of await readdir(join(input, "machines"), { withFileTypes: true })) {
			if (!entry.isDirectory() || !UUID.test(entry.name)) {
				problems.push("Invalid machine directory");
				continue;
			}
			const id = entry.name;
			present.add(id);
			try {
				const base = join(input, "machines", id);
				const manifest = validateManifest(await jsonFile(join(base, "manifest.json")));
				if (manifest.machineId !== id) throw new Error("Machine identity mismatch");
				const shards: Shard[] = [];
				const wire: string[] = [];
				let remaining = MAX_BYTES;
				for (const ref of manifest.shards) {
					const read = await readShard(base, manifest, ref, remaining);
					remaining -= read.expandedBytes;
					shards.push(read.shard);
					wire.push(read.bytes.toString("base64"));
				}
				validateSnapshot({ manifest, shards });
				const prior = machines[id];
				if (prior && manifest.exportedAt < prior.manifest.exportedAt) throw new Error("Older machine snapshot");
				machines[id] = { manifest, shards, ...(manifest.version === 3 ? { wire } : {}) };
				imported++;
			} catch {
				problems.push(`Incomplete snapshot ${id}`);
			}
		}
	} catch {
		problems.push("Unreadable machines directory");
	}
	for (const id of Object.keys(previous.machines)) if (!present.has(id)) problems.push(`Missing snapshot ${id}`);
	const importedAt = imported > 0 ? Date.now() : previous.importedAt;
	const next = { version: SNAPSHOT_VERSION, importedAt, machines, problems } satisfies GlobalCache;
	if (Buffer.byteLength(JSON.stringify(next)) > MAX_BYTES)
		throw new Error("Global cache exceeds 128 MiB; last-good cache retained");
	await atomicJson(globalPath(dir), next);
	const stale = Object.values(machines).flatMap((m) => staleHarnesses(m.manifest));
	return { imported, retained: Object.keys(machines).length - imported, problems, importedAt, stale };
}

/** Newest event per harness. */
function lastEvents(calls: readonly { harness: Harness; ms: number }[]): Partial<Record<Harness, number>> {
	const last: Partial<Record<Harness, number>> = {};
	for (const c of calls) last[c.harness] = Math.max(last[c.harness] ?? 0, c.ms);
	return last;
}

/**
 * Shared offline loader for /stats and harness fixtures. Local pi usage is always freshly scanned; the
 * other harnesses are scanned too when `options.harnesses` names them (read-only, no network), and every
 * imported event keeps its harness label.
 */
export async function loadCombined(
	dir = agentDir(),
	onProgress?: (done: number, total: number) => void,
	now = Date.now(),
	options: CombinedOptions = {},
): Promise<Combined> {
	const identity = await machineIdentity(dir);
	const local = await loadUsage({ root: sessionsDir(dir), cache: cachePath(dir), includeAllRoots: true, onProgress });
	const global = await readGlobal(dir);
	const remotes = Object.values(global.machines).filter((m) => m.manifest.machineId !== identity.machineId);
	const candidates = [...local.calls];
	const sessionCandidates = [...sessionsOf(local)];
	const quotaCandidates: QuotaObservation[] = [];
	const harnessProblems: string[] = [];
	const localStatus: Partial<Record<Harness, HarnessStatus>> = {};
	const wanted = options.harnesses ?? [];
	if (wanted.length > 0) {
		localStatus.pi = { found: true, lastEventMs: lastEvents(local.calls).pi, problems: [] };
		try {
			const scans = await loadHarnesses({
				now,
				harnesses: wanted,
				roots: options.roots,
				env: options.env,
				home: options.home,
				cache: harnessCachePath(dir),
				loadSqlite: options.loadSqlite,
				onProgress: options.onHarnessProgress,
				salt: (await exportState(dir)).salt,
			});
			for (const h of wanted) {
				const scan = scans[h];
				candidates.push(...scan.calls);
				sessionCandidates.push(...scan.sessionMetadata);
				quotaCandidates.push(...scan.quota);
				harnessProblems.push(...scan.problems);
				localStatus[h] = { found: scan.found, lastEventMs: lastEvents(scan.calls)[h], problems: scan.problems };
			}
		} catch {
			harnessProblems.push("other harnesses not read: export state unreadable");
		}
	}
	const remoteStatus = (machine: MachineSnapshot): Partial<Record<Harness, HarnessStatus>> | undefined => {
		const { manifest } = machine;
		const events = machine.shards.flatMap((s) => s.events.map((e) => ({ harness: e.harness ?? "pi", ms: e.ms })));
		const last = lastEvents(events);
		const stale = new Set(staleHarnesses(manifest).map((x) => x.harness));
		const known = HARNESSES.filter((h) => manifest.lastGoodAt?.[h] !== undefined || last[h] !== undefined);
		if (known.length === 0) return undefined;
		return Object.fromEntries(
			known.map((h) => [
				h,
				{ lastEventMs: last[h], lastGoodAt: manifest.lastGoodAt?.[h], stale: stale.has(h), problems: [] },
			]),
		);
	};
	for (const machine of remotes) {
		// Match wire tie ordering across shard boundaries too, so an event cannot move
		// within its session merely because a sealed month is compacted.
		const events = machine.shards.flatMap((s) => s.events).sort((a, b) => a.ms - b.ms || codeUnits(a.id, b.id));
		for (const e of events)
			candidates.push({
				harness: e.harness ?? "pi",
				session: e.sessionId,
				entryId: e.entryId ?? undefined,
				ms: e.ms,
				provider: e.provider,
				model: e.model,
				input: e.input,
				output: e.output,
				cacheRead: e.cacheRead,
				cacheWrite: e.cacheWrite,
				cost: e.cost,
			});
		for (const s of machine.shards) {
			quotaCandidates.push(...(s.quota ?? []));
			for (const session of s.sessions)
				sessionCandidates.push({
					path: session.id,
					startMs: session.startMs,
					endMs: session.endMs,
					child: session.child,
				});
		}
	}
	const sessions = mergeSessionMetadata(sessionCandidates);
	// Every candidate's session is in `sessions`: local calls come with their session, remote events are
	// validated against their shard's sessions.
	const startOf = (c: Call) => (sessions.get(c.session) as Session).startMs;
	// Across machines, the oldest session owns copies too, not whichever UUID was read first.
	const calls = dedupCalls(candidates.sort((a, b) => startOf(a) - startOf(b) || a.session.localeCompare(b.session)));
	const owners = new Set(calls.map((c) => c.session));
	return {
		...local,
		calls,
		quota: mergeQuota(quotaCandidates, now).sort((a, b) => codeUnits(quotaKey(a), quotaKey(b))),
		harnessProblems,
		sessionMetadata: [...sessions.values()],
		sessions: [...sessions.values()].filter((s) => !s.child && owners.has(s.path)),
		coverage: {
			sources: [
				{
					...identity,
					local: true,
					incomplete: local.errors > 0 || local.badLines > 0,
					...(Object.keys(localStatus).length ? { harnesses: localStatus } : {}),
				},
				...remotes.map((machine) => {
					const { manifest } = machine;
					const harnesses = remoteStatus(machine);
					return {
						machineId: manifest.machineId,
						label: manifest.label,
						local: false,
						exportedAt: manifest.exportedAt,
						incomplete: global.problems.some((p) => p.endsWith(` ${manifest.machineId}`)),
						...(harnesses ? { harnesses } : {}),
					};
				}),
				...global.problems.flatMap((p) => {
					const id = /^(?:Incomplete|Missing) snapshot (.+)$/.exec(p)?.[1];
					return id && UUID.test(id) && id !== identity.machineId && !global.machines[id]
						? [{ machineId: id, label: "Pi machine", local: false, incomplete: true }]
						: [];
				}),
			],
			machines: remotes.length + 1,
			remoteMachines: remotes.length,
			importedAt: global.importedAt || undefined,
			incomplete: global.problems.length > 0 || local.errors > 0 || local.badLines > 0,
			problems: global.problems,
		},
	};
}
export function coverageLabel(c: Coverage): string {
	return `${c.incomplete ? "incomplete coverage · " : ""}${c.machines} machine${c.machines === 1 ? "" : "s"} · ${c.remoteMachines ? "cached" : "local-only"} · ${c.importedAt && positive(c.importedAt) ? `viewer last import ${new Date(c.importedAt).toISOString()}` : "viewer never imported"}`;
}
