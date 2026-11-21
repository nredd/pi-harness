import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
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
	return {
		...actual,
		unlink: vi.fn(actual.unlink),
		readdir: vi.fn(actual.readdir),
		writeFile: vi.fn(actual.writeFile),
	};
});
let root: string;
let agent: string;
let out: string;
let viewer: string;
beforeEach(({ onTestFinished }) => {
	root = makeTestTempDir("stats-revisions-", onTestFinished);
	agent = join(root, "agent");
	out = join(root, "out");
	viewer = join(root, "viewer");
	vi.spyOn(Date, "now").mockReturnValue(at("2026-11-02"));
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(unlink).mockRestore();
	vi.mocked(readdir).mockRestore();
	vi.mocked(writeFile).mockRestore();
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

it("preserves recovery files and keeps a vanished harness lost across repeated unreadable manifests", async () => {
	const home = join(root, "home");
	const seeded = seedHarnessHome(home);
	const roots = { ...seeded, codex: join(root, "not-installed") };
	const options = { harnesses: ["pi", "claude", "codex"] as const, roots, home, env: {} };
	writeLines(join(roots.claude, "projects", `-Users-${CANARY}-work`, "sess-A.jsonl"), [
		claudeRow({ id: "sept", requestId: "sept", ts: "2026-09-01T12:00:00Z" }),
		claudeRow({ id: "oct", requestId: "oct", ts: "2026-10-01T12:00:00Z" }),
	]);
	const first = await exportStats(agent, out, undefined, options);
	const before = manifest(first.snapshotDir);
	const valid = before.shards.find((shard) => shard.month === "2026-09");
	if (!valid) throw new Error("Missing valid recovery shard");
	const validBytes = readFileSync(join(first.snapshotDir, valid.file));
	const ref = before.shards.find((shard) => shard.month === "2026-10");
	if (!ref) throw new Error("Missing shard");
	const path = join(first.snapshotDir, ref.file);
	const bytes = readFileSync(path);
	bytes[bytes.length - 1] = 1;
	writeFileSync(path, bytes);
	rmSync(roots.claude, { recursive: true, force: true });
	for (let run = 0; run < 3; run++) {
		// After one recovery export, the active snapshot no longer contains Claude rows.
		if (run === 1) writeFileSync(join(first.snapshotDir, "manifest.json"), "corrupt");
		vi.mocked(Date.now).mockReturnValue(at("2026-11-02") + (run + 1) * 60_000);
		const result = await exportStats(agent, out, undefined, options);
		expect(readdirSync(first.snapshotDir)).toContain(ref.file);
		expect(readFileSync(join(first.snapshotDir, valid.file))).toEqual(validBytes);
		expect(manifest(first.snapshotDir).lastGoodAt?.claude).toBeUndefined();
		expect(result.harnesses?.claude).toMatchObject({ failed: "lost", consecutiveFailures: run + 1 });
		expect(result.harnesses?.codex?.failed).toBeUndefined();
		expect(manifest(first.snapshotDir).lastGoodAt?.codex).toBe(Date.now());
		expect(result.warnings).toContain("recovery files retained: explicit replacement required");
	}
	const statePath = join(agent, "pi-session-kit", "export-state.json");
	const recovery = JSON.parse(readFileSync(statePath, "utf8"));
	expect(recovery.recoveryPending).toBe(true);
	expect(recovery.lostHarnesses).toEqual(["claude"]);
	expect(recovery.failures.codex).toBeUndefined();
	const accepted = await exportStats(agent, out, undefined, { ...options, replaceHarnesses: true });
	expect(accepted.warnings ?? []).toEqual([]);
	expect(readdirSync(first.snapshotDir)).not.toContain(ref.file);
	expect(readdirSync(first.snapshotDir)).not.toContain(valid.file);
	expect(JSON.parse(readFileSync(statePath, "utf8")).recoveryPending).toBe(false);
});

it("does not carry a freshness mark from an older export that stamped a lost harness", async () => {
	const home = join(root, "home");
	const roots = seedHarnessHome(home);
	const options = { harnesses: ["pi", "claude"] as const, roots, home, env: {} };
	const first = await exportStats(agent, out, undefined, options);
	const manifestPath = join(first.snapshotDir, "manifest.json");
	writeFileSync(manifestPath, "corrupt");
	rmSync(roots.claude, { recursive: true });
	const lost = await exportStats(agent, out, undefined, options);
	expect(lost.harnesses?.claude?.failed).toBe("lost");

	const previous = manifest(first.snapshotDir);
	previous.lastGoodAt = { ...previous.lastGoodAt, claude: previous.exportedAt };
	writeFileSync(manifestPath, JSON.stringify(previous));
	vi.mocked(Date.now).mockReturnValue(at("2026-11-03"));
	const next = await exportStats(agent, out, undefined, options);
	expect(next.harnesses?.claude?.failed).toBe("lost");
	expect(manifest(first.snapshotDir).lastGoodAt?.claude).toBeUndefined();
});

it("prunes post-recovery active generations while retaining only the frozen recovery files", async () => {
	const path = join(agent, "sessions", "active.jsonl");
	const seed = (input: number) => {
		const row = JSON.parse(assistantLine({ ms: Date.now(), provider: "physical", model: "fixture", input }));
		row.id = "active";
		sessionFile(path, { startMs: Date.now(), lines: [JSON.stringify(row)] });
	};
	seed(7);
	const first = await exportStats(agent, out);
	const original = manifest(first.snapshotDir).shards[0];
	if (!original) throw new Error("Missing shard");
	writeFileSync(join(first.snapshotDir, original.file), "corrupt");
	await exportStats(agent, out);
	for (let i = 0; i < 5; i++) {
		seed(8 + i);
		await exportStats(agent, out);
	}
	const current = manifest(first.snapshotDir);
	const expected = [...new Set(["manifest.json", original.file, ...current.shards.map((ref) => ref.file)])].sort();
	expect(readdirSync(first.snapshotDir).sort()).toEqual(expected);
	const state = JSON.parse(readFileSync(join(agent, "pi-session-kit", "export-state.json"), "utf8"));
	expect(state.recoveryFiles).toEqual([original.file]);
	expect(state.lostHarnesses).toEqual([]);
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
		expect(result.warnings ?? []).toEqual(code === "ENOENT" ? [] : ["obsolete shard cleanup failed: EACCES=1"]);
		expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
		expect(JSON.parse(readFileSync(join(agent, "pi-session-kit", "export-state.json"), "utf8")).harnesses).toEqual([
			"pi",
		]);
	},
);

it("continues pruning other entries and reports errno counts without raw error details", async () => {
	sessionFile(join(agent, "sessions", "fixture.jsonl"), {
		startMs: at("2026-10-01"),
		lines: [assistantLine({ ms: at("2026-10-01"), provider: "physical", model: "fixture", input: 7 })],
	});
	const first = await exportStats(agent, out);
	const orphans = ["a", "b", "c", "d"].map((id) => `2025-01-${id.repeat(64)}.json`);
	for (const name of orphans) writeFileSync(join(first.snapshotDir, name), "{}");
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	vi.mocked(unlink).mockImplementation(async (path) => {
		const name = String(path);
		if (name.endsWith(orphans[0] ?? "missing") || name.endsWith(orphans[1] ?? "missing"))
			throw Object.assign(new Error("private diagnostic"), { code: "EACCES" });
		if (name.endsWith(orphans[2] ?? "missing")) throw Object.assign(new Error("private diagnostic"), { code: "EPERM" });
		return actual.unlink(path);
	});
	const result = await exportStats(agent, out);
	expect(result.warnings).toEqual(["obsolete shard cleanup failed: EACCES=2, EPERM=1"]);
	expect(readdirSync(first.snapshotDir)).not.toContain(orphans[3]);
});

it("reports a failed directory scan without publishing an unbounded diagnostic", async () => {
	const first = await exportStats(agent, out);
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	vi.mocked(readdir).mockImplementation(async (path, options) => {
		if (String(path) === first.snapshotDir) throw null;
		return actual.readdir(path, options);
	});
	const result = await exportStats(agent, out);
	expect(result.warnings).toEqual(["obsolete shard cleanup failed: UNKNOWN=1"]);
	expect(manifest(first.snapshotDir).shards).toEqual([]);
});

it("refuses publication when the durable recovery barrier cannot be written", async () => {
	const home = join(root, "home");
	const roots = seedHarnessHome(home);
	const options = { harnesses: ["pi", "claude"] as const, roots, home, env: {} };
	const first = await exportStats(agent, out, undefined, options);
	const ref = manifest(first.snapshotDir).shards[0];
	if (!ref) throw new Error("Missing shard");
	const manifestPath = join(first.snapshotDir, "manifest.json");
	const before = readFileSync(manifestPath);
	writeFileSync(join(first.snapshotDir, ref.file), "corrupt");
	rmSync(roots.claude, { recursive: true, force: true });
	const statePath = join(agent, "pi-session-kit", "export-state.json");
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	vi.mocked(writeFile).mockImplementation(async (path, data, options) => {
		if (String(path).startsWith(`${statePath}.`)) throw Object.assign(new Error("barrier denied"), { code: "EACCES" });
		return actual.writeFile(path, data, options);
	});
	await expect(exportStats(agent, out, undefined, options)).rejects.toThrow("barrier denied");
	expect(readFileSync(manifestPath)).toEqual(before);
	expect(readdirSync(first.snapshotDir)).toContain(ref.file);
});

it("reads legacy export state but rejects malformed recovery markers", async () => {
	await exportStats(agent, out);
	const path = join(agent, "pi-session-kit", "export-state.json");
	const state = JSON.parse(readFileSync(path, "utf8"));
	for (const key of ["recoveryPending", "recoveryFiles", "lostHarnesses", "historyHarnesses"]) delete state[key];
	writeFileSync(path, JSON.stringify(state));
	await exportStats(agent, out);
	writeFileSync(path, JSON.stringify({ ...state, recoveryPending: "invalid" }));
	await expect(exportStats(agent, out)).rejects.toThrow("Invalid export state");
});

it.each([
	["recoveryFiles", "invalid"],
	["recoveryFiles", [7]],
	["recoveryFiles", ["../outside.json"]],
	["recoveryFiles", [`2026-11-${"a".repeat(64)}.json.gz`, `2026-11-${"a".repeat(64)}.json.gz`]],
	["lostHarnesses", "invalid"],
	["lostHarnesses", ["unknown"]],
	["lostHarnesses", ["pi", "pi"]],
	["historyHarnesses", "invalid"],
	["historyHarnesses", ["unknown"]],
	["historyHarnesses", ["pi", "pi"]],
])("rejects invalid scoped recovery state in %s", async (field, value) => {
	await exportStats(agent, out);
	const path = join(agent, "pi-session-kit", "export-state.json");
	const state = JSON.parse(readFileSync(path, "utf8"));
	writeFileSync(path, JSON.stringify({ ...state, [String(field)]: value }));
	await expect(exportStats(agent, out)).rejects.toThrow("Invalid export state");
});

it("migrates a legacy boolean recovery marker to a frozen file set once", async () => {
	const options = {
		harnesses: ["pi", "codex"] as const,
		roots: { codex: join(root, "not-installed") },
		home: root,
		env: {},
	};
	const path = join(agent, "sessions", "active.jsonl");
	const seed = (input: number) =>
		sessionFile(path, {
			startMs: Date.now(),
			lines: [assistantLine({ ms: Date.now(), provider: "physical", model: "fixture", input })],
		});
	seed(7);
	const first = await exportStats(agent, out, undefined, options);
	const before = manifest(first.snapshotDir).shards;
	const statePath = join(agent, "pi-session-kit", "export-state.json");
	const state = JSON.parse(readFileSync(statePath, "utf8"));
	delete state.lostHarnesses;
	state.recoveryFiles = null;
	state.historyHarnesses = null;
	state.recoveryPending = true;
	writeFileSync(statePath, JSON.stringify(state));
	const ref = before[0];
	if (!ref) throw new Error("Missing shard");
	writeFileSync(join(first.snapshotDir, ref.file), "corrupt");
	const migrated = await exportStats(agent, out, undefined, options);
	expect(migrated.harnesses?.codex?.failed).toBeUndefined();
	const frozen = JSON.parse(readFileSync(statePath, "utf8")).recoveryFiles;
	expect(frozen).toEqual(before.map((ref) => ref.file));
	seed(8);
	await exportStats(agent, out, undefined, options);
	seed(9);
	await exportStats(agent, out, undefined, options);
	expect(JSON.parse(readFileSync(statePath, "utf8")).recoveryFiles).toEqual(frozen);
	expect(readdirSync(first.snapshotDir).sort()).toEqual(
		["manifest.json", ...new Set([...frozen, ...manifest(first.snapshotDir).shards.map((ref) => ref.file)])].sort(),
	);
});

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

it("appends a delta when distinct sessions share a preserved entry identity", async () => {
	const a = join(agent, "sessions", "a.jsonl");
	const b = join(agent, "sessions", "b.jsonl");
	const row = (id: string, input: number) => {
		const value = JSON.parse(assistantLine({ ms: at("2026-10-01"), provider: "physical", model: "fixture", input }));
		value.id = id;
		return JSON.stringify(value);
	};
	const firstCall = row("deadbeef", 7);
	sessionFile(a, { startMs: at("2026-10-01"), lines: [firstCall] });
	sessionFile(b, { startMs: at("2026-10-01"), lines: [row("deadbeef", 9)] });
	const first = await exportStats(agent, out);
	const before = manifest(first.snapshotDir);
	expect(before.shards).toHaveLength(1);
	sessionFile(a, { startMs: at("2026-10-01"), lines: [firstCall, row("late", 11)] });
	await exportStats(agent, out);
	const after = manifest(first.snapshotDir);
	expect(after.shards).toEqual(expect.arrayContaining(before.shards));
	// One base plus one late delta. A single replacement file would reproduce the regeneration bug.
	expect(after.shards).toHaveLength(2);
	expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
	expect((await loadCombined(viewer)).calls).toHaveLength(3);
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
