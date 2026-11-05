/** Plan-mode runtime boundaries for editing a ready or saved plan. */
import assert from "node:assert/strict";
import { test } from "vitest";
import { formatTransferredPlanPrompt } from "../src/fresh-implementation.js";
import { PLAN_APPROVAL_ENTRY_TYPE } from "../src/plan-approval.js";
import { PLAN_EDIT_MESSAGE_TYPE, PLAN_EDIT_SOURCE } from "../src/plan-edit.js";
import planMode from "../src/plan-mode.js";
import { restorePlanModeState } from "../src/state.js";
import { createMockContext, createMockPi } from "./support.js";

const PLAN = "# Original\n\n- Keep the first step.";
const EDITED = "# Original\n\n- Keep the edited step.";
const MISSING_SETTINGS = { readSettings: async () => ({ kind: "missing" as const }) };
const STATE_ENTRY_TYPE = "plan-mode-state";

type Mock = ReturnType<typeof createMockPi>;

async function readyPlan(mock: Mock, ctx: unknown) {
  await mock.events.get("session_start")?.[0]?.({}, ctx);
  await mock.commands.get("plan")?.handler("start", ctx);
  const complete = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")?.execute as (
    ...args: unknown[]
  ) => Promise<unknown>;
  await complete("complete", { plan: PLAN }, undefined, undefined, ctx);
}

function latestState(mock: Mock) {
  return restorePlanModeState(
    mock.entries.map((entry) => ({ type: "custom", ...entry })),
    STATE_ENTRY_TYPE,
  );
}

function editMessages(mock: Mock) {
  return mock.sentMessages.filter(
    ({ message }) => (message as { customType?: string }).customType === PLAN_EDIT_MESSAGE_TYPE,
  );
}

/** RPC menus: choose Edit once, then close whatever reopens. */
function editingContext(editor: (title: string, prefill?: string) => Promise<string | undefined>, extra = {}) {
  let edits = 0;
  const titles: string[] = [];
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async (title: string, options: string[]) => {
      titles.push(title);
      if (edits === 0 && options.includes("Edit plan…")) {
        edits += 1;
        return "Edit plan…";
      }
      return undefined;
    },
    editor,
    ...extra,
  });
  return { context, titles };
}

test("cancelled, unchanged, empty and oversized edits leave the plan, entries and model untouched", async () => {
  for (const [result, warning] of [
    [undefined, undefined],
    [`\n${PLAN}\n`, undefined],
    ["  \n", "Edited plan rejected: plan must not be empty. The plan is unchanged."],
    ["x".repeat(50_001), "Edited plan rejected: plan must not exceed 50000 characters. The plan is unchanged."],
  ] as const) {
    const mock = createMockPi({ activeTools: ["read"] });
    planMode(mock.pi, MISSING_SETTINGS);
    const { context, titles } = editingContext(async () => result);
    await readyPlan(mock, context.ctx);
    const entries = mock.entries.length;
    await mock.commands.get("plan")?.handler("", context.ctx);

    assert.equal(titles.length, 2, "the menu reopens after the editor closes");
    assert.equal(mock.entries.length, entries);
    assert.deepEqual(editMessages(mock), []);
    assert.equal(latestState(mock).latestPlan, PLAN);
    assert.deepEqual(
      context.notifications.filter((notification) => notification.level === "warning").map(({ message }) => message),
      warning ? [warning] : [],
    );
  }
});

test("an accepted edit persists once, tells the model once and is not a decline", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, MISSING_SETTINGS);
  const prefills: Array<{ title: string; prefill?: string }> = [];
  const { context } = editingContext(async (title, prefill) => {
    prefills.push({ title, prefill });
    return EDITED;
  });
  await readyPlan(mock, context.ctx);
  const entries = mock.entries.length;
  await mock.commands.get("plan")?.handler("", context.ctx);

  assert.deepEqual(prefills, [{ title: "Edit proposed plan", prefill: PLAN }]);
  assert.equal(mock.entries.length, entries + 1);
  const restored = latestState(mock);
  assert.equal(restored.latestPlan, EDITED);
  assert.equal(restored.latestPlanSource, PLAN_EDIT_SOURCE);
  assert.equal(restored.awaitingAction, true);
  assert.equal(restored.declinedPlans, 0);
  assert.equal(restored.reproposalReview, undefined);
  const sent = editMessages(mock);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]?.options, { triggerTurn: false });
  assert.match(
    String((sent[0]?.message as { content?: string } | undefined)?.content),
    /-- Keep the first step\.\n\+- Keep the edited step\./u,
  );
  assert.ok(context.notifications.some(({ message }) => message === "Plan updated."));
});

test("Edit then Start fresh hands the fresh session only the edited plan", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, MISSING_SETTINGS);
  const destinationEntries: Array<{ customType: string; data: unknown }> = [];
  const destinationMessages: string[] = [];
  const replacementMessages: string[] = [];
  let choices = 0;
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    model: { provider: "test-provider", id: "test-model" },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const }) },
    sessionManager: { getSessionFile: () => "/sessions/planning.jsonl", getBranch: () => [], getEntries: () => [] },
    select: async (_title: string, options: string[]) => {
      choices += 1;
      if (choices === 1) return "Edit plan…";
      if (options.includes("Start fresh and implement")) return "Start fresh and implement";
      if (options.includes("Start fresh implementation")) return "Start fresh implementation";
      return undefined;
    },
    editor: async () => EDITED,
    newSession: async (options: {
      setup?: (manager: unknown) => Promise<void>;
      withSession?: (ctx: unknown) => Promise<void>;
    }) => {
      await options.setup?.({
        appendCustomEntry(customType: string, data: unknown) {
          destinationEntries.push({ customType, data });
          return "entry";
        },
        appendCustomMessageEntry(customType: string) {
          destinationMessages.push(customType);
          return "message";
        },
      });
      await options.withSession?.({
        async sendUserMessage(message: string) {
          replacementMessages.push(message);
        },
        ui: { notify() {} },
      });
      return { cancelled: false };
    },
  });
  await readyPlan(mock, context.ctx);
  await mock.commands.get("plan")?.handler("", context.ctx);

  assert.equal(editMessages(mock).length, 1, "the source session keeps its own edit record");
  assert.deepEqual(destinationMessages, ["plan-mode-transition"]);
  assert.deepEqual(
    destinationEntries
      .filter(({ customType }) => customType === PLAN_APPROVAL_ENTRY_TYPE)
      .map(({ data }) => (data as { plan?: string }).plan),
    [EDITED],
  );
  assert.doesNotMatch(JSON.stringify(destinationEntries), /Keep the first step/u);
  assert.deepEqual(replacementMessages, [formatTransferredPlanPrompt(EDITED, true)]);
});

test("an edit is discarded when the plan changes while the editor is open", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, MISSING_SETTINGS);
  let ctx: unknown;
  const { context } = editingContext(async () => {
    await mock.commands.get("plan")?.handler("exit", ctx);
    return EDITED;
  });
  ctx = context.ctx;
  await readyPlan(mock, context.ctx);
  await mock.commands.get("plan")?.handler("", context.ctx);

  assert.deepEqual(editMessages(mock), []);
  assert.equal(latestState(mock).enabled, false);
  assert.ok(
    context.notifications.some(
      ({ message }) => message === "The plan changed while the editor was open. The edit was discarded.",
    ),
  );
});

test("a failed edit record leaves the ready plan unchanged", async () => {
  for (const failure of [new Error("session closed\u001b[31m"), "session closed"]) {
    const mock = createMockPi({ activeTools: ["read"] });
    const send = mock.rawPi.sendMessage;
    mock.rawPi.sendMessage = (message: unknown, options?: unknown) => {
      if ((message as { customType?: string }).customType === PLAN_EDIT_MESSAGE_TYPE) throw failure;
      send(message, options);
    };
    planMode(mock.pi, MISSING_SETTINGS);
    const { context } = editingContext(async () => EDITED);
    await readyPlan(mock, context.ctx);
    const entries = mock.entries.length;
    await mock.commands.get("plan")?.handler("", context.ctx);

    assert.equal(mock.entries.length, entries);
    assert.equal(latestState(mock).latestPlan, PLAN);
    assert.ok(
      context.notifications.some(
        ({ message, level }) => level === "error" && message === "Unable to record the plan edit: session closed",
      ),
    );
  }
});

test("an edit after the ready chooser closed updates the plan without a live presentation", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, MISSING_SETTINGS);
  let menus = 0;
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async (_title: string, options: string[]) => {
      menus += 1;
      return menus === 2 && options.includes("Edit plan…") ? "Edit plan…" : undefined;
    },
    editor: async () => EDITED,
  });
  await readyPlan(mock, context.ctx);
  await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
  assert.equal(menus, 1, "the automatic chooser opened and closed with no action");
  await mock.commands.get("plan")?.handler("", context.ctx);

  assert.equal(menus, 3);
  assert.equal(latestState(mock).latestPlan, EDITED);
  assert.equal(editMessages(mock).length, 1);
});

test("an edit that finds no plan opens no editor", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, MISSING_SETTINGS);
  let editors = 0;
  let menus = 0;
  let ctx: unknown;
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async () => {
      menus += 1;
      if (menus > 1) return undefined;
      // A user-started run clears the ready plan while this menu is still open.
      await mock.events.get("before_agent_start")?.[0]?.({ messageType: "user" }, ctx);
      return "Edit plan…";
    },
    editor: async () => {
      editors += 1;
      return EDITED;
    },
  });
  ctx = context.ctx;
  await readyPlan(mock, context.ctx);
  await mock.commands.get("plan")?.handler("", context.ctx);

  assert.equal(editors, 0);
  assert.equal(latestState(mock).latestPlan, undefined);
  assert.deepEqual(editMessages(mock), []);
});

test("a saved plan edit is restored and implemented later with its edited text", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, MISSING_SETTINGS);
  const prefills: Array<{ title: string; prefill?: string }> = [];
  const { context } = editingContext(
    async (title, prefill) => {
      prefills.push({ title, prefill });
      return EDITED;
    },
    {
      model: { provider: "test-provider", id: "test-model" },
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const }) },
    },
  );
  await readyPlan(mock, context.ctx);
  await mock.commands.get("plan")?.handler("save", context.ctx);
  await mock.commands.get("plan")?.handler("", context.ctx);

  assert.deepEqual(prefills, [{ title: "Edit saved plan", prefill: PLAN }]);
  assert.deepEqual(latestState(mock).savedPlan, { plan: EDITED, source: PLAN_EDIT_SOURCE });
  assert.equal(editMessages(mock).length, 1);

  // A fresh extension instance restores the edited saved plan from the persisted branch.
  const resumed = createMockPi({ activeTools: ["read"] });
  planMode(resumed.pi, MISSING_SETTINGS);
  const branch = mock.entries.map((entry) => ({ type: "custom", ...entry }));
  const resumedContext = createMockContext({
    mode: "rpc",
    hasUI: true,
    model: { provider: "test-provider", id: "test-model" },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const }) },
    sessionManager: {
      getSessionId: () => "resumed",
      getSessionName: () => undefined,
      getBranch: () => branch,
      getEntries: () => branch,
    },
  });
  await resumed.events.get("session_start")?.[0]?.({}, resumedContext.ctx);
  await resumed.commands.get("plan")?.handler("implement", resumedContext.ctx);
  assert.deepEqual(
    resumed.sentUserMessages.map(({ text }) => text),
    [formatTransferredPlanPrompt(EDITED, false)],
  );
});

test("an edit is refused when a run starts while the editor is open", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, MISSING_SETTINGS);
  let idle = true;
  const { context } = editingContext(
    async () => {
      idle = false;
      return EDITED;
    },
    { isIdle: () => idle },
  );
  await readyPlan(mock, context.ctx);
  const entries = mock.entries.length;
  await mock.commands.get("plan")?.handler("", context.ctx);

  assert.equal(mock.entries.length, entries);
  assert.deepEqual(editMessages(mock), []);
  assert.equal(latestState(mock).latestPlan, PLAN);
  assert.ok(
    context.notifications.some(
      ({ message, level }) =>
        level === "warning" &&
        message === "Cannot edit the plan while an agent run is active. Wait for the run to settle, then retry.",
    ),
  );
});
