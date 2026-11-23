import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emptyScan, type QuotaObservation } from "../../src/stats/harness/common.ts";
import { type HarnessLoadOptions, loadHarnesses } from "../../src/stats/harness/index.ts";
import { decodeShard, exportStats, type Manifest, makeSnapshot } from "../../src/stats/snapshot.ts";
import { at } from "../fixtures/stats/fixtures.ts";

vi.mock("../../src/stats/harness/index.ts", async (original) => {
	const actual = await original<typeof import("../../src/stats/harness/index.ts")>();
	return { ...actual, loadHarnesses: vi.fn() };
});

const WALL = at("2026-11-02");
/** The published watermark the export must publish after: plausible, and in the same month. */
const AHEAD = WALL + 5 * 86_400_000;
const reading = (extra: Partial<QuotaObservation>): QuotaObservation => ({
	harness: "codex",
	provider: "openai-codex",
	limitId: "codex",
	window: "7d",
	usedPercent: 10,
	resetAt: WALL + 86_400_000,
	durationMs: 604_800_000,
	observedAt: WALL - 3_600_000,
	planType: null,
	account: "",
	...extra,
});
/** Live at the wall clock, expired at the publication instant. */
const live = reading({ usedPercent: 40 });
/** Newer, but its window reset before the wall clock: only the publication instant would prefer it. */
const reset = reading({ usedPercent: 99, observedAt: WALL - 60_000, resetAt: WALL - 120_000 });

let root: string;
beforeEach(({ onTestFinished }) => {
	root = makeTestTempDir("stats-quota-wall-", onTestFinished);
});
afterEach(() => vi.restoreAllMocks());

it("quota selection uses wall time, not the snapshot instant", () => {
	const identity = { machineId: "00000000-0000-4000-8000-000000000000", label: "fixture" };
	const loaded = { calls: [], sessions: [], errors: 0, badLines: 0, diagnostics: [] };
	const snapshot = makeSnapshot(loaded, identity, AHEAD, [reset, live], {}, WALL);
	expect(snapshot.shards.flatMap((shard) => shard.quota)).toEqual([live]);
	// Without a wall clock the snapshot instant stands in for it.
	expect(makeSnapshot(loaded, identity, AHEAD, [reset, live]).shards.flatMap((shard) => shard.quota)).toEqual([reset]);
});

it("quota selection uses wall time when the publication instant runs ahead of it", async () => {
	const agent = join(root, "agent");
	const out = join(root, "out");
	const clock = vi.spyOn(Date, "now");
	const seen: (number | undefined)[] = [];
	vi.mocked(loadHarnesses).mockImplementation(async (options: HarnessLoadOptions) => {
		seen.push(options.now);
		const codex = { ...emptyScan(true), quota: [reset, live] };
		return { claude: emptyScan(false), codex, opencode: emptyScan(false) };
	});
	const options = { harnesses: ["pi", "codex"] as const };
	// A clock that ran ahead publishes the watermark; this one is behind it.
	clock.mockReturnValue(AHEAD);
	const first = await exportStats(agent, out, undefined, options);
	clock.mockReturnValue(WALL);
	const result = await exportStats(agent, out, undefined, options);
	expect(result.warnings?.[0]).toMatch(/^clock is behind the last published export/);
	expect(seen).toEqual([AHEAD, WALL]);
	const manifest = JSON.parse(readFileSync(join(first.snapshotDir, "manifest.json"), "utf8")) as Manifest;
	expect(manifest.exportedAt).toBe(AHEAD + 1);
	const quota = manifest.shards.flatMap(
		(ref) => decodeShard(readFileSync(join(first.snapshotDir, ref.file)), manifest, ref.month).quota ?? [],
	);
	expect(quota).toEqual([live]);
});
