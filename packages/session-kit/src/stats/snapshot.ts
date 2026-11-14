/** Privacy-only monthly snapshots and offline, atomic last-good imports. Node builtins only. */
import { randomBytes, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { agentDir } from "../agent-dir.ts";
import { mergeQuota, type QuotaObservation } from "./harness/common.ts";
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

/** v2 adds `harness` on events, a null `cost` and quota observations. v1 is still imported (as pi). */
export const SNAPSHOT_VERSION = 2;
const VERSIONS: readonly number[] = [1, 2];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_BYTES = 128 * 1024 * 1024;
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
}
export interface GlobalCache {
	version: number;
	importedAt: number;
	machines: Record<string, MachineSnapshot>;
	problems: string[];
}
/** Known sources only, including failed imports with no last-good snapshot. */
export interface MachineCoverage extends Identity {
	local: boolean;
	exportedAt?: number;
	incomplete: boolean;
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
}

/** Atomic replacement, also safe against concurrent writers' temporary-file collisions. */
export async function atomicJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
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
}
const stateFile = (dir: string): string => join(dir, "pi-session-kit", "export-state.json");
function validateState(value: unknown): ExportState {
	exact(value, ["version", "salt", "harnesses", "failures"]);
	const harnesses = value.harnesses;
	const failures = value.failures;
	if (
		value.version !== 1 ||
		typeof value.salt !== "string" ||
		!/^[a-f0-9]{32}$/.test(value.salt) ||
		!(
			harnesses === null ||
			(Array.isArray(harnesses) &&
				harnesses.every((h) => HARNESSES.includes(h as Harness)) &&
				new Set(harnesses).size === harnesses.length)
		) ||
		!record(failures) ||
		!Object.entries(failures).every(([h, n]) => HARNESSES.includes(h as Harness) && count(n) && n > 0)
	)
		throw new Error("Invalid export state");
	return {
		salt: value.salt,
		harnesses: harnesses as Harness[] | null,
		failures: failures as ExportState["failures"],
	};
}
/** Created on first use with a fresh salt and no recorded set. */
async function exportState(dir: string): Promise<ExportState> {
	return installationFile(
		stateFile(dir),
		() => ({ version: 1, salt: randomBytes(16).toString("hex"), harnesses: null, failures: {} }),
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
): MachineSnapshot {
	const shards = new Map<string, Shard>();
	const shard = (month: string): Shard => {
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
			entryId: c.entryId ?? null,
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
		shard(monthOf(q.observedAt)).quota?.push({
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
	for (const ref of value.shards) {
		exact(ref, ["month", "file", "sha256", "bytes"]);
		if (
			typeof ref.month !== "string" ||
			!MONTH.test(ref.month) ||
			months.has(ref.month) ||
			!hash(ref.sha256) ||
			ref.file !== `${ref.month}-${ref.sha256}.json` ||
			!count(ref.bytes) ||
			ref.bytes > MAX_BYTES
		)
			throw new Error("Invalid shard reference");
		months.add(ref.month);
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
			!(e.entryId === null || hash(e.entryId)) ||
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
	if (v2) for (const q of value.quota as unknown[]) validateQuota(q, month);
	return value as unknown as Shard;
}

/** Cross-shard session references and identifiers are validated as one machine transaction. */
export function validateSnapshot(snapshot: MachineSnapshot): void {
	const metadata = new Set<string>();
	const events = new Set<string>();
	const quota = new Set<string>();
	for (const s of snapshot.shards) {
		for (const session of s.sessions) {
			if (metadata.has(session.id)) throw new Error("Duplicate session metadata");
			metadata.add(session.id);
		}
		for (const e of s.events) {
			if (events.has(e.id)) throw new Error("Duplicate event identity");
			events.add(e.id);
		}
		for (const q of s.quota ?? []) {
			if (quota.has(quotaKey(q))) throw new Error("Duplicate quota window");
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
type Previous = { manifest: Manifest; shards: Shard[] } | null | "unreadable";

async function loadPrevious(snapshotDir: string): Promise<Previous> {
	let manifest: Manifest;
	try {
		manifest = validateManifest(await jsonFile(join(snapshotDir, "manifest.json")));
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
	}
	try {
		const shards: Shard[] = [];
		for (const ref of manifest.shards) {
			const text = await readFile(join(snapshotDir, ref.file), "utf8");
			if (opaqueId(text) !== ref.sha256) throw new Error("Shard digest mismatch");
			shards.push(validateShard(JSON.parse(text) as unknown, manifest, ref.month));
		}
		validateSnapshot({ manifest, shards });
		return { manifest, shards };
	} catch {
		return "unreadable";
	}
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
	return out;
}

/**
 * Write only this machine's immutable shards, publishing its manifest last. Callers must not run two exports
 * into one outbox at once (`pi-usage-sync` serializes its runs); nothing here locks.
 */
export async function exportStats(
	dir: string,
	output: string,
	root = sessionsDir(dir),
	options: ExportOptions = {},
): Promise<{ machineId: string; snapshotDir: string; harnesses?: HarnessReport }> {
	const wanted = new Set<Harness>(options.harnesses ?? ["pi"]);
	const identity = await machineIdentity(dir);
	const state = await exportState(dir);
	const snapshotDir = join(output, "machines", identity.machineId);
	const previous = await loadPrevious(snapshotDir);
	// No recorded set: derive it from what was published, so a lost state file cannot hide a narrowing.
	const dropped = (state.harnesses ?? publishedSet(previous)).filter((h) => !wanted.has(h));
	if (dropped.length > 0 && !options.replaceHarnesses)
		throw new Error(
			`Refusing to publish a narrower harness set than last published (missing: ${dropped.join(", ")}); ` +
				"add them to --harness, or pass --replace-harnesses to drop their history",
		);
	const loaded: Loaded = wanted.has("pi")
		? await loadUsage({ root, cache: cachePath(dir), includeAllRoots: true })
		: { calls: [], sessions: [], errors: 0, badLines: 0 };
	if (loaded.errors || loaded.badLines)
		throw new Error(`Incomplete local scan: ${loaded.errors} errors, ${loaded.badLines} bad lines`);
	const external = EXTERNAL_HARNESSES.filter((h) => wanted.has(h));
	const scans = await loadHarnesses({
		harnesses: external,
		roots: options.roots,
		env: options.env,
		home: options.home,
		cache: harnessCachePath(dir),
		loadSqlite: options.loadSqlite,
		salt: state.salt,
	});
	const exportedAt = Date.now();
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
		const gone = !scan.found && !options.replaceHarnesses && old !== null && old.calls.length + old.quota.length > 0;
		const failed = scan.problems.some(fatalProblem) || gone;
		const use = failed ? (old ?? emptyContribution()) : { ...scan, sessions: scan.sessionMetadata };
		const problems = [
			...scan.problems,
			...(gone ? [`${h}: not found, but data was published before`] : []),
			...(failed && old === null ? [`${h}: last published contents unreadable`] : []),
		];
		if (failed) failures[h] = (state.failures[h] ?? 0) + 1;
		// Carried data is as fresh as it was: the previous snapshot's own mark, else when it was published.
		const was = previous !== null && previous !== "unreadable" ? previous.manifest : undefined;
		const lastGood = failed ? (was?.lastGoodAt?.[h] ?? was?.exportedAt) : exportedAt;
		// Never after the export itself: a carried mark from a snapshot written under a faster clock must stay valid.
		if (lastGood !== undefined) lastGoodAt[h] = Math.min(lastGood, exportedAt);
		report[h] = {
			found: scan.found,
			problems,
			...(failed ? { failed: old ? ("kept" as const) : ("lost" as const), consecutiveFailures: failures[h] } : {}),
		};
		calls.push(...use.calls);
		sessionMetadata.push(...use.sessions);
		quota.push(...use.quota);
	}
	const snapshot = makeSnapshot({ ...loaded, calls, sessionMetadata }, identity, exportedAt, quota, lastGoodAt);
	validateSnapshot(snapshot);
	await mkdir(snapshotDir, { recursive: true });
	for (const s of snapshot.shards) {
		const text = JSON.stringify(s);
		const sha256 = opaqueId(text);
		const file = `${s.month}-${sha256}.json`;
		validateShard(s, snapshot.manifest, s.month);
		await atomicJson(join(snapshotDir, file), s);
		snapshot.manifest.shards.push({ month: s.month, file, sha256, bytes: Buffer.byteLength(text) });
	}
	await atomicJson(join(snapshotDir, "manifest.json"), validateManifest(snapshot.manifest));
	// Recorded only once published: a failed export leaves the previous set, so the next run is still checked.
	const published = HARNESSES.filter((h) => wanted.has(h));
	await atomicJson(stateFile(dir), { version: 1, salt: state.salt, harnesses: published, failures });
	return { machineId: identity.machineId, snapshotDir, ...(external.length ? { harnesses: report } : {}) };
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
			exact(machine, ["manifest", "shards"]);
			const m = validateManifest(machine.manifest);
			if (m.machineId !== id || !Array.isArray(machine.shards) || machine.shards.length !== m.shards.length)
				throw new Error("Invalid cached machine");
			for (const [i, s] of machine.shards.entries()) {
				// The length check above pairs every cached shard with its manifest reference.
				const ref = nth(m.shards, i);
				validateShard(s, m, ref.month);
				if (opaqueId(JSON.stringify(s)) !== ref.sha256) throw new Error("Cached shard digest mismatch");
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
				for (const ref of manifest.shards) {
					const path = join(base, ref.file);
					const info = await lstat(path);
					if (!info.isFile() || info.size !== ref.bytes || info.size > MAX_BYTES)
						throw new Error("Invalid shard size/type");
					const text = await readFile(path, "utf8");
					if (opaqueId(text) !== ref.sha256) throw new Error("Shard digest mismatch");
					const s = validateShard(JSON.parse(text) as unknown, manifest, ref.month);
					if (JSON.stringify(s) !== text) throw new Error("Noncanonical shard JSON");
					shards.push(s);
				}
				validateSnapshot({ manifest, shards });
				const prior = machines[id];
				if (prior && manifest.exportedAt < prior.manifest.exportedAt) throw new Error("Older machine snapshot");
				machines[id] = { manifest, shards };
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

/** Shared offline loader for /stats and harness fixtures. Local usage is always freshly scanned. */
export async function loadCombined(
	dir = agentDir(),
	onProgress?: (done: number, total: number) => void,
	now = Date.now(),
): Promise<Combined> {
	const identity = await machineIdentity(dir);
	const local = await loadUsage({ root: sessionsDir(dir), cache: cachePath(dir), includeAllRoots: true, onProgress });
	const global = await readGlobal(dir);
	const remotes = Object.values(global.machines).filter((m) => m.manifest.machineId !== identity.machineId);
	const candidates = [...local.calls];
	const sessionCandidates = [...sessionsOf(local)];
	const quotaCandidates: QuotaObservation[] = [];
	for (const machine of remotes)
		for (const s of machine.shards) {
			// Until `/stats` labels harnesses (and prices a null cost as unpriced, not $0), only pi usage is shown.
			for (const e of s.events.filter((e) => (e.harness ?? "pi") === "pi"))
				candidates.push({
					harness: "pi",
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
			quotaCandidates.push(...(s.quota ?? []));
			for (const session of s.sessions)
				sessionCandidates.push({
					path: session.id,
					startMs: session.startMs,
					endMs: session.endMs,
					child: session.child,
				});
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
		quota: mergeQuota(quotaCandidates, now),
		sessionMetadata: [...sessions.values()],
		sessions: [...sessions.values()].filter((s) => !s.child && owners.has(s.path)),
		coverage: {
			sources: [
				{ ...identity, local: true, incomplete: local.errors > 0 || local.badLines > 0 },
				...remotes.map(({ manifest }) => ({
					machineId: manifest.machineId,
					label: manifest.label,
					local: false,
					exportedAt: manifest.exportedAt,
					incomplete: global.problems.some((p) => p.endsWith(` ${manifest.machineId}`)),
				})),
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
