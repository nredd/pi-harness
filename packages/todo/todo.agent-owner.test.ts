/**
 * Todo owners and their pi-subagents state (#444), through the real extension:
 * the lifecycle bus, the live overlay, `/todos`, the settle notice, session
 * switches, child isolation and immutable history.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createMockCtx, createMockPi, makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import registerTodo from "./.test-support/home-fixtures.ts";
import { getState } from "./state/store.ts";
import { SUBAGENT_COMPLETED_EVENT, SUBAGENT_FAILED_EVENT, SUBAGENT_STARTED_EVENT } from "./tool/types.ts";
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
		for (const h of bus.get(channel) ?? []) await h(payload);
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
	const todos = async (ctx: Ctx) => {
		await cmd.handler("", ctx as never);
		const calls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
		return String(calls[calls.length - 1]?.[0]);
	};
	return { bus, handler, emit, call, toolEnd, rows, todos };
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
			"Run ended with 1 in_progress todo (#1 Audit auth), armed: no todo wakes the parent; owner agent failed or stopped: #1 Audit auth (@explore failed)",
			"warning",
		]);
	});

	it("keeps the last known state across eviction and a session switch", async () => {
		const h = setup();
		const first = createMockCtx({ sessionId: "s1", hasUI: true });
		await ownedTodo(h, first, "a1");
		await h.emit(SUBAGENT_STARTED_EVENT, { id: "a1" });
		await h.handler("session_shutdown")({}, first);
		// Arrives with no foreground bound: recorded, nothing to render, no throw.
		await h.emit(SUBAGENT_FAILED_EVENT, { id: "a1", status: "stopped" });

		const second = createMockCtx({ sessionId: "s2", hasUI: true });
		await ownedTodo(h, second, "a1");
		expect(h.rows(second)).toEqual(["└─ ◐ #1 Audit auth @a1 stopped ✗ failed"]);
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
