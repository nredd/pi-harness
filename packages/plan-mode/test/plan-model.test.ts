import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import planMode from "../src/plan-mode.js";
import {
  availablePlanModelTiers,
  normalizePlanModelTier,
  PLAN_MODEL_TIER_REQUIRED,
  planModelTarget,
} from "../src/plan-model.js";
import {
  normalizePlanModeSettings,
  type PlanModeSettings,
  readPlanModeSettings,
  updatePlanModeSettings,
} from "../src/settings.js";
import { showPlanModeSettings } from "../src/settings-menu.js";
import { type PlanModelSwitch, restorePlanModeState } from "../src/state.js";
import { AGENT_WORKFLOW_GROUP, WORKFLOW_MUTEX_CHANNEL } from "../src/workflow-mutex.js";
import { builtinTool, createMockContext, createMockPi } from "./support.js";

type TestModel = { provider: string; id: string; name?: string };

const STATE_ENTRY_TYPE = "plan-mode-state";
const PREVIOUS: TestModel = { provider: "anthropic", id: "claude-sonnet-5-5" };
const DEEP: TestModel = { provider: "router", id: "deep" };
const DEFAULT: TestModel = { provider: "router", id: "default" };
const PLAN = "# Plan\n\n1. Do the thing.";

test("planModel accepts only router tier references", () => {
  assert.equal(normalizePlanModelTier("@deep"), "@deep");
  assert.equal(normalizePlanModelTier("  @frontier.v2_x-1 "), "@frontier.v2_x-1");
  for (const invalid of [
    "deep",
    "router/deep",
    "@router/deep",
    "@Deep",
    "@",
    "@-deep",
    "anthropic/claude-opus-5-5",
    `@${"a".repeat(512)}`,
    42,
    undefined,
  ]) {
    assert.equal(normalizePlanModelTier(invalid), undefined, String(invalid));
  }
  assert.deepEqual(planModelTarget("@deep"), { provider: "router", modelId: "deep" });
  assert.deepEqual(availablePlanModelTiers([PREVIOUS, DEEP, { provider: "router", id: "Bad Id" }, DEFAULT]), [
    "@deep",
    "@default",
  ]);
});

test("planModel settings validate, save and clear like the other model settings", async () => {
  assert.equal(normalizePlanModeSettings({ planModel: "@deep" })?.planModel, "@deep");
  assert.equal(normalizePlanModeSettings({ planModel: { provider: "router", modelId: "deep" } }), undefined);
  assert.equal(normalizePlanModeSettings({ planModel: "anthropic/claude-opus-5-5" }), undefined);
  assert.equal(normalizePlanModeSettings({})?.planModel, undefined);

  const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-plan-model-"));
  const settingsPath = join(directory, "pi-plan-mode.json");
  try {
    await writeFile(settingsPath, '{"unknown":true}\n');
    assert.equal((await updatePlanModeSettings({ planModel: "@deep" }, { settingsPath })).planModel, "@deep");
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { unknown: true, planModel: "@deep" });
    await assert.rejects(
      updatePlanModeSettings({ planModel: "router/deep" as never }, { settingsPath }),
      (error: Error) => error.message.endsWith(PLAN_MODEL_TIER_REQUIRED),
    );
    assert.equal((await updatePlanModeSettings({ planModel: null }, { settingsPath })).planModel, undefined);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { unknown: true });
    for (const planModel of [
      '"router/deep"',
      '"anthropic/claude-opus-5-5"',
      '{"provider":"router","modelId":"deep"}',
    ]) {
      await writeFile(settingsPath, `{"planModel":${planModel}}\n`);
      assert.deepEqual(await readPlanModeSettings(settingsPath), { kind: "invalid", reason: PLAN_MODEL_TIER_REQUIRED });
    }
    await writeFile(settingsPath, '{"planModel":"@deep","thinkingLevel":"loud"}\n');
    assert.deepEqual(await readPlanModeSettings(settingsPath), { kind: "invalid", reason: "invalid settings shape" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Plan model switch state restores only while Plan is active and well formed", () => {
  const modelSwitch: PlanModelSwitch = {
    applied: { provider: "router", modelId: "deep" },
    previous: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
    thinkingBefore: "medium",
    thinkingAfter: "medium",
  };
  const restore = (enabled: boolean, planModelSwitch: unknown) =>
    restorePlanModeState(
      [{ type: "custom", customType: STATE_ENTRY_TYPE, data: { enabled, planModelSwitch } }],
      STATE_ENTRY_TYPE,
    ).planModelSwitch;
  assert.deepEqual(restore(true, modelSwitch), modelSwitch);
  assert.equal(restore(false, modelSwitch), undefined);
  for (const invalid of [
    "router/deep",
    { ...modelSwitch, applied: { provider: "router", modelId: "deep", extra: true } },
    { ...modelSwitch, previous: { provider: "", modelId: "x" } },
    { ...modelSwitch, previous: "anthropic/claude-sonnet-5-5" },
    { ...modelSwitch, thinkingBefore: "inherit" },
    { ...modelSwitch, thinkingAfter: undefined },
  ]) {
    assert.equal(restore(true, invalid), undefined);
  }
});

/**
 * Picks Start fresh in the Plan menu, picks `model` on its Model screen, then starts;
 * `modelChoices` records the Model screen's rows.
 */
function startFreshOnce(modelChoices: string[], model: string) {
  const picks = ["Start fresh and implement", "Model", "", "Start fresh implementation"];
  return async (_title: string, options: string[]) => {
    const pick = picks[0];
    if (pick === "") {
      modelChoices.push(...options);
      picks.shift();
      return model;
    }
    return pick && options.includes(pick) ? picks.shift() : undefined;
  };
}

function createModelHost(
  options: {
    settings?: Partial<PlanModeSettings>;
    model?: TestModel;
    catalogue?: TestModel[];
    thinkingLevel?: string;
    /** Thinking level Pi selects when switching to each model; absent keeps the current level. */
    switchThinking?: Record<string, string>;
    clampThinkingLevel?: (level: string) => string;
    branch?: unknown[];
    select?: (title: string, options: string[]) => Promise<string | undefined>;
  } = {},
) {
  let current: TestModel | undefined = "model" in options ? options.model : PREVIOUS;
  const mock = createMockPi({
    activeTools: ["read"],
    thinkingLevel: options.thinkingLevel ?? "medium",
    clampThinkingLevel: options.clampThinkingLevel,
  });
  let catalogue = options.catalogue ?? [PREVIOUS, DEEP, DEFAULT];
  const registry = {
    find: (provider: string, id: string) => catalogue.find((model) => model.provider === provider && model.id === id),
    getApiKeyAndHeaders: async (_model: TestModel): Promise<{ ok: boolean; error?: string }> => ({ ok: true }),
    getAvailable: () => catalogue,
  };
  /** What the fresh session's setup received, set by the `newSession` stand-in. */
  const fresh: { entries: Array<{ customType: string; data: unknown }>; messages: string[] } = {
    entries: [],
    messages: [],
  };
  const context = createMockContext({
    // RPC drives menus through `select`, like the fresh-implementation session tests.
    mode: options.select ? "rpc" : "tui",
    hasUI: true,
    modelRegistry: registry,
    select: options.select,
    sessionManager: {
      getSessionId: () => "plan-model-session",
      getSessionFile: () => "/sessions/planning.jsonl",
      getBranch: () => options.branch ?? [],
      getEntries: () => options.branch ?? [],
    },
    /** Pi's order: the source shuts down, then the fresh session is set up and kicked off. */
    newSession: async (newSessionOptions: {
      setup?: (manager: unknown) => Promise<void>;
      withSession?: (ctx: unknown) => Promise<void>;
    }) => {
      await emit("session_shutdown", { reason: "new" });
      await newSessionOptions.setup?.({
        appendCustomMessageEntry: () => "contract",
        appendCustomEntry: (customType: string, data: unknown) => {
          fresh.entries.push({ customType, data });
          return "entry";
        },
      });
      await newSessionOptions.withSession?.({
        sessionManager: { getBranch: () => [] },
        ui: { notify: () => undefined },
        sendUserMessage: async (message: string) => {
          fresh.messages.push(message);
        },
      });
      return { cancelled: false };
    },
  });
  Object.defineProperty(context.ctx, "model", { get: () => current, configurable: true });

  const emit = async (name: string, event: unknown) => {
    for (const handler of mock.events.get(name) ?? []) await handler(event, context.ctx);
  };
  /** What Pi's `setModel` does: switch, re-select thinking for the model, emit both events. */
  const piSetModel = async (model: TestModel) => {
    mock.setModels.push(model);
    const previousModel = current;
    current = model;
    const previousLevel = mock.rawPi.getThinkingLevel();
    const level = options.switchThinking?.[`${model.provider}/${model.id}`];
    if (level !== undefined) {
      mock.rawPi.setThinkingLevel(level);
      await emit("thinking_level_select", { level: mock.rawPi.getThinkingLevel(), previousLevel });
    }
    await emit("model_select", { model, previousModel, source: "set" });
    return true;
  };
  mock.rawPi.setModel = piSetModel as never;
  planMode(mock.pi, {
    readSettings: async () => ({
      kind: "loaded" as const,
      settings: { thinkingLevel: "inherit", planModel: "@deep", ...options.settings } as PlanModeSettings,
    }),
  });

  return {
    mock,
    context,
    fresh,
    registry,
    piSetModel,
    get current() {
      return current;
    },
    setCatalogue(models: TestModel[]) {
      catalogue = models;
    },
    async sessionStart(reason = "startup") {
      await emit("session_start", { reason });
    },
    async plan(args: string) {
      await mock.commands.get("plan")?.handler(args, context.ctx);
    },
    /** Pi awaits this before every run; the Plan model switch has settled once it returns. */
    async beforeAgentStart() {
      await emit("before_agent_start", { prompt: "go", systemPrompt: "" });
    },
    async completePlan() {
      const complete = mock.tools.find((tool) => tool.name === "plan_mode_complete")?.execute as (
        ...args: unknown[]
      ) => Promise<unknown>;
      await complete("complete", { plan: PLAN }, undefined, undefined, context.ctx);
    },
    async userSelectsModel(model: TestModel) {
      const previousModel = current;
      current = model;
      await emit("model_select", { model, previousModel, source: "set" });
    },
    async userSelectsThinking(level: string) {
      const previousLevel = mock.rawPi.getThinkingLevel();
      mock.rawPi.setThinkingLevel(level);
      await emit("thinking_level_select", { level, previousLevel });
    },
    async shutdown() {
      await emit("session_shutdown", { reason: "reload" });
    },
    latestState() {
      return mock.entries.filter((entry) => entry.customType === STATE_ENTRY_TYPE).at(-1)?.data as
        | { enabled?: boolean; planModelSwitch?: PlanModelSwitch; manualThinkingLevel?: string }
        | undefined;
    },
    warnings() {
      return context.notifications.filter((notification) => notification.level === "warning").map((n) => n.message);
    },
  };
}

for (const exit of ["exit", "save", "implement"] as const) {
  test(`Plan turns run on the tier and ${exit} restores the previous model and thinking`, async () => {
    const host = createModelHost({ switchThinking: { "router/deep": "low", "anthropic/claude-sonnet-5-5": "medium" } });
    await host.sessionStart();
    await host.plan("start");
    await host.beforeAgentStart();

    assert.deepEqual(host.current, DEEP);
    assert.equal(host.mock.thinkingLevel, "medium", "Pi's per-model default does not replace inherited thinking");
    assert.deepEqual(host.latestState()?.planModelSwitch, {
      applied: { provider: "router", modelId: "deep" },
      previous: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
      thinkingBefore: "medium",
      thinkingAfter: "medium",
    });

    if (exit !== "exit") await host.completePlan();
    await host.plan(exit);
    await host.beforeAgentStart();

    assert.deepEqual(host.current, PREVIOUS);
    assert.equal(host.mock.thinkingLevel, "medium");
    assert.deepEqual(host.mock.setModels, [DEEP, PREVIOUS]);
    assert.equal(host.latestState()?.planModelSwitch, undefined);
    if (exit === "implement") assert.match(host.mock.sentUserMessages.at(-1)?.text ?? "", /Implement the plan/);
    assert.deepEqual(host.warnings(), []);
  });
}

test("a fixed Plan thinking level survives the switch, clamps to the tier and restores on exit", async () => {
  const host = createModelHost({
    settings: { thinkingLevel: "xhigh" },
    switchThinking: { "router/deep": "low" },
    clampThinkingLevel: (level) => (level === "xhigh" && host.current === DEEP ? "high" : level),
  });
  await host.sessionStart();
  await host.plan("start");
  await host.beforeAgentStart();

  assert.deepEqual(host.current, DEEP);
  assert.equal(host.mock.thinkingLevel, "high");
  assert.equal(host.latestState()?.manualThinkingLevel, undefined, "switch-time thinking events are not manual");
  assert.equal(host.latestState()?.planModelSwitch?.thinkingAfter, "high");

  await host.plan("exit");
  await host.beforeAgentStart();
  assert.deepEqual(host.current, PREVIOUS);
  assert.equal(host.mock.thinkingLevel, "medium");
});

test("manual /model and thinking changes during Plan survive exit", async () => {
  const host = createModelHost();
  await host.sessionStart();
  await host.plan("start");
  await host.beforeAgentStart();
  await host.userSelectsModel(DEEP);
  assert.ok(host.latestState()?.planModelSwitch, "re-selecting the Plan model is not a manual change");

  await host.userSelectsModel(DEFAULT);
  assert.equal(host.latestState()?.planModelSwitch, undefined);
  await host.plan("exit");
  await host.beforeAgentStart();
  assert.deepEqual(host.current, DEFAULT);
  assert.deepEqual(host.mock.setModels, [DEEP]);

  const thinking = createModelHost();
  await thinking.sessionStart();
  await thinking.plan("start");
  await thinking.beforeAgentStart();
  await thinking.userSelectsThinking("high");
  await thinking.plan("exit");
  await thinking.beforeAgentStart();
  assert.deepEqual(thinking.current, PREVIOUS);
  assert.equal(thinking.mock.thinkingLevel, "high");
});

test("unusable tiers warn once and Plan still starts on the current model", async () => {
  const cases: Array<{
    name: string;
    configure(host: ReturnType<typeof createModelHost>): void;
    warning?: RegExp;
    model?: TestModel;
  }> = [
    {
      name: "missing",
      configure: (host) => host.setCatalogue([PREVIOUS]),
      warning: /^Plan model @deep \(router\/deep\) is no longer available; using the current model\.$/,
    },
    {
      name: "unauthenticated",
      configure: (host) => {
        host.registry.getApiKeyAndHeaders = async () => ({ ok: false, error: "no key" });
      },
      warning: /could not be authenticated: no key; using the current model\./,
    },
    {
      name: "authentication throwing",
      configure: (host) => {
        host.registry.getApiKeyAndHeaders = async () => {
          throw new Error("keychain locked");
        };
      },
      warning: /could not be authenticated: keychain locked; using the current model\./,
    },
    {
      name: "refused",
      configure: (host) => {
        host.mock.rawPi.setModel = async () => false;
      },
      warning: /could not be applied; using the current model\./,
    },
    {
      name: "switch throwing",
      configure: (host) => {
        host.mock.rawPi.setModel = async () => {
          throw new Error("No API key for router/deep");
        };
      },
      warning: /could not be applied: No API key for router\/deep; using the current model\./,
    },
    {
      name: "throwing",
      configure: (host) => {
        host.registry.find = () => {
          throw new Error("registry exploded");
        };
      },
      warning: /could not be resolved: registry exploded; using the current model\./,
    },
    {
      name: "throwing a non-Error",
      configure: (host) => {
        host.registry.find = () => {
          throw "registry offline";
        };
      },
      warning: /could not be resolved: registry offline; using the current model\./,
    },
    { name: "no current model", configure: () => undefined, model: undefined },
    { name: "already on the tier", configure: () => undefined, model: DEEP },
  ];
  for (const scenario of cases) {
    const host = createModelHost("model" in scenario ? { model: scenario.model } : {});
    scenario.configure(host);
    await host.sessionStart();
    await host.plan("start");
    await host.beforeAgentStart();
    await host.plan("exit");
    await host.beforeAgentStart();

    assert.equal(host.mock.setModels.length, 0, scenario.name);
    assert.deepEqual(host.current, "model" in scenario ? scenario.model : PREVIOUS, scenario.name);
    const warnings = host.warnings();
    if (scenario.warning) {
      assert.equal(warnings.length, 1, scenario.name);
      assert.match(warnings[0] ?? "", scenario.warning, scenario.name);
    } else {
      assert.deepEqual(warnings, [], scenario.name);
    }
  }
});

test("reload keeps Plan on the tier and the restored state still restores on exit", async () => {
  const first = createModelHost();
  await first.sessionStart();
  await first.plan("start");
  await first.beforeAgentStart();
  await first.shutdown();
  assert.deepEqual(first.current, DEEP, "shutdown does not write a model change into the session");

  const branch = first.mock.entries.map((entry) => ({ type: "custom", ...entry }));
  const reloaded = createModelHost({ model: DEEP, branch });
  await reloaded.sessionStart("reload");
  await reloaded.beforeAgentStart();
  assert.deepEqual(reloaded.current, DEEP);
  assert.deepEqual(reloaded.mock.setModels, []);

  await reloaded.plan("exit");
  await reloaded.beforeAgentStart();
  assert.deepEqual(reloaded.current, PREVIOUS);

  const resumedElsewhere = createModelHost({ model: DEFAULT, branch });
  await resumedElsewhere.sessionStart("resume");
  await resumedElsewhere.plan("exit");
  await resumedElsewhere.beforeAgentStart();
  assert.deepEqual(resumedElsewhere.current, DEFAULT, "a session model that differs from the switch is kept");
  assert.deepEqual(resumedElsewhere.mock.setModels, []);
});

test("a workflow mutex refusal changes no model", async () => {
  const host = createModelHost();
  host.mock.eventBus.on(WORKFLOW_MUTEX_CHANNEL, (payload) => {
    const attempt = payload as { group?: string; busy?: boolean };
    if (attempt.group === AGENT_WORKFLOW_GROUP) attempt.busy = true;
  });
  await host.sessionStart();
  await host.plan("start");
  await host.beforeAgentStart();
  assert.match(host.warnings().join("\n"), /Another workflow is active/);
  assert.deepEqual(host.mock.setModels, []);
  assert.deepEqual(host.current, PREVIOUS);
});

test("leaving Plan while the switch is in flight puts the previous model back", async () => {
  const host = createModelHost();
  let releaseAuth!: () => void;
  host.registry.getApiKeyAndHeaders = () =>
    new Promise((resolve) => {
      releaseAuth = () => resolve({ ok: true });
    });
  await host.sessionStart();
  await host.plan("start");
  await new Promise((resolve) => setImmediate(resolve));
  await host.plan("exit");
  releaseAuth();
  await host.beforeAgentStart();
  assert.deepEqual(host.mock.setModels, [], "an exit during authentication skips the switch");

  const inFlight = createModelHost();
  let releaseSwitch!: () => void;
  inFlight.mock.rawPi.setModel = (async (model: TestModel) => {
    if (model === DEEP) await new Promise<void>((resolve) => (releaseSwitch = resolve));
    return inFlight.piSetModel(model);
  }) as never;
  await inFlight.sessionStart();
  await inFlight.plan("start");
  await new Promise((resolve) => setImmediate(resolve));
  await inFlight.plan("exit");
  await inFlight.plan("start");
  await inFlight.plan("exit");
  releaseSwitch();
  await inFlight.beforeAgentStart();
  assert.deepEqual(
    inFlight.mock.setModels,
    [DEEP, PREVIOUS],
    "the stale switch is reverted and the stale queued start skipped",
  );
  assert.deepEqual(inFlight.current, PREVIOUS);
  assert.equal(inFlight.latestState()?.planModelSwitch, undefined);
});

test("a failed restore warns, keeps the tier and still restores thinking", async () => {
  const cases: Array<{ name: string; configure(host: ReturnType<typeof createModelHost>): void; warning: RegExp }> = [
    {
      name: "missing",
      configure: (host) => host.setCatalogue([DEEP]),
      warning: /^Previous model anthropic\/claude-sonnet-5-5 is no longer available; Pi stays on router\/deep\.$/,
    },
    {
      name: "refused",
      configure: (host) => {
        host.mock.rawPi.setModel = async () => false;
      },
      warning: /^Previous model anthropic\/claude-sonnet-5-5 could not be applied; Pi stays on router\/deep\.$/,
    },
    {
      name: "switch throwing",
      configure: (host) => {
        host.mock.rawPi.setModel = async () => {
          throw new Error("No API key for anthropic");
        };
      },
      warning: /could not be applied: No API key for anthropic; Pi stays on router\/deep/,
    },
    {
      name: "unauthenticated",
      configure: (host) => {
        host.registry.getApiKeyAndHeaders = async () => ({ ok: false, error: "expired" });
      },
      warning: /could not be authenticated: expired; Pi stays on router\/deep/,
    },
    {
      name: "throwing",
      configure: (host) => {
        host.registry.find = () => {
          throw new Error("registry exploded");
        };
      },
      warning: /could not be resolved: registry exploded; Pi stays on router\/deep/,
    },
    {
      name: "throwing a non-Error",
      configure: (host) => {
        host.registry.find = () => {
          throw "registry offline";
        };
      },
      warning: /could not be resolved: registry offline; Pi stays on router\/deep/,
    },
  ];
  for (const scenario of cases) {
    const host = createModelHost({ settings: { thinkingLevel: "high" }, switchThinking: { "router/deep": "low" } });
    await host.sessionStart();
    await host.plan("start");
    await host.beforeAgentStart();
    assert.equal(host.mock.thinkingLevel, "high", scenario.name);
    scenario.configure(host);
    await host.plan("exit");
    await host.beforeAgentStart();
    assert.deepEqual(host.current, DEEP, scenario.name);
    assert.equal(host.mock.thinkingLevel, "medium", scenario.name);
    assert.match(host.warnings().at(-1) ?? "", scenario.warning, scenario.name);
  }

  const unchanged = createModelHost();
  await unchanged.sessionStart();
  await unchanged.plan("start");
  await unchanged.beforeAgentStart();
  unchanged.setCatalogue([DEEP]);
  await unchanged.plan("exit");
  await unchanged.beforeAgentStart();
  assert.equal(unchanged.mock.thinkingLevel, "medium");
  assert.deepEqual(unchanged.mock.thinkingLevels, [], "an unchanged thinking level is not re-set");
});

test("a failed Implement-here handoff re-applies the Plan model", async () => {
  const host = createModelHost();
  await host.sessionStart();
  await host.plan("start");
  await host.beforeAgentStart();
  await host.completePlan();
  host.mock.rawPi.sendUserMessage = () => {
    throw new Error("handoff failed");
  };
  await host.plan("implement");
  await host.beforeAgentStart();

  assert.equal(host.latestState()?.enabled, true);
  assert.deepEqual(host.current, DEEP);
  assert.deepEqual(host.mock.setModels, [DEEP, PREVIOUS, DEEP]);
  assert.ok(host.latestState()?.planModelSwitch);
});

test("a failed Implement-here handoff keeps a fixed Plan thinking level", async () => {
  const host = createModelHost({ settings: { thinkingLevel: "xhigh" } });
  await host.sessionStart();
  await host.plan("start");
  await host.beforeAgentStart();
  assert.equal(host.mock.thinkingLevel, "xhigh");
  await host.completePlan();
  host.mock.rawPi.sendUserMessage = () => {
    throw new Error("handoff failed");
  };
  await host.plan("implement");
  await host.beforeAgentStart();

  assert.deepEqual(host.current, DEEP);
  assert.equal(host.mock.thinkingLevel, "xhigh", "the queued restore does not leave Plan on the previous thinking");
  assert.equal(host.latestState()?.planModelSwitch?.thinkingBefore, "xhigh");

  await host.plan("exit");
  await host.beforeAgentStart();
  assert.deepEqual(host.current, PREVIOUS);
  assert.equal(host.mock.thinkingLevel, "medium");
});

for (const freshModel of [undefined, DEFAULT]) {
  const name = freshModel ? "Fresh model" : "the pre-Plan model";
  test(`Start fresh implements on ${name} and restores the source session`, async () => {
    const screens: string[] = [];
    const host = createModelHost({
      settings: {
        thinkingLevel: "high",
        ...(freshModel
          ? { defaultImplementationModel: { provider: freshModel.provider, modelId: freshModel.id } }
          : {}),
      },
      switchThinking: { "router/deep": "low" },
      select: startFreshOnce(screens, freshModel ? "default [router]" : "Previous model"),
    });
    await host.sessionStart();
    await host.plan("start");
    await host.beforeAgentStart();
    await host.completePlan();
    assert.deepEqual(host.current, DEEP);
    assert.equal(host.mock.thinkingLevel, "high");

    await host.plan("");

    const destination = host.fresh.entries.find((entry) => entry.customType === STATE_ENTRY_TYPE)?.data as
      | { pendingImplementationRuntime?: { model?: unknown; thinkingLevel?: string } }
      | undefined;
    const implementedOn = freshModel ?? PREVIOUS;
    assert.deepEqual(destination?.pendingImplementationRuntime?.model, {
      provider: implementedOn.provider,
      modelId: implementedOn.id,
    });
    assert.equal(host.fresh.messages.length, 1, "the fresh session was kicked off");
    // The default row names the model the fresh session runs on, never the tier.
    assert.equal(screens[0], "Previous model");
    assert.ok(screens.includes("✓ claude-sonnet-5-5 [anthropic] · default"), screens.join("\n"));
    assert.ok(screens.includes("deep [router]"), "the tier stays an explicit choice");
    assert.deepEqual(host.current, PREVIOUS, "the source session is back on the model Plan started from");
    assert.equal(host.mock.thinkingLevel, "medium");
    assert.deepEqual(host.mock.setModels, [DEEP, PREVIOUS]);
    assert.equal(host.latestState()?.enabled, true, "the source plan stays resumable");
    assert.equal(host.latestState()?.planModelSwitch, undefined);
    assert.deepEqual(host.warnings(), []);
  });
}

test("Start fresh after a manual /model keeps the user's model as the plan model", async () => {
  const screens: string[] = [];
  const host = createModelHost({ select: startFreshOnce(screens, "Same as plan") });
  await host.sessionStart();
  await host.plan("start");
  await host.beforeAgentStart();
  await host.completePlan();
  await host.userSelectsModel(DEFAULT);
  await host.plan("");

  const destination = host.fresh.entries.find((entry) => entry.customType === STATE_ENTRY_TYPE)?.data as
    | { pendingImplementationRuntime?: { model?: unknown } }
    | undefined;
  assert.deepEqual(destination?.pendingImplementationRuntime?.model, { provider: "router", modelId: "default" });
  assert.equal(screens[0], "Same as plan");
  assert.ok(screens.includes("✓ default [router] · default"), screens.join("\n"));
  assert.deepEqual(host.current, DEFAULT);
  assert.deepEqual(host.mock.setModels, [DEEP]);
});

test("Plan model settings offer router tiers and fall back to inherit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-plan-model-menu-"));
  const settingsPath = join(directory, "pi-plan-mode.json");
  const tui = createTuiHarness({ width: 100, rows: 30 });
  const context = createMockContext({
    cwd: directory,
    mode: "tui",
    hasUI: true,
    custom: tui.custom,
    modelRegistry: { getAvailable: () => [PREVIOUS, DEEP, DEFAULT] },
  });
  const saved: PlanModeSettings[] = [];
  const open = (overrides: Partial<Parameters<typeof showPlanModeSettings>[1]> = {}) =>
    showPlanModeSettings(context.ctx, {
      ...overrides,
      settingsPath,
      tools: [builtinTool("read")] as ToolInfo[],
      signal: new AbortController().signal,
      isCurrent: () => true,
      onSaved: (settings) => saved.push(settings),
    });
  const openPlanModel = async () => {
    await tui.waitForOpen();
    tui.press("tui.select.up");
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
  };
  try {
    await writeFile(settingsPath, '{"planModel":"@frontier"}\n');
    let running = open();
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /Plan model\s+inherit · @frontier unavailable/u);
    await openPlanModel();
    let frame = tui.render().join("\n");
    assert.match(frame, /Inherit/u);
    assert.match(frame, /@deep\s+deep \[router\]/u);
    assert.match(frame, /@default/u);
    assert.doesNotMatch(frame, /claude-sonnet/u);
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    assert.equal(saved.at(-1)?.planModel, "@deep");
    assert.match(tui.render().join("\n"), /Plan model\s+@deep/u);
    assert.match(
      context.notifications.at(-1)?.message ?? "",
      /Plan model: @deep\. Applies to the next Plan workflow\./,
    );

    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    frame = tui.render().join("\n");
    assert.match(frame, /→ @deep/u, "the configured tier is preselected");
    tui.press("tui.select.up");
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    assert.equal(saved.at(-1)?.planModel, undefined);
    assert.equal(Object.hasOwn(JSON.parse(await readFile(settingsPath, "utf8")), "planModel"), false);
    assert.match(tui.render().join("\n"), /Plan model\s+inherit/u);
    tui.press("ctrl+c");
    await running;

    await writeFile(settingsPath, '{"planModel":"@deep"}\n');
    running = open();
    await openPlanModel();
    assert.match(tui.render().join("\n"), /→ @deep/u);
    tui.press("ctrl+c");
    await running;

    running = open({
      updateSettings: async () => {
        throw new Error("disk full");
      },
    });
    await openPlanModel();
    tui.press("tui.select.up");
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    assert.match(context.notifications.at(-1)?.message ?? "", /previous value remains: disk full/);
    assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).planModel, "@deep");
    tui.press("ctrl+c");
    await running;
  } finally {
    tui.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
