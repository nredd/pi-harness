import assert from "node:assert/strict";
import { test } from "vitest";
import { chooseReadyPlanAction } from "../src/ready-plan-chooser.js";
import { createCustomSelectorHarness, createMockContext } from "./support.js";

test("ready plan chooser keeps the plan when Escape closes a narrow layout", async () => {
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      const harness = createCustomSelectorHarness(factory, 8);
      const lines = harness.render();
      assert.ok(lines.length > 2);
      harness.invalidate();
      harness.handleInput("tui.select.cancel");
      harness.handleInput("\u0003");
      return harness.resultPromise;
    },
  });

  assert.equal(await chooseReadyPlanAction(context.ctx), "stay");
});

test("ready plan chooser navigates with every supported cursor key", async () => {
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      const harness = createCustomSelectorHarness(factory);
      harness.handleInput("\u001b[C");
      harness.handleInput("\t");
      harness.handleInput("\u001b[D");
      harness.handleInput("\u001b[A");
      harness.handleInput("tui.select.confirm");
      return harness.resultPromise;
    },
  });

  assert.equal(await chooseReadyPlanAction(context.ctx), "show");
});

test("ready plan chooser selects and activates a mouse cell", async () => {
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: async (factory: unknown) => {
      const harness = createCustomSelectorHarness(factory, 120);
      const lines = harness.render();
      const implementHereX = (lines[1]?.indexOf("Implement here") ?? -1) + 3;
      assert.ok(implementHereX > 2);
      assert.equal(harness.handleMouse({ type: "move", button: "left", x: 0, y: 0 }), undefined);
      assert.deepEqual(harness.handleMouse({ type: "press", button: "left", x: implementHereX, y: 1 }), {
        handled: true,
        capture: true,
      });
      assert.deepEqual(harness.handleMouse({ type: "click", button: "left", x: implementHereX, y: 1 }), {
        handled: true,
        capture: false,
      });
      return harness.resultPromise;
    },
  });

  assert.equal(await chooseReadyPlanAction(context.ctx), "implement-here");
});

test("ready plan chooser is unavailable outside the interactive TUI", async () => {
  const context = createMockContext({ mode: "rpc", hasUI: true });
  assert.equal(await chooseReadyPlanAction(context.ctx), undefined);
});
