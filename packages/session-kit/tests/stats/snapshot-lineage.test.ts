import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	decodeShard,
	encodeShard,
	eventId,
	exportStats,
	importStats,
	loadCombined,
	type Manifest,
	type RetiredEvent,
	type Shard,
	type SnapshotEvent,
	validateShard,
	validateSnapshot,
} from "../../src/stats/snapshot.ts";
import { assistantLine } from "../fixtures/stats/fixtures.ts";

let root: string;
let agent: string;
let out: string;
let viewer: string;
beforeEach(({ onTestFinished }) => {
	root = makeTestTempDir("stats-lineage-", onTestFinished);
	agent = join(root, "agent");
	out = join(root, "out");
	viewer = join(root, "viewer");
	clock("2026-10-20");
});
afterEach(() => {
	vi.restoreAllMocks();
});

/** A UTC instant: snapshot months are UTC, so fixtures never depend on the host time zone. */
const utc = (day: string, minute = 0): number => Date.parse(`${day}T12:00:00Z`) + minute * 60_000;
function clock(day: string): void {
	vi.spyOn(Date, "now").mockReturnValue(utc(day));
}

interface Row {
	ms: number;
	model?: string;
	input?: number;
	output?: number;
}
/** A pi assistant entry from before entry IDs existed: no `id`, so only its tuple and position identify it. */
function legacy({ ms, model = "fixture", input = 100, output = 10 }: Row): string {
	const row = JSON.parse(assistantLine({ ms, provider: "physical", model, input, output, cost: 0.01 }));
	delete row.id;
	return JSON.stringify(row);
}
/** One transcript with an explicit header id, so two files can share a session. */
function transcript(file: string, id: string, rows: readonly Row[]): void {
	const path = join(agent, "sessions", file);
	mkdirSync(dirname(path), { recursive: true });
	const header = JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-05T11:00:00.000Z", cwd: "/x" });
	writeFileSync(path, `${[header, ...rows.map(legacy)].join("\n")}\n`);
}
/** Five October calls; `revision` corrects the third call's output counter. */
const october = (revision = 0): Row[] =>
	Array.from({ length: 5 }, (_, i) => ({
		ms: utc("2026-10-05", i),
		input: 100 + i,
		output: i === 2 ? 10 + revision : 10,
	}));

/** Publish October while it is active, then seal it with a November export. */
async function seal(rows: readonly Row[] = october()): Promise<void> {
	transcript("a.jsonl", "a", rows);
	await exportStats(agent, out);
	clock("2026-11-02");
	await exportStats(agent, out);
}

function outbox(): { dir: string; manifest: Manifest } {
	const id = (JSON.parse(readFileSync(join(agent, "pi-session-kit", "machine.json"), "utf8")) as { machineId: string })
		.machineId;
	const dir = join(out, "machines", id);
	return { dir, manifest: JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest };
}
/** Every published shard of `month`, decoded. */
function shards(month = "2026-10"): Shard[] {
	const { dir, manifest } = outbox();
	return manifest.shards
		.filter((ref) => ref.month === month)
		.map((ref) => decodeShard(readFileSync(join(dir, ref.file)), manifest, ref.month));
}
const counted = (month = "2026-10"): SnapshotEvent[] => shards(month).flatMap((s) => s.events);
const retired = (month = "2026-10"): RetiredEvent[] => shards(month).flatMap((s) => s.retired ?? []);
/** What a viewer on another machine counts. */
async function viewed(): Promise<{ output: number; ms: number; model: string }[]> {
	expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
	return (await loadCombined(viewer)).calls.map((c) => ({ output: c.output, ms: c.ms, model: c.model }));
}

describe("row lineage", () => {
	it("persists each legacy row's transcript origin and keeps identified-only shards at version 3", async () => {
		await seal();
		const [shard] = shards();
		expect(shard?.version).toBe(4);
		expect(shard?.events.map((e) => e.origin)).toEqual([0, 1, 2, 3, 4]);
		expect(shard?.retired).toEqual([]);
		// An identified pi session carries no lineage: its month stays byte-compatible version 3.
		const path = join(agent, "sessions", "identified.jsonl");
		writeFileSync(
			path,
			`${[
				JSON.stringify({ type: "session", version: 3, id: "i", timestamp: "2026-11-02T11:00:00.000Z", cwd: "/x" }),
				assistantLine({ ms: utc("2026-11-02", -30), provider: "physical", model: "fixture", input: 5 }),
			].join("\n")}\n`,
		);
		await exportStats(agent, out);
		expect(shards("2026-11").map((s) => s.version)).toEqual([3]);
	});

	it("retires each revised sealed row in place and counts only its successor, ten revisions deep", async () => {
		await seal();
		for (let revision = 1; revision <= 10; revision++) {
			transcript("a.jsonl", "a", october(revision));
			await exportStats(agent, out);
			// Every sealed row is still published: five counted, one retired per revision.
			expect(counted()).toHaveLength(5);
			expect(retired().map((e) => e.output)).toEqual(Array.from({ length: revision }, (_, i) => 10 + i));
			expect(retired().every((e) => e.reason === "revised")).toBe(true);
		}
		// Each retired row names the row that replaced it; the chain ends at the counted row.
		const byId = new Map(retired().map((e) => [e.id, e.successor]));
		const live = new Set(counted().map((e) => e.id));
		let id = retired().find((e) => e.output === 10)?.id as string;
		let hops = 0;
		while (!live.has(id)) {
			id = byId.get(id) as string;
			hops++;
		}
		expect(hops).toBe(10);
		expect(counted().find((e) => e.id === id)).toMatchObject({ output: 20, origin: 2 });
		expect((await viewed()).map((c) => c.output)).toEqual([10, 10, 20, 10, 10]);
	});

	it("keeps every row past the 32-shard cap, packing retired rows losslessly", async () => {
		await seal();
		for (let revision = 1; revision <= 34; revision++) {
			transcript("a.jsonl", "a", october(revision));
			await exportStats(agent, out);
		}
		expect(outbox().manifest.shards.filter((ref) => ref.month === "2026-10").length).toBeLessThanOrEqual(32);
		expect(counted()).toHaveLength(5);
		expect(retired()).toHaveLength(34);
		expect((await viewed()).map((c) => c.output)).toEqual([10, 10, 44, 10, 10]);
	});

	it("leaves a retired row retired when the scan reproduces it", async () => {
		await seal();
		transcript("a.jsonl", "a", october(1));
		await exportStats(agent, out);
		transcript("a.jsonl", "a", october(0));
		await exportStats(agent, out);
		// The reproduced row is already published (retired); its successor stays the counted one.
		expect(
			counted()
				.map((e) => e.output)
				.sort((a, b) => a - b),
		).toEqual([10, 10, 10, 10, 11]);
		expect(retired().map((e) => e.output)).toEqual([10]);
		expect((await viewed()).map((c) => c.output)).toEqual([10, 10, 11, 10, 10]);
	});

	it.each([
		["another model", october(1).map((r, i) => (i === 2 ? { ...r, model: "other" } : r)), 6],
		["another month", october(1).map((r, i) => (i === 2 ? { ...r, ms: utc("2026-09-30") } : r)), 6],
		// The first call left the transcript: every later origin shifted onto a row published elsewhere.
		["shifted origins", october().slice(1), 5],
		// The last call was trimmed and the resumed session's next call reuses its origin in November.
		["trimmed then resumed", [...october().slice(0, 4), { ms: utc("2026-11-01") }], 6],
	])("keeps a sealed row counted when its lineage cannot be established: %s", async (_, rows, calls) => {
		await seal();
		transcript("a.jsonl", "a", rows);
		await exportStats(agent, out);
		expect(retired()).toEqual([]);
		expect(await viewed()).toHaveLength(calls);
	});

	it("publishes no origin for a position two transcripts of one session share, so nothing retires", async () => {
		transcript("b.jsonl", "a", [{ ms: utc("2026-10-06"), input: 7 }]);
		await seal();
		expect(counted().map((e) => e.origin)).toEqual([null, 1, 2, 3, 4, null]);
		transcript(
			"a.jsonl",
			"a",
			october(1).map((r, i) => (i === 0 ? { ...r, output: 99 } : r)),
		);
		await exportStats(agent, out);
		// Origin 0 is ambiguous, so the first call appends; the third has a unique origin and retires.
		expect(retired().map((e) => e.output)).toEqual([10]);
		expect(await viewed()).toHaveLength(7);
	});

	it("leaves rows published before lineage counted beside a correction, as before", async () => {
		await seal();
		// Rewrite October as a kit without lineage published it: version 3 rows, no origins.
		const { dir, manifest } = outbox();
		manifest.shards = manifest.shards.map((ref) => {
			if (ref.month !== "2026-10") return ref;
			const shard = decodeShard(readFileSync(join(dir, ref.file)), manifest, ref.month);
			const bytes = encodeShard({
				version: 3,
				machineId: shard.machineId,
				month: shard.month,
				events: shard.events.map(({ origin: _, ...e }) => e),
				sessions: shard.sessions,
				quota: shard.quota,
			});
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			writeFileSync(join(dir, `${ref.month}-${sha256}.json.gz`), bytes);
			return { month: ref.month, file: `${ref.month}-${sha256}.json.gz`, sha256, bytes: bytes.length };
		});
		writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
		transcript("a.jsonl", "a", october(1));
		await exportStats(agent, out);
		expect(retired()).toEqual([]);
		expect((await viewed()).map((c) => c.output)).toEqual([10, 10, 10, 11, 10, 10]);
	});

	it("carries retired rows through a month an identified correction regenerates", async () => {
		const identified = (output: number) =>
			assistantLine({ ms: utc("2026-10-07"), provider: "physical", model: "fixture", input: 3, output });
		const write = (output: number) =>
			writeFileSync(
				join(agent, "sessions", "identified.jsonl"),
				`${[
					JSON.stringify({ type: "session", version: 3, id: "i", timestamp: "2026-10-07T11:00:00.000Z", cwd: "/x" }),
					JSON.stringify({ ...JSON.parse(identified(output)), id: "entry-1" }),
				].join("\n")}\n`,
			);
		mkdirSync(join(agent, "sessions"), { recursive: true });
		write(1);
		await seal();
		transcript("a.jsonl", "a", october(1));
		await exportStats(agent, out);
		// Correct the identified call and the legacy call again in one export: October is regenerated.
		write(2);
		transcript("a.jsonl", "a", october(2));
		await exportStats(agent, out);
		expect(
			retired()
				.map((e) => e.output)
				.sort((a, b) => a - b),
		).toEqual([10, 11]);
		expect((await viewed()).map((c) => c.output).sort((a, b) => a - b)).toEqual([2, 10, 10, 10, 10, 12]);
	});
});

const MACHINE = "6f1c2a43-8a8f-4a7e-9f43-0d4f3c8a1b2e";
const manifest: Manifest = { version: 3, machineId: MACHINE, label: "m", exportedAt: 1, lastGoodAt: {}, shards: [] };
const SESSION = "a".repeat(64);
function row(extra: Partial<SnapshotEvent> = {}): SnapshotEvent {
	const e = {
		harness: "pi" as const,
		entryId: null,
		sessionId: SESSION,
		ms: utc("2026-10-05"),
		provider: "physical",
		model: "fixture",
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		...extra,
	};
	return { id: eventId(e), ...e };
}
const lineageShard = (events: SnapshotEvent[], retiredRows: RetiredEvent[] = []): Shard => ({
	version: 4,
	machineId: MACHINE,
	month: "2026-10",
	events,
	sessions: [{ id: SESSION, startMs: utc("2026-10-05"), endMs: utc("2026-10-05"), child: false }],
	quota: [],
	retired: retiredRows,
});
const retire = (e: SnapshotEvent, successor: string, extra: Partial<RetiredEvent> = {}): RetiredEvent => {
	const { origin: _, ...rest } = e;
	return { ...rest, successor, reason: "revised", ...extra };
};

describe("lineage validation", () => {
	const live = row({ output: 2, origin: 0 });
	const old = row({ output: 1 });

	it("round-trips a lineage shard through its compact wire form", () => {
		const shard = lineageShard([live], [retire(old, live.id)]);
		expect(validateShard(shard, manifest, "2026-10")).toBe(shard);
		expect(decodeShard(encodeShard(shard), manifest, "2026-10")).toEqual(shard);
	});

	it.each([
		["an origin on an identified row", [row({ entryId: "b".repeat(24), origin: 0 })], [], "Invalid event origin"],
		["a negative origin", [row({ origin: -1 })], [], "Invalid event origin"],
		["no lineage at all", [row({ origin: null })], [], "Lineage shard without lineage"],
		["a retired row that is also counted", [live], [retire(live, old.id)], "Invalid retired event"],
		["a self-successor", [live], [retire(old, old.id)], "Invalid retired event"],
		["another reason", [live], [retire(old, live.id, { reason: "x" as never })], "Invalid retired event"],
		["a malformed successor", [live], [retire(old, "nope")], "Invalid retired event"],
		[
			"a retired identified row",
			[live],
			[retire(row({ entryId: "b".repeat(24), output: 3 }), live.id)],
			"Invalid retired event",
		],
		["a duplicate event", [live, live], [], "Invalid snapshot event"],
	])("rejects %s", (_, events, retiredRows, message) => {
		expect(() => validateShard(lineageShard(events, retiredRows), manifest, "2026-10")).toThrow(message);
	});

	it("rejects lineage outside a v3 manifest", () => {
		expect(() => validateShard(lineageShard([live]), { ...manifest, version: 2 }, "2026-10")).toThrow(
			"Unexpected snapshot fields",
		);
		expect(() =>
			validateShard({ ...lineageShard([live]), retired: undefined } as unknown as Shard, manifest, "2026-10"),
		).toThrow("Invalid shard header");
	});

	it.each([
		[
			"a successor that is not published",
			[lineageShard([live], [retire(old, row({ output: 9 }).id)])],
			"Invalid row lineage",
		],
		[
			"a retired row counted in another shard",
			[lineageShard([live], [retire(old, live.id)]), lineageShard([old])],
			"Invalid row lineage",
		],
		[
			"a row retired twice",
			[
				lineageShard([live], [retire(old, live.id)]),
				lineageShard([row({ output: 5, origin: 1 })], [retire(old, live.id)]),
			],
			"Duplicate retired identity",
		],
	])("rejects a machine with %s", (_, shardList, message) => {
		expect(() => validateSnapshot({ manifest, shards: shardList })).toThrow(message);
	});

	it("accepts a retired row whose successor was retired in turn", () => {
		const middle = row({ output: 3 });
		const shard = lineageShard([live], [retire(old, middle.id), retire(middle, live.id)]);
		expect(() => validateSnapshot({ manifest, shards: [shard] })).not.toThrow();
	});

	it.each([
		["an unknown reason code", (x: unknown[][]) => [[...(x[0] as unknown[]).slice(0, 11), 2]], "Invalid retired row"],
		["a non-array retired table", () => 0, "Invalid compact shard"],
	])("rejects a wire shard with %s", (_, tamper, message) => {
		const bytes = encodeShard(lineageShard([live], [retire(old, live.id)]));
		const wire = JSON.parse(gunzipSync(bytes).toString("utf8")) as { x: unknown[][] };
		wire.x = tamper(wire.x) as unknown[][];
		expect(() => decodeShard(gzipSync(JSON.stringify(wire)), manifest, "2026-10")).toThrow(message);
	});
});
