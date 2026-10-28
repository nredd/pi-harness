import assert from "node:assert/strict";
import { test } from "vitest";
import { DECLINE_GATE_ERROR } from "../src/decline-contract.js";
import { FINALIZE_PLAN_PROMPT } from "../src/finalization-request.js";
import planMode from "../src/plan-mode.js";
import { createMockContext, createMockPi } from "./support.js";

function toolExecute(mock: ReturnType<typeof createMockPi>, name: string) {
  const execute = mock.tools.find((tool) => tool.name === name)?.execute;
  assert.equal(typeof execute, "function", `${name} must be registered`);
  return execute as (...args: unknown[]) => Promise<unknown>;
}

test("question tool returns distinct inactive and invalid-input outcomes", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
  const context = createMockContext();
  const question = toolExecute(mock, "plan_mode_question");

  const inactive = (await question("inactive", {}, undefined, undefined, context.ctx)) as { details?: unknown };
  assert.deepEqual(inactive.details, { cancelled: true, reason: "plan_mode_inactive", questions: [] });

  await mock.commands.get("plan")?.handler("start", context.ctx);
  const invalid = (await question("invalid", { questions: [] }, undefined, undefined, context.ctx)) as {
    details?: { reason?: string };
  };
  assert.equal(invalid.details?.reason, "invalid_input");
  assert.equal(context.statuses.get("plan-mode"), "plan active");
});

test("headless activation reports unavailable Plan helpers as an error", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  mock.rawPi.setActiveTools(["read"]);
  planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
  const context = createMockContext({ hasUI: false, mode: "print" });

  await assert.rejects(
    async () => mock.commands.get("plan")?.handler("start", context.ctx),
    /Cannot start Plan mode: plan_mode_question and plan_mode_complete are unavailable/u,
  );
  assert.equal(context.statuses.get("plan-mode"), undefined);
});

test("a declined plan requires renewed confirmation before a second proposal", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
  const context = createMockContext();
  const complete = toolExecute(mock, "plan_mode_complete");

  await mock.commands.get("plan")?.handler("start", context.ctx);
  await complete("complete", { plan: "# First" }, undefined, undefined, context.ctx);
  await mock.events.get("input")?.[0]?.({ text: "revise", source: "user" }, context.ctx);
  await mock.events.get("input")?.[0]?.({ text: "revise again", source: "user" }, context.ctx);

  await assert.rejects(
    async () => complete("second", { plan: "# Second" }, undefined, undefined, context.ctx),
    (error: unknown) => error instanceof Error && error.message === DECLINE_GATE_ERROR,
  );
  assert.equal((mock.entries.at(-1)?.data as { declinedPlans?: number } | undefined)?.declinedPlans, 1);
});

test("invalid settings warn without changing the extension's safe defaults", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, {
    readSettings: async () => ({ kind: "invalid" as const, reason: "bad JSON", notice: "use a valid file" }),
  });
  const context = createMockContext({ hasUI: true });

  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);

  assert.deepEqual(context.notifications, [
    { message: "pi-plan-mode settings ignored: bad JSON", level: "warning" },
    { message: "use a valid file", level: "warning" },
  ]);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  assert.equal(context.statuses.get("plan-mode"), "plan active");
});

test("an unavailable settings directory leaves Plan mode usable", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, { settingsPath: "/definitely-missing-plan-mode-directory/settings.json" });
  const context = createMockContext();

  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);

  assert.equal(context.statuses.get("plan-mode"), "plan active");
});

test("a replaced session cannot finish the previous session shutdown", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
  const first = createMockContext({ sessionManager: { getBranch: () => [], getEntries: () => [] } });
  const second = createMockContext({ sessionManager: { getBranch: () => [], getEntries: () => [] } });
  const start = mock.events.get("session_start")?.[0];
  const shutdown = mock.events.get("session_shutdown")?.[0];
  assert.ok(start);
  assert.ok(shutdown);

  await start({ reason: "startup" }, first.ctx);
  const stopping = Promise.resolve(shutdown({ reason: "reload" }, first.ctx));
  await start({ reason: "reload" }, second.ctx);
  await stopping;

  assert.equal(first.statuses.get("plan-mode"), undefined);
  assert.equal(second.statuses.get("plan-mode"), undefined);
});

test("legacy malformed plans remain active and explain the rejection", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
  const context = createMockContext();
  await mock.commands.get("plan")?.handler("start", context.ctx);

  await mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", content: "<proposed_plan>unfinished", stopReason: "stop" }] },
    context.ctx,
  );

  assert.equal(context.statuses.get("plan-mode"), "plan active");
  assert.match(context.notifications.at(-1)?.message ?? "", /closing tag is missing/u);
});

test("restoring Plan mode without helpers fails closed even without a UI", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  mock.rawPi.setActiveTools(["read"]);
  planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
  const state = { type: "custom", customType: "plan-mode-state", data: { enabled: true, awaitingAction: false } };
  const context = createMockContext({
    hasUI: false,
    sessionManager: { getBranch: () => [state], getEntries: () => [state] },
  });

  await mock.events.get("session_start")?.[0]?.({ reason: "resume" }, context.ctx);

  assert.equal(context.statuses.get("plan-mode"), undefined);
  assert.deepEqual(mock.rawPi.getActiveTools(), ["read"]);
});

test("failed finalization retry resets the request instead of retrying forever", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
  const context = createMockContext();
  await mock.commands.get("plan")?.handler("start", context.ctx);
  await mock.commands.get("plan")?.handler("finalize", context.ctx);
  const agentEnd = mock.events.get("agent_end")?.[0];
  const settled = mock.events.get("agent_settled")?.[0];
  assert.ok(agentEnd);
  assert.ok(settled);
  await agentEnd({ messages: [{ role: "assistant", content: "No result.", stopReason: "stop" }] }, context.ctx);
  mock.rawPi.sendUserMessage = () => {
    throw new Error("delivery failed");
  };

  await settled({}, context.ctx);
  await settled({}, context.ctx);

  assert.equal(mock.sentUserMessages.length, 1);
  assert.equal(mock.sentUserMessages[0]?.text, FINALIZE_PLAN_PROMPT);
  assert.match(context.notifications.at(-1)?.message ?? "", /delivery failed/u);
});
