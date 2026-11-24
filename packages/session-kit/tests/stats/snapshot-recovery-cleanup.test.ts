import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cleanRecovery,
	ExportRefusal,
	encodeShard,
	eventId,
	exportStats,
	importStats,
	type Manifest,
	machineIdentity,
	type Shard,
	type SnapshotEvent,
	type SnapshotQuota,
	type SnapshotSession,
} from "../../src/stats/snapshot.ts";
import { assistantLine, at, outboxStatePath, sessionFile } from "../fixtures/stats/fixtures.ts";

vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return { ...actual, lstat: vi.fn(actual.lstat), rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink) };
});

let root: string;
let agent: string;
let out: string;
let machineId: string;
let snapshotDir: string;
beforeEach(async ({ onTestFinished }) => {
	root = makeTestTempDir("stats-recovery-cleanup-", onTestFinished);
	agent = join(root, "agent");
	out = join(root, "out");
	vi.spyOn(Date, "now").mockReturnValue(at("2026-11-02"));
	machineId = (await machineIdentity(agent)).machineId;
	snapshotDir = join(out, "machines", machineId);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(lstat).mockRestore();
	vi.mocked(rename).mockRestore();
	vi.mocked(unlink).mockRestore();
});

const MONTH = "2026-10";
const missingOrDamaged =
	"Recovery cleanup refused: the active manifest or a shard it references is missing, denied or damaged; " +
	"restore the manifest, the referenced shards or read access, then retry; nothing was removed";
const hex = (seed: string): string => createHash("sha256").update(seed).digest("hex");
const SESSION = hex("session");
const manifestOf = (): Manifest => JSON.parse(readFileSync(join(snapshotDir, "manifest.json"), "utf8")) as Manifest;
const stateOf = () => JSON.parse(readFileSync(outboxStatePath(agent, snapshotDir), "utf8"));

function event(input: number, over: Partial<Omit<SnapshotEvent, "id">> = {}): SnapshotEvent {
	const e = {
		harness: "pi" as const,
		entryId: hex(`entry-${input}`).slice(0, 24),
		sessionId: SESSION,
		ms: at("2026-10-10"),
		provider: "physical",
		model: "fixture",
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		...over,
	};
	return { id: eventId(e), ...e };
}
function session(over: Partial<SnapshotSession> = {}): SnapshotSession {
	return { id: SESSION, startMs: at("2026-10-10", 1), endMs: at("2026-10-10", 20), child: false, ...over };
}
function quota(over: Partial<SnapshotQuota> = {}): SnapshotQuota {
	return {
		harness: "codex",
		provider: "openai",
		limitId: "codex",
		window: "primary",
		usedPercent: 10,
		resetAt: at("2026-10-12"),
		durationMs: 3_600_000,
		observedAt: at("2026-10-11"),
		planType: null,
		account: "",
		...over,
	};
}
function shard(rows: Partial<Pick<Shard, "events" | "sessions" | "quota">>): Shard {
	return { version: 3, machineId, month: MONTH, events: [], sessions: [], quota: [], ...rows };
}
/** Write `s` under its content address and return its manifest reference. */
function write(s: Shard): Manifest["shards"][number] {
	const bytes = encodeShard(s);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const file = `${MONTH}-${sha256}.json.gz`;
	mkdirSync(snapshotDir, { recursive: true });
	writeFileSync(join(snapshotDir, file), bytes);
	return { month: MONTH, file, sha256, bytes: bytes.length };
}
/** Publish `active` as this machine's v3 manifest. */
function publish(active: Shard[], over: Partial<Manifest> = {}): void {
	mkdirSync(snapshotDir, { recursive: true });
	const manifest = {
		version: 3,
		machineId,
		label: "fixture",
		exportedAt: Date.now(),
		lastGoodAt: {},
		shards: active.map(write),
		...over,
	};
	writeFileSync(join(snapshotDir, "manifest.json"), JSON.stringify(manifest));
}
/** This outbox's own bookkeeping, as an export records it. */
function bookkeeping(recoveryFiles: string[] | null, over: Record<string, unknown> = {}): void {
	const path = outboxStatePath(agent, snapshotDir);
	mkdirSync(join(agent, "pi-session-kit", "outboxes"), { recursive: true, mode: 0o700 });
	writeFileSync(
		path,
		JSON.stringify({
			version: 1,
			harnesses: ["pi"],
			failures: {},
			recoveryPending: true,
			recoveryFiles,
			lostHarnesses: [],
			historyHarnesses: ["pi"],
			...over,
		}),
	);
}
const activeShard = (): Shard =>
	shard({
		events: [event(1), event(2)],
		sessions: [session()],
		quota: [quota()],
	});

describe("cleanRecovery", () => {
	it("removes a generation frozen at an unreadable manifest once its successor covers it", async () => {
		const path = join(agent, "sessions", "active.jsonl");
		const first = assistantLine({ ms: at("2026-11-02", 1), provider: "physical", model: "fixture", input: 7 });
		sessionFile(path, { startMs: at("2026-11-02", 1), lines: [first] });
		await exportStats(agent, out);
		const superseded = manifestOf().shards[0]?.file;
		const second = assistantLine({ ms: at("2026-11-02", 2), provider: "physical", model: "fixture", input: 8 });
		sessionFile(path, { startMs: at("2026-11-02", 1), lines: [first, second] });
		writeFileSync(join(snapshotDir, "manifest.json"), "corrupt");
		vi.mocked(Date.now).mockReturnValue(at("2026-11-02", 3));
		expect((await exportStats(agent, out)).warnings).toEqual([
			expect.stringMatching(/^no readable published manifest bounds this export \(manifest\.json unreadable\)/),
			"recovery files retained: run clean-recovery to remove those the active snapshot covers",
		]);
		expect(stateOf().recoveryFiles).toEqual([superseded]);

		const result = await cleanRecovery(agent, out);
		expect(result).toEqual({ machineId, snapshotDir, removed: [superseded], failed: [], kept: [] });
		expect(readdirSync(snapshotDir).sort()).toEqual(
			["manifest.json", ...manifestOf().shards.map((r) => r.file)].sort(),
		);
		expect(stateOf()).toMatchObject({ recoveryPending: false, recoveryFiles: [] });
		expect(existsSync(join(snapshotDir, ".export.lock"))).toBe(false);
		expect((await exportStats(agent, out)).warnings).toBeUndefined();
		expect(await importStats(join(root, "viewer"), out)).toMatchObject({ imported: 1, problems: [] });
	});

	it("keeps a frozen generation holding a call the active snapshot corrected", async () => {
		const path = join(agent, "sessions", "active.jsonl");
		const seed = (input: number) => {
			const row = JSON.parse(assistantLine({ ms: Date.now(), provider: "physical", model: "fixture", input }));
			row.id = "active";
			sessionFile(path, { startMs: Date.now(), lines: [JSON.stringify(row)] });
		};
		seed(7);
		await exportStats(agent, out);
		const original = manifestOf().shards[0]?.file;
		writeFileSync(join(snapshotDir, "manifest.json"), "corrupt");
		seed(8);
		await exportStats(agent, out);
		const state = readFileSync(outboxStatePath(agent, snapshotDir));
		expect(await cleanRecovery(agent, out)).toMatchObject({
			removed: [],
			kept: [{ file: original, reason: "not covered" }],
		});
		expect(readdirSync(snapshotDir)).toContain(original);
		expect(readFileSync(outboxStatePath(agent, snapshotDir))).toEqual(state);
	});

	it.each([
		[
			"a subset of the active rows",
			() => shard({ events: [event(1)], sessions: [session({ endMs: at("2026-10-10", 3) })] }),
			true,
		],
		["the same quota reading", () => shard({ quota: [quota()] }), true],
		[
			"an older reading that resets no later",
			() => shard({ quota: [quota({ observedAt: at("2026-10-10"), usedPercent: 5 })] }),
			true,
		],
		["a cost the active event lacks", () => shard({ events: [event(1, { cost: 0.5 })], sessions: [session()] }), false],
		["an event the active snapshot lacks", () => shard({ events: [event(3)], sessions: [session()] }), false],
		["an unknown session", () => shard({ sessions: [session({ id: hex("other") })] }), false],
		["an earlier session start", () => shard({ sessions: [session({ startMs: at("2026-10-10", 0) })] }), false],
		["a later session end", () => shard({ sessions: [session({ endMs: at("2026-10-10", 21) })] }), false],
		["a child marker the active session lacks", () => shard({ sessions: [session({ child: true })] }), false],
		["a quota window the active snapshot lacks", () => shard({ quota: [quota({ window: "secondary" })] }), false],
		[
			"a fresher quota reading",
			() => shard({ quota: [quota({ observedAt: at("2026-10-11", 13), usedPercent: 20 })] }),
			false,
		],
		[
			"an older reading that resets later",
			() => shard({ quota: [quota({ observedAt: at("2026-10-10"), resetAt: at("2026-10-13") })] }),
			false,
		],
	])("decides coverage of a frozen shard with %s", async (_, frozen, covered) => {
		publish([activeShard()]);
		const { file } = write(frozen());
		bookkeeping([file]);
		const result = await cleanRecovery(agent, out);
		expect(result.removed).toEqual(covered ? [file] : []);
		expect(result.kept).toEqual(covered ? [] : [{ file, reason: "not covered" }]);
		expect(existsSync(join(snapshotDir, file))).toBe(!covered);
		expect(stateOf()).toMatchObject({ recoveryPending: !covered, recoveryFiles: covered ? [] : [file] });
	});

	it.each([
		["the retired row the active snapshot keeps", 2, true],
		["a retired row the active snapshot lacks", 3, false],
	])("decides coverage of a frozen lineage shard with %s", async (_, input, covered) => {
		const live = { ...event(1, { entryId: null }), origin: 0 };
		const retiredRow = (n: number) => ({
			...event(n, { entryId: null }),
			successor: live.id,
			reason: "revised" as const,
		});
		publish([{ ...shard({ events: [live], sessions: [session()] }), version: 4, retired: [retiredRow(2)] }]);
		const { file } = write({ ...shard({}), version: 4, retired: [retiredRow(input)] });
		bookkeeping([file]);
		const result = await cleanRecovery(agent, out);
		expect(result.removed).toEqual(covered ? [file] : []);
		expect(result.kept).toEqual(covered ? [] : [{ file, reason: "not covered" }]);
	});

	it.each([
		// A pre-lineage frozen v3 row carries no origin; the same call is now published with one.
		[
			"a pre-lineage row now published with an origin",
			(row: SnapshotEvent) => shard({ events: [row], sessions: [session()] }),
			true,
		],
		// The active snapshot retired the frozen counted row: it is held there as a recorded replacement.
		[
			"a counted row the active snapshot retired",
			() => shard({ events: [event(2, { entryId: null })], sessions: [session()] }),
			true,
		],
		[
			"a counted row with another cost",
			(row: SnapshotEvent) => shard({ events: [{ ...row, cost: 1 }], sessions: [session()] }),
			false,
		],
	])("decides coverage of a frozen shard with %s", async (_, frozen, covered) => {
		const row = event(1, { entryId: null });
		const live = { ...row, origin: 0 };
		const retiredRow = { ...event(2, { entryId: null }), successor: live.id, reason: "revised" as const };
		publish([{ ...shard({ events: [live], sessions: [session()] }), version: 4, retired: [retiredRow] }]);
		const { file } = write(frozen(row));
		bookkeeping([file]);
		const result = await cleanRecovery(agent, out);
		expect(result.removed).toEqual(covered ? [file] : []);
		expect(result.kept).toEqual(covered ? [] : [{ file, reason: "not covered" }]);
	});

	it("keeps active, missing, legacy and unreadable frozen files with their reasons", async () => {
		publish([activeShard()]);
		const active = manifestOf().shards[0]?.file as string;
		const redundant = write(shard({ events: [event(2)], sessions: [session()] })).file;
		const corrupt = write(shard({ events: [event(1)], sessions: [session()] })).file;
		const bytes = readFileSync(join(snapshotDir, corrupt));
		writeFileSync(join(snapshotDir, corrupt), Buffer.concat([bytes, Buffer.from([0])]));
		const missing = `${MONTH}-${hex("missing")}.json.gz`;
		const legacy = `${MONTH}-${hex("legacy")}.json`;
		writeFileSync(join(snapshotDir, legacy), "{}");
		bookkeeping([active, missing, legacy, corrupt, redundant]);
		const result = await cleanRecovery(agent, out);
		expect(result.removed).toEqual([redundant]);
		expect(result.kept).toEqual([
			{ file: active, reason: "active" },
			{ file: missing, reason: "missing" },
			{ file: legacy, reason: "legacy" },
			{ file: corrupt, reason: "unreadable" },
		]);
		expect(stateOf()).toMatchObject({ recoveryPending: true, recoveryFiles: [active, missing, legacy, corrupt] });
		expect(readdirSync(snapshotDir).sort()).toEqual([active, corrupt, legacy, "manifest.json"].sort());
	});

	it.runIf(process.platform !== "win32")("never follows a frozen name that is a symlink", async () => {
		publish([activeShard()]);
		// Named by the target's real content address: a reader that followed the link would find it redundant.
		const bytes = encodeShard(shard({ events: [event(1)], sessions: [session()] }));
		const target = join(root, "elsewhere.json.gz");
		writeFileSync(target, bytes);
		const linked = `${MONTH}-${createHash("sha256").update(bytes).digest("hex")}.json.gz`;
		symlinkSync(target, join(snapshotDir, linked));
		bookkeeping([linked]);
		expect((await cleanRecovery(agent, out)).kept).toEqual([{ file: linked, reason: "unreadable" }]);
		expect(existsSync(join(snapshotDir, linked))).toBe(true);
		expect(existsSync(target)).toBe(true);
	});

	it("leaves a frozen set alone when nothing is redundant, even with recovery not pending", async () => {
		publish([activeShard()]);
		const active = manifestOf().shards[0]?.file as string;
		bookkeeping([active], { recoveryPending: false });
		const before = readFileSync(outboxStatePath(agent, snapshotDir));
		expect(await cleanRecovery(agent, out)).toEqual({
			machineId,
			snapshotDir,
			removed: [],
			failed: [],
			kept: [{ file: active, reason: "active" }],
		});
		expect(readFileSync(outboxStatePath(agent, snapshotDir))).toEqual(before);
	});

	it("keeps a file whose unlink failed protected and warns with errno counts only", async () => {
		// No quota rows: the follow-up pi export must not refuse a narrower harness set.
		publish([shard({ events: [event(1), event(2)], sessions: [session()] })]);
		const kept = write(shard({ events: [event(9)], sessions: [session()] })).file;
		const busy = write(shard({ events: [event(1)], sessions: [session()] })).file;
		const gone = write(shard({ events: [event(2)], sessions: [session()] })).file;
		bookkeeping([kept, busy, gone]);
		const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		vi.mocked(unlink).mockImplementation(async (path) => {
			if (String(path).endsWith(busy)) throw Object.assign(new Error("secret path"), { code: "EACCES" });
			if (String(path).endsWith(gone)) await actual.unlink(path);
			return actual.unlink(path);
		});
		const result = await cleanRecovery(agent, out);
		expect(result.removed).toEqual([gone]);
		expect(result.failed).toEqual([busy]);
		expect(result.warnings).toEqual(["redundant recovery file removal failed (they stay protected): EACCES=1"]);
		expect(stateOf().recoveryFiles).toEqual([kept, busy]);
		vi.mocked(unlink).mockImplementation(actual.unlink);
		await exportStats(agent, out);
		expect(readdirSync(snapshotDir)).toContain(busy);
		expect(readdirSync(snapshotDir)).toContain(kept);
	});

	it("tolerates the stale name left when the shrunken recovery set cannot be recorded", async () => {
		// No quota rows: the follow-up pi export must not refuse a narrower harness set.
		publish([shard({ events: [event(1), event(2)], sessions: [session()] })]);
		const redundant = write(shard({ events: [event(1)], sessions: [session()] })).file;
		bookkeeping([redundant]);
		const before = readFileSync(outboxStatePath(agent, snapshotDir));
		vi.mocked(rename).mockRejectedValue(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
		const result = await cleanRecovery(agent, out);
		expect(result).toMatchObject({ removed: [redundant], failed: [], kept: [] });
		expect(result.warnings).toEqual(["recovery set not updated: removed files stay listed as missing (harmless)"]);
		expect(existsSync(join(snapshotDir, redundant))).toBe(false);
		expect(readFileSync(outboxStatePath(agent, snapshotDir))).toEqual(before);
		expect(existsSync(join(snapshotDir, ".export.lock"))).toBe(false);
		vi.mocked(rename).mockRestore();
		expect((await exportStats(agent, out)).warnings).toEqual([
			"recovery files retained: run clean-recovery to remove those the active snapshot covers",
		]);
		expect(stateOf().recoveryFiles).toEqual([redundant]);
		expect((await cleanRecovery(agent, out)).kept).toEqual([{ file: redundant, reason: "missing" }]);
	});

	it("surfaces an outbox that cannot be inspected instead of reporting it absent", async () => {
		publish([activeShard()]);
		const redundant = write(shard({ events: [event(1)], sessions: [session()] })).file;
		bookkeeping([redundant]);
		const before = readFileSync(outboxStatePath(agent, snapshotDir));
		const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		vi.mocked(lstat).mockImplementation(async (path, options) => {
			if (String(path) === snapshotDir) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
			return actual.lstat(path, options);
		});
		vi.mocked(unlink).mockClear();
		await expect(cleanRecovery(agent, out)).rejects.toMatchObject({ code: "EACCES" });
		expect(vi.mocked(unlink)).not.toHaveBeenCalled();
		expect(existsSync(join(snapshotDir, redundant))).toBe(true);
		expect(readFileSync(outboxStatePath(agent, snapshotDir))).toEqual(before);
	});

	/** Run `swap` once, at the recheck's `lstat` of the active shard: after the manifest was read, before the unlink. */
	/** Run `swap` during the active-shard pass of recheck `n` (1-based), after its manifest read. */
	async function duringRecheck(swap: () => void, n = 1): Promise<void> {
		const active = join(snapshotDir, manifestOf().shards[0]?.file as string);
		const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		let reads = 0;
		vi.mocked(lstat).mockImplementation(async (path, options) => {
			const info = await actual.lstat(path, options);
			if (String(path) === active && ++reads === n + 1) swap();
			return info;
		});
	}

	it("preserves a shard a concurrent restore references from a manifest swapped during the recheck", async () => {
		publish([activeShard()]);
		const restored = shard({ events: [event(1)], sessions: [session()] });
		const candidate = write(restored).file;
		bookkeeping([candidate]);
		const before = readFileSync(outboxStatePath(agent, snapshotDir));
		// A restore that skips the lock installs a valid manifest referencing the candidate; every shard stays intact.
		await duringRecheck(() => publish([restored]));
		const result = await cleanRecovery(agent, out);
		expect(result).toMatchObject({ removed: [], failed: [], kept: [{ file: candidate, reason: "changed" }] });
		expect(result.warnings).toEqual([
			"recovery cleanup stopped: the active manifest changed; 1 redundant files left in place",
		]);
		expect(existsSync(join(snapshotDir, candidate))).toBe(true);
		expect(readFileSync(outboxStatePath(agent, snapshotDir))).toEqual(before);
		expect(await importStats(join(root, "viewer"), out)).toMatchObject({ imported: 1, problems: [] });
	});

	it.each([
		["malformed JSON", "corrupt"],
		["valid JSON with an invalid schema", "{}"],
	])("stops, recording earlier unlinks, when the manifest turns into %s during a recheck", async (_, bytes) => {
		publish([shard({ events: [event(1), event(2)], sessions: [session()] })]);
		const first = write(shard({ events: [event(1)], sessions: [session()] })).file;
		const second = write(shard({ events: [event(2)], sessions: [session()] })).file;
		bookkeeping([first, second]);
		await duringRecheck(() => writeFileSync(join(snapshotDir, "manifest.json"), bytes), 2);
		const result = await cleanRecovery(agent, out);
		expect(result).toMatchObject({ removed: [first], failed: [], kept: [{ file: second, reason: "changed" }] });
		expect(result.warnings).toEqual([
			"recovery cleanup stopped: the active manifest changed; 1 redundant files left in place",
		]);
		expect(existsSync(join(snapshotDir, first))).toBe(false);
		expect(existsSync(join(snapshotDir, second))).toBe(true);
		expect(stateOf().recoveryFiles).toEqual([second]);
	});

	it("stops, keeping everything protected, on a transient read error during the recheck", async () => {
		publish([activeShard()]);
		const candidate = write(shard({ events: [event(1)], sessions: [session()] })).file;
		bookkeeping([candidate]);
		const active = join(snapshotDir, manifestOf().shards[0]?.file as string);
		const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		let reads = 0;
		vi.mocked(lstat).mockImplementation(async (path, options) => {
			if (String(path) === active && ++reads === 2)
				throw Object.assign(new Error("EIO: i/o error"), { code: "EIO", syscall: "lstat" });
			return actual.lstat(path, options);
		});
		expect(await cleanRecovery(agent, out)).toMatchObject({
			removed: [],
			kept: [{ file: candidate, reason: "changed" }],
		});
		expect(existsSync(join(snapshotDir, candidate))).toBe(true);
		expect(stateOf().recoveryFiles).toEqual([candidate]);
	});

	it("keeps a candidate replaced during the recheck", async () => {
		publish([activeShard()]);
		const candidate = write(shard({ events: [event(1)], sessions: [session()] })).file;
		bookkeeping([candidate]);
		await duringRecheck(() => writeFileSync(join(snapshotDir, candidate), "replaced"));
		expect(await cleanRecovery(agent, out)).toMatchObject({
			removed: [],
			kept: [{ file: candidate, reason: "changed" }],
		});
		expect(readFileSync(join(snapshotDir, candidate), "utf8")).toBe("replaced");
		expect(stateOf().recoveryFiles).toEqual([candidate]);
	});

	it("keeps survivors protected through the next export after a crash following some unlinks", async () => {
		// No quota rows: the follow-up pi export must not refuse a narrower harness set.
		publish([shard({ events: [event(1), event(2)], sessions: [session()] })]);
		const first = write(shard({ events: [event(1)], sessions: [session()] })).file;
		const second = write(shard({ events: [event(2)], sessions: [session()] })).file;
		bookkeeping([first, second]);
		const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		let unlinked = false;
		vi.mocked(unlink).mockImplementation(async (path) => {
			await actual.unlink(path);
			unlinked = true;
			// A restore installs a valid manifest that does not cover `second`.
			publish([shard({ events: [event(9)], sessions: [session()] })]);
		});
		// Every bookkeeping write after an unlink fails, as a crash there would.
		vi.mocked(rename).mockImplementation(async (from, to) => {
			if (unlinked && String(to) === outboxStatePath(agent, snapshotDir))
				throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
			await actual.rename(from, to);
		});
		const result = await cleanRecovery(agent, out);
		expect(result).toMatchObject({ removed: [first], failed: [], kept: [{ file: second, reason: "changed" }] });
		expect(stateOf()).toMatchObject({ recoveryPending: true, recoveryFiles: [first, second] });
		vi.mocked(unlink).mockImplementation(actual.unlink);
		vi.mocked(rename).mockImplementation(actual.rename);
		await exportStats(agent, out);
		expect(manifestOf().shards.map((ref) => ref.file)).not.toContain(second);
		expect(readdirSync(snapshotDir)).toContain(second);
		expect(stateOf().recoveryFiles).toContain(second);
	});

	it("keeps protecting the files a stopped cleanup did not unlink", async () => {
		publish([activeShard()]);
		const kept = write(shard({ events: [event(9)], sessions: [session()] })).file;
		const first = write(shard({ events: [event(1)], sessions: [session()] })).file;
		const second = write(shard({ events: [event(2)], sessions: [session()] })).file;
		bookkeeping([kept, first, second]);
		const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		vi.mocked(unlink).mockImplementation(async (path) => {
			await actual.unlink(path);
			publish([activeShard()], { label: "restored" });
		});
		const result = await cleanRecovery(agent, out);
		expect(result).toMatchObject({
			removed: [first],
			kept: [
				{ file: kept, reason: "not covered" },
				{ file: second, reason: "changed" },
			],
		});
		expect(stateOf()).toMatchObject({ recoveryPending: true, recoveryFiles: [kept, second] });
	});

	it("refuses while another export holds the lock", async () => {
		publish([activeShard()]);
		bookkeeping([]);
		mkdirSync(join(snapshotDir, ".export.lock"));
		await expect(cleanRecovery(agent, out)).rejects.toThrow("Export lock is held at");
	});

	it("refuses without an outbox and creates none", async () => {
		const error = await cleanRecovery(agent, out).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ExportRefusal);
		expect(error).toMatchObject({
			refusal: "recovery-outbox-missing",
			message: `Recovery cleanup refused: no outbox for this machine at ${JSON.stringify(snapshotDir)}; nothing was removed`,
		});
		expect(existsSync(out)).toBe(false);
	});

	it("surfaces a transient read of the active snapshot uncoded and changes nothing", async () => {
		publish([activeShard()]);
		const frozen = write(shard({ events: [event(1)], sessions: [session()] })).file;
		bookkeeping([frozen]);
		const manifest = join(snapshotDir, "manifest.json");
		const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		vi.mocked(lstat).mockImplementation(async (path, options) => {
			if (String(path) === manifest)
				throw Object.assign(new Error("EIO: i/o error"), { code: "EIO", syscall: "lstat" });
			return actual.lstat(path, options);
		});
		const error = await cleanRecovery(agent, out).catch((e: unknown) => e);
		expect(error).toMatchObject({ code: "EIO", message: "EIO: i/o error" });
		expect(error).not.toBeInstanceOf(ExportRefusal);
		expect(existsSync(join(snapshotDir, frozen))).toBe(true);
		expect(stateOf().recoveryFiles).toEqual([frozen]);
	});

	it.skipIf(process.getuid?.() === 0)("refuses a denied manifest as unverified", async ({ onTestFinished }) => {
		publish([activeShard()]);
		bookkeeping([]);
		const manifest = join(snapshotDir, "manifest.json");
		chmodSync(manifest, 0o000);
		onTestFinished(() => chmodSync(manifest, 0o600));
		await expect(cleanRecovery(agent, out)).rejects.toMatchObject({
			refusal: "recovery-snapshot-unverified",
			message: missingOrDamaged,
		});
		// An ordinary export refuses it too, so the cleanup must not send the owner there.
		await expect(exportStats(agent, out)).rejects.toMatchObject({ refusal: "history-unreadable" });
	});

	const refusal = (why: string) => `Recovery cleanup refused: ${why}; nothing was removed`;
	const unauthenticated = refusal(
		"the active manifest does not authenticate as this machine's v3 snapshot; export first",
	);
	const unaccounted = refusal(
		"this outbox has no recorded recovery set of its own, so frozen files are unaccounted; export first",
	);
	it.each([
		[
			"a missing manifest",
			() => write(activeShard()),
			missingOrDamaged,
			"recovery-snapshot-unverified",
			"manifest-missing",
		],
		[
			"a corrupt manifest",
			() => {
				publish([]);
				writeFileSync(join(snapshotDir, "manifest.json"), "corrupt");
			},
			unauthenticated,
			"recovery-snapshot-unverified",
		],
		[
			"a damaged referenced shard",
			() => {
				publish([activeShard()]);
				writeFileSync(join(snapshotDir, manifestOf().shards[0]?.file as string), "corrupt");
			},
			missingOrDamaged,
			"recovery-snapshot-unverified",
			"history-unreadable",
		],
		["a v2 manifest", () => publish([], { version: 2 }), unauthenticated, "recovery-snapshot-unverified"],
		[
			"another machine's manifest",
			() => publish([], { machineId: "11111111-1111-4111-8111-111111111111" }),
			unauthenticated,
			"recovery-snapshot-unverified",
		],
		["no own bookkeeping", () => publish([activeShard()]), unaccounted, "recovery-set-unrecorded"],
		[
			"an uncaptured recovery set",
			() => {
				publish([activeShard()]);
				bookkeeping(null);
			},
			unaccounted,
			"recovery-set-unrecorded",
		],
		[
			"a lost harness",
			() => {
				publish([activeShard()]);
				// An otherwise deletable frozen shard is in the recorded set.
				bookkeeping([write(shard({ events: [event(1)], sessions: [session()] })).file], {
					lostHarnesses: ["pi", "claude"],
				});
			},
			refusal("recovery of lost pi, claude history is pending and may need frozen files"),
			"recovery-harness-lost",
		],
		[
			"invalid own bookkeeping",
			() => {
				publish([activeShard()]);
				bookkeeping([], { recoveryFiles: "not a list" });
			},
			"Invalid export state in",
			"export-state-invalid",
		],
	] as [string, () => void, string, string, string?][])(
		"refuses with %s and changes nothing",
		async (_, arrange, message, code, exported) => {
			arrange();
			const frozen = write(shard({ events: [event(1)], sessions: [session()] })).file;
			const listing = () => readdirSync(out, { recursive: true }).map(String).sort();
			const before = listing();
			const state = () => {
				const path = outboxStatePath(agent, snapshotDir);
				return existsSync(path) ? readFileSync(path) : undefined;
			};
			const recorded = state();
			const error = await cleanRecovery(agent, out).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(ExportRefusal);
			expect(error).toMatchObject({ refusal: code, message: expect.stringContaining(message) });
			expect(listing()).toEqual(before);
			expect(state()).toEqual(recorded);
			expect(existsSync(join(snapshotDir, frozen))).toBe(true);
			// Where the cleanup says to restore rather than export, an ordinary export refuses as well.
			if (exported !== undefined) await expect(exportStats(agent, out)).rejects.toMatchObject({ refusal: exported });
		},
	);
});
