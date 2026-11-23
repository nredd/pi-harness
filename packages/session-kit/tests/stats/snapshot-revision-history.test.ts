import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
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
/** Revise the identified October call's counters and export again. */
async function revise(): Promise<void> {
	sessionFile(mainPath(), { startMs: at("2026-10-05"), lines: [line("call", at("2026-10-05"), 11)] });
	await exportStats(agent, out);
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
	// Rebuild the usage cache so the archived call exists only in published history.
	rmSync(join(agent, "pi-session-kit", "stats-cache.json"));
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
	rmSync(join(agent, "pi-session-kit", "stats-cache.json"));
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
	await exportStats(agent, out);
	expect(manifest(snapshotDir).shards.filter((ref) => ref.month === "2026-09")).toHaveLength(1);
	const combined = await viewed();
	expect(combined.calls.map((call) => call.ms)).toEqual([at("2026-10-15")]);
	expect(combined.quota).toEqual([quotaRow("fixture", at("2026-09-20"))]);
});

it("compacts what a regenerated month carries within the sealed shard limit", async () => {
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
