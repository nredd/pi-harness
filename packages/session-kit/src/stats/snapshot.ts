/** Privacy-only monthly snapshots and offline, atomic last-good imports. Node builtins only. */
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	agentDir,
	cachePath,
	dedupCalls,
	type Loaded,
	loadUsage,
	mergeSessionMetadata,
	opaqueId,
	sessionsDir,
} from "./load.ts";

export const SNAPSHOT_VERSION = 1;
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
	entryId: string | null;
	sessionId: string;
	ms: number;
	provider: string;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}
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
}
export interface Manifest extends Identity {
	version: number;
	exportedAt: number;
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

/** An installation identity belongs to the agent dir, never to the sync checkout. */
export async function machineIdentity(dir = agentDir()): Promise<Identity> {
	const path = join(dir, "pi-session-kit", "machine.json");
	try {
		return validateIdentity(await jsonFile(path));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await mkdir(dirname(path), { recursive: true });
	const identity = { machineId: randomUUID(), label: "Pi machine" };
	const tmp = `${path}.${randomUUID()}.tmp`;
	await writeFile(tmp, JSON.stringify(identity), { flag: "wx", mode: 0o600 });
	try {
		// Hard-link publication is atomic and exclusive: concurrent readers never see partial JSON.
		await link(tmp, path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	} finally {
		await unlink(tmp);
	}
	return validateIdentity(await jsonFile(path));
}

/** Canonical event fingerprint includes identity, timestamp, raw attribution and every counter. */
export function eventId(event: Omit<SnapshotEvent, "id">): string {
	if (event.entryId === null)
		return opaqueId(
			JSON.stringify([
				event.provider,
				event.model,
				event.ms,
				event.input,
				event.output,
				event.cacheRead,
				event.cacheWrite,
			]),
		);
	return opaqueId(
		JSON.stringify([
			event.entryId,
			event.ms,
			event.provider,
			event.model,
			event.input,
			event.output,
			event.cacheRead,
			event.cacheWrite,
		]),
	);
}

/** Allowlist projection. No source objects, paths, names or message payloads are serialized. */
export function makeSnapshot(loaded: Loaded, identity: Identity, exportedAt = Date.now()): MachineSnapshot {
	const shards = new Map<string, Shard>();
	const shard = (month: string): Shard => {
		let s = shards.get(month);
		if (!s) {
			s = { version: SNAPSHOT_VERSION, machineId: identity.machineId, month, events: [], sessions: [] };
			shards.set(month, s);
		}
		return s;
	};
	const sessionId = (value: string): string => (HASH.test(value) ? value : opaqueId(`session:${value}`));
	for (const c of loaded.calls) {
		const e = {
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
	for (const s of loaded.sessionMetadata ?? loaded.sessions)
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
			shards: [],
		},
		shards: [...shards.values()].sort((a, b) => a.month.localeCompare(b.month)),
	};
}

export function validateManifest(value: unknown): Manifest {
	exact(value, ["version", "machineId", "label", "exportedAt", "shards"]);
	if (
		value.version !== SNAPSHOT_VERSION ||
		typeof value.machineId !== "string" ||
		!UUID.test(value.machineId) ||
		!name(value.label) ||
		!positive(value.exportedAt) ||
		!Array.isArray(value.shards)
	)
		throw new Error("Invalid or unsupported manifest");
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
export function validateShard(value: unknown, manifest: Manifest, month: string): Shard {
	exact(value, ["version", "machineId", "month", "events", "sessions"]);
	if (
		value.version !== SNAPSHOT_VERSION ||
		value.machineId !== manifest.machineId ||
		value.month !== month ||
		!Array.isArray(value.events) ||
		!Array.isArray(value.sessions)
	)
		throw new Error("Invalid shard header");
	const seenEvents = new Set<string>();
	for (const e of value.events) {
		exact(e, [
			"id",
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
			typeof e.cost !== "number" ||
			!Number.isFinite(e.cost) ||
			e.cost < 0 ||
			eventId(e as unknown as SnapshotEvent) !== e.id
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
	return value as unknown as Shard;
}

/** Cross-shard session references and identifiers are validated as one machine transaction. */
export function validateSnapshot(snapshot: MachineSnapshot): void {
	const metadata = new Set<string>();
	const events = new Set<string>();
	for (const s of snapshot.shards) {
		for (const session of s.sessions) {
			if (metadata.has(session.id)) throw new Error("Duplicate session metadata");
			metadata.add(session.id);
		}
		for (const e of s.events) {
			if (events.has(e.id)) throw new Error("Duplicate event identity");
			events.add(e.id);
		}
	}
	for (const s of snapshot.shards)
		for (const e of s.events) if (!metadata.has(e.sessionId)) throw new Error("Missing session metadata");
}

/** Write only this machine's immutable shards, publishing its manifest last. */
export async function exportStats(
	dir: string,
	output: string,
	root = sessionsDir(dir),
): Promise<{ machineId: string; snapshotDir: string }> {
	const identity = await machineIdentity(dir);
	const loaded = await loadUsage({ root, cache: cachePath(dir), includeAllRoots: true });
	if (loaded.errors || loaded.badLines)
		throw new Error(`Incomplete local scan: ${loaded.errors} errors, ${loaded.badLines} bad lines`);
	const snapshot = makeSnapshot(loaded, identity);
	validateSnapshot(snapshot);
	const snapshotDir = join(output, "machines", identity.machineId);
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
	return { machineId: identity.machineId, snapshotDir };
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
			v.version !== SNAPSHOT_VERSION ||
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
				const ref = m.shards[i];
				if (!ref) throw new Error("Missing shard");
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

/** Independent machine transactions: invalid/missing machines retain last-good data; one atomic publication. */
export async function importStats(
	dir: string,
	input: string,
): Promise<{ imported: number; retained: number; problems: string[]; importedAt: number }> {
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
				if (machines[id] && manifest.exportedAt < (machines[id]?.manifest.exportedAt ?? 0))
					throw new Error("Older machine snapshot");
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
	return { imported, retained: Object.keys(machines).length - imported, problems, importedAt };
}

/** Shared offline loader for /stats and harness fixtures. Local usage is always freshly scanned. */
export async function loadCombined(
	dir = agentDir(),
	onProgress?: (done: number, total: number) => void,
): Promise<Combined> {
	const identity = await machineIdentity(dir);
	const local = await loadUsage({ root: sessionsDir(dir), cache: cachePath(dir), includeAllRoots: true, onProgress });
	const global = await readGlobal(dir);
	const remotes = Object.values(global.machines).filter((m) => m.manifest.machineId !== identity.machineId);
	const candidates = [...local.calls];
	const sessionCandidates = [...(local.sessionMetadata ?? local.sessions)];
	for (const machine of remotes)
		for (const s of machine.shards) {
			for (const e of s.events)
				candidates.push({
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
			for (const session of s.sessions)
				sessionCandidates.push({
					path: session.id,
					startMs: session.startMs,
					endMs: session.endMs,
					child: session.child,
				});
		}
	const sessions = mergeSessionMetadata(sessionCandidates);
	// Across machines, the oldest session owns copies too, not whichever UUID was read first.
	const calls = dedupCalls(
		candidates.sort(
			(a, b) =>
				(sessions.get(a.session)?.startMs ?? a.ms) - (sessions.get(b.session)?.startMs ?? b.ms) ||
				a.session.localeCompare(b.session),
		),
	);
	const owners = new Set(calls.map((c) => c.session));
	return {
		...local,
		calls,
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
