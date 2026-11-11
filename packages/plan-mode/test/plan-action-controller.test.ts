import assert from "node:assert/strict";
import { test } from "vitest";
import { createPlanActionController } from "../src/plan-action-controller.js";
import { createMockContext } from "./harness/support.js";

test("stale Plan actions do not load interactive UI", async () => {
  let interactiveLoads = 0;
  const controller = createPlanActionController({
    loadInteractiveUi: async () => {
      interactiveLoads += 1;
      return {} as never;
    },
    getState: () => ({ enabled: false, awaitingAction: false, declinedPlans: 0 }),
    captureLifecycle: () => ({
      signal: new AbortController().signal,
      isCurrent: () => false,
    }),
    statusText: () => "off",
    getThinkingLevel: () => "medium",
    getFreshPlanModel: (ctx) => ({
      model: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined,
      label: "same as plan",
    }),
    getSettings: () => ({ thinkingLevel: "inherit" }),
    implementationOutcome: () => "",
    getExportDestination: () => ({ configuredPath: "plan.md", resolvedPath: "/tmp/plan.md" }),
    edit: async () => undefined,
    show: () => undefined,
    finalize: () => undefined,
    implementHere: () => undefined,
    implementFresh: () => undefined,
    exportPlan: async () => false,
    settings: async () => false,
    save: () => undefined,
    stay: () => undefined,
    exitReady: () => undefined,
    clearSaved: () => undefined,
  });
  const context = createMockContext({ hasUI: true });

  await controller.showSaved(context.ctx);
  await controller.showCurrent(context.ctx);

  assert.equal(interactiveLoads, 0);
});

test("user-opened fresh actions stop after menu disposal", async () => {
  const currents: Array<() => boolean> = [];
  const invokeFresh = async (menuOptions: Record<string, unknown>, kind: "saved" | "current") => {
    const controller = new AbortController();
    if (kind === "saved") {
      await (menuOptions.implementFresh as (signal: AbortSignal) => Promise<void>)(controller.signal);
    } else {
      await (menuOptions.implementFresh as (runtime: Record<string, never>, signal: AbortSignal) => Promise<void>)(
        {},
        controller.signal,
      );
    }
    controller.abort(new DOMException("Menu closed", "AbortError"));
  };
  const controller = createPlanActionController({
    loadInteractiveUi: async () =>
      ({
        showSavedPlanMenu: (_ctx: unknown, options: Record<string, unknown>) => invokeFresh(options, "saved"),
        showPlanModeMenu: (_ctx: unknown, options: Record<string, unknown>) => invokeFresh(options, "current"),
      }) as never,
    getState: () => ({
      enabled: true,
      awaitingAction: true,
      declinedPlans: 0,
      latestPlan: "# Plan",
      latestPlanSource: "plan_mode_complete",
      workflowToolPolicy: { kind: "automatic" as const, allowedNames: [], resolved: true },
    }),
    captureLifecycle: () => ({
      signal: new AbortController().signal,
      isCurrent: () => true,
    }),
    statusText: () => "ready",
    getThinkingLevel: () => "medium",
    getFreshPlanModel: (ctx) => ({
      model: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined,
      label: "same as plan",
    }),
    getSettings: () => ({ thinkingLevel: "inherit" }),
    implementationOutcome: () => "",
    getExportDestination: () => ({ configuredPath: "plan.md", resolvedPath: "/tmp/plan.md" }),
    edit: async () => undefined,
    show: () => undefined,
    finalize: () => undefined,
    implementHere: () => undefined,
    implementFresh: (_ctx, isCurrent) => {
      currents.push(isCurrent);
    },
    exportPlan: async () => false,
    settings: async () => false,
    save: () => undefined,
    stay: () => undefined,
    exitReady: () => undefined,
    clearSaved: () => undefined,
  });
  const context = createMockContext({
    hasUI: true,
    model: { provider: "planning-provider", id: "planning-model" },
    modelRegistry: { getAvailable: () => [] },
  });

  await controller.showSaved(context.ctx);
  await controller.showCurrent(context.ctx);

  assert.deepEqual(
    currents.map((isCurrent) => isCurrent()),
    [false, false],
  );
});

test("saved-plan fresh actions use persistent defaults and fall back from missing models", async () => {
  const target = { provider: "target-provider", id: "target-model" };
  const scenarios = [
    { name: "available", availableModels: [target], scopedModels: undefined, usesTarget: true },
    { name: "missing", availableModels: [], scopedModels: undefined, usesTarget: false },
    {
      name: "stale scoped model",
      availableModels: [],
      scopedModels: [{ model: target }],
      usesTarget: false,
    },
  ];
  for (const scenario of scenarios) {
    let selectedRuntime: unknown;
    const controller = createPlanActionController({
      loadInteractiveUi: async () =>
        ({
          showSavedPlanMenu: async (_ctx: unknown, menuOptions: Record<string, unknown>) => {
            await (menuOptions.implementFresh as (signal: AbortSignal) => Promise<void>)(new AbortController().signal);
          },
        }) as never,
      getState: () => ({
        enabled: false,
        awaitingAction: false,
        declinedPlans: 0,
        savedPlan: { plan: "# Plan", source: "plan_mode_complete" },
      }),
      captureLifecycle: () => ({
        signal: new AbortController().signal,
        isCurrent: () => true,
      }),
      statusText: () => "saved",
      getThinkingLevel: () => "medium",
      getFreshPlanModel: (ctx) => ({
        model: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined,
        label: "same as plan",
      }),
      getSettings: () => ({
        thinkingLevel: "inherit",
        defaultImplementationModel: {
          provider: target.provider,
          modelId: target.id,
        },
        defaultImplementationThinkingLevel: "high",
      }),
      implementationOutcome: () => "",
      getExportDestination: () => ({ configuredPath: "plan.md", resolvedPath: "/tmp/plan.md" }),
      edit: async () => undefined,
      show: () => undefined,
      finalize: () => undefined,
      implementHere: () => undefined,
      implementFresh: (_ctx, _isCurrent, runtime) => {
        selectedRuntime = runtime;
      },
      exportPlan: async () => false,
      settings: async () => false,
      save: () => undefined,
      stay: () => undefined,
      exitReady: () => undefined,
      clearSaved: () => undefined,
    });
    const context = createMockContext({
      hasUI: true,
      model: { provider: "planning-provider", id: "planning-model" },
      ...(scenario.scopedModels ? { scopedModels: scenario.scopedModels } : {}),
      modelRegistry: { getAvailable: () => scenario.availableModels },
    });

    await controller.showSaved(context.ctx);

    assert.deepEqual(
      selectedRuntime,
      {
        model: scenario.usesTarget
          ? { provider: target.provider, modelId: target.id }
          : { provider: "planning-provider", modelId: "planning-model" },
        thinkingLevel: "high",
      },
      scenario.name,
    );
    assert.equal(
      context.notifications.some((notice) => /unavailable/u.test(notice.message)),
      !scenario.usesTarget,
      scenario.name,
    );
  }
});

type ControllerOptions = Parameters<typeof createPlanActionController>[0];

function controllerOptions(overrides: Partial<ControllerOptions>): ControllerOptions {
  return {
    loadInteractiveUi: async () => ({}) as never,
    getState: () => ({ enabled: false, awaitingAction: false, declinedPlans: 0 }),
    captureLifecycle: () => ({ signal: new AbortController().signal, isCurrent: () => true }),
    statusText: () => "status",
    getThinkingLevel: () => "medium",
    getFreshPlanModel: (ctx) => ({
      model: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined,
      label: "same as plan",
    }),
    getSettings: () => ({ thinkingLevel: "inherit" }),
    implementationOutcome: () => "",
    getExportDestination: () => ({ configuredPath: "plan.md", resolvedPath: "/tmp/plan.md" }),
    edit: async () => undefined,
    show: () => undefined,
    finalize: () => undefined,
    implementHere: () => undefined,
    implementFresh: () => undefined,
    exportPlan: async () => false,
    settings: async () => false,
    save: () => undefined,
    stay: () => undefined,
    exitReady: () => undefined,
    clearSaved: () => undefined,
    ...overrides,
  };
}

test("fresh actions invoked on an already closed menu never start", async () => {
  let started = 0;
  const controller = createPlanActionController(
    controllerOptions({
      loadInteractiveUi: async () =>
        ({
          showSavedPlanMenu: async (_ctx: unknown, menuOptions: Record<string, unknown>) => {
            const closed = new AbortController();
            closed.abort(new DOMException("Menu closed", "AbortError"));
            await (menuOptions.implementFresh as (signal: AbortSignal) => Promise<void>)(closed.signal);
          },
        }) as never,
      implementFresh: () => {
        started += 1;
      },
    }),
  );

  await controller.showSaved(createMockContext({ hasUI: true }).ctx);

  assert.equal(started, 0);
});

test("fresh defaults omit the model and thinking level when none is known", async () => {
  let selectedRuntime: unknown = "unset";
  const controller = createPlanActionController(
    controllerOptions({
      loadInteractiveUi: async () =>
        ({
          showSavedPlanMenu: async (_ctx: unknown, menuOptions: Record<string, unknown>) => {
            await (menuOptions.implementFresh as (signal: AbortSignal) => Promise<void>)(new AbortController().signal);
          },
        }) as never,
      getThinkingLevel: () => undefined,
      implementFresh: (_ctx, _isCurrent, runtime) => {
        selectedRuntime = runtime;
      },
    }),
  );

  await controller.showSaved(createMockContext({ hasUI: true, model: undefined }).ctx);

  assert.deepEqual(selectedRuntime, {});
});

test("menus stop when their lifecycle ends before or while the interactive UI loads", async () => {
  type Show = "showSaved" | "showReady" | "showCurrent";
  const shows: Show[] = ["showSaved", "showReady", "showCurrent"];
  const ends = ["aborted before load", "stale before load", "aborted during load", "stale during load"] as const;
  for (const show of shows) {
    for (const end of ends) {
      const lifecycle = new AbortController();
      let current = true;
      let loads = 0;
      let opened = 0;
      const onOpen = () => {
        opened += 1;
      };
      const controller = createPlanActionController(
        controllerOptions({
          captureLifecycle: () => ({ signal: lifecycle.signal, isCurrent: () => current }),
          loadInteractiveUi: async () => {
            loads += 1;
            if (end === "aborted during load") lifecycle.abort(new DOMException("Menu closed", "AbortError"));
            if (end === "stale during load") current = false;
            return { showSavedPlanMenu: onOpen, showReadyPlanMenu: onOpen, showPlanModeMenu: onOpen } as never;
          },
        }),
      );
      if (end === "aborted before load") lifecycle.abort(new DOMException("Menu closed", "AbortError"));
      if (end === "stale before load") current = false;
      const ctx = createMockContext({ hasUI: true }).ctx;

      if (show === "showReady") await controller.showReady(ctx, () => true);
      else await controller[show](ctx);

      assert.equal(opened, 0, `${show} ${end}`);
      assert.equal(loads, end.endsWith("during load") ? 1 : 0, `${show} ${end}`);
    }
  }
});

test("a ready menu stops when the ready plan is no longer current", async () => {
  let loads = 0;
  const controller = createPlanActionController(
    controllerOptions({
      loadInteractiveUi: async () => {
        loads += 1;
        return {} as never;
      },
    }),
  );
  await controller.showReady(createMockContext({ hasUI: true }).ctx, () => false);
  assert.equal(loads, 0);
});
