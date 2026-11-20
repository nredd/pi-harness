import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { EMPTY_REMINDER_MARKER } from "../../src/plan/hooks.ts";
import { EMPTY_REMINDER_MESSAGE_TYPE } from "../../src/tool/types.ts";
import registerTodo from "../fixtures/home-fixtures.ts";
import { TEST_HOME } from "../fixtures/setup.ts";
import { createTodoCtx, createTodoPi } from "../fixtures/todo-host.ts";

const config = join(TEST_HOME, ".config", "rpiv-todo", "config.json");
const marker = { customType: EMPTY_REMINDER_MESSAGE_TYPE, content: EMPTY_REMINDER_MARKER, display: false };

afterEach(() => {
	rmSync(config, { force: true });
	vi.unstubAllGlobals();
});

async function setup({
	calls = 3,
	cooldown = 2,
	child = false,
	branch = [],
}: {
	calls?: number;
	cooldown?: number;
	child?: boolean;
	branch?: SessionEntry[];
} = {}) {
	mkdirSync(dirname(config), { recursive: true });
	writeFileSync(config, JSON.stringify({ emptyAfterToolCalls: calls, emptyReminderCooldownSettles: cooldown }));
	const ctx = createTodoCtx({ sessionId: "s1", branch });
	const { pi, captured } = createTodoPi();
	const register = () => registerTodo(pi, undefined, { homeDir: TEST_HOME });
	if (child) {
		const context = new AsyncLocalStorage<boolean>();
		vi.stubGlobal(Symbol.for("pi-subagents:child-session-context"), context);
		context.run(true, register);
	} else register();

	const emit = async (name: string, event: unknown, context = ctx) => {
		let result: unknown;
		for (const handler of captured.handlers.get(name) ?? []) result = await handler(event, context);
		return result;
	};
	await emit("session_start", { reason: "startup" });
	return {
		emit,
		tool: (toolName = "read", isError = false, context = ctx) =>
			emit("tool_execution_end", { toolName, isError }, context),
		settle: (outcome = "completed", context = ctx) =>
			emit("agent_before_settle", { outcome, entries: [], context: { contextMessages: [] } }, context),
		input: (source = "interactive") => emit("input", { source }),
		callTodo: (params: Record<string, unknown>) =>
			captured.tools.get("todo")?.execute("tc", params as never, undefined, undefined, ctx),
	};
}

const reminder = { continue: true, entries: [{ type: "custom_message", ...marker, details: {} }] };

it("counts work across settles, skips conversation, and expands only the trailing marker", async () => {
	const { tool, settle, emit, input } = await setup();
	for (let i = 0; i < 2; i++) {
		await tool();
		expect(await settle()).toBeUndefined();
	}
	await input();
	expect(await settle()).toBeUndefined();
	await tool();
	expect(await settle()).toEqual(reminder);
	const message = { role: "custom", ...marker };
	expect(await emit("context", { messages: [message] })).toEqual({
		messages: [{ ...message, content: expect.stringContaining("use `todo`") }],
	});
	expect(message.content).toBe(EMPTY_REMINDER_MARKER);
	expect(await emit("context", { messages: [message, { role: "assistant" }] })).toBeUndefined();
});

it("nudges for a successful Agent call, but not a failed one or an unfinished run", async () => {
	const { tool, settle } = await setup({ calls: 5 });
	await tool("Agent", true);
	expect(await settle()).toBeUndefined();
	await tool("Agent");
	expect(await settle("aborted")).toBeUndefined();
	expect(await settle()).toBeUndefined();
	await tool("Agent");
	expect(await settle()).toEqual(reminder);
});

it("requires fresh work, human input and actual settles between nudges", async () => {
	const { tool, settle, input, emit } = await setup({ calls: 1, cooldown: 3 });
	await tool();
	expect(await settle()).toEqual(reminder);
	await settle();
	await emit("agent_settled", { aborted: false });
	await input();
	for (let i = 0; i < 4; i++) {
		await tool("Agent");
		expect(await settle()).toBeUndefined(); // Another handler continues this run.
	}
	await emit("agent_settled", { aborted: false });
	await tool();
	expect(await settle()).toBeUndefined();
	await emit("agent_settled", { aborted: false });
	await tool();
	expect(await settle()).toEqual(reminder);
	await input("extension");
	for (let i = 0; i < 4; i++) {
		await tool("Agent");
		expect(await settle()).toBeUndefined();
		await emit("agent_settled", { aborted: false });
	}
	await input("rpc");
	expect(await settle()).toBeUndefined();
	await tool();
	expect(await settle()).toEqual(reminder);
});

it("does not age cooldown after aborted, failed or Plan runs", async () => {
	const branch: SessionEntry[] = [];
	const { tool, settle, input, emit } = await setup({ calls: 1, cooldown: 1, branch });
	await tool();
	expect(await settle()).toEqual(reminder);
	await settle();
	await emit("agent_settled", { aborted: true });
	await input();
	await settle("error");
	await emit("agent_settled", { aborted: false });
	await tool();
	expect(await settle()).toBeUndefined();
	branch.push({
		type: "custom",
		customType: "plan-mode-state",
		id: "plan",
		parentId: null,
		timestamp: "",
		data: { enabled: true },
	});
	await emit("agent_settled", { aborted: false });
	branch.pop();
	await tool();
	expect(await settle()).toBeUndefined();
	await emit("agent_settled", { aborted: false });
	await tool();
	expect(await settle()).toEqual(reminder);
});

it("resets work on todo activity and skips nonempty lists, including completed todos", async () => {
	const { tool, settle, callTodo, emit, input } = await setup({ calls: 2 });
	await tool("Agent");
	await tool("todo");
	await tool();
	expect(await settle()).toBeUndefined();
	await tool();
	expect(await settle()).toEqual(reminder);
	await callTodo({ action: "create", subject: "Tracked work" });
	await callTodo({ action: "update", id: 1, status: "completed", evidence: "Checked" });
	await input();
	for (let i = 0; i < 2; i++) {
		await tool("Agent");
		expect(await settle()).toBeUndefined();
		await emit("agent_settled", { aborted: false });
	}
	await tool("Agent");
	expect(await settle()).toBeUndefined();
	expect(await emit("context", { messages: [{ role: "custom", ...marker }] })).toBeUndefined();
});

it("nudges and expands the marker after the last visible todo is deleted", async () => {
	const { tool, settle, callTodo, emit } = await setup({ calls: 2 });
	await callTodo({ action: "create", subject: "Tracked work" });
	await tool("todo");
	await callTodo({ action: "delete", id: 1 });
	await tool("todo");
	await tool();
	expect(await settle()).toBeUndefined();
	await tool();
	expect(await settle()).toEqual(reminder);
	expect(await emit("context", { messages: [{ role: "custom", ...marker }] })).toEqual({
		messages: [{ role: "custom", ...marker, content: expect.stringContaining("use `todo`") }],
	});
});

it("pauses counting, settling and context expansion in Plan mode", async () => {
	const branch: SessionEntry[] = [];
	const { tool, settle, emit } = await setup({ calls: 2, branch });
	branch.push({
		type: "custom",
		customType: "plan-mode-state",
		id: "plan",
		parentId: null,
		timestamp: "",
		data: { enabled: true },
	});
	await tool("Agent");
	expect(await settle()).toBeUndefined();
	expect(await emit("context", { messages: [{ role: "custom", ...marker }] })).toBeUndefined();
	branch.pop();
	await tool();
	expect(await settle()).toBeUndefined();
	await tool();
	expect(await settle()).toEqual(reminder);
});

it.each([{ child: true }, { calls: 0 }])("suppresses the nudge with %j", async (options) => {
	const { tool, settle, emit } = await setup(options);
	await tool("Agent");
	expect(await settle()).toBeUndefined();
	expect(await emit("context", { messages: [{ role: "custom", ...marker }] })).toBeUndefined();
});

it("restores the prompt budget and isolates and evicts session work", async () => {
	const { tool, settle, input, emit } = await setup({
		calls: 1,
		branch: [{ type: "custom_message", ...marker, id: "nudge", parentId: null, timestamp: "" }],
	});
	await tool("Agent");
	expect(await settle()).toBeUndefined();
	await emit("agent_settled", { aborted: false });
	await input();
	const another = createTodoCtx({ sessionId: "s2" });
	await emit("session_start", { reason: "new" }, another);
	await tool("Agent");
	expect(await settle("completed", another)).toBeUndefined();
	expect(await settle()).toBeUndefined();
	await emit("agent_settled", { aborted: false });
	await tool("Agent");
	expect(await settle()).toEqual(reminder);
	await tool("Agent", false, another);
	await emit("session_shutdown", {}, another);
	expect(await settle("completed", another)).toBeUndefined();
});
