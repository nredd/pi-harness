import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	agentDir,
	CACHE_VERSION,
	cachePath,
	flatten,
	isFileStats,
	loadUsage,
	mergeSessionMetadata,
	opaqueId,
	parseSession,
	sessionsDir,
} from "../../src/stats/load.ts";
import { assistantLine, at, sessionFile } from "./fixtures.ts";

let dir: string;
let root: string;
let cache: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "psk-stats-"));
	root = join(dir, "sessions");
	cache = join(dir, "cache", "stats-cache.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const opus = (day: string, input: number, output: number, extra = {}) =>
	assistantLine({ ms: at(day), provider: "anthropic", model: "claude-opus-5-5", input, output, ...extra });

describe("agent paths", () => {
	it("derives session and cache defaults from an injected home", () => {
		const agent = agentDir("/isolated/home");
		expect(agent).toBe("/isolated/home/.pi/agent");
		expect(sessionsDir(agent)).toBe("/isolated/home/.pi/agent/sessions");
		expect(cachePath(agent)).toBe("/isolated/home/.pi/agent/pi-session-kit/stats-cache.json");
	});
});

describe("parseSession", () => {
	it("keeps real assistant usage and skips everything that is not a physical model call", () => {
		const steer = JSON.stringify({
			type: "message",
			timestamp: new Date(at("2026-10-01", 13)).toISOString(),
			message: {
				role: "toolResult",
				toolName: "steer_subagent",
				content: [],
				usage: { input: 41596, output: 900, cacheRead: 0, cacheWrite: 0, cost: { total: 0.09 } },
			},
		});
		const compaction = JSON.stringify({
			type: "compaction",
			timestamp: new Date(at("2026-10-01", 15)).toISOString(),
			usage: { input: 9999, output: 9999 },
		});
		const text = [
			JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date(at("2026-10-01", 9)).toISOString() }),
			opus("2026-10-01", 10, 20, { cacheRead: 5, cacheWrite: 7, cost: 0.5 }),
			assistantLine({ ms: at("2026-10-01"), provider: "faux", model: "faux-1", input: 100 }),
			assistantLine({ ms: at("2026-10-01"), provider: "router", model: "default", input: 0 }),
			assistantLine({ ms: at("2026-10-01"), provider: "router", model: "default", input: 5 }),
			assistantLine({ ms: at("2026-10-01"), provider: "anthropic", model: "claude-sonnet-5-5" }),
			'{"type":"message","message":{"role":"assistant", broken',
			'{"type":"message","timestamp":"2026-10-01T20:00:00Z","message":{"role":"user"',
			"[1, 2]",
			steer,
			compaction,
		].join("\n");
		const file = parseSession(text);
		expect(file.models).toEqual(["anthropic/claude-opus-5-5"]);
		expect(file.calls).toEqual([[at("2026-10-01"), 0, 10, 20, 5, 7, 0.5]]);
		// the broken assistant line, the truncated user line, and a non-object
		expect(file.badLines).toBe(3);
		expect(file.child).toBe(false);
		expect(file.startMs).toBe(at("2026-10-01", 9));
		// non-assistant entries still move the end of the session
		expect(file.endMs).toBe(at("2026-10-01", 15));
	});

	it("counts a broken header as a bad line", () => {
		const file = parseSession(['{"type":"session","timestamp":', opus("2026-10-01", 1, 1)].join("\n"));
		expect(file.badLines).toBe(1);
		expect(file.calls).toHaveLength(1);
	});

	it("marks a subagent child only with BOTH a parent link and a child name", () => {
		const header = (parent?: string) =>
			JSON.stringify({ type: "session", timestamp: new Date(at("2026-10-01")).toISOString(), parentSession: parent });
		const info = (name: string) => JSON.stringify({ type: "session_info", timestamp: "2026-10-01T12:00:00Z", name });
		expect(parseSession([header("/p.jsonl"), info("Explore#c617350b")].join("\n")).child).toBe(true);
		expect(parseSession([header("/p.jsonl"), info("my fork")].join("\n")).child).toBe(false);
		expect(parseSession([header(), info("Explore#c617350b")].join("\n")).child).toBe(false);
	});

	it("does not depend on compact JSON", () => {
		const spaced = (v: unknown) => JSON.stringify(v, null, 1).replace(/\n\s*/g, " ");
		const text = [
			spaced({ type: "session", timestamp: new Date(at("2026-10-01", 9)).toISOString() }),
			spaced(JSON.parse(opus("2026-10-01", 3, 4))),
			spaced({ type: "message", timestamp: new Date(at("2026-10-01", 18)).toISOString(), message: { role: "user" } }),
		].join("\n");
		const file = parseSession(text);
		expect(file.calls).toEqual([[at("2026-10-01"), 0, 3, 4, 0, 0, 0]]);
		expect(file.startMs).toBe(at("2026-10-01", 9));
		expect(file.endMs).toBe(at("2026-10-01", 18));
	});

	it("accepts a numeric cost and falls back to the entry timestamp", () => {
		const line = JSON.stringify({
			type: "message",
			timestamp: new Date(at("2026-10-02")).toISOString(),
			message: { role: "assistant", provider: "p", model: "m", usage: { input: 1, output: 2, cost: 0.25 } },
		});
		expect(parseSession(line).calls).toEqual([[at("2026-10-02"), 0, 1, 2, 0, 0, 0.25]]);
	});
});

describe("mergeSessionMetadata", () => {
	it("merges copy bounds and child markers without mutating either source", () => {
		const first = { path: "one", startMs: 20, endMs: 30, child: false };
		const copy = { ...first, startMs: 10, endMs: 25, child: true };
		const second = { ...first, path: "two" };
		expect([...mergeSessionMetadata([first, copy, second]).values()]).toEqual([
			{ path: "one", startMs: 10, endMs: 30, child: true },
			second,
		]);
		expect(first).toEqual({ path: "one", startMs: 20, endMs: 30, child: false });
		expect(copy).toEqual({ path: "one", startMs: 10, endMs: 25, child: true });
	});
});

describe("flatten", () => {
	it("counts a forked copy once, credits the original, and excludes children from sessions", () => {
		const copied = opus("2026-10-01", 1, 2);
		const original = parseSession(
			[JSON.stringify({ type: "session", timestamp: new Date(at("2026-10-01", 9)).toISOString() }), copied].join("\n"),
		);
		const fork = parseSession(
			[
				JSON.stringify({
					type: "session",
					timestamp: new Date(at("2026-10-02", 9)).toISOString(),
					parentSession: "/a",
				}),
				copied,
				opus("2026-10-02", 3, 4),
			].join("\n"),
		);
		const child = parseSession(
			[
				JSON.stringify({
					type: "session",
					timestamp: new Date(at("2026-10-03", 9)).toISOString(),
					parentSession: "/a",
				}),
				JSON.stringify({ type: "session_info", name: "general-purpose#12f92799" }),
				opus("2026-10-03", 5, 6),
			].join("\n"),
		);
		// insertion order must not matter
		const { calls, sessions } = flatten({ "/z/fork": fork, "/z/child": child, "/a/orig": original });
		expect(calls.map((c) => c.input)).toEqual([1, 3, 5]);
		expect(sessions.map((s) => s.path)).toEqual([
			opaqueId("legacy-session:/a/orig"),
			opaqueId("legacy-session:/z/fork"),
		]);
	});
});

describe("flatten names", () => {
	it("retains raw provider/model names for dedup; only the view sanitizes", () => {
		const file = parseSession(
			assistantLine({ ms: at("2026-10-01"), provider: "evil\u001b[2J", model: "m\nx", input: 1 }),
		);
		const [c] = flatten({ "/a": file }).calls;
		expect(c?.provider).toBe("evil\u001b[2J");
		expect(c?.model).toBe("m\nx");
	});

	it("dedups on the raw name, so two models that sanitize alike stay two calls", () => {
		const file = parseSession(
			[
				assistantLine({ ms: at("2026-10-01"), provider: "p", model: "m\nx", input: 1 }),
				assistantLine({ ms: at("2026-10-01"), provider: "p", model: "m^Jx", input: 1 }),
			].join("\n"),
		);
		expect(flatten({ "/a": file }).calls).toHaveLength(2);
	});
});

describe("loadUsage", () => {
	it("re-parses only changed files, keeps deleted history, and rebuilds a corrupt cache", async () => {
		const a = join(root, "--proj--", "a.jsonl");
		const b = join(root, "--other--", "nested", "b.jsonl");
		sessionFile(a, { startMs: at("2026-10-01", 9), lines: [opus("2026-10-01", 1, 1)] });
		sessionFile(b, { startMs: at("2026-10-02", 9), lines: [opus("2026-10-02", 2, 2)] });
		writeFileSync(join(root, "notes.txt"), "ignored");

		const progress: number[] = [];
		const first = await loadUsage({ root, cache, onProgress: (d) => progress.push(d) });
		expect(first.calls).toHaveLength(2);
		expect(progress).toEqual([1, 2]);
		const doc = JSON.parse(readFileSync(cache, "utf8"));
		expect(doc.version).toBe(CACHE_VERSION);
		expect(Object.keys(doc.files).sort()).toEqual([a, b].sort());

		// cache hit: nothing re-parsed
		const hits: number[] = [];
		await loadUsage({ root, cache, onProgress: (d) => hits.push(d) });
		expect(hits).toEqual([]);

		// size change -> re-parse that one file
		sessionFile(a, { startMs: at("2026-10-01", 9), lines: [opus("2026-10-01", 1, 1), opus("2026-10-03", 9, 9)] });
		const changed: number[] = [];
		const second = await loadUsage({ root, cache, onProgress: (_done, total) => changed.push(total) });
		expect(changed).toEqual([1]);
		expect(second.calls).toHaveLength(3);

		// mtime-only change -> re-parse
		const s = statSync(b);
		utimesSync(b, s.atime, new Date(s.mtimeMs + 5000));
		const touched: number[] = [];
		await loadUsage({ root, cache, onProgress: (d) => touched.push(d) });
		expect(touched).toEqual([1]);

		// deleted file keeps counting
		rmSync(b);
		expect((await loadUsage({ root, cache })).calls).toHaveLength(3);

		// corrupt cache -> rebuilt from what is on disk
		writeFileSync(cache, "{not json");
		const rebuilt = await loadUsage({ root, cache });
		expect(rebuilt.calls).toHaveLength(2);
		expect(JSON.parse(readFileSync(cache, "utf8")).version).toBe(CACHE_VERSION);

		// wrong version -> rebuilt
		writeFileSync(cache, JSON.stringify({ version: 0, files: { "/x": {} } }));
		expect((await loadUsage({ root, cache })).calls).toHaveLength(2);

		// valid JSON, malformed records: each bad record is dropped (and re-parsed if on disk), never thrown on
		const good = JSON.parse(readFileSync(cache, "utf8")).files[a];
		writeFileSync(
			cache,
			JSON.stringify({
				version: CACHE_VERSION,
				files: {
					[join(root, "gone.jsonl")]: {},
					[join(root, "bad-tuple.jsonl")]: { ...good, calls: [[1, 9, 1, 1, 1, 1, 1]] },
					[a]: { ...good, calls: "nope" },
				},
			}),
		);
		const repaired = await loadUsage({ root, cache });
		expect(repaired.calls).toHaveLength(2);
	});

	it("validates every field of a cached record", () => {
		const ok = {
			size: 1,
			mtimeMs: 1,
			startMs: 1,
			endMs: 1,
			child: false,
			badLines: 0,
			models: ["a/b"],
			calls: [[1, 0, 1, 1, 1, 1, 1]],
		};
		expect(isFileStats(ok)).toBe(true);
		for (const broken of [
			null,
			[],
			{ ...ok, size: "1" },
			{ ...ok, child: 0 },
			{ ...ok, models: ["nope"] },
			{ ...ok, calls: [[1, 0, 1]] },
			{ ...ok, calls: [[1, 1, 1, 1, 1, 1, 1]] },
			{ ...ok, calls: [[1, 0.5, 1, 1, 1, 1, 1]] },
			{ ...ok, calls: [[1, 0, 1, 1, 1, 1, null]] },
			{ ...ok, badLines: undefined },
		])
			expect(isFileStats(broken), JSON.stringify(broken)).toBe(false);
	});

	it("reports only the current sessions root, while the shared cache keeps both", async () => {
		const other = join(dir, "other-sessions");
		sessionFile(join(root, "a.jsonl"), { startMs: at("2026-10-01"), lines: [opus("2026-10-01", 1, 1)] });
		sessionFile(join(other, "b.jsonl"), {
			startMs: at("2026-10-02"),
			lines: [opus("2026-10-02", 2, 2), opus("2026-10-03", 3, 3)],
		});
		expect((await loadUsage({ root, cache })).calls).toHaveLength(1);
		expect((await loadUsage({ root: other, cache })).calls).toHaveLength(2);
		// an empty root reports nothing, even though the cache holds both
		expect((await loadUsage({ root: join(dir, "empty"), cache })).calls).toHaveLength(0);
		expect(Object.keys(JSON.parse(readFileSync(cache, "utf8")).files)).toHaveLength(2);
		// a sibling dir sharing the prefix is not inside the root
		sessionFile(join(`${root}-old`, "c.jsonl"), { startMs: at("2026-10-04"), lines: [opus("2026-10-04", 4, 4)] });
		await loadUsage({ root: `${root}-old`, cache });
		expect((await loadUsage({ root, cache })).calls).toHaveLength(1);
	});

	it("treats a missing sessions dir as empty, and survives a cache it cannot write", async () => {
		expect(await loadUsage({ root: join(dir, "nope"), cache })).toEqual({
			calls: [],
			sessionMetadata: [],
			sessions: [],
			errors: 0,
			badLines: 0,
		});
		sessionFile(join(root, "a.jsonl"), { startMs: at("2026-10-01"), lines: [opus("2026-10-01", 1, 1)] });
		writeFileSync(join(dir, "file"), "");
		const loaded = await loadUsage({ root, cache: join(dir, "file", "cache.json") });
		expect(loaded.calls).toHaveLength(1);
	});

	it("counts a directory it cannot list instead of silently reporting less", async () => {
		sessionFile(join(root, "ok", "a.jsonl"), { startMs: at("2026-10-01"), lines: [opus("2026-10-01", 1, 1)] });
		mkdirSync(join(root, "locked"));
		chmodSync(join(root, "locked"), 0o000);
		try {
			const loaded = await loadUsage({ root, cache });
			expect(loaded.calls).toHaveLength(1);
			expect(loaded.errors).toBe(1);
		} finally {
			chmodSync(join(root, "locked"), 0o755);
		}
	});

	it("streams files bigger than one yield window", async () => {
		const lines = Array.from({ length: 4500 }, (_, i) => opus("2026-10-01", i + 1, 1));
		sessionFile(join(root, "big.jsonl"), { startMs: at("2026-10-01"), lines });
		expect((await loadUsage({ root, cache })).calls).toHaveLength(4500);
	});
});
