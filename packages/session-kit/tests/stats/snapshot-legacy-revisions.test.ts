import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encodeShard, exportStats, importStats, loadCombined, type Manifest } from "../../src/stats/snapshot.ts";
import { assistantLine, at, sessionFile } from "../fixtures/stats/fixtures.ts";

let root: string;
let agent: string;
let out: string;
let viewer: string;
beforeEach(({ onTestFinished }) => {
	root = makeTestTempDir("stats-legacy-revisions-", onTestFinished);
	agent = join(root, "agent");
	out = join(root, "out");
	viewer = join(root, "viewer");
	vi.spyOn(Date, "now").mockReturnValue(at("2026-10-20"));
});
afterEach(() => {
	vi.restoreAllMocks();
});

const manifest = (dir: string): Manifest => JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
const october = (dir: string) => manifest(dir).shards.filter((ref) => ref.month === "2026-10");
const bytes = (refs: readonly { bytes: number }[]): number => refs.reduce((n, ref) => n + ref.bytes, 0);

interface Row {
	ms: number;
	model?: string;
	input?: number;
	output?: number;
}
/** A pi assistant entry from before entry IDs existed: no `id`, so only the legacy tuple identifies it. */
function legacy({ ms, model = "fixture-large", input = 1200, output = 300 }: Row): string {
	const row = JSON.parse(
		assistantLine({ ms, provider: "physical", model, input, output, cacheRead: 20_000, cacheWrite: 1_500, cost: 0.01 }),
	);
	delete row.id;
	return JSON.stringify(row);
}
const userLine = (ms: number): string =>
	JSON.stringify({ type: "message", timestamp: new Date(ms).toISOString(), message: { role: "user", content: [] } });

/** An identified session whose rows carry the given entry IDs, ending at a fixed later entry. */
function identifiedFile(ids: string[]): void {
	const lines = ids.map((id, i) => {
		const row = JSON.parse(
			assistantLine({ ms: at("2026-10-07") + i * 60_000, provider: "physical", model: "fixture-large", input: 50 + i }),
		);
		row.id = id;
		return JSON.stringify(row);
	});
	sessionFile(join(agent, "sessions", "identified.jsonl"), {
		startMs: at("2026-10-07"),
		lines: [...lines, userLine(at("2026-10-07") + 120_000)],
	});
}

/** A realistic October: one legacy session to revise, one untouched legacy session, one identified session. */
function seedOctober(): { revised: string; rows: (revision: number) => string[] } {
	const start = at("2026-10-05");
	const revised = join(agent, "sessions", "revised.jsonl");
	const rows = (revision: number) =>
		Array.from({ length: 40 }, (_, i) =>
			legacy({
				ms: start + i * 60_000,
				model: i % 3 === 0 ? "fixture-small" : "fixture-large",
				input: 1_200 + i * 37,
				output: 300 + i + revision,
			}),
		);
	sessionFile(revised, { startMs: start, lines: rows(0) });
	sessionFile(join(agent, "sessions", "untouched.jsonl"), {
		startMs: at("2026-10-06"),
		lines: Array.from({ length: 25 }, (_, i) =>
			legacy({ ms: at("2026-10-06") + i * 60_000, input: 900 + i, output: 100 }),
		),
	});
	sessionFile(join(agent, "sessions", "identified.jsonl"), {
		startMs: at("2026-10-07"),
		lines: Array.from({ length: 10 }, (_, i) =>
			assistantLine({ ms: at("2026-10-07") + i * 60_000, provider: "physical", model: "fixture-large", input: 50 + i }),
		),
	});
	return { revised, rows };
}

/** Export October, then seal it with a November export. */
async function sealOctober(): Promise<string> {
	const { snapshotDir } = await exportStats(agent, out);
	vi.mocked(Date.now).mockReturnValue(at("2026-11-02"));
	await exportStats(agent, out);
	return snapshotDir;
}

async function imported() {
	expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
	return loadCombined(viewer);
}

it("regenerates a sealed month for revised legacy rows instead of appending every revision", async () => {
	const { revised, rows } = seedOctober();
	const dir = await sealOctober();
	const sealed = october(dir);
	expect(sealed).toHaveLength(1);
	for (let revision = 1; revision <= 10; revision++) {
		sessionFile(revised, { startMs: at("2026-10-05"), lines: rows(revision) });
		await exportStats(agent, out);
		// Appending would add one 40-row delta per revision: 11 references and 475 calls after ten.
		expect(october(dir)).toHaveLength(1);
	}
	expect(bytes(october(dir))).toBeLessThan(bytes(sealed) * 1.25);
	expect(readdirSync(dir).sort()).toEqual(["manifest.json", ...manifest(dir).shards.map((ref) => ref.file)].sort());
	const combined = await imported();
	expect(combined.calls).toHaveLength(75);
	const final = rows(10).map((line) => JSON.parse(line).message.usage.output as number);
	const outputs = combined.calls.filter((call) => call.output >= 300).map((call) => call.output);
	expect(outputs.sort((a, b) => a - b)).toEqual(final.sort((a, b) => a - b));
	// An unchanged export keeps the regenerated month byte-for-byte.
	const settled = manifest(dir).shards;
	await exportStats(agent, out);
	expect(manifest(dir).shards).toEqual(settled);
});

it("retires a sealed legacy row whose corrected timestamp moved into the active month", async () => {
	const path = join(agent, "sessions", "moved.jsonl");
	sessionFile(path, { startMs: at("2026-10-20"), lines: [legacy({ ms: at("2026-10-20") })] });
	const dir = await sealOctober();
	sessionFile(path, { startMs: at("2026-10-20"), lines: [legacy({ ms: at("2026-11-01"), output: 301 })] });
	await exportStats(agent, out);
	const combined = await imported();
	expect(combined.calls.map((call) => [call.ms, call.output])).toEqual([[at("2026-11-01"), 301]]);
	expect(combined.sessions).toHaveLength(1);
	expect(october(dir)).toHaveLength(1);
});

it.each([
	{
		case: "a session archived only in published history",
		change: () => {
			rmSync(join(agent, "sessions", "untouched.jsonl"));
			rmSync(join(agent, "pi-session-kit", "stats-cache.json"));
		},
		lines: [legacy({ ms: at("2026-10-05"), output: 301 })],
	},
	{
		case: "a call its own transcript no longer holds",
		change: () =>
			sessionFile(join(agent, "sessions", "untouched.jsonl"), {
				startMs: at("2026-10-06"),
				lines: [legacy({ ms: at("2026-10-06"), input: 900 }), userLine(at("2026-10-06") + 120_000)],
			}),
		lines: [legacy({ ms: at("2026-10-05"), output: 301 })],
	},
	{
		case: "an identified call its own transcript no longer holds",
		seed: () => identifiedFile(["kept", "dropped"]),
		change: () => identifiedFile(["kept"]),
		lines: [legacy({ ms: at("2026-10-05"), output: 301 })],
	},
	{
		case: "fewer replacement rows than lost rows",
		before: [legacy({ ms: at("2026-10-05") }), legacy({ ms: at("2026-10-05") + 60_000 }), userLine(at("2026-10-25"))],
		lines: [legacy({ ms: at("2026-10-05"), output: 301 }), userLine(at("2026-10-25"))],
	},
	{
		case: "a replacement under another model",
		lines: [legacy({ ms: at("2026-10-05"), model: "fixture-small" })],
	},
	{
		case: "a session end the scan no longer reaches",
		before: [legacy({ ms: at("2026-10-05") }), userLine(at("2026-10-25"))],
		lines: [legacy({ ms: at("2026-10-05"), output: 301 })],
	},
])("keeps appending, never dropping, when regeneration would lose $case", async ({ seed, change, lines, before }) => {
	const path = join(agent, "sessions", "revised.jsonl");
	seed?.();
	sessionFile(path, { startMs: at("2026-10-05"), lines: before ?? [legacy({ ms: at("2026-10-05") })] });
	sessionFile(join(agent, "sessions", "untouched.jsonl"), {
		startMs: at("2026-10-06"),
		lines: [
			legacy({ ms: at("2026-10-06"), input: 900 }),
			legacy({ ms: at("2026-10-06") + 60_000, input: 901 }),
			userLine(at("2026-10-06") + 120_000),
		],
	});
	const dir = await sealOctober();
	const sealed = october(dir);
	const original = await imported();
	change?.();
	sessionFile(path, { startMs: at("2026-10-05"), lines });
	await exportStats(agent, out);
	expect(october(dir)).toEqual(expect.arrayContaining(sealed));
	expect(october(dir)).toHaveLength(2);
	for (const ref of sealed) expect(readdirSync(dir)).toContain(ref.file);
	const combined = await imported();
	// Every sealed row survives beside the appended one.
	expect(combined.calls).toHaveLength(original.calls.length + 1);
	expect(combined.sessions.map((s) => s.endMs)).toEqual(original.sessions.map((s) => s.endMs));
});

it("keeps appending when the sealed month holds a quota reading the scan no longer has", async () => {
	const path = join(agent, "sessions", "revised.jsonl");
	sessionFile(path, { startMs: at("2026-10-05"), lines: [legacy({ ms: at("2026-10-05") })] });
	const dir = await sealOctober();
	// Quota is only ever carried as published history; a pi scan never reproduces it.
	const published = manifest(dir);
	const reading = {
		harness: "pi" as const,
		provider: "physical",
		limitId: "fixture",
		window: "daily",
		usedPercent: 40,
		resetAt: at("2026-10-11"),
		durationMs: 86_400_000,
		observedAt: at("2026-10-10"),
		planType: null,
		account: "",
	};
	const shard = encodeShard({
		version: 3,
		machineId: published.machineId,
		month: "2026-10",
		events: [],
		sessions: [],
		quota: [reading],
	});
	const sha256 = createHash("sha256").update(shard).digest("hex");
	const file = `2026-10-${sha256}.json.gz`;
	writeFileSync(join(dir, file), shard);
	published.shards.push({ month: "2026-10", file, sha256, bytes: shard.length });
	writeFileSync(join(dir, "manifest.json"), JSON.stringify(published));
	const sealed = october(dir);
	sessionFile(path, { startMs: at("2026-10-05"), lines: [legacy({ ms: at("2026-10-05"), output: 301 })] });
	await exportStats(agent, out);
	expect(october(dir)).toEqual(expect.arrayContaining(sealed));
	const combined = await imported();
	expect(combined.calls).toHaveLength(2);
	expect(combined.quota).toEqual([reading]);
});

it("keeps appending when the sealed month holds a session whose calls are archived in another month", async () => {
	const path = join(agent, "sessions", "revised.jsonl");
	const spanning = join(agent, "sessions", "spanning.jsonl");
	sessionFile(path, { startMs: at("2026-10-05"), lines: [legacy({ ms: at("2026-10-05") })] });
	sessionFile(spanning, { startMs: at("2026-10-20"), lines: [legacy({ ms: at("2026-11-05"), input: 900 })] });
	vi.mocked(Date.now).mockReturnValue(at("2026-11-06"));
	const { snapshotDir: dir } = await exportStats(agent, out);
	vi.mocked(Date.now).mockReturnValue(at("2026-12-02"));
	await exportStats(agent, out);
	const sealed = manifest(dir).shards;
	rmSync(spanning);
	rmSync(join(agent, "pi-session-kit", "stats-cache.json"));
	sessionFile(path, { startMs: at("2026-10-05"), lines: [legacy({ ms: at("2026-10-05"), output: 301 })] });
	// Regenerating October would drop the November call's session metadata.
	await exportStats(agent, out);
	expect(manifest(dir).shards).toEqual(expect.arrayContaining(sealed));
	const combined = await imported();
	expect(combined.calls.map((call) => call.input).sort()).toEqual([1200, 1200, 900].sort());
	expect(combined.sessions).toHaveLength(2);
});
