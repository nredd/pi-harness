import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
  normalizePlanModeCompletion,
  planFromCompletionDetails,
  planModeCompleted,
  planModeCompletionMarkdown,
  planTitle,
  renderPlanModeCompletion,
  renderPlanModeCompletionCall,
} from "../src/completion-tool.js";
import planMode from "../src/plan-mode.js";
import { createMockPi } from "./support.js";

const PLAN = "Intro line\n\n## Ship the thing\n\n- step one\n- step two";

test("completion normalization rejects malformed, empty, and oversized plans", () => {
  assert.deepEqual(normalizePlanModeCompletion({}), { ok: false, error: "plan must be a string" });
  assert.deepEqual(normalizePlanModeCompletion({ plan: " \n " }), { ok: false, error: "plan must not be empty" });
  const oversized = normalizePlanModeCompletion({ plan: "x".repeat(50_001) });
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.match(oversized.error, /must not exceed/u);
  assert.deepEqual(normalizePlanModeCompletion({ plan: "\n# Plan\n" }), { ok: true, plan: "# Plan" });
});

test("completion details require the canonical version and source", () => {
  const completed = planModeCompleted(PLAN);
  assert.equal(planFromCompletionDetails(completed.details), PLAN);
  assert.equal(planFromCompletionDetails({ ...completed.details, version: 2 }), undefined);
  assert.equal(planFromCompletionDetails({ ...completed.details, source: "other" }), undefined);
  assert.equal(planFromCompletionDetails(null), undefined);
});

test("planTitle prefers the first heading, then the first line", () => {
  assert.equal(planTitle("# **Big** `plan`\n\nbody"), "Big plan");
  assert.equal(planTitle(PLAN), "Ship the thing");
  assert.equal(planTitle("just text\nmore"), "just text");
  assert.equal(planTitle("## ***```***"), "plan");
  assert.equal(planTitle(undefined), "plan");
});

test("plan_mode_complete renderCall is the title and the collapsed result leads with the summary", () => {
  initTheme("dark");
  const mock = createMockPi();
  planMode(mock.pi);
  const tool = mock.tools.find((candidate) => candidate.name === "plan_mode_complete");
  const renderCall = tool?.renderCall as (args: unknown) => { render(width: number): string[]; invalidate(): void };
  const titledCall = renderCall({ plan: PLAN });
  assert.deepEqual(titledCall.render(80), ["Ship the thing"]);
  titledCall.invalidate();
  assert.deepEqual(renderCall({}).render(80), ["plan"]);

  const result = planModeCompleted(PLAN);
  const collapsed = renderPlanModeCompletion(result, { expanded: false });
  assert.deepEqual(collapsed.render(80), ["plan proposed"]);
  collapsed.invalidate();
});

test("plan_mode_complete renderers recover legacy text and details", () => {
  initTheme("dark");
  const expanded = renderPlanModeCompletion(planModeCompleted(PLAN), { expanded: true }).render(80).join("\n");
  assert.match(expanded, /Proposed Plan/);
  assert.match(expanded, /Ship the thing/);
  assert.match(expanded, /step one/);
  assert.match(expanded, /step two/);

  const legacy = { content: [{ type: "text", text: "\nLegacy plan\n" }] };
  assert.equal(planModeCompletionMarkdown(legacy), "Legacy plan");
  assert.deepEqual(renderPlanModeCompletion(legacy, { expanded: false }).render(80), ["Legacy plan"]);
  assert.equal(
    planModeCompletionMarkdown({ content: [], details: planModeCompleted("# Details").details }),
    "**Proposed Plan**\n\n# Details",
  );
  assert.deepEqual(renderPlanModeCompletion({ content: [] }, { expanded: false }).render(80), ["plan"]);
  assert.deepEqual(renderPlanModeCompletionCall(null).render(80), ["plan"]);
});
