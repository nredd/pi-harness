/** Privacy-only monthly snapshots and offline, atomic last-good imports. Node builtins only. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	chmod,
	link,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rmdir,
	unlink,
	writeFile,
} from "node:fs/promises";
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
/**
 * A v3 manifest's shard whose rows carry lineage (a legacy row's origin, or a retired row) uses compact wire
 * version 4. Older readers reject it as an invalid shard and keep their last-good snapshot; the manifest
 * version, which the sync helper allowlists, stays 3.
 */
const LINEAGE_VERSION = 4;
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
	/**
	 * Lineage shards (version 4) only, where it is always present: a legacy pi row's position among its
	 * transcript's counted calls (`Call.origin`), or `null` (identified rows, and legacy rows whose position
	 * was ambiguous in the scan).
	 */
	origin?: number | null;
}
/** Why a sealed row was retired. `revised`: a later scan holds a different row at its transcript origin. */
export type RetiredReason = "revised";
/** A sealed legacy row kept in its month but no longer counted: `successor` replaced it. */
export interface RetiredEvent extends Omit<SnapshotEvent, "origin"> {
	/** The event id that replaced it: a counted row, or another retired row whose successors end at one. */
	successor: string;
	reason: RetiredReason;
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
	/** Lineage shards (version 4) only: retired sealed rows, never counted, never deleted. */
	retired?: RetiredEvent[];
}
type CompactShard = Shard & { version: 3 | 4; quota: SnapshotQuota[] };

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

/**
 * Why an export or a recovery cleanup cannot succeed until the owner acts: retrying it unchanged never helps.
 * Each is a fixed refusal site, never inferred from a message; anything else, contention, I/O and a refusal
 * that clears with time included, has no code. `watermark-ahead` is clock-dependent: a lead just over 366 days
 * clears as the clock advances, so callers should bound their wait on it rather than stop for good. The
 * `recovery-` codes come only from `cleanRecovery`, which removes nothing when it refuses.
 */
export type RefusalCode =
	| "watermark-ahead"
	| "history-unreadable"
	| "history-over-budget"
	| "manifest-missing"
	| "harness-set-narrowed"
	| "harness-set-unknown"
	| "export-state-invalid"
	| "recovery-outbox-missing"
	| "recovery-snapshot-unverified"
	| "recovery-set-unrecorded"
	| "recovery-harness-lost";

/** An export refused before publishing, or a cleanup before removing; `refusal` is the stable code callers may act on. */
export class ExportRefusal extends Error {
	readonly refusal: RefusalCode;
	constructor(refusal: RefusalCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ExportRefusal";
		this.refusal = refusal;
	}
}

/**
 * The local scan was incomplete. Its message is the fixed `pi-stats-scan:` protocol: a fixed first line,
 * then one line per diagnostic holding only JSON-quoted values, so its line breaks are safe to print.
 */
export class IncompleteScan extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IncompleteScan";
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
/** How far a published `exportedAt` may run ahead of this clock before the next export refuses it. */
const MAX_CLOCK_LEAD_MS = 366 * 86_400_000;
/** The last instant with a four-digit ISO year, so `YYYY-MM` months still sort chronologically. */
const LAST_ISO_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

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

/**
 * An installation identity belongs to the agent dir, never to the sync checkout. A JSON parse error can
 * quote the file, so malformed JSON is reported by path and a fixed reason with no parse cause attached;
 * filesystem and validation errors pass through unchanged.
 */
export async function machineIdentity(dir = agentDir()): Promise<Identity> {
	const path = join(dir, "pi-session-kit", "machine.json");
	return installationFile(path, () => ({ machineId: randomUUID(), label: "Pi machine" }), validateIdentity).catch(
		(error: unknown) => {
			if (!(error instanceof SyntaxError)) throw error;
			throw new Error(`Invalid installation identity in ${JSON.stringify(path)}: not valid JSON`);
		},
	);
}

/**
 * Local export state, never synced: the installation's secret salt plus one outbox's bookkeeping. The
 * bookkeeping lives in a per-outbox file written only under that outbox's export lock, so two outboxes
 * of one agent dir cannot overwrite each other's recovery set; `export-state.json` holds the salt and,
 * for outboxes without their own file yet, the legacy installation-wide bookkeeping they inherit.
 */
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
/** One outbox's bookkeeping: everything in the export state but the installation's salt. */
type OutboxState = Omit<ExportState, "salt">;
const RECOVERY_KEYS = ["recoveryPending", "recoveryFiles", "lostHarnesses", "historyHarnesses"];
const stateFile = (dir: string): string => join(dir, "pi-session-kit", "export-state.json");
/** Keyed by the resolved outbox, so aliases of one outbox share its bookkeeping and lock. */
async function outboxStateFile(dir: string, snapshotDir: string): Promise<string> {
	const key = createHash("sha256")
		.update(await realpath(snapshotDir))
		.digest("hex");
	return join(dir, "pi-session-kit", "outboxes", `${key}.json`);
}
/**
 * Private like the state it holds: the `outboxes/` directory is 0700, also when an older kit created it
 * under a looser umask. On POSIX it must be a real directory owned by this user (not a symlink), else the
 * export is refused. Without POSIX ownership (Windows) the platform's permissions apply.
 */
async function privateOutboxes(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const uid = process.getuid?.();
	if (uid === undefined) return;
	const info = await lstat(dir);
	if (!info.isDirectory() || info.uid !== uid)
		throw new Error(
			`Outbox bookkeeping directory ${JSON.stringify(dir)} is not a directory owned by this user; move it aside and retry`,
		);
	if ((info.mode & 0o777) !== 0o700) await chmod(dir, 0o700);
}
/** Written 0600 through an atomic rename into the directory `privateOutboxes` checked. */
async function recordOutbox(path: string, state: OutboxState): Promise<void> {
	await atomicJson(path, { version: 1, ...state });
}
function validateState(value: unknown): ExportState {
	const optional = RECOVERY_KEYS.filter((key) => record(value) && Object.hasOwn(value, key));
	exact(value, ["version", "salt", "harnesses", "failures", ...optional]);
	if (typeof value.salt !== "string" || !/^[a-f0-9]{32}$/.test(value.salt)) throw new Error("Invalid export state");
	return { salt: value.salt, ...validateBookkeeping(value) };
}
function validateOutbox(value: unknown): OutboxState {
	exact(value, ["version", "harnesses", "failures", ...RECOVERY_KEYS]);
	return validateBookkeeping(value);
}
function validateBookkeeping(value: Record<string, unknown>): OutboxState {
	const harnesses = value.harnesses;
	const failures = value.failures;
	if (
		value.version !== 1 ||
		("recoveryPending" in value && typeof value.recoveryPending !== "boolean") ||
		("recoveryFiles" in value && value.recoveryFiles !== null && !shardFileList(value.recoveryFiles)) ||
		("lostHarnesses" in value && !harnessList(value.lostHarnesses)) ||
		("historyHarnesses" in value && value.historyHarnesses !== null && !harnessList(value.historyHarnesses)) ||
		!(harnesses === null || harnessList(harnesses)) ||
		!record(failures) ||
		!Object.entries(failures).every(([h, n]) => HARNESSES.includes(h as Harness) && count(n) && n > 0)
	)
		throw new Error("Invalid export state");
	return {
		harnesses: harnesses as Harness[] | null,
		failures: failures as ExportState["failures"],
		recoveryPending: value.recoveryPending === true,
		recoveryFiles: (value.recoveryFiles as string[] | null | undefined) ?? null,
		lostHarnesses: (value.lostHarnesses as Harness[] | undefined) ?? [],
		historyHarnesses: (value.historyHarnesses as Harness[] | null | undefined) ?? null,
	};
}
/**
 * A state file that was read but does not validate is never replaced, so it refuses until the owner
 * repairs it. Filesystem errors (with an errno `code`) pass through unchanged. JSON parse errors can
 * quote the file, which holds the salt, so only a fixed reason is reported and the parse error is not
 * attached as a cause.
 */
function invalidState(path: string, error: unknown): never {
	if ((error as NodeJS.ErrnoException).code !== undefined) throw error;
	const reason = error instanceof SyntaxError ? "not valid JSON" : (error as Error).message;
	throw new ExportRefusal("export-state-invalid", `Invalid export state in ${JSON.stringify(path)}: ${reason}`);
}
/** Created on first use with a fresh salt and no recorded set. */
async function exportState(dir: string): Promise<ExportState> {
	const path = stateFile(dir);
	return installationFile(
		path,
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
	).catch((error: unknown) => invalidState(path, error));
}
/** This outbox's own bookkeeping, `null` when it has none. Corrupt fails. */
async function ownOutbox(path: string): Promise<OutboxState | null> {
	try {
		return validateOutbox(await jsonFile(path));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") invalidState(path, error);
		return null;
	}
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

/** The lineage position `[session, origin]` a legacy row names, shared by `makeSnapshot` and the retirement rule. */
const positionKey = (sessionId: string, origin: number | null | undefined): string =>
	JSON.stringify([sessionId, origin]);

/** Allowlist projection. No source objects, paths, names or message payloads are serialized. */
export function makeSnapshot(
	loaded: Loaded,
	identity: Identity,
	exportedAt = Date.now(),
	quota: readonly QuotaObservation[] = [],
	lastGoodAt: Manifest["lastGoodAt"] = {},
	/** Wall clock for quota expiry; `exportedAt` can run ahead of it. */
	now = exportedAt,
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
	// Lineage needs a position that names one row: one shared by two scanned rows (two transcripts with one
	// session id) is published as `null`, never guessed.
	const originKey = (c: Call): string => positionKey(sessionId(c.session), c.origin);
	const positions = new Map<string, number>();
	for (const c of loaded.calls)
		if (c.origin !== undefined) positions.set(originKey(c), (positions.get(originKey(c)) ?? 0) + 1);
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
		const origin = c.origin === undefined ? {} : { origin: positions.get(originKey(c)) === 1 ? c.origin : null };
		shard(monthOf(c.ms)).events.push({ id: eventId(e), ...e, ...origin });
	}
	for (const q of mergeQuota(quota, now))
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
		shards: [...shards.values()].sort((a, b) => a.month.localeCompare(b.month)).map(withLineage),
	};
}

/**
 * The canonical form of a shard: lineage version 4, with an `origin` on every event and a `retired` list, when
 * any row carries lineage (a legacy origin or a retired row); otherwise plain version 3, byte-identical to what
 * kits without lineage publish.
 */
function withLineage(shard: CompactShard): CompactShard {
	const { retired = [], ...rest } = shard;
	const lineage = retired.length > 0 || shard.events.some((e) => typeof e.origin === "number");
	if (!lineage) return { ...rest, version: 3, events: shard.events.map(({ origin: _, ...e }) => e) };
	return {
		...rest,
		version: LINEAGE_VERSION,
		events: shard.events.map((e) => ({ ...e, origin: e.origin ?? null })),
		retired,
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
	const retired = shard.retired ?? [];
	const rows = [...shard.events, ...retired];
	const ids = [...new Set([...shard.sessions.map((s) => s.id), ...rows.map((e) => e.sessionId)])].sort();
	const pairs = [...new Set(rows.map((e) => JSON.stringify([e.provider, e.model])))].sort();
	const sessions = new Map(ids.map((id, i) => [id, i]));
	const models = new Map(pairs.map((pair, i) => [pair, i]));
	const epoch = Date.parse(`${shard.month}-01T00:00:00Z`);
	const lineage = shard.version === LINEAGE_VERSION;
	const wireRow = (e: Omit<SnapshotEvent, "origin">): unknown[] => [
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
	];
	const order = (a: { ms: number; id: string }, b: { ms: number; id: string }): number =>
		a.ms - b.ms || codeUnits(a.id, b.id);
	const compact = {
		v: lineage ? LINEAGE_VERSION : 3,
		m: shard.machineId,
		t: shard.month,
		s: ids.map(packedId),
		p: pairs.map((pair) => JSON.parse(pair) as [string, string]),
		d: [...shard.sessions]
			.sort((a, b) => codeUnits(a.id, b.id))
			.map((s) => [sessions.get(s.id), s.startMs - epoch, s.endMs - s.startMs, s.child ? 1 : 0]),
		e: [...shard.events].sort(order).map((e) => (lineage ? [...wireRow(e), e.origin] : wireRow(e))),
		q: shard.quota,
		// Retired rows: the event row, then the successor's packed id and the reason code (1: `revised`).
		...(lineage ? { x: [...retired].sort(order).map((e) => [...wireRow(e), packedId(e.successor), 1]) } : {}),
	};
	return JSON.stringify(compact);
}

/** zlib emits a zero mtime; canonical JSON and a fixed compression level make producer bytes stable. */
const gzipCanonical = (text: string): Buffer => gzipSync(text, { level: 9 });

/** Canonical v3 wire encoding. Collision-checked 96-bit entry identities deduplicate across versions. */
export function encodeShard(shard: Shard): Buffer {
	if (shard.version !== 3 && shard.version !== LINEAGE_VERSION) return Buffer.from(JSON.stringify(shard));
	const text = compactJson(shard);
	if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("Shard exceeds 128 MiB");
	return gzipCanonical(text);
}

/** Decode bounded wire bytes into the existing strict, privacy-only aggregation schema. */
export function decodeShard(bytes: Buffer, manifest: Manifest, month: string): Shard {
	return decodeWithinBudget(bytes, manifest, month, MAX_BYTES).shard;
}

/** The machine's expansion budget is spent: authenticated bytes, too many of them, not damage. */
class OverBudget extends Error {
	constructor(options?: ErrorOptions) {
		super("Machine snapshot exceeds 128 MiB expanded", options);
	}
}

/** Charge actual wire bytes before parsing another shard or publishing its reference. */
function expandWithinBudget(
	bytes: Buffer,
	version: number,
	remaining: number,
): { text: string; expandedBytes: number } {
	if (remaining <= 0) throw new OverBudget();
	let text: string;
	try {
		text = (version === 3 ? gunzipSync(bytes, { maxOutputLength: remaining }) : bytes).toString("utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw new OverBudget({ cause: error });
		throw error;
	}
	return { text, expandedBytes: chargeExpansion(Buffer.byteLength(text), remaining) };
}

function chargeExpansion(expandedBytes: number, remaining: number): number {
	if (expandedBytes > remaining) throw new OverBudget();
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
	const lineage = record(value) && value.v === LINEAGE_VERSION;
	exact(value, ["v", "m", "t", "s", "p", "d", "e", "q", ...(lineage ? ["x"] : [])]);
	if (
		(value.v !== 3 && !lineage) ||
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
	const event = (r: unknown[]): SnapshotEvent => {
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
		return { id: eventId(e as Omit<SnapshotEvent, "id">), ...e } as SnapshotEvent;
	};
	const events = value.e.map((data: unknown) => {
		if (!lineage) return event(row(data, 10));
		const r = row(data, 11);
		return { ...event(r), origin: r[10] };
	});
	if (lineage && !Array.isArray(value.x)) throw new Error("Invalid compact shard");
	const lineageRows = lineage
		? {
				retired: (value.x as unknown[]).map((data): RetiredEvent => {
					const r = row(data, 12);
					if (r[11] !== 1) throw new Error("Invalid retired row");
					return { ...event(r), successor: unpackedId(r[10]), reason: "revised" };
				}),
			}
		: {};
	const shard = validateShard(
		{
			version: lineage ? LINEAGE_VERSION : 3,
			machineId: value.m,
			month: value.t,
			events,
			sessions,
			quota: value.q,
			...lineageRows,
		},
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
/** A legacy pi row: the only kind a transcript origin or a retirement can name. */
const legacyPi = (e: Record<string, unknown>): boolean => e.entryId === null && e.harness === "pi";
export function validateShard(value: unknown, manifest: Manifest, month: string): Shard {
	const v2 = manifest.version >= 2;
	// Lineage shards are compact wire version 4 inside a v3 manifest; nothing else may carry lineage.
	const lineage = manifest.version === 3 && record(value) && value.version === LINEAGE_VERSION;
	exact(value, [...SHARD_KEYS, ...(v2 ? ["quota"] : []), ...(lineage ? ["retired"] : [])]);
	if (
		(value.version !== manifest.version && !lineage) ||
		value.machineId !== manifest.machineId ||
		value.month !== month ||
		!Array.isArray(value.events) ||
		!Array.isArray(value.sessions) ||
		(v2 && !Array.isArray(value.quota)) ||
		(lineage && !Array.isArray(value.retired))
	)
		throw new Error("Invalid shard header");
	const keys = [
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
	];
	const checkEvent = (e: unknown, extra: string[]): Record<string, unknown> => {
		exact(e, [...keys, ...extra]);
		if (
			!hash(e.id) ||
			(v2 && !HARNESSES.includes(e.harness as Harness)) ||
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
		return e;
	};
	const seenEvents = new Set<string>();
	let origins = 0;
	for (const data of value.events) {
		const e = checkEvent(data, lineage ? ["origin"] : []);
		if (seenEvents.has(e.id as string)) throw new Error("Invalid snapshot event");
		if (lineage && !(e.origin === null || (count(e.origin) && legacyPi(e)))) throw new Error("Invalid event origin");
		if (typeof e.origin === "number") origins++;
		seenEvents.add(e.id as string);
	}
	for (const data of lineage ? (value.retired as unknown[]) : []) {
		const e = checkEvent(data, ["successor", "reason"]);
		if (
			seenEvents.has(e.id as string) ||
			!legacyPi(e) ||
			!hash(e.successor) ||
			e.successor === e.id ||
			e.reason !== "revised"
		)
			throw new Error("Invalid retired event");
		seenEvents.add(e.id as string);
	}
	// Canonical: a producer writes version 4 only for a shard that holds lineage.
	if (lineage && origins === 0 && (value.retired as unknown[]).length === 0)
		throw new Error("Lineage shard without lineage");
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
	const retired = new Map<string, string>();
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
		for (const e of s.retired ?? []) {
			if (retired.has(e.id)) throw new Error("Duplicate retired identity");
			retired.set(e.id, e.successor);
		}
		for (const q of s.quota ?? []) {
			if (snapshot.manifest.version < 3 && quota.has(quotaKey(q))) throw new Error("Duplicate quota window");
			quota.add(quotaKey(q));
		}
	}
	for (const s of snapshot.shards)
		for (const e of s.events) if (!metadata.has(e.sessionId)) throw new Error("Missing session metadata");
	// A retired row is never also counted, its successor is published (counted, or retired in turn), and each
	// successor replaces at most one row.
	const successors = new Set<string>();
	for (const [id, successor] of retired) {
		if (events.has(id) || !(events.has(successor) || retired.has(successor)) || successors.has(successor))
			throw new Error("Invalid row lineage");
		successors.add(successor);
	}
}

/** Which harnesses an export reads, and where. Default is pi only: other tools are opt-in. */
export interface ExportOptions {
	harnesses?: readonly Harness[];
	/**
	 * Publish this scan as a replacement generation. Bypasses the narrower-set, unreadable-history,
	 * missing-manifest and later-month safeguards and clears frozen recovery files, so it drops published
	 * history absent from the scan, sealed months included. Like any export it is timestamped after the readable published
	 * manifest, so viewers holding that manifest import it; viewers holding a snapshot newer than the
	 * replacement (e.g. with no readable manifest to bound it) keep their copy. It does not bypass the
	 * implausible-watermark refusal.
	 */
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

/**
 * A readable manifest whose history is not: the unreadable shard files (empty when only their union is
 * invalid), the first authenticated shard the expansion budget could not hold, and the manifest's own
 * `exportedAt`, which still bounds the next publication instant. A manifest the owner may not read
 * (`damaged` is `manifest.json`, `manifestDenied` its errno code) has no `exportedAt`: like an unreadable
 * one, it bounds nothing. A denied shard is never damage: `loadPrevious` throws it as retryable I/O.
 */
interface Damaged {
	damaged: string[];
	manifestDenied?: string;
	exportedAt?: number;
	overBudget?: string;
}

/**
 * A filesystem call failed for a reason other than absence (EIO, EMFILE, EACCES...). Only Node's
 * filesystem errors carry `syscall`; parse, digest, zlib and validation failures do not. Such a failure
 * says nothing about the file, so it is neither damage nor a refusal: the caller sees it and retries.
 * The one exception is a permission denial on the manifest itself, see `loadPrevious`.
 */
const readFailure = (error: unknown): boolean =>
	typeof (error as NodeJS.ErrnoException).syscall === "string" && (error as NodeJS.ErrnoException).code !== "ENOENT";

async function loadPrevious(snapshotDir: string): Promise<Previous | Damaged> {
	let manifest: Manifest;
	try {
		manifest = validateManifest(await jsonFile(join(snapshotDir, "manifest.json")));
	} catch (error) {
		// A denied manifest read persists until the owner acts, so retrying never helps: it is damage that
		// refuses an ordinary export and that explicit replacement publishes over by rename, as before.
		// Ambiguous I/O (EIO, EMFILE, EBUSY...) stays fatal and unclassified: it may clear on retry.
		const code = (error as NodeJS.ErrnoException).code;
		if (readFailure(error) && (code === "EACCES" || code === "EPERM"))
			return { damaged: ["manifest.json"], manifestDenied: code };
		if (readFailure(error)) throw error;
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
	}
	const shards: Shard[] = [];
	const expandedSizes: number[] = [];
	const damaged: string[] = [];
	let overBudget: string | undefined;
	let remaining = MAX_BYTES;
	// Read every reference so the owner learns all the files to restore, not just the first.
	for (const ref of manifest.shards) {
		try {
			const read = await readShard(snapshotDir, manifest, ref, remaining);
			shards.push(read.shard);
			expandedSizes.push(read.expandedBytes);
			remaining -= read.expandedBytes;
		} catch (error) {
			if (readFailure(error)) throw error;
			if (!(error instanceof OverBudget)) damaged.push(ref.file);
			else overBudget ??= ref.file;
		}
	}
	if (damaged.length > 0 || overBudget !== undefined) return { damaged, overBudget, exportedAt: manifest.exportedAt };
	try {
		validateSnapshot({ manifest, shards });
	} catch {
		return { damaged: [], exportedAt: manifest.exportedAt };
	}
	return { manifest, shards, expandedSizes };
}

/**
 * Why `previous` cannot bound the next publication instant although this outbox published before: its
 * manifest is corrupt, denied (only its errno code is named) or, per `publishedBefore`, missing. A missing
 * manifest with no sign of an earlier export is a first export, which has nothing to follow.
 */
function unboundedBy(previous: Previous | Damaged, publishedBefore: boolean): string | undefined {
	if (previous === "unreadable") return "manifest.json unreadable";
	if (previous === null) return publishedBefore ? "manifest.json missing" : undefined;
	return "damaged" in previous && previous.manifestDenied !== undefined
		? `${previous.manifestDenied} on manifest.json`
		: undefined;
}

/**
 * Publishing over a readable manifest with unreadable shards would evict its intact history from the
 * active snapshot. Keep it, naming what to restore, unless the owner explicitly asks for replacement.
 */
function intactPrevious(previous: Previous | Damaged, replace: boolean): Previous {
	if (previous === null || previous === "unreadable" || !("damaged" in previous)) return previous;
	if (replace) return "unreadable";
	// Restoring read access keeps the archived history a replacement would drop; only the errno code is named.
	if (previous.manifestDenied !== undefined)
		throw new ExportRefusal(
			"history-unreadable",
			`Published usage manifest is not readable (${previous.manifestDenied} on manifest.json); restore read access to it ` +
				"and retry before considering --replace-harnesses, which drops published history absent from this scan",
		);
	// Restoring files fixes damage, never a spent budget: report damage first, then the budget.
	if (previous.damaged.length === 0 && previous.overBudget !== undefined)
		throw new ExportRefusal(
			"history-over-budget",
			`Published usage history exceeds the 128 MiB expanded machine budget (from ${previous.overBudget}); ` +
				"those files match the manifest, so restoring them will not help: pass --replace-harnesses to publish without it",
		);
	const what = previous.damaged.length > 0 ? previous.damaged.join(", ") : "shards inconsistent with each other";
	throw new ExportRefusal(
		"history-unreadable",
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

/** Sealed months a correction retires, and the sealed event and session rows it supersedes. */
interface Revisions {
	months: Set<string>;
	/** Ids of sealed events a corrected call replaces. */
	supersededEventIds: Set<string>;
	/** The scan's corrected row for each sealed session id whose start or child attribution changed. */
	supersededSessions: Map<string, SnapshotSession>;
}

/** Retire sealed generations only when a physical call or session identity was corrected. */
function detectRevisions(previous: MachineSnapshot, next: MachineSnapshot): Revisions {
	const revised = new Set<string>();
	const supersededEventIds = new Set<string>();
	const supersededSessions = new Map<string, SnapshotSession>();
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
					supersededEventIds.add(prior.id);
					revised.add(prior.month);
					revised.add(shard.month);
				}
		}
	const sessions = new Map(next.shards.flatMap((s) => s.sessions.map((session) => [session.id, session] as const)));
	for (const shard of previous.shards)
		for (const prior of shard.sessions) {
			const current = sessions.get(prior.id);
			if (current && (current.startMs !== prior.startMs || current.child !== prior.child)) {
				supersededSessions.set(prior.id, current);
				revised.add(shard.month);
				revised.add(monthOf(current.startMs));
			}
		}
	return { months: revised, supersededEventIds, supersededSessions };
}

/**
 * Sealed legacy pi rows a clean scan revises, each mapped to the event id that replaces it. Lineage is the
 * persisted transcript origin (`SnapshotEvent.origin`): a sealed row with one is revised only when all hold:
 * the scan no longer holds it; the scan still holds another sealed row of its session, under that session and at
 * that row's published origin (the transcript is still there, not replaced by another file with the same session
 * id; a correction touching every sealed row of a session has no anchor and appends, as before); the scan holds
 * exactly one legacy row at the lost row's origin of its session (`makeSnapshot` publishes `null` for a shared
 * one), in its month, under its provider and model, that is not published at all (counted or retired); and no
 * other lost row names that same successor (one-to-one: a contested successor retires nobody). Anything less
 * establishes no lineage and the row stays counted: never a guess from counts.
 */
function lineageRetirements(sealed: readonly CompactShard[], next: MachineSnapshot): Map<string, string> {
	const scanned = new Map<string, SnapshotEvent>();
	const at = new Map<string, SnapshotEvent>();
	for (const shard of next.shards)
		for (const e of shard.events) {
			scanned.set(e.id, e);
			if (typeof e.origin === "number") at.set(positionKey(e.sessionId, e.origin), e);
		}
	const published = new Set<string>();
	const anchored = new Set<string>();
	for (const shard of sealed) {
		for (const e of shard.events) {
			published.add(e.id);
			// Same row, same session, same origin: a fork copy elsewhere (same id, other session) anchors nothing.
			const kept = scanned.get(e.id);
			if (typeof e.origin === "number" && kept?.sessionId === e.sessionId && kept.origin === e.origin)
				anchored.add(e.sessionId);
		}
		for (const e of shard.retired ?? []) published.add(e.id);
	}
	const candidates = new Map<string, string[]>();
	for (const shard of sealed)
		for (const e of shard.events) {
			if (typeof e.origin !== "number" || scanned.has(e.id) || !anchored.has(e.sessionId)) continue;
			const successor = at.get(positionKey(e.sessionId, e.origin));
			if (
				successor === undefined ||
				monthOf(successor.ms) !== shard.month ||
				successor.provider !== e.provider ||
				successor.model !== e.model ||
				published.has(successor.id)
			)
				continue;
			candidates.set(successor.id, [...(candidates.get(successor.id) ?? []), e.id]);
		}
	const successors = new Map<string, string>();
	for (const [successor, ids] of candidates) if (ids.length === 1) successors.set(nth(ids, 0), successor);
	return successors;
}

/** `shard` with the rows `successors` names moved, losslessly, to its retired rows; `undefined` if none. */
function retireRows(shard: CompactShard, successors: ReadonlyMap<string, string>): CompactShard | undefined {
	const moved = shard.events.filter((e) => successors.has(e.id));
	if (moved.length === 0) return undefined;
	return withLineage({
		...shard,
		events: shard.events.filter((e) => !successors.has(e.id)),
		retired: [
			// Only a lineage shard holds a row with an origin, and every lineage shard has a retired list.
			...(shard.retired as RetiredEvent[]),
			...moved.map(({ origin: _, ...e }) => ({
				...e,
				successor: successors.get(e.id) as string,
				reason: "revised" as const,
			})),
		],
	});
}

/**
 * The sealed ends of superseded sessions, under the scan's corrected start and child attribution, as carry
 * shards in the corrected start month: one per regenerated sealed shard and month, so no shard repeats a session.
 * Carried: every distinct sealed end at or after the corrected start and before the active month. An end
 * before the corrected start is dominated by the scan's own end; one in the active month is not carried,
 * because that month is rebuilt from the scan (a deleted call there takes its end with it). Then each
 * corrected session is floored at its latest sealed call that is published under it (any sealed shard,
 * wherever its old metadata was), in one more carry shard per month, so it never ends before its own call.
 */
function rebasedEnds(
	regenerated: ReadonlyMap<string, readonly CompactShard[]>,
	sealed: readonly CompactShard[],
	fresh: ReadonlyMap<string, CompactShard>,
	revisions: Revisions,
	current: string,
): CompactShard[] {
	const corrections = revisions.supersededSessions;
	if (corrections.size === 0) return [];
	const out: CompactShard[] = [];
	const carried = new Map<string, number>();
	for (const shards of regenerated.values())
		for (const shard of shards) {
			const byMonth = new Map<string, CompactShard>();
			for (const prior of shard.sessions) {
				const corrected = corrections.get(prior.id);
				if (!corrected || prior.endMs < corrected.startMs || monthOf(prior.endMs) >= current) continue;
				const month = monthOf(corrected.startMs);
				const target = byMonth.get(month) ?? blank(shard, month);
				target.sessions.push({ ...corrected, endMs: prior.endMs });
				byMonth.set(month, target);
				carried.set(prior.id, Math.max(carried.get(prior.id) ?? 0, prior.endMs));
			}
			out.push(...byMonth.values());
		}
	// Sealed shards hold only calls before the active month. An unrevised month keeps its shards verbatim;
	// `regenerateMonth` publishes the scan first, then each unsuperseded sealed event whose id is not yet
	// published, so a sealed row a fresh row (maybe under another session) replaces floors nothing.
	const published = new Map<string, Set<string>>();
	const floors = new Map<string, { corrected: SnapshotSession; endMs: number; shard: CompactShard }>();
	for (const shard of sealed)
		for (const event of shard.events) {
			if (revisions.supersededEventIds.has(event.id)) continue;
			if (regenerated.has(shard.month)) {
				let ids = published.get(shard.month);
				if (!ids) {
					ids = new Set(fresh.get(shard.month)?.events.map((e) => e.id));
					published.set(shard.month, ids);
				}
				if (ids.has(event.id)) continue;
				ids.add(event.id);
			}
			const corrected = corrections.get(event.sessionId);
			if (!corrected) continue;
			const endMs = Math.max(floors.get(event.sessionId)?.endMs ?? 0, event.ms);
			floors.set(event.sessionId, { corrected, endMs, shard });
		}
	const floored = new Map<string, CompactShard>();
	for (const [id, { corrected, endMs, shard }] of floors) {
		// A floor above the published ends lies after the corrected start, so before the active month too.
		if (endMs <= Math.max(corrected.endMs, carried.get(id) ?? 0)) continue;
		const month = monthOf(corrected.startMs);
		const target = floored.get(month) ?? blank(shard, month);
		target.sessions.push({ ...corrected, endMs });
		floored.set(month, target);
	}
	out.push(...floored.values());
	return out;
}

/**
 * Regenerate a revised sealed month from the clean scan, then carry what its replaced sealed shards held that the
 * scan no longer reproduces (archived calls and sessions, every distinct session end, quota readings) in
 * delta shards, plus the `rebased` sealed ends of sessions whose corrected start falls in this month. Only
 * the superseded rows themselves are dropped. Past the shard limit the carries are packed losslessly into
 * the fresh shard and as few more as validation allows; if even that does not fit, publication is refused
 * rather than dropping a sealed row.
 */
function regenerateMonth(
	month: string,
	full: CompactShard | undefined,
	replaced: readonly CompactShard[],
	revisions: Revisions,
	rebased: readonly CompactShard[],
): CompactShard[] {
	const shards = full ? [full] : [];
	for (const shard of replaced) {
		const carry = monthDelta(
			{
				...shard,
				events: shard.events.filter((event) => !revisions.supersededEventIds.has(event.id)),
				sessions: shard.sessions.filter((session) => !revisions.supersededSessions.has(session.id)),
			},
			shards,
			true,
		);
		if (carry) shards.push(carry);
	}
	for (const shard of rebased) {
		const carry = monthDelta(shard, shards, true);
		if (carry) shards.push(carry);
	}
	if (shards.length <= MAX_SEALED_SHARDS) return shards;
	const [base, ...carries] = shards as [CompactShard, ...CompactShard[]];
	const packed = packLossless(base, carries);
	if (packed.length > MAX_SEALED_SHARDS)
		throw new Error(
			`Revised sealed month ${month} cannot keep its history within ${MAX_SEALED_SHARDS} shards; ` +
				"refusing to publish. Pass --replace-harnesses to publish the scan as a replacement",
		);
	return packed;
}

/**
 * Pack `deltas` into `first` and as few further shards as validation allows without dropping a row: every
 * event and every retired row joins `first`, and each session or quota row goes to the first shard not yet
 * holding its session id or quota window, counting the rows `first` already holds.
 */
function packLossless(first: CompactShard, deltas: readonly CompactShard[]): CompactShard[] {
	const slots: CompactShard[] = [
		{
			...first,
			events: [...first.events, ...deltas.flatMap((delta) => delta.events)],
			sessions: [...first.sessions],
			quota: [...first.quota],
			retired: [...(first.retired ?? []), ...deltas.flatMap((delta) => delta.retired ?? [])],
		},
	];
	const slot = (n: number): CompactShard => {
		slots[n] ??= blank(first);
		return slots[n];
	};
	const sessionRows = new Map(first.sessions.map((session) => [session.id, 1]));
	const quotaRows = new Map(first.quota.map((q) => [quotaKey(q), 1]));
	for (const delta of deltas) {
		for (const session of delta.sessions) {
			const n = sessionRows.get(session.id) ?? 0;
			slot(n).sessions.push(session);
			sessionRows.set(session.id, n + 1);
		}
		for (const q of delta.quota) {
			const n = quotaRows.get(quotaKey(q)) ?? 0;
			slot(n).quota.push(q);
			quotaRows.set(quotaKey(q), n + 1);
		}
	}
	return slots;
}

/**
 * Compact late updates without rewriting the base or consulting the current transcript scan, dropping
 * session ends below the maximum and quota readings that can never win. Only used once lossless packing
 * no longer fits.
 */
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
			// The base keeps its own retired rows; the deltas' move here, never dropped.
			retired: deltas.flatMap((delta) => delta.retired ?? []),
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
			const shard = compacted[slot] ?? blank(base);
			shard.quota.push(q);
			compacted[slot++] = shard;
		}
	}
	// Do not silently throw away a candidate just to fit the cap.
	if (compacted.length >= MAX_SEALED_SHARDS) throw new Error("Sealed month quota history exceeds shard limit");
	return compacted.filter(nonempty);
}

const nonempty = (shard: CompactShard): boolean =>
	shard.events.length + shard.sessions.length + shard.quota.length + (shard.retired?.length ?? 0) > 0;
/** An empty shard of `shard`'s machine for `month`: no rows, retired ones included, are copied. */
const blank = (shard: CompactShard, month = shard.month): CompactShard => ({
	version: SNAPSHOT_VERSION,
	machineId: shard.machineId,
	month,
	events: [],
	sessions: [],
	quota: [],
});

/**
 * What `full` adds to `old`. A session row is new past the maximum end `old` holds, or, with `exactEnds`
 * (regeneration, which must keep every distinct sealed end), when `old` lacks that exact id and end.
 */
function monthDelta(full: CompactShard, old: readonly CompactShard[], exactEnds = false): CompactShard | undefined {
	const events = new Set(old.flatMap((shard) => shard.events.map((event) => event.id)));
	const ends = new Map<string, number>();
	const rows = new Set<string>();
	const row = (session: SnapshotSession): string => JSON.stringify([session.id, session.endMs]);
	for (const shard of old)
		for (const session of shard.sessions) {
			ends.set(session.id, Math.max(ends.get(session.id) ?? 0, session.endMs));
			rows.add(row(session));
		}
	const quotas = new Set(old.flatMap((shard) => shard.quota.map((q) => JSON.stringify(q))));
	const delta = {
		...full,
		events: full.events.filter((event) => !events.has(event.id)),
		sessions: full.sessions.filter((session) =>
			exactEnds ? !rows.has(row(session)) : session.endMs > (ends.get(session.id) ?? 0),
		),
		quota: full.quota.filter((q) => !quotas.has(JSON.stringify(q))),
	};
	return nonempty(delta) ? delta : undefined;
}

/** Count a failure by its safe errno code only: never a path or message. */
function countErrno(errors: Map<string, number>, error: unknown): void {
	const raw = (error as NodeJS.ErrnoException | null | undefined)?.code;
	const code = typeof raw === "string" && /^E[A-Z0-9_]{1,23}$/.test(raw) ? raw : "UNKNOWN";
	errors.set(code, (errors.get(code) ?? 0) + 1);
}

/**
 * Best-effort, per-file unlink in `snapshotDir`; an already absent file is not a failure. Returns the files whose
 * unlink failed, so they are still on disk.
 */
async function removeFiles(
	snapshotDir: string,
	files: readonly string[],
	errors: Map<string, number>,
): Promise<string[]> {
	const failed: string[] = [];
	for (const file of files) {
		try {
			await unlink(join(snapshotDir, file));
		} catch (error) {
			if ((error as NodeJS.ErrnoException | null | undefined)?.code === "ENOENT") continue;
			countErrno(errors, error);
			failed.push(file);
		}
	}
	return failed;
}

/** One warning with sorted errno counts, or none. */
const errnoWarning = (what: string, errors: ReadonlyMap<string, number>): string[] =>
	errors.size
		? [
				`${what}: ${[...errors]
					.sort(([a], [b]) => codeUnits(a, b))
					.map(([code, count]) => `${code}=${count}`)
					.join(", ")}`,
			]
		: [];

/** Best-effort cleanup of only unreferenced, unprotected content-addressed files. */
async function pruneOutbox(snapshotDir: string, keep: ReadonlySet<string>): Promise<string[]> {
	const cleanupErrors = new Map<string, number>();
	const entries = await readdir(snapshotDir, { withFileTypes: true }).catch((error: unknown) => {
		countErrno(cleanupErrors, error);
		return [];
	});
	const obsolete = entries
		.filter((entry) => entry.isFile() && SHARD_FILE.test(entry.name) && !keep.has(entry.name))
		.map((entry) => entry.name);
	await removeFiles(snapshotDir, obsolete, cleanupErrors);
	return errnoWarning("obsolete shard cleanup failed", cleanupErrors);
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
	return withExportLock(snapshotDir, () => publishStats(dir, snapshotDir, root, options, identity));
}

/**
 * Run `work` holding the outbox's exclusive export lock. A lock release failure after `work` succeeded is a
 * warning on its result; after it failed, both errors are reported.
 */
async function withExportLock<T extends { warnings?: string[] }>(
	snapshotDir: string,
	work: () => Promise<T>,
): Promise<T> {
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
	let outcome: { ok: true; result: T } | { ok: false; error: unknown };
	try {
		outcome = { ok: true, result: await work() };
	} catch (error) {
		outcome = { ok: false, error };
	}
	try {
		await rmdir(lock);
	} catch (unlockError) {
		const warning = `could not release export lock ${JSON.stringify(lock)}; check permissions and remove it only after verifying no export is running`;
		// Never turn an already-visible publish into a failure, nor hide the primary publication error.
		// A refusal keeps its code: the unlock failure is a secondary diagnostic, never a retryable cause.
		if (!outcome.ok && outcome.error instanceof ExportRefusal)
			throw new ExportRefusal(outcome.error.refusal, `${outcome.error.message}\n${warning}`, {
				cause: new AggregateError([outcome.error, unlockError]),
			});
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
	// The wall clock is read once, first, so the manifest read cannot move it.
	const now = Date.now();
	const loadedPrevious = await loadPrevious(snapshotDir);
	// The publication instant is monotonic over the readable manifest: strictly after the last published
	// export, even when this clock is behind it, so viewers holding the published snapshot accept this one
	// as newer. Without a readable manifest there is nothing to follow.
	const publishedAt =
		loadedPrevious === null || loadedPrevious === "unreadable"
			? 0
			: "damaged" in loadedPrevious
				? (loadedPrevious.exportedAt ?? 0)
				: loadedPrevious.manifest.exportedAt;
	const exportedAt = Math.max(now, publishedAt + 1);
	// A watermark that is implausibly far ahead would misdate everything sealed after it, and one past year
	// 9999 has no `YYYY-MM` month that sorts after the sealed ones: refuse, replacement included, with no
	// cache or publication writes. This runs under the outbox lock `exportStats` holds; its release after
	// the refusal is best effort and can fail. Within
	// years 0000-9999 a later instant never seals an earlier month.
	if (publishedAt - now > MAX_CLOCK_LEAD_MS || exportedAt > LAST_ISO_MS)
		throw new ExportRefusal(
			"watermark-ahead",
			`Published usage manifest exportedAt (${new Date(publishedAt).toISOString()}) is more than 366 days ahead ` +
				`of this clock (${new Date(now).toISOString()}) or leaves no instant before year 10000 to publish after ` +
				`it (${JSON.stringify(join(snapshotDir, "manifest.json"))}); there is no supported in-place repair ` +
				"(https://github.com/nredd/pi-harness/issues/1327): back up this outbox and publish into a fresh one. " +
				"--replace-harnesses does not bypass this",
		);
	// Every manifest seals exactly the months before its `exportedAt` month: that is the only record of what
	// was sealed. Publishing in a later month than this clock's would seal months it has not left, and a
	// later export could not tell them from months a clock-ahead export sealed: refuse (no cache or
	// publication writes; this also runs under the outbox lock).
	// A replacement seals nothing from the previous generation, so it may publish there. No refusal code:
	// this clears by itself once the clock reaches that month, so callers keep retrying it.
	if (!options.replaceHarnesses && monthOf(exportedAt) > monthOf(now))
		throw new Error(
			`Clock (${new Date(now).toISOString()}) is in an earlier month than the next export after the last ` +
				`published one (${new Date(publishedAt).toISOString()}); publishing would seal months this clock has ` +
				`not left. Fix the clock or wait until ${monthOf(exportedAt)}, or pass --replace-harnesses to publish ` +
				"without published history absent from this scan",
		);
	// Checked after the watermark, so damage never hides a refusal --replace-harnesses cannot bypass.
	const previous = intactPrevious(loadedPrevious, options.replaceHarnesses === true);
	// Exporting twice within one millisecond is not a clock problem; only a clock behind it is reported.
	const clockWarning =
		now < publishedAt
			? [
					`clock is behind the last published export (${new Date(now).toISOString()} < ` +
						`${new Date(publishedAt).toISOString()}); published at ${new Date(exportedAt).toISOString()} instead`,
				]
			: [];
	// Bookkeeping is per outbox and written only under its lock: another outbox's export cannot record
	// stale recovery state over this one's.
	const statePath = await outboxStateFile(dir, snapshotDir);
	await privateOutboxes(dirname(statePath));
	const own = await ownOutbox(statePath);
	// A missing manifest is a first export only if nothing says this outbox published before. Otherwise
	// publishing the scan would replace its sealed history and prune the shards that hold it.
	const publishedBefore =
		loadedPrevious === null &&
		(own !== null ||
			(await readdir(snapshotDir, { withFileTypes: true })).some(
				(entry) => entry.isFile() && SHARD_FILE.test(entry.name),
			));
	if (publishedBefore && !options.replaceHarnesses)
		throw new ExportRefusal(
			"manifest-missing",
			`Published usage manifest is missing from ${JSON.stringify(snapshotDir)}, but this outbox published ` +
				"before (its bookkeeping or shard files remain); restore manifest.json from the sync checkout, " +
				"or pass --replace-harnesses to publish without that history",
		);
	// Nothing records the last published instant but the manifest, so without it there is no watermark to
	// follow: publish by the wall clock rather than guess one, and say so.
	const unbounded = unboundedBy(loadedPrevious, publishedBefore);
	const unboundedWarning =
		unbounded === undefined
			? []
			: [
					`no readable published manifest bounds this export (${unbounded}); published at ` +
						`${new Date(exportedAt).toISOString()} by this clock, so viewers holding a later snapshot of this ` +
						"machine keep it until this clock passes it",
				];
	const installation = await exportState(dir);
	const { salt: _, ...inherited } = installation;
	const bookkeeping = { state: own ?? inherited, own: own !== null };
	const state: ExportState = { ...bookkeeping.state, salt: installation.salt };
	// The recorded set can lag the snapshot (state not written after a publish) or be missing: check against
	// both, so neither a lost nor a stale state file can hide a narrowing.
	const last = new Set([...(state.harnesses ?? []), ...publishedSet(previous)]);
	const dropped = HARNESSES.filter((h) => last.has(h) && !wanted.has(h));
	if (dropped.length > 0 && !options.replaceHarnesses)
		throw new ExportRefusal(
			"harness-set-narrowed",
			`Refusing to publish a narrower harness set than last published (missing: ${dropped.join(", ")}); ` +
				"add them to --harness, or pass --replace-harnesses to drop their history",
		);
	// With neither a readable snapshot nor a recorded set, what was last published cannot be established.
	if (previous === "unreadable" && state.harnesses === null && !options.replaceHarnesses)
		throw new ExportRefusal(
			"harness-set-unknown",
			"Cannot establish which harnesses were last published (unreadable snapshot, no recorded set); " +
				"pass --replace-harnesses to publish anyway",
		);
	const loaded = wanted.has("pi")
		? await loadUsage({ root, cache: cachePath(dir), includeAllRoots: true })
		: { calls: [], sessions: [], errors: 0, badLines: 0, diagnostics: [] };
	if (loaded.errors || loaded.badLines) {
		// Fixed, bounded stderr protocol for local callers. Never serialize Loaded or raw exceptions:
		// both can contain transcript-derived values. JSON quoting prevents terminal/newline injection.
		// JSON.stringify leaves U+2028/U+2029 raw, and some readers split lines on them: escape both.
		const details = loaded.diagnostics.map(
			(diagnostic) =>
				`pi-stats-scan: ${JSON.stringify({
					...diagnostic,
					path: diagnostic.path
						.slice(0, 1024)
						.replace(/[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "\ufffd"),
				})
					.replace(/\u2028/g, "\\u2028")
					.replace(/\u2029/g, "\\u2029")}`,
		);
		throw new IncompleteScan(
			[`Incomplete local scan: ${loaded.errors} errors, ${loaded.badLines} bad lines`, ...details].join("\n"),
		);
	}
	const external = EXTERNAL_HARNESSES.filter((h) => wanted.has(h));
	// Harness reads and quota expiry follow the wall clock; publication and sealing follow `exportedAt`.
	const scans = await loadHarnesses({
		now,
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
	const snapshot = makeSnapshot({ ...loaded, calls, sessionMetadata }, identity, exportedAt, quota, lastGoodAt, now);
	validateSnapshot(snapshot);
	const reportedLost = EXTERNAL_HARNESSES.filter((h) => report[h]?.failed === "lost");
	const lostHarnesses = options.replaceHarnesses
		? []
		: HARNESSES.filter(
				(h) =>
					reportedLost.some((lost) => lost === h) ||
					(state.lostHarnesses.includes(h) && (h === "pi" || !(report[h]?.found && !report[h]?.failed))),
			);
	// Without this outbox's own bookkeeping (deleted, or the checkout moved and so rekeyed), a shard
	// neither the active manifest nor the inherited fields account for may be a frozen recovery file:
	// its ownership is unknown, so freeze it instead of pruning it. Only replacement accepts the loss.
	const unaccounted: string[] = [];
	if (!bookkeeping.own && !options.replaceHarnesses) {
		const accounted = new Set([
			...(previous !== null && previous !== "unreadable" ? previous.manifest.shards.map((ref) => ref.file) : []),
			...(state.recoveryFiles ?? []),
		]);
		for (const entry of await readdir(snapshotDir, { withFileTypes: true }))
			if (entry.isFile() && SHARD_FILE.test(entry.name) && !accounted.has(entry.name)) unaccounted.push(entry.name);
	}
	const recoveryPending =
		!options.replaceHarnesses &&
		(state.recoveryPending || previous === "unreadable" || reportedLost.length > 0 || unaccounted.length > 0);
	const protectedFiles = new Set(options.replaceHarnesses ? [] : [...(state.recoveryFiles ?? []), ...unaccounted]);
	const captureRecovery = recoveryPending && (previous === "unreadable" || state.recoveryFiles === null);
	if (captureRecovery) {
		for (const entry of await readdir(snapshotDir, { withFileTypes: true }))
			if (entry.isFile() && SHARD_FILE.test(entry.name)) protectedFiles.add(entry.name);
	}
	const recoveryFiles = [...protectedFiles].sort();
	// Freeze recovery scope BEFORE replacing unreadable history. Ordinary exports never add newly
	// superseded files to this set, so subsequent active generations still prune automatically.
	if (recoveryPending && (captureRecovery || !state.recoveryPending || unaccounted.length > 0))
		await recordOutbox(statePath, {
			harnesses: state.harnesses,
			failures: state.failures,
			recoveryPending,
			recoveryFiles,
			lostHarnesses,
			historyHarnesses: state.historyHarnesses,
		});
	// Uncorrected past months stay sealed. An explicit replacement drops their old generations.
	const sealed =
		previous !== null && previous !== "unreadable" && previous.manifest.version === 3 && !options.replaceHarnesses
			? previous
			: null;
	// Ordinary exports publish only in this clock's month (above), so this is the wall clock's month.
	const current = monthOf(exportedAt);
	const revisions: Revisions = sealed
		? detectRevisions(sealed, snapshot)
		: { months: new Set(), supersededEventIds: new Set(), supersededSessions: new Map() };
	// Legacy rows a correction revised are retired in place first: every sealed row stays in its shard.
	const sealedShards = (sealed?.shards ?? []) as CompactShard[];
	const successors = lineageRetirements(
		sealedShards.filter((shard) => shard.month < current),
		snapshot,
	);
	const lineaged = sealedShards.map((shard) => retireRows(shard, successors));
	const lineagedShards = sealedShards.map((shard, i) => lineaged[i] ?? shard);
	const retiredIds = new Set(lineagedShards.flatMap((shard) => shard.retired?.map((e) => e.id) ?? []));
	/** A sealed shard to keep: its published reference, or none when lineage rewrote it. */
	type Kept =
		| { ref: Manifest["shards"][number]; shard: CompactShard; expandedBytes: number }
		| { ref?: undefined; shard: CompactShard };
	const prior = new Map<string, Kept[]>();
	const regenerated = new Map<string, CompactShard[]>();
	if (sealed)
		for (const [i, original] of sealedShards.entries()) {
			if (original.month >= current) continue;
			const rewritten = lineaged[i];
			const shard = rewritten ?? original;
			if (revisions.months.has(shard.month)) {
				regenerated.set(shard.month, [...(regenerated.get(shard.month) ?? []), shard]);
				continue;
			}
			const refs = prior.get(shard.month) ?? [];
			// loadPrevious authenticated and validated every shard against this v3 manifest; a rewritten one is new.
			refs.push(
				rewritten
					? { shard }
					: { ref: nth(sealed.manifest.shards, i), shard, expandedBytes: nth(sealed.expandedSizes, i) },
			);
			prior.set(shard.month, refs);
		}
	// A scanned row identical to a retired one stays retired: it is published, and counting it again would
	// double count beside its successor.
	const fresh = new Map(
		snapshot.shards.map((shard) => [
			shard.month,
			{ ...shard, events: shard.events.filter((e) => !retiredIds.has(e.id)) },
		]),
	);
	const rebased = rebasedEnds(
		regenerated,
		lineagedShards.filter((shard) => shard.month < current),
		fresh,
		revisions,
		current,
	);
	const publishedShards: CompactShard[] = [];
	const writes: { file: string; bytes: Buffer }[] = [];
	let remaining = MAX_BYTES;
	/** Encode a new shard of `month` in canonical form, charge it and queue its content-addressed write. */
	const publish = (month: string, raw: CompactShard): void => {
		const shard = withLineage(raw);
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
	};
	for (const month of [...new Set([...prior.keys(), ...regenerated.keys(), ...fresh.keys()])].sort()) {
		let old = prior.get(month) ?? [];
		const full = fresh.get(month);
		const moved = rebased.filter((shard) => shard.month === month);
		const replaced = regenerated.get(month);
		const delta =
			full &&
			monthDelta(
				full,
				old.map(({ shard }) => shard),
			);
		let deltas =
			replaced || moved.length ? regenerateMonth(month, full, replaced ?? [], revisions, moved) : delta ? [delta] : [];
		if (old.length + deltas.length > MAX_SEALED_SHARDS) {
			const base = nth(old, 0);
			const rest = [...old.slice(1).map(({ shard }) => shard), ...deltas];
			// Keep every row (e.g. readings a regeneration preserved) whenever lossless packing fits beside the base.
			const packed = packLossless(blank(base.shard), rest).filter(nonempty);
			deltas = packed.length < MAX_SEALED_SHARDS ? packed : compactDeltas(base.shard, rest);
			old = [base];
		}
		for (const kept of old) {
			if (kept.ref === undefined) {
				publish(month, kept.shard);
				continue;
			}
			remaining -= chargeExpansion(kept.expandedBytes, remaining);
			snapshot.manifest.shards.push(kept.ref);
			publishedShards.push(kept.shard);
		}
		for (const shard of deltas) publish(month, shard);
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
	const warnings = [...clockWarning, ...unboundedWarning];
	if (recoveryPending)
		warnings.push("recovery files retained: run clean-recovery to remove those the active snapshot covers");
	if (unaccounted.length > 0)
		warnings.push(
			`no bookkeeping for this outbox: froze ${unaccounted.length} unaccounted shard files as recovery files; ` +
				"pass --replace-harnesses to drop them",
		);
	const keep = new Set([...snapshot.manifest.shards.map((ref) => ref.file), ...recoveryFiles]);
	warnings.push(...(await pruneOutbox(snapshotDir, keep)));
	// Recorded only once published: a failed export leaves the previous set, so the next run is still checked.
	const published = HARNESSES.filter((h) => wanted.has(h));
	// The snapshot is out by now: failing to record it is a warning, not a failed export. The next run
	// derives the set from the snapshot itself, so a widening is still protected.
	const stateWarnings = await recordOutbox(statePath, {
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

/**
 * Why `cleanRecovery` kept a frozen recovery file: the active manifest references it, it is gone, it is a
 * legacy `.json` shard, it does not authenticate as this machine's v3 shard, or the active snapshot lacks
 * some of its rows.
 */
export type KeptReason = "active" | "missing" | "legacy" | "unreadable" | "not covered" | "changed";
/** What an explicit recovery cleanup did. */
export interface CleanupResult {
	machineId: string;
	snapshotDir: string;
	/** Frozen files proven redundant and now gone (unlinked or already absent), then dropped from the recovery set. */
	removed: string[];
	/** Frozen files proven redundant whose unlink failed: still on disk and still in the recovery set. */
	failed: string[];
	/**
	 * Frozen files that stay, with why. `changed`: the active manifest or this file changed during cleanup, so it
	 * stopped before unlinking this file.
	 */
	kept: { file: string; reason: KeptReason }[];
	warnings?: string[];
}

/** Whether the active snapshot already holds every row of `shard`, so a viewer would see nothing more. */
function coveredBy(active: readonly CompactShard[]): (shard: CompactShard) => boolean {
	// A row's identity and values, without lineage metadata: a pre-lineage frozen row and the same row published
	// later with an `origin` (or the reverse) are the same call.
	const row = (e: Omit<SnapshotEvent, "origin">): string =>
		JSON.stringify([
			e.id,
			e.harness,
			e.entryId,
			e.sessionId,
			e.ms,
			e.provider,
			e.model,
			e.input,
			e.output,
			e.cacheRead,
			e.cacheWrite,
			e.cost,
		]);
	const events = new Map(active.flatMap((s) => s.events.map((e) => [e.id, row(e)] as const)));
	const retired = new Map(active.flatMap((s) => (s.retired ?? []).map((e) => [e.id, JSON.stringify(e)] as const)));
	// A frozen counted row the active snapshot has since retired is held there too, as a recorded replacement.
	const retiredRows = new Map(active.flatMap((s) => (s.retired ?? []).map((e) => [e.id, row(e)] as const)));
	const sessions = mergeSessionMetadata(
		active.flatMap((s) => s.sessions.map((x) => ({ path: x.id, startMs: x.startMs, endMs: x.endMs, child: x.child }))),
	);
	const quota = active.flatMap((s) => s.quota);
	return (shard) =>
		shard.events.every((e) => (events.get(e.id) ?? retiredRows.get(e.id)) === row(e)) &&
		// A retired row is kept like any other: only an identical retired row covers it.
		(shard.retired ?? []).every((e) => retired.get(e.id) === JSON.stringify(e)) &&
		shard.sessions.every((s) => {
			const merged = sessions.get(s.id);
			return (
				merged !== undefined && merged.startMs <= s.startMs && merged.endMs >= s.endMs && (merged.child || !s.child)
			);
		}) &&
		// Same rule as `compactDeltas`: an at-least-as-fresh reading that resets no earlier always wins `mergeQuota`.
		shard.quota.every((q) =>
			quota.some((a) => quotaKey(a) === quotaKey(q) && compareFreshness(a, q) >= 0 && a.resetAt >= q.resetAt),
		);
}

/** The frozen `.json.gz` `file`, authenticated as this machine's v3 shard of its month (never through a symlink). */
async function frozenShard(snapshotDir: string, manifest: Manifest, file: string): Promise<Shard> {
	// The name is the only reference a frozen file has: `<month>-<sha256>.json.gz` (`SHARD_FILE`).
	const ref = {
		month: file.slice(0, 7),
		file,
		sha256: file.slice(8, 72),
		bytes: (await lstat(join(snapshotDir, file))).size,
	};
	return (await readShard(snapshotDir, manifest, ref, MAX_BYTES)).shard;
}

/** `undefined` when the frozen `file` is an authenticated v3 shard of this machine the active snapshot covers. */
async function keptReason(
	snapshotDir: string,
	manifest: Manifest,
	file: string,
	covered: (shard: CompactShard) => boolean,
): Promise<KeptReason | undefined> {
	if (!file.endsWith(".json.gz")) return "legacy";
	let shard: Shard;
	try {
		shard = await frozenShard(snapshotDir, manifest, file);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
	}
	return covered(shard as CompactShard) ? undefined : "not covered";
}

/**
 * Explicit, recovery-only cleanup of frozen shard files; no export ever runs it. Under the outbox's export lock,
 * and only when its active v3 manifest and every shard it references authenticate and its own bookkeeping records
 * a recovery set with no lost harness, a frozen file the manifest does not reference is removed only if it
 * authenticates as this machine's v3 shard and the active snapshot holds every row of it. Everything else stays
 * frozen, with a reason. Every candidate stays in the recovery set until its unlink succeeds; the set shrinks
 * once, after the unlinks, so a crash or failed bookkeeping write leaves only stale names of absent files, which
 * are harmless, never an unprotected frozen file. `restoreSnapshot` holds the same export lock, giving cleanup real
 * exclusion against restores; right before each unlink the manifest is also authenticated and reread and the file
 * authenticated again, stopping cleanup if an external writer modified the outbox outside the lock.
 */
export async function cleanRecovery(dir: string, output: string): Promise<CleanupResult> {
	const identity = await machineIdentity(dir);
	const snapshotDir = join(output, "machines", identity.machineId);
	// Each refusal waits on the owner or a later export, never on a retry of this cleanup: all are coded.
	const refused = (code: RefusalCode, why: string): ExportRefusal =>
		new ExportRefusal(code, `Recovery cleanup refused: ${why}; nothing was removed`);
	// Only absence is "no outbox"; any other error (EACCES, EIO) is the operator's to fix, so it surfaces as is.
	const outbox = await lstat(snapshotDir).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (!outbox?.isDirectory())
		throw refused("recovery-outbox-missing", `no outbox for this machine at ${JSON.stringify(snapshotDir)}`);
	/** `loaded` when it authenticates as this machine's v3 snapshot. */
	const verified = (loaded: Previous | Damaged): Exclude<Previous, null | "unreadable"> | undefined =>
		loaded === null ||
		loaded === "unreadable" ||
		"damaged" in loaded ||
		loaded.manifest.version !== 3 ||
		loaded.manifest.machineId !== identity.machineId
			? undefined
			: loaded;
	const authenticated = async () => verified(await loadPrevious(snapshotDir));
	return withExportLock(snapshotDir, async () => {
		// Transient I/O reading the active snapshot (EIO, EMFILE, a denied shard) throws uncoded: retry it.
		const loaded = await loadPrevious(snapshotDir);
		// An ordinary export refuses these too (`manifest-missing`, `history-unreadable`), and its override would
		// drop the history: only restoring the files or read access helps.
		if (loaded === null || (loaded !== "unreadable" && "damaged" in loaded))
			throw refused(
				"recovery-snapshot-unverified",
				"the active manifest or a shard it references is missing, denied or damaged; " +
					"restore the manifest, the referenced shards or read access, then retry",
			);
		const previous = verified(loaded);
		if (previous === undefined)
			throw refused(
				"recovery-snapshot-unverified",
				"the active manifest does not authenticate as this machine's v3 snapshot; export first",
			);
		const statePath = await outboxStateFile(dir, snapshotDir);
		await privateOutboxes(dirname(statePath));
		const own = await ownOutbox(statePath);
		if (own === null || own.recoveryFiles === null)
			throw refused(
				"recovery-set-unrecorded",
				"this outbox has no recorded recovery set of its own, so frozen files are unaccounted; export first",
			);
		if (own.lostHarnesses.length > 0)
			throw refused(
				"recovery-harness-lost",
				`recovery of lost ${own.lostHarnesses.join(", ")} history is pending and may need frozen files`,
			);
		const referenced = new Set(previous.manifest.shards.map((ref) => ref.file));
		const covered = coveredBy(previous.shards as CompactShard[]);
		const removed: string[] = [];
		const kept: CleanupResult["kept"] = [];
		for (const file of own.recoveryFiles) {
			const reason = referenced.has(file) ? "active" : await keptReason(snapshotDir, previous.manifest, file, covered);
			if (reason === undefined) removed.push(file);
			else kept.push({ file, reason });
		}
		const warnings: string[] = [];
		const failed: string[] = [];
		const expected = JSON.stringify(previous.manifest);
		/** Whether the manifest and `file` are still what cleanup judged, checked as late as possible before its unlink. */
		const unchanged = async (file: string): Promise<boolean> => {
			// Any failure here, transient I/O included, stops cleanup with everything left protected.
			const now = await authenticated().catch(() => undefined);
			if (now === undefined || JSON.stringify(now.manifest) !== expected) return false;
			// Reread after the shard pass: a restore that swapped manifest.json during it is otherwise unseen.
			const manifest = await jsonFile(join(snapshotDir, "manifest.json"))
				.then(validateManifest)
				.catch(() => undefined);
			if (manifest === undefined || JSON.stringify(manifest) !== expected) return false;
			return frozenShard(snapshotDir, previous.manifest, file).then(
				() => true,
				() => false,
			);
		};
		const errors = new Map<string, number>();
		const candidates = removed.splice(0);
		for (const [i, file] of candidates.entries()) {
			// A writer that skips the lock may have installed a manifest referencing `file`: any change stops cleanup.
			if (!(await unchanged(file))) {
				const stopped = candidates.slice(i);
				kept.push(...stopped.map((file) => ({ file, reason: "changed" as const })));
				warnings.push(
					`recovery cleanup stopped: the active manifest changed; ${stopped.length} redundant files left in place`,
				);
				break;
			}
			if ((await removeFiles(snapshotDir, [file], errors)).length > 0) failed.push(file);
			else removed.push(file);
		}
		warnings.push(...errnoWarning("redundant recovery file removal failed (they stay protected)", errors));
		if (removed.length > 0) {
			// Unprotect only what is gone. Failing here leaves stale names of absent files, which export ignores.
			const gone = new Set(removed);
			const recoveryFiles = own.recoveryFiles.filter((file) => !gone.has(file));
			const recorded = await recordOutbox(statePath, {
				...own,
				recoveryFiles,
				recoveryPending: own.recoveryPending && recoveryFiles.length > 0,
			}).then(
				() => true,
				() => false,
			);
			if (!recorded) warnings.push("recovery set not updated: removed files stay listed as missing (harmless)");
		}
		return {
			machineId: identity.machineId,
			snapshotDir,
			removed,
			failed,
			kept,
			...(warnings.length ? { warnings } : {}),
		};
	});
}

/** What an explicit locked outbox restore wrote or repaired. */
export interface RestoreResult {
	machineId: string;
	snapshotDir: string;
	exportedAt: number;
	/** Shard files and `manifest.json` written or repaired in `snapshotDir`, shards first and `manifest.json` last. */
	restored: string[];
	warnings?: string[];
}

/** Whether `path` is already a readable regular file (never a symlink) holding `expected`. */
async function sameRegularFile(path: string, expected: Buffer): Promise<boolean> {
	try {
		return (await lstat(path)).isFile() && (await readFile(path)).equals(expected);
	} catch {
		return false;
	}
}

/**
 * Restore this machine's manifest and/or referenced shards from `input` into `<output>/machines/<machineId>` under
 * the outbox's `.export.lock`, giving `exportStats` and `cleanRecovery` real mutual exclusion against restores.
 * `input` may be a sync root (`<input>/machines/<machineId>`) or a direct machine snapshot directory (`<input>`).
 * Validates the manifest as this machine's, authenticates every referenced shard within the 128 MiB cumulative
 * expansion budget (from `sourceDir` when present there, else from `snapshotDir`), and validates the whole snapshot
 * before writing any file: missing, damaged, denied or symlinked shards are atomically written first, then
 * `manifest.json` last, without pruning unreferenced files or modifying outbox bookkeeping.
 */
export async function restoreSnapshot(dir: string, input: string, output: string): Promise<RestoreResult> {
	const identity = await machineIdentity(dir);
	const snapshotDir = join(output, "machines", identity.machineId);
	return withExportLock<RestoreResult>(snapshotDir, async () => {
		if (!(await lstat(input)).isDirectory())
			throw new Error(`Restore source ${JSON.stringify(input)} is not a directory`);
		const nested = join(input, "machines", identity.machineId);
		const nestedStat = await lstat(nested).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (nestedStat && !nestedStat.isDirectory())
			throw new Error(`Restore source ${JSON.stringify(nested)} is not a directory`);
		const sourceDir = nestedStat ? nested : input;
		if ((await realpath(sourceDir)) === (await realpath(snapshotDir)))
			throw new Error(`Restore source ${JSON.stringify(sourceDir)} is the target outbox`);
		const sourceManifest = await lstat(join(sourceDir, "manifest.json")).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		const manifestBase = sourceManifest ? sourceDir : snapshotDir;
		const manifest = validateManifest(await jsonFile(join(manifestBase, "manifest.json")));
		if (manifest.machineId !== identity.machineId)
			throw new Error(
				`Restore manifest machineId (${manifest.machineId}) does not match this installation (${identity.machineId})`,
			);
		const shards: Shard[] = [];
		const fromSource: { file: string; bytes: Buffer }[] = [];
		let remaining = MAX_BYTES;
		for (const ref of manifest.shards) {
			const inSource = await lstat(join(sourceDir, ref.file)).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return undefined;
				throw error;
			});
			const read = await readShard(inSource ? sourceDir : snapshotDir, manifest, ref, remaining);
			remaining -= read.expandedBytes;
			shards.push(read.shard);
			if (inSource) fromSource.push({ file: ref.file, bytes: read.bytes });
		}
		if (!sourceManifest && fromSource.length === 0)
			throw new Error(
				`Restore source ${JSON.stringify(sourceDir)} contains neither manifest.json nor any referenced shard`,
			);
		validateSnapshot({ manifest, shards });
		const restored: string[] = [];
		for (const { file, bytes } of fromSource) {
			const target = join(snapshotDir, file);
			if (!(await sameRegularFile(target, bytes))) {
				await atomicContents(target, bytes);
				restored.push(file);
			}
		}
		const manifestPath = join(snapshotDir, "manifest.json");
		const manifestBytes = Buffer.from(JSON.stringify(manifest));
		if (!(await sameRegularFile(manifestPath, manifestBytes))) {
			await atomicContents(manifestPath, manifestBytes);
			restored.push("manifest.json");
		}
		return { machineId: identity.machineId, snapshotDir, exportedAt: manifest.exportedAt, restored };
	});
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
