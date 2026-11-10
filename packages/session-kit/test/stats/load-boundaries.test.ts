import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CACHE_VERSION, isFileStats, loadUsage, opaqueId, parseSession } from "../../src/stats/load.ts";
import { assistantLine, at, sessionFile } from "./fixtures.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, stat: vi.fn(actual.stat) };
});

/** Fixed physical usage with a stable identity for cache and rejection assertions. */
function usageLine(usage: Record<string, unknown> = { input: 7 }): string {
	return JSON.stringify({
		type: "message",
		id: "answer",
		timestamp: "2026-10-01T12:00:00Z",
		message: { role: "assistant", provider: "p", model: "m", usage },
	});
}

/** Parsed real record, rather than a hand-maintained approximation of the cache schema. */
function cachedRecord() {
	return parseSession(usageLine());
}

describe("stats parser rejection boundaries", () => {
	it.each([null, [], 7, "assistant"])("rejects a non-object header: %j", (header) => {
		const parsed = parseSession(`${JSON.stringify(header)}\n${usageLine()}`);
		expect(parsed.badLines).toBe(1);
		expect(parsed.calls).toEqual([[Date.parse("2026-10-01T12:00:00Z"), 0, 7, 0, 0, 0, 0]]);
	});

	it.each([
		{ input: -1 },
		{ output: 0.5 },
		{ cacheRead: "7" },
		{ cacheWrite: Number.MAX_SAFE_INTEGER + 1 },
		{ input: 7, cost: -0.1 },
	])("drops invalid usage without losing the next valid call: %j", (usage) => {
		const parsed = parseSession(`${usageLine(usage)}\n${usageLine()}`);
		expect(parsed.badLines).toBe(1);
		expect(parsed.calls).toEqual([[Date.parse("2026-10-01T12:00:00Z"), 0, 7, 0, 0, 0, 0]]);
		expect(parsed.entryIds).toEqual([opaqueId("entry:answer")]);
	});

	it("binds persisted child markers to their own session, even after a rename", () => {
		const header = JSON.stringify({ type: "session", id: "child", timestamp: "2026-10-01T12:00:00Z" });
		const marker = (sessionId: string, version = 1) =>
			JSON.stringify({ type: "custom", customType: "session-kit:child", data: { version, sessionId } });
		const renamed = JSON.stringify({ type: "session_info", name: "renamed" });
		for (const [sessionId, version, child] of [
			["child", 1, true],
			["other", 1, false],
			["child", 2, false],
		] as const) {
			const parsed = parseSession([header, marker(sessionId, version), renamed, usageLine()].join("\n"));
			expect(parsed.child).toBe(child);
			expect(parsed.calls).toHaveLength(1);
			expect(parsed.sessionId).toBe(opaqueId("session:child"));
		}
	});

	it("rejects malformed identity and raw attribution in cached records", () => {
		const record = cachedRecord();
		expect(isFileStats(record)).toBe(true);
		for (const broken of [
			{ ...record, sessionId: "raw-session" },
			{ ...record, modelPairs: [["p"]] },
			{ ...record, modelPairs: [["p", 7]] },
			{ ...record, modelPairs: [] },
		])
			expect(isFileStats(broken)).toBe(false);
	});
});

describe("crash padding", () => {
	const NUL = (n: number): string => "\0".repeat(n);
	const assistant = usageLine();

	it.each([
		["mid-file", [NUL(174), assistant]],
		["at EOF", [assistant, NUL(2079)]],
		["several in a row", [NUL(1), NUL(8), assistant, NUL(3)]],
	])("skips an all-NUL line %s without counting it as bad", (_name, lines) => {
		const parsed = parseSession(lines.join("\n"));
		expect(parsed.badLines).toBe(0);
		expect(parsed.calls).toHaveLength(1);
	});

	it.each([`${NUL(4)}${assistant}`, `${assistant}${NUL(4)}`, `{"type":"x"${NUL(2)}`, `${NUL(2)} ${NUL(2)}`])(
		"still counts a line mixing NULs with other data as bad: %j",
		(line) => {
			expect(parseSession(`${line}\n${assistant}`).badLines).toBe(1);
		},
	);
});

describe("stats file races", () => {
	let dir: string;
	let root: string;
	let cache: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "psk-load-boundaries-"));
		root = join(dir, "sessions");
		cache = join(dir, "cache.json");
	});
	afterEach(() => {
		vi.mocked(stat).mockReset();
		rmSync(dir, { recursive: true, force: true });
	});

	/** Two ordered inputs make the second parse disappear after its successful stat. */
	function seedFiles(): [string, string] {
		const paths: [string, string] = [join(root, "a.jsonl"), join(root, "b.jsonl")];
		for (const [i, path] of paths.entries()) {
			sessionFile(path, {
				startMs: at("2026-10-01"),
				lines: [assistantLine({ ms: at("2026-10-01"), provider: "p", model: "m", input: i + 1 })],
			});
		}
		return paths;
	}

	it("counts failed stat as partial history and persists only readable files", async () => {
		const [a, b] = seedFiles();
		vi.mocked(stat).mockRejectedValueOnce(Object.assign(new Error("vanished"), { code: "ENOENT" }));
		const progress: [number, number][] = [];
		const loaded = await loadUsage({ root, cache, onProgress: (done, total) => progress.push([done, total]) });
		expect(loaded.errors).toBe(1);
		expect(loaded.calls.map((call) => call.input)).toEqual([2]);
		expect(progress).toEqual([[1, 1]]);
		expect(Object.keys(JSON.parse(readFileSync(cache, "utf8")).files)).toEqual([b]);
		expect(readFileSync(a, "utf8")).toContain('"assistant"');
	});

	it("retains last-good cached history when a stale file vanishes before parsing", async () => {
		const [a, b] = seedFiles();
		const first = await loadUsage({ root, cache });
		// Both files become stale; the first progress callback removes the second after stat.
		for (const path of [a, b]) writeFileSync(path, `${readFileSync(path, "utf8")}\n`);
		const progress: [number, number][] = [];
		const loaded = await loadUsage({
			root,
			cache,
			onProgress: (done, total) => {
				progress.push([done, total]);
				if (done === 1) rmSync(b);
			},
		});
		expect(loaded.errors).toBe(1);
		expect(loaded.calls).toEqual(first.calls);
		expect(progress).toEqual([
			[1, 2],
			[2, 2],
		]);
		expect(Object.keys(JSON.parse(readFileSync(cache, "utf8")).files)).toEqual([a, b]);
	});

	it("recomputes a version-2 cached file that counted bad lines, keeping clean ones", async () => {
		mkdirSync(root);
		const padded = join(root, "padded.jsonl");
		const clean = join(root, "clean.jsonl");
		writeFileSync(padded, `${usageLine()}\n${"\0".repeat(64)}\n`);
		writeFileSync(clean, `${usageLine()}\n`);
		const files = Object.fromEntries(
			[padded, clean].map((path) => {
				const s = statSync(path);
				return [path, { ...cachedRecord(), size: s.size, mtimeMs: s.mtimeMs, badLines: path === padded ? 1 : 0 }];
			}),
		);
		writeFileSync(cache, JSON.stringify({ version: 2, files }));
		const loaded = await loadUsage({ root, cache });
		expect(loaded.badLines).toBe(0);
		const saved = JSON.parse(readFileSync(cache, "utf8"));
		expect(saved.version).toBe(CACHE_VERSION);
		expect(saved.files[padded].badLines).toBe(0);
	});

	it("drops invalid cached identity and attribution records instead of reporting their usage", async () => {
		mkdirSync(root);
		const good = cachedRecord();
		writeFileSync(
			cache,
			JSON.stringify({
				version: CACHE_VERSION,
				files: {
					[join(root, "good.jsonl")]: good,
					[join(root, "bad-id.jsonl")]: { ...good, sessionId: "private-raw-id", calls: [[1, 0, 999, 0, 0, 0, 0]] },
					[join(root, "bad-pair.jsonl")]: { ...good, modelPairs: [["p"]], calls: [[2, 0, 999, 0, 0, 0, 0]] },
				},
			}),
		);
		const loaded = await loadUsage({ root, cache });
		expect(loaded.errors).toBe(0);
		expect(loaded.calls.map(({ provider, model, input }) => ({ provider, model, input }))).toEqual([
			{ provider: "p", model: "m", input: 7 },
		]);
	});
});
