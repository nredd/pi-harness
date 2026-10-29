import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import {
  findHistoryImplementationArtifact,
  latestAssistantStopReason,
  PLAN_HISTORY_IMPLEMENTATION_PROMPT,
  stripPlanModeCompletionCallsFromMessage,
  stripProposedPlanBlocksFromMessage,
} from "../src/message-transform.js";
import { exportPlanToFile, exportStoredPlan, resolvePlanExportPath } from "../src/plan-export.js";
import { planModeStatusText, renderPlanMessage, updatePlanModeUi } from "../src/presentation.js";
import {
  normalizePlanModeQuestionParams,
  planModeQuestionCollapsedText,
  planModeQuestionExpandedText,
  renderPlanModeQuestionCall,
} from "../src/question-tool.js";
import { normalizeKeyId, updatePlanModeSettings } from "../src/settings.js";
import { restorePlanModeState } from "../src/state.js";
import { createMockContext } from "./harness/support.js";

const question = {
  id: "scope",
  header: "Scope",
  question: "How broad?",
  options: [
    { label: "Small", description: "Bug only" },
    { label: "Broad", description: "Cleanup" },
  ],
};

test("question validation rejects each malformed boundary with a useful diagnostic", () => {
  const cases: [unknown, string][] = [
    [null, "questions must be an array"],
    [{ questions: [question], mode: "approve" }, "mode must be reproposal_confirmation"],
    [{ questions: [null] }, "question 1 must be an object"],
    [{ questions: [{ ...question, header: " " }] }, "question 1 requires non-empty id, header, and question"],
    [{ questions: [{ ...question, options: null }] }, "question 1 options must be an array"],
    [{ questions: [{ ...question, options: [null, question.options[1]] }] }, "question 1 option 1 must be an object"],
    [
      { questions: [{ ...question, options: [{ label: " " }, question.options[1]] }] },
      "question 1 option 1 requires a label",
    ],
    [
      { questions: [{ ...question, options: [{ label: "Yes" }, question.options[1]] }] },
      "question 1 option 1 requires a description",
    ],
    [
      { mode: "reproposal_confirmation", questions: [question, question] },
      "reproposal_confirmation requires exactly one question",
    ],
  ];
  for (const [input, error] of cases) assert.deepEqual(normalizePlanModeQuestionParams(input), { ok: false, error });
});

test("question fallback renders only text blocks and remains invalidatable", () => {
  const result = {
    content: [
      { type: "image", text: "hidden" },
      { type: "text", text: " first\nline " },
      { type: "text" },
      { type: "text", text: "second" },
    ],
  };
  assert.equal(planModeQuestionCollapsedText(result), "first line second");
  assert.equal(planModeQuestionExpandedText(result), "first\nline \nsecond");
  const component = renderPlanModeQuestionCall({ questions: [question] });
  component.invalidate();
  assert.deepEqual(component.render(80), ["plan question · Scope"]);
});

test("message transforms preserve scalar content and honor user boundaries", () => {
  assert.equal(latestAssistantStopReason([{ role: "user", content: "hello" }]), undefined);
  const scalar = { role: "assistant", content: "plain text" };
  assert.equal(stripPlanModeCompletionCallsFromMessage(scalar), scalar);
  const wrapper = {
    type: "message",
    message: { role: "assistant", content: "<proposed_plan>\nsecret\n</proposed_plan>" },
  };
  assert.deepEqual(stripProposedPlanBlocksFromMessage(wrapper), {
    type: "message",
    message: { role: "assistant", content: "" },
  });
  assert.deepEqual(
    findHistoryImplementationArtifact([
      { role: "custom", customType: "proposed-plan", content: "# Plan" },
      { role: "user", content: PLAN_HISTORY_IMPLEMENTATION_PROMPT },
    ]),
    { messageIndex: 0, kind: "presentation" },
  );
  assert.equal(
    findHistoryImplementationArtifact([
      { role: "assistant", content: [{ type: "toolCall", id: "old", name: "plan_mode_complete" }] },
      { role: "user", content: "different task" },
      { role: "toolResult", toolName: "plan_mode_complete", toolCallId: "old" },
      { role: "user", content: PLAN_HISTORY_IMPLEMENTATION_PROMPT },
    ]),
    undefined,
  );
});

test("restoration skips non-completion messages before recovering the last completed plan", () => {
  const state = restorePlanModeState(
    [
      { type: "custom", customType: "state", data: { enabled: true } },
      {
        message: {
          role: "toolResult",
          toolName: "plan_mode_complete",
          details: { version: 1, source: "plan_mode_complete", plan: "# Recovered" },
        },
      },
      { message: { role: "user", content: "continue" } },
    ],
    "state",
  );
  assert.equal(state.latestPlan, "# Recovered");
});

test("active plan status reports the frozen tool summary", () => {
  assert.equal(
    planModeStatusText({ enabled: true, awaitingAction: true, latestPlan: "# Ready" }, () => "read only"),
    "Plan mode is active and a proposed plan is ready. read only",
  );
  assert.equal(
    planModeStatusText({ enabled: false, awaitingAction: false }, () => "unused"),
    "Plan mode is off.",
  );
});

test("message and widget components remain renderable after invalidation", () => {
  const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text } as Theme;
  const component = renderPlanMessage(
    { content: "", details: { version: 1, title: "Saved", plan: "# Task" } } as Parameters<typeof renderPlanMessage>[0],
    { expanded: false, outputPad: 0 },
    theme,
  );
  const before = component.render(80);
  component.invalidate();
  assert.deepEqual(component.render(80), before);
  const context = createMockContext({ hasUI: true, mode: "tui", theme });
  updatePlanModeUi(context.ctx, { enabled: true, awaitingAction: true, latestPlan: "# Task" }, () => "read");
  const factory = context.widgets.get("plan-mode-plan") as (tui: unknown, theme: Theme) => Component;
  const widget = factory({}, theme);
  const lines = widget.render(40);
  widget.invalidate();
  assert.deepEqual(widget.render(40), lines);
  assert.ok(lines.length > 0);
  assert.ok(lines.every((line) => visibleWidth(line) <= 40));
});

test("settings reject duplicate shortcut modifiers and invalid legacy settings without writing", async () => {
  assert.equal(normalizeKeyId("ctrl+ctrl+p"), undefined);
  const directory = await mkdtemp(join(tmpdir(), "pm-value-boundaries-"));
  try {
    const settingsPath = join(directory, "canonical.json");
    const legacySettingsPath = join(directory, "legacy.json");
    await writeFile(legacySettingsPath, "broken");
    await assert.rejects(
      updatePlanModeSettings({ thinkingLevel: "high" }, { settingsPath, legacySettingsPath }),
      /legacy.json.*invalid JSON/,
    );
    assert.equal(await readFile(legacySettingsPath, "utf8"), "broken");
    await assert.rejects(readFile(settingsPath), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("export failures are visible headlessly and never overwrite or create invalid targets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pm-export-boundaries-"));
  try {
    const context = createMockContext({ cwd: directory, hasUI: false });
    await assert.rejects(
      exportStoredPlan({ enabled: false, awaitingAction: false }, undefined, context.ctx),
      /No completed plan/,
    );
    const interactive = createMockContext({ cwd: directory, hasUI: true });
    assert.equal(await exportStoredPlan({ enabled: false, awaitingAction: false }, undefined, interactive.ctx), false);
    assert.match(interactive.notifications.at(-1)?.message ?? "", /No completed plan/);
    assert.equal(interactive.notifications.at(-1)?.level, "warning");
    await assert.rejects(exportPlanToFile("# Plan", "x".repeat(300), directory), /ENAMETOOLONG/);
    const state = { enabled: true, awaitingAction: true, latestPlan: "# Plan" };
    assert.throws(() => resolvePlanExportPath("bad\0path", directory), /NUL/);
    await writeFile(join(directory, "blocker"), "owned");
    await assert.rejects(exportPlanToFile("# Plan", "blocker/plan.md", directory), /ENOTDIR|EEXIST/);
    await assert.rejects(exportStoredPlan(state, "blocker/plan.md", context.ctx), /ENOTDIR|EEXIST/);
    const aborted = new AbortController();
    aborted.abort(new Error("cancelled by owner"));
    await assert.rejects(exportPlanToFile("# Plan", "cancelled.md", directory, aborted.signal), /cancelled by owner/);
    await assert.rejects(readFile(join(directory, "cancelled.md")), /ENOENT/);
    await exportPlanToFile("# Plan", "default-current.md", directory);
    assert.equal(await readFile(join(directory, "default-current.md"), "utf8"), "# Plan\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
