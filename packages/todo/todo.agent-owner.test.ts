/**
 * Todo owners and their pi-subagents state (#444), through the real extension:
 * the lifecycle bus, the live overlay, `/todos`, the settle notice, session
 * switches, child isolation and immutable history; then repeated settles
 * during background work (#448).
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createMockCtx, createMockPi, makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import registerTodo from "./.test-support/home-fixtures.ts";
import { getState } from "./state/store.ts";
import {
	SUBAGENT_COMPLETED_EVENT,
	SUBAGENT_CREATED_EVENT,
	SUBAGENT_FAILED_EVENT,
	SUBAGENT_STARTED_EVENT,
} from "./tool/types.ts";
import { renderTodoResult } from "./view/format.ts";

type Handler = (...args: unknown[]) => unknown;
type Ctx = ReturnType<typeof createMockCtx>;

const plainTheme = makeTheme({ fg: (_c, text) => text, strikethrough: (text) => text }) as unknown as Theme;

function setup() {
	const bus = new Map<string, Handler[]>();
	const { pi, captured } = createMockPi({
		events: {
			emit: vi.fn(),
			on: vi.fn((channel: string, handler: Handler) => {
				bus.set(channel, [...(bus.get(channel) ?? []), handler]);
				return () => {};
			}),
		},
	} as never);
	registerTodo(pi);
	const handler = (name: string) => {
		const found = captured.events.get(name)?.[0];
		if (!found) throw new Error(`${name} not registered`);
		return found;
	};
	const tool = captured.tools.get("todo");
	const cmd = captured.commands.get("todos");
	if (!tool || !cmd) throw new Error("todo tool or command not registered");
	const emit = async (channel: string, payload: Record<string, unknown>) => {
		// Existing lifecycle fixtures represent background agents unless a test says otherwise.
		const event = { wakesParent: true, ...payload };
		for (const h of bus.get(channel) ?? []) await h(event);
	};
	const call = (ctx: Ctx, params: Record<string, unknown>) =>
		tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx as never);
	const toolEnd = () => handler("tool_execution_end")({ toolName: "todo", isError: false });
	/** Rows the live overlay currently paints (identity theme), heading excluded. */
	const rows = (ctx: Ctx) => {
		const setWidget = ctx.ui.setWidget as ReturnType<typeof vi.fn>;
		const registered = setWidget.mock.calls.filter((call: unknown[]) => call[1] !== undefined);
		const factory = registered[registered.length - 1]?.[1];
		if (!factory) return [];
		const widget = factory({ requestRender: vi.fn() }, plainTheme) as { render(w: number): string[] };
		return widget.render(200).slice(1, -1);
	};
	/** Mount the registered widget on a fresh TUI stub, as Pi does, and return the stub. */
	const mount = (ctx: Ctx) => {
		const setWidget = ctx.ui.setWidget as ReturnType<typeof vi.fn>;
		const registered = setWidget.mock.calls.filter((call: unknown[]) => call[1] !== undefined);
		const tui = { requestRender: vi.fn() };
		registered[registered.length - 1]?.[1](tui, plainTheme);
		return tui;
	};
	const todos = async (ctx: Ctx) => {
		await cmd.handler("", ctx as never);
		const calls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
		return String(calls[calls.length - 1]?.[0]);
	};
	return { bus, handler, emit, call, toolEnd, rows, mount, todos };
}

async function ownedTodo(h: ReturnType<typeof setup>, ctx: Ctx, owner: string) {
	await h.handler("session_start")({ reason: "startup" }, ctx);
	await h.call(ctx, { action: "create", subject: "Audit auth", owner });
	await h.call(ctx, { action: "update", id: 1, status: "in_progress" });
	await h.toolEnd();
}

describe("owner matches a subagent", () => {
	it("shows running, flips to done, and leaves the todo in_progress", async () => {
		const h = setup();
		const ctx = createMockCtx({ sessionId: "s1", hasUI: true });
		await ownedTodo(h, ctx, "auth-audit");
		await h.emit(SUBAGENT_STARTED_EVENT, {
			id: "a1",
			type: "general-purpose",
			handle: "general-purpose",
			name: "auth-audit",
		});
		expect(h.rows(ctx)).toEqual(["└─ ◐ #1 Audit auth @auth-audit running"]);

		await h.emit(SUBAGENT_COMPLETED_EVENT, { id: "a1", status: "completed" });
		expect(h.rows(ctx)).toEqual(["└─ ◐ #1 Audit auth @auth-audit done"]);
		expect(getState("s1").tasks[0].status).toBe("in_progress");
		expect(await h.todos(ctx)).toContain("◐ #1 Audit auth @auth-audit done");
	});

	it("marks a failed agent's todo and names it in the settle warning", async () => {
		const h = setup();
		const ctx = createMockCtx({ sessionId: "s1", hasUI: true });
		await ownedTodo(h, ctx, "@explore");
		await h.emit(SUBAGENT_STARTED_EVENT, { id: "a1", handle: "explore" });
		await h.emit(SUBAGENT_FAILED_EVENT, { id: "a1", status: "error" });
		expect(h.rows(ctx)).toEqual(["└─ ◐ #1 Audit auth @explore ✗ failed"]);

		await h.handler("agent_settled")({ type: "agent_settled" }, ctx);
		expect((ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual([
			"Run ended with 1 in_progress todo, armed: no todo-owned wake (monitor and agent notices list session wakes); owner agent failed or stopped: #1 Audit auth (@explore failed)",
			"warning",
		]);
	});

	it("keeps the last known state within a session after the agent goes quiet", async () => {
		const h = setup();
		const ctx = createMockCtx({ sessionId: "s1", hasUI: true });
		await ownedTodo(h, ctx, "a1");
		await h.emit(SUBAGENT_FAILED_EVENT, { id: "a1", status: "stopped" });
		// Eviction emits nothing, so later work in the session still shows the last state.
		await h.call(ctx, { action: "create", subject: "Next" });
		await h.toolEnd();
		expect(h.rows(ctx)[0]).toBe("├─ ◐ #1 Audit auth @a1 ✗ stopped");
	});

	it("never shows another session's agent after a session switch", async () => {
		const h = setup();
		const first = createMockCtx({ sessionId: "s1", hasUI: true });
		await ownedTodo(h, first, "scout");
		await h.emit(SUBAGENT_FAILED_EVENT, { id: "a1", handle: "scout", status: "error" });
		expect(h.rows(first)).toEqual(["└─ ◐ #1 Audit auth @scout ✗ failed"]);
		await h.handler("session_shutdown")({}, first);
		// Arrives with no session bound: dropped, nothing to render, no throw.
		await h.emit(SUBAGENT_COMPLETED_EVENT, { id: "a1", handle: "scout" });

		const second = createMockCtx({ sessionId: "s2", hasUI: true });
		await ownedTodo(h, second, "scout");
		expect(h.rows(second)).toEqual(["└─ ◐ #1 Audit auth @scout"]);
		await h.emit(SUBAGENT_STARTED_EVENT, { id: "b1", handle: "scout" });
		expect(h.rows(second)).toEqual(["└─ ◐ #1 Audit auth @scout running"]);
	});

	it("forgets a session's agents when it shuts down, so a resume starts without stale states", async () => {
		const h = setup();
		const first = createMockCtx({ sessionId: "s1", hasUI: true });
		await ownedTodo(h, first, "scout");
		await h.emit(SUBAGENT_STARTED_EVENT, { id: "a1", handle: "scout" });
		await h.handler("session_shutdown")({}, first);

		const resumed = createMockCtx({ sessionId: "s1", hasUI: true });
		await ownedTodo(h, resumed, "scout");
		expect(h.rows(resumed)).toEqual(["└─ ◐ #1 Audit auth @scout"]);
	});

	it("repaints the live overlay when an owner's agent changes state", async () => {
		const h = setup();
		const ctx = createMockCtx({ sessionId: "s1", hasUI: true });
		await ownedTodo(h, ctx, "scout");
		const tui = h.mount(ctx);
		await h.emit(SUBAGENT_STARTED_EVENT, { id: "a1", handle: "scout" });
		expect(tui.requestRender).toHaveBeenCalledTimes(1);
		// An unchanged state is not a repaint.
		await h.emit(SUBAGENT_STARTED_EVENT, { id: "a1", handle: "scout" });
		expect(tui.requestRender).toHaveBeenCalledTimes(1);
	});

	it("matches a spawner name typed as free text, e.g. Auth Audit", async () => {
		const h = setup();
		const ctx = createMockCtx({ sessionId: "s1", hasUI: true });
		await ownedTodo(h, ctx, "Auth Audit");
		await h.emit(SUBAGENT_STARTED_EVENT, { id: "a1", handle: "general-purpose", name: "auth-audit" });
		expect(h.rows(ctx)).toEqual(["└─ ◐ #1 Audit auth @Auth Audit running"]);
	});
});

describe("owner without a live agent", () => {
	it("renders free text that matches no agent without a state", async () => {
		const h = setup();
		const ctx = createMockCtx({ sessionId: "s1", hasUI: true });
		await ownedTodo(h, ctx, "Sergii");
		await h.emit(SUBAGENT_STARTED_EVENT, { id: "a1", handle: "explore" });
		expect(h.rows(ctx)).toEqual(["└─ ◐ #1 Audit auth @Sergii"]);
		expect((await h.todos(ctx)).split("\n")).toContain("  ◐ #1 Audit auth @Sergii");
	});

	it("renders the owner alone when pi-subagents never emits", async () => {
		const h = setup();
		const ctx = createMockCtx({ sessionId: "s1", hasUI: true });
		await ownedTodo(h, ctx, "explore");
		expect(h.rows(ctx)).toEqual(["└─ ◐ #1 Audit auth @explore"]);
		await h.handler("agent_settled")({ type: "agent_settled" }, ctx);
		expect((ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).not.toContain("owner agent");
	});
});

describe("isolation and history", () => {
	it("never lets agent events or a child session read or write the parent list", async () => {
		const h = setup();
		const parent = createMockCtx({ sessionId: "parent", hasUI: true });
		const child = createMockCtx({ sessionId: "child", hasUI: true });
		await ownedTodo(h, parent, "a1");
		const before = getState("parent");
		await h.handler("session_start")({ reason: "startup" }, child);
		await h.emit(SUBAGENT_STARTED_EVENT, { id: "a1" });
		await h.emit(SUBAGENT_FAILED_EVENT, { id: "a1", status: "error" });

		expect(getState("parent")).toBe(before);
		const listed = await h.call(child, { action: "list" });
		expect(listed?.details).toMatchObject({ tasks: [] });
		await h.call(child, { action: "create", subject: "child work" });
		expect(getState("parent").tasks.map((t) => t.subject)).toEqual(["Audit auth"]);
	});

	it("keeps live agent state out of persisted results and settled rows", async () => {
		const h = setup();
		const ctx = createMockCtx({ sessionId: "s1", hasUI: true });
		await ownedTodo(h, ctx, "a1");
		await h.emit(SUBAGENT_FAILED_EVENT, { id: "a1", status: "error" });
		const got = await h.call(ctx, { action: "get", id: 1 });
		const text = got?.content.map((c) => ("text" in c ? c.text : "")).join("");
		expect(text).toContain("owner: a1");
		expect(text).not.toContain("failed");
		const updated = await h.call(ctx, { action: "update", id: 1, activeForm: "auditing" });
		const row = renderTodoResult(updated as never, plainTheme, { expanded: true })
			.render(200)
			.join("\n");
		expect(row).not.toMatch(/failed|@a1/);
	});
});

describe("repeated settles during background work (#448)", () => {
	const ARMED = "armed: no todo-owned wake (monitor and agent notices list session wakes)";

	/** Four in_progress todos: an agent's, one blocked on it, a monitored deploy, a stale recovery. */
	async function orchestration(h: ReturnType<typeof setup>, ctx: Ctx) {
		await h.handler("session_start")({ reason: "startup" }, ctx);
		await h.call(ctx, {
			ops: [
				{ action: "create", subject: "Audit auth", owner: "scout" },
				{ action: "create", subject: "Admit TV scope" },
				{ action: "create", subject: "Deploy under CI monitor" },
				{ action: "create", subject: "Recover stale branch" },
			],
		});
		await h.call(ctx, { action: "update", id: 2, addBlockedBy: [1] });
		for (const id of [1, 2, 3, 4]) await h.call(ctx, { action: "update", id, status: "in_progress" });
		await h.toolEnd();
		await h.emit(SUBAGENT_STARTED_EVENT, { id: "a1", handle: "scout" });
	}

	const settle = async (h: ReturnType<typeof setup>, ctx: Ctx) => {
		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
		notify.mockClear();
		await h.handler("agent_settled")({ type: "agent_settled" }, ctx);
		return notify.mock.calls;
	};

	it("repeats a warning on every settle and an unchanged info report only once", async () => {
		const h = setup();
		const ctx = createMockCtx({ sessionId: "s1", hasUI: true });
		await orchestration(h, ctx);

		// Parent-held work warns on every settle: nothing else will move it.
		const held = [
			`Run ended with 4 in_progress todos, ${ARMED}; held by the parent: #3 Deploy under CI monitor, #4 Recover stale branch; blocked: #2 Admit TV scope (by #1); agent running: #1 Audit auth (@scout running)`,
			"warning",
		];
		expect(await settle(h, ctx)).toEqual([held]);
		expect(await settle(h, ctx)).toEqual([held]);

		// Once only the child and its dependent are open, a wake that changed nothing settles silently.
		await h.call(ctx, { action: "update", id: 3, status: "completed", evidence: "CI green, deployed" });
		await h.call(ctx, { action: "update", id: 4, status: "completed", evidence: "branch deleted" });
		expect(await settle(h, ctx)).toEqual([
			[
				`Run ended with 2 in_progress todos, ${ARMED}; blocked: #2 Admit TV scope (by #1); agent running: #1 Audit auth (@scout running)`,
				"info",
			],
		]);
		expect(await settle(h, ctx)).toEqual([]);
		expect(await settle(h, ctx)).toEqual([]);

		// The child fails: its todo is abandoned, #2's only blocker is dead, and both warn every settle.
		await h.emit(SUBAGENT_FAILED_EVENT, { id: "a1", status: "error" });
		const failed = [
			`Run ended with 2 in_progress todos, ${ARMED}; owner agent failed or stopped: #1 Audit auth (@scout failed); held by the parent: #2 Admit TV scope (by #1 in_progress)`,
			"warning",
		];
		expect(await settle(h, ctx)).toEqual([failed]);
		expect(await settle(h, ctx)).toEqual([failed]);

		// A retry under the same name revives the dependency: info again, once.
		await h.emit(SUBAGENT_STARTED_EVENT, { id: "a2", handle: "scout" });
		expect((await settle(h, ctx))[0]?.[1]).toBe("info");
		expect(await settle(h, ctx)).toEqual([]);

		// The dependency resolves: #2 is no longer blocked, so it is reported as parent-held.
		await h.call(ctx, { action: "update", id: 1, status: "completed", evidence: "re-ran audit" });
		expect((await settle(h, ctx))[0]).toEqual([
			`Run ended with 1 in_progress todo, ${ARMED}; held by the parent: #2 Admit TV scope`,
			"warning",
		]);
	});

	it("shows an unchanged info report again after a person prompts, not after an extension prompt", async () => {
		const h = setup();
		const ctx = createMockCtx({ sessionId: "s1", hasUI: true });
		await orchestration(h, ctx);
		for (const id of [3, 4]) await h.call(ctx, { action: "update", id, status: "completed", evidence: "done" });
		expect(await settle(h, ctx)).toHaveLength(1);

		// Monitor and agent wakes run no input handlers at all; `/loop` and `/goal` prompts are `extension`.
		await h.handler("input")({ type: "input", text: "goal nudge", source: "extension" }, ctx);
		expect(await settle(h, ctx)).toEqual([]);

		await h.handler("input")({ type: "input", text: "status?", source: "interactive" }, ctx);
		expect(await settle(h, ctx)).toHaveLength(1);
	});

	it("is info while every todo waits on a running agent, and warns when it finishes unconsumed", async () => {
		const h = setup();
		const ctx = createMockCtx({ sessionId: "s1", hasUI: true });
		await ownedTodo(h, ctx, "scout");
		await h.emit(SUBAGENT_STARTED_EVENT, { id: "a1", handle: "scout" });
		expect((await settle(h, ctx))[0]?.[1]).toBe("info");
		await h.emit(SUBAGENT_COMPLETED_EVENT, { id: "a1", status: "completed" });
		expect((await settle(h, ctx))[0]).toEqual([
			`Run ended with 1 in_progress todo, ${ARMED}; held by the parent: #1 Audit auth (@scout done)`,
			"warning",
		]);
	});

	it("repeats a warning for a silent agent, then dedupes after a verified handoff", async () => {
		const h = setup();
		const ctx = createMockCtx({ sessionId: "s1", hasUI: true });
		await ownedTodo(h, ctx, "scout");
		await h.emit(SUBAGENT_STARTED_EVENT, { id: "a1", handle: "scout", wakesParent: false, runSeq: 10 });
		expect((await settle(h, ctx))[0]?.[1]).toBe("warning");
		expect((await settle(h, ctx))[0]?.[1]).toBe("warning");
		await h.emit(SUBAGENT_CREATED_EVENT, { id: "a1", backgroundHandoff: true, runSeq: 9 });
		expect((await settle(h, ctx))[0]?.[1]).toBe("warning");
		await h.emit(SUBAGENT_CREATED_EVENT, { id: "a1", backgroundHandoff: true, runSeq: 10 });
		expect((await settle(h, ctx))[0]?.[1]).toBe("info");
		await h.emit(SUBAGENT_CREATED_EVENT, { id: "a1", backgroundHandoff: true, runSeq: 10 });
		expect(await settle(h, ctx)).toEqual([]);
	});

	it("counts a queued Agent spawn with running, then follows started and completed", async () => {
		const h = setup();
		const ctx = createMockCtx({ sessionId: "s1", hasUI: true });
		await ownedTodo(h, ctx, "scout");
		await h.emit(SUBAGENT_CREATED_EVENT, { id: "a1", handle: "scout", isBackground: true });
		expect(await settle(h, ctx)).toEqual([
			[`Run ended with 1 in_progress todo, ${ARMED}; agent running: #1 Audit auth (@scout queued)`, "info"],
		]);
		await h.emit(SUBAGENT_STARTED_EVENT, { id: "a1", handle: "scout" });
		expect(await settle(h, ctx)).toEqual([
			[`Run ended with 1 in_progress todo, ${ARMED}; agent running: #1 Audit auth (@scout running)`, "info"],
		]);
		await h.emit(SUBAGENT_COMPLETED_EVENT, { id: "a1", status: "completed" });
		const done = [
			`Run ended with 1 in_progress todo, ${ARMED}; held by the parent: #1 Audit auth (@scout done)`,
			"warning",
		];
		expect(await settle(h, ctx)).toEqual([done]);

		// A detached resume re-announces the id after it completed: still done, still a warning.
		await h.emit(SUBAGENT_CREATED_EVENT, { id: "a1", handle: "scout", isBackground: true });
		expect(await settle(h, ctx)).toEqual([done]);
	});

	it("warns when a numbered retry fails while the named owner is still queued", async () => {
		const h = setup();
		const ctx = createMockCtx({ sessionId: "s1", hasUI: true });
		await ownedTodo(h, ctx, "auth-audit");
		await h.emit(SUBAGENT_CREATED_EVENT, { id: "a1", name: "auth-audit", nameBase: "auth-audit" });
		expect((await settle(h, ctx))[0]?.[1]).toBe("info");
		expect(await settle(h, ctx)).toEqual([]);
		expect(await settle(h, ctx)).toEqual([]);
		await h.emit(SUBAGENT_STARTED_EVENT, { id: "a2", name: "auth-audit-2", nameBase: "auth-audit" });
		await h.emit(SUBAGENT_FAILED_EVENT, { id: "a2", status: "error" });
		const failed = [
			`Run ended with 1 in_progress todo, ${ARMED}; owner agent failed or stopped: #1 Audit auth (@auth-audit failed)`,
			"warning",
		];
		expect(await settle(h, ctx)).toEqual([failed]);
		expect(await settle(h, ctx)).toEqual([failed]);
	});

	it("warns once pi-subagents reports a queued owner stopped before it started", async () => {
		const h = setup();
		const ctx = createMockCtx({ sessionId: "s1", hasUI: true });
		await ownedTodo(h, ctx, "scout");
		await h.emit(SUBAGENT_CREATED_EVENT, { id: "a1", handle: "scout", isBackground: true });
		expect((await settle(h, ctx))[0]?.[1]).toBe("info");
		await h.emit(SUBAGENT_FAILED_EVENT, { id: "a1", handle: "scout", status: "stopped" });
		const stopped = [
			`Run ended with 1 in_progress todo, ${ARMED}; owner agent failed or stopped: #1 Audit auth (@scout stopped)`,
			"warning",
		];
		expect(await settle(h, ctx)).toEqual([stopped]);
		expect(await settle(h, ctx)).toEqual([stopped]);
	});

	it("reports again once the list empties and refills, and forgets a shut-down session", async () => {
		const h = setup();
		const ctx = createMockCtx({ sessionId: "s1", hasUI: true });
		await ownedTodo(h, ctx, "scout");
		await h.emit(SUBAGENT_STARTED_EVENT, { id: "a1", handle: "scout" });
		expect(await settle(h, ctx)).toHaveLength(1);
		expect(await settle(h, ctx)).toEqual([]);
		await h.call(ctx, { action: "update", id: 1, status: "pending" });
		expect(await settle(h, ctx)).toEqual([]);
		await h.call(ctx, { action: "update", id: 1, status: "in_progress" });
		expect(await settle(h, ctx)).toHaveLength(1);

		await h.handler("session_shutdown")({}, ctx);
		const resumed = createMockCtx({ sessionId: "s1", hasUI: true });
		await ownedTodo(h, resumed, "scout");
		await h.emit(SUBAGENT_STARTED_EVENT, { id: "a1", handle: "scout" });
		expect(await settle(h, resumed)).toHaveLength(1);
	});
});
