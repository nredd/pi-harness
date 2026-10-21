import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createPlanApproval,
  latestPlanApproval,
  PLAN_APPROVAL_ENTRY_TYPE,
  PLAN_APPROVED_EVENT,
  type PlanApprovedPayload,
} from "../src/plan-approval.js";
import planMode from "../src/plan-mode.js";
import { createMockContext, createMockPi } from "./support.js";

const PLAN = "# Widgets\n\n## Work\n- Add `alpha`\n- Wire `beta`\n";

async function completePlan(mock: ReturnType<typeof createMockPi>, ctx: unknown, plan = PLAN) {
  const complete = mock.tools.find((tool) => tool.name === "plan_mode_complete")?.execute as
    | ((...args: unknown[]) => Promise<unknown>)
    | undefined;
  assert.ok(complete);
  await complete("complete", { plan }, undefined, undefined, ctx);
}

function listen(mock: ReturnType<typeof createMockPi>) {
  const seen: PlanApprovedPayload[] = [];
  mock.eventBus.on(PLAN_APPROVED_EVENT, (data) => seen.push(data as PlanApprovedPayload));
  return seen;
}

test("implementing an approved plan in this session announces it once, verbatim", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi);
  const seen = listen(mock);
  const context = createMockContext();
  await mock.commands.get("plan")?.handler("start", context.ctx);
  await completePlan(mock, context.ctx);
  assert.equal(seen.length, 0, "a proposed plan is not an approved one");

  await mock.commands.get("plan")?.handler("implement", context.ctx);
  assert.equal(seen.length, 1);
  assert.deepEqual(
    { ...seen[0], planId: "<id>" },
    { version: 1, planId: "<id>", plan: PLAN.trim(), sessionId: "test-session" },
  );
  assert.match(seen[0]?.planId ?? "", /^[0-9a-f-]{36}$/u);

  // Recorded for resume and fresh sessions, before the Plan state entry that callers read last.
  const approvalIndex = mock.entries.findIndex((entry) => entry.customType === PLAN_APPROVAL_ENTRY_TYPE);
  assert.ok(approvalIndex >= 0);
  assert.equal((mock.entries[approvalIndex]?.data as { planId: string } | undefined)?.planId, seen[0]?.planId);
  assert.equal(mock.entries.at(-1)?.customType, "plan-mode-state");
  assert.equal(mock.sentUserMessages.length, 1, "the implementation handoff is still sent");
});

test("approval without any listener is harmless", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi);
  const context = createMockContext();
  await mock.commands.get("plan")?.handler("start", context.ctx);
  await completePlan(mock, context.ctx);
  await mock.commands.get("plan")?.handler("implement", context.ctx);
  assert.equal(mock.sentUserMessages.length, 1);
});

test("a session whose branch holds an approval announces it before the first prompt, once per plan", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi);
  const seen = listen(mock);
  const branch: unknown[] = [];
  const context = createMockContext({
    sessionManager: {
      getSessionId: () => "fresh-session",
      getSessionName: () => undefined,
      getBranch: () => branch,
      getEntries: () => branch,
    },
  });
  await mock.events.get("session_start")?.[0]?.({ reason: "new" }, context.ctx);
  assert.equal(seen.length, 0);

  // Fresh-session setup lands after session_start.
  const first = createPlanApproval(PLAN);
  branch.push({ type: "custom", customType: PLAN_APPROVAL_ENTRY_TYPE, data: first });
  const beforeAgentStart = mock.events.get("before_agent_start")?.[0];
  await beforeAgentStart?.({}, context.ctx);
  await beforeAgentStart?.({}, context.ctx);
  assert.deepEqual(seen, [{ ...first, sessionId: "fresh-session" }]);

  const second = createPlanApproval("# Revised\n\n- one\n");
  branch.push({ type: "custom", customType: PLAN_APPROVAL_ENTRY_TYPE, data: second });
  await beforeAgentStart?.({}, context.ctx);
  assert.deepEqual(
    seen.map((payload) => payload.planId),
    [first.planId, second.planId],
  );
});

test("custom starts restore late setup and announce approvals before returning, once per plan", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi);
  const seen = listen(mock);
  const branch: unknown[] = [];
  const context = createMockContext({
    sessionManager: {
      getSessionId: () => "custom-first-session",
      getSessionName: () => undefined,
      getBranch: () => branch,
      getEntries: () => branch,
    },
  });
  await mock.events.get("session_start")?.[0]?.({ reason: "new" }, context.ctx);
  assert.equal(seen.length, 0);

  // New-session setup arrives after session_start, before an extension wakes the session.
  const first = createPlanApproval(PLAN);
  branch.push(
    { type: "custom", customType: PLAN_APPROVAL_ENTRY_TYPE, data: first },
    {
      type: "custom",
      customType: "plan-mode-state",
      data: { enabled: true, awaitingAction: true, latestPlan: PLAN.trim() },
    },
  );
  const statusesAtDelivery: Array<string | undefined> = [];
  mock.eventBus.on(PLAN_APPROVED_EVENT, () => {
    // Event-bus observers swallow errors, so assert on captured state outside the callback.
    statusesAtDelivery.push(context.statuses.get("plan-mode"));
  });
  const beforeAgentStart = mock.events.get("before_agent_start")?.[0];
  assert.ok(beforeAgentStart);
  for (const content of ["notice", [{ type: "text", text: "notice" }]]) {
    await beforeAgentStart(
      {
        messageType: "custom",
        message: { role: "custom", customType: "notification", content, display: false, timestamp: 1 },
        systemPrompt: "base",
      },
      context.ctx,
    );
    assert.deepEqual(seen, [{ ...first, sessionId: "custom-first-session" }]);
    assert.equal(context.statuses.get("plan-mode"), "plan ready", "custom starts keep restored plans");
  }

  const second = createPlanApproval("# Revised\n\n- one\n");
  branch.push({ type: "custom", customType: PLAN_APPROVAL_ENTRY_TYPE, data: second });
  await beforeAgentStart({ messageType: "custom" }, context.ctx);
  assert.deepEqual(
    seen,
    [first, second].map((approval) => ({ ...approval, sessionId: "custom-first-session" })),
  );
  assert.deepEqual(statusesAtDelivery, ["plan ready", "plan ready"], "restore precedes announcement");
  await beforeAgentStart({ messageType: "user", prompt: "Revise it", systemPrompt: "base" }, context.ctx);
  assert.equal(seen.length, 2, "a subsequent user start does not repeat approval delivery");
  assert.equal(context.statuses.get("plan-mode"), "plan active", "user starts still clear ready plans");
});

test("latestPlanApproval takes the newest well-formed entry", () => {
  const good = createPlanApproval("# A");
  assert.equal(latestPlanApproval([]), undefined);
  assert.deepEqual(
    latestPlanApproval([
      { type: "custom", customType: PLAN_APPROVAL_ENTRY_TYPE, data: good },
      { type: "custom", customType: PLAN_APPROVAL_ENTRY_TYPE, data: { version: 2, planId: "x", plan: "y" } },
      { type: "custom", customType: "other", data: createPlanApproval("# B") },
    ]),
    good,
  );
});
