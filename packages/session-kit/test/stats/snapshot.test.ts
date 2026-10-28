import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cachePath, dedupCalls, flatten, loadUsage, opaqueId, parseSession } from "../../src/stats/load.ts";
import {
	atomicJson,
	coverageLabel,
	exportStats,
	importStats,
	loadCombined,
	machineIdentity,
	makeSnapshot,
	readGlobal,
	validateManifest,
	validateShard,
} from "../../src/stats/snapshot.ts";
import { assistantLine, at, call, sessionFile } from "./fixtures.ts";

let dir: string;
let repo: string;
let a: string;
let b: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "stats-snapshot-"));
	repo = join(dir, "repo");
	a = join(dir, "a");
	b = join(dir, "b");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const usage = (id: string, ms = at("2026-10-01"), input = 10): string => {
	const e = JSON.parse(assistantLine({ ms, provider: "enterprise-raw", model: "wire-model", input }));
	e.id = id;
	return JSON.stringify(e);
};
const seed = (agent: string, lines = [usage("entry-1")]): string => {
	const path = join(agent, "sessions", "SECRET-PROJECT", "SECRET-NAME.jsonl");
	sessionFile(path, { startMs: at("2026-09-30"), name: "SECRET-TITLE", lines });
	return path;
};

it("retains distinct entry IDs with identical usage; collapses copies and legacy counterparts", () => {
	const first = call("2026-10-01", "p", "m", 10, 0, { entryId: opaqueId("a") });
	const second = { ...first, entryId: opaqueId("b") };
	const legacy = { ...first, entryId: undefined };
	expect(dedupCalls([legacy, first, second, { ...first, session: "copy" }])).toHaveLength(2);
	expect(dedupCalls([legacy, { ...legacy, session: "copy" }])).toHaveLength(1);
	// List-price changes cannot turn a copied physical call into another event.
	expect(dedupCalls([first, { ...first, cost: 1 }])).toHaveLength(1);
	const snapshotId = (cost: number) =>
		makeSnapshot(
			{ calls: [{ ...first, cost }], sessions: [], errors: 0, badLines: 0 },
			{ machineId: "11111111-1111-4111-8111-111111111111", label: "fixture" },
		).shards[0]?.events[0]?.id;
	expect(snapshotId(0)).toBe(snapshotId(1));
});

it("v1 migration reparses available files for IDs, preserves unavailable deleted-file records", async () => {
	const path = seed(a, [usage("entry-1"), usage("entry-2")]);
	const loaded = await loadUsage({ root: join(a, "sessions"), cache: cachePath(a) });
	expect(loaded.calls).toHaveLength(2);
	const doc = JSON.parse(readFileSync(cachePath(a), "utf8"));
	doc.version = 1;
	for (const f of Object.values(doc.files) as Record<string, unknown>[]) {
		delete f.entryIds;
		delete f.sessionId;
		delete f.modelPairs;
	}
	const deleted = join(a, "sessions", "gone.jsonl");
	doc.files[deleted] = { ...doc.files[path], calls: [[at("2026-08-01"), 0, 99, 0, 0, 0, 0]] };
	writeFileSync(cachePath(a), JSON.stringify(doc));
	const result = await loadUsage({ root: join(a, "sessions"), cache: cachePath(a) });
	expect(result.calls.map((c) => c.input)).toEqual([99, 10, 10]);
	expect(result.calls.filter((c) => c.entryId)).toHaveLength(2);
	expect(JSON.parse(readFileSync(cachePath(a), "utf8")).files[deleted]).toEqual(doc.files[deleted]);
	rmSync(path);
	expect((await loadUsage({ root: join(a, "sessions"), cache: cachePath(a) })).calls).toHaveLength(3);
});

it("atomically enrolls one identity under concurrent first readers, and never replaces corrupt identities", async () => {
	const identities = await Promise.all(Array.from({ length: 16 }, () => machineIdentity(a)));
	expect(new Set(identities.map((i) => i.machineId)).size).toBe(1);
	expect(readdirSync(join(a, "pi-session-kit"))).toEqual(["machine.json"]);
	writeFileSync(join(a, "pi-session-kit", "machine.json"), "{broken");
	await expect(machineIdentity(a)).rejects.toThrow();
	expect(readFileSync(join(a, "pi-session-kit", "machine.json"), "utf8")).toBe("{broken");
	writeFileSync(join(a, "pi-session-kit", "machine.json"), JSON.stringify({ machineId: "not-a-uuid", label: "fixture" }));
	await expect(machineIdentity(a)).rejects.toThrow("Invalid installation identity");
	expect(readFileSync(join(a, "pi-session-kit", "machine.json"), "utf8")).toContain("not-a-uuid");
});

it("cleans temporary output when atomic publication cannot replace a directory", async () => {
	const target = join(dir, "publication");
	mkdirSync(target);
	await expect(atomicJson(target, { value: true })).rejects.toThrow();
	expect(readdirSync(dir)).toEqual(["publication"]);
});

it("exports only allowlisted metadata in monthly shards and persistent agent-local UUID", async () => {
	seed(a, [usage("entry-1", at("2026-09-30")), usage("entry-2", at("2026-10-01"))]);
	const result = await exportStats(a, repo);
	const identity = await machineIdentity(a);
	expect(result).toEqual({ machineId: identity.machineId, snapshotDir: join(repo, "machines", identity.machineId) });
	expect(readdirSync(repo)).toEqual(["machines"]);
	const text = readdirSync(result.snapshotDir)
		.map((f) => readFileSync(join(result.snapshotDir, f), "utf8"))
		.join("\n");
	for (const secret of ["SECRET", '"text":"hi"', a, "cwd", "content", "name", "arguments", "entry-1"])
		expect(text).not.toContain(secret);
	const manifest = JSON.parse(readFileSync(join(result.snapshotDir, "manifest.json"), "utf8"));
	expect(manifest.shards.map((s: { month: string }) => s.month)).toEqual(["2026-09", "2026-10"]);
	expect(await machineIdentity(a)).toEqual(identity);
	const second = await exportStats(a, join(dir, "other"));
	expect(second.machineId).toBe(identity.machineId);
});

it("copies/forks across machines count once, while fresh local calls and children remain included", async () => {
	const original = seed(a);
	const copied = seed(b);
	copyFileSync(original, copied);
	await exportStats(a, repo);
	await exportStats(b, repo);
	const viewer = join(dir, "viewer");
	seed(viewer, [usage("entry-2", at("2026-10-02"), 20)]);
	const childPath = join(viewer, "sessions", "child.jsonl");
	sessionFile(childPath, {
		startMs: at("2026-10-02"),
		parentSession: "secret-parent",
		name: "Explore#1234abcd",
		lines: [usage("entry-3", at("2026-10-02"), 30)],
	});
	expect((await importStats(viewer, repo)).problems).toEqual([]);
	const result = await loadCombined(viewer);
	expect(result.calls.map((c) => c.input)).toEqual([10, 20, 30]);
	expect(result.sessions).toHaveLength(2);
	expect(result.coverage.machines).toBe(3);
	seed(viewer, [usage("entry-2", at("2026-10-02"), 20), usage("fresh-local", at("2026-10-03"), 40)]);
	expect((await loadCombined(viewer)).calls.map((c) => c.input)).toEqual([10, 20, 30, 40]);
	expect(coverageLabel(result.coverage)).toContain("viewer last import");
	const own = await exportStats(viewer, repo);
	const ownManifest = JSON.parse(readFileSync(join(own.snapshotDir, "manifest.json"), "utf8"));
	const sessions = ownManifest.shards.flatMap(
		(s: { file: string }) => JSON.parse(readFileSync(join(own.snapshotDir, s.file), "utf8")).sessions,
	);
	expect(sessions.filter((s: { child: boolean }) => s.child)).toHaveLength(1);
	expect((await importStats(viewer, repo)).problems).toEqual([]);
	expect((await loadCombined(viewer)).calls).toHaveLength(4);
});

it("credits the oldest original across machines, not a fresh local fork that was scanned first", async () => {
	seed(a);
	const fork = join(b, "sessions", "fork.jsonl");
	sessionFile(fork, {
		startMs: at("2026-10-02"),
		parentSession: "secret-original",
		name: "my fork",
		lines: [usage("entry-1"), usage("fork-new", at("2026-10-02"), 20)],
	});
	await exportStats(a, repo);
	await importStats(b, repo);
	const result = await loadCombined(b);
	expect(result.calls.map((c) => c.input)).toEqual([10, 20]);
	expect(result.sessions).toHaveLength(2);
	expect(result.calls[0]?.session).not.toBe(result.calls[1]?.session);
});

it("preserves deleted history on repeated exports, independent of output checkout", async () => {
	const path = seed(a);
	await exportStats(a, repo);
	rmSync(path);
	const result = await exportStats(a, join(dir, "fresh-output"));
	await importStats(b, join(dir, "fresh-output"));
	expect((await loadCombined(b)).calls).toHaveLength(1);
	expect(readdirSync(result.snapshotDir).length).toBeGreaterThan(1);
});

it("rejects a machine transaction as a whole, retains prior data and still imports valid machines", async () => {
	seed(a);
	seed(b, [usage("other", at("2026-10-02"), 20)]);
	const exported = await exportStats(a, repo);
	const viewer = join(dir, "viewer");
	await importStats(viewer, repo);
	const prior = (await readGlobal(viewer)).machines[exported.machineId];
	await exportStats(b, repo);
	writeFileSync(join(exported.snapshotDir, "manifest.json"), "{broken");
	const result = await importStats(viewer, repo);
	expect(result.imported).toBe(1);
	expect(result.retained).toBe(1);
	expect(result.problems).toHaveLength(1);
	expect((await readGlobal(viewer)).machines[exported.machineId]).toEqual(prior);
	const combined = await loadCombined(viewer);
	expect(combined.calls.map((c) => c.input)).toEqual([10, 20]);
	expect(combined.coverage.incomplete).toBe(true);
	rmSync(join(repo, "machines"), { recursive: true });
	expect((await importStats(viewer, repo)).problems.length).toBeGreaterThan(0);
	expect((await loadCombined(viewer)).calls).toHaveLength(2);
});

it("validates schemas with strict keys, digest, counters, month, IDs and traversal", async () => {
	seed(a);
	const exported = await exportStats(a, repo);
	const manifest = JSON.parse(readFileSync(join(exported.snapshotDir, "manifest.json"), "utf8"));
	const ref = manifest.shards.find((s: { month: string }) => s.month === "2026-10");
	const shard = JSON.parse(readFileSync(join(exported.snapshotDir, ref.file), "utf8"));
	for (const malformed of [
		{ ...manifest, version: 99 },
		{ ...manifest, path: "secret" },
		{ ...manifest, machineId: "wrong" },
		{ ...manifest, shards: [{ ...ref, file: "../secret" }] },
		{ ...manifest, shards: [ref, ref] },
	])
		expect(() => validateManifest(malformed)).toThrow();
	const event = shard.events[0];
	for (const malformed of [
		{ ...shard, text: "secret" },
		{ ...shard, machineId: "wrong" },
		{ ...shard, events: [{ ...event, input: -1 }] },
		{ ...shard, events: [{ ...event, ms: at("2026-08-01") }] },
		{ ...shard, events: [{ ...event, entryId: "not-opaque" }] },
		{ ...shard, events: [{ ...event, cost: Infinity }] },
		{ ...shard, events: [{ ...event, args: "secret" }] },
		{ ...shard, events: [event, event] },
		{
			...shard,
			sessions: [{ ...shard.sessions[0], endMs: (shard.sessions[0]?.startMs ?? 2) - 1 }],
		},
	])
		expect(() => validateShard(malformed, manifest, ref.month)).toThrow();
	writeFileSync(join(exported.snapshotDir, ref.file), JSON.stringify({ ...shard, events: [] }));
	expect((await importStats(b, repo)).problems).toHaveLength(1);
	expect(Object.keys((await readGlobal(b)).machines)).toHaveLength(0);
});

it("reports malformed persisted global caches without trusting them", async () => {
	mkdirSync(join(a, "pi-session-kit"), { recursive: true });
	writeFileSync(join(a, "pi-session-kit", "stats-global.json"), JSON.stringify({ version: 1, importedAt: 0, machines: [], problems: [] }));
	expect((await readGlobal(a)).problems).toEqual(["Unreadable global cache"]);
	seed(a);
	const exported = await exportStats(a, repo);
	const viewer = join(dir, "viewer");
	await importStats(viewer, repo);
	const cache = join(viewer, "pi-session-kit", "stats-global.json");
	const document = JSON.parse(readFileSync(cache, "utf8"));
	document.machines[exported.machineId].shards = [];
	writeFileSync(cache, JSON.stringify(document));
	expect((await readGlobal(viewer)).problems).toEqual(["Unreadable global cache"]);
});

it("rejects incomplete local scans, invalid machine directories, and older exports", async () => {
	const malformed = join(a, "sessions", "bad.jsonl");
	mkdirSync(join(a, "sessions"), { recursive: true });
	writeFileSync(malformed, "{broken");
	await expect(exportStats(a, repo)).rejects.toThrow("Incomplete local scan");
	rmSync(malformed);
	rmSync(cachePath(a));
	const exported = await exportStats(a, repo);
	const viewer = join(dir, "viewer");
	await importStats(viewer, repo);
	mkdirSync(join(repo, "machines", "not-a-machine"));
	const invalid = await importStats(viewer, repo);
	expect(invalid.problems).toContain("Invalid machine directory");
	rmSync(join(repo, "machines", "not-a-machine"), { recursive: true });
	const manifestPath = join(exported.snapshotDir, "manifest.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	writeFileSync(manifestPath, JSON.stringify({ ...manifest, exportedAt: 1 }));
	expect((await importStats(viewer, repo)).problems).toContain(`Incomplete snapshot ${exported.machineId}`);
});

it("rejects unsupported snapshots and symlinks while retaining last-good", async () => {
	seed(a);
	const out = await exportStats(a, repo);
	await importStats(b, repo);
	const manifestPath = join(out.snapshotDir, "manifest.json");
	const m = JSON.parse(readFileSync(manifestPath, "utf8"));
	writeFileSync(manifestPath, JSON.stringify({ ...m, version: 999 }));
	expect((await importStats(b, repo)).problems).toHaveLength(1);
	rmSync(manifestPath);
	writeFileSync(join(dir, "linked.json"), JSON.stringify(m));
	symlinkSync(join(dir, "linked.json"), manifestPath);
	expect((await importStats(b, repo)).problems).toHaveLength(1);
	expect((await loadCombined(b)).calls).toHaveLength(1);
});

it("failed first import remains never-synced and failed subsequent import does not advance last sync", async () => {
	const viewer = join(dir, "viewer");
	const first = await importStats(viewer, repo);
	expect(first.problems.length).toBeGreaterThan(0);
	expect(first.importedAt).toBe(0);
	expect(coverageLabel((await loadCombined(viewer)).coverage)).toContain("viewer never imported");
	seed(a);
	const out = await exportStats(a, repo);
	const successful = await importStats(viewer, repo);
	expect(successful.importedAt).toBeGreaterThan(0);
	writeFileSync(join(out.snapshotDir, "manifest.json"), "{broken");
	const failed = await importStats(viewer, repo);
	expect(failed.importedAt).toBe(successful.importedAt);
	expect((await loadCombined(viewer)).calls).toHaveLength(1);
});

it("pure allowlist projection hashes fixture paths and keeps raw attribution", () => {
	const c = call("2026-10-01", "evil\u001b[2J", "m\nx", 10);
	const result = makeSnapshot(
		{ calls: [c], sessions: [{ path: c.session, startMs: c.ms, endMs: c.ms }], errors: 0, badLines: 0 },
		{ machineId: "12345678-1234-4234-8234-123456789abc", label: "machine" },
	);
	expect(JSON.stringify(result)).not.toContain('"/s"');
	expect(result.shards[0]?.events[0]?.provider).toBe(c.provider);
	const parsed = flatten({ "/secret": parseSession(usage("id")) });
	expect(parsed.calls[0]?.entryId).toMatch(/^[a-f0-9]{64}$/);
});

describe("actual portable bundled CLI", () => {
	function run(args: string[], env: NodeJS.ProcessEnv = {}, artifactDir = dir) {
		const artifact = join(artifactDir, "portable.mjs");
		copyFileSync(resolve("dist/pi-stats-export.mjs"), artifact);
		const clean = { ...process.env };
		delete clean.PI_CODING_AGENT_DIR;
		delete clean.PI_CODING_AGENT_SESSION_DIR;
		return spawnSync(process.execPath, [artifact, ...args], { cwd: dir, env: { ...clean, ...env }, encoding: "utf8" });
	}
	it("runs from a standalone artifact without kit, Pi or node_modules; stdout is one object", () => {
		seed(a);
		const exported = run(["export", "--agent-dir", a, "--output", repo]);
		expect(exported.status, exported.stderr).toBe(0);
		expect(exported.stderr).toBe("");
		expect(exported.stdout.trim().split("\n")).toHaveLength(1);
		const value = JSON.parse(exported.stdout);
		expect(value.machineId).toMatch(/^[a-f0-9-]{36}$/);
		expect(value.snapshotDir).toBe(join(repo, "machines", value.machineId));
		const imported = run(["import", "--agent-dir", b, "--input", repo]);
		expect(imported.status, imported.stderr).toBe(0);
		expect(JSON.parse(imported.stdout).imported).toBe(1);
		expect(readFileSync(join(b, "pi-session-kit", "stats-global.json"), "utf8")).toContain("wire-model");
	});
	it("runs from a path with URL-significant characters", () => {
		seed(a);
		const artifactDir = join(dir, "bundle#query?");
		mkdirSync(artifactDir);
		const exported = run(["export", "--agent-dir", a, "--output", repo], {}, artifactDir);
		expect(exported.status, exported.stderr).toBe(0);
		expect(JSON.parse(exported.stdout).snapshotDir).toContain("machines");
	});

	it("respects the sessions environment override and explicit option precedence", () => {
		seed(a, [usage("excluded", at("2026-10-01"), 99)]);
		const external = join(dir, "external");
		seed(external, [usage("included", at("2026-10-01"), 7)]);
		const result = run(["export", "--agent-dir", a, "--output", repo], {
			PI_CODING_AGENT_SESSION_DIR: join(external, "sessions"),
		});
		expect(result.status, result.stderr).toBe(0);
		let snapshot = JSON.parse(result.stdout).snapshotDir;
		let m = JSON.parse(readFileSync(join(snapshot, "manifest.json"), "utf8"));
		expect(
			m.shards
				.flatMap((s: { file: string }) => JSON.parse(readFileSync(join(snapshot, s.file), "utf8")).events)
				.map((e: { input: number }) => e.input),
		).toEqual([7]);
		const explicit = run(["export", "--agent-dir", a, "--output", repo, "--sessions-dir", join(a, "sessions")], {
			PI_CODING_AGENT_SESSION_DIR: join(external, "sessions"),
		});
		expect(explicit.status, explicit.stderr).toBe(0);
		snapshot = JSON.parse(explicit.stdout).snapshotDir;
		m = JSON.parse(readFileSync(join(snapshot, "manifest.json"), "utf8"));
		expect(
			m.shards
				.flatMap((s: { file: string }) => JSON.parse(readFileSync(join(snapshot, s.file), "utf8")).events)
				.map((e: { input: number }) => e.input),
		).toEqual([99, 7]);
	});
	it("returns nonzero on partial import, preserving valid old data with JSON stdout", () => {
		seed(a);
		const exportResult = JSON.parse(run(["export", "--agent-dir", a, "--output", repo]).stdout);
		expect(run(["import", "--agent-dir", b, "--input", repo]).status).toBe(0);
		writeFileSync(join(exportResult.snapshotDir, "manifest.json"), "{}");
		const failed = run(["import", "--agent-dir", b, "--input", repo]);
		expect(failed.status).toBe(1);
		expect(JSON.parse(failed.stdout).retained).toBe(1);
		expect(failed.stderr).toContain("Incomplete snapshot");
		const cached = JSON.parse(readFileSync(join(b, "pi-session-kit", "stats-global.json"), "utf8"));
		expect(Object.values(cached.machines)).toHaveLength(1);
	});
	it("fails malformed scans and arguments without publishing a manifest", () => {
		seed(a, ["{broken"]);
		const failed = run(["export", "--agent-dir", a, "--output", repo]);
		expect(failed.status).toBe(1);
		expect(failed.stdout).toBe("");
		expect(failed.stderr).toContain("Incomplete local scan");
		expect(run(["export", "--output", repo, "--output", repo]).status).toBe(1);
		expect(run(["unknown"]).status).toBe(1);
	});
	it("build is byte reproducible and contains only Node builtin imports", () => {
		const before = readFileSync(resolve("dist/pi-stats-export.mjs"), "utf8");
		const result = spawnSync("npm", ["run", "build:stats-export"], { cwd: resolve("."), encoding: "utf8" });
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(resolve("dist/pi-stats-export.mjs"), "utf8")).toBe(before);
		expect(before).not.toContain("@earendil");
		expect(before).not.toContain("node_modules");
	});
});
