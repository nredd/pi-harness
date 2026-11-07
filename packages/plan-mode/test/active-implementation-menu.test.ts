import assert from "node:assert/strict";
import { test } from "vitest";
import { showActiveImplementationMenu } from "../src/active-implementation-menu.js";
import { createMockContext } from "./support.js";

function activeMenuOptions(overrides: Partial<Parameters<typeof showActiveImplementationMenu>[1]> = {}) {
  return {
    statusText: "implementing",
    getExportDestination: () => ({ configuredPath: "PLAN.md", resolvedPath: "/tmp/PLAN.md" }),
    signal: new AbortController().signal,
    isCurrent: () => true,
    show: () => assert.fail("unexpected show"),
    exportPlan: async () => assert.fail("unexpected export"),
    settings: async () => assert.fail("unexpected settings"),
    startNew: () => assert.fail("unexpected start-new"),
    clear: () => assert.fail("unexpected clear"),
    ...overrides,
  };
}

test("active implementation settings stay open, close, or reject stale results", async () => {
  for (const outcome of ["stay", "close", "stale", "aborted"] as const) {
    let current = true;
    const lifecycle = new AbortController();
    let selections = 0;
    let settings = 0;
    const context = createMockContext({
      hasUI: true,
      mode: "rpc",
      select: async () => (++selections === 1 ? "Settings" : undefined),
    });
    await showActiveImplementationMenu(
      context.ctx,
      activeMenuOptions({
        signal: lifecycle.signal,
        isCurrent: () => current,
        settings: async () => {
          settings++;
          if (outcome === "stale") current = false;
          if (outcome === "aborted") lifecycle.abort(new DOMException("Menu closed", "AbortError"));
          return outcome === "close";
        },
      }),
    );
    assert.equal(settings, 1, outcome);
    assert.equal(selections, outcome === "stay" ? 2 : 1, outcome);
  }
});

test("active implementation export closes on success and keeps the input open when refused", async () => {
  for (const accepted of [true, false]) {
    let inputs = 0;
    let selections = 0;
    const exported: string[] = [];
    const context = createMockContext({
      hasUI: true,
      mode: "rpc",
      select: async () => (++selections === 1 ? "Export plan…" : undefined),
      input: async () => (++inputs === 1 ? "out.md" : undefined),
    });
    await showActiveImplementationMenu(
      context.ctx,
      activeMenuOptions({
        exportPlan: async (path) => {
          exported.push(path);
          return accepted;
        },
      }),
    );
    assert.deepEqual(exported, ["out.md"]);
    assert.equal(inputs, accepted ? 1 : 2);
  }
});
