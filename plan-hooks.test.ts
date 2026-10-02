import type { Theme } from "@earendil-works/pi-coding-agent";
import { createMockCtx, createMockPi, makeTheme } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerTodo from "./index.js";
import { PLAN_REMINDER_MARKER } from "./plan-hooks.js";
import { replayFromBranch } from "./state/replay.js";
import { getState } from "./state/store.js";
import { __resetState } from "./todo.js";
import { PLAN_APPROVED_EVENT, PLAN_REMINDER_MESSAGE_TYPE, STATE_ENTRY_TYPE, type TaskDetails } from "./tool/types.js";
import { renderTodoResult } from "./view/format.js";

const PLAN = `# Add widgets

## Work
- Add the \`alpha\` module
- Wire \`beta\` into the CLI

## Verification
- \`make test\` passes
`;

type Handler = (...args: unknown[]) => unknown;

function setup() {
	__resetState();
	const bus = new Map<string, Handler[]>();
	const appendEntry = vi.fn();
	const { pi, captured } = createMockPi({
		appendEntry,
		events: {
			emit: vi.fn((channel: string, data: unknown) => {
				for (const handler of bus.get(channel) ?? []) void handler(data);
			}),
			on: vi.fn((channel: string, handler: Handler) => {
				bus.set(channel, [...(bus.get(channel) ?? []), handler]);
				return () => {};
			}),
		},
	} as never);
	registerTodo(pi, async () => {
		throw new Error("overlay must not load in headless tests");
	});
	const handler = (name: string) => {
		const found = captured.events.get(name)?.[0];
		if (!found) throw new Error(`${name} not registered`);
		return found;
	};
	const tool = captured.tools.get("todo");
	if (!tool) throw new Error("todo tool not registered");
	const announce = async (payload: Record<string, unknown>) => {
		for (const h of bus.get(PLAN_APPROVED_EVENT) ?? []) await h(payload);
	};
	const call = (ctx: unknown, params: Record<string, unknown>) =>
		tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx as never);
	return { handler, announce, appendEntry, call, bus };
}

const approval = (planId: string, sessionId = "s1", plan = PLAN) => ({ version: 1, planId, plan, sessionId });

function text(result: { content: Array<{ type: string; text?: string }> } | undefined): string {
	return result?.content.map((c) => c.text ?? "").join("") ?? "";
}

beforeEach(() => __resetState());
afterEach(() => __resetState());

describe("plan approval event", () => {
	it("seeds verbatim plan todos for the live session and persists a snapshot", async () => {
		const { handler, announce, appendEntry, call } = setup();
		const ctx = createMockCtx({ sessionId: "s1" });
		await handler("session_start")({}, ctx);
		await announce(approval("p1"));

		expect(getState("s1").tasks.map((t) => [t.id, t.subject, t.source])).toEqual([
			[1, "Add the `alpha` module", "plan"],
			[2, "Wire `beta` into the CLI", "plan"],
			[3, "`make test` passes", "plan"],
		]);
		expect(appendEntry).toHaveBeenCalledTimes(1);
		const [type, data] = appendEntry.mock.calls[0];
		expect(type).toBe(STATE_ENTRY_TYPE);
		// Replay sees the custom entry exactly like a todo tool result.
		const replayed = replayFromBranch({
			sessionManager: { getBranch: () => [{ type: "custom", customType: type, data }] },
		});
		expect(replayed).toEqual(getState("s1"));
		expect(replayed.plan).toEqual({ id: "p1", title: "Add widgets" });

		const list = text(await call(ctx, { action: "list" }));
		expect(list.split("\n")[0]).toBe("Plan: Add widgets -- 3/3 plan items open");
		expect(list).toContain("[pending] #2 Wire `beta` into the CLI [plan: Work]");
	});

	it("holds an approval for a session that hasn't started here yet", async () => {
		const { handler, announce } = setup();
		await announce(approval("p1", "fresh"));
		expect(getState("fresh").tasks).toEqual([]);
		await handler("session_start")({}, createMockCtx({ sessionId: "fresh" }));
		expect(getState("fresh").tasks).toHaveLength(3);
	});

	it("replaces plan todos on re-approval, ignores a re-announcement, keeps agent todos", async () => {
		const { handler, announce, appendEntry, call } = setup();
		const ctx = createMockCtx({ sessionId: "s1" });
		await handler("session_start")({}, ctx);
		await call(ctx, { action: "create", subject: "agent todo" });
		await announce(approval("p1"));
		await announce(approval("p1"));
		expect(appendEntry).toHaveBeenCalledTimes(1);

		await announce(approval("p2", "s1", "# v2\n\n## Work\n- Only this\n"));
		expect(getState("s1").tasks.map((t) => [t.subject, t.source])).toEqual([
			["Only this", "plan"],
			["agent todo", undefined],
		]);
		expect(getState("s1").plan?.id).toBe("p2");
	});

	it("ignores malformed and future-version payloads", async () => {
		const { handler, announce } = setup();
		await handler("session_start")({}, createMockCtx({ sessionId: "s1" }));
		await announce({ ...approval("p1"), version: 2 });
		await announce({ planId: "p1", sessionId: "s1" });
		expect(getState("s1").tasks).toEqual([]);
	});
});

describe("todo tool on plan items", () => {
	it("rejects completed without evidence, accepts it with, and shows the evidence", async () => {
		const { handler, announce, call } = setup();
		const ctx = createMockCtx({ sessionId: "s1" });
		await handler("session_start")({}, ctx);
		await announce(approval("p1"));

		const rejected = await call(ctx, { action: "update", id: 1, status: "completed" });
		expect(text(rejected)).toMatch(/^Error: evidence required/);
		expect(getState("s1").tasks[0].status).toBe("pending");
		const theme = makeTheme() as unknown as Theme;
		expect(renderTodoResult(rejected!, theme).render(80)[0]).toContain("✗ evidence required");

		const accepted = await call(ctx, { action: "update", id: 1, status: "completed", evidence: "vitest: 3 passed" });
		expect(text(accepted)).toBe("Updated #1 (pending → completed)");
		const collapsed = renderTodoResult(accepted!, theme).render(200);
		expect(collapsed).toHaveLength(1);
		const expanded = renderTodoResult(accepted!, theme, { expanded: true }).render(200);
		expect(expanded.join("\n")).toContain("evidence: vitest: 3 passed");
		expect(text(await call(ctx, { action: "list" }))).toContain("    evidence: vitest: 3 passed");
	});

	it("tells the user when a plan item is deferred", async () => {
		const { handler, announce, call } = setup();
		const ctx = createMockCtx({ sessionId: "s1", hasUI: true });
		await handler("session_start")({}, createMockCtx({ sessionId: "s1" }));
		await announce(approval("p1"));
		const result = await call(ctx, { action: "update", id: 2, status: "deferred", reason: "needs a design call" });
		expect(text(result)).toContain("Tell the user this plan item is descoped and why: needs a design call");
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Plan item deferred: #2 Wire `beta` into the CLI -- needs a design call",
			"warning",
		);
		expect(text(await call(ctx, { action: "delete", id: 2 }))).toContain("can't be deleted");
	});
});

describe("wrap-up reminder", () => {
	const user = { role: "user", content: "go" };
	const assistant = { role: "assistant", content: [] };
	const marker = { role: "custom", customType: PLAN_REMINDER_MESSAGE_TYPE, content: PLAN_REMINDER_MARKER };
	const settleEvent = (contextMessages: unknown[], outcome = "completed") => ({
		type: "agent_before_settle",
		outcome,
		entries: [{ type: "custom", customType: "other" }],
		continue: false,
		context: { contextMessages },
	});

	it("fires once per prompt while plan items are open, and the context hook expands it", async () => {
		const { handler, announce, call } = setup();
		const ctx = createMockCtx({ sessionId: "s1" });
		await handler("session_start")({}, ctx);
		await announce(approval("p1"));
		await call(ctx, { action: "update", id: 1, status: "completed", evidence: "done" });
		await call(ctx, { action: "update", id: 3, status: "deferred", reason: "CI is down" });
		const settle = handler("agent_before_settle");

		const result = (await settle(settleEvent([user, assistant]), ctx)) as {
			entries: Array<Record<string, unknown>>;
			continue: boolean;
		};
		expect(result.continue).toBe(true);
		expect(result.entries[0]).toEqual({ type: "custom", customType: "other" });
		expect(result.entries[1]).toMatchObject({
			type: "custom_message",
			customType: PLAN_REMINDER_MESSAGE_TYPE,
			content: PLAN_REMINDER_MARKER,
			display: false,
		});

		// Second settle in the same prompt: the marker is already in context.
		expect(await settle(settleEvent([user, assistant, marker, assistant]), ctx)).toBeUndefined();
		// A new prompt can be reminded again.
		expect(await settle(settleEvent([user, assistant, marker, assistant, user, assistant]), ctx)).toBeDefined();
		// An aborted run is the user's call; no reminder.
		expect(await settle(settleEvent([user, assistant], "aborted"), ctx)).toBeUndefined();

		const context = handler("context");
		const expanded = (await context({ messages: [user, assistant, marker] }, ctx)) as {
			messages: Array<{ content: string }>;
		};
		const reminder = expanded.messages[2].content;
		expect(reminder).toContain('the approved plan "Add widgets" still has 1/3 items open');
		expect(reminder).toContain("- #2 [Work] Wire `beta` into the CLI");
		expect(reminder).not.toContain("#1 ");
		expect(reminder).toContain("- #3 [Verification] `make test` passes -- CI is down");
		// Only the request right after the marker sees the list.
		expect(await context({ messages: [user, assistant, marker, assistant] }, ctx)).toBeUndefined();
	});

	it("stays silent with no plan, or once every plan item is closed", async () => {
		const { handler, announce, call } = setup();
		const ctx = createMockCtx({ sessionId: "s1" });
		await handler("session_start")({}, ctx);
		const settle = handler("agent_before_settle");
		await call(ctx, { action: "create", subject: "agent only" });
		expect(await settle(settleEvent([user, assistant]), ctx)).toBeUndefined();

		await announce(approval("p1", "s1", "# T\n\n## Work\n- one\n"));
		await call(ctx, { action: "update", id: 2, status: "completed", evidence: "ok" });
		expect(await settle(settleEvent([user, assistant]), ctx)).toBeUndefined();
	});
});

describe("TaskDetails snapshot", () => {
	it("carries the plan on every todo tool result so replay keeps it", async () => {
		const { handler, announce, call } = setup();
		const ctx = createMockCtx({ sessionId: "s1" });
		await handler("session_start")({}, ctx);
		await announce(approval("p1"));
		const result = await call(ctx, { action: "create", subject: "x" });
		expect((result?.details as TaskDetails | undefined)?.plan).toEqual({ id: "p1", title: "Add widgets" });
	});
});
