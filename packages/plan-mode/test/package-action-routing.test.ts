import assert from "node:assert/strict";
import { test } from "vitest";
import { createPlanActionController } from "../src/plan-action-controller.js";
import { showSavedPlanMenu } from "../src/saved-plan-menu.js";
import { createMockContext } from "./harness/support.js";

type InteractiveUi = typeof import("../src/interactive-ui.js");

test("action controller forwards saved, ready, and current menu callbacks with their original ownership", async () => {
  const context = createMockContext({ hasUI: true });
  const owner = new AbortController();
  const action = new AbortController();
  const calls: string[] = [];
  const destination = { configuredPath: "plan.md", resolvedPath: "/tmp/plan.md" };
  let current = true;
  const mark = (name: string) => (ctx: typeof context.ctx) => {
    assert.equal(ctx, context.ctx);
    calls.push(name);
  };
  const ui: Pick<InteractiveUi, "showSavedPlanMenu" | "showReadyPlanMenu" | "showPlanModeMenu"> = {
    async showSavedPlanMenu(ctx, menu) {
      assert.equal(ctx, context.ctx);
      assert.equal(menu.getExportDestination(), destination);
      menu.show();
      await menu.implementHere();
      menu.clear();
      assert.equal(await menu.settings(action.signal), true);
      assert.equal(await menu.exportPlan("saved.md", action.signal), true);
    },
    async showReadyPlanMenu(_ctx, menu) {
      assert.equal(menu.getExportDestination(), destination);
      menu.show();
      await menu.implementHere();
      menu.save();
      menu.stay();
      menu.exit();
      await menu.implementFresh({ thinkingLevel: "high" }, action.signal);
      assert.equal(await menu.exportPlan("ready.md", action.signal), true);
      current = false;
      assert.equal(menu.isCurrent(), false);
      current = true;
    },
    async showPlanModeMenu(_ctx, menu) {
      assert.equal(menu.getExportDestination(), destination);
      menu.show();
      menu.finalize();
      await menu.implementHere();
      menu.save();
      menu.stay();
      menu.exit();
      assert.equal(await menu.exportPlan("current.md", action.signal), true);
    },
  };
  const controller = createPlanActionController({
    loadInteractiveUi: async () => ui as InteractiveUi,
    getState: () => ({ enabled: true, awaitingAction: true, latestPlan: "# Plan" }),
    captureLifecycle: () => ({ signal: owner.signal, isCurrent: () => current }),
    statusText: () => "ready",
    getThinkingLevel: () => "medium",
    getSettings: () => ({ thinkingLevel: "inherit" }),
    implementationOutcome: () => "keep",
    getExportDestination: () => destination,
    show: mark("show"),
    finalize: mark("finalize"),
    implementHere: mark("here"),
    implementFresh: (ctx, isCurrent, runtime) => {
      assert.equal(ctx, context.ctx);
      assert.equal(isCurrent(), true);
      assert.deepEqual(runtime, { thinkingLevel: "high" });
      calls.push("fresh");
    },
    exportPlan: async (ctx, path, signal, isCurrent) => {
      assert.equal(ctx, context.ctx);
      assert.equal(signal, action.signal);
      assert.equal(isCurrent(), true);
      calls.push(path);
      return true;
    },
    settings: async (ctx, signal, isCurrent) => {
      assert.equal(ctx, context.ctx);
      assert.equal(signal, action.signal);
      assert.equal(isCurrent(), true);
      calls.push("settings");
      return true;
    },
    save: mark("save"),
    stay: mark("stay"),
    exitReady: mark("exit"),
    clearSaved: mark("clear"),
  });
  await controller.showSaved(context.ctx);
  await controller.showReady(context.ctx, () => true);
  await controller.showCurrent(context.ctx);
  const headless = createMockContext({ hasUI: false });
  await controller.showCurrent(headless.ctx);
  assert.deepEqual(headless.notifications, [{ message: "ready", level: "info" }]);
  assert.deepEqual(calls, [
    "show",
    "here",
    "clear",
    "settings",
    "saved.md",
    "show",
    "here",
    "save",
    "stay",
    "exit",
    "fresh",
    "ready.md",
    "show",
    "finalize",
    "here",
    "save",
    "stay",
    "exit",
    "current.md",
  ]);
});

test("saved-plan settings stays, closes, or rejects stale results", async () => {
  for (const outcome of ["stay", "close", "stale"] as const) {
    let current = true;
    let selections = 0;
    let settings = 0;
    const context = createMockContext({
      hasUI: true,
      mode: "rpc",
      select: async () => (++selections === 1 ? "Settings" : undefined),
    });
    await showSavedPlanMenu(context.ctx, {
      statusText: "saved",
      implementationOutcome: () => "keep",
      getExportDestination: () => ({ configuredPath: "PLAN.md", resolvedPath: "/tmp/PLAN.md" }),
      signal: new AbortController().signal,
      isCurrent: () => current,
      show: () => assert.fail("unexpected show"),
      implementHere: () => assert.fail("unexpected implementation"),
      implementFresh: () => assert.fail("unexpected fresh implementation"),
      exportPlan: async () => assert.fail("unexpected export"),
      clear: () => assert.fail("unexpected clear"),
      settings: async () => {
        settings++;
        if (outcome === "stale") current = false;
        return outcome === "close";
      },
    });
    assert.equal(settings, 1);
    assert.equal(selections, outcome === "stay" ? 2 : 1);
  }
});

test("saved-plan menu rejects a headless caller with available command routes", async () => {
  const context = createMockContext({ hasUI: false });
  await assert.rejects(
    showSavedPlanMenu(context.ctx, {
      statusText: "saved",
      implementationOutcome: () => "",
      getExportDestination: () => ({ configuredPath: "", resolvedPath: "" }),
      signal: new AbortController().signal,
      isCurrent: () => true,
      show() {},
      implementHere() {},
      implementFresh() {},
      exportPlan: async () => false,
      settings: async () => false,
      clear() {},
    }),
    /saved.*\/plan show.*\/plan implement.*\/plan export.*\/plan exit/,
  );
});
