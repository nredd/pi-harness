import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isExpired, mergeQuota, type QuotaObservation } from "../../src/stats/harness/common.ts";
import { type Harness, opaqueId } from "../../src/stats/load.ts";
import {
	eventId,
	exportStats,
	importStats,
	loadCombined,
	type Manifest,
	machineIdentity,
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
	account: "",
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
	const NOW = at("2026-10-05");
	const live = (extra: Partial<QuotaObservation> = {}) => quota({ resetAt: NOW + 1000, ...extra });

	it("keeps the freshest reading per (provider, limitId, window), never summing", () => {
		const old = live({ usedPercent: 10, observedAt: 1 });
		const fresh = live({ usedPercent: 90, observedAt: 2, harness: "claude" });
		const other = live({ window: "5h" });
		expect(mergeQuota([fresh, old, other], NOW)).toEqual([fresh, other]);
		expect(mergeQuota([old, fresh], NOW)).toEqual([fresh]);
		expect(mergeQuota([], NOW)).toEqual([]);
	});

	it("breaks observedAt ties independent of input order", () => {
		const a = live({ harness: "claude", usedPercent: 1 });
		const b = live({ harness: "codex", usedPercent: 2 });
		expect(mergeQuota([a, b], NOW)).toEqual(mergeQuota([b, a], NOW));
		expect(mergeQuota([a, b, a], NOW)).toHaveLength(1);
	});

	it("does not merge two accounts, and merges an account with itself", () => {
		const one = live({ account: opaqueId("one"), usedPercent: 10, observedAt: 1 });
		const two = live({ account: opaqueId("two"), usedPercent: 80, observedAt: 2 });
		const anon = live({ usedPercent: 5, observedAt: 3 });
		const merged = mergeQuota([one, two, anon], NOW);
		expect(merged).toHaveLength(3);
		expect(mergeQuota([one, { ...one, usedPercent: 20, observedAt: 9 }], NOW).map((q) => q.usedPercent)).toEqual([20]);
	});

	it("treats a window that has reset as expired: a live reading wins however old, expired stays if alone", () => {
		const liveOld = live({ usedPercent: 40, observedAt: 1 });
		const expiredNew = quota({ usedPercent: 99, observedAt: 50, resetAt: NOW });
		expect(isExpired(expiredNew, NOW)).toBe(true);
		expect(isExpired(liveOld, NOW)).toBe(false);
		expect(mergeQuota([expiredNew, liveOld], NOW)).toEqual([liveOld]);
		expect(mergeQuota([liveOld, expiredNew], NOW)).toEqual([liveOld]);
		// nothing live: the freshest expired reading stays, for the viewer to show as reset
		expect(mergeQuota([expiredNew, { ...expiredNew, observedAt: 2 }], NOW)).toEqual([expiredNew]);
		// the same readings are live earlier
		expect(mergeQuota([expiredNew, liveOld], NOW - 10_000)).toEqual([expiredNew]);
	});

	it("is applied across imported machines, with the observer kept", async () => {
		const later = OCT + 60_000;
		publish(OLD_MACHINE, 2, [], [quota({ usedPercent: 10, observedAt: OCT })]);
		publish(NEW_MACHINE, 2, [], [quota({ usedPercent: 70, observedAt: later, harness: "claude" })]);
		await importStats(viewer, repo);
		const combined = await loadCombined(viewer, undefined, OCT);
		expect(combined.quota).toEqual([quota({ usedPercent: 70, observedAt: later, harness: "claude" })]);
	});

	it("keeps two accounts' imported readings apart", async () => {
		const [a, b] = [opaqueId("a"), opaqueId("b")];
		publish(OLD_MACHINE, 2, [], [quota({ usedPercent: 10, account: a })]);
		publish(NEW_MACHINE, 2, [], [quota({ usedPercent: 70, account: b, observedAt: OCT + 1 })]);
		await importStats(viewer, repo);
		const combined = await loadCombined(viewer, undefined, OCT);
		expect(combined.quota.map((q) => q.account).sort()).toEqual([a, b].sort());
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
		// the pi row seen by both exporters collapses; the codex row is not shown until `/stats` labels harnesses
		expect(calls.map((c) => [c.harness, c.entryId === opaqueId("shared"), c.input]).sort()).toEqual([
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
		expect(calls).toEqual([]);
		// the data is there, just not shown yet
		const events = Object.values((await readGlobal(viewer)).machines).flatMap((m) =>
			m.shards.flatMap((shard) => shard.events),
		);
		expect(events.map((e) => [e.harness, e.cost])).toEqual([["claude", null]]);
	});

	it("shows only pi usage and sessions from remote machines until harness display lands", async () => {
		publish(OLD_MACHINE, 2, [event("pi", "p", { cost: 1 }), event("claude", "c"), event("opencode", "o", { cost: 3 })]);
		await importStats(viewer, repo);
		const combined = await loadCombined(viewer);
		expect(combined.calls.map((c) => [c.harness, c.cost])).toEqual([["pi", 1]]);
		expect(combined.sessions).toHaveLength(1);
		expect(combined.calls.reduce((n, c) => n + (c.cost ?? 0), 0)).toBe(1);
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
				account: expect.stringMatching(/^[a-f0-9]{64}$/),
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
		// only pi is shown for now; the other three are in the imported snapshot, labelled
		const combined = await loadCombined(viewer);
		expect(combined.calls.map((c) => c.harness)).toEqual(["pi"]);
		const imported = Object.values((await readGlobal(viewer)).machines).flatMap((m) =>
			m.shards.flatMap((shard) => shard.events),
		);
		expect(imported.map((e) => e.harness).sort()).toEqual(["claude", "codex", "opencode", "pi"]);
		expect(new Set(imported.map((e) => e.sessionId)).size).toBe(4);
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

	it("reports an unreadable OpenCode database as failed; with nothing published before there is nothing to carry", async () => {
		const roots = seedHarnessHome(home);
		const loadSqlite = () => Promise.reject(new Error("no sqlite"));
		const result = await exportStats(agent, repo, undefined, { harnesses: ["opencode"], roots, home, loadSqlite });
		expect(result.harnesses?.opencode).toMatchObject({ found: true, failed: "kept" });
		expect(result.harnesses?.opencode?.problems[0]).toContain("opencode: database unreadable");
		expect(published(result.snapshotDir)).toEqual([]);
	});

	it("reports unreadable harness files as failed, and keeps the readable history of the others", async () => {
		const roots = seedHarnessHome(home);
		const { chmodSync } = await import("node:fs");
		const path = join(roots.claude, "projects", `-Users-${CANARY}-work`, "sess-A.jsonl");
		chmodSync(path, 0o000);
		try {
			const result = await exportStats(agent, repo, undefined, { harnesses: ["claude", "codex"], roots, home });
			if (process.getuid?.() === 0) expect(result.harnesses?.claude?.failed).toBeUndefined();
			else
				expect(result.harnesses?.claude).toEqual({
					found: true,
					problems: ["claude: 1 unreadable files"],
					failed: "kept",
				});
			expect(published(result.snapshotDir).flatMap((sh) => sh.events.map((e) => e.harness))).toContain("codex");
		} finally {
			chmodSync(path, 0o600);
		}
	});

	describe("harness set", () => {
		const all: Harness[] = ["pi", "claude", "codex", "opencode"];
		const statePath = () => join(agent, "pi-session-kit", "export-state.json");

		it("persists the published set and a private salt in installation state", async () => {
			seedPi();
			const roots = seedHarnessHome(home);
			await exportStats(agent, repo, undefined, { harnesses: ["pi", "codex"], roots, home });
			const state = JSON.parse(readFileSync(statePath(), "utf8"));
			expect(state).toEqual({ version: 1, salt: expect.stringMatching(/^[a-f0-9]{32}$/), harnesses: ["pi", "codex"] });
			// the salt never reaches the published snapshot
			const out = Object.values(files(repo))
				.map(([bytes]) => bytes)
				.join("\n");
			expect(out).not.toContain(state.salt);
			// and survives later exports
			await exportStats(agent, repo, undefined, { harnesses: ["pi", "codex"], roots, home });
			expect(JSON.parse(readFileSync(statePath(), "utf8")).salt).toBe(state.salt);
		});

		it("refuses a narrower set than last published unless replacing is explicit", async () => {
			seedPi();
			const roots = seedHarnessHome(home);
			const first = await exportStats(agent, repo, undefined, { harnesses: all, roots, home });
			const manifest = readFileSync(join(first.snapshotDir, "manifest.json"), "utf8");
			for (const harnesses of [
				undefined,
				["pi"],
				["pi", "claude", "codex"],
				["claude", "codex", "opencode"],
			] as const) {
				await expect(exportStats(agent, repo, undefined, { harnesses, roots, home })).rejects.toThrow(
					/narrower harness set.*--replace-harnesses/,
				);
			}
			// refused before anything is read or written
			expect(readFileSync(join(first.snapshotDir, "manifest.json"), "utf8")).toBe(manifest);
			expect(JSON.parse(readFileSync(statePath(), "utf8")).harnesses).toEqual(all);

			// widening or repeating is fine, and so is an explicit narrowing
			await exportStats(agent, repo, undefined, { harnesses: all, roots, home });
			const narrowed = await exportStats(agent, repo, undefined, {
				harnesses: ["pi", "claude"],
				replaceHarnesses: true,
				roots,
				home,
			});
			expect(
				published(narrowed.snapshotDir)
					.flatMap((sh) => sh.events.map((e) => e.harness))
					.sort(),
			).toEqual(["claude", "pi"]);
			expect(JSON.parse(readFileSync(statePath(), "utf8")).harnesses).toEqual(["pi", "claude"]);
			await expect(exportStats(agent, repo, undefined, { roots, home })).rejects.toThrow(/missing: claude/);
		});

		it("treats a manifest with no recorded set as a pi-only export, and an empty output as nothing published", async () => {
			seedPi();
			const roots = seedHarnessHome(home);
			// no state, nothing published: any set is fine, including one without pi
			await exportStats(agent, join(dir, "elsewhere"), undefined, { harnesses: ["codex"], roots, home });
			expect(JSON.parse(readFileSync(statePath(), "utf8")).harnesses).toEqual(["codex"]);
			// state without a recorded set (as created before any export finished) and a pi-era manifest
			const salt = JSON.parse(readFileSync(statePath(), "utf8")).salt;
			writeFileSync(statePath(), JSON.stringify({ version: 1, salt, harnesses: null }));
			await exportStats(agent, repo, undefined, { harnesses: ["pi"], roots, home });
			writeFileSync(statePath(), JSON.stringify({ version: 1, salt, harnesses: null }));
			await expect(exportStats(agent, repo, undefined, { harnesses: ["claude"], roots, home })).rejects.toThrow(
				/missing: pi/,
			);
		});

		it("rejects corrupt installation state", async () => {
			seedPi();
			await exportStats(agent, repo, undefined, { harnesses: ["pi"], home });
			const salt = "a".repeat(32);
			for (const bad of [
				"{",
				JSON.stringify({ version: 1, salt: "x", harnesses: ["pi"] }),
				JSON.stringify({ version: 2, salt, harnesses: ["pi"] }),
				JSON.stringify({ version: 1, salt, harnesses: "pi" }),
				JSON.stringify({ version: 1, salt, harnesses: ["pi", "pi"] }),
				JSON.stringify({ version: 1, salt, harnesses: ["vim"] }),
				JSON.stringify({ version: 1, salt, harnesses: ["pi"], extra: 1 }),
			]) {
				writeFileSync(statePath(), bad);
				await expect(exportStats(agent, repo, undefined, { home })).rejects.toThrow();
			}
		});

		it("does not record a set when the export fails", async () => {
			seedPi();
			const roots = seedHarnessHome(home);
			await exportStats(agent, repo, undefined, { harnesses: ["pi"], roots, home });
			writeFileSync(join(agent, "sessions", "p", "bad.jsonl"), "{broken\n");
			await expect(exportStats(agent, repo, undefined, { harnesses: all, roots, home })).rejects.toThrow(
				"Incomplete local scan",
			);
			expect(JSON.parse(readFileSync(statePath(), "utf8")).harnesses).toEqual(["pi"]);
		});
	});

	describe("a failing harness", () => {
		const busy = Object.assign(new Error("database is locked"), { errcode: 5 });
		const busyDb = () => Promise.reject(busy);

		it("keeps what it last published and reports the failure, without aborting the pi export", async () => {
			seedPi();
			const roots = seedHarnessHome(home);
			const harnesses: Harness[] = ["pi", "claude", "codex", "opencode"];
			const first = await exportStats(agent, repo, undefined, { harnesses, roots, home });
			const kinds = (dir: string) =>
				published(dir)
					.flatMap((sh) => sh.events.map((e) => `${e.harness}:${e.entryId}`))
					.sort();
			const before = kinds(first.snapshotDir);
			expect(before).toHaveLength(4);
			const quotaBefore = published(first.snapshotDir).flatMap((sh) => sh.quota ?? []);

			// a new pi call must still be published while opencode is busy
			sessionFile(join(agent, "sessions", "p", "s2.jsonl"), {
				startMs: OCT,
				lines: [assistantLine({ ms: OCT + 1000, provider: "pi-provider", model: "pi-model", input: 6 })],
			});
			const second = await exportStats(agent, repo, undefined, { harnesses, roots, home, loadSqlite: busyDb });
			expect(second.harnesses?.opencode).toEqual({
				found: true,
				problems: ["opencode: database busy, skipped"],
				failed: "kept",
			});
			expect(second.harnesses?.claude).toEqual({ found: true, problems: [] });
			const after = kinds(second.snapshotDir);
			expect(after.filter((k) => !k.startsWith("pi:"))).toEqual(before.filter((k) => !k.startsWith("pi:")));
			expect(after.filter((k) => k.startsWith("pi:"))).toHaveLength(2);
			const carried = published(second.snapshotDir)
				.flatMap((sh) => sh.events)
				.find((e) => e.harness === "opencode");
			expect(carried).toMatchObject({ provider: "anthropic", cost: 0.25, output: 25 });
			expect(published(second.snapshotDir).flatMap((sh) => sh.quota ?? [])).toEqual(quotaBefore);
			// every carried event still has its session metadata (a snapshot without it fails validation)
			const sessions = new Set(published(second.snapshotDir).flatMap((sh) => sh.sessions.map((x) => x.id)));
			expect(carried && sessions.has(carried.sessionId)).toBe(true);
			// the set is still recorded, and a recovered harness replaces the carried copy
			expect(JSON.parse(readFileSync(join(agent, "pi-session-kit", "export-state.json"), "utf8")).harnesses).toEqual(
				harnesses,
			);
			const third = await exportStats(agent, repo, undefined, { harnesses, roots, home });
			expect(third.harnesses?.opencode).toEqual({ found: true, problems: [] });
		});

		it("carries a cache-write failure's previous contents too, and publishes nothing for a harness never published", async () => {
			seedPi();
			const roots = seedHarnessHome(home);
			const first = await exportStats(agent, repo, undefined, { harnesses: ["pi", "opencode"], roots, home });
			const second = await exportStats(agent, repo, undefined, {
				harnesses: ["pi", "opencode"],
				roots,
				home,
				loadSqlite: busyDb,
			});
			expect(
				published(second.snapshotDir)
					.flatMap((sh) => sh.events.map((e) => e.harness))
					.sort(),
			).toEqual(
				published(first.snapshotDir)
					.flatMap((sh) => sh.events.map((e) => e.harness))
					.sort(),
			);
			// a machine whose first opted-in export fails has nothing to carry
			const fresh = join(dir, "fresh-agent");
			sessionFile(join(fresh, "sessions", "p", "s.jsonl"), {
				startMs: OCT,
				lines: [assistantLine({ ms: OCT, provider: "p", model: "m", input: 1 })],
			});
			const result = await exportStats(fresh, join(dir, "fresh-repo"), undefined, {
				harnesses: ["pi", "opencode"],
				roots,
				home,
				loadSqlite: busyDb,
			});
			expect(result.harnesses?.opencode?.failed).toBe("kept");
			expect(published(result.snapshotDir).flatMap((sh) => sh.events.map((e) => e.harness))).toEqual(["pi"]);
		});

		it("reads a pi-era (v1) previous snapshot as holding no other harness", async () => {
			seedPi();
			const roots = seedHarnessHome(home);
			publish((await machineIdentity(agent)).machineId, 1, [v1Event("legacy")]);
			const result = await exportStats(agent, repo, undefined, {
				harnesses: ["pi", "opencode"],
				roots,
				home,
				loadSqlite: busyDb,
			});
			expect(result.harnesses?.opencode?.failed).toBe("kept");
			expect(published(result.snapshotDir).flatMap((sh) => sh.events.map((e) => e.harness))).toEqual(["pi"]);
		});

		it("carries an event that has no entry identity", async () => {
			seedPi();
			const roots = seedHarnessHome(home);
			publish((await machineIdentity(agent)).machineId, 2, [event("opencode", null)]);
			const result = await exportStats(agent, repo, undefined, {
				harnesses: ["pi", "opencode"],
				roots,
				home,
				loadSqlite: busyDb,
			});
			const carried = published(result.snapshotDir).flatMap((sh) => sh.events.filter((e) => e.harness === "opencode"));
			expect(carried).toHaveLength(1);
			expect(carried[0]?.entryId).toBeNull();
		});

		it("ignores an unreadable previous snapshot", async () => {
			seedPi();
			const roots = seedHarnessHome(home);
			const first = await exportStats(agent, repo, undefined, { harnesses: ["pi", "opencode"], roots, home });
			const manifest = JSON.parse(readFileSync(join(first.snapshotDir, "manifest.json"), "utf8")) as Manifest;
			for (const ref of manifest.shards) writeFileSync(join(first.snapshotDir, ref.file), "tampered");
			const second = await exportStats(agent, repo, undefined, {
				harnesses: ["pi", "opencode"],
				roots,
				home,
				loadSqlite: busyDb,
			});
			// the previous snapshot cannot be read: say so rather than claim it was kept
			expect(second.harnesses?.opencode).toMatchObject({ failed: "lost" });
			expect(second.harnesses?.opencode?.problems).toContain("opencode: last published contents unreadable");
			expect(published(second.snapshotDir).flatMap((sh) => sh.events.map((e) => e.harness))).toEqual(["pi"]);
		});
	});
});
