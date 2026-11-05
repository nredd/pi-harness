import assert from "node:assert/strict";
import { test } from "vitest";
import { MODE_CONTRACT_MESSAGE_TYPE } from "../src/mode-contract.js";
import planMode from "../src/plan-mode.js";
import { WORKFLOW_MUTEX_CHANNEL } from "../src/workflow-mutex.js";
import { createMockContext, createMockPi } from "./support.js";

type InteractiveUi = typeof import("../src/interactive-ui.js");
type Mock = ReturnType<typeof createMockPi>;
type Context = ReturnType<typeof createMockContext>;

const MISSING = async () => ({ kind: "missing" as const });

function stateEntry(data: Record<string, unknown>) {
  return { type: "custom", customType: "plan-mode-state", data };
}

/** Real interactive UI with selected menus replaced by scripted ones. */
function scriptedUi(overrides: Partial<Record<keyof InteractiveUi, (...args: never[]) => unknown>>) {
  return async () => ({ ...(await import("../src/interactive-ui.js")), ...overrides }) as InteractiveUi;
}

function lastState(mock: Mock) {
  return mock.entries.at(-1)?.data as Record<string, unknown> | undefined;
}

async function command(mock: Mock, context: Context, args: string) {
  const plan = mock.commands.get("plan");
  assert.ok(plan);
  await plan.handler(args, context.ctx);
}

async function emit(mock: Mock, name: string, event: unknown, context: Context) {
  const handler = mock.events.get(name)?.[0];
  assert.ok(handler, `${name} handler`);
  return handler(event, context.ctx);
}

async function completePlan(mock: Mock, context: Context, plan: string) {
  const execute = mock.tools.find((tool) => tool.name === "plan_mode_complete")?.execute;
  assert.equal(typeof execute, "function");
  await (execute as (...args: unknown[]) => Promise<unknown>)("call", { plan }, undefined, undefined, context.ctx);
}

function failSendMessage(mock: Mock, error: unknown) {
  mock.rawPi.sendMessage = () => {
    throw error;
  };
}

test("a ready plan stays active when its exit cannot publish the Normal contract", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, {
    readSettings: MISSING,
    loadInteractiveUi: scriptedUi({
      showReadyPlanMenu: async (_ctx: never, options: never) => {
        failSendMessage(mock, "offline");
        (options as { exit(): void }).exit();
      },
    }),
  });
  const context = createMockContext({ hasUI: true, mode: "tui" });
  await command(mock, context, "start");
  await completePlan(mock, context, "# Ready");
  await emit(mock, "agent_settled", {}, context);

  assert.deepEqual(context.notifications.at(-1), {
    message: "Unable to publish the Normal mode contract: offline",
    level: "error",
  });
  assert.equal(context.statuses.get("plan-mode"), "plan ready");
});

test("busy runs keep a saved or active implementation plan when the menu clears it", async () => {
  for (const kind of ["saved", "active"] as const) {
    let idle = true;
    const busyClear = async (_ctx: never, options: never) => {
      idle = false;
      (options as { clear(): void }).clear();
    };
    const mock = createMockPi({ activeTools: ["read"] });
    planMode(mock.pi, {
      readSettings: async () => ({
        kind: "loaded" as const,
        settings: { thinkingLevel: "inherit" as const, implementationPlanRetention: "keep" as const },
      }),
      loadInteractiveUi: scriptedUi({ showSavedPlanMenu: busyClear, showActiveImplementationMenu: busyClear }),
    });
    const context = createMockContext({ hasUI: true, mode: "tui", isIdle: () => idle });
    await emit(mock, "session_start", { reason: "startup" }, context);
    await command(mock, context, "start");
    await completePlan(mock, context, "# Keep me");
    await command(mock, context, kind === "saved" ? "save" : "implement");
    const before = lastState(mock);

    await command(mock, context, "");

    assert.match(context.notifications.at(-1)?.message ?? "", /^Cannot leave or clear Plan mode while an agent run/u);
    assert.equal(lastState(mock), before, kind);
  }
});

test("headless /plan tools explains the lock while Planning is active", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, { readSettings: MISSING });
  const context = createMockContext({ hasUI: false, mode: "print" });
  await command(mock, context, "start");

  await assert.rejects(command(mock, context, "tools"), /Plan-mode tools are locked while Planning is active/u);
});

test("headless tree moves are refused silently onto contract markers and during runtime admission", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, { readSettings: MISSING });
  let releaseAuth!: () => void;
  const authGate = new Promise<void>((resolve) => {
    releaseAuth = resolve;
  });
  const branch = [
    stateEntry({
      enabled: false,
      awaitingAction: false,
      pendingImplementationRuntime: { version: 1, model: { provider: "p", modelId: "m" } },
    }),
  ];
  const context = createMockContext({
    hasUI: false,
    sessionManager: {
      getBranch: () => branch,
      getEntries: () => branch,
      getEntry: () => ({ type: "custom_message", customType: MODE_CONTRACT_MESSAGE_TYPE }),
    },
    modelRegistry: {
      find: () => ({ provider: "p", id: "m" }),
      getApiKeyAndHeaders: async () => {
        await authGate;
        return { ok: true as const };
      },
    },
  });
  await emit(mock, "session_start", { reason: "new" }, context);
  const tree = (event: unknown) => emit(mock, "session_before_tree", event, context);
  const event = { preparation: { targetId: "marker" } };

  assert.deepEqual(await tree(event), { cancel: true });
  const input = emit(mock, "input", { text: "go", source: "rpc" }, context);
  assert.deepEqual(await tree(event), { cancel: true });
  releaseAuth();
  await input;
  assert.deepEqual(context.notifications, []);
});

test("a resumed Plan without helpers stops startup before announcing it", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  mock.rawPi.setActiveTools(["read"]);
  planMode(mock.pi, { readSettings: MISSING });
  const branch = [stateEntry({ enabled: true, awaitingAction: false })];
  const context = createMockContext({
    hasUI: true,
    mode: "tui",
    sessionManager: { getBranch: () => branch, getEntries: () => branch },
  });

  await emit(mock, "session_start", { reason: "resume" }, context);

  assert.equal(context.statuses.get("plan-mode"), undefined);
  assert.match(context.notifications.at(-1)?.message ?? "", /helper tools are unavailable/u);
});

test("re-selecting Plan's own thinking level is not a manual override", async () => {
  const mock = createMockPi({ activeTools: ["read"], thinkingLevel: "low" });
  planMode(mock.pi, {
    readSettings: async () => ({ kind: "loaded" as const, settings: { thinkingLevel: "high" as const } }),
  });
  const context = createMockContext({ hasUI: true, mode: "tui" });
  await emit(mock, "session_start", { reason: "startup" }, context);
  await command(mock, context, "start");
  const entries = mock.entries.length;

  await emit(mock, "thinking_level_select", { level: "high" }, context);
  assert.equal(mock.entries.length, entries);
  await command(mock, context, "exit");
  assert.equal(mock.thinkingLevel, "low");
});

test("agent_start from a replaced session does not flush the current session's queue", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, { readSettings: MISSING });
  let releaseAuth!: () => void;
  const authGate = new Promise<void>((resolve) => {
    releaseAuth = resolve;
  });
  const branch = [
    stateEntry({
      enabled: false,
      awaitingAction: false,
      pendingImplementationRuntime: { version: 1, model: { provider: "p", modelId: "m" } },
    }),
  ];
  const context = createMockContext({
    sessionManager: { getBranch: () => branch, getEntries: () => branch },
    modelRegistry: {
      find: () => ({ provider: "p", id: "m" }),
      getApiKeyAndHeaders: async () => {
        await authGate;
        return { ok: true as const };
      },
    },
  });
  const stale = createMockContext();
  await emit(mock, "session_start", { reason: "new" }, context);
  const leading = emit(mock, "input", { text: "implement", source: "rpc" }, context);
  const follower = emit(mock, "input", { text: "queued", source: "rpc" }, context);
  releaseAuth();
  assert.deepEqual(await Promise.all([leading, follower]), [undefined, { action: "handled" }]);

  await emit(mock, "agent_start", {}, stale);
  assert.deepEqual(mock.sentUserMessages, []);
  await emit(mock, "agent_start", {}, context);
  assert.deepEqual(
    mock.sentUserMessages.map(({ text }) => text),
    ["queued"],
  );
});

test("a settle during an open ready menu does not reopen it, and a newer plan gets its own menu", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  const opened: string[] = [];
  let context!: Context;
  planMode(mock.pi, {
    readSettings: MISSING,
    loadInteractiveUi: scriptedUi({
      showReadyPlanMenu: async (_ctx: never, options: never) => {
        opened.push((options as { planThinkingLevel: string }).planThinkingLevel);
        if (opened.length > 1) return;
        await emit(mock, "agent_settled", {}, context);
        await completePlan(mock, context, "# Second");
        await emit(mock, "agent_settled", {}, context);
      },
    }),
  });
  context = createMockContext({ hasUI: true, mode: "tui" });
  await command(mock, context, "start");
  await completePlan(mock, context, "# First");

  await emit(mock, "agent_settled", {}, context);
  assert.equal(opened.length, 2);
  await emit(mock, "agent_settled", {}, context);
  assert.equal(opened.length, 2, "a presented plan is not shown again");
  assert.equal(lastState(mock)?.latestPlan, "# Second");
});

test("a /plan prompt that cannot be sent keeps an already active Plan", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, { readSettings: MISSING });
  const context = createMockContext({ hasUI: true, mode: "tui" });
  await command(mock, context, "start");
  mock.rawPi.sendUserMessage = () => {
    throw new Error("queue closed");
  };
  const contracts = mock.sentMessages.length;

  await command(mock, context, "look again");

  assert.equal(context.notifications.at(-1)?.message, "Unable to send Plan-mode message: queue closed");
  assert.equal(context.statuses.get("plan-mode"), "plan active");
  assert.equal(mock.sentMessages.length, contracts, "no Normal contract is published");
  assert.equal(await emit(mock, "tool_call", { toolName: "read", input: {} }, context), undefined, "Plan still owns");
});

test("headless activation fails loudly when the Plan contract cannot be published", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, { readSettings: MISSING });
  const failure = new Error("transcript closed");
  failSendMessage(mock, failure);
  const context = createMockContext({ hasUI: false, mode: "print" });

  await assert.rejects(
    command(mock, context, "start"),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Cannot start Plan mode: Unable to publish the Plan mode contract: transcript closed." &&
      error.cause instanceof Error &&
      error.cause.cause === failure,
  );
  assert.equal(context.statuses.get("plan-mode"), undefined);
});

test("the toggle shortcut refuses to start over a saved plan", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, {
    readSettings: async () => ({
      kind: "loaded" as const,
      settings: { thinkingLevel: "inherit" as const, toggleShortcut: "ctrl+alt+p" as const },
    }),
  });
  const context = createMockContext({ hasUI: true, mode: "tui" });
  await emit(mock, "session_start", { reason: "startup" }, context);
  await command(mock, context, "start");
  await completePlan(mock, context, "# Later");
  await command(mock, context, "save");
  const toggle = mock.shortcuts.get("ctrl+alt+p");
  assert.ok(toggle);

  await toggle.handler(context.ctx);

  assert.match(context.notifications.at(-1)?.message ?? "", /^A plan is saved for later/u);
  assert.equal(context.statuses.get("plan-mode"), "plan saved");
});

test("restored plans without a recorded source save and implement as legacy proposals", async () => {
  for (const action of ["save", "implement"] as const) {
    const mock = createMockPi({ activeTools: ["read"] });
    planMode(mock.pi, {
      readSettings: async () => ({
        kind: "loaded" as const,
        settings: { thinkingLevel: "inherit" as const, implementationPlanRetention: "keep" as const },
      }),
    });
    const branch = [stateEntry({ enabled: true, awaitingAction: true, latestPlan: "# Restored" })];
    const context = createMockContext({
      hasUI: true,
      mode: "tui",
      sessionManager: { getSessionId: () => "restored", getBranch: () => branch, getEntries: () => branch },
    });
    await emit(mock, "session_start", { reason: "resume" }, context);

    await command(mock, context, action);

    const state = lastState(mock);
    const kept = (action === "save" ? state?.savedPlan : state?.activeImplementation) as { source?: string };
    assert.equal(kept?.source, "legacy_proposed_plan", action);
  }
});

test("save and implement keep the ready plan when the Normal contract cannot be published", async () => {
  for (const action of ["save", "implement"] as const) {
    const mock = createMockPi({ activeTools: ["read"] });
    planMode(mock.pi, { readSettings: MISSING });
    const context = createMockContext({ hasUI: true, mode: "tui" });
    await command(mock, context, "start");
    await completePlan(mock, context, "# Ready");
    failSendMessage(mock, new Error("offline"));

    await command(mock, context, action);

    assert.equal(context.notifications.at(-1)?.message, "Unable to publish the Normal mode contract: offline", action);
    assert.equal(lastState(mock)?.latestPlan, "# Ready", action);
    assert.deepEqual(mock.sentUserMessages, [], action);
  }
});

test("implementing during an active run is refused", async () => {
  let idle = true;
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, { readSettings: MISSING });
  const context = createMockContext({ hasUI: true, mode: "tui", isIdle: () => idle });
  await command(mock, context, "start");
  await completePlan(mock, context, "# Ready");
  idle = false;

  await command(mock, context, "implement");

  assert.match(context.notifications.at(-1)?.message ?? "", /^Cannot start plan implementation while an agent run/u);
  assert.equal(lastState(mock)?.enabled, true);
});

function launchHarness(options: { activeTools?: string[]; settings?: Record<string, unknown> } = {}) {
  const mock = createMockPi({ activeTools: options.activeTools ?? ["read"] });
  const launches: Record<string, unknown>[] = [];
  let onLaunch: (menu: Record<string, unknown>) => unknown = () => undefined;
  let onLoad: () => unknown = () => undefined;
  planMode(mock.pi, {
    readSettings: async () => ({
      kind: "loaded" as const,
      settings: { thinkingLevel: "inherit" as const, ...options.settings },
    }),
    loadInteractiveUi: async () => {
      await onLoad();
      return {
        ...(await import("../src/interactive-ui.js")),
        showPlanLaunchMenu: async (_ctx: unknown, menu: Record<string, unknown>) => {
          launches.push(menu);
          await onLaunch(menu);
        },
      } as unknown as InteractiveUi;
    },
  });
  const context = createMockContext({ hasUI: true, mode: "tui" });
  return {
    mock,
    context,
    launches,
    setOnLaunch(handler: typeof onLaunch) {
      onLaunch = handler;
    },
    setOnLoad(handler: typeof onLoad) {
      onLoad = handler;
    },
  };
}

test("the launch menu opens only for the current, live session", async () => {
  const harness = launchHarness();
  const { mock, context, launches } = harness;
  await emit(mock, "session_start", { reason: "startup" }, context);
  harness.setOnLoad(() => emit(mock, "session_tree", {}, context));
  await command(mock, context, "");
  assert.equal(launches.length, 0, "a tree move while the UI loads drops the menu");

  harness.setOnLoad(() => undefined);
  await emit(mock, "session_shutdown", { reason: "quit" }, context);
  await command(mock, context, "");
  assert.equal(launches.length, 0, "a shut-down session opens no menu");
});

test("launch menu actions from a closed menu do not start Plan mode", async () => {
  const harness = launchHarness();
  const { mock, context } = harness;
  await emit(mock, "session_start", { reason: "startup" }, context);
  const aborted = AbortSignal.abort();
  harness.setOnLaunch((menu) => {
    (menu.start as (signal: AbortSignal) => void)(aborted);
    (menu.startWithTools as (names: string[], signal: AbortSignal) => void)(["read"], aborted);
  });

  await command(mock, context, "");

  assert.equal(context.statuses.get("plan-mode"), undefined);
  assert.equal(mock.entries.length, 0);
});

test("starting with tools drops names that are neither available nor retained", async () => {
  const harness = launchHarness();
  const { mock, context } = harness;
  await emit(mock, "session_start", { reason: "startup" }, context);
  harness.setOnLaunch((menu) => {
    (menu.startWithTools as (names: string[], signal: AbortSignal) => void)(
      ["read", "never_registered"],
      new AbortController().signal,
    );
  });

  await command(mock, context, "");

  assert.equal(context.statuses.get("plan-mode"), "plan active");
  assert.deepEqual(lastState(mock)?.selectedToolNames, ["read"]);
});

test("the launch menu says when the active tool policy hides the Plan helpers", async () => {
  const harness = launchHarness();
  const { mock, context, launches } = harness;
  mock.rawPi.setActiveTools(["read"]);
  await emit(mock, "session_start", { reason: "startup" }, context);

  await command(mock, context, "");

  assert.equal(
    launches[0]?.statusText,
    "Status: Off — required Plan helpers are unavailable under the active tool policy.",
  );
});

test("pending tool names are sanitized for the terminal", async () => {
  const harness = launchHarness({ settings: { defaultPlanTools: ["\u0007", "left⁧right"] } });
  const { mock, context, launches } = harness;
  await emit(mock, "session_start", { reason: "startup" }, context);

  await command(mock, context, "");

  const tools = launches[0]?.tools as { name: string; label?: string; disabled?: boolean }[] | undefined;
  const labels = (tools ?? []).filter((tool) => tool.disabled).map((tool) => tool.label);
  assert.deepEqual(labels.sort(), ["(unnamed tool)", "left right"]);
});

async function activeImplementationHarness() {
  const mock = createMockPi({ activeTools: ["read"] });
  const shown: string[] = [];
  let onLoad: () => unknown = () => undefined;
  planMode(mock.pi, {
    readSettings: async () => ({
      kind: "loaded" as const,
      settings: { thinkingLevel: "inherit" as const, implementationPlanRetention: "keep" as const },
    }),
    loadInteractiveUi: async () => {
      await onLoad();
      return {
        ...(await import("../src/interactive-ui.js")),
        showActiveImplementationMenu: async () => {
          shown.push("active");
        },
        showPlanModeSettings: async () => {
          shown.push("settings");
          return { kind: "closed", reason: "close" };
        },
      } as unknown as InteractiveUi;
    },
  });
  const context = createMockContext({ hasUI: true, mode: "tui" });
  await emit(mock, "session_start", { reason: "startup" }, context);
  await command(mock, context, "start");
  await completePlan(mock, context, "# Active");
  await command(mock, context, "implement");
  assert.equal(context.statuses.get("plan-mode"), "plan implementing");
  return {
    mock,
    context,
    shown,
    setOnLoad(handler: () => unknown) {
      onLoad = handler;
    },
  };
}

test("active implementation and settings menus are dropped when the tree moves while loading", async () => {
  const { mock, context, shown, setOnLoad } = await activeImplementationHarness();
  setOnLoad(() => emit(mock, "session_tree", {}, context));

  await command(mock, context, "");
  await command(mock, context, "settings");

  assert.deepEqual(shown, []);
});

test("a shut-down session opens no active implementation menu", async () => {
  const { mock, context, shown } = await activeImplementationHarness();
  await emit(mock, "session_shutdown", { reason: "quit" }, context);

  await command(mock, context, "");

  assert.deepEqual(shown, []);
});

test("settings saved after the session moved on are not applied", async () => {
  const mock = createMockPi({ activeTools: ["read"], thinkingLevel: "low" });
  let context!: Context;
  planMode(mock.pi, {
    readSettings: MISSING,
    loadInteractiveUi: scriptedUi({
      showPlanModeSettings: async (_ctx: never, options: never) => {
        await emit(mock, "session_tree", {}, context);
        (options as { onSaved(settings: unknown): void }).onSaved({ thinkingLevel: "high" });
        return { kind: "closed", reason: "close" };
      },
    }),
  });
  context = createMockContext({ hasUI: true, mode: "tui" });
  await emit(mock, "session_start", { reason: "startup" }, context);

  await command(mock, context, "settings");
  await command(mock, context, "start");

  assert.equal(mock.thinkingLevel, "low");
});

test("the Plan menu status names an empty tool policy", async () => {
  const mock = createMockPi({ activeTools: [] });
  const statuses: string[] = [];
  planMode(mock.pi, {
    readSettings: MISSING,
    loadInteractiveUi: scriptedUi({
      showPlanModeMenu: async (_ctx: never, options: never) => {
        statuses.push((options as { statusText: string }).statusText);
      },
    }),
  });
  const context = createMockContext({ hasUI: true, mode: "tui" });
  await command(mock, context, "start");

  await command(mock, context, "");

  assert.match(statuses[0] ?? "", /Plan policy allows: none\./u);
});

test("a busy workflow silently blocks headless Plan restoration", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, { readSettings: MISSING });
  const branch = [stateEntry({ enabled: true, awaitingAction: false })];
  const sessionManager = { getSessionId: () => "busy", getBranch: () => branch, getEntries: () => branch };
  mock.eventBus.on(WORKFLOW_MUTEX_CHANNEL, (payload) => {
    const attempt = payload as { session?: object; busy?: boolean };
    if (attempt.session === sessionManager) attempt.busy = true;
  });
  const context = createMockContext({ hasUI: false, sessionManager });

  await emit(mock, "session_start", { reason: "resume" }, context);

  assert.equal(context.statuses.get("plan-mode"), undefined);
  assert.deepEqual(context.notifications, []);
});

test("a tree move onto an enabled Plan without helpers turns the current Plan off", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, { readSettings: MISSING });
  const branch: unknown[] = [];
  const context = createMockContext({
    hasUI: true,
    mode: "tui",
    sessionManager: { getSessionId: () => "tree", getBranch: () => branch, getEntries: () => branch },
  });
  await emit(mock, "session_start", { reason: "startup" }, context);
  await command(mock, context, "start");
  branch.push(stateEntry({ enabled: true, awaitingAction: false }));
  mock.rawPi.setActiveTools(["read"]);

  await emit(mock, "session_tree", {}, context);

  assert.match(context.notifications.at(-1)?.message ?? "", /helper tools are unavailable/u);
  const gate = await emit(mock, "tool_call", { toolName: "read", input: {} }, context);
  assert.equal(gate, undefined, "Plan no longer gates tools");
  assert.equal(context.statuses.get("plan-mode"), undefined);
  mock.rawPi.setActiveTools(["read", "plan_mode_question", "plan_mode_complete"]);
  await command(mock, context, "start");
  assert.equal(context.statuses.get("plan-mode"), "plan active");
});

const RUNTIME_MODEL = { provider: "runtime-provider", id: "runtime-model" };

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

function runtimeSession(runtime: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const branch = [stateEntry({ enabled: false, awaitingAction: false, pendingImplementationRuntime: runtime })];
  return createMockContext({
    sessionManager: { getSessionId: () => "runtime", getBranch: () => branch, getEntries: () => branch },
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === RUNTIME_MODEL.provider && id === RUNTIME_MODEL.id ? RUNTIME_MODEL : undefined,
      getApiKeyAndHeaders: async () => ({ ok: true as const }),
    },
    ...overrides,
  });
}

const MODEL_RUNTIME = { version: 1, model: { provider: RUNTIME_MODEL.provider, modelId: RUNTIME_MODEL.id } };

test("a session replaced before runtime application starts leaves the intent pending", async () => {
  const mock = createMockPi();
  planMode(mock.pi, { readSettings: MISSING });
  const context = runtimeSession({ version: 1, thinkingLevel: "high" });
  await emit(mock, "session_start", { reason: "new" }, context);

  const input = emit(mock, "input", { text: "go", source: "rpc" }, context);
  void emit(mock, "session_start", { reason: "new" }, createMockContext());

  assert.deepEqual(await input, { action: "handled" });
  assert.deepEqual(mock.thinkingLevels, []);
});

test("a tree move during model application suppresses its warning and keeps the intent", async () => {
  const mock = createMockPi();
  const modelGate = gate();
  const modelStarted = gate();
  mock.rawPi.setModel = async () => {
    modelStarted.open();
    await modelGate.opened;
    throw "provider offline";
  };
  planMode(mock.pi, { readSettings: MISSING });
  const context = runtimeSession(MODEL_RUNTIME);
  await emit(mock, "session_start", { reason: "new" }, context);
  const input = emit(mock, "input", { text: "go", source: "rpc" }, context);
  await modelStarted.opened;

  const tree = emit(mock, "session_tree", {}, context);
  modelGate.open();

  assert.deepEqual(await input, { action: "handled" });
  await tree;
  assert.deepEqual(context.notifications, []);
  assert.deepEqual(mock.entries, [], "the one-shot intent was not consumed");
});

test("a thrown non-Error model or thinking failure is reported as text", async () => {
  const mock = createMockPi();
  mock.rawPi.setModel = async () => {
    throw "provider offline";
  };
  mock.rawPi.setThinkingLevel = () => {
    throw "thinking locked";
  };
  planMode(mock.pi, { readSettings: MISSING });
  const context = runtimeSession({ ...MODEL_RUNTIME, thinkingLevel: "high" });
  await emit(mock, "session_start", { reason: "new" }, context);

  assert.equal(await emit(mock, "input", { text: "go", source: "rpc" }, context), undefined);

  assert.deepEqual(
    context.notifications.map(({ message }) => message),
    [
      "Implementation model runtime-provider/runtime-model could not be applied: provider offline. The destination default model will continue.",
      "Implementation thinking high could not be applied: thinking locked. The destination default will continue.",
    ],
  );
});

test("a tree move while thinking is applied leaves the runtime intent unconsumed and unannounced", async () => {
  const mock = createMockPi({ clampThinkingLevel: () => "medium" });
  let context!: Context;
  const setThinkingLevel = mock.rawPi.setThinkingLevel.bind(mock.rawPi);
  mock.rawPi.setThinkingLevel = (level) => {
    setThinkingLevel(level);
    void emit(mock, "session_tree", {}, context);
  };
  planMode(mock.pi, { readSettings: MISSING });
  context = runtimeSession({ version: 1, thinkingLevel: "high" });
  await emit(mock, "session_start", { reason: "new" }, context);
  const entries = mock.entries.length;

  assert.deepEqual(await emit(mock, "input", { text: "go", source: "rpc" }, context), { action: "handled" });

  assert.equal(mock.entries.length, entries, "the one-shot intent was not consumed");
  assert.deepEqual(context.notifications, [], "the clamp warning belongs to the replaced branch");
});

test("a non-Error persistence failure blocks the prompt and keeps the intent", async () => {
  const mock = createMockPi();
  planMode(mock.pi, { readSettings: MISSING });
  const context = runtimeSession({ version: 1, thinkingLevel: "high" });
  await emit(mock, "session_start", { reason: "new" }, context);
  let appends = 0;
  mock.rawPi.appendEntry = () => {
    appends += 1;
    throw "disk full";
  };

  assert.deepEqual(await emit(mock, "input", { text: "go", source: "rpc" }, context), { action: "handled" });

  assert.equal(appends, 2, "consume, then best-effort rollback");
  assert.match(context.notifications.at(-1)?.message ?? "", /could not be consumed: disk full\./u);
});

test("a newer session's runtime application is not cleared by an older one settling", async () => {
  const mock = createMockPi();
  planMode(mock.pi, { readSettings: MISSING });
  const authGate = gate();
  const firstStarted = gate();
  const first = runtimeSession(MODEL_RUNTIME, {
    modelRegistry: {
      find: () => RUNTIME_MODEL,
      getApiKeyAndHeaders: async () => {
        firstStarted.open();
        await authGate.opened;
        return { ok: true as const };
      },
    },
  });
  const secondGate = gate();
  const secondStarted = gate();
  const second = runtimeSession(MODEL_RUNTIME, {
    modelRegistry: {
      find: () => RUNTIME_MODEL,
      getApiKeyAndHeaders: async () => {
        secondStarted.open();
        await secondGate.opened;
        return { ok: true as const };
      },
    },
  });
  await emit(mock, "session_start", { reason: "new" }, first);
  const stale = emit(mock, "input", { text: "old", source: "rpc" }, first);
  await firstStarted.opened;
  const resumed = emit(mock, "session_start", { reason: "resume" }, second);
  await secondStarted.opened;
  authGate.open();
  assert.deepEqual(await stale, { action: "handled" });

  const before = emit(mock, "session_before_tree", { preparation: { targetId: "x" } }, second);
  assert.deepEqual(await before, { cancel: true }, "the newer application still blocks tree moves");
  secondGate.open();
  await resumed;
  assert.deepEqual(mock.setModels, [RUNTIME_MODEL]);
});

test("a prompt queued behind runtime application and recovered at shutdown is not dequeued twice", async () => {
  const mock = createMockPi();
  planMode(mock.pi, { readSettings: MISSING });
  const authGate = gate();
  const context = runtimeSession(MODEL_RUNTIME, {
    modelRegistry: {
      find: () => RUNTIME_MODEL,
      getApiKeyAndHeaders: async () => {
        await authGate.opened;
        return { ok: true as const };
      },
    },
  });
  await emit(mock, "session_start", { reason: "new" }, context);
  const leading = emit(mock, "input", { text: "lead", source: "rpc" }, context);
  const follower = emit(mock, "input", { text: "follow", source: "rpc" }, context);
  const shutdown = emit(mock, "session_shutdown", { reason: "quit" }, context);
  authGate.open();

  assert.deepEqual(await Promise.all([leading, follower]), [{ action: "handled" }, { action: "handled" }]);
  await shutdown;
  assert.deepEqual(
    mock.sentMessages.map(({ message }) => (message as { content?: unknown }).content),
    ["follow"],
  );
  assert.deepEqual(mock.sentUserMessages, []);
});

test("a long missing implementation model name is truncated in the warning", async () => {
  const mock = createMockPi();
  planMode(mock.pi, { readSettings: MISSING });
  const context = runtimeSession({ version: 1, model: { provider: "p", modelId: "m".repeat(200) } });
  await emit(mock, "session_start", { reason: "new" }, context);

  await emit(mock, "input", { text: "go", source: "rpc" }, context);

  assert.equal(
    context.notifications[0]?.message,
    `Implementation model p/${"m".repeat(157)}… is no longer available. The destination default model will continue.`,
  );
});

test("a saved plan is not implemented when a run starts during its model preflight", async () => {
  let idle = true;
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, { readSettings: MISSING });
  const context = createMockContext({
    hasUI: true,
    mode: "tui",
    isIdle: () => idle,
    model: RUNTIME_MODEL,
    modelRegistry: {
      getApiKeyAndHeaders: async () => {
        idle = false;
        return { ok: true as const };
      },
    },
  });
  await command(mock, context, "start");
  await completePlan(mock, context, "# Saved");
  await command(mock, context, "save");

  await command(mock, context, "implement");

  assert.match(context.notifications.at(-1)?.message ?? "", /^Cannot start plan implementation while an agent run/u);
  assert.deepEqual((lastState(mock)?.savedPlan as { plan?: string } | undefined)?.plan, "# Saved");
  assert.deepEqual(mock.sentUserMessages, []);
});

test("a new session's first prompt does not restore a Plan whose helpers are unavailable", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, { readSettings: MISSING });
  const branch: unknown[] = [];
  const context = createMockContext({
    hasUI: true,
    mode: "tui",
    sessionManager: { getSessionId: () => "new", getBranch: () => branch, getEntries: () => branch },
  });
  await emit(mock, "session_start", { reason: "new" }, context);
  branch.push(stateEntry({ enabled: true, awaitingAction: false }));
  mock.rawPi.setActiveTools(["read"]);

  assert.equal(await emit(mock, "input", { text: "hello", source: "interactive" }, context), undefined);

  assert.match(context.notifications.at(-1)?.message ?? "", /helper tools are unavailable/u);
  assert.equal(context.statuses.get("plan-mode"), undefined);
});

test("a Plan exit before a failed implementation's re-applied thinking runs keeps the exit", async () => {
  const mock = createMockPi({ activeTools: ["read"], thinkingLevel: "low" });
  planMode(mock.pi, {
    readSettings: async () => ({
      kind: "loaded" as const,
      settings: { thinkingLevel: "high" as const, planModel: "@deep" as const },
    }),
  });
  const authGate = gate();
  const context = createMockContext({
    hasUI: true,
    mode: "tui",
    model: RUNTIME_MODEL,
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id }),
      getApiKeyAndHeaders: async () => {
        await authGate.opened;
        return { ok: true as const };
      },
    },
  });
  await emit(mock, "session_start", { reason: "startup" }, context);
  await command(mock, context, "start");
  await completePlan(mock, context, "# Ready");
  mock.rawPi.sendUserMessage = () => {
    throw new Error("queue closed");
  };
  await command(mock, context, "implement");
  assert.equal(context.statuses.get("plan-mode"), "plan ready");

  await command(mock, context, "exit");
  authGate.open();
  await emit(mock, "before_agent_start", { messageType: "user" }, context);

  assert.equal(mock.thinkingLevel, "low");
  assert.deepEqual(mock.setModels, []);
});

test("a late prompt for a replaced session is handled once and not recovered again at its shutdown", async () => {
  const mock = createMockPi();
  planMode(mock.pi, { readSettings: MISSING });
  const authGate = gate();
  const authStarted = gate();
  const old = runtimeSession(MODEL_RUNTIME, {
    modelRegistry: {
      find: () => RUNTIME_MODEL,
      getApiKeyAndHeaders: async () => {
        authStarted.open();
        await authGate.opened;
        return { ok: true as const };
      },
    },
  });
  await emit(mock, "session_start", { reason: "new" }, old);
  const leading = emit(mock, "input", { text: "lead", source: "rpc" }, old);
  await authStarted.opened;
  await emit(mock, "session_start", { reason: "startup" }, createMockContext());
  const late = emit(mock, "input", { text: "late", source: "rpc" }, old);
  authGate.open();

  assert.deepEqual(await Promise.all([leading, late]), [{ action: "handled" }, { action: "handled" }]);
  await emit(mock, "session_shutdown", { reason: "quit" }, old);
  assert.deepEqual(mock.sentMessages, []);
  assert.deepEqual(mock.sentUserMessages, []);
});
