import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entryHash, sessionHash } from "../../../src/stats/harness/common.ts";
import { loadNodeSqlite, readOpenCode } from "../../../src/stats/harness/opencode.ts";
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
		.run(id, parent, `${CANARY} title`, `/Users/${CANARY}`, T0, T0);
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
	path: { cwd: `/Users/${CANARY}` },
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
		expect(scan.calls[1]).toMatchObject({ input: 3, output: 0, cost: 0 });
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

	it("never projects titles, directories, message bodies or native IDs", async () => {
		session("ses_1");
		message("msg_1", "ses_1", assistant());
		const text = JSON.stringify(await readOpenCode(dbPath));
		expect(text).not.toContain(CANARY);
		for (const native of ["ses_1", "msg_1"]) expect(text).not.toContain(native);
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
