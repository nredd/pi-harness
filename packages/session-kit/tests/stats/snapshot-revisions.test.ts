import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	decodeShard,
	encodeShard,
	eventId,
	exportStats,
	importStats,
	loadCombined,
	type Manifest,
	readGlobal,
	type Shard,
	type SnapshotQuota,
} from "../../src/stats/snapshot.ts";
import { assistantLine, at, outboxStatePath, sessionFile } from "../fixtures/stats/fixtures.ts";
import { CANARY, claudeRow, writeLines } from "../fixtures/stats/harness/fixtures.ts";
import { seedHarnessHome } from "../fixtures/stats/harness/home.ts";

vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return {
		...actual,
		lstat: vi.fn(actual.lstat),
		mkdir: vi.fn(actual.mkdir),
		unlink: vi.fn(actual.unlink),
		rename: vi.fn(actual.rename),
		readdir: vi.fn(actual.readdir),
		readFile: vi.fn(actual.readFile),
		rmdir: vi.fn(actual.rmdir),
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
	vi.mocked(lstat).mockRestore();
	vi.mocked(mkdir).mockRestore();
	vi.mocked(unlink).mockRestore();
	vi.mocked(rename).mockRestore();
	vi.mocked(readdir).mockRestore();
	vi.mocked(readFile).mockRestore();
	vi.mocked(rmdir).mockRestore();
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
		if (run < 2) writeFileSync(join(first.snapshotDir, "manifest.json"), "corrupt");
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
	const statePath = outboxStatePath(agent, first.snapshotDir);
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

it("clears a lost harness after a clean reappearance before a later absence", async () => {
	const home = join(root, "home");
	const roots = seedHarnessHome(home);
	const options = { harnesses: ["pi", "claude"] as const, roots, home, env: {} };
	const first = await exportStats(agent, out, undefined, options);
	const manifestPath = join(first.snapshotDir, "manifest.json");
	const statePath = outboxStatePath(agent, first.snapshotDir);
	writeFileSync(manifestPath, "corrupt");
	rmSync(roots.claude, { recursive: true });
	const lost = await exportStats(agent, out, undefined, options);
	expect(lost.harnesses?.claude).toMatchObject({ failed: "lost", consecutiveFailures: 1 });
	expect(manifest(first.snapshotDir).lastGoodAt?.claude).toBeUndefined();

	rmSync(join(agent, "pi-session-kit", "stats-harness-cache.json"), { force: true });
	mkdirSync(roots.claude, { recursive: true });
	vi.mocked(Date.now).mockReturnValue(at("2026-11-03"));
	const restored = await exportStats(agent, out, undefined, options);
	expect(restored.harnesses?.claude).toEqual({ found: true, problems: [] });
	expect(manifest(first.snapshotDir).lastGoodAt?.claude).toBe(Date.now());
	const state = JSON.parse(readFileSync(statePath, "utf8"));
	expect(state.lostHarnesses).not.toContain("claude");
	expect(state.failures.claude).toBeUndefined();

	// No rows survive the clean scan, and the next manifest is unreadable.
	rmSync(roots.claude, { recursive: true });
	writeFileSync(manifestPath, "corrupt");
	vi.mocked(Date.now).mockReturnValue(at("2026-11-04"));
	const absent = await exportStats(agent, out, undefined, options);
	expect(absent.harnesses?.claude).toEqual({ found: false, problems: [] });
	expect(manifest(first.snapshotDir).lastGoodAt?.claude).toBe(Date.now());
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

it.runIf(process.platform !== "win32")("keeps outbox bookkeeping private", async () => {
	const first = await exportStats(agent, out);
	const path = outboxStatePath(agent, first.snapshotDir);
	expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
	expect(statSync(path).mode & 0o777).toBe(0o600);
	// A umask of 077 would hide a dropped mode on disk: the requested modes are the contract.
	expect(mkdir).toHaveBeenCalledWith(dirname(path), { recursive: true, mode: 0o700 });
	expect(writeFile).toHaveBeenCalledWith(
		expect.stringMatching(new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.[0-9a-f-]+\\.tmp$`)),
		expect.any(String),
		{ mode: 0o600 },
	);
});

it.runIf(process.platform !== "win32")("tightens an existing outbox bookkeeping directory to 0700", async () => {
	const outboxes = join(agent, "pi-session-kit", "outboxes");
	mkdirSync(outboxes, { recursive: true, mode: 0o755 });
	chmodSync(outboxes, 0o755);
	const first = await exportStats(agent, out);
	expect(statSync(outboxes).mode & 0o777).toBe(0o700);
	expect(statSync(outboxStatePath(agent, first.snapshotDir)).mode & 0o777).toBe(0o600);
});

it.runIf(process.platform !== "win32")(
	"refuses an outbox bookkeeping directory that is a symlink or not owned",
	async () => {
		const outboxes = join(agent, "pi-session-kit", "outboxes");
		const elsewhere = join(root, "elsewhere");
		mkdirSync(elsewhere, { mode: 0o755 });
		mkdirSync(dirname(outboxes), { recursive: true });
		symlinkSync(elsewhere, outboxes);
		const refusal = `Outbox bookkeeping directory ${JSON.stringify(outboxes)} is not a directory owned by this user; move it aside and retry`;
		await expect(exportStats(agent, out)).rejects.toThrow(refusal);
		expect(readdirSync(elsewhere)).toEqual([]);
		expect(statSync(elsewhere).mode & 0o777).toBe(0o755);
		expect(readdirSync(out, { recursive: true }).filter((file) => String(file).endsWith("manifest.json"))).toEqual([]);
		rmSync(outboxes);
		mkdirSync(outboxes, { mode: 0o755 });
		vi.spyOn(process, "getuid").mockReturnValue((process.getuid?.() ?? 0) + 1);
		await expect(exportStats(agent, out)).rejects.toThrow(refusal);
		expect(statSync(outboxes).mode & 0o777).toBe(0o755);
	},
);

it("leaves outbox bookkeeping permissions to the platform without POSIX ownership", async () => {
	const getuid = process.getuid;
	process.getuid = undefined;
	try {
		const first = await exportStats(agent, out);
		expect(readFileSync(outboxStatePath(agent, first.snapshotDir), "utf8")).toContain('"version":1');
	} finally {
		process.getuid = getuid;
	}
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
	writeFileSync(join(first.snapshotDir, "manifest.json"), "corrupt");
	await exportStats(agent, out);
	for (let i = 0; i < 5; i++) {
		seed(8 + i);
		await exportStats(agent, out);
	}
	const current = manifest(first.snapshotDir);
	const expected = [...new Set(["manifest.json", original.file, ...current.shards.map((ref) => ref.file)])].sort();
	expect(readdirSync(first.snapshotDir).sort()).toEqual(expected);
	const state = JSON.parse(readFileSync(outboxStatePath(agent, first.snapshotDir), "utf8"));
	expect(state.recoveryFiles).toEqual([original.file]);
	expect(state.lostHarnesses).toEqual([]);
});

it.each(["deleted state", "moved outbox"])(
	"keeps frozen recovery files when the outbox's own bookkeeping is lost (%s)",
	async (loss) => {
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
		writeFileSync(join(first.snapshotDir, "manifest.json"), "corrupt");
		await exportStats(agent, out);
		// A readable manifest again: the archived shard is now only in this outbox's frozen recovery set.
		seed(8);
		await exportStats(agent, out);
		expect(manifest(first.snapshotDir).shards.map((ref) => ref.file)).not.toContain(original.file);
		let target = out;
		if (loss === "deleted state") rmSync(outboxStatePath(agent, first.snapshotDir));
		else {
			target = join(root, "moved");
			renameSync(out, target);
		}
		const snapshotDir = join(target, "machines", basename(first.snapshotDir));
		for (let i = 0; i < 2; i++) {
			seed(9 + i);
			const result = await exportStats(agent, target);
			expect(readdirSync(snapshotDir)).toContain(original.file);
			expect(result.warnings).toEqual([
				"recovery files retained: explicit replacement required",
				...(i === 0
					? [
							"no bookkeeping for this outbox: froze 1 unaccounted shard files as recovery files; pass --replace-harnesses to drop them",
						]
					: []),
			]);
		}
		expect(JSON.parse(readFileSync(outboxStatePath(agent, snapshotDir), "utf8")).recoveryFiles).toEqual([
			original.file,
		]);
		// Accepting the loss is explicit.
		await exportStats(agent, target, undefined, { replaceHarnesses: true });
		expect(readdirSync(snapshotDir).sort()).toEqual(
			["manifest.json", ...manifest(snapshotDir).shards.map((ref) => ref.file)].sort(),
		);
	},
);

it("prunes post-recovery generations without losing frozen files to another outbox's stale state", async () => {
	const path = join(agent, "sessions", "active.jsonl");
	const seed = (input: number) => {
		const row = JSON.parse(assistantLine({ ms: Date.now(), provider: "physical", model: "fixture", input }));
		row.id = "active";
		sessionFile(path, { startMs: Date.now(), lines: [JSON.stringify(row)] });
	};
	seed(7);
	const outB = join(root, "out-b");
	const first = await exportStats(agent, out);
	const second = await exportStats(agent, outB);
	const original = manifest(first.snapshotDir).shards[0];
	if (!original) throw new Error("Missing shard");
	writeFileSync(join(first.snapshotDir, "manifest.json"), "corrupt");
	// Barrier: B has read its export state and waits to record it while A freezes recovery.
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	let reached = (): void => {};
	let release = (): void => {};
	const paused = new Promise<void>((resolve) => {
		reached = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let waits = 0;
	vi.mocked(rename).mockImplementation(async (from, to) => {
		if (String(to) === outboxStatePath(agent, second.snapshotDir) && waits++ === 0) {
			reached();
			await gate;
		}
		return actual.rename(from, to);
	});
	const stale = exportStats(agent, outB);
	try {
		// B failing (or finishing) before its checkpoint surfaces here instead of hanging the test.
		await Promise.race([
			paused,
			stale.then(() => {
				throw new Error("B finished before its checkpoint");
			}),
		]);
		await exportStats(agent, out);
	} finally {
		release();
	}
	await stale;
	seed(8);
	await exportStats(agent, out);
	const current = manifest(first.snapshotDir);
	expect(current.shards.map((ref) => ref.file)).not.toContain(original.file);
	expect(readdirSync(first.snapshotDir).sort()).toEqual(
		["manifest.json", original.file, ...current.shards.map((ref) => ref.file)].sort(),
	);
	expect(readdirSync(second.snapshotDir).sort()).toEqual(
		["manifest.json", ...manifest(second.snapshotDir).shards.map((ref) => ref.file)].sort(),
	);
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
		expect(JSON.parse(readFileSync(outboxStatePath(agent, first.snapshotDir), "utf8")).harnesses).toEqual(["pi"]);
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
	writeFileSync(manifestPath, "corrupt");
	const before = readFileSync(manifestPath);
	rmSync(roots.claude, { recursive: true, force: true });
	const statePath = outboxStatePath(agent, first.snapshotDir);
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
	const first = await exportStats(agent, out);
	const path = join(agent, "pi-session-kit", "export-state.json");
	const outbox = outboxStatePath(agent, first.snapshotDir);
	const state = JSON.parse(readFileSync(path, "utf8"));
	for (const key of ["recoveryPending", "recoveryFiles", "lostHarnesses", "historyHarnesses"]) delete state[key];
	writeFileSync(path, JSON.stringify({ ...state, harnesses: ["pi"] }));
	// An outbox without its own bookkeeping inherits the legacy installation-wide fields, then records its own.
	rmSync(outbox);
	await exportStats(agent, out);
	expect(JSON.parse(readFileSync(outbox, "utf8"))).toMatchObject({ harnesses: ["pi"], recoveryPending: false });
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
	const first = await exportStats(agent, out);
	for (const path of [join(agent, "pi-session-kit", "export-state.json"), outboxStatePath(agent, first.snapshotDir)]) {
		const state = readFileSync(path, "utf8");
		writeFileSync(path, JSON.stringify({ ...JSON.parse(state), [String(field)]: value }));
		await expect(exportStats(agent, out)).rejects.toThrow("Invalid export state");
		writeFileSync(path, state);
	}
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
	const legacyPath = join(agent, "pi-session-kit", "export-state.json");
	const statePath = outboxStatePath(agent, first.snapshotDir);
	const state = { ...JSON.parse(readFileSync(legacyPath, "utf8")), ...JSON.parse(readFileSync(statePath, "utf8")) };
	delete state.lostHarnesses;
	state.recoveryFiles = null;
	state.historyHarnesses = null;
	state.recoveryPending = true;
	writeFileSync(legacyPath, JSON.stringify(state));
	rmSync(statePath);
	writeFileSync(join(first.snapshotDir, "manifest.json"), "corrupt");
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

it("compacts sealed deltas without rewriting the base or losing archived calls", async () => {
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
	const latePath = join(agent, "sessions", "archived.jsonl");
	const lateMs = at("2026-10-02");
	sessionFile(latePath, {
		startMs: lateMs,
		lines: [assistantLine({ ms: lateMs, provider: "physical", model: "fixture", input: 500 })],
	});
	await exportStats(agent, out);
	rmSync(latePath);
	// Rebuild the usage cache so the archived call exists only in published history.
	rmSync(join(agent, "pi-session-kit", "stats-cache.json"));
	let peak = 0;
	for (let i = 100; i < 140; i++) {
		if (i === 130) {
			// A valid older manifest need not list its deltas in order of increasing session end.
			const { shards, ...header } = manifest(first.snapshotDir);
			writeFileSync(
				join(first.snapshotDir, "manifest.json"),
				JSON.stringify({
					...header,
					shards: [shards[0], ...shards.slice(1).reverse()],
				}),
			);
		}
		const row = JSON.parse(
			assistantLine({ ms: at("2026-10-01") + i, provider: "physical", model: "fixture", input: i + 1 }),
		);
		row.id = `fixture-${i}`;
		lines.push(JSON.stringify(row));
		sessionFile(path, { startMs: at("2026-10-01"), lines });
		await exportStats(agent, out);
		peak = Math.max(peak, manifest(first.snapshotDir).shards.length);
	}
	const after = manifest(first.snapshotDir);
	expect(peak).toBe(32);
	expect(after.shards).toHaveLength(11);
	expect(after.shards).toContainEqual(ref);
	expect(after.shards.reduce((n, s) => n + s.bytes, 0)).toBeLessThan(ref.bytes + 41 * 256);
	await exportStats(agent, out);
	expect(manifest(first.snapshotDir).shards).toEqual(after.shards);
	expect(readFileSync(join(first.snapshotDir, ref.file))).toEqual(original);
	expect(readdirSync(first.snapshotDir).sort()).toEqual(["manifest.json", ...after.shards.map((s) => s.file)].sort());
	expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
	const imported = await loadCombined(viewer);
	expect(imported.calls.map((call) => call.input)).toEqual([...Array.from({ length: 140 }, (_, i) => i + 1), 500]);
	expect(imported.sessions).toHaveLength(2);
	expect(imported.sessions.map((session) => session.endMs)).toEqual([at("2026-10-01") + 139, lateMs]);
});

it("compacts an already over-cap month missing from the scan and keeps last-good on digest mismatch", async () => {
	const result = await exportStats(agent, out);
	const previous = manifest(result.snapshotDir);
	const month = "2026-10";
	for (let i = 0; i < 33; i++) {
		const bytes = encodeShard({
			version: 3,
			machineId: previous.machineId,
			month,
			events: [],
			sessions: [],
			quota: [
				{
					harness: "pi",
					provider: "fixture",
					limitId: "fixture",
					window: "daily",
					usedPercent: i,
					resetAt: at("2026-10-02"),
					durationMs: 86_400_000,
					observedAt: at("2026-10-01") + i,
					planType: null,
					account: "",
				},
			],
		});
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const file = `${month}-${sha256}.json.gz`;
		writeFileSync(join(result.snapshotDir, file), bytes);
		previous.shards.push({ month, file, sha256, bytes: bytes.length });
	}
	writeFileSync(join(result.snapshotDir, "manifest.json"), JSON.stringify(previous));
	expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
	const oldCache = await readGlobal(viewer);
	const previousFiles = readdirSync(result.snapshotDir).sort();
	vi.mocked(writeFile).mockRejectedValueOnce(Object.assign(new Error("read-only fixture"), { code: "EROFS" }));
	await expect(exportStats(agent, out)).rejects.toThrow("read-only fixture");
	expect(manifest(result.snapshotDir)).toEqual(previous);
	expect(readdirSync(result.snapshotDir).sort()).toEqual(previousFiles);
	await exportStats(agent, out);
	const after = manifest(result.snapshotDir);
	expect(after.shards).toHaveLength(2);
	expect(after.shards[0]).toEqual(previous.shards[0]);
	const compact = after.shards[1];
	if (!compact) throw new Error("Missing compacted shard");
	const path = join(result.snapshotDir, compact.file);
	const bytes = readFileSync(path);
	const corrupt = Buffer.from(bytes);
	corrupt[corrupt.length - 1] = (corrupt.at(-1) ?? 0) ^ 1;
	writeFileSync(path, corrupt);
	expect(await importStats(viewer, out)).toMatchObject({ imported: 0, retained: 1 });
	expect((await readGlobal(viewer)).machines).toEqual(oldCache.machines);
	writeFileSync(path, bytes);
	expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
	expect((await loadCombined(viewer)).quota).toEqual([expect.objectContaining({ usedPercent: 32 })]);
});

async function sealedFixture(rows: Partial<Shard>[]) {
	const { snapshotDir } = await exportStats(agent, out);
	const before = manifest(snapshotDir);
	for (const row of rows) {
		const month = row.month ?? "2026-10";
		const bytes = encodeShard({
			version: 3,
			machineId: before.machineId,
			month,
			events: [],
			sessions: [],
			quota: [],
			...row,
		});
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const file = `${month}-${sha256}.json.gz`;
		writeFileSync(join(snapshotDir, file), bytes);
		before.shards.push({ month, file, sha256, bytes: bytes.length });
	}
	writeFileSync(join(snapshotDir, "manifest.json"), JSON.stringify(before));
	return { before, snapshotDir };
}

const quotaRow = (i: number, resetAt = at("2026-10-03"), limitId = "fixture"): SnapshotQuota => ({
	harness: "pi",
	provider: "physical",
	limitId,
	window: "daily",
	usedPercent: i,
	resetAt,
	durationMs: 86_400_000,
	observedAt: at("2026-10-01") + i,
	planType: null,
	account: "",
});
const filler = Array.from({ length: 30 }, (_, i) => ({ quota: [quotaRow(i, undefined, "filler")] }));
const session = (i: number) => ({
	id: i.toString(16).padStart(64, "0"),
	startMs: at("2026-10-01"),
	endMs: at("2026-10-01"),
	child: false,
});
const event = (i: number, sessionId: string) => {
	const row = {
		harness: "pi" as const,
		entryId: null,
		sessionId,
		ms: at("2026-10-01"),
		provider: "physical",
		model: "fixture",
		input: i,
		output: 2,
		cacheRead: 3,
		cacheWrite: 4,
		cost: i / 8,
	};
	return { id: eventId(row), ...row };
};

it("does not publish if preserving quota winners would exceed the cap", async () => {
	const { before, snapshotDir } = await sealedFixture([
		{},
		...Array.from({ length: 32 }, (_, i) => ({ quota: [quotaRow(i, at("2026-12-01") - i)] })),
	]);
	await expect(exportStats(agent, out)).rejects.toThrow("Sealed month quota history exceeds shard limit");
	expect(manifest(snapshotDir)).toEqual(before);
	expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
});

it("publishes unrelated usage when the sealed base dominates all quota deltas", async () => {
	const { before, snapshotDir } = await sealedFixture([
		{ quota: [quotaRow(99, at("2026-12-02"))] },
		...Array.from({ length: 32 }, (_, i) => ({ quota: [quotaRow(i, at("2026-12-01") - i)] })),
	]);
	const base = before.shards[0];
	if (!base) throw new Error("Missing base");
	const path = join(snapshotDir, base.file);
	const bytes = readFileSync(path);
	sessionFile(join(agent, "sessions", "new.jsonl"), {
		startMs: at("2026-11-01"),
		lines: [assistantLine({ ms: at("2026-11-01"), provider: "physical", model: "fixture", input: 7 })],
	});
	await exportStats(agent, out);
	const after = manifest(snapshotDir);
	expect(after.shards.filter((ref) => ref.month === base.month)).toEqual([base]);
	expect(readFileSync(path)).toEqual(bytes);
	expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
	const combined = await loadCombined(viewer);
	expect(combined.quota).toEqual([quotaRow(99, at("2026-12-02"))]);
	expect(combined.calls.map((row) => row.input)).toEqual([7]);
});

it.each(["2026-10-03", "2026-11-03"])("quota winner changes after reset on %s", async (reset) => {
	// Run compaction both before and after the newer observation expires.
	const earlyReset = at(reset);
	const lateReset = at("2026-12-01");
	const { snapshotDir } = await sealedFixture([
		{ quota: [quotaRow(99, earlyReset, "base")], sessions: [session(101)] },
		{ quota: [quotaRow(99, earlyReset, "base")], sessions: [session(101), session(102)] },
		{ quota: [quotaRow(1, lateReset)] },
		{ quota: [quotaRow(2, earlyReset)] },
		{ quota: [{ ...quotaRow(2, earlyReset), usedPercent: 0 }] },
		...filler,
	]);
	const times = [at("2026-10-02"), earlyReset - 1, earlyReset, lateReset - 1, lateReset, lateReset + 1];
	const read = (dir: string) => Promise.all(times.map(async (now) => (await loadCombined(dir, undefined, now)).quota));
	expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
	const before = await read(viewer);
	expect(before.map((q) => q.find((row) => row.limitId === "fixture")?.usedPercent)).toEqual([2, 2, 1, 1, 2, 2]);
	await exportStats(agent, out);
	expect(manifest(snapshotDir).shards).toHaveLength(3);
	const fresh = join(root, "fresh");
	expect(await importStats(fresh, out)).toMatchObject({ imported: 1, problems: [] });
	expect(await read(fresh)).toEqual(before);
});

it("hands a fresher base reading over to an older, later-resetting delta at the base reset", async () => {
	const baseReset = at("2026-10-03");
	const deltaReset = at("2026-12-01");
	const { before, snapshotDir } = await sealedFixture([
		{ quota: [quotaRow(99, baseReset)] },
		{ quota: [quotaRow(1, deltaReset)] },
		{ quota: [quotaRow(2, at("2026-10-02"))] },
		...filler,
	]);
	const times = [at("2026-10-02"), baseReset - 1, baseReset, baseReset + 1, deltaReset - 1, deltaReset];
	const read = async (dir: string) => {
		expect(await importStats(dir, out)).toMatchObject({ imported: 1, problems: [] });
		return Promise.all(times.map(async (now) => (await loadCombined(dir, undefined, now)).quota));
	};
	const uncompacted = await read(viewer);
	expect(uncompacted.map((rows) => rows.find((row) => row.limitId === "fixture")?.usedPercent)).toEqual([
		99, 99, 1, 1, 1, 99,
	]);
	await exportStats(agent, out);
	const after = manifest(snapshotDir).shards;
	expect(after.length).toBeLessThan(before.shards.length);
	expect(after[0]).toEqual(before.shards[0]);
	expect(await read(join(root, "fresh"))).toEqual(uncompacted);
});

it("keeps reader quota order when compacting a reverse-month manifest", async () => {
	const november = at("2026-11-01");
	vi.mocked(Date.now).mockReturnValue(at("2026-12-01"));
	const { before, snapshotDir } = await sealedFixture([
		{ month: "2026-11", quota: [{ ...quotaRow(5, at("2026-12-01"), "z-november"), observedAt: november }] },
		{ quota: [quotaRow(6, at("2026-10-03"), "a-october")] },
		{ quota: [quotaRow(7, at("2026-10-02"), "a-october")] },
		...filler,
		{ quota: [quotaRow(31, undefined, "filler")] },
	]);
	expect(before.shards.map((ref) => ref.month).slice(0, 2)).toEqual(["2026-11", "2026-10"]);
	const read = async (dir: string) => {
		expect(await importStats(dir, out)).toMatchObject({ imported: 1, problems: [] });
		return Promise.all(
			[at("2026-10-01"), at("2026-10-02"), at("2026-12-01")].map(
				async (now) => (await loadCombined(dir, undefined, now)).quota,
			),
		);
	};
	const uncompacted = await read(viewer);
	await exportStats(agent, out);
	expect(manifest(snapshotDir).shards.length).toBeLessThan(before.shards.length);
	expect(await read(join(root, "fresh"))).toEqual(uncompacted);
	expect(uncompacted.map((rows) => rows.map((row) => row.limitId))).toEqual(
		Array.from({ length: 3 }, () => ["a-october", "filler", "z-november"]),
	);
});

it("preserves equal-timestamp call order and totals across compaction", async () => {
	const meta = session(1);
	const [a, b] = [event(1, meta.id), event(2, meta.id)].sort((a, b) => b.id.localeCompare(a.id));
	if (!a || !b) throw new Error("Missing fixture events");
	await sealedFixture([{ sessions: [meta] }, { events: [a] }, { events: [b] }, ...filler]);
	const read = async (dir: string) => {
		expect(await importStats(dir, out)).toMatchObject({ imported: 1, problems: [] });
		return (await loadCombined(dir)).calls;
	};
	const before = await read(viewer);
	await exportStats(agent, out);
	const after = await read(join(root, "fresh"));
	for (const calls of [before, after]) {
		expect(calls).toHaveLength(2);
		for (const [key, total] of [
			["input", 3],
			["output", 4],
			["cacheRead", 6],
			["cacheWrite", 8],
			["cost", 0.375],
		] as const)
			expect(calls.reduce((sum, call) => sum + (call[key] ?? 0), 0)).toBe(total);
	}
	expect(after).toEqual(before);
});

it("compaction respects machine expansion budget", async () => {
	const dense = session(100);
	const events = Array.from({ length: 8000 }, (_, i) => event(i + 1, dense.id));
	const { before, snapshotDir } = await sealedFixture([
		{ month: "2026-09" },
		{},
		{ events, sessions: [dense] },
		...Array.from({ length: 31 }, (_, i) => ({ sessions: [session(i + 1)] })),
	]);
	const expanded = before.shards.map((ref) => gunzipSync(readFileSync(join(snapshotDir, ref.file))).toString());
	const padding = 128 * 1024 * 1024 - expanded.reduce((sum, json) => sum + Buffer.byteLength(json), 0) - 100;
	// Charge unchanged September's authenticated wire as ballast without allocating 128 MiB per test worker.
	const measure = Buffer.byteLength;
	vi.spyOn(Buffer, "byteLength").mockImplementation(
		(value, encoding) => measure(value, encoding) + (value === expanded[0] ? padding : 0),
	);
	expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
	const orphanBytes = gzipSync(expanded[0] ?? "", { level: 0 });
	const orphanHash = createHash("sha256").update(orphanBytes).digest("hex");
	const orphan = join(snapshotDir, `2026-09-${orphanHash}.json.gz`);
	writeFileSync(orphan, orphanBytes);
	const files = readdirSync(snapshotDir).sort();
	await expect(exportStats(agent, out)).rejects.toThrow("Machine snapshot exceeds 128 MiB expanded");
	expect(manifest(snapshotDir)).toEqual(before);
	expect(readdirSync(snapshotDir).sort()).toEqual(files);
	expect(readFileSync(orphan)).toEqual(orphanBytes);
	expect(await importStats(join(root, "fresh"), out)).toMatchObject({ imported: 1, problems: [] });
});

it("reports one generated shard over 128 MiB expanded as the machine budget and keeps last-good", async () => {
	const { before, snapshotDir } = await sealedFixture([
		{},
		{ quota: [quotaRow(32)] },
		...filler,
		{ quota: [quotaRow(31)] },
	]);
	const sealed = new Set(
		before.shards.map((ref) => gunzipSync(readFileSync(join(snapshotDir, ref.file))).toString("utf8")),
	);
	const files = readdirSync(snapshotDir).sort();
	const original = Buffer.byteLength;
	// Only the newly generated compacted shard is oversized; every sealed shard still fits.
	const measure = vi
		.spyOn(Buffer, "byteLength")
		.mockImplementation((value, encoding) =>
			typeof value === "string" && value.startsWith('{"v":3,') && !sealed.has(value)
				? 128 * 1024 * 1024 + 1
				: original(value, encoding),
		);
	try {
		await expect(exportStats(agent, out)).rejects.toThrow("Machine snapshot exceeds 128 MiB expanded");
	} finally {
		measure.mockRestore();
	}
	expect(manifest(snapshotDir)).toEqual(before);
	expect(readdirSync(snapshotDir).sort()).toEqual(files);
	expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
});

it.each(["partial shard write", "manifest rename"])("keeps the old generation after a %s failure", async (failure) => {
	const { before, snapshotDir } = await sealedFixture([
		{},
		{ quota: [quotaRow(32)] },
		{ quota: [quotaRow(31)] },
		...filler,
	]);
	const path = join(snapshotDir, "manifest.json");
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	const oldFiles = new Set(before.shards.map((ref) => join(snapshotDir, ref.file)));
	let unpublished: string | undefined;
	vi.mocked(writeFile).mockImplementation(async (file, data, options) => {
		if (String(file).endsWith(".json.gz") && !oldFiles.has(String(file))) {
			unpublished = String(file);
			if (failure === "partial shard write" && Buffer.isBuffer(data)) {
				await actual.writeFile(file, data.subarray(0, 7), options);
				throw new Error(failure);
			}
		}
		await actual.writeFile(file, data, options);
	});
	vi.mocked(rename).mockImplementation(async (from, to) => {
		if (to === path && failure === "manifest rename") throw new Error(failure);
		await actual.rename(from, to);
	});
	await expect(exportStats(agent, out)).rejects.toThrow(failure);
	if (!unpublished) throw new Error("No new compacted shard was written");
	const bytes = readFileSync(unpublished);
	if (failure === "partial shard write") expect(bytes.length).toBe(7);
	else expect(() => gunzipSync(bytes)).not.toThrow();
	expect(manifest(snapshotDir)).toEqual(before);
	expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
	vi.mocked(rename).mockRestore();
	vi.mocked(writeFile).mockRestore();
	await exportStats(agent, out);
	expect(manifest(snapshotDir).shards.length).toBeLessThan(before.shards.length);
	expect(await importStats(join(root, "fresh"), out)).toMatchObject({ imported: 1, problems: [] });
});

it.each(["previous manifest read", "manifest rename", "pruning", "state recording"])(
	"holds the export lock during %s",
	async (checkpoint) => {
		const seed = (input: number) =>
			sessionFile(join(agent, "sessions", "active.jsonl"), {
				startMs: at("2026-11-01"),
				lines: [assistantLine({ ms: at("2026-11-01"), provider: "physical", model: "fixture", input })],
			});
		seed(3);
		const first = await exportStats(agent, out);
		const path = join(first.snapshotDir, "manifest.json");
		const stale = manifest(first.snapshotDir).shards[0];
		if (!stale) throw new Error("Missing obsolete shard");
		const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		let pause!: () => void;
		const paused = new Promise<void>((resolve) => {
			pause = resolve;
		});
		let resume!: () => void;
		const release = new Promise<void>((resolve) => {
			resume = resolve;
		});
		let blocked = false;
		const barrier = async () => {
			if (blocked) return;
			blocked = true;
			pause();
			await release;
		};
		vi.mocked(readFile).mockImplementation(async (...args) => {
			if (checkpoint === "previous manifest read" && args[0] === path) await barrier();
			return actual.readFile(...args);
		});
		vi.mocked(rename).mockImplementation(async (from, to) => {
			if (checkpoint === "manifest rename" && to === path) await barrier();
			if (checkpoint === "state recording" && to === outboxStatePath(agent, first.snapshotDir)) await barrier();
			await actual.rename(from, to);
		});
		vi.mocked(unlink).mockImplementation(async (file) => {
			if (checkpoint === "pruning" && file === join(first.snapshotDir, stale.file)) await barrier();
			await actual.unlink(file);
		});
		seed(7);
		const a = exportStats(agent, out);
		try {
			await Promise.race([paused, a]);
			expect(blocked).toBe(true);
			await expect(exportStats(agent, out)).rejects.toMatchObject({
				code: "EEXIST",
				path: join(first.snapshotDir, ".export.lock"),
			});
		} finally {
			resume();
			await a;
		}
		expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
		expect((await loadCombined(viewer)).calls.map((call) => call.input)).toEqual([7]);
		seed(13);
		await exportStats(agent, out);
		expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
		expect((await loadCombined(viewer)).calls.map((call) => call.input)).toEqual([13]);
	},
);

it("fails closed when a racing writer releases its lock before the age check", async () => {
	const { snapshotDir } = await exportStats(agent, out);
	const lock = join(snapshotDir, ".export.lock");
	mkdirSync(lock);
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	vi.mocked(lstat).mockImplementation(async (path, options) => {
		if (path === lock) await actual.rmdir(lock);
		return actual.lstat(path, options);
	});
	await expect(exportStats(agent, out)).rejects.toMatchObject({
		code: "EEXIST",
		message: expect.stringContaining(`Export lock is held at ${JSON.stringify(lock)} (age unknown); retry`),
	});
	await expect(exportStats(agent, out)).resolves.toMatchObject({ snapshotDir });
});

it("surfaces a lock inspection failure other than a release race", async () => {
	const { snapshotDir } = await exportStats(agent, out);
	const lock = join(snapshotDir, ".export.lock");
	mkdirSync(lock);
	const denied = Object.assign(new Error("stat denied"), { code: "EACCES" });
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	vi.mocked(lstat).mockImplementation(async (path, options) => {
		if (path === lock) throw denied;
		return actual.lstat(path, options);
	});
	await expect(exportStats(agent, out)).rejects.toMatchObject({
		code: "EACCES",
		path: lock,
		cause: denied,
		message: `Export lock exists at ${JSON.stringify(lock)} but could not be inspected (EACCES); verify no export is running before removing the lock directory`,
	});
});

it("preserves non-contention errors when acquiring the lock", async () => {
	const { snapshotDir } = await exportStats(agent, out);
	const lock = join(snapshotDir, ".export.lock");
	const denied = Object.assign(new Error("lock denied"), { code: "EACCES" });
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	vi.mocked(mkdir).mockImplementation(async (path, options) => {
		if (path === lock) throw denied;
		return actual.mkdir(path, options);
	});
	await expect(exportStats(agent, out)).rejects.toBe(denied);
});

it.each(["published", "failed"])("keeps the %s export outcome when unlocking fails", async (outcome) => {
	const ms = at("2026-11-01");
	sessionFile(join(agent, "sessions", "new.jsonl"), {
		startMs: ms,
		lines: [assistantLine({ ms, provider: "physical", model: "fixture", input: 7 })],
	});
	const denied = Object.assign(new Error("unlock denied"), { code: "EACCES" });
	let shardsAtUnlock: number | undefined;
	let lock = "";
	vi.mocked(rmdir).mockImplementationOnce(async (path) => {
		lock = String(path);
		if (outcome === "published") shardsAtUnlock = manifest(dirname(lock)).shards.length;
		throw denied;
	});
	if (outcome === "failed") {
		const failure = new Error("manifest rename failed");
		const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		vi.mocked(rename).mockImplementation(async (from, to) => {
			if (basename(String(to)) === "manifest.json") throw failure;
			await actual.rename(from, to);
		});
		const error = await exportStats(agent, out).then(
			() => undefined,
			(reason: unknown) => reason,
		);
		// The primary failure stays first; the unlock failure is a named secondary diagnostic.
		expect(error).toBeInstanceOf(AggregateError);
		expect(error).toMatchObject({ errors: [failure, denied], cause: failure });
		expect((error as Error).message).toBe(
			`Error: manifest rename failed\ncould not release export lock ${JSON.stringify(lock)}; check permissions and remove it only after verifying no export is running`,
		);
	} else {
		const result = await exportStats(agent, out);
		expect(shardsAtUnlock).toBe(1);
		expect(result.warnings).toEqual([
			expect.stringContaining(
				`could not release export lock ${JSON.stringify(join(result.snapshotDir, ".export.lock"))}`,
			),
		]);
		expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
		expect((await loadCombined(viewer)).calls.map((row) => row.input)).toEqual([7]);
	}
	expect(rmdir).toHaveBeenCalledOnce();
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

it("clock rollback preserves sealed history", async () => {
	const path = join(agent, "sessions", "fixture.jsonl");
	vi.mocked(Date.now).mockReturnValue(at("2026-10-20"));
	sessionFile(path, {
		startMs: at("2026-10-20"),
		lines: [assistantLine({ ms: at("2026-10-20"), provider: "physical", model: "fixture", input: 7 })],
	});
	const first = await exportStats(agent, out);
	// November seals October; the archived call then exists only in published history.
	vi.mocked(Date.now).mockReturnValue(at("2026-11-02"));
	await exportStats(agent, out);
	const sealed = readFileSync(join(first.snapshotDir, "manifest.json"));
	const files = readdirSync(first.snapshotDir).sort();
	rmSync(path);
	rmSync(join(agent, "pi-session-kit", "stats-cache.json"));
	vi.mocked(Date.now).mockReturnValue(at("2026-10-25"));
	await expect(exportStats(agent, out)).rejects.toThrow("Clock is behind the last published export");
	expect(readFileSync(join(first.snapshotDir, "manifest.json"))).toEqual(sealed);
	expect(readdirSync(first.snapshotDir).sort()).toEqual(files);
	expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
	expect((await loadCombined(viewer)).calls.map((call) => call.input)).toEqual([7]);
	// An explicit replacement is the owner's way past a clock that ran ahead.
	await exportStats(agent, out, undefined, { replaceHarnesses: true });
	expect(manifest(first.snapshotDir).exportedAt).toBe(at("2026-10-25"));
});

it("refuses a same-month clock rollback before the scan, salt or bookkeeping can write", async () => {
	const path = join(agent, "sessions", "fixture.jsonl");
	const line = (input: number) =>
		assistantLine({ ms: at("2026-11-01"), provider: "physical", model: "fixture", input });
	sessionFile(path, { startMs: at("2026-11-01"), lines: [line(7)] });
	const first = await exportStats(agent, out);
	// Exact equality is not a rollback.
	await exportStats(agent, out);
	const files = (): Record<string, Buffer | undefined> => {
		const read = (file: string) => {
			try {
				return readFileSync(file);
			} catch {
				return undefined;
			}
		};
		return {
			cache: read(join(agent, "pi-session-kit", "stats-cache.json")),
			salt: read(join(agent, "pi-session-kit", "export-state.json")),
			bookkeeping: read(outboxStatePath(agent, first.snapshotDir)),
			manifest: read(join(first.snapshotDir, "manifest.json")),
		};
	};
	// A changed transcript would make the loader rewrite its cache, and a missing salt would be created.
	sessionFile(path, { startMs: at("2026-11-01"), lines: [line(7), line(8)] });
	rmSync(join(agent, "pi-session-kit", "export-state.json"));
	const before = files();
	expect(before.cache && before.bookkeeping && before.manifest && !before.salt).toBeTruthy();
	vi.mocked(Date.now).mockReturnValue(at("2026-11-02") - 1);
	const behind = new Date(at("2026-11-02") - 1).toISOString();
	const published = new Date(at("2026-11-02")).toISOString();
	await expect(exportStats(agent, out)).rejects.toThrow(
		`Clock is behind the last published export (${behind} < ${published}); refusing to reopen sealed months. ` +
			"Fix the clock, or pass --replace-harnesses to publish anyway: that drops sealed history absent from " +
			"this scan, and viewers that imported the newer snapshot keep it and never import this replacement; they " +
			`accept this machine again only from a later export timestamped at or after ${published}`,
	);
	expect(files()).toEqual(before);
	vi.mocked(Date.now).mockReturnValue(at("2026-11-02"));
	await exportStats(agent, out);
	expect(manifest(first.snapshotDir).exportedAt).toBe(at("2026-11-02"));
});

it("checks and publishes one export instant taken before the published manifest is read", async () => {
	sessionFile(join(agent, "sessions", "fixture.jsonl"), {
		startMs: at("2026-11-01"),
		lines: [assistantLine({ ms: at("2026-11-01"), provider: "physical", model: "fixture", input: 7 })],
	});
	const first = await exportStats(agent, out);
	const manifestPath = join(first.snapshotDir, "manifest.json");
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	// The clock moves while the manifest is read: a later capture or a second read would see it.
	const advanceDuringRead = (to: number) =>
		vi.mocked(readFile).mockImplementation(async (path, options) => {
			if (path === manifestPath) vi.mocked(Date.now).mockReturnValue(to);
			return actual.readFile(path, options);
		});
	vi.mocked(Date.now).mockReturnValue(at("2026-11-02") - 1);
	advanceDuringRead(at("2026-11-03"));
	await expect(exportStats(agent, out)).rejects.toThrow("Clock is behind the last published export");
	vi.mocked(Date.now).mockReturnValue(at("2026-11-04"));
	advanceDuringRead(at("2026-11-05"));
	await exportStats(agent, out);
	expect(manifest(first.snapshotDir)).toMatchObject({
		exportedAt: at("2026-11-04"),
		lastGoodAt: { pi: at("2026-11-04") },
	});
});

it.each(["bookkeeping kept", "bookkeeping lost", "no shards"])(
	"treats a deleted manifest as lost history, not a first export (%s)",
	async (variant) => {
		const path = join(agent, "sessions", "fixture.jsonl");
		vi.mocked(Date.now).mockReturnValue(at("2026-10-20"));
		if (variant !== "no shards")
			sessionFile(path, {
				startMs: at("2026-10-20"),
				lines: [assistantLine({ ms: at("2026-10-20"), provider: "physical", model: "fixture", input: 7 })],
			});
		const first = await exportStats(agent, out);
		// November seals October; the archived call then exists only in published history.
		vi.mocked(Date.now).mockReturnValue(at("2026-11-02"));
		await exportStats(agent, out);
		rmSync(path, { force: true });
		rmSync(join(agent, "pi-session-kit", "stats-cache.json"), { force: true });
		const statePath = outboxStatePath(agent, first.snapshotDir);
		if (variant === "bookkeeping lost") rmSync(statePath);
		rmSync(join(first.snapshotDir, "manifest.json"));
		const files = readdirSync(first.snapshotDir).sort();
		expect(files.length > 0 || variant === "no shards").toBe(true);
		const state = variant === "bookkeeping lost" ? undefined : readFileSync(statePath);
		vi.mocked(Date.now).mockReturnValue(at("2026-11-03"));
		await expect(exportStats(agent, out)).rejects.toThrow(
			`Published usage manifest is missing from ${JSON.stringify(first.snapshotDir)}, but this outbox published ` +
				"before (its bookkeeping or shard files remain); restore manifest.json from the sync checkout, " +
				"or pass --replace-harnesses to publish without that history",
		);
		expect(readdirSync(first.snapshotDir).sort()).toEqual(files);
		if (state) expect(readFileSync(statePath)).toEqual(state);
		else expect(existsSync(statePath)).toBe(false);
		// Accepting the loss is explicit.
		await exportStats(agent, out, undefined, { replaceHarnesses: true });
		expect(manifest(first.snapshotDir).shards).toEqual([]);
	},
);

it("publishes a genuinely first export with no manifest, bookkeeping or shards", async () => {
	sessionFile(join(agent, "sessions", "fixture.jsonl"), {
		startMs: at("2026-11-01"),
		lines: [assistantLine({ ms: at("2026-11-01"), provider: "physical", model: "fixture", input: 7 })],
	});
	const result = await exportStats(agent, out);
	expect(result.warnings).toBeUndefined();
	expect(manifest(result.snapshotDir).shards).toHaveLength(1);
});

it.each(["corrupt", "missing"])("keeps the active manifest when one shard among intact ones is %s", async (damage) => {
	const path = join(agent, "sessions", "fixture.jsonl");
	const months = ["2026-08-10", "2026-09-10", "2026-10-10"];
	sessionFile(path, {
		startMs: at("2026-08-10"),
		lines: months.map((day, i) => {
			const row = JSON.parse(assistantLine({ ms: at(day), provider: "physical", model: "fixture", input: i + 1 }));
			row.id = `fixture-${i}`;
			return JSON.stringify(row);
		}),
	});
	const first = await exportStats(agent, out);
	const published = manifest(first.snapshotDir);
	expect(published.shards.map((ref) => ref.month)).toEqual(["2026-08", "2026-09", "2026-10"]);
	// The archived calls now exist only in published history.
	rmSync(path);
	rmSync(join(agent, "pi-session-kit", "stats-cache.json"));
	const bad = published.shards[1];
	if (!bad) throw new Error("Missing shard");
	const backup = readFileSync(join(first.snapshotDir, bad.file));
	if (damage === "missing") rmSync(join(first.snapshotDir, bad.file));
	else writeFileSync(join(first.snapshotDir, bad.file), "corrupt");
	const before = readFileSync(join(first.snapshotDir, "manifest.json"));
	const files = readdirSync(first.snapshotDir).sort();
	vi.mocked(Date.now).mockReturnValue(at("2026-11-03"));
	await expect(exportStats(agent, out)).rejects.toThrow(
		`Published usage history is unreadable (${bad.file}); restore it from the sync checkout, or pass --replace-harnesses to publish without it`,
	);
	expect(readFileSync(join(first.snapshotDir, "manifest.json"))).toEqual(before);
	expect(readdirSync(first.snapshotDir).sort()).toEqual(files);
	// Restoring the shard is enough: the next export publishes over intact history again.
	writeFileSync(join(first.snapshotDir, bad.file), backup);
	await exportStats(agent, out);
	expect(manifest(first.snapshotDir).shards).toEqual(published.shards);
	expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
	expect((await loadCombined(viewer)).calls.map((call) => call.input)).toEqual([1, 2, 3]);
});

it("reports published history over the expansion budget apart from files to restore", async () => {
	const path = join(agent, "sessions", "fixture.jsonl");
	sessionFile(path, {
		startMs: at("2026-09-10"),
		lines: ["2026-09-10", "2026-10-10"].map((day, i) =>
			assistantLine({ ms: at(day), provider: "physical", model: "fixture", input: i + 1 }),
		),
	});
	const first = await exportStats(agent, out);
	const before = readFileSync(join(first.snapshotDir, "manifest.json"));
	const files = readdirSync(first.snapshotDir).sort();
	const ref = manifest(first.snapshotDir).shards[0];
	if (!ref) throw new Error("Missing shard");
	const text = gunzipSync(readFileSync(join(first.snapshotDir, ref.file))).toString("utf8");
	const measure = Buffer.byteLength;
	// Charge one intact shard past the bound without allocating 128 MiB.
	const spy = vi
		.spyOn(Buffer, "byteLength")
		.mockImplementation((value, encoding) => (value === text ? 128 * 1024 * 1024 + 1 : measure(value, encoding)));
	try {
		await expect(exportStats(agent, out)).rejects.toThrow(
			`Published usage history exceeds the 128 MiB expanded machine budget (from ${ref.file}); those files ` +
				"match the manifest, so restoring them will not help: pass --replace-harnesses to publish without it",
		);
	} finally {
		spy.mockRestore();
	}
	expect(readFileSync(join(first.snapshotDir, "manifest.json"))).toEqual(before);
	expect(readdirSync(first.snapshotDir).sort()).toEqual(files);
});

it("names every unreadable shard and replaces history only when the owner asks", async () => {
	const path = join(agent, "sessions", "fixture.jsonl");
	sessionFile(path, {
		startMs: at("2026-09-10"),
		lines: ["2026-09-10", "2026-10-10"].map((day, i) =>
			assistantLine({ ms: at(day), provider: "physical", model: "fixture", input: i + 1 }),
		),
	});
	const first = await exportStats(agent, out);
	const refs = manifest(first.snapshotDir).shards;
	for (const ref of refs) writeFileSync(join(first.snapshotDir, ref.file), "corrupt");
	await expect(exportStats(agent, out)).rejects.toThrow(
		`Published usage history is unreadable (${refs.map((ref) => ref.file).join(", ")})`,
	);
	const replaced = await exportStats(agent, out, undefined, { replaceHarnesses: true });
	expect(replaced.warnings ?? []).toEqual([]);
	expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
	expect((await loadCombined(viewer)).calls.map((call) => call.input)).toEqual([1, 2]);
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
	await expect(exportStats(agent, out)).rejects.toThrow(`Published usage history is unreadable (${ref.file})`);
	await exportStats(agent, out, undefined, { replaceHarnesses: true });
	expect(readFileSync(path)).toEqual(original);
	expect(await importStats(viewer, out)).toMatchObject({ imported: 1, problems: [] });
});
