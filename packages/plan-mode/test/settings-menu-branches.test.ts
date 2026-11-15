import assert from "node:assert/strict";
import type { ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import * as kit from "@narumitw/pi-tui-kit";
import { test, vi } from "vitest";
import type { PlanModeSettings } from "../src/settings.js";
import { showPlanModeSettings } from "../src/settings-menu.js";
import { builtinTool, createPlanContext } from "./harness/support.js";

vi.mock("@narumitw/pi-tui-kit", { spy: true });

type ActionInput = { itemId?: string; value?: string; selected?: boolean; signal?: AbortSignal };
type Outcome = { kind: string; screen?: string };
type Handlers = Record<string, (input: ActionInput) => Promise<Outcome>>;

/**
 * Adapter fault injection, not a claim that the current Kit UI emits these inputs: capture the
 * menu's action handlers and drive them with values the Kit contract types but never produces.
 */
async function captureSettingsActions(overrides: Partial<Parameters<typeof showPlanModeSettings>[1]> = {}) {
  const context = createPlanContext({ hasUI: true });
  let captured: Handlers | undefined;
  let state: unknown;
  vi.spyOn(kit, "runMenu").mockImplementation(async (ctx, definition, options) => {
    const menu = definition as kit.MenuDefinition<unknown, string, string, ExtensionContext>;
    const signal = new AbortController().signal;
    state = await options.getState({ ctx, signal });
    captured = Object.fromEntries(
      Object.entries(menu.actions ?? {}).map(([name, handler]) => [
        name,
        (input: ActionInput) =>
          handler({
            ctx: ctx as ExtensionContext,
            state,
            signal: new AbortController().signal,
            itemId: "",
            ...input,
          }) as Promise<Outcome>,
      ]),
    );
    return { kind: "closed", reason: "close" };
  });
  const saved: PlanModeSettings[] = [];
  const updates: unknown[] = [];
  try {
    await showPlanModeSettings(context.ctx, {
      tools: [builtinTool("read")] as ToolInfo[],
      signal: new AbortController().signal,
      isCurrent: () => true,
      readSettings: async () => ({ kind: "missing" }),
      updateSettings: async (patch) => {
        updates.push(patch);
        return { thinkingLevel: "inherit" };
      },
      onSaved: (settings) => saved.push(settings),
      ...overrides,
    });
  } finally {
    vi.restoreAllMocks();
  }
  assert.ok(captured);
  return { actions: captured, notifications: context.notifications, saved, updates };
}

test("settings adapters reject unsupported retention labels and model IDs without saving", async () => {
  const { actions, updates } = await captureSettingsActions();

  for (const value of ["not a retention", undefined]) {
    assert.deepEqual(await actions["set-retention"]?.({ value }), { kind: "rejected" });
  }
  assert.deepEqual(await actions["set-implementation-model"]?.({ itemId: "plan-settings-model:99" }), {
    kind: "rejected",
  });
  assert.deepEqual(updates, []);
});

test("resetting automatic default tools is a no-op that does not rewrite settings", async () => {
  const { actions, updates } = await captureSettingsActions();
  assert.deepEqual(await actions["reset-tools"]?.({}), { kind: "stay" });
  assert.deepEqual(updates, []);
});

test("saves from a closed or stale menu are refused before touching settings", async () => {
  const closed = new AbortController();
  closed.abort(new DOMException("Menu closed", "AbortError"));
  const first = await captureSettingsActions();
  assert.deepEqual(await first.actions["set-thinking"]?.({ value: "high", signal: closed.signal }), {
    kind: "rejected",
  });
  assert.deepEqual(first.updates, []);

  let current = false;
  const second = await captureSettingsActions({ isCurrent: () => current });
  assert.deepEqual(await second.actions["set-thinking"]?.({ value: "high" }), { kind: "rejected" });
  assert.deepEqual(second.updates, []);
  current = true;
  assert.deepEqual(await second.actions["set-thinking"]?.({ value: "high" }), { kind: "stay" });
  assert.equal(second.updates.length, 1);
});

test("a save finishing after the menu went stale or closed is not announced", async () => {
  let current = true;
  const lifecycle = new AbortController();
  const stale = await captureSettingsActions({
    isCurrent: () => current,
    updateSettings: async () => {
      current = false;
      return { thinkingLevel: "high" };
    },
  });
  assert.deepEqual(await stale.actions["set-thinking"]?.({ value: "high" }), { kind: "rejected" });
  assert.deepEqual(stale.saved, [], "a stale menu does not report the saved settings");
  assert.deepEqual(stale.notifications, []);

  const aborted = await captureSettingsActions({
    updateSettings: async () => {
      lifecycle.abort(new DOMException("Menu closed", "AbortError"));
      return { thinkingLevel: "high" };
    },
  });
  assert.deepEqual(await aborted.actions["set-thinking"]?.({ value: "high", signal: lifecycle.signal }), {
    kind: "rejected",
  });
  assert.deepEqual(aborted.notifications, []);
});

test("failed saves stay on their input screen and show sanitized details for any thrown value", async () => {
  const failures: unknown[] = [new Error("disk\u0085full"), "quota\u0085exceeded"];
  for (const failure of failures) {
    const { actions, notifications, saved } = await captureSettingsActions({
      updateSettings: async () => {
        throw failure;
      },
    });
    assert.deepEqual(await actions["set-plan-model"]?.({ itemId: "inherit" }), { kind: "rejected" });
    assert.deepEqual(await actions["set-export"]?.({ value: "out.md" }), { kind: "rejected" });
    assert.deepEqual(await actions["set-implementation-model"]?.({ itemId: "same-as-plan" }), { kind: "rejected" });
    assert.equal(notifications.length, 3);
    for (const { message } of notifications) {
      assert.match(message, /previous value remains: (disk full|quota exceeded)$/u);
    }
    assert.deepEqual(saved, []);
  }
});
