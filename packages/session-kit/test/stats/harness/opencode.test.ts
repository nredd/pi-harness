import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entryHash, sessionHash } from "../../../src/stats/harness/common.ts";
import { type LoadSqlite, loadNodeSqlite, readOpenCode } from "../../../src/stats/harness/opencode.ts";
import type { HarnessCache, ParsedFile } from "../../../src/stats/harness/scan.ts";
import { CANARY } from "./fixtures.ts";

let dir: string;
let dbPath: string;
let writer: DatabaseSync;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "psk-opencode-"));
	dbPath = join(dir, "opencode.db");
	writer = new DatabaseSync(dbPath);
	writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
	writer.exec(`
		CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);
		CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
	`);
});
afterEach(() => {
	writer.close();
	rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.parse("2026-10-03T09:00:00Z");
function session(id: string, parent: string | null = null): void {
	writer
		.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)")
		.run(id, parent, `${CANARY} title`, `/Users/<user>/${CANARY}`, T0, T0);
}
function message(id: string, sid: string, data: Record<string, unknown>, created: number | null = T0): void {
	writer.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(id, sid, created, JSON.stringify(data));
}
const assistant = (extra: Record<string, unknown> = {}) => ({
	role: "assistant",
	providerID: "anthropic",
	modelID: "claude-opus-5-5",
	cost: 0.25,
	tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 30, write: 40 } },
	path: { cwd: `/Users/<user>/${CANARY}` },
	summary: `${CANARY} text`,
	...extra,
});

describe("readOpenCode", () => {
	it("reports a missing database as not installed, silently", async () => {
		expect(await readOpenCode(join(dir, "nope.db"))).toMatchObject({ found: false, problems: [] });
	});

	it("reads assistant messages, adds reasoning to output, flags child sessions and keeps cost", async () => {
		session("ses_1");
		session("ses_2", "ses_1");
		message("msg_1", "ses_1", assistant());
		message("msg_2", "ses_1", assistant({ cost: null, tokens: { input: 3 } }), T0 + 60_000);
		message("msg_3", "ses_2", assistant({ time: { created: T0 + 120_000 } }), null);
		message("msg_u", "ses_1", { role: "user", summary: `${CANARY}` });
		message("msg_0", "ses_1", assistant({ tokens: {} }));
		const scan = await readOpenCode(dbPath);
		expect(scan.problems).toEqual([]);
		expect(scan.calls).toHaveLength(3);
		expect(scan.calls[0]).toEqual({
			harness: "opencode",
			session: sessionHash("opencode", "ses_1"),
			entryId: entryHash("opencode", "msg_1"),
			ms: T0,
			provider: "anthropic",
			model: "claude-opus-5-5",
			input: 10,
			output: 25,
			cacheRead: 30,
			cacheWrite: 40,
			cost: 0.25,
		});
		expect(scan.calls[1]).toMatchObject({ input: 3, output: 0, cost: null });
		expect(scan.calls[2]).toMatchObject({ ms: T0 + 120_000, session: sessionHash("opencode", "ses_2") });
		expect(scan.sessionMetadata).toHaveLength(2);
		expect(scan.sessions).toEqual([
			{ path: sessionHash("opencode", "ses_1"), startMs: T0, endMs: T0 + 60_000, child: false },
		]);
	});

	it("sees WAL-only rows without writing to the database", async () => {
		session("ses_1");
		message("msg_1", "ses_1", assistant());
		// The writer is still open and never checkpointed: the rows live only in the -wal file.
		expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
		expect(statSync(dbPath).size).toBeLessThan(statSync(`${dbPath}-wal`).size);
		const files = [dbPath, `${dbPath}-wal`];
		const before = files.map((f) => ({ bytes: readFileSync(f), mtimeMs: statSync(f).mtimeMs }));
		const scan = await readOpenCode(dbPath);
		expect(scan.calls).toHaveLength(1);
		files.forEach((f, i) => {
			expect(readFileSync(f).equals(before[i]?.bytes as Buffer)).toBe(true);
			expect(statSync(f).mtimeMs).toBe(before[i]?.mtimeMs);
		});
	});

	it("leaves the directory listing unchanged when reading a checkpointed database", async () => {
		session("ses_1");
		message("msg_1", "ses_1", assistant());
		writer.close();
		expect(readdirSync(dir)).toEqual(["opencode.db"]);
		writer = new DatabaseSync(":memory:");
		const scan = await readOpenCode(dbPath);
		expect(scan.calls).toHaveLength(1);
		expect(readdirSync(dir)).toEqual(["opencode.db"]);
	});

	it("reports a locked database as busy, without error text", async () => {
		const plain = join(dir, "plain.db");
		const lock = new DatabaseSync(plain);
		lock.exec("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
		lock.exec("CREATE TABLE session (id TEXT, parent_id TEXT)");
		lock.exec("BEGIN EXCLUSIVE");
		try {
			const scan = await readOpenCode(plain);
			expect(scan).toMatchObject({ found: true, calls: [], problems: ["opencode: database busy, skipped"] });
			expect(JSON.stringify(scan)).not.toContain(dir);
		} finally {
			lock.exec("ROLLBACK");
			lock.close();
		}
	});

	it("never projects titles, directories, message bodies or native IDs", async () => {
		session("ses_1");
		message("msg_1", "ses_1", assistant());
		const text = JSON.stringify(await readOpenCode(dbPath));
		expect(text).not.toContain(CANARY);
		for (const native of ["ses_1", "msg_1"]) expect(text).not.toContain(native);
	});

	it("skips a message whose data is not JSON without losing the rest", async () => {
		session("ses_1");
		message("ok", "ses_1", assistant());
		writer.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("bad", "ses_1", T0, "{not json");
		const scan = await readOpenCode(dbPath);
		expect(scan.calls).toHaveLength(1);
		expect(scan.problems).toEqual([]);
	});

	it("counts unreadable rows", async () => {
		session("ses_1");
		message("m1", "ses_1", assistant({ tokens: { input: -1 } }));
		message("m2", "ses_1", assistant({ cost: "free" }));
		message("m3", "ses_1", assistant({ cost: -1 }));
		message("m4", "ses_1", assistant({ providerID: undefined }));
		message("m5", "ses_1", assistant({ modelID: undefined }));
		message("m6", "ses_1", assistant(), 0);
		message("m7", "ses_1", assistant({ tokens: { input: 1.5 } }));
		message("ok", "ses_1", assistant());
		const scan = await readOpenCode(dbPath);
		expect(scan.calls).toHaveLength(1);
		expect(scan.problems).toEqual(["opencode: ! 7 unreadable lines"]);
	});

	it("degrades to a diagnostic on schema drift, a non-database file or a missing node:sqlite", async () => {
		const drift = join(dir, "drift.db");
		const other = new DatabaseSync(drift);
		other.exec("CREATE TABLE message (id TEXT, body TEXT)");
		other.close();
		const garbage = join(dir, "garbage.db");
		writeFileSync(garbage, `${CANARY} not sqlite`.repeat(100));
		const expected = {
			found: true,
			calls: [],
			problems: ["opencode: database unreadable (missing node:sqlite or unexpected schema), skipped"],
		};
		expect(await readOpenCode(drift)).toMatchObject(expected);
		const scan = await readOpenCode(garbage);
		expect(scan).toMatchObject(expected);
		expect(JSON.stringify(scan)).not.toContain(CANARY);
		expect(await readOpenCode(dbPath, () => Promise.reject(new Error("no node:sqlite")))).toMatchObject(expected);
	});

	it("loads the real node:sqlite", async () => {
		expect(typeof (await loadNodeSqlite()).DatabaseSync).toBe("function");
	});
});

describe("readOpenCode cache and paging", () => {
	it("serves a repeat read from the cache while the database is unchanged, and re-reads once it changes", async () => {
		session("ses_1");
		message("m1", "ses_1", assistant());
		const cache: HarnessCache = {};
		const first = await readOpenCode(dbPath, loadNodeSqlite, { cache });
		const mustNotOpen: LoadSqlite = () => Promise.reject(new Error("opened"));
		expect(await readOpenCode(dbPath, mustNotOpen, { cache })).toEqual(first);
		message("m2", "ses_1", assistant({ cost: 1 }));
		const third = await readOpenCode(dbPath, loadNodeSqlite, { cache });
		expect(third.calls.map((c) => c.cost)).toEqual([0.25, 1]);
		// cached per session, keyed under the database, and free of content
		expect(Object.keys(cache.opencode ?? {}).every((key) => key.startsWith(`${dbPath}#`))).toBe(true);
		expect(JSON.stringify(cache)).not.toContain(CANARY);
	});

	it("forgets sessions deleted from the database when it is re-read", async () => {
		session("ses_1");
		session("ses_2");
		message("m1", "ses_1", assistant());
		message("m2", "ses_2", assistant());
		const cache: HarnessCache = {};
		expect((await readOpenCode(dbPath, loadNodeSqlite, { cache })).sessions).toHaveLength(2);
		const other = cache.opencode?.[`${dbPath}#stamp`] as ParsedFile;
		(cache.opencode as Record<string, ParsedFile>)["/elsewhere/opencode.db#stamp"] = other;
		writer.prepare("DELETE FROM message WHERE session_id = ?").run("ses_2");
		expect((await readOpenCode(dbPath, loadNodeSqlite, { cache })).sessions).toHaveLength(1);
		// another database's entries are not this one's to forget
		expect(cache.opencode?.["/elsewhere/opencode.db#stamp"]).toBe(other);
	});

	it("counts unreadable rows from the cache too", async () => {
		session("ses_1");
		message("m1", "ses_1", assistant({ tokens: { input: -1 } }));
		const cache: HarnessCache = {};
		const first = await readOpenCode(dbPath, loadNodeSqlite, { cache });
		expect(first.problems).toEqual(["opencode: ! 1 unreadable lines"]);
		expect((await readOpenCode(dbPath, () => Promise.reject(new Error("opened")), { cache })).problems).toEqual(
			first.problems,
		);
	});

	it("reads in pages and yields to the event loop between them, reporting progress", async () => {
		session("ses_1");
		for (let i = 0; i < 6; i++) message(`m${i}`, "ses_1", assistant());
		let ticks = 0;
		let running = true;
		const tick = (): void => {
			if (!running) return;
			ticks++;
			setImmediate(tick);
		};
		setImmediate(tick);
		const seen: number[] = [];
		const scan = await readOpenCode(dbPath, loadNodeSqlite, { pageRows: 2, onRows: (n) => seen.push(n) });
		running = false;
		expect(scan.calls).toHaveLength(6);
		expect(seen).toEqual([2, 4, 6]);
		expect(ticks).toBeGreaterThanOrEqual(3);
		// the same answer as one big page
		expect(scan).toEqual(await readOpenCode(dbPath));
	});

	it("stops paging when the last ID cannot advance the cursor", async () => {
		const stubbed =
			(rows: Record<string, unknown>[]): LoadSqlite =>
			async () => ({
				DatabaseSync: class {
					exec(): void {}
					prepare() {
						return { all: () => rows };
					}
					close(): void {}
				},
			});
		const numeric = [{ id: 5 }, { id: 6 }];
		expect((await readOpenCode(dbPath, stubbed(numeric), { pageRows: 2 })).problems).toEqual([
			"opencode: ! 2 unreadable lines",
		]);
		const stuck = [{ id: "a" }, { id: "a" }];
		expect((await readOpenCode(dbPath, stubbed(stuck), { pageRows: 2 })).problems).toEqual([
			"opencode: ! 4 unreadable lines",
		]);
	});
});
