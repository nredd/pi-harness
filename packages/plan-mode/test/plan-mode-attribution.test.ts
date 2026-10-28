import assert from "node:assert/strict";
import { test, vi } from "vitest";
import planMode from "../src/plan-mode.js";
import { createMockContext, createMockPi } from "./support.js";

/** Read the public tool gate instead of reaching into Plan mode's private state. */
async function questionGate(mock: ReturnType<typeof createMockPi>, context: ReturnType<typeof createMockContext>) {
  const handler = mock.events.get("tool_call")?.[0];
  assert.ok(handler);
  return handler({ toolName: "plan_mode_question", input: {} }, context.ctx) as Promise<
    { reason?: string } | undefined
  >;
}

test("restored thinking failure rolls back state and releases the newly acquired workflow", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, {
    readSettings: async () => ({ kind: "loaded" as const, settings: { thinkingLevel: "high" as const } }),
  });
  const state = {
    type: "custom",
    customType: "plan-mode-state",
    data: { enabled: true, awaitingAction: false, appliedThinkingLevel: "high", previousThinkingLevel: "low" },
  };
  const sessionManager = { getBranch: () => [state], getEntries: () => [state] };
  const context = createMockContext({ hasUI: false, sessionManager });
  const start = mock.events.get("session_start")?.[0];
  assert.ok(start);
  const setThinkingLevel = mock.rawPi.setThinkingLevel;
  const failure = new Error("restored thinking level rejected");
  let thinkingAttempts = 0;
  mock.rawPi.setThinkingLevel = (level) => {
    setThinkingLevel(level);
    thinkingAttempts += 1;
    if (thinkingAttempts === 1) throw failure;
  };

  await assert.rejects(
    async () => start({ reason: "resume" }, context.ctx),
    (error: unknown) => error === failure,
  );

  assert.equal(mock.rawPi.getThinkingLevel(), "low", "outer rollback must restore the prior thinking level");
  assert.match((await questionGate(mock, context))?.reason ?? "", /only available while Plan mode is active/u);
  const contender = { session: sessionManager, group: "agent-workflow", busy: false };
  mock.eventBus.emit("workflow:mutex:v1", contender);
  assert.equal(contender.busy, false);
  mock.rawPi.setThinkingLevel = setThinkingLevel;
  await mock.commands.get("plan")?.handler("start", context.ctx);
  assert.equal(context.statuses.get("plan-mode"), "plan active");
  assert.equal(mock.rawPi.getThinkingLevel(), "high");
  assert.equal(await questionGate(mock, context), undefined);
});

test("failed tree restoration retains the prior Plan state, policy, and workflow owner", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
  const entries: Array<{ type: string; customType: string; data: Record<string, unknown> }> = [];
  const sessionManager = { getBranch: () => entries, getEntries: () => entries };
  const context = createMockContext({ sessionManager });
  const start = mock.events.get("session_start")?.[0];
  const tree = mock.events.get("session_tree")?.[0];
  assert.ok(start);
  assert.ok(tree);
  await start({ reason: "startup" }, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  const appendEntry = mock.rawPi.appendEntry;
  const failure = new Error("restored policy persistence rejected");
  mock.rawPi.appendEntry = () => {
    throw failure;
  };
  entries.push({
    type: "custom",
    customType: "plan-mode-state",
    data: { enabled: true, awaitingAction: false, selectedToolNames: [] },
  });

  await assert.rejects(
    async () => tree({}, context.ctx),
    (error: unknown) => error === failure,
  );

  assert.equal(await questionGate(mock, context), undefined);
  const contender = { session: sessionManager, group: "agent-workflow", busy: false };
  mock.eventBus.emit("workflow:mutex:v1", contender);
  assert.equal(contender.busy, true);
  mock.rawPi.appendEntry = appendEntry;
  const call = mock.events.get("tool_call")?.[0];
  assert.ok(call);
  assert.equal(await call({ toolName: "read", input: { path: "README.md" } }, context.ctx), undefined);
  const transformContext = mock.events.get("context")?.[0];
  assert.ok(transformContext);
  await transformContext({ messages: [] }, context.ctx);
  assert.equal(await call({ toolName: "read", input: { path: "README.md" } }, context.ctx), undefined);
  const before = mock.events.get("before_agent_start")?.[0];
  assert.ok(before);
  await before({ prompt: "keep planning" }, context.ctx);
  assert.equal(await questionGate(mock, context), undefined);
  await mock.commands.get("plan")?.handler("off", context.ctx);
  assert.match((await questionGate(mock, context))?.reason ?? "", /only available while Plan mode is active/u);
});

test("a failed lazy UI import can be retried by the same extension instance", async () => {
  const failure = new Error("interactive UI failed to load");
  vi.doMock("../src/interactive-ui.js", () => {
    throw failure;
  });
  try {
    const mock = createMockPi({ activeTools: ["read"] });
    planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
    const context = createMockContext({ hasUI: true, mode: "tui" });
    const command = mock.commands.get("plan");
    assert.ok(command);
    await assert.rejects(
      async () => command.handler("settings", context.ctx),
      (error: unknown) => error instanceof Error && error.cause === failure,
    );

    let opened = 0;
    vi.doMock("../src/interactive-ui.js", () => ({
      showPlanModeSettings: async () => {
        opened += 1;
        return { kind: "closed", reason: "close" };
      },
    }));
    await command.handler("settings", context.ctx);
    assert.equal(opened, 1);
    assert.equal(context.statuses.get("plan-mode"), undefined);
  } finally {
    vi.doUnmock("../src/interactive-ui.js");
  }
});

test("exiting a ready plan through its review menu clears it and permits a new workflow", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, {
    readSettings: async () => ({ kind: "missing" as const }),
    loadInteractiveUi: async () => ({
      ...(await import("../src/interactive-ui.js")),
      showReadyPlanMenu: async (_context, options) => {
        options.exit();
      },
    }),
  });
  const context = createMockContext({ hasUI: true, mode: "tui" });
  await mock.commands.get("plan")?.handler("start", context.ctx);
  const complete = mock.tools.find((tool) => tool.name === "plan_mode_complete")?.execute;
  assert.equal(typeof complete, "function");
  await (complete as (...args: unknown[]) => Promise<unknown>)(
    "ready",
    { plan: "# Ready for review" },
    undefined,
    undefined,
    context.ctx,
  );
  await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
  assert.equal(context.notifications.at(-1)?.message, "Plan mode disabled. Proposed plan discarded.");
  const persisted = mock.entries.at(-1)?.data as { enabled: boolean; latestPlan?: unknown } | undefined;
  assert.ok(persisted);
  assert.equal(persisted.enabled, false);
  assert.equal(persisted.latestPlan, undefined);
  assert.match((await questionGate(mock, context))?.reason ?? "", /only available while Plan mode is active/u);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  assert.equal(context.statuses.get("plan-mode"), "plan active");
});
