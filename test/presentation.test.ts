import assert from "node:assert/strict";
import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import planMode from "../src/plan-mode.js";
import {
  PLAN_MESSAGE_TYPE,
  planMessageParts,
  renderPlanMessage,
  renderPlanModeWidget,
  sanitizePlanModeWidgetLine,
  showPlanModePlan,
  updatePlanModeUi,
} from "../src/presentation.js";
import type { PlanModeState } from "../src/state.js";
import { createMockContext, createMockPi } from "./support.js";

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

test("implementing a plan has no above-editor widget, only a colored footer chip", () => {
  const { theme } = fgTrackingTheme();
  const context = createMockContext({ hasUI: true, theme });
  const state: PlanModeState = {
    ...BASE_STATE,
    activeImplementation: { id: "plan-1", plan: "# Plan", source: "plan_mode_complete", startedAt: 0 },
  };

  updatePlanModeUi(context.ctx, state, () => "unused");

  assert.equal(context.widgets.get("plan-mode-plan"), undefined);
  assert.equal(context.statuses.get("plan-mode"), "[accent]plan implementing[/accent]");
});

test("a saved plan keeps its one-line widget and switches the footer chip to saved", () => {
  const { theme } = fgTrackingTheme();
  const context = createMockContext({ hasUI: true, theme });
  const state: PlanModeState = { ...BASE_STATE, savedPlan: { plan: "# Plan", source: "plan_mode_complete" } };

  updatePlanModeUi(context.ctx, state, () => "unused");

  assert.equal(context.statuses.get("plan-mode"), "[accent]plan saved[/accent]");
  const widget = context.widgets.get("plan-mode-plan");
  assert.ok(widget, "expected a widget for a saved plan");
});

test("clears the footer chip and widget once Plan mode is fully off", () => {
  const { theme } = fgTrackingTheme();
  const context = createMockContext({ hasUI: true, theme });

  updatePlanModeUi(context.ctx, BASE_STATE, () => "unused");

  assert.equal(context.statuses.get("plan-mode"), undefined);
  assert.equal(context.widgets.get("plan-mode-plan"), undefined);
});

const PLAN = "Intro line\n\n## Ship the thing\n\n- step one\n- step two";

type PlanMessage = Parameters<MessageRenderer>[0];

function planMessage(overrides: Partial<PlanMessage> = {}): PlanMessage {
  return {
    role: "custom",
    customType: PLAN_MESSAGE_TYPE,
    content: `**Proposed Plan**\n\n${PLAN}`,
    display: true,
    timestamp: 0,
    ...overrides,
  };
}

test("showPlanModePlan sends a proposed-plan message with structured details", () => {
  const mock = createMockPi();
  const context = createMockContext({ hasUI: true });

  showPlanModePlan(mock.pi, context.ctx, "Saved Plan", PLAN);

  assert.deepEqual(mock.sentMessages, [
    {
      message: {
        customType: PLAN_MESSAGE_TYPE,
        content: `**Saved Plan**\n\n${PLAN}`,
        display: true,
        details: { version: 1, title: "Saved Plan", plan: PLAN },
      },
      options: { triggerTurn: false },
    },
  ]);
});

test("planMessageParts prefers details and falls back to the legacy bold-title content", () => {
  assert.deepEqual(planMessageParts(planMessage({ details: { version: 1, title: "Active Plan", plan: "# X" } })), {
    version: 1,
    title: "Active Plan",
    plan: "# X",
  });
  assert.deepEqual(planMessageParts(planMessage()), { version: 1, title: "Proposed Plan", plan: PLAN });
  assert.deepEqual(planMessageParts(planMessage({ content: [{ type: "text", text: "**Saved Plan**\n\nbody" }] })), {
    version: 1,
    title: "Saved Plan",
    plan: "body",
  });
  assert.deepEqual(planMessageParts(planMessage({ content: "no title here" })), {
    version: 1,
    title: "Plan",
    plan: "no title here",
  });
});

test("the proposed-plan renderer collapses to `Title · heading` and expands to the full plan", () => {
  const liveTheme = {
    fg: (role: string, text: string) => `[${role}]${text}[/${role}]`,
    bold: (text: string) => `[b]${text}[/b]`,
  } as unknown as Theme;
  const collapsed = renderPlanMessage(planMessage(), { expanded: false, outputPad: 1 }, liveTheme).render(80);
  assert.deepEqual(collapsed, ["[b]Proposed Plan[/b][muted] · [/muted]Ship the thing"]);

  const headingless = renderPlanMessage(
    planMessage({ details: { version: 1, title: "Saved Plan", plan: "" } }),
    { expanded: false, outputPad: 1 },
    liveTheme,
  ).render(80);
  assert.deepEqual(headingless, ["[b]Saved Plan[/b]"]);

  initTheme("dark");
  const expanded = renderPlanMessage(planMessage(), { expanded: true, outputPad: 0 }, liveTheme)
    .render(80)
    .map(stripTerminalSequences)
    .join("\n");
  assert.match(expanded, /Proposed Plan/u);
  assert.match(expanded, /Ship the thing/u);
  assert.match(expanded, /step one/u);
  assert.match(expanded, /step two/u);
});

test("plan mode registers the proposed-plan message renderer", () => {
  const mock = createMockPi();
  planMode(mock.pi);
  assert.equal(mock.messageRenderers.get(PLAN_MESSAGE_TYPE), renderPlanMessage);
});
