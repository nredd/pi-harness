import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { planModeCompleted, planTitle, renderPlanModeCompletion } from "../src/completion-tool.js";
import planMode from "../src/plan-mode.js";
import { createMockPi } from "./support.js";

const PLAN = "Intro line\n\n## Ship the thing\n\n- step one\n- step two";

test("planTitle prefers the first heading, then the first line", () => {
  assert.equal(planTitle("# **Big** `plan`\n\nbody"), "Big plan");
  assert.equal(planTitle(PLAN), "Ship the thing");
  assert.equal(planTitle("just text\nmore"), "just text");
  assert.equal(planTitle(undefined), "plan");
});

test("plan_mode_complete renderCall is the title and the collapsed result leads with the summary", () => {
  initTheme("dark");
  const mock = createMockPi();
  planMode(mock.pi);
  const tool = mock.tools.find((candidate) => candidate.name === "plan_mode_complete");
  const renderCall = tool?.renderCall as (args: unknown) => { render(width: number): string[] };
  assert.deepEqual(renderCall({ plan: PLAN }).render(80), ["Ship the thing"]);
  assert.deepEqual(renderCall({}).render(80), ["plan"]);

  const result = planModeCompleted(PLAN);
  const collapsed = renderPlanModeCompletion(result, { expanded: false }).render(80);
  assert.deepEqual(collapsed, ["plan proposed"]);
});

test("plan_mode_complete expanded result shows the full plan", () => {
  initTheme("dark");
  const rendered = renderPlanModeCompletion(planModeCompleted(PLAN), { expanded: true }).render(80).join("\n");
  assert.match(rendered, /Proposed Plan/);
  assert.match(rendered, /Ship the thing/);
  assert.match(rendered, /step one/);
  assert.match(rendered, /step two/);
});
