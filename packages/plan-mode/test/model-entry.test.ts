import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import planMode from "../src/plan-mode.js";
import { normalizePlanModeSettings } from "../src/settings.js";
import { WORKFLOW_MUTEX_CHANNEL } from "../src/workflow-mutex.js";
import { createPlanContext, createPlanPi } from "./support.js";

type Options = Parameters<typeof createPlanContext>[0];

/** Drive the production closure with explicit settings and a disposable in-memory branch. */
async function fixture(options: Options = {}, data?: Record<string, unknown>, enabled = true) {
  const mock = createPlanPi({ activeTools: ["read", "write", "plan_mode_enter"] });
  const context = createPlanContext({
    hasUI: true,
    mode: "rpc",
    ...options,
    ...(data
      ? {
          sessionManager: {
            getBranch: () => [{ type: "custom", customType: "plan-mode-state", data }],
            getSessionId: () => "entry-test",
          },
        }
      : {}),
  });
  planMode(mock.pi, {
    readSettings: async () => ({ kind: "loaded", settings: { thinkingLevel: "inherit", modelPlanEntry: enabled } }),
  });
  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of mock.handlers.get(name) ?? []) await handler(event, context.ctx);
  };
  await emit("session_start", { reason: "startup" });
  if (!data?.enabled) await emit("before_agent_start", { messageType: "user", prompt: "Original request" });
  const execute = [...mock.tools.values()].find((tool) => tool.name === "plan_mode_enter")?.execute as unknown as (
    id: string,
    params: { reason: string },
    signal: AbortSignal | undefined,
    update: undefined,
    ctx: ExtensionContext,
  ) => Promise<{ content: { text: string }[]; terminate?: boolean }>;
  const enter = (signal?: AbortSignal, reason = "Scope") =>
    execute("entry", { reason }, signal, undefined, context.ctx);
  return { mock, context, emit, enter };
}

test("model entry settings accept only booleans, default on, and opt-out does not widen tools", async () => {
  assert.deepEqual(normalizePlanModeSettings({ modelPlanEntry: true }), {
    thinkingLevel: "inherit",
    modelPlanEntry: true,
  });
  assert.equal(normalizePlanModeSettings({ modelPlanEntry: "false" }), undefined);
  const f = await fixture({}, undefined, false);
  assert.equal(f.mock.pi.getActiveTools().includes("plan_mode_enter"), false);
  assert.match((await f.enter()).content[0]?.text ?? "", /disabled/);
  assert.equal(f.mock.sentMessages.length, 0);
});

for (const [data, message] of [
  [{ enabled: true, awaitingAction: false }, /already active/],
  [
    { enabled: true, awaitingAction: true, latestPlan: "# Ready", latestPlanSource: "plan_mode_complete" },
    /ready for review/,
  ],
  [
    { enabled: false, awaitingAction: false, savedPlan: { plan: "# Saved", source: "plan_mode_complete" } },
    /saved plan/,
  ],
  [
    {
      enabled: false,
      awaitingAction: false,
      activeImplementation: {
        id: "impl",
        plan: "# Active",
        source: "plan_mode_complete",
        startedAt: 1,
        retention: "keep",
      },
    },
    /implementation is active/,
  ],
] as const) {
  test(`entry preserves existing state: ${message}`, async () => {
    const f = await fixture({}, data);
    const before = JSON.stringify(f.mock.entries);
    assert.match((await f.enter()).content[0]?.text ?? "", message);
    if (data.enabled) {
      const policy = (await f.mock.handlers.get("tool_call")?.[0]?.(
        { toolName: "plan_mode_enter", input: { reason: "Scope" } },
        f.context.ctx,
      )) as { block: boolean; reason: string };
      assert.equal(policy.block, true);
      assert.match(policy.reason, message);
    }
    assert.equal(JSON.stringify(f.mock.entries), before);
    assert.equal(f.mock.sentUserMessages.length, 0);
  });
}

test("mutex contention refuses anonymously before confirmation and rechecks after confirmation", async () => {
  let confirms = 0;
  const f = await fixture({
    confirm: async () => {
      confirms++;
      return true;
    },
  });
  const off = f.mock.bus.on(WORKFLOW_MUTEX_CHANNEL, (attempt) => {
    (attempt as { busy: boolean }).busy = true;
  });
  assert.match((await f.enter()).content[0]?.text ?? "", /Another workflow/);
  assert.equal(confirms, 0);
  off();
  await f.enter();
  f.mock.bus.on(WORKFLOW_MUTEX_CHANNEL, (attempt) => {
    (attempt as { busy: boolean }).busy = true;
  });
  await f.emit("agent_settled");
  assert.equal(f.mock.sentMessages.length, 0);
  assert.match(f.context.notifications.at(-1)?.message ?? "", /Another workflow/);
});

test("pending confirms are unique; empty reasons and unsupported UI cannot mutate", async () => {
  let answer!: (value: boolean) => void;
  const f = await fixture({
    confirm: () =>
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
  });
  assert.match((await f.enter(undefined, " ")).content[0]?.text ?? "", /non-empty/);
  const pending = f.enter();
  assert.match((await f.enter()).content[0]?.text ?? "", /already pending/);
  answer(false);
  assert.match((await pending).content[0]?.text ?? "", /declined/);
  const noUi = await fixture({ hasUI: false });
  assert.match((await noUi.enter()).content[0]?.text ?? "", /requires TUI or RPC/);
});

test("confirmation failure clears the reservation and aborted confirmation never enters", async () => {
  let fail = true;
  const controller = new AbortController();
  const f = await fixture({
    confirm: async () => {
      if (fail) throw new Error("dialog unavailable");
      controller.abort();
      return true;
    },
  });
  await assert.rejects(f.enter(), /dialog unavailable/);
  fail = false;
  assert.match((await f.enter(controller.signal)).content[0]?.text ?? "", /cancelled/);
  await f.emit("agent_settled");
  assert.equal(f.mock.sentMessages.length, 0);
});

for (const event of ["session_start", "session_tree", "session_shutdown"] as const) {
  test(`${event} invalidates pending confirmed entry`, async () => {
    const f = await fixture();
    await f.enter();
    await f.emit(event, { reason: "reload" });
    await f.emit("agent_settled");
    assert.equal(f.mock.sentUserMessages.length, 0);
    assert.equal(f.mock.sentMessages.length, 0);
  });
}

test("a rejected stale confirmation does not clear a replacement session's reservation", async () => {
  let reject!: (error: Error) => void;
  const f = await fixture({
    confirm: () =>
      new Promise<boolean>((_resolve, fail) => {
        reject = fail;
      }),
  });
  const pending = f.enter();
  await f.emit("session_start", { reason: "reload" });
  reject(new Error("stale dialog"));
  await assert.rejects(pending, /stale dialog/);
  await f.emit("agent_settled");
  assert.equal(f.mock.sentUserMessages.length, 0);
});

test("reload during confirmation, explicit supersession and cancellation invalidate intent", async () => {
  let answer!: (value: boolean) => void;
  const f = await fixture({
    confirm: () =>
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
  });
  const pending = f.enter();
  await f.emit("session_start", { reason: "reload" });
  answer(true);
  assert.match((await pending).content[0]?.text ?? "", /cancelled/);
  const g = await fixture();
  await g.enter();
  await g.mock.commands.get("plan")?.handler("exit", g.context.ctx);
  await g.emit("agent_settled");
  assert.equal(g.mock.sentUserMessages.length, 0);
  for (const stopReason of ["aborted", "error"]) {
    const h = await fixture();
    await h.enter();
    await h.emit("agent_end", { messages: [{ role: "assistant", stopReason, content: [] }] });
    await h.emit("agent_settled");
    assert.equal(h.mock.sentMessages.length, 0);
  }
});

for (const busy of ["run", "queue"] as const) {
  test(`settled entry cannot displace a ${busy}`, async () => {
    let idle = true;
    let queued = false;
    const f = await fixture({ isIdle: () => idle, hasPendingMessages: () => queued });
    await f.enter();
    idle = busy !== "run";
    queued = busy === "queue";
    await f.emit("agent_settled");
    assert.match(f.context.notifications.at(-1)?.message ?? "", /another request is pending/);
    assert.equal(f.mock.sentMessages.length, 0);
  });
}

test("aborted settlement invalidates confirmed entry without an aborted assistant message", async () => {
  const f = await fixture();
  const tools = f.mock.pi.getActiveTools();
  const before = JSON.stringify(f.mock.entries);
  await f.enter();
  await f.emit("agent_end", { messages: [{ role: "assistant", stopReason: "toolUse", content: [] }] });
  await f.emit("agent_settled", { aborted: true });
  assert.equal(f.mock.sentUserMessages.length, 0);
  assert.equal(f.mock.sentMessages.length, 0);
  assert.equal(JSON.stringify(f.mock.entries), before);
  assert.deepEqual(f.mock.pi.getActiveTools(), tools);
});

test("a superseding user request drained before settlement invalidates confirmed entry", async () => {
  const f = await fixture();
  const tools = f.mock.pi.getActiveTools();
  const before = JSON.stringify(f.mock.entries);
  await f.enter();
  await f.emit("input", { text: "Instead, inspect the tests", source: "interactive" });
  await f.emit("message_start", { message: { role: "user", content: "Instead, inspect the tests" } });
  await f.emit("agent_settled", { aborted: false });
  assert.equal(f.mock.sentUserMessages.length, 0);
  assert.equal(f.mock.sentMessages.length, 0);
  assert.equal(JSON.stringify(f.mock.entries), before);
  assert.deepEqual(f.mock.pi.getActiveTools(), tools);
});

test("admitted user messages invalidate entry even when input is extension-owned or text is repeated", async () => {
  const f = await fixture();
  await f.enter();
  await f.emit("input", { text: "Original request", source: "extension" });
  await f.emit("message_start", { message: { role: "user", content: "Original request" } });
  await f.emit("agent_settled", { aborted: false });
  assert.equal(f.mock.sentMessages.length, 0);
  assert.equal(f.mock.sentUserMessages.length, 0);
});

test("fresh confirmation after superseding input replays only the newly admitted request", async () => {
  const f = await fixture();
  await f.enter();
  await f.emit("input", { text: "Instead, inspect tests", source: "interactive" });
  await f.emit("message_start", { message: { role: "user", content: "Instead, inspect tests" } });
  await f.enter();
  await f.emit("agent_settled", { aborted: false });
  assert.deepEqual(
    f.mock.sentUserMessages.map((message) => message.content),
    ["Instead, inspect tests"],
  );
});

test("settled entry uses helper admission without activating hidden helpers", async () => {
  const f = await fixture();
  await f.enter();
  f.mock.pi.setActiveTools(["read", "plan_mode_enter"]);
  await f.emit("agent_settled");
  assert.match(
    f.context.notifications.at(-1)?.message ?? "",
    /plan_mode_question and plan_mode_complete are unavailable/,
  );
  assert.deepEqual(f.mock.pi.getActiveTools(), ["read", "plan_mode_enter"]);
  assert.equal(f.mock.sentUserMessages.length, 0);
});
