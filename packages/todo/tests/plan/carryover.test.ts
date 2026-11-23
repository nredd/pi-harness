/**
 * Fresh-session carryover: which previous session is read, how its branch is replayed from the
 * file, and the one-shot hidden list the first request outside Plan mode gets.
 */
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
	type CarriedTodos,
	formatCarriedTodos,
	loadPreviousOpenTodos,
	previousSessionOf,
	recordOutgoing,
} from "../../src/plan/carryover.ts";
import { __resetState } from "../../src/todo.ts";
import { CARRYOVER_LIST_MESSAGE_TYPE, STATE_ENTRY_TYPE } from "../../src/tool/types.ts";
import registerTodo from "../fixtures/home-fixtures.ts";
import { TEST_HOME } from "../fixtures/setup.ts";
import { createTodoCtx, createTodoPi } from "../fixtures/todo-host.ts";

const CWD = "/work/project";

interface Row {
	id: number;
	subject: string;
	status: string;
	owner?: string;
}

const header = (id: string, extra: Record<string, unknown> = {}) => ({
	type: "session",
	version: 3,
	id,
	timestamp: "2026-01-01T00:00:00.000Z",
	cwd: CWD,
	...extra,
});

const snapshot = (id: string, parentId: string | null, tasks: Row[]) => ({
	type: "custom",
	customType: STATE_ENTRY_TYPE,
	id,
	parentId,
	timestamp: "2026-01-01T00:00:01.000Z",
	data: { persistenceVersion: 1, tasks, nextId: Math.max(0, ...tasks.map((t) => t.id)) + 1 },
});

const OPEN: Row[] = [
	{ id: 1, subject: "done", status: "completed" },
	{ id: 2, subject: "ship widgets", status: "in_progress", owner: "worker" },
	{ id: 3, subject: "verify widgets", status: "pending" },
	{ id: 4, subject: "later", status: "deferred" },
];

/** Write a session file with `lines` (objects are JSON-encoded) and a fixed mtime in seconds. */
function writeSession(dir: string, name: string, lines: unknown[], mtime: number): string {
	const path = join(dir, name);
	writeFileSync(path, `${lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`);
	utimesSync(path, mtime, mtime);
	return path;
}

const scan = (sessionDir: string, currentId = "current") => ({ sessionDir, cwd: CWD, currentId });

describe("previousSessionOf", () => {
	const manager = (overrides: Record<string, unknown> = {}) => ({
		getSessionId: () => "s1",
		getBranch: () => [] as unknown[],
		getHeader: () => ({}),
		getCwd: () => CWD,
		getSessionDir: () => "/sessions",
		getSessionFile: () => "/sessions/b.jsonl",
		...overrides,
	});
	/** The session `/new` replaces: `a.jsonl` in `cwd`, live branch `branch`. */
	const outgoingManager = (branch: unknown[], cwd = CWD) =>
		manager({
			getSessionId: () => "prev",
			getBranch: () => branch,
			getHeader: () => ({ cwd }),
			getSessionFile: () => "/sessions/a.jsonl",
		});
	const shutdown = { reason: "new", targetSessionFile: "/sessions/b.jsonl" };
	const started = { reason: "new", previousSessionFile: "/sessions/a.jsonl" };

	it("carries the live branch /new captured at shutdown, once", () => {
		recordOutgoing(shutdown, outgoingManager([snapshot("e1", null, OPEN)]));
		expect(previousSessionOf(started, manager())).toEqual({
			carried: { sessionId: "prev", tasks: [OPEN[1], OPEN[2]] },
		});
		expect(previousSessionOf(started, manager())).toBeUndefined();
	});

	it("refuses a /new capture from another cwd, predecessor or target, or with nothing open", () => {
		recordOutgoing(shutdown, outgoingManager([snapshot("e1", null, OPEN)], "/other"));
		expect(previousSessionOf(started, manager())).toBeUndefined();
		recordOutgoing(shutdown, outgoingManager([snapshot("e1", null, OPEN)]));
		expect(previousSessionOf({ reason: "new", previousSessionFile: "/sessions/z.jsonl" }, manager())).toBeUndefined();
		recordOutgoing(shutdown, outgoingManager([snapshot("e1", null, OPEN)]));
		expect(previousSessionOf(started, manager({ getSessionFile: () => "/sessions/c.jsonl" }))).toBeUndefined();
		expect(previousSessionOf(started, manager({ getSessionFile: undefined }))).toBeUndefined();
		recordOutgoing(shutdown, outgoingManager([snapshot("e1", null, [OPEN[0]])]));
		expect(previousSessionOf(started, manager())).toBeUndefined();
		// Nothing was captured for this /new at all.
		expect(previousSessionOf(started, manager())).toBeUndefined();
	});

	it("captures only /new shutdowns of a readable file-backed session", () => {
		const live = [snapshot("e1", null, OPEN)];
		recordOutgoing({ reason: "resume", targetSessionFile: "/sessions/b.jsonl" }, outgoingManager(live));
		recordOutgoing({ reason: "new" }, outgoingManager(live));
		recordOutgoing(shutdown, { ...outgoingManager(live), getSessionFile: () => undefined });
		recordOutgoing(shutdown, {
			...outgoingManager(live),
			getBranch: () => {
				throw new Error("stale");
			},
		});
		expect(previousSessionOf(started, manager())).toBeUndefined();
		recordOutgoing(shutdown, { ...outgoingManager(live), getHeader: undefined });
		expect(previousSessionOf(started, manager({ getCwd: () => undefined }))).toEqual(
			expect.objectContaining({ carried: expect.objectContaining({ sessionId: "prev" }) }),
		);
	});

	it("scans the session directory at process startup", () => {
		expect(previousSessionOf({ reason: "startup" }, manager())).toEqual({
			sessionDir: "/sessions",
			cwd: CWD,
			currentId: "s1",
		});
	});

	it.each(["resume", "fork", "reload"])("never carries over on %s", (reason) => {
		expect(previousSessionOf({ reason, previousSessionFile: "/sessions/a.jsonl" }, manager())).toBeUndefined();
	});

	it("never carries over into a non-empty branch or a child session", () => {
		expect(previousSessionOf({ reason: "startup" }, manager({ getBranch: () => [{}] }))).toBeUndefined();
		const child = manager({ getHeader: () => ({ parentSession: "/sessions/parent.jsonl" }) });
		recordOutgoing(shutdown, outgoingManager([snapshot("e1", null, OPEN)]));
		expect(previousSessionOf(started, child)).toBeUndefined();
		// The child consumed the capture: nothing is left for a later start of that file.
		expect(previousSessionOf(started, manager())).toBeUndefined();
	});

	it("has nothing to scan without a session directory, cwd or header getter", () => {
		expect(previousSessionOf({ reason: "startup" }, manager({ getSessionDir: () => "" }))).toBeUndefined();
		expect(previousSessionOf({ reason: "startup" }, manager({ getCwd: undefined }))).toBeUndefined();
		expect(previousSessionOf({ reason: "startup" }, manager({ getHeader: () => null }))).toEqual(
			expect.objectContaining({ currentId: "s1" }),
		);
		expect(previousSessionOf({ reason: "startup" }, manager({ getHeader: undefined }))).toEqual(
			expect.objectContaining({ currentId: "s1" }),
		);
	});
});

describe("loadPreviousOpenTodos", () => {
	it("returns the open todos of the predecessor's persisted branch", async () => {
		const dir = makeTestTempDir("todo-carryover-", onTestFinished);
		// The abandoned branch (e2) is not the leaf's ancestry; a partial trailing line is skipped.
		writeSession(
			dir,
			"a.jsonl",
			[
				header("prev"),
				snapshot("e1", null, [{ id: 1, subject: "old", status: "pending" }]),
				snapshot("e2", "e1", [{ id: 1, subject: "abandoned", status: "pending" }]),
				"null",
				{ type: "message", parentId: "e1" },
				snapshot("e3", "e1", OPEN),
				'{"type":"custom","id":"e4","parentId":"e3"',
			],
			100,
		);
		expect(await loadPreviousOpenTodos(scan(dir))).toEqual({ sessionId: "prev", tasks: [OPEN[1], OPEN[2]] });
	});

	it("returns a captured /new list as is", async () => {
		const carried = { sessionId: "prev", tasks: [] };
		expect(await loadPreviousOpenTodos({ carried })).toBe(carried);
	});

	it("returns undefined when nothing is open or the directory is unreadable", async () => {
		const dir = makeTestTempDir("todo-carryover-", onTestFinished);
		writeSession(dir, "a.jsonl", [header("prev"), snapshot("e1", null, [OPEN[0]])], 100);
		expect(await loadPreviousOpenTodos(scan(dir))).toBeUndefined();
		expect(await loadPreviousOpenTodos(scan(join(dir, "missing")))).toBeUndefined();
	});

	it("stops walking at a parent cycle or a missing parent", async () => {
		const cycle = makeTestTempDir("todo-carryover-", onTestFinished);
		writeSession(cycle, "a.jsonl", [header("prev"), snapshot("e1", "e2", OPEN), snapshot("e2", "e1", [OPEN[0]])], 100);
		const orphan = makeTestTempDir("todo-carryover-", onTestFinished);
		writeSession(orphan, "b.jsonl", [header("prev"), snapshot("e2", "gone", OPEN)], 100);
		expect(await loadPreviousOpenTodos(scan(cycle))).toBeUndefined();
		expect((await loadPreviousOpenTodos(scan(orphan)))?.tasks).toHaveLength(2);
	});

	it("skips a vanished or unreadable entry during discovery", async () => {
		const dir = makeTestTempDir("todo-carryover-", onTestFinished);
		writeSession(dir, "a-valid.jsonl", [header("valid"), snapshot("e1", null, OPEN)], 100);
		// A dangling link fails `stat`; a directory named like a session fails its header read.
		symlinkSync(join(dir, "gone.jsonl"), join(dir, "b-dangling.jsonl"));
		mkdirSync(join(dir, "c-dir.jsonl"));
		utimesSync(join(dir, "c-dir.jsonl"), 900, 900);
		expect((await loadPreviousOpenTodos(scan(dir)))?.sessionId).toBe("valid");
	});

	it("scans for the newest top-level same-cwd session other than the current one", async () => {
		const dir = makeTestTempDir("todo-carryover-", onTestFinished);
		const open = (subject: string) => [snapshot("e1", null, [{ id: 1, subject, status: "pending" }])];
		// Newest wins even though the older file sorts later by name.
		writeSession(dir, "z-oldest.jsonl", [header("oldest"), ...open("oldest")], 100);
		writeSession(dir, "b-chosen.jsonl", [header("chosen"), ...open("chosen")], 200);
		writeSession(dir, "c-child.jsonl", [header("child", { parentSession: "/p.jsonl" }), ...open("child")], 300);
		writeSession(dir, "d-elsewhere.jsonl", [header("elsewhere", { cwd: "/other" }), ...open("elsewhere")], 300);
		writeSession(dir, "e-current.jsonl", [header("current"), ...open("current")], 400);
		writeSession(dir, "f-headerless.jsonl", ['{"type":"message"}', ...open("headerless")], 400);
		writeFileSync(join(dir, "g-nonewline.jsonl"), JSON.stringify(header("nonewline")));
		utimesSync(join(dir, "g-nonewline.jsonl"), 500, 500);
		writeFileSync(join(dir, "h-notes.txt"), "ignored");
		writeSession(dir, "i-null.jsonl", ["null", ...open("null")], 600);
		expect(await loadPreviousOpenTodos(scan(dir))).toEqual({
			sessionId: "chosen",
			tasks: [{ id: 1, subject: "chosen", status: "pending" }],
		});
	});

	it("breaks an mtime tie by file name and reads only the chosen session", async () => {
		const dir = makeTestTempDir("todo-carryover-", onTestFinished);
		writeSession(dir, "a.jsonl", [header("a"), snapshot("e1", null, OPEN)], 100);
		writeSession(dir, "b.jsonl", [header("b"), snapshot("e1", null, [OPEN[0]])], 100);
		writeSession(dir, "c.jsonl", [header("c"), snapshot("e1", null, OPEN)], 100);
		// "c" sorts first and has open todos; a chosen session with none open never falls back.
		expect((await loadPreviousOpenTodos(scan(dir)))?.sessionId).toBe("c");
		expect(await loadPreviousOpenTodos(scan(dir, "c"))).toBeUndefined();
		expect(await loadPreviousOpenTodos(scan(makeTestTempDir("todo-carryover-", onTestFinished)))).toBeUndefined();
	});
});

describe("formatCarriedTodos", () => {
	it("names the source session, says nothing was imported, and marks owners as past", () => {
		const carried: CarriedTodos = {
			sessionId: "prev\u001b[31m",
			tasks: [
				{ id: 2, subject: "ship \u001b[31mwidgets", status: "in_progress", owner: "worker" },
				{ id: 3, subject: "verify", status: "pending" },
			],
		};
		expect(formatCarriedTodos(carried)).toBe(
			[
				"[rpiv-todo] This is a fresh session. The previous session in this directory (prev) last recorded these open todos. Nothing was imported into this session's list: those ids belong to that session, no agent owner there is running for you here, and that session may still be running elsewhere.",
				"- #2 in_progress ship widgets (was @worker)",
				"- #3 pending verify",
				"If this request continues that work, recreate the todos it still needs with `todo`. Otherwise ignore this list.",
			].join("\n"),
		);
	});
});

describe("carryover through the context hook", () => {
	const user = { role: "user", content: "go" };
	const planning = { role: "custom", customType: "plan-mode-transition", details: { version: 1, mode: "plan" } };

	beforeEach(() => __resetState());
	afterEach(() => __resetState());

	function setup(dir: string, mode: "tui" | "rpc" = "tui") {
		const { pi, captured } = createTodoPi();
		registerTodo(
			pi,
			async () => {
				throw new Error("overlay must not load in headless tests");
			},
			{ homeDir: TEST_HOME },
		);
		const handler = (name: string) => captured.handlers.get(name)?.[0] as (...args: unknown[]) => Promise<unknown>;
		const ctx = createTodoCtx({
			sessionId: "s1",
			mode,
			hasUI: false,
			sessionManager: { getSessionDir: () => dir, getCwd: () => CWD, getHeader: () => null },
		});
		return { handler, ctx };
	}

	function previousDir(): string {
		const dir = makeTestTempDir("todo-carryover-", onTestFinished);
		writeSession(dir, "prev.jsonl", [header("prev"), snapshot("e1", null, OPEN)], 100);
		return dir;
	}

	it("appends the previous session's open todos to the first request outside Plan mode, once", async () => {
		const { handler, ctx } = setup(previousDir());
		await handler("session_start")({ reason: "startup" }, ctx);
		const context = handler("context");
		expect(await context({ messages: [planning, user] }, ctx)).toBeUndefined();
		const result = (await context({ messages: [user] }, ctx)) as { messages: Record<string, unknown>[] };
		expect(result.messages).toHaveLength(2);
		expect(result.messages[1]).toMatchObject({ customType: CARRYOVER_LIST_MESSAGE_TYPE, display: false });
		expect(result.messages[1].content).toContain("(prev) last recorded");
		expect(result.messages[1].content).toContain("- #2 in_progress ship widgets (was @worker)\n- #3 pending");
		expect(await context({ messages: [user] }, ctx)).toBeUndefined();
	});

	it("lists what /new captured from the session it replaced, never another cwd's", async () => {
		for (const [cwd, listed] of [
			[CWD, true],
			["/other", false],
		] as const) {
			__resetState();
			const outgoing = createTodoCtx({
				sessionId: "prev",
				mode: "tui",
				hasUI: false,
				branch: [snapshot("e1", null, OPEN)] as never,
				sessionManager: { getHeader: () => ({ cwd }) as never, getSessionFile: () => "/sessions/prev.jsonl" },
			});
			const { handler, ctx } = setup("/unused");
			await handler("session_start")({ reason: "startup" }, outgoing);
			await handler("session_shutdown")({ reason: "new", targetSessionFile: "/tmp/test-session.jsonl" }, outgoing);
			await handler("session_start")({ reason: "new", previousSessionFile: "/sessions/prev.jsonl" }, ctx);
			const result = (await handler("context")({ messages: [user] }, ctx)) as { messages: unknown[] } | undefined;
			expect(result?.messages[1]).toEqual(
				listed ? expect.objectContaining({ customType: CARRYOVER_LIST_MESSAGE_TYPE }) : undefined,
			);
		}
	});

	it("carries nothing into a headless session or a resumed one", async () => {
		const headless = setup(previousDir(), "rpc");
		await headless.handler("session_start")({ reason: "startup" }, headless.ctx);
		expect(await headless.handler("context")({ messages: [user] }, headless.ctx)).toBeUndefined();
		__resetState();
		const resumed = setup(previousDir());
		await resumed.handler("session_start")({ reason: "resume" }, resumed.ctx);
		expect(await resumed.handler("context")({ messages: [user] }, resumed.ctx)).toBeUndefined();
	});

	it.each(["session_start", "session_shutdown"])("drops a pending carryover on %s", async (event) => {
		const { handler, ctx } = setup(previousDir());
		await handler("session_start")({ reason: "startup" }, ctx);
		await handler(event)({ reason: "reload" }, ctx);
		expect(await handler("context")({ messages: [user] }, ctx)).toBeUndefined();
	});

	it("leaves the request alone when the previous session cannot be read", async () => {
		const { handler, ctx } = setup(join(previousDir(), "missing"));
		const warn = vi.spyOn(console, "warn");
		await handler("session_start")({ reason: "startup" }, ctx);
		expect(await handler("context")({ messages: [user] }, ctx)).toBeUndefined();
		expect(warn).not.toHaveBeenCalled();
	});
});
