import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as kit from "@narumitw/pi-tui-kit";
import { test, vi } from "vitest";
import { showPlanLaunchMenu } from "../src/plan-launch-menu.js";
import { showPlanModeSettings } from "../src/settings-menu.js";
import { createMockContext } from "./harness/support.js";

vi.mock("@narumitw/pi-tui-kit", { spy: true });

/** Adapter fault injection, not a claim that the current Kit UI emits invalid selections. */
test("settings adapters reject unknown thinking values and absent tools without saving", async () => {
  const context = createMockContext({ hasUI: true });
  let checked = 0;
  try {
    vi.spyOn(kit, "runMenu").mockImplementation(async (ctx, definition, options) => {
      const menu = definition as kit.MenuDefinition<unknown, string, string, ExtensionContext>;
      const signal = new AbortController().signal;
      const state = await options.getState({ ctx, signal });
      for (const action of ["set-thinking", "set-implementation-thinking", "toggle-tool"]) {
        const handler = menu.actions?.[action];
        assert.ok(handler);
        assert.deepEqual(
          await handler({ ctx: ctx as ExtensionContext, state, signal, itemId: "missing-tool", value: "not-a-level" }),
          { kind: "rejected" },
        );
        checked++;
      }
      return { kind: "closed", reason: "close" };
    });
    await showPlanModeSettings(context.ctx, {
      tools: [],
      signal: new AbortController().signal,
      isCurrent: () => true,
      readSettings: async () => ({ kind: "missing" }),
      updateSettings: async () => assert.fail("invalid dispatch must not save"),
      onSaved: () => assert.fail("invalid dispatch must not report saved"),
    });
    assert.equal(checked, 3);
    assert.deepEqual(context.notifications, []);
  } finally {
    vi.restoreAllMocks();
  }
});

test("launch adapter rejects an unknown tool ID without broadening its selected policy", async () => {
  const context = createMockContext({ hasUI: true });
  let started: string[] | undefined;
  try {
    vi.spyOn(kit, "runMenu").mockImplementation(async (ctx, definition) => {
      const menu = definition as kit.MenuDefinition<unknown, string, string, ExtensionContext>;
      const signal = new AbortController().signal;
      const toggle = menu.actions?.["toggle-tool"];
      const start = menu.actions?.["start-with-tools"];
      assert.ok(toggle);
      assert.ok(start);
      assert.deepEqual(
        await toggle({ ctx: ctx as ExtensionContext, state: undefined, signal, itemId: "unknown", selected: true }),
        { kind: "rejected" },
      );
      assert.deepEqual(
        await start({ ctx: ctx as ExtensionContext, state: undefined, signal, itemId: "start-with-tools" }),
        { kind: "close" },
      );
      return { kind: "closed", reason: "close" };
    });
    await showPlanLaunchMenu(context.ctx, {
      statusText: "off",
      toolSummary: () => "read",
      getSelectedNames: () => new Set(["read"]),
      tools: [],
      signal: new AbortController().signal,
      isCurrent: () => true,
      start() {},
      startWithTools: (names) => {
        started = names;
      },
      settings: async () => false,
    });
    assert.deepEqual(started, ["read"]);
  } finally {
    vi.restoreAllMocks();
  }
});
