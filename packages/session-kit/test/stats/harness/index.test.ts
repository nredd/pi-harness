import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountHash } from "../../../src/stats/harness/common.ts";
import {
	harnessCachePath,
	harnessRoots,
	loadHarnesses,
	readHarnessCache,
	saltMark,
	writeHarnessCache,
} from "../../../src/stats/harness/index.ts";
import type { ParsedFile } from "../../../src/stats/harness/scan.ts";
import {
	CANARY,
	claudeRow,
	codexContext,
	codexMeta,
	codexRecord,
	codexTokenCount,
	limits,
	writeLines,
} from "./fixtures.ts";
import { seedHarnessHome } from "./home.ts";

const SALT = "0123456789abcdef0123456789abcdef";
let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "psk-harness-"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

/** Every file under `dir` with its bytes and mtime. */
function snapshot(dir: string): Record<string, [string, number]> {
	const out: Record<string, [string, number]> = {};
	for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const path = join(entry.parentPath, entry.name);
		out[path] = [readFileSync(path, "utf8"), statSync(path).mtimeMs];
	}
	return out;
}

describe("harnessRoots", () => {
	it("prefers overrides, then the harness's environment variable, then standard paths", () => {
		expect(harnessRoots({}, "/h")).toEqual({
			claude: "/h/.claude",
			codex: "/h/.codex",
			opencode: "/h/.local/share/opencode/opencode.db",
		});
		const env = { CLAUDE_CONFIG_DIR: "/c", CODEX_HOME: "/x", XDG_DATA_HOME: "/d", OPENCODE_DB: "/o.db" };
		expect(harnessRoots(env, "/h")).toEqual({ claude: "/c", codex: "/x", opencode: "/o.db" });
		expect(harnessRoots({ XDG_DATA_HOME: "/d" }, "/h").opencode).toBe("/d/opencode/opencode.db");
		expect(harnessRoots(env, "/h", { claude: "/a", codex: "/b", opencode: "/e" })).toEqual({
			claude: "/a",
			codex: "/b",
			opencode: "/e",
		});
		expect(Object.keys(harnessRoots())).toEqual(["claude", "codex", "opencode"]);
	});

	it("places the cache under the agent dir", () => {
		expect(harnessCachePath("/a")).toBe("/a/pi-session-kit/stats-harness-cache.json");
		expect(harnessCachePath()).toMatch(/pi-session-kit\/stats-harness-cache\.json$/);
	});
});

describe("loadHarnesses", () => {
	function fakeHome(): { cache: string; env: Record<string, string> } {
		writeLines(join(home, ".claude", "projects", `-Users-${CANARY}`, "a.jsonl"), [claudeRow()]);
		writeLines(join(home, ".codex", "sessions", "2026", "10", "02", "rollout-a.jsonl"), [
			codexMeta(),
			codexContext(),
			codexRecord(),
		]);
		writeLines(join(home, ".codex", "history.jsonl"), [{ text: `${CANARY} prompt` }]);
		writeLines(join(home, ".codex", "auth.json"), [{ token: CANARY }]);
		writeLines(join(home, ".claude", ".credentials.json"), [{ token: CANARY }]);
		return { cache: join(home, "agent", "pi-session-kit", "stats-harness-cache.json"), env: {} };
	}

	it("reads every installed harness, silently skips the rest, and never modifies a source", async () => {
		const { cache, env } = fakeHome();
		const before = snapshot(join(home, ".claude"));
		const beforeCodex = snapshot(join(home, ".codex"));
		const scans = await loadHarnesses({ home, env, cache, salt: SALT });
		expect(scans.claude.calls).toHaveLength(1);
		expect(scans.codex.calls).toHaveLength(1);
		expect(scans.opencode).toMatchObject({ found: false, problems: [] });
		expect(snapshot(join(home, ".claude"))).toEqual(before);
		expect(snapshot(join(home, ".codex"))).toEqual(beforeCodex);
		expect(JSON.stringify(scans)).not.toContain(CANARY);
		// Local cache keys are paths (the encoded cwd); no cached value carries content.
		const cached = JSON.parse(readFileSync(cache, "utf8")).harnesses;
		expect(JSON.stringify(Object.values(cached).map((files) => Object.values(files as object)))).not.toContain(CANARY);
	});

	it("reuses the persisted cache and rewrites nothing when nothing changed", async () => {
		const { cache, env } = fakeHome();
		await loadHarnesses({ home, env, cache, salt: SALT });
		// An atomic rewrite would replace the inode.
		const written = statSync(cache).ino;
		const again = await loadHarnesses({ home, env, cache, salt: SALT });
		expect(again.claude.calls).toHaveLength(1);
		expect(statSync(cache).ino).toBe(written);
	});

	it("reports what it is reading, and caches OpenCode so a repeat load never opens the database", async () => {
		const roots = seedHarnessHome(home);
		const cache = join(home, "c.json");
		const status: string[] = [];
		const first = await loadHarnesses({ home, env: {}, roots, cache, salt: SALT, onProgress: (s) => status.push(s) });
		expect(status).toEqual(["reading claude", "reading codex", "reading opencode", "reading opencode, 1 rows"]);
		expect(first.opencode.calls).toHaveLength(1);
		const again = await loadHarnesses({
			home,
			env: {},
			roots,
			cache,
			salt: SALT,
			harnesses: ["opencode"],
			loadSqlite: () => Promise.reject(new Error("opened")),
		});
		expect(again.opencode).toEqual(first.opencode);
	});

	it("defaults the cache to the agent dir", async () => {
		const { env } = fakeHome();
		vi.stubEnv("PI_CODING_AGENT_DIR", join(home, "agent"));
		await loadHarnesses({ home, env, harnesses: ["claude", "opencode"], salt: SALT });
		expect(statSync(harnessCachePath()).isFile()).toBe(true);
	});

	it("keeps usage for a deleted file across a salt change, and re-derives quota for one that remains", async () => {
		const cache = join(home, "c.json");
		const codex = join(home, ".codex");
		const rollout = (name: string) => join(codex, "sessions", "2026", "10", "02", `rollout-${name}.jsonl`);
		const lines = (id: string, account: string) => [
			codexMeta(id, { creator_account_id: account }),
			codexContext(`turn-${id}`, "gpt-6.1-sol"),
			codexRecord({ turn: `turn-${id}`, response: `resp-${id}` }),
			codexTokenCount(limits({ used_percent: 5, window_minutes: 300, resets_at: 4_102_444_800 })),
		];
		writeLines(rollout("gone"), lines("gone", "acct-1"));
		writeLines(rollout("kept"), lines("kept", "acct-1"));
		const load = (salt: string) =>
			loadHarnesses({ harnesses: ["codex"], roots: { codex }, cache, salt }).then((scans) => scans.codex);
		const before = await load(SALT);
		expect(before.calls).toHaveLength(2);
		expect(before.quota.map((q) => q.account)).toEqual([accountHash(SALT, "codex", "acct-1")]);

		rmSync(rollout("gone"));
		const other = "fedcba9876543210fedcba9876543210";
		const after = await load(other);
		// the pruned transcript's usage survives the salt change; the surviving file's quota is re-derived
		expect(after.calls).toHaveLength(2);
		expect(after.quota.map((q) => q.account)).toEqual([accountHash(other, "codex", "acct-1")]);
		expect(after.problems).toEqual([]);
	});

	it("honors the harness subset and per-harness roots", async () => {
		const { cache } = fakeHome();
		const scans = await loadHarnesses({
			salt: SALT,
			harnesses: ["codex"],
			roots: { codex: join(home, ".codex"), claude: join(home, ".claude") },
			cache,
		});
		expect(scans.codex.calls).toHaveLength(1);
		expect(scans.claude).toMatchObject({ found: false, calls: [] });
	});

	it("reads OpenCode through the injected loader", async () => {
		const db = join(home, "opencode.db");
		writeFileSync(db, "x");
		const scans = await loadHarnesses({
			salt: SALT,
			harnesses: ["opencode"],
			roots: { opencode: db },
			cache: join(home, "c.json"),
			loadSqlite: () => Promise.reject(new Error("nope")),
		});
		expect(scans.opencode.problems).toHaveLength(1);
	});

	it("reports a cache it cannot write without hiding the data", async () => {
		const { env } = fakeHome();
		const blocker = join(home, "blocker");
		writeFileSync(blocker, "file");
		const scans = await loadHarnesses({
			salt: SALT,
			home,
			env,
			cache: join(blocker, "sub", "cache.json"),
			harnesses: ["claude", "codex", "opencode"],
		});
		expect(scans.claude.calls).toHaveLength(1);
		expect(scans.claude.problems).toEqual(["claude: cache not written"]);
		expect(scans.codex.problems).toEqual(["codex: cache not written"]);
		expect(scans.opencode.problems).toEqual(["opencode: cache not written"]);
	});
});

describe("harness cache", () => {
	it("round-trips and drops malformed records, unknown versions and corrupt files", async () => {
		const path = join(home, "c", "cache.json");
		const good: ParsedFile = {
			size: 1,
			mtimeMs: 2,
			startMs: 3,
			endMs: 4,
			session: "",
			child: false,
			models: [["p", "m"]],
			calls: [[1, 0, 1, 1, 1, 1, null]],
			entryIds: ["a".repeat(64)],
			quota: [],
			badLines: 0,
			unsupportedTurns: 0,
		};
		await writeHarnessCache(path, { claude: { "/x": good } }, SALT);
		expect(await readHarnessCache(path, SALT)).toEqual({ claude: { "/x": good } });
		// only a mark of the salt is stored, never the salt
		expect(readFileSync(path, "utf8")).not.toContain(SALT);

		const quotaOk = {
			harness: "codex",
			provider: "p",
			limitId: "l",
			window: "5h",
			usedPercent: 1,
			resetAt: 2,
			durationMs: 3,
			observedAt: 4,
			planType: null,
			account: "",
		};
		const bad = [
			{ ...good, models: [["p"]] },
			{ ...good, calls: [[1, 5, 1, 1, 1, 1, 0]] },
			{ ...good, calls: [[1, 0, 1, 1, 1, 1, "free"]] },
			{ ...good, calls: [[1, 0, 1, 1, null, 1, 0]] },
			{ ...good, entryIds: ["short"] },
			{ ...good, entryIds: [] },
			{ ...good, quota: [{ harness: "nope" }] },
			// a reading with no `account` is from before the discriminator and is re-parsed
			{ ...good, quota: [{ ...quotaOk, account: undefined }] },
			{ ...good, quota: [{ ...quotaOk, account: "not-a-hash" }] },
			{ ...good, child: "yes" },
			"junk",
		];
		writeFileSync(
			path,
			JSON.stringify({
				version: 4,
				salt: saltMark(SALT),
				harnesses: {
					codex: {
						...Object.fromEntries(bad.map((b, i) => [`/${i}`, b])),
						"/ok": { ...good, quota: [quotaOk, { ...quotaOk, planType: "pro", account: "f".repeat(64) }] },
					},
					odd: "x",
				},
			}),
		);
		const cache = await readHarnessCache(path, SALT);
		expect(Object.keys(cache.codex ?? {})).toEqual(["/ok"]);
		expect(cache.odd).toEqual({});

		// v1 caches recorded cost 0 and v2 quota had no account: dropped and re-parsed, never trusted.
		for (const version of [1, 2, 3, 99]) {
			writeFileSync(path, JSON.stringify({ version, harnesses: { codex: { "/ok": good } } }));
			expect(await readHarnessCache(path, SALT)).toEqual({});
		}
		// a cache made under another salt (or none) keeps its usage but loses quota, and is marked for re-parse
		const marked = { version: 4, harnesses: { codex: { "/ok": { ...good, quota: [quotaOk] } } } };
		const keptStale = { codex: { "/ok": { ...good, size: -1, quota: [] } } };
		writeFileSync(path, JSON.stringify({ ...marked, salt: saltMark("another-salt") }));
		expect(await readHarnessCache(path, SALT)).toEqual(keptStale);
		writeFileSync(path, JSON.stringify(marked));
		expect(await readHarnessCache(path, SALT)).toEqual(keptStale);
		writeFileSync(path, JSON.stringify({ version: 99, harnesses: {} }));
		expect(await readHarnessCache(path, SALT)).toEqual({});
		writeFileSync(path, "{not json");
		expect(await readHarnessCache(path, SALT)).toEqual({});
		mkdirSync(join(home, "d"));
		expect(await readHarnessCache(join(home, "d", "missing.json"), SALT)).toEqual({});
	});
});
