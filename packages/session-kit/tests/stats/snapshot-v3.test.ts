import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile as asyncWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { dedupCalls, opaqueId } from "../../src/stats/load.ts";
import {
	decodeShard,
	encodeShard,
	eventId,
	exportStats,
	importStats,
	loadCombined,
	type Manifest,
	makeSnapshot,
	readGlobal,
	validateShard,
	validateSnapshot,
} from "../../src/stats/snapshot.ts";
import { assistantLine, call, sessionFile } from "../fixtures/stats/fixtures.ts";

vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
vi.mock("node:zlib", async (original) => {
	const actual = await original<typeof import("node:zlib")>();
	return { ...actual, gzipSync: vi.fn(actual.gzipSync) };
});

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("publishes compact gzip and bounds repeated historical exports to new data", async () => {
	const root = mkdtempSync(join(tmpdir(), "stats-v3-"));
	roots.push(root);
	const agent = join(root, "agent");
	const out = join(root, "out");
	const ms = Date.parse("2026-01-02T12:00:00Z");
	const path = join(agent, "sessions", "fixture.jsonl");
	const lines = Array.from({ length: 100 }, (_, i) => {
		const line = JSON.parse(assistantLine({ ms: ms + i, provider: "physical", model: "fixture", input: i + 1 }));
		line.id = `event-${i}`;
		return JSON.stringify(line);
	});
	sessionFile(path, { startMs: ms, lines });
	const first = await exportStats(agent, out);
	const manifestPath = join(first.snapshotDir, "manifest.json");
	const before = JSON.parse(readFileSync(manifestPath, "utf8"));
	expect(before.version).toBe(3);
	const ref = before.shards[0];
	expect(ref.file).toMatch(/\.json\.gz$/);
	const bytes = readFileSync(join(first.snapshotDir, ref.file));
	expect(JSON.parse(gunzipSync(bytes).toString()).e).toHaveLength(100);
	const line = JSON.parse(assistantLine({ ms: ms + 100, provider: "physical", model: "fixture", input: 101 }));
	line.id = "new-event";
	sessionFile(path, { startMs: ms, lines: [...lines, JSON.stringify(line)] });
	await exportStats(agent, out);
	const after = JSON.parse(readFileSync(manifestPath, "utf8"));
	expect(after.shards).toContainEqual(ref);
	expect(readFileSync(join(first.snapshotDir, ref.file))).toEqual(bytes);
	expect(after.shards.reduce((sum: number, s: { bytes: number }) => sum + s.bytes, 0)).toBeLessThan(ref.bytes * 1.5);
	await exportStats(agent, out);
	expect(readdirSync(first.snapshotDir).sort()).toEqual(
		["manifest.json", ...after.shards.map((s: { file: string }) => s.file)].sort(),
	);
	const viewer = join(root, "viewer");
	expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
	expect((await loadCombined(viewer)).calls).toHaveLength(101);
});

const identity = { machineId: "11111111-1111-4111-8111-111111111111", label: "fixture" };
const ms = Date.parse("2026-01-02T12:00:00Z");
function fixture() {
	const event = call("2026-01-02", "physical", "fixture", 7, 1, { entryId: opaqueId("entry") });
	const snapshot = makeSnapshot(
		{ calls: [event], sessions: [{ path: event.session, startMs: event.ms, endMs: event.ms }], errors: 0, badLines: 0 },
		identity,
		ms,
	);
	const shard = snapshot.shards[0];
	if (!shard) throw new Error("Missing fixture shard");
	return { snapshot, shard, bytes: encodeShard(shard) };
}

interface WireFixture extends Record<string, unknown> {
	s: unknown[];
	p: unknown[];
	d: [unknown[]];
	e: [unknown[]];
}
const malformed: [string, (v: WireFixture) => void][] = [
	[
		"version",
		(v) => {
			v.v = 4;
		},
	],
	[
		"machine",
		(v) => {
			v.m = "wrong";
		},
	],
	[
		"month",
		(v) => {
			v.t = "2026-02";
		},
	],
	...["s", "p", "d", "e"].map((key): [string, (v: WireFixture) => void] => [
		`table ${key}`,
		(v) => {
			v[key] = null;
		},
	]),
	[
		"identity type",
		(v) => {
			v.s[0] = 1;
		},
	],
	[
		"identity bytes",
		(v) => {
			v.s[0] = "AAAA";
		},
	],
	[
		"identity spelling",
		(v) => {
			v.s[0] = `${v.s[0]}\n`;
		},
	],
	[
		"model pair",
		(v) => {
			v.p[0] = null;
		},
	],
	[
		"model arity",
		(v) => {
			v.p[0] = ["physical"];
		},
	],
	[
		"model name",
		(v) => {
			v.p[0] = ["physical", ""];
		},
	],
	[
		"row type",
		(v) => {
			Object.assign(v.e, { 0: null });
		},
	],
	[
		"row arity",
		(v) => {
			v.e[0].push(0);
		},
	],
	[
		"negative index",
		(v) => {
			v.e[0][0] = -1;
		},
	],
	[
		"missing index",
		(v) => {
			v.e[0][4] = 999;
		},
	],
	[
		"fractional timestamp",
		(v) => {
			v.e[0][3] = 0.5;
		},
	],
	[
		"metadata offset",
		(v) => {
			v.d[0][1] = -1;
		},
	],
	[
		"metadata duration",
		(v) => {
			v.d[0][2] = -1;
		},
	],
	[
		"metadata child",
		(v) => {
			v.d[0][3] = 2;
		},
	],
	[
		"extra table identity",
		(v) => {
			v.s.push(Buffer.alloc(32, 7).toString("base64"));
		},
	],
];
it.each(malformed)("rejects malformed compact %s before aggregation", (_name, mutate) => {
	const { snapshot, shard, bytes } = fixture();
	const value = JSON.parse(gunzipSync(bytes).toString()) as WireFixture;
	mutate(value);
	expect(() => decodeShard(gzipSync(JSON.stringify(value), { level: 9 }), snapshot.manifest, shard.month)).toThrow();
});

it("preserves cross-version copies and refuses full-identity prefix collisions", () => {
	const a = call("2026-01-02", "physical", "fixture", 7, 1, { entryId: opaqueId("a") });
	const compact = { ...a, entryId: a.entryId?.slice(0, 24) };
	expect(dedupCalls([a, compact])).toHaveLength(1);
	const left = { ...a, entryId: "a".repeat(64) };
	const right = { ...a, entryId: "a".repeat(24) + "b".repeat(40) };
	expect(() => dedupCalls([left, right])).toThrow("Compact entry identity collision");
	expect(() => makeSnapshot({ calls: [left, right], sessions: [], errors: 0, badLines: 0 }, identity)).toThrow(
		"Compact entry identity collision",
	);
});

it("bounds expanded canonical bytes and rejects conflicting sealed metadata", () => {
	const { snapshot, shard } = fixture();
	const original = Buffer.byteLength;
	const measure = vi
		.spyOn(Buffer, "byteLength")
		.mockImplementation((value, encoding) =>
			typeof value === "string" && value.startsWith('{"v":3,') ? 128 * 1024 * 1024 + 1 : original(value, encoding),
		);
	try {
		expect(() => encodeShard(shard)).toThrow("Shard exceeds 128 MiB");
	} finally {
		measure.mockRestore();
	}
	const session = shard.sessions[0];
	if (!session) throw new Error("Missing session");
	expect(() =>
		validateSnapshot({
			manifest: snapshot.manifest,
			shards: [shard, { ...shard, events: [], sessions: [{ ...session, startMs: session.startMs + 1 }] }],
		}),
	).toThrow("Duplicate session metadata");
	expect(() =>
		validateSnapshot({
			manifest: snapshot.manifest,
			shards: [shard, { ...shard, events: [], sessions: [{ ...session, child: !session.child }] }],
		}),
	).toThrow("Duplicate session metadata");
});

it("prunes superseded active generations, ignores unrelated files and retains last-good on corrupt gzip", async () => {
	const root = mkdtempSync(join(tmpdir(), "stats-v3-active-"));
	roots.push(root);
	const agent = join(root, "agent");
	const out = join(root, "out");
	const viewer = join(root, "viewer");
	const now = Date.now();
	const path = join(agent, "sessions", "fixture.jsonl");
	const lines = [assistantLine({ ms: now, provider: "physical", model: "fixture", input: 7 })];
	sessionFile(path, { startMs: now, lines });
	const first = await exportStats(agent, out);
	const manifestPath = join(first.snapshotDir, "manifest.json");
	const before = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
	const ref = before.shards[0];
	if (!ref) throw new Error("Missing reference");
	writeFileSync(join(first.snapshotDir, "unrelated.txt"), "keep");
	const stale = `2025-01-${"a".repeat(64)}.json`;
	writeFileSync(join(first.snapshotDir, stale), "{}");
	sessionFile(path, {
		startMs: now,
		lines: [...lines, assistantLine({ ms: now + 1, provider: "physical", model: "fixture", input: 8 })],
	});
	await exportStats(agent, out);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
	expect(readdirSync(first.snapshotDir).sort()).toEqual(
		["manifest.json", "unrelated.txt", ...manifest.shards.map((r) => r.file)].sort(),
	);
	expect(readdirSync(first.snapshotDir)).not.toContain(ref.file);
	await importStats(viewer, out);
	const cached = await readGlobal(viewer);
	const next = manifest.shards[0];
	if (!next) throw new Error("Missing reference");
	const corrupt = Buffer.from("not gzip");
	const sha256 = createHash("sha256").update(corrupt).digest("hex");
	const file = `${next.month}-${sha256}.json.gz`;
	writeFileSync(join(first.snapshotDir, file), corrupt);
	writeFileSync(
		manifestPath,
		JSON.stringify({ ...manifest, shards: [{ ...next, file, sha256, bytes: corrupt.length }] }),
	);
	expect(await importStats(viewer, out)).toMatchObject({ imported: 0, retained: 1 });
	expect((await readGlobal(viewer)).machines).toEqual(cached.machines);
});

it("rejects noncanonical legacy bytes and duplicate quota rows without weakening old schemas", () => {
	const { snapshot, shard } = fixture();
	const legacy = {
		...shard,
		version: 2,
		events: shard.events.map((event) => {
			const e = { ...event, entryId: event.entryId?.padEnd(64, "0") ?? null };
			return { ...e, id: eventId(e, 2) };
		}),
	};
	expect(() =>
		decodeShard(Buffer.from(JSON.stringify(legacy, null, 1)), { ...snapshot.manifest, version: 2 }, shard.month),
	).toThrow("Noncanonical shard JSON");
	const quota = {
		harness: "codex",
		provider: "physical",
		limitId: "fixture",
		window: "7d",
		usedPercent: 1,
		resetAt: ms + 86400000,
		durationMs: 86400000,
		observedAt: ms,
		planType: null,
		account: "",
	};
	expect(() => validateShard({ ...shard, quota: [quota, quota] }, snapshot.manifest, shard.month)).toThrow(
		"Duplicate quota window",
	);
});

it("does not publish a manifest on write failure or oversized compressed bytes", async () => {
	const root = mkdtempSync(join(tmpdir(), "stats-v3-failure-"));
	roots.push(root);
	const agent = join(root, "agent");
	const out = join(root, "out");
	sessionFile(join(agent, "sessions", "fixture.jsonl"), {
		startMs: ms,
		lines: [assistantLine({ ms, provider: "physical", model: "fixture", input: 7 })],
	});
	const first = await exportStats(agent, out);
	const manifestPath = join(first.snapshotDir, "manifest.json");
	const before = readFileSync(manifestPath);
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	vi.mocked(asyncWriteFile).mockImplementation(async (path, data, options) => {
		if (String(path).endsWith(".json.gz")) throw Object.assign(new Error("write denied"), { code: "EACCES" });
		return actual.writeFile(path, data, options);
	});
	try {
		await expect(exportStats(agent, out, undefined, { replaceHarnesses: true })).rejects.toThrow("write denied");
	} finally {
		vi.mocked(asyncWriteFile).mockRestore();
	}
	expect(readFileSync(manifestPath)).toEqual(before);
	vi.mocked(gzipSync).mockReturnValue(Buffer.alloc(128 * 1024 * 1024 + 1));
	try {
		await expect(exportStats(agent, out, undefined, { replaceHarnesses: true })).rejects.toThrow(
			"Shard exceeds 128 MiB",
		);
	} finally {
		vi.mocked(gzipSync).mockRestore();
	}
	expect(readFileSync(manifestPath)).toEqual(before);
});

it("accepts independently compressed canonical JSON and authenticates cached producer bytes", async () => {
	const root = mkdtempSync(join(tmpdir(), "stats-v3-gzip-"));
	roots.push(root);
	const agent = join(root, "agent");
	const out = join(root, "out");
	const viewer = join(root, "viewer");
	sessionFile(join(agent, "sessions", "fixture.jsonl"), {
		startMs: ms,
		lines: [assistantLine({ ms, provider: "physical", model: "fixture", input: 7 })],
	});
	const first = await exportStats(agent, out);
	const manifestPath = join(first.snapshotDir, "manifest.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
	const ref = manifest.shards[0];
	if (!ref) throw new Error("Missing reference");
	const original = readFileSync(join(first.snapshotDir, ref.file));
	const independent = gzipSync(gunzipSync(original), { level: 0 });
	independent[4] = 1; // A different gzip header and deflate implementation must not affect canonical JSON.
	const sha256 = createHash("sha256").update(independent).digest("hex");
	const file = `${ref.month}-${sha256}.json.gz`;
	const next = { ...manifest, shards: [{ ...ref, file, sha256, bytes: independent.length }] };
	writeFileSync(join(first.snapshotDir, file), independent);
	writeFileSync(manifestPath, JSON.stringify(next));
	expect(decodeShard(independent, next, ref.month)).toEqual(decodeShard(original, manifest, ref.month));
	expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
	const cached = await readGlobal(viewer);
	expect(cached.problems).toEqual([]);
	expect(cached.machines[first.machineId]?.wire).toEqual([independent.toString("base64")]);
	const cachePath = join(viewer, "pi-session-kit", "stats-global.json");
	const doc = JSON.parse(readFileSync(cachePath, "utf8"));
	const mutations: ((v: typeof doc) => void)[] = [
		(v) => {
			v.machines[first.machineId] = null;
		},
		(v) => {
			v.machines[first.machineId].manifest = null;
		},
		(v) => {
			delete v.machines[first.machineId].wire;
		},
		(v) => {
			v.machines[first.machineId].wire = null;
		},
		(v) => {
			v.machines[first.machineId].wire = [];
		},
		(v) => {
			v.machines[first.machineId].wire = [7];
		},
		(v) => {
			v.machines[first.machineId].wire[0] += "\\n";
		},
		(v) => {
			v.machines[first.machineId].manifest.shards[0].bytes++;
		},
		(v) => {
			const changed = Buffer.from(independent);
			changed[changed.length - 1] = 1;
			v.machines[first.machineId].wire[0] = changed.toString("base64");
		},
	];
	for (const mutate of mutations) {
		const changed = structuredClone(doc);
		mutate(changed);
		writeFileSync(cachePath, JSON.stringify(changed));
		expect((await readGlobal(viewer)).problems).toEqual(["Unreadable global cache"]);
	}
});

it("authenticates legacy cached shard bytes without requiring a v3 wire array", async () => {
	const root = mkdtempSync(join(tmpdir(), "stats-v2-cache-"));
	roots.push(root);
	const { snapshot, shard } = fixture();
	const legacy = {
		...shard,
		version: 2,
		events: shard.events.map((event) => {
			const e = { ...event, entryId: event.entryId?.padEnd(64, "0") ?? null };
			return { ...e, id: eventId(e, 2) };
		}),
	};
	const text = JSON.stringify(legacy);
	const sha256 = opaqueId(text);
	const manifest = {
		...snapshot.manifest,
		version: 2,
		shards: [{ month: shard.month, file: `${shard.month}-${sha256}.json`, sha256, bytes: Buffer.byteLength(text) }],
	};
	const doc = {
		version: 2,
		importedAt: ms,
		machines: { [identity.machineId]: { manifest, shards: [legacy] } },
		problems: [],
	};
	const path = join(root, "pi-session-kit", "stats-global.json");
	mkdirSync(join(root, "pi-session-kit"));
	writeFileSync(path, JSON.stringify(doc));
	expect((await readGlobal(root)).problems).toEqual([]);
	const session = legacy.sessions[0];
	if (!session) throw new Error("Missing session");
	session.endMs++;
	writeFileSync(path, JSON.stringify(doc));
	expect((await readGlobal(root)).problems).toEqual(["Unreadable global cache"]);
});
