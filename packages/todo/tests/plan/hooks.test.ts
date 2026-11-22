import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { type AgentRunState, applyAgentEvent } from "../../src/agents.ts";
import {
	formatCompactionList,
	formatHeldReminder,
	formatInProgressNotice,
	formatPlanReminder,
	HELD_REMINDER_MARKER,
	isPlanApprovedPayload,
	PLAN_REMINDER_MARKER,
	remindedSinceLastPrompt,
	STALE_REMINDER_MARKER,
} from "../../src/plan/hooks.ts";
import { replayFromBranch } from "../../src/state/replay.ts";
import { getState } from "../../src/state/store.ts";
import { __resetState } from "../../src/todo.ts";
import {
	COMPACTION_LIST_MESSAGE_TYPE,
	HELD_REMINDER_MESSAGE_TYPE,
	MONITOR_STARTED_EVENT,
	MONITOR_STOPPED_EVENT,
	NUDGE_BUDGET_ENTRY_TYPE,
	PLAN_APPROVED_EVENT,
	PLAN_REMINDER_MESSAGE_TYPE,
	STALE_REMINDER_MESSAGE_TYPE,
	STATE_ENTRY_TYPE,
	SUBAGENT_ANNOUNCE_SURVIVORS_EVENT,
	SUBAGENT_OTHER_SESSION_SURVIVOR_EVENT,
	SUBAGENT_STARTED_EVENT,
	type TaskDetails,
} from "../../src/tool/types.ts";
import { renderTodoResult } from "../../src/view/format.ts";
import registerTodo from "../fixtures/home-fixtures.ts";
import { TEST_HOME } from "../fixtures/setup.ts";
import { createTodoCtx, createTodoPi } from "../fixtures/todo-host.ts";

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
	const { pi, captured } = createTodoPi({
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
	registerTodo(
		pi,
		async () => {
			throw new Error("overlay must not load in headless tests");
		},
		{ homeDir: TEST_HOME },
	);
	const handler = (name: string) => {
		const found = captured.handlers.get(name)?.[0];
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

describe("prompt-less settlement", () => {
	it.each([{ messages: [] }, { messages: [{ role: "assistant" }] }])(
		"still drafts a reminder for %j",
		async ({ messages }) => {
			expect(remindedSinceLastPrompt(messages)).toBe(false);
			const { handler, announce } = setup();
			const ctx = createTodoCtx({ sessionId: "s1" });
			await handler("session_start")({}, ctx);
			await announce(approval("p1"));
			expect(
				await handler("agent_before_settle")(
					{
						outcome: "completed",
						entries: [],
						context: { contextMessages: messages },
					},
					ctx,
				),
			).toEqual({
				continue: true,
				entries: [
					{
						type: "custom_message",
						customType: PLAN_REMINDER_MESSAGE_TYPE,
						content: PLAN_REMINDER_MARKER,
						display: false,
						details: { open: [1, 2, 3] },
					},
				],
			});
		},
	);
});

describe("plan approval event", () => {
	it("seeds verbatim plan todos for the live session and persists a snapshot", async () => {
		const { handler, announce, appendEntry, call } = setup();
		const ctx = createTodoCtx({ sessionId: "s1" });
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
		expect(data).toMatchObject({ persistenceVersion: 1 });
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
		await handler("session_start")({}, createTodoCtx({ sessionId: "fresh" }));
		expect(getState("fresh").tasks).toHaveLength(3);
	});

	it("replaces plan todos on re-approval, ignores a re-announcement, keeps agent todos", async () => {
		const { handler, announce, appendEntry, call } = setup();
		const ctx = createTodoCtx({ sessionId: "s1" });
		await handler("session_start")({}, ctx);
		await call(ctx, { action: "create", subject: "agent todo" });
		await announce(approval("p1"));
		await announce(approval("p1"));
		// The create and first approval persist; re-announcing the approval does not.
		expect(appendEntry).toHaveBeenCalledTimes(2);

		await announce(approval("p2", "s1", "# v2\n\n## Work\n- Only this\n"));
		expect(getState("s1").tasks.map((t) => [t.subject, t.source])).toEqual([
			["Only this", "plan"],
			["agent todo", undefined],
		]);
		expect(getState("s1").plan?.id).toBe("p2");
	});

	it("ignores malformed and future-version payloads", async () => {
		const { handler, announce } = setup();
		await handler("session_start")({}, createTodoCtx({ sessionId: "s1" }));
		await announce({ ...approval("p1"), version: 2 });
		await announce({ planId: "p1", sessionId: "s1" });
		expect(getState("s1").tasks).toEqual([]);
	});
});

describe("todo tool on plan items", () => {
	it("rejects completed without evidence, accepts it with, and shows the evidence", async () => {
		const { handler, announce, call } = setup();
		const ctx = createTodoCtx({ sessionId: "s1" });
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
		const ctx = createTodoCtx({ sessionId: "s1", hasUI: true });
		await handler("session_start")({}, createTodoCtx({ sessionId: "s1" }));
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
		const ctx = createTodoCtx({ sessionId: "s1" });
		await handler("session_start")({}, ctx);
		await announce(approval("p1"));
		await call(ctx, { action: "update", id: 1, status: "completed", evidence: "done" });
		await call(ctx, { action: "update", id: 3, status: "deferred", reason: "CI is down" });
		const settle = handler("agent_before_settle");

		const result = (await settle(settleEvent([user, assistant]), ctx)) as {
			entries: Record<string, unknown>[];
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
		expect(reminder).toContain("update them by id");
		expect(reminder).toContain("Do not create new todos for them");
		expect(reminder).toContain("- #3 [Verification] `make test` passes -- CI is down");
		// Only the request right after the marker sees the list.
		expect(await context({ messages: [user, assistant, marker, assistant] }, ctx)).toBeUndefined();
	});

	it("suspends old-plan reminders while replanning, including after compaction and restore", async () => {
		const { handler, announce, call } = setup();
		const ctx = createTodoCtx({ sessionId: "s1" });
		await handler("session_start")({}, ctx);
		await announce(approval("p1"));
		const transition = (mode: string) => ({
			role: "custom",
			customType: "plan-mode-transition",
			details: { version: 1, mode },
		});
		const branch: unknown[] = [{ type: "message", message: transition("plan") }];
		vi.mocked(ctx.sessionManager.getBranch).mockImplementation(() => branch as never);
		const settle = handler("agent_before_settle");
		// The projected messages can lose the transition to compaction; the active branch retains it.
		expect(await settle(settleEvent([user, assistant]), ctx)).toBeUndefined();
		expect(await handler("context")({ messages: [user, marker] }, ctx)).toBeUndefined();
		expect(text(await call(ctx, { action: "list" }))).toContain("3/3 plan items open");
		// Exit without approval resumes the old obligations, without replacing them.
		branch.push({ type: "message", message: transition("normal") });
		expect(await settle(settleEvent([user, assistant]), ctx)).toBeDefined();
		// Legacy restored workflows can carry state but no persisted mode transition.
		branch.push({ type: "custom", customType: "plan-mode-state", data: { enabled: true } });
		expect(await settle(settleEvent([user, assistant]), ctx)).toBeUndefined();
		branch.push({ type: "custom", customType: "plan-mode-state", data: { enabled: false } });
		expect(await settle(settleEvent([user, assistant]), ctx)).toBeDefined();
	});

	it("honors a current projected mode contract when the branch has no mode history", async () => {
		const { handler, announce } = setup();
		const ctx = createTodoCtx({ sessionId: "s1" });
		await handler("session_start")({}, ctx);
		await announce(approval("p1"));
		const planning = { role: "custom", customType: "plan-mode-transition", details: { version: 1, mode: "plan" } };
		expect(await handler("agent_before_settle")(settleEvent([planning, user, assistant]), ctx)).toBeUndefined();
	});

	it("stays silent with no plan, or once every plan item is closed", async () => {
		const { handler, announce, call } = setup();
		const ctx = createTodoCtx({ sessionId: "s1" });
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
		const ctx = createTodoCtx({ sessionId: "s1" });
		await handler("session_start")({}, ctx);
		await announce(approval("p1"));
		const result = await call(ctx, { action: "create", subject: "x" });
		expect((result?.details as TaskDetails | undefined)?.plan).toEqual({ id: "p1", title: "Add widgets" });
	});
});

describe("settling with in_progress todos", () => {
	const notices = (ctx: { ui: { notify: unknown } }) => (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
	const ARMED = "armed: no todo-owned wake (agent notices list session wakes; unlinked monitors arm no todo)";
	const task = (id: number, extra: Record<string, unknown> = {}) => ({
		id,
		subject: `t${id}`,
		status: "in_progress",
		...extra,
	});

	it("reports the in_progress todos once the run settles", async () => {
		const { handler, call } = setup();
		const ctx = createTodoCtx({ sessionId: "s1" });
		await handler("session_start")({}, ctx);
		await call(ctx, { action: "create", subject: "Ship the thing" });
		await call(ctx, { action: "update", id: 1, status: "in_progress" });
		await handler("agent_settled")({ type: "agent_settled" }, ctx);
		expect(notices(ctx)).toEqual([
			[`Run ended with 1 in_progress todo, ${ARMED}; held by the parent: #1 Ship the thing`, "warning"],
		]);
	});

	it("names free-text owners alongside any blocker details", () => {
		const state = {
			tasks: [
				task(1, { owner: "release-team" }),
				task(2, { owner: "deploy-team", blockedBy: [4] }),
				task(3, { owner: "audit-team", blockedBy: [5] }),
				{ id: 4, subject: "t4", status: "deferred" },
				{ id: 5, subject: "t5", status: "pending", owner: "worker" },
				task(6, { owner: "finished", blockedBy: [4] }),
			],
			nextId: 7,
		} as never;
		const states: Record<string, AgentRunState> = { worker: "running", finished: "done" };
		const lookup = Object.assign((owner: string | undefined) => states[owner ?? ""], { wakesParent: () => true });
		const notice = formatInProgressNotice(state, lookup);
		expect(notice?.text).toContain("#1 t1 (@release-team)");
		expect(notice?.text).toContain("#2 t2 (@deploy-team; by #4 deferred)");
		expect(notice?.text).toContain("#3 t3 (@audit-team; by #5)");
		expect(notice?.text).toContain("#6 t6 (@finished done; by #4 deferred)");
	});

	it("re-arms an info report when its displayed owner changes", () => {
		const state = (owner: string) =>
			({
				tasks: [task(1, { owner, blockedBy: [2] }), task(2, { owner: "worker" })],
				nextId: 3,
			}) as never;
		const lookup = (owner: string | undefined) => (owner === "worker" ? "running" : undefined);
		expect(formatInProgressNotice(state("alice"), lookup)?.key).not.toBe(
			formatInProgressNotice(state("bob"), lookup)?.key,
		);
	});

	it("caps each group at three and counts the rest", () => {
		const state = { tasks: [1, 2, 3, 4, 5].map((id) => task(id)), nextId: 6 } as never;
		expect(formatInProgressNotice(state)?.text).toBe(
			`Run ended with 5 in_progress todos, ${ARMED}; held by the parent: #1 t1, #2 t2, #3 t3, +2 more`,
		);
	});

	it("groups abandoned, held, blocked and running todos, naming every abandoned one", () => {
		const state = {
			tasks: [
				task(1, { owner: "w1" }),
				task(2, { owner: "w2" }),
				task(3, { owner: "w3" }),
				task(4, { owner: "w4" }),
				task(5, { blockedBy: [2, 6] }),
				{ id: 6, subject: "t6", status: "completed" },
				task(7, { blockedBy: [6] }),
				task(8, { owner: "w1", blockedBy: [2] }),
			],
			nextId: 9,
		} as never;
		const states: Record<string, AgentRunState> = { w1: "running", w2: "done", w3: "stopped", w4: "failed" };
		const lookup = Object.assign((owner: string | undefined) => states[owner ?? ""], { wakesParent: () => true });
		expect(formatInProgressNotice(state, lookup)).toEqual({
			text: `Run ended with 7 in_progress todos, ${ARMED}; owner agent failed or stopped: #3 t3 (@w3 stopped), #4 t4 (@w4 failed); held by the parent: #2 t2 (@w2 done), #7 t7; blocked: #5 t5 (by #2); agent running: #1 t1 (@w1 running), #8 t8 (@w1 running)`,
			level: "warning",
			key: expect.any(String),
		});
	});

	it("is info when every todo waits on a running agent or a live dependency", () => {
		const state = {
			tasks: [
				task(1, { owner: "w1" }),
				task(2, { blockedBy: [1] }),
				task(3, { blockedBy: [4] }),
				{ id: 4, subject: "t4", status: "pending", owner: "w1" },
			],
			nextId: 5,
		} as never;
		const lookup = Object.assign((owner: string | undefined) => (owner === "w1" ? ("running" as const) : undefined), {
			wakesParent: () => true,
		});
		expect(formatInProgressNotice(state, lookup)).toEqual({
			text: `Run ended with 3 in_progress todos, ${ARMED}; blocked: #2 t2 (by #1), #3 t3 (by #4); agent running: #1 t1 (@w1 running)`,
			level: "info",
			key: expect.any(String),
		});
	});

	it.each([
		["deferred", { status: "deferred" }],
		["unowned pending", { status: "pending" }],
		["pending with a finished owner", { status: "pending", owner: "w2" }],
		["abandoned in_progress", { status: "in_progress", owner: "w3" }],
	])("warns when a todo's only open dependency is %s", (_name, dep) => {
		const state = { tasks: [task(1, { blockedBy: [2] }), { id: 2, subject: "t2", ...dep }], nextId: 3 } as never;
		const states: Record<string, AgentRunState> = { w2: "done", w3: "failed" };
		const notice = formatInProgressNotice(state, (owner) => states[owner ?? ""]);
		expect(notice?.level).toBe("warning");
		expect(notice?.text).toContain(`held by the parent: #1 t1 (by #2 ${(dep as { status: string }).status})`);
	});

	it("keys a report by group, agent state and blockers", () => {
		const state = (dep: string) =>
			({
				tasks: [task(1, { blockedBy: [2] }), { id: 2, subject: "t2", status: dep, owner: "w" }],
				nextId: 3,
			}) as never;
		const key = (dep: string, agent?: AgentRunState) => formatInProgressNotice(state(dep), () => agent)?.key;
		expect(key("pending", "running")).toBe(key("pending", "running"));
		expect(key("pending", "running")).not.toBe(key("in_progress", "running"));
		expect(key("pending", "running")).not.toBe(key("pending"));
	});

	it("strips terminal escapes from the subjects", () => {
		const state = {
			tasks: [{ id: 1, subject: "a\u001b[31mred\u001b[0m", status: "in_progress" }],
			nextId: 2,
		} as never;
		expect(formatInProgressNotice(state)?.text).toBe(
			`Run ended with 1 in_progress todo, ${ARMED}; held by the parent: #1 ared`,
		);
	});

	it("stays silent in Plan mode", async () => {
		const { handler, call } = setup();
		const ctx = createTodoCtx({ sessionId: "s1" });
		await handler("session_start")({}, ctx);
		await call(ctx, { action: "create", subject: "Ship the thing" });
		await call(ctx, { action: "update", id: 1, status: "in_progress" });
		(ctx.sessionManager as { getBranch: () => unknown[] }).getBranch = () => [
			{ type: "custom", customType: "plan-mode-state", data: { enabled: true } },
		];
		await handler("agent_settled")({ type: "agent_settled" }, ctx);
		expect(notices(ctx)).toEqual([]);
	});

	it("stays silent when nothing is in_progress", async () => {
		const { handler, call } = setup();
		const ctx = createTodoCtx({ sessionId: "s1" });
		await handler("session_start")({}, ctx);
		await call(ctx, { action: "create", subject: "Later" });
		await handler("agent_settled")({ type: "agent_settled" }, ctx);
		expect(notices(ctx)).toEqual([]);
	});
});

describe("settling with nothing armed to wake the parent", () => {
	const user = { role: "user", content: "go" };
	const assistant = { role: "assistant", content: [] };
	const marker = { role: "custom", customType: HELD_REMINDER_MESSAGE_TYPE, content: HELD_REMINDER_MARKER };
	const settleEvent = (contextMessages: unknown[], outcome = "completed") => ({
		type: "agent_before_settle",
		outcome,
		entries: [],
		continue: false,
		context: { contextMessages },
	});
	const notices = (ctx: { ui: { notify: unknown } }) => (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
	const tasks = (...rows: Array<{ id: number; owner?: string }>) => ({
		persistenceVersion: 1,
		nextId: rows.length + 1,
		tasks: rows.map((r) => ({ subject: `t${r.id}`, status: "in_progress", ...r })),
	});
	/** Start a session whose branch already holds `snapshot`, i.e. a resume. */
	async function start(
		snapshot: ReturnType<typeof tasks>,
		{
			reason = "resume",
			beforeStart,
			parentSession,
			mode = "tui",
			entries = [],
			childContext,
		}: {
			reason?: string;
			beforeStart?: (bus: Map<string, Handler[]>) => void;
			/** The session file this session was forked from (its header's `parentSession`), if any. */
			parentSession?: string;
			mode?: ExtensionContext["mode"];
			entries?: SessionEntry[];
			childContext?: AsyncLocalStorage<boolean>;
		} = {},
	) {
		const s = childContext ? childContext.run(true, setup) : setup();
		beforeStart?.(s.bus);
		const ctx = createTodoCtx({
			sessionId: "s1",
			mode,
			hasUI: false,
			branch: [{ type: "custom", customType: STATE_ENTRY_TYPE, data: snapshot }, ...entries] as never,
		});
		Object.assign(ctx.sessionManager, {
			getSessionFile: () => CURRENT_FILE,
			getHeader: () => ({ type: "session", id: "s1", timestamp: "t", cwd: "/", parentSession }),
		});
		await s.handler("session_start")({ reason }, ctx);
		return { ...s, ctx };
	}
	const CURRENT_FILE = "current.jsonl";
	/**
	 * A stand-in for pi-subagents' process-wide registry of detached survivors, each registered under
	 * the session file whose spool it wakes (see `packages/subagents/tests/extension-final-lifecycle.test.ts`
	 * for the real emitter). Like it, an announce request answers for EVERY live survivor: from the
	 * CURRENT file as `subagents:started`, from any other as `subagents:other_session_survivor`.
	 */
	interface Survivor {
		nameBase?: string;
		handle: string;
		file: string;
		live: boolean;
	}
	const survivorPeer = (survivors: Survivor[]) => (bus: Map<string, Handler[]>) => {
		bus.set(SUBAGENT_ANNOUNCE_SURVIVORS_EVENT, [
			() => {
				for (const [i, { handle, file, live, nameBase }] of survivors.entries()) {
					if (!live) continue;
					const own = file === CURRENT_FILE;
					const channel = own ? SUBAGENT_STARTED_EVENT : SUBAGENT_OTHER_SESSION_SURVIVOR_EVENT;
					for (const h of bus.get(channel) ?? [])
						void h({
							id: `a${i + 1}`,
							handle,
							...(nameBase ? { nameBase } : {}),
							type: "general-purpose",
							description: "d",
							...(own ? { wakesParent: true } : { sessionFile: file }),
						});
				}
			},
		]);
	};
	const alive = (handle: string, file = CURRENT_FILE): Survivor => ({ handle, file, live: true });
	const ELSEWHERE_NOTICE =
		"Run ended with 1 in_progress todo, armed: no todo-owned wake (agent notices list session wakes; unlinked monitors arm no todo); agent running for another session, which it wakes instead of this one: #1 t1 (@worker)";
	const monitor = (bus: Map<string, Handler[]>, channel: string, id = "m1", sessionId = "s1") => {
		for (const h of bus.get(channel) ?? []) void h({ sessionId, id, name: "ci" });
	};

	it("reminds once per prompt when todos are held and nothing is armed, and expands the list", async () => {
		const { handler, ctx } = await start(tasks({ id: 1 }, { id: 2, owner: "release-team" }));
		const settle = handler("agent_before_settle");
		const result = (await settle(settleEvent([user, assistant]), ctx)) as {
			entries: Record<string, unknown>[];
			continue: boolean;
		};
		expect(result.continue).toBe(true);
		expect(result.entries[0]).toMatchObject({
			type: "custom_message",
			customType: HELD_REMINDER_MESSAGE_TYPE,
			content: HELD_REMINDER_MARKER,
			display: false,
			details: { held: [1, 2] },
		});
		// Same prompt: already reminded. A new prompt reminds again. Aborted runs are the user's call.
		expect(await settle(settleEvent([user, assistant, marker, assistant]), ctx)).toBeUndefined();
		expect(await settle(settleEvent([user, assistant, marker, assistant, user, assistant]), ctx)).toBeDefined();
		expect(await settle(settleEvent([user, assistant], "aborted"), ctx)).toBeUndefined();

		const expanded = (await handler("context")({ messages: [user, assistant, marker] }, ctx)) as {
			messages: Array<{ content: string }>;
		};
		const reminder = expanded.messages[2].content;
		expect(reminder).toContain("Nothing is armed to wake you");
		expect(reminder).toContain("- #1 t1\n");
		expect(reminder).toContain("- #2 t2 (@release-team)");
		expect(reminder).toContain("monitor_stop it and monitor_start it again with todo: <id>");
		// Only the request right after the marker sees the list.
		expect(await handler("context")({ messages: [user, marker, assistant] }, ctx)).toBeUndefined();
	});

	it("stays out of the way when a running background agent will wake the parent", async () => {
		const { handler, ctx } = await start(tasks({ id: 1 }));
		const settle = handler("agent_before_settle");
		applyAgentEvent("s1", SUBAGENT_STARTED_EVENT, { id: "a1", handle: "other-worker", wakesParent: true });
		expect(await settle(settleEvent([user, assistant]), ctx)).toBeUndefined();
		expect(await handler("context")({ messages: [user, marker] }, ctx)).toBeUndefined();
	});

	describe("open list after a compaction", () => {
		const planning = { role: "custom", customType: "plan-mode-transition", details: { version: 1, mode: "plan" } };
		const mixed = {
			persistenceVersion: 1,
			nextId: 6,
			tasks: [
				{ id: 1, subject: "done work", status: "completed" },
				{ id: 2, subject: "ship \u001b[31mwidgets", status: "in_progress", owner: "worker" },
				{ id: 3, subject: "verify", status: "pending", blockedBy: [1, 2, 5] },
				{ id: 4, subject: "descoped", status: "deferred", reason: "later" },
				{ id: 5, subject: "gone", status: "deleted" },
			],
		};
		const LIST = [
			"[rpiv-todo] The conversation was compacted, so here is the todo list it no longer shows. These todos are still open:",
			"- #2 in_progress ship widgets (@worker)",
			"- #3 pending verify (blocked by #2)",
			"They already exist: update them by id with `todo`, do not recreate them. Complete only with evidence and defer with a reason.",
		].join("\n");
		const appended = { role: "custom", customType: COMPACTION_LIST_MESSAGE_TYPE, content: LIST, display: false };

		it("appends the open list to the first request after a compaction only", async () => {
			const { handler, ctx } = await start(mixed as never);
			const context = handler("context");
			expect(await context({ messages: [user] }, ctx)).toBeUndefined();
			await handler("session_compact")({}, ctx);
			expect(await context({ messages: [user] }, ctx)).toEqual({
				messages: [user, { ...appended, timestamp: expect.any(Number) }],
			});
			expect(await context({ messages: [user, assistant] }, ctx)).toBeUndefined();
		});

		it("waits out Plan mode and expands a trailing reminder in the same request", async () => {
			const { handler, ctx } = await start(tasks({ id: 1 }));
			const context = handler("context");
			await handler("session_compact")({}, ctx);
			expect(await context({ messages: [planning, user] }, ctx)).toBeUndefined();
			const result = (await context({ messages: [user, assistant, marker] }, ctx)) as {
				messages: Array<{ customType?: string; content: string }>;
			};
			expect(result.messages).toHaveLength(4);
			expect(result.messages[2]).toMatchObject({ customType: HELD_REMINDER_MESSAGE_TYPE });
			expect(result.messages[2].content).toContain("Nothing is armed to wake you");
			expect(result.messages[3]).toMatchObject({ customType: COMPACTION_LIST_MESSAGE_TYPE });
			expect(result.messages[3].content).toContain("- #1 in_progress t1\n");
			expect(await context({ messages: [user] }, ctx)).toBeUndefined();
		});

		it("spends the list on a request with nothing open", async () => {
			const { handler, ctx, call } = await start({ persistenceVersion: 1, nextId: 1, tasks: [] } as never);
			await handler("session_compact")({}, ctx);
			expect(await handler("context")({ messages: [user] }, ctx)).toBeUndefined();
			await call(ctx, { action: "create", subject: "later work" });
			expect(await handler("context")({ messages: [user] }, ctx)).toBeUndefined();
		});

		it.each(["session_start", "session_shutdown"])("drops a pending list on %s", async (event) => {
			const { handler, ctx } = await start(tasks({ id: 1 }));
			await handler("session_compact")({}, ctx);
			await handler(event)({ reason: event === "session_start" ? "new" : "quit" }, ctx);
			if (event === "session_shutdown") await handler("session_start")({ reason: "new" }, ctx);
			expect(await handler("context")({ messages: [user] }, ctx)).toBeUndefined();
		});

		it("skips a blocker missing from the list", () => {
			const state = { nextId: 3, tasks: [{ id: 2, subject: "orphan", status: "pending", blockedBy: [1] }] };
			expect(formatCompactionList(state as never)).toContain("\n- #2 pending orphan\n");
		});

		it("lists open todos in child and non-TUI sessions too", async () => {
			const childContext = new AsyncLocalStorage<boolean>();
			vi.stubGlobal(Symbol.for("pi-subagents:child-session-context"), childContext);
			onTestFinished(() => {
				vi.unstubAllGlobals();
			});
			const { handler, ctx } = await start(mixed as never, { mode: "rpc", childContext });
			await handler("session_compact")({}, ctx);
			expect(await handler("context")({ messages: [user] }, ctx)).toMatchObject({ messages: [user, appended] });
		});
	});

	describe("stale open lists", () => {
		const customType = STALE_REMINDER_MESSAGE_TYPE;
		const budget = {
			type: "custom",
			customType: NUDGE_BUDGET_ENTRY_TYPE,
			data: { persistenceVersion: 1, nudge: "stale" },
		};
		const nudged = { continue: true, entries: [budget, { type: "custom_message", customType, display: false }] };
		const expectQuiet = async (settle: () => unknown, count: number) => {
			for (let i = 0; i < count; i++) expect(await settle()).toBeUndefined();
		};
		const armWorker = () => {
			applyAgentEvent("s1", SUBAGENT_STARTED_EVENT, { id: "a1", handle: "worker", wakesParent: true });
		};

		it("rereads the stale threshold from the injected config home without rebinding", async () => {
			const { handler, ctx } = await start(tasks({ id: 1 }));
			armWorker();
			const settle = () => handler("agent_before_settle")(settleEvent([user, assistant]), ctx);
			await expectQuiet(settle, 2);
			const path = join(TEST_HOME, ".config", "rpiv-todo", "config.json");
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, JSON.stringify({ staleAfterSettles: 3 }));
			try {
				expect(await settle()).toMatchObject(nudged);
			} finally {
				rmSync(path, { force: true });
			}
		});

		it.each(["json", "rpc", "print"] as const)("never continues a %s session for a stale list", async (mode) => {
			const { handler, ctx } = await start(tasks({ id: 1 }), { mode });
			armWorker();
			const settle = () => handler("agent_before_settle")(settleEvent([user, assistant]), ctx);
			await expectQuiet(settle, 11);
		});

		it("never continues a child activation bound as TUI for a stale list", async () => {
			const childContext = new AsyncLocalStorage<boolean>();
			vi.stubGlobal(Symbol.for("pi-subagents:child-session-context"), childContext);
			onTestFinished(() => {
				vi.unstubAllGlobals();
			});
			const { handler, ctx } = await start(tasks({ id: 1 }), { mode: "tui", childContext });
			armWorker();
			await expectQuiet(() => handler("agent_before_settle")(settleEvent([user, assistant]), ctx), 11);
		});

		it.each(["resume", "reload"])("restores the stale prompt budget on %s from bookkeeping", async (reason) => {
			const persisted = { customType, content: STALE_REMINDER_MARKER, display: false };
			const { handler, ctx } = await start(tasks({ id: 1 }), {
				reason,
				entries: [{ ...budget, id: "budget", parentId: null, timestamp: "" }] as SessionEntry[],
			});
			armWorker();
			const marker = { role: "custom", ...persisted };
			const messages = [user, assistant, marker];
			expect(await handler("context")({ messages }, ctx)).toBeUndefined();
			const settle = () => handler("agent_before_settle")(settleEvent([...messages, assistant]), ctx);
			await expectQuiet(settle, 11);
			await handler("input")({ source: "extension" }, ctx);
			expect(await settle()).toBeUndefined();
			await handler("input")({ source: "interactive" }, ctx);
			expect(await settle()).toMatchObject(nudged);
		});

		it("spends the stale budget on neither a restored marker nor empty-list bookkeeping", async () => {
			const persisted = { customType, content: STALE_REMINDER_MARKER, display: false };
			const empty = { ...budget, data: { persistenceVersion: 1, nudge: "empty" } };
			const { handler, ctx } = await start(tasks({ id: 1 }), {
				reason: "resume",
				entries: [
					{ type: "custom_message", ...persisted, id: "nudge", parentId: null, timestamp: "" },
					{ ...empty, id: "empty", parentId: "nudge", timestamp: "" },
				] as SessionEntry[],
			});
			armWorker();
			const settle = () => handler("agent_before_settle")(settleEvent([user, assistant]), ctx);
			await expectQuiet(settle, 9);
			expect(await settle()).toMatchObject(nudged);
		});

		it.each([
			["a missing version", { nudge: "stale" }],
			["an unsupported version", { persistenceVersion: 2, nudge: "stale" }],
			["null data", null],
		])("leaves the stale budget unspent for bookkeeping with %s", async (_case, data) => {
			const { handler, ctx } = await start(tasks({ id: 1 }), {
				reason: "resume",
				entries: [{ ...budget, data, id: "budget", parentId: null, timestamp: "" }] as SessionEntry[],
			});
			armWorker();
			const settle = () => handler("agent_before_settle")(settleEvent([user, assistant]), ctx);
			await expectQuiet(settle, 9);
			expect(await settle()).toMatchObject(nudged);
		});

		it("evicts stale eligibility on a same-session non-TUI rebind", async () => {
			const { handler, ctx } = await start(tasks({ id: 1 }));
			armWorker();
			await expectQuiet(() => handler("agent_before_settle")(settleEvent([user, assistant]), ctx), 9);
			const rpc = createTodoCtx({ sessionId: "s1", mode: "rpc", hasUI: false, branch: ctx.sessionManager.getBranch() });
			await handler("session_start")({ reason: "resume" }, rpc);
			armWorker();
			await expectQuiet(() => handler("agent_before_settle")(settleEvent([user, assistant]), rpc), 11);
		});

		it("nudges at the threshold with an armed worker and rearms only on human input", async () => {
			const { handler, ctx, call } = await start(tasks({ id: 1 }));
			armWorker();
			const settle = (messages = [user, assistant] as unknown[]) =>
				handler("agent_before_settle")(settleEvent(messages), ctx);
			await expectQuiet(settle, 9);
			const result = (await settle()) as { entries: Array<{ content: string }>; continue: boolean };
			expect(result).toMatchObject(nudged);
			const marker = { role: "custom", customType, content: result.entries[1].content };
			const messages = [user, assistant, marker];
			const expanded = await handler("context")({ messages }, ctx);
			expect(expanded).toMatchObject({
				messages: [user, assistant, { customType, content: expect.stringContaining("action `list`") }],
			});
			expect(marker.content).not.toContain("action `list`");
			expect(await handler("context")({ messages }, ctx)).toBeUndefined();
			expect(await handler("context")({ messages: [...messages, assistant] }, ctx)).toBeUndefined();
			await expectQuiet(() => settle([...messages, assistant]), 10);
			await handler("input")({ source: "extension" }, ctx);
			expect(await settle([...messages, user, assistant])).toBeUndefined();
			await handler("input")({ source: "interactive" }, ctx);
			expect(await settle([...messages, user, assistant])).toMatchObject(nudged);
			await call(ctx, { action: "clear" });
			expect(await handler("context")({ messages }, ctx)).toBeUndefined();
		});

		it("resets age on a successful write, but not on a read or rejected write", async () => {
			const { handler, ctx, call } = await start(tasks({ id: 1 }));
			armWorker();
			const settle = () => handler("agent_before_settle")(settleEvent([user, assistant]), ctx);
			await expectQuiet(settle, 9);
			await call(ctx, { action: "create", subject: "pending follow-up" });
			await expectQuiet(settle, 9);
			await call(ctx, { action: "list" });
			expect(text(await call(ctx, { action: "update", id: 2, status: "completed" }))).toMatch(/^Error:/);
			expect(await settle()).toMatchObject(nudged);
			await call(ctx, { action: "update", id: 1, status: "completed", evidence: "verified" });
			await expectQuiet(settle, 10);
			await handler("session_shutdown")({ reason: "quit" }, ctx);
			await handler("session_start")({ reason: "new" }, ctx);
			armWorker();
			await expectQuiet(settle, 9);
			expect(await settle()).toMatchObject(nudged);
		});

		it("ignores closed lists and does not age in Plan mode or on an aborted settle", async () => {
			const { handler, ctx, call } = await start(tasks());
			const settle = () => handler("agent_before_settle")(settleEvent([user, assistant]), ctx);
			await expectQuiet(settle, 10);
			await call(ctx, {
				ops: [
					{ action: "create", subject: "closed work" },
					{ action: "delete", id: 1 },
				],
			});
			await expectQuiet(settle, 10);
			await call(ctx, { action: "create", subject: "open work" });
			const planning = { role: "custom", customType: "plan-mode-transition", details: { version: 1, mode: "plan" } };
			await expectQuiet(() => handler("agent_before_settle")(settleEvent([planning, user, assistant]), ctx), 10);
			await expectQuiet(() => handler("agent_before_settle")(settleEvent([user, assistant], "aborted"), ctx), 10);
			await expectQuiet(settle, 9);
			expect(await settle()).toMatchObject(nudged);
		});
	});

	describe("monitors linked to a todo", () => {
		const link = (bus: Map<string, Handler[]>, channel: string, todo?: number | number[], id = "m1", name = "ci") => {
			for (const h of bus.get(channel) ?? [])
				void h({
					sessionId: "s1",
					id,
					name,
					wake: false,
					todos: todo === undefined ? undefined : Array.isArray(todo) ? todo : [todo],
				});
		};
		const WAITING =
			"Run ended with 1 in_progress todo, armed: monitor for #1; waiting on a monitor, which wakes the parent: #1 t1 (monitor ci)";

		it("shows a todo with a live linked monitor as waiting once, then held again after it stops", async () => {
			const { handler, ctx, bus } = await start(tasks({ id: 1 }));
			link(bus, MONITOR_STARTED_EVENT, 1);
			await handler("agent_settled")({ type: "agent_settled" }, ctx);
			await handler("agent_settled")({ type: "agent_settled" }, ctx);
			expect(notices(ctx)).toEqual([[WAITING, "info"]]);
			expect(await handler("agent_before_settle")(settleEvent([user, assistant]), ctx)).toBeUndefined();
			link(bus, MONITOR_STOPPED_EVENT, 1);
			await handler("agent_settled")({ type: "agent_settled" }, ctx);
			expect(notices(ctx)[1]).toEqual([expect.stringContaining("held by the parent: #1 t1"), "warning"]);
			expect(await handler("agent_before_settle")(settleEvent([user, assistant]), ctx)).toBeDefined();
		});

		it("leaves a todo the monitor is not linked to held, and a linked one does not arm the session", async () => {
			const { handler, ctx, bus } = await start(tasks({ id: 1 }, { id: 2 }));
			link(bus, MONITOR_STARTED_EVENT, 2);
			await handler("agent_settled")({ type: "agent_settled" }, ctx);
			expect(notices(ctx)).toEqual([
				[
					expect.stringContaining(
						"held by the parent: #1 t1; waiting on a monitor, which wakes the parent: #2 t2 (monitor ci)",
					),
					"warning",
				],
			]);
			const result = (await handler("agent_before_settle")(settleEvent([user, assistant]), ctx)) as {
				entries: Array<{ details: { held: number[] } }>;
			};
			expect(result.entries[0].details.held).toEqual([1]);
		});

		it("arms no todo for an unlinked or malformed-link monitor, and the held reminder still fires", async () => {
			const { handler, ctx, bus } = await start(tasks({ id: 1 }));
			monitor(bus, MONITOR_STARTED_EVENT);
			link(bus, MONITOR_STARTED_EVENT, 0.5, "m2");
			await handler("agent_settled")({ type: "agent_settled" }, ctx);
			expect(notices(ctx)[0][1]).toBe("warning");
			expect(notices(ctx)[0][0]).toContain("held by the parent: #1 t1");
			expect(await handler("agent_before_settle")(settleEvent([user, assistant]), ctx)).toBeDefined();
			// Stops for another monitor or session change nothing; its own stop is harmless.
			monitor(bus, MONITOR_STOPPED_EVENT, "m1", "other");
			monitor(bus, MONITOR_STOPPED_EVENT);
			expect(await handler("agent_before_settle")(settleEvent([user, assistant]), ctx)).toBeDefined();
		});

		it("arms every todo of a monitor linked to several", async () => {
			const { handler, ctx, bus } = await start(tasks({ id: 1 }, { id: 2 }, { id: 3 }));
			link(bus, MONITOR_STARTED_EVENT, [1, 2]);
			await handler("agent_settled")({ type: "agent_settled" }, ctx);
			expect(notices(ctx)[0][0]).toContain("armed: monitor for #1, #2; held by the parent: #3 t3; waiting");
			expect(notices(ctx)[0][0]).toContain("#1 t1 (monitor ci), #2 t2 (monitor ci)");
		});

		it("keeps the link of a plan todo that survives clear, drops the cleared one", async () => {
			const snapshot = tasks({ id: 1 }, { id: 2 });
			snapshot.tasks[0] = { ...snapshot.tasks[0], source: "plan" } as never;
			const { handler, ctx, bus, call } = await start(snapshot);
			link(bus, MONITOR_STARTED_EVENT, [1, 2]);
			await call(ctx, { action: "clear" });
			await call(ctx, { action: "create", subject: "reused id" });
			await call(ctx, { action: "update", id: 3, status: "in_progress" });
			await handler("agent_settled")({ type: "agent_settled" }, ctx);
			expect(notices(ctx)[0][0]).toContain(
				"held by the parent: #3 reused id; waiting on a monitor, which wakes the parent: #1 t1",
			);
		});

		it("drops a link when its todo is cleared inside an ops batch, so a reused id is not armed", async () => {
			const { handler, ctx, bus, call } = await start(tasks({ id: 1 }));
			link(bus, MONITOR_STARTED_EVENT, 1);
			await call(ctx, {
				ops: [
					{ action: "clear" },
					{ action: "create", subject: "reused id" },
					{ action: "update", id: 1, status: "in_progress" },
				],
			});
			await handler("agent_settled")({ type: "agent_settled" }, ctx);
			expect(notices(ctx)[0][1]).toBe("warning");
			expect(notices(ctx)[0][0]).not.toContain("waiting on a monitor");
		});

		it("drops every link when tree navigation changes the todos, keeps them when nothing changed", async () => {
			const { handler, ctx, bus } = await start(tasks({ id: 1 }));
			link(bus, MONITOR_STARTED_EVENT, 1);
			const branchWith = (data: unknown) => {
				(ctx.sessionManager as unknown as { getBranch: () => unknown }).getBranch = () => [
					{ type: "custom", customType: STATE_ENTRY_TYPE, data },
				];
			};
			// The same state replayed (compaction) keeps the link.
			branchWith(tasks({ id: 1 }));
			await handler("session_compact")({}, ctx);
			await handler("agent_settled")({ type: "agent_settled" }, ctx);
			expect(notices(ctx)[0][0]).toContain("waiting on a monitor");
			// Another branch's #1, even with the same subject, is not the todo the monitor was started for.
			const other = tasks({ id: 1 });
			other.tasks[0] = { ...other.tasks[0], description: "recreated on another branch" } as never;
			branchWith(other);
			await handler("session_tree")({}, ctx);
			await handler("agent_settled")({ type: "agent_settled" }, ctx);
			expect(notices(ctx)[1]).toEqual([expect.stringContaining("held by the parent: #1 t1"), "warning"]);
		});

		it("drops a link when its todo is cleared, so a reused id is not armed", async () => {
			const { handler, ctx, bus, call } = await start(tasks({ id: 1 }));
			link(bus, MONITOR_STARTED_EVENT, 1);
			monitor(bus, MONITOR_STARTED_EVENT, "m2");
			await call(ctx, { action: "clear" });
			await call(ctx, { action: "create", subject: "reused id" });
			await call(ctx, { action: "update", id: 1, status: "in_progress" });
			await handler("agent_settled")({ type: "agent_settled" }, ctx);
			expect(notices(ctx)[0][1]).toBe("warning");
		});

		it("names a monitor by id when its event carries no name and keeps the first of two on one todo", async () => {
			const { handler, ctx, bus } = await start(tasks({ id: 1 }));
			for (const h of bus.get(MONITOR_STARTED_EVENT) ?? []) void h({ sessionId: "s1", id: "m9", todos: [1] });
			link(bus, MONITOR_STARTED_EVENT, 1, "m10", "later");
			await handler("agent_settled")({ type: "agent_settled" }, ctx);
			expect(notices(ctx)[0][0]).toContain("(monitor m9)");
		});

		it("forgets linked monitors when the session shuts down", async () => {
			const { handler, ctx, bus } = await start(tasks({ id: 1 }));
			link(bus, MONITOR_STARTED_EVENT, 1);
			await handler("session_shutdown")({ reason: "quit" }, ctx);
			await handler("session_start")({ reason: "startup" }, ctx);
			await handler("agent_settled")({ type: "agent_settled" }, ctx);
			expect(notices(ctx)[0][1]).toBe("warning");
		});
	});

	it("does not count a running agent without a completion notice as armed", async () => {
		const { handler, ctx } = await start(tasks({ id: 1 }));
		applyAgentEvent("s1", SUBAGENT_STARTED_EVENT, { id: "a1", handle: "worker" });
		expect(await handler("agent_before_settle")(settleEvent([user, assistant]), ctx)).toBeDefined();
	});

	it("ignores malformed monitor payloads and unrelated channels", async () => {
		const { handler, ctx, bus } = await start(tasks({ id: 1 }));
		for (const h of bus.get(MONITOR_STARTED_EVENT) ?? []) {
			void h(undefined);
			void h({ sessionId: "s1" });
			void h({ sessionId: "s1", id: "" });
			void h({ sessionId: 1, id: "m1" });
		}
		expect(await handler("agent_before_settle")(settleEvent([user, assistant]), ctx)).toBeDefined();
	});

	it("forgets a session's monitors when it shuts down", async () => {
		const { handler, ctx, bus } = await start(tasks({ id: 1 }));
		monitor(bus, MONITOR_STARTED_EVENT);
		await handler("session_shutdown")({ reason: "quit" }, ctx);
		await handler("session_start")({ reason: "startup" }, ctx);
		expect(await handler("agent_before_settle")(settleEvent([user, assistant]), ctx)).toBeDefined();
	});

	it("leaves a plan reminder first, and suppresses neither", async () => {
		const { handler, announce, ctx } = await start(tasks({ id: 1 }));
		await announce(approval("p1"));
		const settle = handler("agent_before_settle");
		const planMarker = { role: "custom", customType: PLAN_REMINDER_MESSAGE_TYPE, content: PLAN_REMINDER_MARKER };
		const first = (await settle(settleEvent([user, assistant]), ctx)) as { entries: Array<{ customType: string }> };
		expect(first.entries[0].customType).toBe(PLAN_REMINDER_MESSAGE_TYPE);
		const second = (await settle(settleEvent([user, assistant, planMarker, assistant]), ctx)) as {
			entries: Array<{ customType: string }>;
		};
		expect(second.entries[0].customType).toBe(HELD_REMINDER_MESSAGE_TYPE);
		expect(await settle(settleEvent([user, assistant, planMarker, assistant, marker, assistant]), ctx)).toBeUndefined();
	});

	it("does not remind in Plan mode or with nothing in_progress", async () => {
		const { handler, ctx } = await start({
			...tasks({ id: 1 }),
			tasks: [{ id: 1, subject: "t1", status: "pending" }],
		});
		expect(await handler("agent_before_settle")(settleEvent([user, assistant]), ctx)).toBeUndefined();
		const planning = await start(tasks({ id: 1 }));
		const planningMessage = {
			role: "custom",
			customType: "plan-mode-transition",
			details: { version: 1, mode: "plan" },
		};
		expect(
			await planning.handler("agent_before_settle")(settleEvent([planningMessage, user, assistant]), planning.ctx),
		).toBeUndefined();
	});

	it("reports an owner unknown after resume as lost, naming it, on every settle", async () => {
		const { handler, ctx } = await start(tasks({ id: 1, owner: "0a1b2c3d-4e5f-6a7" }, { id: 2, owner: "alive" }), {
			reason: "startup",
		});
		applyAgentEvent("s1", SUBAGENT_STARTED_EVENT, { id: "a1", handle: "alive", wakesParent: true });
		await handler("agent_settled")({ type: "agent_settled" }, ctx);
		await handler("agent_settled")({ type: "agent_settled" }, ctx);
		const text =
			"Run ended with 2 in_progress todos, armed: no todo-owned wake (agent notices list session wakes; unlinked monitors arm no todo); owner agent not found after resume: #1 t1 (@0a1b2c3d-4e5f-6a7); agent running: #2 t2 (@alive running)";
		expect(notices(ctx)).toEqual([
			[text, "warning"],
			[text, "warning"],
		]);
		// The live agent is armed, so no reminder: the parent will be woken anyway.
		expect(await handler("agent_before_settle")(settleEvent([user, assistant]), ctx)).toBeUndefined();
	});

	it("does not call an owner lost when it was set after resume, changed, or heard again", async () => {
		const { handler, ctx, call } = await start(tasks({ id: 1, owner: "old-worker" }), { reason: "startup" });
		await call(ctx, { action: "create", subject: "fresh" });
		await call(ctx, { action: "update", id: 2, status: "in_progress", owner: "new-worker" });
		await call(ctx, { action: "update", id: 1, owner: "reassigned" });
		await handler("agent_settled")({ type: "agent_settled" }, ctx);
		expect(notices(ctx)[0][0]).not.toContain("not found after resume");
		await call(ctx, { action: "update", id: 1, owner: "old-worker" });
		applyAgentEvent("s1", SUBAGENT_STARTED_EVENT, { id: "a1", handle: "old-worker", wakesParent: true });
		notices(ctx).length = 0;
		await handler("agent_settled")({ type: "agent_settled" }, ctx);
		expect(notices(ctx)[0][0]).not.toContain("not found after resume");
	});

	it("treats only a startup with an unnamed owner as lost, and still reminds", async () => {
		const { handler, ctx } = await start(tasks({ id: 1, owner: "worker" }), { reason: "startup" });
		await handler("agent_settled")({ type: "agent_settled" }, ctx);
		expect(notices(ctx)[0][0]).toContain("owner agent not found after resume: #1 t1 (@worker)");
		expect(await handler("agent_before_settle")(settleEvent([user, assistant]), ctx)).toBeDefined();
	});

	it.each(["resume", "reload", "fork", "new"])(
		"keeps an unheard owner after %s out of the lost group",
		async (reason) => {
			const { handler, ctx } = await start(tasks({ id: 1, owner: "worker" }), { reason });
			await handler("agent_settled")({ type: "agent_settled" }, ctx);
			expect(notices(ctx)[0][0]).toContain("held by the parent: #1 t1 (@worker)");
			expect(notices(ctx)[0][0]).not.toContain("not found after resume");
		},
	);

	it.each(["resume", "reload"])("neither warns nor reminds for a live detached survivor after %s", async (reason) => {
		const { handler, ctx } = await start(tasks({ id: 1, owner: "worker" }), {
			reason,
			beforeStart: survivorPeer([alive("worker")]),
		});
		await handler("agent_settled")({ type: "agent_settled" }, ctx);
		expect(notices(ctx)).toEqual([
			[
				"Run ended with 1 in_progress todo, armed: no todo-owned wake (agent notices list session wakes; unlinked monitors arm no todo); agent running: #1 t1 (@worker running)",
				"info",
			],
		]);
		expect(await handler("agent_before_settle")(settleEvent([user, assistant]), ctx)).toBeUndefined();
	});

	const settleNotice = async (h: { handler: (n: string) => (...a: never[]) => unknown; ctx: unknown }) => {
		notices(h.ctx as never).length = 0;
		await (h.handler("agent_settled") as (...a: unknown[]) => Promise<void>)({ type: "agent_settled" }, h.ctx);
		return notices(h.ctx as never)[0]?.[0];
	};
	const remind = async (h: { handler: (n: string) => (...a: never[]) => unknown; ctx: unknown }) =>
		(h.handler("agent_before_settle") as (...a: unknown[]) => Promise<unknown>)(settleEvent([user, assistant]), h.ctx);
	/** Another start of the same session id, as `/reload` or a switch back and forth: shutdown, then session_start. */
	const restart = async (h: Awaited<ReturnType<typeof start>>, reason: string) => {
		await h.handler("session_shutdown")({ reason }, h.ctx);
		await h.handler("session_start")({ reason }, h.ctx);
	};

	it.each(["fork", "reload"])(
		"shows a survivor of the fork parent as running for it after %s, and never reminds",
		async (reason) => {
			const h = await start(tasks({ id: 1, owner: "worker" }), {
				reason,
				beforeStart: survivorPeer([alive("worker", "parent.jsonl")]),
				parentSession: "parent.jsonl",
			});
			expect(await settleNotice(h)).toBe(ELSEWHERE_NOTICE);
			expect(notices(h.ctx)[0][1]).toBe("info");
			expect(await remind(h)).toBeUndefined();
		},
	);

	it.each(["new", "resume"])(
		"holds the owner, and reminds, when a same-named survivor belongs to an unrelated session after %s",
		async (reason) => {
			const h = await start(tasks({ id: 1, owner: "worker" }), {
				reason,
				beforeStart: survivorPeer([alive("worker", "a.jsonl")]),
			});
			expect(await settleNotice(h)).toContain("held by the parent: #1 t1 (@worker)");
			expect(await remind(h)).toBeDefined();
		},
	);

	it("holds the owner when the survivor's file is not an ancestor of a forked session", async () => {
		const h = await start(tasks({ id: 1, owner: "worker" }), {
			reason: "fork",
			beforeStart: survivorPeer([alive("worker", "other.jsonl")]),
			parentSession: "parent.jsonl",
		});
		expect(await settleNotice(h)).toContain("held by the parent: #1 t1 (@worker)");
		expect(await remind(h)).toBeDefined();
	});

	it("holds the owner when a survivor announcement carries no session file", async () => {
		const noFile = (bus: Map<string, Handler[]>) =>
			bus.set(SUBAGENT_ANNOUNCE_SURVIVORS_EVENT, [
				() => {
					for (const hd of bus.get(SUBAGENT_OTHER_SESSION_SURVIVOR_EVENT) ?? [])
						void hd({ id: "a1", handle: "worker" });
				},
			]);
		const h = await start(tasks({ id: 1, owner: "worker" }), {
			reason: "fork",
			beforeStart: noFile,
			parentSession: "parent.jsonl",
		});
		expect(await settleNotice(h)).toContain("held by the parent: #1 t1 (@worker)");
	});

	it("keeps the survivor elsewhere after a /reload in the fork, not held", async () => {
		const h = await start(tasks({ id: 1, owner: "worker" }), {
			reason: "fork",
			beforeStart: survivorPeer([alive("worker", "a.jsonl")]),
			parentSession: "a.jsonl",
		});
		expect(await settleNotice(h)).toBe(ELSEWHERE_NOTICE);
		await restart(h, "reload");
		expect(await settleNotice(h)).toBe(ELSEWHERE_NOTICE);
		expect(await remind(h)).toBeUndefined();
	});

	it("keeps the survivor elsewhere after a fork of a fork, via the ancestry chain", async () => {
		const dir = makeTestTempDir("todo-lineage-", onTestFinished);
		const header = (parentSession?: string) => `${JSON.stringify({ type: "session", id: "x", parentSession })}\n{}\n`;
		const a = join(dir, "a.jsonl");
		const b = join(dir, "b.jsonl");
		writeFileSync(a, header());
		writeFileSync(b, header(a));
		const h = await start(tasks({ id: 1, owner: "worker" }), {
			reason: "fork",
			beforeStart: survivorPeer([alive("worker", a)]),
			parentSession: b,
		});
		expect(await settleNotice(h)).toBe(ELSEWHERE_NOTICE);
		expect(await remind(h)).toBeUndefined();
	});

	it("stops walking the ancestry at a cycle, an unreadable file or a headerless one", async () => {
		const dir = makeTestTempDir("todo-lineage-", onTestFinished);
		const a = join(dir, "a.jsonl");
		const b = join(dir, "b.jsonl");
		const junk = join(dir, "junk.jsonl");
		writeFileSync(a, `${JSON.stringify({ type: "session", parentSession: b })}\n`);
		writeFileSync(b, `${JSON.stringify({ type: "session", parentSession: a })}\n`);
		writeFileSync(junk, "not json\n");
		const cyc = await start(tasks({ id: 1, owner: "worker" }), {
			reason: "fork",
			beforeStart: survivorPeer([alive("worker", b)]),
			parentSession: a,
		});
		expect(await settleNotice(cyc)).toBe(ELSEWHERE_NOTICE);
		const bad = await start(tasks({ id: 1, owner: "worker" }), {
			reason: "fork",
			beforeStart: survivorPeer([alive("worker", "z")]),
			parentSession: junk,
		});
		expect(await settleNotice(bad)).toContain("held by the parent");
		const missing = await start(tasks({ id: 1, owner: "worker" }), {
			reason: "fork",
			beforeStart: survivorPeer([alive("worker", "z")]),
			parentSession: join(dir, "none"),
		});
		expect(await settleNotice(missing)).toContain("held by the parent");
	});

	it("holds the owner after resuming A and then an unrelated B", async () => {
		const h = await start(tasks({ id: 1, owner: "worker" }), {
			beforeStart: survivorPeer([alive("worker", "a.jsonl")]),
		});
		await restart(h, "resume");
		expect(await settleNotice(h)).toContain("held by the parent: #1 t1 (@worker)");
		expect(await remind(h)).toBeDefined();
	});

	it("reads a newer failed same-named agent as failed, not the survivor re-announced at the settle", async () => {
		const h = await start(tasks({ id: 1, owner: "general-purpose" }), {
			reason: "reload",
			beforeStart: survivorPeer([alive("general-purpose")]),
		});
		applyAgentEvent("s1", SUBAGENT_STARTED_EVENT, { id: "b1", handle: "general-purpose" });
		applyAgentEvent("s1", "subagents:failed", { id: "b1", status: "error" });
		// The settle re-asks, so the survivor is announced again after the failure.
		expect(await settleNotice(h)).toContain("owner agent failed or stopped: #1 t1 (@general-purpose failed)");
		expect(await remind(h)).toBeUndefined();
	});

	it("does not arm an other-session survivor, so another owner's held todo still reminds", async () => {
		const { handler, ctx } = await start(tasks({ id: 1, owner: "worker" }, { id: 2 }), {
			reason: "fork",
			beforeStart: survivorPeer([alive("worker", "parent.jsonl")]),
			parentSession: "parent.jsonl",
		});
		const result = (await handler("agent_before_settle")(settleEvent([user, assistant]), ctx)) as {
			entries: Array<{ details: { held: number[] } }>;
		};
		expect(result.entries[0].details.held).toEqual([2]);
	});

	it("drops the entry when the survivor completed, even though its result went to the other session", async () => {
		const peer = [alive("worker", "a.jsonl")];
		const h = await start(tasks({ id: 1, owner: "worker" }), {
			reason: "fork",
			beforeStart: survivorPeer(peer),
			parentSession: "a.jsonl",
		});
		expect(await settleNotice(h)).toBe(ELSEWHERE_NOTICE);
		// Re-query at settle: the registry no longer lists it.
		peer[0].live = false;
		expect(await settleNotice(h)).toContain("held by the parent: #1 t1 (@worker)");
		expect(await remind(h)).toBeDefined();
	});

	it("reads a survivor's replayed terminal event as that agent's own state, not as running elsewhere", async () => {
		const h = await start(tasks({ id: 1, owner: "worker" }), {
			reason: "fork",
			beforeStart: survivorPeer([alive("worker", "a.jsonl")]),
			parentSession: "a.jsonl",
		});
		// The registry still lists it (a stale peer); the terminal event is the newer, own-session fact.
		for (const hd of h.bus.get("subagents:completed") ?? [])
			void hd({ id: "a1", handle: "worker", status: "completed" });
		expect(await settleNotice(h)).toContain("held by the parent: #1 t1 (@worker done)");
	});

	it("treats a survivor that finished while this session was inactive as held, with no announcement", async () => {
		const h = await start(tasks({ id: 1, owner: "worker" }), {
			beforeStart: survivorPeer([{ handle: "worker", file: "a.jsonl", live: false }]),
		});
		expect(await settleNotice(h)).toContain("held by the parent: #1 t1 (@worker)");
		expect(await remind(h)).toBeDefined();
	});

	it("prefers this session's own agent state over an other-session survivor of the same owner", async () => {
		const { handler, ctx } = await start(tasks({ id: 1, owner: "worker" }), {
			reason: "fork",
			beforeStart: survivorPeer([alive("worker", "parent.jsonl")]),
			parentSession: "parent.jsonl",
		});
		applyAgentEvent("s1", SUBAGENT_STARTED_EVENT, { id: "b1", handle: "worker", wakesParent: true });
		await handler("agent_settled")({ type: "agent_settled" }, ctx);
		expect(notices(ctx)[0][0]).toContain("agent running: #1 t1 (@worker running)");
	});

	it("matches an other-session survivor by its unnumbered spawner name, and ignores one heard before binding", async () => {
		const early = setup();
		for (const h of early.bus.get(SUBAGENT_OTHER_SESSION_SURVIVOR_EVENT) ?? []) void h({ id: "a1", handle: "worker" });
		const { handler, ctx } = await start(tasks({ id: 1, owner: "Auth Audit" }), {
			reason: "fork",
			beforeStart: survivorPeer([{ ...alive("auth-audit-2", "a.jsonl"), nameBase: "auth-audit" }]),
			parentSession: "a.jsonl",
		});
		await handler("agent_settled")({ type: "agent_settled" }, ctx);
		expect(notices(ctx)[0][0]).toContain("running for another session");
	});

	it("ignores a malformed other-session survivor payload", async () => {
		const { handler, ctx, bus } = await start(tasks({ id: 1, owner: "worker" }), { reason: "fork" });
		for (const h of bus.get(SUBAGENT_OTHER_SESSION_SURVIVOR_EVENT) ?? []) {
			void h(undefined);
			void h({ id: "", handle: "worker" });
		}
		await handler("agent_settled")({ type: "agent_settled" }, ctx);
		expect(notices(ctx)[0][0]).toContain("held by the parent: #1 t1 (@worker)");
	});

	it("hears a survivor re-announced before the session bound, via the announce request", async () => {
		const { handler, ctx, bus } = await start(tasks({ id: 1, owner: "worker" }), {
			reason: "reload",
			beforeStart: (b) => {
				survivorPeer([alive("worker")])(b);
				// pi-subagents' session_start ran first: nothing was bound to hear it yet.
				for (const h of b.get(SUBAGENT_STARTED_EVENT) ?? []) void h({ id: "a1", handle: "worker", wakesParent: true });
			},
		});
		expect(bus.get(SUBAGENT_ANNOUNCE_SURVIVORS_EVENT)).toHaveLength(1);
		expect(await handler("agent_before_settle")(settleEvent([user, assistant]), ctx)).toBeUndefined();
	});

	it("falls back to the held reminder once a survivor's delivered result settles it", async () => {
		const peer = [alive("worker")];
		const { handler, ctx, bus } = await start(tasks({ id: 1, owner: "worker" }), { beforeStart: survivorPeer(peer) });
		const settle = handler("agent_before_settle");
		expect(await settle(settleEvent([user, assistant]), ctx)).toBeUndefined();
		peer[0].live = false; // the registry drops a settled survivor
		for (const h of bus.get("subagents:completed") ?? []) void h({ id: "a1", handle: "worker", status: "completed" });
		const result = (await settle(settleEvent([user, assistant]), ctx)) as { entries: unknown[] };
		expect(result.entries).toHaveLength(1);
	});

	it("re-asks for survivors at a settle of the bound session, never of a child", async () => {
		const asks = vi.fn();
		const { handler, ctx } = await start(tasks({ id: 1 }), {
			beforeStart: (b) => b.set(SUBAGENT_ANNOUNCE_SURVIVORS_EVENT, [asks]),
		});
		expect(asks).toHaveBeenCalledTimes(1);
		await handler("agent_settled")({ type: "agent_settled" }, ctx);
		expect(asks).toHaveBeenCalledTimes(2);
		await handler("agent_settled")({ type: "agent_settled" }, createTodoCtx({ sessionId: "child" }));
		expect(asks).toHaveBeenCalledTimes(2);
	});

	it("asks for survivors once for the bound headless session, never for a child", async () => {
		const asks = vi.fn();
		const { handler } = await start(tasks({ id: 1 }), {
			beforeStart: (b) => b.set(SUBAGENT_ANNOUNCE_SURVIVORS_EVENT, [asks]),
		});
		expect(asks).toHaveBeenCalledTimes(1);
		await handler("session_start")({ reason: "startup" }, createTodoCtx({ sessionId: "child" }));
		expect(asks).toHaveBeenCalledTimes(1);
	});

	it("shows held work once while a wake is armed, and warns again when it is not", async () => {
		const { handler, ctx } = await start(tasks(...Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }))));
		applyAgentEvent("s1", SUBAGENT_STARTED_EVENT, { id: "a1", handle: "worker", wakesParent: true });
		const settled = () => handler("agent_settled")({ type: "agent_settled" }, ctx);
		await settled();
		await settled();
		await settled();
		expect(notices(ctx)).toHaveLength(1);
		expect(notices(ctx)[0][1]).toBe("info");
		// Disarming warns, repeatedly; a person's prompt resets the armed dedupe.
		applyAgentEvent("s1", "subagents:completed", { id: "a1" });
		await settled();
		await settled();
		expect(notices(ctx).map((n) => n[1])).toEqual(["info", "warning", "warning"]);
		applyAgentEvent("s1", SUBAGENT_STARTED_EVENT, { id: "a2", handle: "worker2", wakesParent: true });
		await settled();
		await settled();
		expect(notices(ctx).map((n) => n[1])).toEqual(["info", "warning", "warning", "info"]);
		await handler("input")({ source: "interactive" }, ctx);
		await settled();
		expect(notices(ctx).map((n) => n[1])).toEqual(["info", "warning", "warning", "info", "info"]);
	});

	it("keeps abandoned and silent work a warning even with a wake armed", () => {
		const state = { tasks: [{ id: 1, subject: "t1", status: "in_progress", owner: "dead" }], nextId: 2 } as never;
		const lookup = (owner: string | undefined) => (owner === "dead" ? "failed" : undefined);
		expect(formatInProgressNotice(state, lookup, { armed: true })?.level).toBe("warning");
		const silent = { tasks: [{ id: 1, subject: "t1", status: "in_progress", owner: "w" }], nextId: 2 } as never;
		expect(formatInProgressNotice(silent, () => "running", { armed: true })?.level).toBe("warning");
	});

	it("formats the reminder with sanitized subjects and optional owners", () => {
		const out = formatHeldReminder([
			{ id: 1, subject: "a\u001b[31mb", status: "in_progress" },
			{ id: 2, subject: "c", status: "in_progress", owner: "bob" },
		] as never);
		expect(out).toContain("- #1 a");
		expect(out).not.toContain("\u001b");
		expect(out).toContain("- #2 c (@bob)");
	});
});

describe("plan payload and mode guards", () => {
	it.each([null, undefined, "plan", 7])("isPlanApprovedPayload rejects non-object %j", (value) => {
		expect(isPlanApprovedPayload(value)).toBe(false);
	});

	it("ignores malformed branch entries when deciding whether Plan mode is active", async () => {
		const { handler, announce } = setup();
		const ctx = createTodoCtx({ sessionId: "s1" });
		await handler("session_start")({}, ctx);
		await announce(approval("p1"));
		const transition = (details: unknown) => ({
			type: "message",
			message: { role: "custom", customType: "plan-mode-transition", details },
		});
		const branch: unknown[] = [
			// Walked last-to-first: each of these must be skipped, never read as "planning".
			transition({ version: 2, mode: "plan" }),
			transition({ version: 1, mode: "unknown" }),
			{ type: "custom", customType: "plan-mode-state", data: { enabled: "yes" } },
			{ type: "custom", customType: "plan-mode-state" },
			"not an entry",
			null,
		].reverse();
		vi.mocked(ctx.sessionManager.getBranch).mockImplementation(() => branch as never);
		const result = await handler("agent_before_settle")(
			{ outcome: "completed", entries: [], continue: false, context: { contextMessages: [] } },
			ctx,
		);
		expect(result).toMatchObject({ continue: true });
	});

	it("does not expand a plan reminder once no plan item is open", async () => {
		const { handler, announce, call } = setup();
		const ctx = createTodoCtx({ sessionId: "s1" });
		await handler("session_start")({}, ctx);
		await announce(approval("p1", "s1", "# T\n\n## Work\n- one\n"));
		for (const task of getState("s1").tasks)
			await call(ctx, { action: "update", id: task.id, status: "completed", evidence: "ok" });
		expect(getState("s1").tasks.every((task) => task.status === "completed")).toBe(true);
		const marker = { role: "custom", customType: PLAN_REMINDER_MESSAGE_TYPE, content: PLAN_REMINDER_MARKER };
		expect(await handler("context")({ messages: [{ role: "user", content: "go" }, marker] }, ctx)).toBeUndefined();
	});
});

describe("formatPlanReminder — sparse state", () => {
	it("falls back to a generic title and zero counts without a plan", () => {
		const text = formatPlanReminder({ tasks: [], nextId: 1 });
		expect(text).toContain('the approved plan "plan" still has 0/0 items open');
		expect(text).not.toContain("Deferred plan items");
	});

	it("omits the group tag for ungrouped items and an empty reason for reasonless deferrals", () => {
		const text = formatPlanReminder({
			tasks: [
				{ id: 1, subject: "open one", status: "pending", source: "plan" },
				{ id: 2, subject: "later one", status: "deferred", source: "plan", planGroup: "G" },
			],
			nextId: 3,
			plan: { id: "p", title: "T" },
		});
		expect(text).toContain("- #1 open one\n");
		expect(text).toContain("Deferred plan items (tell the user):\n- #2 [G] later one -- ");
		expect(text.endsWith("later one -- ")).toBe(true);
	});
});
