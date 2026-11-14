import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeQuota, type QuotaObservation } from "../../src/stats/harness/common.ts";
import { type Harness, opaqueId } from "../../src/stats/load.ts";
import {
	eventId,
	exportStats,
	importStats,
	loadCombined,
	type Manifest,
	makeSnapshot,
	readGlobal,
	type Shard,
	type SnapshotEvent,
	validateManifest,
	validateShard,
	validateSnapshot,
} from "../../src/stats/snapshot.ts";
import { assistantLine, at, call, sessionFile } from "./fixtures.ts";
import { CANARY } from "./harness/fixtures.ts";
import { CODEX_RESET_S, seedHarnessHome } from "./harness/home.ts";

const OLD_MACHINE = "11111111-1111-4111-8111-111111111111";
const NEW_MACHINE = "22222222-2222-4222-8222-222222222222";
const OCT = at("2026-10-01");

let dir: string;
let repo: string;
let agent: string;
let viewer: string;
let home: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "stats-harness-export-"));
	repo = join(dir, "repo");
	agent = join(dir, "agent");
	viewer = join(dir, "viewer");
	home = join(dir, "home");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const quota = (extra: Partial<QuotaObservation> = {}): QuotaObservation => ({
	harness: "codex",
	provider: "openai-codex",
	limitId: "codex",
	window: "7d",
	usedPercent: 10,
	resetAt: at("2026-10-08"),
	durationMs: 604_800_000,
	observedAt: OCT,
	planType: "pro",
	...extra,
});

/** A v2 event for `harness`, with its real fingerprint. */
function event(harness: Harness, entry: string | null, extra: Partial<SnapshotEvent> = {}): SnapshotEvent {
	const e = {
		harness,
		entryId: entry === null ? null : opaqueId(entry),
		sessionId: opaqueId("s"),
		ms: OCT,
		provider: "p",
		model: "m",
		input: 10,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		cost: null,
		...extra,
	};
	return { id: eventId(e), ...e };
}

/** A manifest plus one October shard, published for `version` (1 or 2) under `repo`. */
function publish(machineId: string, version: 1 | 2, events: SnapshotEvent[], q: QuotaObservation[] = []): Manifest {
	const sessions = [{ id: opaqueId("s"), startMs: OCT, endMs: OCT, child: false }];
	const shard: Record<string, unknown> = { version, machineId, month: "2026-10", events, sessions };
	if (version === 2) shard.quota = q;
	const text = JSON.stringify(shard);
	const sha256 = opaqueId(text);
	const file = `2026-10-${sha256}.json`;
	const base = join(repo, "machines", machineId);
	mkdirSync(base, { recursive: true });
	writeFileSync(join(base, file), text);
	const manifest: Manifest = {
		version,
		machineId,
		label: "fixture",
		exportedAt: OCT,
		shards: [{ month: "2026-10", file, sha256, bytes: Buffer.byteLength(text) }],
	};
	writeFileSync(join(base, "manifest.json"), JSON.stringify(manifest));
	return manifest;
}

/** What a v1 exporter wrote: no `harness`, numeric cost, the original fingerprint. */
function v1Event(entry: string | null, extra: Partial<SnapshotEvent> = {}): SnapshotEvent {
	const { harness: _harness, id: _id, ...bare } = event("pi", entry, { cost: 0, ...extra });
	return { id: eventId(bare, 1), ...bare };
}

describe("event fingerprint", () => {
	it("includes the harness in v2, so equal rows from two tools never collide", () => {
		for (const entry of [opaqueId("e"), null]) {
			const base = event("pi", entry === null ? null : "e");
			expect(eventId({ ...base, harness: "codex" })).not.toBe(eventId(base));
			// v1 had no harness: its formula is unchanged, and ignores the field
			expect(eventId(base, 1)).toBe(eventId({ ...base, harness: "codex" }, 1));
			expect(eventId(base, 1)).not.toBe(eventId(base, 2));
		}
		const { harness: _h, ...bare } = event("pi", "e");
		expect(eventId(bare)).toBe(eventId({ ...bare, harness: "pi" }));
	});
});

describe("snapshot v2 schema", () => {
	const manifest2: Manifest = { version: 2, machineId: NEW_MACHINE, label: "m", exportedAt: OCT, shards: [] };
	const manifest1: Manifest = { ...manifest2, version: 1 };
	const shard = (events: SnapshotEvent[], q: QuotaObservation[] = []): Shard => ({
		version: 2,
		machineId: NEW_MACHINE,
		month: "2026-10",
		events,
		sessions: [{ id: opaqueId("s"), startMs: OCT, endMs: OCT, child: false }],
		quota: q,
	});

	it("accepts null cost, every harness and quota readings", () => {
		const ok = shard(
			[event("claude", "a"), event("codex", "b"), event("opencode", "c", { cost: 0.5 })],
			[quota(), quota({ window: "5h", limitId: "other", planType: null })],
		);
		expect(validateShard(ok, manifest2, "2026-10")).toBe(ok);
		expect(() => validateManifest(manifest2)).not.toThrow();
		expect(() => validateManifest({ ...manifest2, version: 3 })).toThrow();
	});

	it("rejects bad v2 events and quota", () => {
		const good = event("claude", "a");
		const bad: unknown[] = [
			{ ...shard([good]), quota: undefined },
			{ ...shard([good]), quota: "" },
			{ ...shard([good]), quota: null },
			{ ...shard([good]), quota: {} },
			{ ...shard([{ ...good, harness: "gemini" as Harness }]) },
			{ ...shard([{ ...good, harness: undefined }]) },
			{ ...shard([{ ...good, cost: -1 }]) },
			{ ...shard([{ ...good, cost: "0" as unknown as number }]) },
			{ ...shard([good], [{ ...quota(), harness: "nope" as Harness }]) },
			{ ...shard([good], [{ ...quota(), provider: "" }]) },
			{ ...shard([good], [{ ...quota(), usedPercent: Number.NaN }]) },
			{ ...shard([good], [{ ...quota(), usedPercent: -1 }]) },
			{ ...shard([good], [{ ...quota(), resetAt: 0 }]) },
			{ ...shard([good], [{ ...quota(), durationMs: 0 }]) },
			{ ...shard([good], [{ ...quota(), observedAt: at("2026-08-01") }]) },
			{ ...shard([good], [{ ...quota(), planType: 5 as unknown as string }]) },
			{ ...shard([good], [{ ...quota(), account: CANARY } as QuotaObservation]) },
			{ ...shard([good]), version: 1 },
		];
		for (const s of bad) expect(() => validateShard(s, manifest2, "2026-10")).toThrow();
	});

	it("keeps v1 shards exact: no harness, no quota, no null cost", () => {
		const v1 = { ...shard([v1Event("a")]), version: 1, quota: undefined };
		delete v1.quota;
		expect(validateShard(v1, manifest1, "2026-10")).toBe(v1);
		for (const bad of [
			{ ...v1, quota: [] },
			{ ...v1, events: [{ ...v1Event("a"), harness: "pi" }] },
			{ ...v1, events: [{ ...v1Event("a"), cost: null }] },
			// a v1 event carrying a v2 fingerprint
			{ ...v1, events: [{ ...v1Event("a"), id: event("pi", "a").id }] },
			{ ...v1, version: 2 },
		])
			expect(() => validateShard(bad, manifest1, "2026-10")).toThrow();
	});

	it("rejects a snapshot that reports one quota window twice", () => {
		const a = shard([], [quota()]);
		const b = { ...shard([], [quota({ observedAt: at("2026-10-02") })]), sessions: [] };
		expect(() => validateSnapshot({ manifest: manifest2, shards: [a, b] })).toThrow("Duplicate quota window");
		expect(() => validateSnapshot({ manifest: manifest2, shards: [a] })).not.toThrow();
	});
});

describe("quota merge", () => {
	it("keeps the freshest reading per (provider, limitId, window), never summing", () => {
		const old = quota({ usedPercent: 10, observedAt: 1 });
		const fresh = quota({ usedPercent: 90, observedAt: 2, harness: "claude" });
		const other = quota({ window: "5h" });
		expect(mergeQuota([fresh, old, other])).toEqual([fresh, other]);
		expect(mergeQuota([old, fresh])).toEqual([fresh]);
		expect(mergeQuota([])).toEqual([]);
	});

	it("breaks observedAt ties independent of input order", () => {
		const a = quota({ harness: "claude", usedPercent: 1 });
		const b = quota({ harness: "codex", usedPercent: 2 });
		expect(mergeQuota([a, b])).toEqual(mergeQuota([b, a]));
		expect(mergeQuota([a, b, a])).toHaveLength(1);
	});

	it("is applied across imported machines, with the observer kept", async () => {
		publish(OLD_MACHINE, 2, [], [quota({ usedPercent: 10, observedAt: OCT })]);
		publish(NEW_MACHINE, 2, [], [quota({ usedPercent: 70, observedAt: OCT + 60_000, harness: "claude" })]);
		await importStats(viewer, repo);
		const combined = await loadCombined(viewer);
		expect(combined.quota).toEqual([quota({ usedPercent: 70, observedAt: OCT + 60_000, harness: "claude" })]);
	});

	it("is stored in the month the reading was observed", () => {
		const loaded = { calls: [], sessions: [], errors: 0, badLines: 0 };
		const snap = makeSnapshot(loaded, { machineId: NEW_MACHINE, label: "m" }, OCT, [
			quota({ observedAt: at("2026-11-02") }),
			quota({ window: "5h", observedAt: at("2026-10-02") }),
		]);
		expect(snap.shards.map((s) => [s.month, s.quota?.length])).toEqual([
			["2026-10", 1],
			["2026-11", 1],
		]);
	});
});

describe("mixed-version machines", () => {
	it("imports v1 and v2 machines together; v1 events are pi, copies count once", async () => {
		publish(OLD_MACHINE, 1, [v1Event("shared"), v1Event("old-only", { input: 3 })]);
		publish(NEW_MACHINE, 2, [event("pi", "shared", { cost: 0 }), event("codex", "shared", { input: 10 })]);
		expect(await importStats(viewer, repo)).toMatchObject({ imported: 2, problems: [] });
		const global = await readGlobal(viewer);
		expect(
			Object.values(global.machines)
				.map((m) => m.manifest.version)
				.sort(),
		).toEqual([1, 2]);
		expect(global.problems).toEqual([]);
		const { calls, coverage } = await loadCombined(viewer);
		expect(coverage.incomplete).toBe(false);
		// the pi row seen by both exporters collapses; the codex row with the same native id does not
		expect(calls.map((c) => [c.harness, c.entryId === opaqueId("shared"), c.input]).sort()).toEqual([
			["codex", true, 10],
			["pi", false, 3],
			["pi", true, 10],
		]);
	});

	it("re-exporting a machine as v2 replaces its v1 snapshot", async () => {
		publish(OLD_MACHINE, 1, [v1Event("a")]);
		await importStats(viewer, repo);
		publish(OLD_MACHINE, 2, [event("claude", "a")]);
		const manifest = JSON.parse(readFileSync(join(repo, "machines", OLD_MACHINE, "manifest.json"), "utf8"));
		writeFileSync(
			join(repo, "machines", OLD_MACHINE, "manifest.json"),
			JSON.stringify({ ...manifest, exportedAt: OCT + 1 }),
		);
		expect(await importStats(viewer, repo)).toMatchObject({ imported: 1, problems: [] });
		const { calls } = await loadCombined(viewer);
		expect(calls.map((c) => c.harness)).toEqual(["claude"]);
		expect(calls[0]?.cost).toBeNull();
	});

	it("keeps a v1 global cache readable and rewrites it as v2", async () => {
		publish(OLD_MACHINE, 1, [v1Event("a")]);
		await importStats(viewer, repo);
		const path = join(viewer, "pi-session-kit", "stats-global.json");
		const doc = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(path, JSON.stringify({ ...doc, version: 1 }));
		expect(Object.keys((await readGlobal(viewer)).machines)).toEqual([OLD_MACHINE]);
		await importStats(viewer, repo);
		expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(2);
	});

	it("sums null cost as zero in model totals", async () => {
		const { modelTotals } = await import("../../src/stats/aggregate.ts");
		const calls = [
			call("2026-10-01", "p", "m", 10, 0, { cost: null }),
			call("2026-10-01", "p", "m", 1, 0, { cost: 2 }),
		];
		expect(modelTotals(calls)[0]?.cost).toBe(2);
	});
});

/** Every file under `dir`, with bytes and mtime. */
function files(dir: string): Record<string, [string, number]> {
	const out: Record<string, [string, number]> = {};
	for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const path = join(entry.parentPath, entry.name);
		out[path] = [readFileSync(path, "utf8"), statSync(path).mtimeMs];
	}
	return out;
}

describe("exportStats with harnesses", () => {
	const seedPi = (): void =>
		sessionFile(join(agent, "sessions", "p", "s.jsonl"), {
			startMs: OCT,
			lines: [assistantLine({ ms: OCT, provider: "pi-provider", model: "pi-model", input: 5 })],
		});
	const env = (): Record<string, string> => ({});

	/** All published shard contents of one machine. */
	function published(snapshotDir: string): Shard[] {
		const manifest = JSON.parse(readFileSync(join(snapshotDir, "manifest.json"), "utf8")) as Manifest;
		return manifest.shards.map((s) => JSON.parse(readFileSync(join(snapshotDir, s.file), "utf8")) as Shard);
	}

	it("exports Claude, Codex and OpenCode alongside pi with null cost and Codex quota", async () => {
		seedPi();
		const roots = seedHarnessHome(home);
		const before = files(home);
		const result = await exportStats(agent, repo, undefined, {
			harnesses: ["pi", "claude", "codex", "opencode"],
			roots,
			env: env(),
			home,
		});
		expect(result.harnesses).toEqual({
			claude: { found: true, problems: [] },
			codex: { found: true, problems: [] },
			opencode: { found: true, problems: [] },
		});
		const shards = published(result.snapshotDir);
		const events = shards.flatMap((s) => s.events);
		expect(events.map((e) => [e.harness, e.provider, e.cost]).sort()).toEqual([
			["claude", "anthropic", null],
			["codex", "openai", null],
			["opencode", "anthropic", 0.25],
			["pi", "pi-provider", 0],
		]);
		const claude = events.find((e) => e.harness === "claude");
		expect(claude).toMatchObject({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });
		const codex = events.find((e) => e.harness === "codex");
		expect(codex).toMatchObject({ input: 200, output: 50, cacheRead: 800 });
		expect(shards.flatMap((s) => s.quota ?? [])).toEqual([
			expect.objectContaining({
				harness: "codex",
				provider: "openai-codex",
				window: "7d",
				usedPercent: 12.5,
				resetAt: CODEX_RESET_S * 1000,
			}),
		]);
		// counts only: no canary and no path from any source reaches the output
		const text = Object.values(files(repo))
			.map(([bytes]) => bytes)
			.join("\n");
		for (const secret of [CANARY, home, "projects", "rollout", "opencode.db", "ses_1", "msg_oc", "sess-A"])
			expect(text).not.toContain(secret);
		// sources are read-only: same bytes and mtimes
		expect(files(home)).toEqual(before);
		expect(Object.keys(before).some((p) => p.endsWith("auth.json"))).toBe(true);

		// and a second agent dir imports all of it
		expect(await importStats(viewer, repo)).toMatchObject({ imported: 1, problems: [] });
		const combined = await loadCombined(viewer);
		expect(combined.calls).toHaveLength(4);
		// one session per harness plus pi's; a child never marks its parent
		expect(new Set(combined.calls.map((c) => c.session)).size).toBe(4);
	});

	it("is pi only by default and never opens the other harnesses", async () => {
		seedPi();
		const roots = seedHarnessHome(home);
		const result = await exportStats(agent, repo, undefined, { roots, env: env(), home });
		expect(result.harnesses).toBeUndefined();
		expect(published(result.snapshotDir).flatMap((s) => s.events.map((e) => e.harness))).toEqual(["pi"]);
		expect(() => statSync(join(agent, "pi-session-kit", "stats-harness-cache.json"))).toThrow();
	});

	it("skips pi when it is not requested", async () => {
		seedPi();
		const roots = seedHarnessHome(home);
		const result = await exportStats(agent, repo, undefined, { harnesses: ["codex"], roots, env: env(), home });
		expect(result.harnesses).toEqual({ codex: { found: true, problems: [] } });
		expect(published(result.snapshotDir).flatMap((s) => s.events.map((e) => e.harness))).toEqual(["codex"]);
		expect(() => statSync(join(agent, "pi-session-kit", "stats-cache.json"))).toThrow();
	});

	it("lists a missing harness as not found, not an error", async () => {
		const result = await exportStats(agent, repo, undefined, {
			harnesses: ["claude"],
			roots: { claude: join(home, "none") },
			env: env(),
			home,
		});
		expect(result.harnesses).toEqual({ claude: { found: false, problems: [] } });
		expect(published(result.snapshotDir)).toEqual([]);
	});

	it("reports count-only diagnostics but publishes the rest", async () => {
		const roots = seedHarnessHome(home);
		writeFileSync(join(roots.claude, "projects", "bad.jsonl"), `{"type":"assistant"\n`);
		const result = await exportStats(agent, repo, undefined, { harnesses: ["claude", "codex"], roots, home });
		expect(result.harnesses?.claude?.problems).toEqual(["claude: ! 1 unreadable lines"]);
		expect(result.harnesses?.codex?.problems).toEqual([]);
	});

	it("fails closed when the harness cache cannot be written", async () => {
		const roots = seedHarnessHome(home);
		const blocker = join(agent, "pi-session-kit");
		mkdirSync(agent, { recursive: true });
		writeFileSync(blocker, "a file where the cache directory belongs");
		await expect(exportStats(agent, repo, undefined, { harnesses: ["claude"], roots, home })).rejects.toThrow();
		expect(() => statSync(join(repo, "machines"))).toThrow();
	});

	it("fails closed when the OpenCode database is unreadable or busy, which has no cache to fall back on", async () => {
		const roots = seedHarnessHome(home);
		const loadSqlite = () => Promise.reject(new Error("no sqlite"));
		await expect(
			exportStats(agent, repo, undefined, { harnesses: ["opencode"], roots, home, loadSqlite }),
		).rejects.toThrow("Incomplete opencode scan: opencode: database unreadable");
		expect(() => statSync(join(repo, "machines"))).toThrow();
	});

	it("fails closed on unreadable harness files, without publishing a manifest", async () => {
		const roots = seedHarnessHome(home);
		const { chmodSync } = await import("node:fs");
		const path = join(roots.claude, "projects", `-Users-${CANARY}-work`, "sess-A.jsonl");
		chmodSync(path, 0o000);
		try {
			const result = exportStats(agent, repo, undefined, { harnesses: ["claude"], roots, home });
			if (process.getuid?.() === 0) await result;
			else await expect(result).rejects.toThrow("Incomplete claude scan: claude: 1 unreadable files");
		} finally {
			chmodSync(path, 0o600);
		}
	});
});
