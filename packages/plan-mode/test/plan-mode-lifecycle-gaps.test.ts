import assert from "node:assert/strict";
import { test } from "vitest";
import { DECLINE_GATE_ERROR } from "../src/decline-contract.js";
import planMode from "../src/plan-mode.js";
import { createMockContext, createMockPi } from "./support.js";

test("failed Normal contract publication keeps the active Plan state and ownership", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
  const sessionManager = restored({ enabled: false, awaitingAction: false });
  const context = createMockContext({ sessionManager, hasUI: true });
  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  mock.rawPi.sendMessage = () => {
    throw new Error("contract persistence unavailable");
  };
  await mock.commands.get("plan")?.handler("off", context.ctx);
  assert.equal(context.statuses.get("plan-mode"), "plan active");
  assert.match(context.notifications.at(-1)?.message ?? "", /contract persistence unavailable/u);
  const contender = { session: sessionManager, group: "agent-workflow", busy: false };
  mock.eventBus.emit("workflow:mutex:v1", contender);
  assert.equal(contender.busy, true);
});

function restored(data: Record<string, unknown>) {
  const branch = [{ type: "custom", customType: "plan-mode-state", data }];
  return { getBranch: () => branch, getEntries: () => branch };
}

test("legacy completion cannot bypass a declined plan and renewed replies revoke confirmation", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
  const context = createMockContext({
    sessionManager: restored({
      enabled: true,
      awaitingAction: true,
      latestPlan: "# Existing",
      planDeclined: true,
      declinedPlans: 1,
      reproposalReview: "confirmed",
    }),
  });
  await mock.events.get("session_start")?.[0]?.({ reason: "resume" }, context.ctx);
  await mock.events.get("input")?.[0]?.({ text: "No, revise again", source: "user" }, context.ctx);
  await mock.events.get("agent_end")?.[0]?.(
    {
      messages: [
        { role: "assistant", content: "<proposed_plan>\n# Unauthorized\n</proposed_plan>", stopReason: "stop" },
      ],
    },
    context.ctx,
  );
  const state = mock.entries.at(-1)?.data as { latestPlan?: string; reproposalReview?: string; declinedPlans?: number };
  assert.equal(state.latestPlan, "# Existing");
  assert.equal(state.reproposalReview, "required");
  assert.equal(state.declinedPlans, 1);
  assert.equal(context.notifications.at(-1)?.message, `Proposed plan ignored. ${DECLINE_GATE_ERROR}`);
});

test("restoring a manual thinking override reapplies it without adopting the settings default", async () => {
  const mock = createMockPi({ activeTools: ["read"], thinkingLevel: "low" });
  planMode(mock.pi, {
    readSettings: async () => ({ kind: "loaded" as const, settings: { thinkingLevel: "high" as const } }),
  });
  const context = createMockContext({
    sessionManager: restored({ enabled: true, awaitingAction: false, manualThinkingLevel: "medium" }),
  });
  await mock.events.get("session_start")?.[0]?.({ reason: "resume" }, context.ctx);
  assert.equal(mock.thinkingLevel, "medium");
  await mock.commands.get("plan")?.handler("off", context.ctx);
  assert.equal(mock.thinkingLevel, "medium", "manual choice must survive leaving Plan mode");
});

test("a throwing active-tool registry fails activation closed", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  mock.rawPi.getActiveTools = () => {
    throw new Error("active registry unavailable");
  };
  planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
  const context = createMockContext({ hasUI: true });
  await mock.commands.get("plan")?.handler("start", context.ctx);
  assert.match(
    context.notifications.at(-1)?.message ?? "",
    /Cannot start Plan mode: plan_mode_question and plan_mode_complete are unavailable/u,
  );
  assert.equal(context.statuses.get("plan-mode"), undefined);
});

test("failed new activation restores inactive state and frees workflow ownership", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, {
    readSettings: async () => ({ kind: "loaded" as const, settings: { thinkingLevel: "high" as const } }),
  });
  const sessionManager = restored({ enabled: false, awaitingAction: false });
  const context = createMockContext({ sessionManager });
  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
  const failure = new Error("thinking unavailable");
  mock.rawPi.setThinkingLevel = () => {
    throw failure;
  };
  await assert.rejects(
    async () => mock.commands.get("plan")?.handler("start", context.ctx),
    (error: unknown) => error === failure,
  );
  const gate = (await mock.events.get("tool_call")?.[0]?.(
    { toolName: "plan_mode_question", input: {} },
    context.ctx,
  )) as { reason?: string };
  assert.match(gate.reason ?? "", /only available while Plan mode is active/u);
  const contender = { session: sessionManager, group: "agent-workflow", busy: false };
  mock.eventBus.emit("workflow:mutex:v1", contender);
  assert.equal(contender.busy, false);
});

for (const stale of [true, false]) {
  test(`${stale ? "a stale ready-menu context is contained" : "a non-stale ready-menu error escapes"} when presentation settles`, async () => {
    let presentations = 0;
    const failure = new Error(stale ? "Extension context is no longer active" : "menu backend failed");
    const mock = createMockPi({ activeTools: ["read"] });
    planMode(mock.pi, {
      readSettings: async () => ({ kind: "missing" as const }),
      loadInteractiveUi: async () => ({
        ...(await import("../src/interactive-ui.js")),
        showReadyPlanMenu: async () => {
          presentations += 1;
          throw failure;
        },
      }),
    });
    const context = createMockContext({ hasUI: true, mode: "tui" });
    await mock.commands.get("plan")?.handler("start", context.ctx);
    const complete = mock.tools.find((tool) => tool.name === "plan_mode_complete")?.execute;
    assert.equal(typeof complete, "function");
    await (complete as (...args: unknown[]) => Promise<unknown>)(
      "ready",
      { plan: "# Keep this plan" },
      undefined,
      undefined,
      context.ctx,
    );
    const settle = mock.events.get("agent_settled")?.[0];
    assert.ok(settle);
    if (stale) await assert.doesNotReject(async () => settle({}, context.ctx), "stale presentation must be contained");
    else
      await assert.rejects(
        async () => settle({}, context.ctx),
        (error: unknown) => error === failure,
      );
    await settle({}, context.ctx);
    const state = mock.entries.at(-1)?.data as { enabled: boolean; latestPlan?: string };
    assert.equal(state.enabled, true);
    assert.equal(state.latestPlan, "# Keep this plan");
    assert.equal(presentations, 1, "presentation must run once and not repeat");
  });
}
