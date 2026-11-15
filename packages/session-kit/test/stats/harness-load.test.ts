import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshnessLines } from "../../src/stats/freshness.ts";
import { type Harness, opaqueId } from "../../src/stats/load.ts";
import {
	eventId,
	importStats,
	loadCombined,
	type Manifest,
	machineIdentity,
	type SnapshotEvent,
	STALE_AFTER_MS,
} from "../../src/stats/snapshot.ts";
import { assistantLine, at, sessionFile } from "./fixtures.ts";
import { CANARY } from "./harness/fixtures.ts";
import { CODEX_RESET_S, seedHarnessHome } from "./harness/home.ts";

const REMOTE = "33333333-3333-4333-8333-333333333333";
const OCT = at("2026-10-01");
const ALL = ["claude", "codex", "opencode"] as const;

let dir: string;
let repo: string;
let viewer: string;
let home: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "stats-harness-load-"));
	repo = join(dir, "repo");
	viewer = join(dir, "viewer");
	home = join(dir, "home");
	sessionFile(join(viewer, "sessions", "p", "s.jsonl"), {
		startMs: OCT,
		lines: [assistantLine({ ms: OCT, provider: "pi-provider", model: "pi-model", input: 5, cost: 0.5 })],
	});
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function files(root: string): Record<string, [string, number]> {
	const out: Record<string, [string, number]> = {};
	for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const path = join(entry.parentPath, entry.name);
		out[path] = [readFileSync(path, "utf8"), statSync(path).mtimeMs];
	}
	return out;
}

/** A remote machine's v2 snapshot: one event per harness in `events`, and the given `lastGoodAt`. */
function publishRemote(events: Harness[], lastGoodAt: Manifest["lastGoodAt"], exportedAt: number): void {
	const sessions = [{ id: opaqueId("s"), startMs: OCT, endMs: OCT, child: false }];
	const list: SnapshotEvent[] = events.map((harness, i) => {
		const e = {
			harness,
			entryId: opaqueId(`e${i}`),
			sessionId: opaqueId("s"),
			ms: OCT + i,
			provider: "p",
			model: "m",
			input: 10,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			cost: null,
		};
		return { id: eventId(e), ...e };
	});
	const text = JSON.stringify({ version: 2, machineId: REMOTE, month: "2026-10", events: list, sessions, quota: [] });
	const sha256 = opaqueId(text);
	const file = `2026-10-${sha256}.json`;
	const base = join(repo, "machines", REMOTE);
	mkdirSync(base, { recursive: true });
	writeFileSync(join(base, file), text);
	const manifest: Manifest = {
		version: 2,
		machineId: REMOTE,
		label: "remote",
		exportedAt,
		lastGoodAt,
		shards: [{ month: "2026-10", file, sha256, bytes: Buffer.byteLength(text) }],
	};
	writeFileSync(join(base, "manifest.json"), JSON.stringify(manifest));
}

describe("loadCombined with local harness scans", () => {
	it("merges Claude, Codex and OpenCode usage with their labels, null costs and quota, read-only", async () => {
		const roots = seedHarnessHome(home);
		const before = files(home);
		const combined = await loadCombined(viewer, undefined, OCT, { harnesses: ALL, roots, env: {}, home });
		expect(combined.calls.map((c) => [c.harness, c.cost]).sort()).toEqual([
			["claude", null],
			["codex", null],
			["opencode", 0.25],
			["pi", 0.5],
		]);
		expect(combined.sessions).toHaveLength(4);
		expect(combined.harnessProblems).toEqual([]);
		expect(combined.quota).toEqual([
			expect.objectContaining({
				harness: "codex",
				provider: "openai-codex",
				window: "7d",
				resetAt: CODEX_RESET_S * 1000,
			}),
		]);
		const local = combined.coverage.sources?.find((s) => s.local);
		expect(Object.keys(local?.harnesses ?? {}).sort()).toEqual(["claude", "codex", "opencode", "pi"]);
		expect(local?.harnesses).toMatchObject({
			pi: { found: true, lastEventMs: OCT, problems: [] },
			claude: { found: true, problems: [] },
			opencode: { found: true },
		});
		expect(local?.harnesses?.claude?.lastEventMs).toBeGreaterThan(0);
		expect(JSON.stringify(combined)).not.toContain(CANARY);
		// sources are never written
		expect(files(home)).toEqual(before);
	});

	it("reports an absent harness as not installed and scans only what it is asked to", async () => {
		const combined = await loadCombined(viewer, undefined, OCT, { harnesses: ["codex"], env: {}, home });
		expect(combined.calls.map((c) => c.harness)).toEqual(["pi"]);
		const local = combined.coverage.sources?.find((s) => s.local);
		expect(local?.harnesses?.codex).toEqual({ found: false, lastEventMs: undefined, problems: [] });
		expect(local?.harnesses?.claude).toBeUndefined();
		expect(freshnessLines(combined.coverage, OCT).join("\n")).toContain("  codex: not installed");
	});

	it("keeps pi usage and says so when the other harnesses cannot be read", async () => {
		mkdirSync(join(viewer, "pi-session-kit"), { recursive: true });
		writeFileSync(join(viewer, "pi-session-kit", "export-state.json"), "{ not json");
		const combined = await loadCombined(viewer, undefined, OCT, { harnesses: ALL, env: {}, home });
		expect(combined.calls.map((c) => c.harness)).toEqual(["pi"]);
		expect(combined.harnessProblems).toEqual(["other harnesses not read: export state unreadable"]);
		expect(combined.coverage.sources?.find((s) => s.local)?.harnesses).toMatchObject({ pi: { found: true } });
	});

	it("reads nothing else by default", async () => {
		seedHarnessHome(home);
		const combined = await loadCombined(viewer, undefined, OCT, { env: {}, home });
		expect(combined.calls.map((c) => c.harness)).toEqual(["pi"]);
		expect(combined.coverage.sources?.find((s) => s.local)?.harnesses).toBeUndefined();
		await machineIdentity(viewer);
	});
});

describe("loadCombined with imported harness status", () => {
	it("carries last good and last event per harness and marks a lagging one stale", async () => {
		const exportedAt = OCT + 10 * STALE_AFTER_MS;
		publishRemote(["pi", "claude"], { pi: exportedAt, claude: exportedAt - 3 * STALE_AFTER_MS }, exportedAt);
		await importStats(viewer, repo);
		const combined = await loadCombined(viewer, undefined, exportedAt);
		const remote = combined.coverage.sources?.find((s) => !s.local);
		expect(remote?.harnesses).toEqual({
			pi: { lastEventMs: OCT, lastGoodAt: exportedAt, stale: false, problems: [] },
			claude: { lastEventMs: OCT + 1, lastGoodAt: exportedAt - 3 * STALE_AFTER_MS, stale: true, problems: [] },
		});
		expect(combined.calls.map((c) => [c.harness, c.cost]).sort()).toEqual([
			["claude", null],
			["pi", null],
			["pi", 0.5],
		]);
		const lines = freshnessLines(combined.coverage, exportedAt).join("\n");
		expect(lines).toMatch(/ {2}claude: STALE, not read cleanly since .*\(6d ago\) · last event /);
		expect(lines).toMatch(/ {2}pi: last read cleanly .* · last event /);
	});

	it("shows what an export with no per-harness marks still holds", async () => {
		publishRemote(["codex"], {}, OCT);
		await importStats(viewer, repo);
		const remote = (await loadCombined(viewer, undefined, OCT)).coverage.sources?.find((s) => !s.local);
		expect(remote?.harnesses).toEqual({
			codex: { lastEventMs: OCT, lastGoodAt: undefined, stale: false, problems: [] },
		});
	});

	it("has no harness block for a machine with neither marks nor events", async () => {
		publishRemote([], {}, OCT);
		await importStats(viewer, repo);
		const remote = (await loadCombined(viewer, undefined, OCT)).coverage.sources?.find((s) => !s.local);
		expect(remote).toBeDefined();
		expect(remote?.harnesses).toBeUndefined();
	});
});
