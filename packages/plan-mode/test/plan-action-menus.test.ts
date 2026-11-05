import assert from "node:assert/strict";
import { test } from "vitest";
import { editPlanThenReopen, showPlanModeMenu, showReadyPlanMenu } from "../src/plan-action-menus.js";
import { showSavedPlanMenu } from "../src/saved-plan-menu.js";
import { createCustomSelectorHarness, createMockContext } from "./support.js";

/**
 * Build a complete menu callback contract, overriding only the outcome under test.
 *
 * This keeps each test at the public menu boundary while making omitted outcomes inert.
 */
function menuOptions(overrides: Record<string, unknown> = {}) {
  return {
    signal: new AbortController().signal,
    isCurrent: () => true,
    statusText: "Plan is ready for review.",
    hasReadyPlan: true,
    planThinkingLevel: "medium" as const,
    implementationOutcome: () => "The plan remains available until implementation ends.",
    getExportDestination: () => ({ configuredPath: "PLAN.md", resolvedPath: "/tmp/PLAN.md" }),
    edit: async () => undefined,
    show: () => undefined,
    finalize: () => undefined,
    implementHere: () => undefined,
    implementFresh: () => undefined,
    exportPlan: async () => true,
    save: () => undefined,
    stay: () => undefined,
    exit: () => undefined,
    ...overrides,
  };
}

/**
 * Drive Kit's RPC adapter with an ordered menu-selection script and one text submission.
 *
 * Each selection is an independent user-visible label, not a menu implementation detail.
 */
function rpcContext(choices: readonly string[], input = "review.md") {
  let choice = 0;
  return createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async () => choices[choice++],
    input: async () => input,
  });
}

test("Plan menu choices invoke their corresponding lifecycle outcomes", async () => {
  for (const [hasReadyPlan, choice, expected] of [
    [false, "Request final plan", "finalize"],
    [false, "Stay in Plan mode", "stay"],
    [false, "Exit Plan mode", "exit"],
    [true, "Show latest proposed plan", "show"],
    [true, "Implement here", "implementHere"],
    [true, "Save for later", "save"],
    [true, "Discard plan and exit", "exit"],
  ] as const) {
    const actions: string[] = [];
    const context = rpcContext([choice]);

    await showPlanModeMenu(
      context.ctx,
      menuOptions({
        hasReadyPlan,
        finalize: () => actions.push("finalize"),
        show: () => actions.push("show"),
        implementHere: () => actions.push("implementHere"),
        save: () => actions.push("save"),
        stay: () => actions.push("stay"),
        exit: () => actions.push("exit"),
      }),
    );

    assert.deepEqual(actions, [expected]);
  }
});

test("Plan menu carries selected models and submitted export paths to their outcomes", async () => {
  const runtime: unknown[] = [];
  const exports: string[] = [];
  const models = [
    { provider: "provider-one", id: "model-one", name: "First" },
    { provider: "provider-two", id: "model-two", name: "Second" },
  ];
  let settingsVisits = 0;
  const freshContext = createMockContext({
    mode: "rpc",
    hasUI: true,
    model: models[0],
    modelRegistry: { getAvailable: () => models },
    select: async (title: string, options: string[]) => {
      if (title.startsWith("Plan mode")) return "Start fresh and implement";
      if (title.startsWith("Fresh implementation settings")) {
        settingsVisits += 1;
        return settingsVisits === 1 ? "Model" : "Start fresh implementation";
      }
      if (title.startsWith("Implementation model")) {
        return options.find((option) => option.includes("model-two [provider-two]"));
      }
      return undefined;
    },
  });

  await showPlanModeMenu(
    freshContext.ctx,
    menuOptions({ implementFresh: (selection: unknown) => runtime.push(selection) }),
  );

  assert.deepEqual(runtime, [{ model: { provider: "provider-two", modelId: "model-two" }, thinkingLevel: "medium" }]);

  const exportContext = rpcContext(["Export plan…"], "review.md");
  await showPlanModeMenu(
    exportContext.ctx,
    menuOptions({
      hasReadyPlan: true,
      exportPlan: async (path: string) => {
        exports.push(path);
        return true;
      },
    }),
  );

  assert.deepEqual(exports, ["review.md"]);

  const thinkingRuntime: unknown[] = [];
  const thinkingContext = rpcContext([
    "Start fresh and implement",
    "Thinking level",
    "max",
    "Start fresh implementation",
  ]);
  await showPlanModeMenu(
    thinkingContext.ctx,
    menuOptions({ implementFresh: (selection: unknown) => thinkingRuntime.push(selection) }),
  );
  assert.deepEqual(thinkingRuntime, [{ thinkingLevel: "max" }]);
});

test("Plan menu awaits deferred implementation outcomes", async () => {
  let startImplementation!: () => void;
  const started = new Promise<void>((resolve) => {
    startImplementation = resolve;
  });
  let finishImplementation!: () => void;
  const completion = new Promise<void>((resolve) => {
    finishImplementation = resolve;
  });
  let settled = false;
  let menuReturned = false;
  const context = rpcContext(["Implement here"]);
  const running = showPlanModeMenu(
    context.ctx,
    menuOptions({
      implementHere: async () => {
        startImplementation();
        await completion;
        settled = true;
      },
    }),
  );

  void running.then(() => {
    menuReturned = true;
  });
  await started;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(menuReturned, false);
  finishImplementation();
  await running;
  assert.equal(settled, true);
  assert.equal(menuReturned, true);
});

test("Plan menu keeps a rejected export input open for cancellation", async () => {
  let inputs = 0;
  let exports = 0;
  let selections = 0;
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async () => {
      selections += 1;
      return selections === 1 ? "Export plan…" : undefined;
    },
    input: async () => {
      inputs += 1;
      return inputs === 1 ? "rejected.md" : undefined;
    },
  });

  await showPlanModeMenu(
    context.ctx,
    menuOptions({
      exportPlan: async (path: string) => {
        exports += 1;
        assert.equal(path, "rejected.md");
        return false;
      },
    }),
  );

  assert.equal(exports, 1);
  assert.equal(inputs, 2);
});

test("Ready-plan full menu choices invoke their corresponding lifecycle outcomes", async () => {
  for (const [choice, expected] of [
    ["Implement here", "implementHere"],
    ["Save for later", "save"],
    ["Stay in Plan mode", "stay"],
  ] as const) {
    const actions: string[] = [];
    const context = rpcContext([choice]);

    await showReadyPlanMenu(
      context.ctx,
      menuOptions({
        implementHere: () => actions.push("implementHere"),
        save: () => actions.push("save"),
        stay: () => actions.push("stay"),
      }),
    );

    assert.deepEqual(actions, [expected]);
  }
});

test("Ready-plan full menu routes show and exit actions", async () => {
  for (const [choice, expected] of [
    ["Show latest proposed plan", "show"],
    ["Discard plan and exit", "exit"],
  ] as const) {
    const actions: string[] = [];
    const context = rpcContext([choice]);
    await showReadyPlanMenu(
      context.ctx,
      menuOptions({ show: () => actions.push("show"), exit: () => actions.push("exit") }),
    );
    assert.deepEqual(actions, [expected]);
  }
});

test("Ready-plan full menu applies selected model and exports submitted paths", async () => {
  const models = [
    { provider: "provider-one", id: "model-one", name: "First" },
    { provider: "provider-two", id: "model-two", name: "Second" },
  ];
  const runtime: unknown[] = [];
  let settingsVisits = 0;
  const freshContext = createMockContext({
    mode: "rpc",
    hasUI: true,
    model: models[0],
    modelRegistry: { getAvailable: () => models },
    select: async (title: string, options: string[]) => {
      if (title.startsWith("Proposed plan ready")) return "Start fresh and implement";
      if (title.startsWith("Fresh implementation settings")) {
        settingsVisits += 1;
        return settingsVisits === 1 ? "Model" : "Start fresh implementation";
      }
      if (title.startsWith("Implementation model")) {
        return options.find((option) => option.includes("model-two [provider-two]"));
      }
      return undefined;
    },
  });
  await showReadyPlanMenu(
    freshContext.ctx,
    menuOptions({ implementFresh: (selection: unknown) => runtime.push(selection) }),
  );

  assert.deepEqual(runtime, [{ model: { provider: "provider-two", modelId: "model-two" }, thinkingLevel: "medium" }]);

  const exports: string[] = [];
  const exportContext = rpcContext(["Export plan…"], "ready.md");
  await showReadyPlanMenu(
    exportContext.ctx,
    menuOptions({
      exportPlan: async (path: string) => {
        exports.push(path);
        return true;
      },
    }),
  );

  assert.deepEqual(exports, ["ready.md"]);
});

test("Ready-plan chooser renders at narrow widths and routes explicit choices", async () => {
  for (const [moves, expected] of [
    [0, "show"],
    [5, "save"],
    [7, "exit"],
  ] as const) {
    const actions: string[] = [];
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: async (factory: unknown) => {
        const harness = createCustomSelectorHarness(factory, 80);
        for (const width of [20, 40, 80]) {
          const rendered = harness.render(width).join("\n");
          assert.match(rendered, /Proposed plan ready/u);
          assert.match(rendered.replace(/\s+/gu, " "), /Show latest proposed plan.*Discard plan and exit/u);
        }
        for (let move = 0; move < moves; move += 1) harness.handleInput("tui.select.down");
        harness.handleInput("tui.select.confirm");
        return harness.resultPromise;
      },
    });

    await showReadyPlanMenu(
      context.ctx,
      menuOptions({
        show: () => actions.push("show"),
        implementHere: () => actions.push("implementHere"),
        save: () => actions.push("save"),
        stay: () => actions.push("stay"),
        exit: () => actions.push("exit"),
      }),
    );

    assert.deepEqual(actions, [expected]);
  }
});

test("Ready-plan chooser distinguishes Escape from Ctrl-C cancellation", async () => {
  for (const [input, expected] of [
    ["tui.select.cancel", ["stay"]],
    ["\u0003", []],
  ] as const) {
    const actions: string[] = [];
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: async (factory: unknown) => {
        const harness = createCustomSelectorHarness(factory);
        harness.handleInput(input);
        return harness.resultPromise;
      },
    });

    await showReadyPlanMenu(
      context.ctx,
      menuOptions({
        show: () => actions.push("show"),
        implementHere: () => actions.push("implementHere"),
        implementFresh: () => actions.push("implementFresh"),
        exportPlan: async () => {
          actions.push("exportPlan");
          return true;
        },
        save: () => actions.push("save"),
        stay: () => actions.push("stay"),
        exit: () => actions.push("exit"),
      }),
    );

    assert.deepEqual(actions, expected);
  }
});

test("Edit plan in every ready and saved menu edits after closing, then reopens the menu", async () => {
  const ready: string[] = [];
  await showReadyPlanMenu(
    rpcContext(["Edit plan…", "Implement here"]).ctx,
    menuOptions({
      edit: async () => {
        ready.push("edit");
      },
      implementHere: () => ready.push("implementHere"),
    }),
  );
  assert.deepEqual(ready, ["edit", "implementHere"]);

  const current: string[] = [];
  await showPlanModeMenu(
    rpcContext(["Edit plan…", "Stay in Plan mode"]).ctx,
    menuOptions({
      edit: async () => {
        current.push("edit");
      },
      stay: () => current.push("stay"),
    }),
  );
  assert.deepEqual(current, ["edit", "stay"]);

  const saved: string[] = [];
  const titles: string[] = [];
  await showSavedPlanMenu(
    createMockContext({
      mode: "rpc",
      hasUI: true,
      select: async (title: string, options: string[]) => {
        titles.push(title);
        assert.ok(options.includes("Edit plan…"));
        return titles.length === 1 ? "Edit plan…" : "Show saved plan";
      },
    }).ctx,
    {
      statusText: "Saved plan ready.",
      implementationOutcome: () => "Plan reinjection: Until /plan exit.",
      getExportDestination: () => ({ configuredPath: "PLAN.md", resolvedPath: "/tmp/PLAN.md" }),
      signal: new AbortController().signal,
      isCurrent: () => true,
      show: () => saved.push("show"),
      edit: async () => {
        saved.push("edit");
      },
      implementHere: () => assert.fail("unexpected implementHere"),
      implementFresh: () => assert.fail("unexpected implementFresh"),
      exportPlan: async () => assert.fail("unexpected export"),
      settings: async () => assert.fail("unexpected settings"),
      clear: () => assert.fail("unexpected clear"),
    },
  );
  assert.deepEqual(saved, ["edit", "show"]);
  assert.equal(titles.length, 2);
});

test("Ctrl+G in the ready chooser edits, then reopens the chooser on the edited plan", async () => {
  const actions: string[] = [];
  let opened = 0;
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      opened += 1;
      const harness = createCustomSelectorHarness(factory);
      harness.handleInput(opened === 1 ? "\u0007" : "tui.select.cancel");
      return harness.resultPromise;
    },
  });
  await showReadyPlanMenu(
    context.ctx,
    menuOptions({
      edit: async () => {
        actions.push("edit");
      },
      stay: () => actions.push("stay"),
    }),
  );
  assert.equal(opened, 2);
  assert.deepEqual(actions, ["edit", "stay"]);
});

test("A menu does not reopen after its edit leaves the plan stale", async () => {
  let current = true;
  let opened = 0;
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      opened += 1;
      const harness = createCustomSelectorHarness(factory);
      harness.handleInput("\u0007");
      return harness.resultPromise;
    },
  });
  await showReadyPlanMenu(
    context.ctx,
    menuOptions({
      isCurrent: () => current,
      edit: async () => {
        current = false;
      },
    }),
  );
  assert.equal(opened, 1);

  let edits = 0;
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(
    await editPlanThenReopen({
      signal: aborted.signal,
      isCurrent: () => true,
      edit: async () => {
        edits += 1;
      },
    }),
    false,
  );
  assert.equal(
    await editPlanThenReopen({
      signal: new AbortController().signal,
      isCurrent: () => false,
      edit: async () => {
        edits += 1;
      },
    }),
    false,
  );
  assert.equal(edits, 0);
});
