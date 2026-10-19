import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { renderPlanModeWidget, sanitizePlanModeWidgetLine, updatePlanModeUi } from "../src/presentation.js";
import type { PlanModeState } from "../src/state.js";
import { createMockContext } from "./support.js";

const BASE_STATE: PlanModeState = {
  enabled: false,
  awaitingAction: false,
};

function fgTrackingTheme() {
  const calls: Array<{ role: string; text: string }> = [];
  const theme = {
    fg(role: string, text: string) {
      calls.push({ role, text });
      return `[${role}]${text}[/${role}]`;
    },
  } as unknown as Theme;
  return { calls, theme };
}

test("renders an editor-style divider above bounded Plan mode content", () => {
  const roles: string[] = [];
  const theme = {
    fg(role: string, text: string) {
      roles.push(role);
      return text;
    },
  } as unknown as Theme;

  const lines = renderPlanModeWidget(["Plan mode: planning", "A longer status line"], theme, 12);

  assert.deepEqual(lines.map(stripTerminalSequences), ["─".repeat(12), "Plan mode: p", "A longer sta"]);
  assert.deepEqual(roles, ["borderMuted"]);
  assert.ok(lines.every((line) => visibleWidth(line) <= 12));
});

test("sanitizes terminal and bidi controls before truncating Plan mode content", () => {
  const hostile = "safe\u001b]8;;https://evil\u0007link\u001b]8;;\u0007\n界界\u202e";
  assert.equal(sanitizePlanModeWidgetLine(hostile), "safelink 界界");
});

test("plain planning state has no above-editor widget, only a colored footer chip", () => {
  const { calls, theme } = fgTrackingTheme();
  const context = createMockContext({ hasUI: true, theme });
  const state: PlanModeState = { ...BASE_STATE, enabled: true };

  updatePlanModeUi(context.ctx, state, () => "unused");

  assert.equal(context.widgets.get("plan-mode-plan"), undefined);
  assert.equal(context.statuses.get("plan-mode"), "[accent]plan active[/accent]");
  assert.deepEqual(calls, [{ role: "accent", text: "plan active" }]);
});

test("a ready plan keeps its one-line widget and switches the footer chip to ready", () => {
  const { theme } = fgTrackingTheme();
  const context = createMockContext({ hasUI: true, theme });
  const state: PlanModeState = { ...BASE_STATE, enabled: true, latestPlan: "# Plan", awaitingAction: true };

  updatePlanModeUi(context.ctx, state, () => "unused");

  assert.equal(context.statuses.get("plan-mode"), "[accent]plan ready[/accent]");
  const widget = context.widgets.get("plan-mode-plan");
  assert.ok(widget, "expected a widget for a ready plan");
});

test("clears the footer chip and widget once Plan mode is fully off", () => {
  const { theme } = fgTrackingTheme();
  const context = createMockContext({ hasUI: true, theme });

  updatePlanModeUi(context.ctx, BASE_STATE, () => "unused");

  assert.equal(context.statuses.get("plan-mode"), undefined);
  assert.equal(context.widgets.get("plan-mode-plan"), undefined);
});
