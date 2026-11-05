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
const KEPT = " The edit was not applied; Edit plan… reopens it while this plan is current.";

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
    ["  \n", `Edited plan rejected: plan must not be empty.${KEPT}`],
    ["x".repeat(50_001), `Edited plan rejected: plan must not exceed 50000 characters.${KEPT}`],
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
    context.notifications.some(({ message }) => message === `The plan changed while the editor was open.${KEPT}`),
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
        ({ message, level }) =>
          level === "error" && message === `Unable to record the plan edit: session closed.${KEPT}`,
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
        level === "warning" && message === `An agent run started while the editor was open.${KEPT}`,
    ),
  );
});

/** RPC `/plan` menus that pick `Edit plan…` on every open and close the reopened menu. */
function repeatEditContext(editor: (title: string, prefill?: string) => Promise<string | undefined>) {
  let opened = 0;
  return createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async (_title: string, options: string[]) => {
      opened += 1;
      return opened % 2 === 1 && options.includes("Edit plan…") ? "Edit plan…" : undefined;
    },
    editor,
  });
}

test("refused editor text reopens on the next edit of the same plan until it is saved", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, MISSING_SETTINGS);
  const tooLong = `${PLAN}\n${"x".repeat(50_000)}`;
  const results = [tooLong, undefined, EDITED, undefined];
  const prefills: Array<string | undefined> = [];
  const context = repeatEditContext(async (_title, prefill) => {
    prefills.push(prefill);
    return results.shift();
  });
  await readyPlan(mock, context.ctx);
  for (let attempt = 0; attempt < 4; attempt += 1) await mock.commands.get("plan")?.handler("", context.ctx);

  // Rejected, then cancelled (kept), then saved (cleared), then the saved plan is current.
  assert.deepEqual(prefills, [PLAN, tooLong, tooLong, EDITED]);
  assert.equal(latestState(mock).latestPlan, EDITED);
  assert.equal(editMessages(mock).length, 1);
});

test("refused editor text is dropped once the plan it was based on changes", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, MISSING_SETTINGS);
  let idle = true;
  let opened = 0;
  const results = [EDITED, undefined];
  const prefills: Array<string | undefined> = [];
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async (_title: string, options: string[]) => {
      opened += 1;
      return opened % 2 === 1 && options.includes("Edit plan…") ? "Edit plan…" : undefined;
    },
    editor: async (_title: string, prefill?: string) => {
      prefills.push(prefill);
      idle = prefills.length !== 1;
      return results.shift();
    },
    isIdle: () => idle,
  });
  await readyPlan(mock, context.ctx);
  // The first edit is refused because a run starts while the editor is open.
  await mock.commands.get("plan")?.handler("", context.ctx);
  idle = true;
  const complete = mock.tools.find((candidate) => candidate.name === "plan_mode_complete")?.execute as (
    ...args: unknown[]
  ) => Promise<unknown>;
  await complete("replacement", { plan: "# Replacement\n\n- New step." }, undefined, undefined, context.ctx);
  await mock.commands.get("plan")?.handler("", context.ctx);

  assert.deepEqual(prefills, [PLAN, "# Replacement\n\n- New step."]);
  assert.equal(latestState(mock).latestPlan, "# Replacement\n\n- New step.");
});

/** RPC context whose session branch is the mock's persisted entries, so tree moves restore real state. */
function branchBackedEditContext(mock: Mock, editor: (prefill?: string) => Promise<string | undefined>) {
  let opened = 0;
  const branch = () => mock.entries.map((entry) => ({ type: "custom", ...entry }));
  return createMockContext({
    mode: "rpc",
    hasUI: true,
    sessionManager: {
      getSessionId: () => "test-session",
      getSessionName: () => undefined,
      getBranch: branch,
      getEntries: branch,
    },
    select: async (_title: string, options: string[]) => {
      opened += 1;
      return opened % 2 === 1 && options.includes("Edit plan…") ? "Edit plan…" : undefined;
    },
    editor: async (_title: string, prefill?: string) => editor(prefill),
  });
}

const OVERSIZED = `${PLAN}\n${"x".repeat(50_000)}`;

test("a kept draft is dropped by a tree move before the next edit", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, MISSING_SETTINGS);
  const results = [OVERSIZED, undefined];
  const prefills: Array<string | undefined> = [];
  const context = branchBackedEditContext(mock, async (prefill) => {
    prefills.push(prefill);
    return results.shift();
  });
  await readyPlan(mock, context.ctx);
  await mock.commands.get("plan")?.handler("", context.ctx);
  await mock.events.get("session_tree")?.[0]?.({}, context.ctx);
  await mock.commands.get("plan")?.handler("", context.ctx);

  assert.deepEqual(prefills, [PLAN, PLAN]);
});

test("an edit refused across a tree move made while the editor was open is not kept", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, MISSING_SETTINGS);
  const prefills: Array<string | undefined> = [];
  let ctx: unknown;
  const context = branchBackedEditContext(mock, async (prefill) => {
    prefills.push(prefill);
    if (prefills.length > 1) return undefined;
    await mock.events.get("session_tree")?.[0]?.({}, ctx);
    return OVERSIZED;
  });
  ctx = context.ctx;
  await readyPlan(mock, context.ctx);
  // The tree move retires the first menu, so it does not reopen; the helper's next open only closes.
  for (let open = 0; open < 3; open += 1) await mock.commands.get("plan")?.handler("", context.ctx);

  assert.deepEqual(prefills, [PLAN, PLAN]);
  assert.ok(
    context.notifications.some(
      ({ message }) => message === "The plan changed while the editor was open. The edit was not applied.",
    ),
  );
});

test("a draft kept on the ready plan does not prefill the same text once it is saved for later", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, MISSING_SETTINGS);
  const results = [OVERSIZED, undefined];
  const prefills: Array<string | undefined> = [];
  const context = branchBackedEditContext(mock, async (prefill) => {
    prefills.push(prefill);
    return results.shift();
  });
  await readyPlan(mock, context.ctx);
  await mock.commands.get("plan")?.handler("", context.ctx);
  await mock.commands.get("plan")?.handler("save", context.ctx);
  assert.equal(latestState(mock).savedPlan?.plan, PLAN);
  await mock.commands.get("plan")?.handler("", context.ctx);

  assert.deepEqual(prefills, [PLAN, PLAN]);
});
