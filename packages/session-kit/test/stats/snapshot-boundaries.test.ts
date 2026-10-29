import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { opaqueId } from "../../src/stats/load.ts";
import {
	atomicJson,
	exportStats,
	importStats,
	type Manifest,
	readGlobal,
	type Shard,
	validateShard,
} from "../../src/stats/snapshot.ts";
import { assistantLine, sessionFile } from "./fixtures.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, unlink: vi.fn(actual.unlink) };
});

const NOW = Date.parse("2026-10-18T12:00:00Z");
const MAX_BYTES = 128 * 1024 * 1024;
let dir: string;
let producer: string;
let viewer: string;
let repo: string;
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	dir = mkdtempSync(join(tmpdir(), "psk-snapshot-boundaries-"));
	producer = join(dir, "producer");
	viewer = join(dir, "viewer");
	repo = join(dir, "repo");
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.mocked(unlink).mockReset();
	rmSync(dir, { recursive: true, force: true });
});

/** Write physical usage with preserved identities in the same month as session metadata. */
function seed(inputs: number[]): void {
	const lines = inputs.map((input, index) => {
		const entry = JSON.parse(assistantLine({ ms: NOW + index, provider: "physical", model: "fixture-model", input }));
		entry.id = `event-${index}`;
		return JSON.stringify(entry);
	});
	sessionFile(join(producer, "sessions", "fixture.jsonl"), { startMs: NOW, lines });
}

/** Publish altered canonical bytes with the matching digest, so schema validation is the rejecting boundary. */
function publishShard(snapshotDir: string, manifest: Manifest, shard: Shard): void {
	const text = JSON.stringify(shard);
	const sha256 = opaqueId(text);
	const file = `${shard.month}-${sha256}.json`;
	writeFileSync(join(snapshotDir, file), text);
	writeFileSync(
		join(snapshotDir, "manifest.json"),
		JSON.stringify({ ...manifest, shards: [{ month: shard.month, file, sha256, bytes: Buffer.byteLength(text) }] }),
	);
}

describe("snapshot bounded publication and session schemas", () => {
	it("rejects structurally complete invalid session metadata and retains the last-good machine transaction", async () => {
		seed([7]);
		const exported = await exportStats(producer, repo);
		await importStats(viewer, repo);
		const before = await readGlobal(viewer);
		const manifest = JSON.parse(readFileSync(join(exported.snapshotDir, "manifest.json"), "utf8")) as Manifest;
		const reference = manifest.shards[0];
		if (!reference) throw new Error("Expected one shard");
		const good = JSON.parse(readFileSync(join(exported.snapshotDir, reference.file), "utf8")) as Shard;
		const session = good.sessions[0];
		if (!session) throw new Error("Expected session metadata in the event month");
		expect(() => validateShard(good, manifest, good.month)).not.toThrow();
		for (const sessions of [
			[{ ...session, endMs: session.startMs - 1 }],
			[{ ...session, startMs: 0 }],
			[{ ...session, id: "raw-private-id" }],
			[{ ...session, startMs: Date.parse("2026-09-01T12:00:00Z") }],
			[{ ...session, child: "false" }],
			[session, session],
		]) {
			const malformed = { ...good, sessions };
			expect(() => validateShard(malformed, manifest, good.month)).toThrow("Invalid snapshot session");
			publishShard(exported.snapshotDir, manifest, malformed as Shard);
			expect(await importStats(viewer, repo)).toMatchObject({
				imported: 0,
				retained: 1,
				problems: [`Incomplete snapshot ${exported.machineId}`],
				importedAt: before.importedAt,
			});
			expect((await readGlobal(viewer)).machines).toEqual(before.machines);
		}
	});

	it.each([MAX_BYTES, MAX_BYTES + 1])(
		"enforces the assembled global cache byte boundary at %i without replacing last-good on overflow",
		async (measuredBytes) => {
			seed([7]);
			const exported = await exportStats(producer, repo);
			await importStats(viewer, repo);
			const cache = join(viewer, "pi-session-kit", "stats-global.json");
			const before = readFileSync(cache, "utf8");
			seed([7, 11]);
			await exportStats(producer, repo);
			const byteLength = Buffer.byteLength;
			const measured: string[] = [];
			// Inject only the final document's byte accounting, not policy or serialization. This exercises
			// the real import/validation/atomic-write path at the 128 MiB edge without allocating 128 MiB.
			const measurement = vi.spyOn(Buffer, "byteLength").mockImplementation((value, encoding) => {
				if (typeof value === "string" && value.startsWith('{"version":1,"importedAt":')) {
					measured.push(value);
					return measuredBytes;
				}
				return byteLength(value, encoding);
			});
			if (measuredBytes === MAX_BYTES) {
				expect(await importStats(viewer, repo)).toMatchObject({ imported: 1, retained: 0, problems: [] });
				expect(readFileSync(cache, "utf8")).not.toBe(before);
			} else {
				await expect(importStats(viewer, repo)).rejects.toThrow(
					"Global cache exceeds 128 MiB; last-good cache retained",
				);
				expect(readFileSync(cache, "utf8")).toBe(before);
			}
			measurement.mockRestore();
			expect(measured).toHaveLength(1);
			const cached = await readGlobal(viewer);
			expect(cached.problems).toEqual([]);
			expect(
				cached.machines[exported.machineId]?.shards.flatMap((shard) => shard.events.map((event) => event.input)),
			).toEqual(measuredBytes === MAX_BYTES ? [7, 11] : [7]);
		},
	);

	it("preserves the publication error and last-good destination when temporary cleanup also fails", async () => {
		const destination = join(dir, "destination");
		mkdirSync(destination);
		writeFileSync(join(destination, "last-good.json"), '{"retained":true}');
		vi.mocked(unlink).mockRejectedValueOnce(new Error("temporary cleanup denied"));
		await expect(atomicJson(destination, { replacement: true })).rejects.toMatchObject({ code: "EISDIR" });
		expect(vi.mocked(unlink)).toHaveBeenCalledOnce();
		expect(readFileSync(join(destination, "last-good.json"), "utf8")).toBe('{"retained":true}');
	});
});
