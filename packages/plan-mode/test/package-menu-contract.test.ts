import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as kit from "@narumitw/pi-tui-kit";
import { test, vi } from "vitest";
import { showActiveImplementationMenu } from "../src/active-implementation-menu.js";
import { showPlanModeMenu, showReadyPlanMenu } from "../src/plan-action-menus.js";
import { showPlanLaunchMenu } from "../src/plan-launch-menu.js";
import { showSavedPlanMenu } from "../src/saved-plan-menu.js";
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

/** Adapter fault injection: Kit checks currency before dispatch, the adapter must still not act on a stale one. */
test("launch adapter refuses every action from a closed or stale menu", async () => {
  const context = createMockContext({ hasUI: true });
  const closed = new AbortController();
  closed.abort(new DOMException("Menu closed", "AbortError"));
  const effects: string[] = [];
  let current = false;
  const outcomes: [string, unknown][] = [];
  try {
    vi.spyOn(kit, "runMenu").mockImplementation(async (ctx, definition) => {
      const menu = definition as kit.MenuDefinition<unknown, string, string, ExtensionContext>;
      for (const [name, signal] of [
        ["stale", new AbortController().signal],
        ["closed", closed.signal],
      ] as const) {
        for (const action of ["start", "toggle-tool", "start-with-tools", "settings"]) {
          const handler = menu.actions?.[action];
          assert.ok(handler);
          outcomes.push([
            `${name} ${action}`,
            await handler({
              ctx: ctx as ExtensionContext,
              state: undefined,
              signal,
              itemId: "plan-tool:0",
              selected: true,
            }),
          ]);
        }
        current = true;
      }
      return { kind: "closed", reason: "close" };
    });
    await showPlanLaunchMenu(context.ctx, {
      statusText: "off",
      toolSummary: () => "read",
      getSelectedNames: () => new Set(["read"]),
      tools: [{ name: "read", description: "Read", searchText: "read", disabled: false }],
      signal: new AbortController().signal,
      isCurrent: () => current,
      start: () => effects.push("start"),
      startWithTools: () => effects.push("startWithTools"),
      settings: async () => {
        effects.push("settings");
        return true;
      },
    });
    assert.deepEqual(
      outcomes.map(([name, outcome]) => [name, (outcome as { kind: string }).kind]),
      [
        ["stale start", "rejected"],
        ["stale toggle-tool", "rejected"],
        ["stale start-with-tools", "rejected"],
        ["stale settings", "rejected"],
        ["closed start", "rejected"],
        ["closed toggle-tool", "rejected"],
        ["closed start-with-tools", "rejected"],
        ["closed settings", "rejected"],
      ],
    );
    assert.deepEqual(effects, [], "no action ran from a stale or closed menu");
  } finally {
    vi.restoreAllMocks();
  }
});

test("launch Settings that finish after the menu went stale do not change the draft", async () => {
  const context = createMockContext({ hasUI: true });
  let current = true;
  let outcome: unknown;
  try {
    vi.spyOn(kit, "runMenu").mockImplementation(async (ctx, definition) => {
      const menu = definition as kit.MenuDefinition<unknown, string, string, ExtensionContext>;
      const settings = menu.actions?.settings;
      assert.ok(settings);
      outcome = await settings({
        ctx: ctx as ExtensionContext,
        state: undefined,
        signal: new AbortController().signal,
        itemId: "settings",
      });
      return { kind: "closed", reason: "close" };
    });
    await showPlanLaunchMenu(context.ctx, {
      statusText: "off",
      toolSummary: () => "read",
      getSelectedNames: () => new Set(["read"]),
      tools: [],
      signal: new AbortController().signal,
      isCurrent: () => current,
      start() {},
      startWithTools() {},
      settings: async () => {
        current = false;
        return true;
      },
    });
    assert.deepEqual(outcome, { kind: "rejected" });
  } finally {
    vi.restoreAllMocks();
  }
});

/** Adapter fault injection: Kit types an input action's value as optional, though its input screen always supplies one. */
test("every export action sends a missing value to the default destination and reports refusal", async () => {
  const menuOptions = (exportPlan: (path: string) => Promise<boolean>) => ({
    signal: new AbortController().signal,
    isCurrent: () => true,
    statusText: "ready",
    hasReadyPlan: true,
    planThinkingLevel: "medium" as const,
    planModel: { model: undefined, label: "same as plan" as const },
    implementationOutcome: () => "",
    getExportDestination: () => ({ configuredPath: "PLAN.md", resolvedPath: "/tmp/PLAN.md" }),
    edit: async () => undefined,
    show: () => undefined,
    finalize: () => undefined,
    implementHere: () => undefined,
    implementFresh: () => undefined,
    exportPlan,
    settings: async () => false,
    save: () => undefined,
    stay: () => undefined,
    exit: () => undefined,
    clear: () => undefined,
    startNew: () => undefined,
  });
  const menus: [string, (ctx: ExtensionContext, options: ReturnType<typeof menuOptions>) => Promise<unknown>][] = [
    ["active", (ctx, options) => showActiveImplementationMenu(ctx, options)],
    ["saved", (ctx, options) => showSavedPlanMenu(ctx, options)],
    ["plan", (ctx, options) => showPlanModeMenu(ctx, options)],
    ["ready", (ctx, options) => showReadyPlanMenu(ctx, options)],
  ];
  for (const [name, show] of menus) {
    const paths: string[] = [];
    let accept = true;
    const outcomes: unknown[] = [];
    try {
      vi.spyOn(kit, "runMenu").mockImplementation(async (ctx, definition) => {
        const menu = definition as kit.MenuDefinition<unknown, string, string, ExtensionContext>;
        const exportAction = menu.actions?.export;
        assert.ok(exportAction, name);
        for (const value of [undefined, "out.md"]) {
          for (accept of [true, false]) {
            outcomes.push(
              await exportAction({
                ctx: ctx as ExtensionContext,
                state: undefined,
                signal: new AbortController().signal,
                itemId: "input",
                ...(value === undefined ? {} : { value }),
              }),
            );
          }
        }
        return { kind: "closed", reason: "close" };
      });
      const context = createMockContext({ hasUI: true, mode: "rpc" });
      await show(
        context.ctx,
        menuOptions(async (path) => {
          paths.push(path);
          return accept;
        }),
      );
      assert.deepEqual(paths, ["", "", "out.md", "out.md"], name);
      assert.deepEqual(
        outcomes,
        [{ kind: "close" }, { kind: "rejected" }, { kind: "close" }, { kind: "rejected" }],
        name,
      );
    } finally {
      vi.restoreAllMocks();
    }
  }
});
