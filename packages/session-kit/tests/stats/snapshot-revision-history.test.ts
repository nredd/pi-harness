import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	decodeShard,
	encodeShard,
	exportStats,
	importStats,
	loadCombined,
	type Manifest,
	type Shard,
	type SnapshotQuota,
} from "../../src/stats/snapshot.ts";
import { assistantLine, at, sessionFile } from "../fixtures/stats/fixtures.ts";

let root: string;
let agent: string;
let out: string;
let viewer: string;
beforeEach(({ onTestFinished }) => {
	root = makeTestTempDir("stats-revision-history-", onTestFinished);
	agent = join(root, "agent");
	out = join(root, "out");
	viewer = join(root, "viewer");
	// October is sealed: every export below runs in November.
	vi.spyOn(Date, "now").mockReturnValue(at("2026-11-02"));
});
afterEach(() => {
	vi.restoreAllMocks();
});

const manifest = (dir: string): Manifest => JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;

/** An identified pi call: a fixed entry `id`, so changed counters or timestamps are a revision. */
function line(id: string, ms: number, input: number): string {
	const row = JSON.parse(assistantLine({ ms, provider: "physical", model: "fixture", input, output: 2 }));
	row.id = id;
	return JSON.stringify(row);
}

const quotaRow = (limitId: string, observedAt = at("2026-10-07")): SnapshotQuota => ({
	harness: "pi",
	provider: "physical",
	limitId,
	window: "daily",
	usedPercent: 40,
	resetAt: at("2026-12-01"),
	durationMs: 86_400_000,
	observedAt,
	planType: null,
	account: "",
});

/** Add authenticated sealed shards to the published manifest, as an earlier export would have. */
function plant(snapshotDir: string, rows: Partial<Shard>[]): void {
	const published = manifest(snapshotDir);
	for (const row of rows) {
		const month = row.month ?? "2026-10";
		const bytes = encodeShard({
			version: 3,
			machineId: published.machineId,
			month,
			events: [],
			sessions: [],
			quota: [],
			...row,
		});
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const file = `${month}-${sha256}.json.gz`;
		writeFileSync(join(snapshotDir, file), bytes);
		published.shards.push({ month, file, sha256, bytes: bytes.length });
	}
	writeFileSync(join(snapshotDir, "manifest.json"), JSON.stringify(published));
}

const mainPath = (): string => join(agent, "sessions", "main.jsonl");
/**
 * Drop the usage cache before re-exporting a rewritten transcript: it keys on size and mtime, and a
 * same-size rewrite on a coarse-timestamp filesystem would otherwise return the old scan.
 */
const dropUsageCache = (): void => rmSync(join(agent, "pi-session-kit", "stats-cache.json"), { force: true });
/** Revise the identified October call's counters and export again. */
async function revise(): Promise<void> {
	sessionFile(mainPath(), { startMs: at("2026-10-05"), lines: [line("call", at("2026-10-05"), 11)] });
	dropUsageCache();
	await exportStats(agent, out);
}
/** Every quota reading the published October shards hold, decoded from the raw files. */
function publishedQuota(snapshotDir: string): SnapshotQuota[] {
	const published = manifest(snapshotDir);
	return published.shards
		.filter((ref) => ref.month === "2026-10")
		.flatMap((ref) => decodeShard(readFileSync(join(snapshotDir, ref.file)), published, ref.month).quota ?? []);
}
async function viewed() {
	expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
	return loadCombined(viewer);
}

it("keeps a sealed quota reading when an identified revision regenerates its month", async () => {
	sessionFile(mainPath(), { startMs: at("2026-10-05"), lines: [line("call", at("2026-10-05"), 10)] });
	const { snapshotDir } = await exportStats(agent, out);
	plant(snapshotDir, [{ quota: [quotaRow("fixture")] }]);
	await revise();
	const combined = await viewed();
	expect(combined.calls.map((call) => call.input)).toEqual([11]);
	expect(combined.quota).toEqual([quotaRow("fixture")]);
});

it("keeps a call and session archived only in published history when a revision regenerates its month", async () => {
	sessionFile(mainPath(), { startMs: at("2026-10-05"), lines: [line("call", at("2026-10-05"), 10)] });
	const archived = join(agent, "sessions", "archived.jsonl");
	sessionFile(archived, { startMs: at("2026-10-09"), lines: [line("old", at("2026-10-09"), 500)] });
	await exportStats(agent, out);
	rmSync(archived);
	// `revise` rebuilds the usage cache, so the archived call exists only in published history.
	await revise();
	const combined = await viewed();
	expect(combined.calls.map((call) => call.input).sort((a, b) => a - b)).toEqual([11, 500]);
	expect(combined.sessions.map((session) => session.startMs).sort()).toEqual([at("2026-10-05"), at("2026-10-09")]);
});

it("keeps a sealed session end the scan no longer reaches when a revision regenerates its month", async () => {
	sessionFile(mainPath(), { startMs: at("2026-10-05"), lines: [line("call", at("2026-10-05"), 10)] });
	const truncated = join(agent, "sessions", "truncated.jsonl");
	const lines = [line("early", at("2026-10-09"), 20), line("late", at("2026-10-12"), 30)];
	sessionFile(truncated, { startMs: at("2026-10-09"), lines });
	await exportStats(agent, out);
	sessionFile(truncated, { startMs: at("2026-10-09"), lines: lines.slice(0, 1) });
	await revise();
	const combined = await viewed();
	expect(combined.calls.map((call) => call.input).sort((a, b) => a - b)).toEqual([11, 20, 30]);
	expect(combined.sessions.find((session) => session.startMs === at("2026-10-09"))?.endMs).toBe(at("2026-10-12"));
});

it("keeps a quota reading in a sealed month a cross-month revision empties", async () => {
	const path = mainPath();
	sessionFile(path, { startMs: at("2026-08-31"), lines: [line("call", at("2026-09-15"), 10)] });
	const { snapshotDir } = await exportStats(agent, out);
	plant(snapshotDir, [{ month: "2026-09", quota: [quotaRow("fixture", at("2026-09-20"))] }]);
	sessionFile(path, { startMs: at("2026-08-31"), lines: [line("call", at("2026-10-15"), 10)] });
	dropUsageCache();
	await exportStats(agent, out);
	expect(manifest(snapshotDir).shards.filter((ref) => ref.month === "2026-09")).toHaveLength(1);
	const combined = await viewed();
	expect(combined.calls.map((call) => call.ms)).toEqual([at("2026-10-15")]);
	expect(combined.quota).toEqual([quotaRow("fixture", at("2026-09-20"))]);
});

it("packs what a regenerated month carries within the sealed shard limit", async () => {
	sessionFile(mainPath(), { startMs: at("2026-10-05"), lines: [line("call", at("2026-10-05"), 10)] });
	const { snapshotDir } = await exportStats(agent, out);
	const readings = Array.from({ length: 32 }, (_, i) => quotaRow(`limit-${i}`));
	plant(
		snapshotDir,
		readings.map((q) => ({ quota: [q] })),
	);
	await revise();
	expect(manifest(snapshotDir).shards.filter((ref) => ref.month === "2026-10")).toHaveLength(2);
	const combined = await viewed();
	expect(combined.calls.map((call) => call.input)).toEqual([11]);
	expect(combined.quota).toHaveLength(32);
	expect(combined.quota).toEqual(expect.arrayContaining(readings));
});

it("keeps every same-window quota reading when a regenerated month packs past the shard limit", async () => {
	sessionFile(mainPath(), { startMs: at("2026-10-05"), lines: [line("call", at("2026-10-05"), 10)] });
	const archived = join(agent, "sessions", "archived.jsonl");
	sessionFile(archived, { startMs: at("2026-10-09"), lines: [line("old", at("2026-10-09"), 500)] });
	const { snapshotDir } = await exportStats(agent, out);
	// The old base also carries: its archived call is gone from the scan.
	rmSync(archived);
	const [baseRef] = manifest(snapshotDir).shards;
	const base = decodeShard(readFileSync(join(snapshotDir, baseRef?.file ?? "")), manifest(snapshotDir), "2026-10");
	const session = base.sessions.find((row) => row.startMs === at("2026-10-09"));
	if (!session) throw new Error("archived session missing from the published base");
	// Two later ends of the archived session, two readings of one window with one reset observed at
	// different times, and 27 other windows: 32 October shards with the base.
	const ends = [at("2026-10-10"), at("2026-10-11")];
	const shared = [quotaRow("shared", at("2026-10-07")), quotaRow("shared", at("2026-10-08"))];
	const readings = [...shared, ...Array.from({ length: 27 }, (_, i) => quotaRow(`limit-${i}`))];
	plant(snapshotDir, [
		...ends.map((endMs) => ({ sessions: [{ ...session, endMs }] })),
		...readings.map((q) => ({ quota: [q] })),
	]);
	expect(manifest(snapshotDir).shards.filter((ref) => ref.month === "2026-10")).toHaveLength(32);
	await revise();
	const refs = manifest(snapshotDir).shards.filter((ref) => ref.month === "2026-10");
	expect(refs.length).toBeLessThanOrEqual(32);
	const quota = publishedQuota(snapshotDir);
	expect(quota).toHaveLength(readings.length);
	expect(quota).toEqual(expect.arrayContaining(readings));
	const combined = await viewed();
	expect(combined.calls.map((call) => call.input).sort((a, b) => a - b)).toEqual([11, 500]);
	expect(combined.sessions.find((row) => row.startMs === at("2026-10-09"))?.endMs).toBe(at("2026-10-11"));
});

it("refuses to publish when a regenerated month cannot keep its history within the shard limit", async () => {
	sessionFile(mainPath(), { startMs: at("2026-10-05"), lines: [line("call", at("2026-10-05"), 10)] });
	const { snapshotDir } = await exportStats(agent, out);
	// 32 readings of one window need 32 delta shards beside the regenerated base: 33 in all.
	const readings = Array.from({ length: 32 }, (_, i) => quotaRow("shared", at("2026-10-07") + i * 60_000));
	plant(
		snapshotDir,
		readings.map((q) => ({ quota: [q] })),
	);
	const before = readFileSync(join(snapshotDir, "manifest.json"), "utf8");
	sessionFile(mainPath(), { startMs: at("2026-10-05"), lines: [line("call", at("2026-10-05"), 11)] });
	dropUsageCache();
	await expect(exportStats(agent, out)).rejects.toThrow(
		"Revised sealed month 2026-10 cannot keep its history within 32 shards",
	);
	expect(readFileSync(join(snapshotDir, "manifest.json"), "utf8")).toBe(before);
	for (const ref of manifest(snapshotDir).shards) expect(existsSync(join(snapshotDir, ref.file))).toBe(true);
	expect(publishedQuota(snapshotDir)).toEqual(expect.arrayContaining(readings));
});
