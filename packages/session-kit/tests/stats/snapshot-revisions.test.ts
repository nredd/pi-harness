import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	decodeShard,
	exportStats,
	importStats,
	loadCombined,
	type Manifest,
	readGlobal,
} from "../../src/stats/snapshot.ts";
import { assistantLine, at, sessionFile } from "../fixtures/stats/fixtures.ts";
import { CANARY, claudeRow, writeLines } from "../fixtures/stats/harness/fixtures.ts";
import { seedHarnessHome } from "../fixtures/stats/harness/home.ts";

vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return { ...actual, unlink: vi.fn(actual.unlink) };
});
let root: string;
let agent: string;
let out: string;
let viewer: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "stats-revisions-"));
	agent = join(root, "agent");
	out = join(root, "out");
	viewer = join(root, "viewer");
	vi.spyOn(Date, "now").mockReturnValue(at("2026-11-02"));
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(unlink).mockRestore();
	rmSync(root, { recursive: true, force: true });
});
const manifest = (path: string): Manifest => JSON.parse(readFileSync(join(path, "manifest.json"), "utf8")) as Manifest;

it.each(["2026-10-31T23:58:00Z", "2026-11-01T00:00:01Z"])(
	"replaces a streaming call sealed before its final counters at %s",
	async (finalTime) => {
		const home = join(root, "home");
		const roots = seedHarnessHome(home);
		const path = join(roots.claude, "projects", `-Users-${CANARY}-work`, "sess-A.jsonl");
		const options = { harnesses: ["claude"] as const, roots, home, env: {} };
		const clock = vi.spyOn(Date, "now").mockReturnValue(at("2026-10-31", 23));
		writeLines(path, [
			claudeRow({
				id: "stream",
				requestId: "request",
				ts: "2026-10-31T23:58:00Z",
				usage: { input_tokens: 10, output_tokens: 1 },
			}),
		]);
		await exportStats(agent, out, undefined, options);
		writeLines(path, [
			claudeRow({ id: "stream", requestId: "request", ts: finalTime, usage: { input_tokens: 10, output_tokens: 500 } }),
		]);
		clock.mockReturnValue(at("2026-11-01", 1));
		await exportStats(agent, out, undefined, options);
		expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
		const combined = await loadCombined(viewer);
		expect(combined.calls).toHaveLength(1);
		expect(combined.calls[0]).toMatchObject({ input: 10, output: 500 });
	},
);

it.each(["start", "child"])("regenerates sealed metadata after its %s changes", async (change) => {
	const path = join(agent, "sessions", "fixture.jsonl");
	const first = assistantLine({ ms: at("2026-10-16"), provider: "physical", model: "fixture", input: 7 });
	sessionFile(path, { startMs: at("2026-10-15"), lines: [first] });
	await exportStats(agent, out);
	sessionFile(path, {
		startMs: at(change === "start" ? "2026-09-30" : "2026-10-15"),
		...(change === "child" ? { parentSession: "fixture-parent", name: "Explore#1234abcd" } : {}),
		lines: [first, assistantLine({ ms: at("2026-10-17"), provider: "physical", model: "fixture", input: 9 })],
	});
	await exportStats(agent, out);
	expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
	const combined = await loadCombined(viewer);
	expect(combined.calls).toHaveLength(2);
	expect(combined.sessionMetadata?.[0]).toMatchObject({
		startMs: at(change === "start" ? "2026-09-30" : "2026-10-15"),
		child: change === "child",
	});
});

it.each([70 * 1024 * 1024, 128 * 1024 * 1024])(
	"bounds total machine expansion with %i bytes charged per shard and retains last-good",
	async (chargedBytes) => {
		sessionFile(join(agent, "sessions", "fixture.jsonl"), {
			startMs: at("2026-01-01"),
			lines: [
				assistantLine({ ms: at("2026-01-01"), provider: "physical", model: "fixture", input: 7 }),
				assistantLine({ ms: at("2026-02-01"), provider: "physical", model: "fixture", input: 9 }),
			],
		});
		await exportStats(agent, out);
		await importStats(viewer, out);
		const before = await readGlobal(viewer);
		const original = Buffer.byteLength;
		// Inject only byte accounting: each real validated shard fits alone, but their total exceeds 128 MiB.
		const measure = vi
			.spyOn(Buffer, "byteLength")
			.mockImplementation((value, encoding) =>
				typeof value === "string" && value.startsWith('{"v":3,') ? chargedBytes : original(value, encoding),
			);
		try {
			expect(await importStats(viewer, out)).toMatchObject({ imported: 0, retained: 1 });
		} finally {
			measure.mockRestore();
		}
		expect((await readGlobal(viewer)).machines).toEqual(before.machines);
	},
);

it("rejects a real gzip stream expanding beyond 128 MiB", () => {
	const bytes = gzipSync(Buffer.alloc(128 * 1024 * 1024 + 1, 32), { level: 1 });
	const m: Manifest = {
		version: 3,
		machineId: "11111111-1111-4111-8111-111111111111",
		label: "fixture",
		exportedAt: at("2026-11-02"),
		lastGoodAt: {},
		shards: [],
	};
	expect(() => decodeShard(bytes, m, "2026-10")).toThrow();
});

it("preserves recoverable files when the previous transaction and harness are unreadable", async () => {
	const home = join(root, "home");
	const roots = seedHarnessHome(home);
	const options = { harnesses: ["pi", "claude"] as const, roots, home, env: {} };
	const first = await exportStats(agent, out, undefined, options);
	const ref = manifest(first.snapshotDir).shards[0];
	if (!ref) throw new Error("Missing shard");
	const path = join(first.snapshotDir, ref.file);
	const bytes = readFileSync(path);
	bytes[bytes.length - 1] = 1;
	writeFileSync(path, bytes);
	rmSync(roots.claude, { recursive: true, force: true });
	await exportStats(agent, out, undefined, options);
	expect(readdirSync(first.snapshotDir)).toContain(ref.file);
});

it.each(["EACCES", "ENOENT"])(
	"handles orphan removal %s after publication without failing the export",
	async (code) => {
		sessionFile(join(agent, "sessions", "fixture.jsonl"), {
			startMs: at("2026-10-01"),
			lines: [assistantLine({ ms: at("2026-10-01"), provider: "physical", model: "fixture", input: 7 })],
		});
		const first = await exportStats(agent, out);
		const orphan = `2025-01-${"a".repeat(64)}.json`;
		writeFileSync(join(first.snapshotDir, orphan), "{}");
		const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		vi.mocked(unlink).mockImplementation(async (path) => {
			if (String(path).endsWith(orphan)) throw Object.assign(new Error("cleanup denied"), { code });
			return actual.unlink(path);
		});
		const result = await exportStats(agent, out);
		expect(result.warnings ?? []).toEqual(code === "ENOENT" ? [] : ["obsolete shard cleanup failed"]);
		expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
		expect(JSON.parse(readFileSync(join(agent, "pi-session-kit", "export-state.json"), "utf8")).harnesses).toEqual([
			"pi",
		]);
	},
);

it("keeps many sealed deltas proportional to new events and leaves no superseded files", async () => {
	const path = join(agent, "sessions", "fixture.jsonl");
	const lines = Array.from({ length: 100 }, (_, i) => {
		const row = JSON.parse(
			assistantLine({ ms: at("2026-10-01") + i, provider: "physical", model: "fixture", input: i + 1 }),
		);
		row.id = `fixture-${i}`;
		return JSON.stringify(row);
	});
	sessionFile(path, { startMs: at("2026-10-01"), lines });
	const first = await exportStats(agent, out);
	const before = manifest(first.snapshotDir);
	const ref = before.shards[0];
	if (!ref) throw new Error("Missing shard");
	const original = readFileSync(join(first.snapshotDir, ref.file));
	for (let i = 100; i < 140; i++) {
		const row = JSON.parse(
			assistantLine({ ms: at("2026-10-01") + i, provider: "physical", model: "fixture", input: i + 1 }),
		);
		row.id = `fixture-${i}`;
		lines.push(JSON.stringify(row));
		sessionFile(path, { startMs: at("2026-10-01"), lines });
		await exportStats(agent, out);
	}
	await exportStats(agent, out);
	const after = manifest(first.snapshotDir);
	expect(after.shards).toHaveLength(41);
	expect(after.shards.reduce((n, s) => n + s.bytes, 0)).toBeLessThanOrEqual(ref.bytes + 40 * 256);
	expect(readFileSync(join(first.snapshotDir, ref.file))).toEqual(original);
	expect(readdirSync(first.snapshotDir).sort()).toEqual(["manifest.json", ...after.shards.map((s) => s.file)].sort());
	expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
	expect((await loadCombined(viewer)).calls).toHaveLength(140);
});

it("keeps unidentified legacy events stable across repeated sealed-month exports", async () => {
	const row = JSON.parse(assistantLine({ ms: at("2026-10-01"), provider: "physical", model: "fixture", input: 7 }));
	delete row.id;
	sessionFile(join(agent, "sessions", "fixture.jsonl"), { startMs: at("2026-10-01"), lines: [JSON.stringify(row)] });
	const first = await exportStats(agent, out);
	const before = manifest(first.snapshotDir);
	await exportStats(agent, out);
	expect(manifest(first.snapshotDir).shards).toEqual(before.shards);
	expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
	expect((await loadCombined(viewer)).calls).toHaveLength(1);
});

it("atomically repairs corrupt bytes at an existing content-addressed filename", async () => {
	sessionFile(join(agent, "sessions", "fixture.jsonl"), {
		startMs: at("2026-10-01"),
		lines: [assistantLine({ ms: at("2026-10-01"), provider: "physical", model: "fixture", input: 7 })],
	});
	const first = await exportStats(agent, out);
	const ref = manifest(first.snapshotDir).shards[0];
	if (!ref) throw new Error("Missing shard");
	const path = join(first.snapshotDir, ref.file);
	const original = readFileSync(path);
	writeFileSync(path, "corrupt");
	await exportStats(agent, out);
	expect(readFileSync(path)).toEqual(original);
	expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
});
