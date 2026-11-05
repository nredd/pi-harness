import assert from "node:assert/strict";
import { test } from "vitest";
import { PLAN_MODE_MAX_CHARS } from "../src/completion-tool.js";
import {
  createPlanEditMessage,
  PLAN_EDIT_MESSAGE_TYPE,
  PLAN_EDIT_SOURCE,
  PLAN_EDIT_VERSION,
  reviewEditedPlan,
  unifiedPlanDiff,
} from "../src/plan-edit.js";

const PLAN = "# Plan\n\n- One\n- Two";

test("editor results follow the plan_mode_complete limits", () => {
  assert.deepEqual(reviewEditedPlan(PLAN, undefined), { kind: "cancelled" });
  assert.deepEqual(reviewEditedPlan(PLAN, `\n${PLAN}\n\n`), { kind: "unchanged" });
  assert.deepEqual(reviewEditedPlan(PLAN, " \n\t"), { kind: "rejected", error: "plan must not be empty" });
  assert.deepEqual(reviewEditedPlan(PLAN, "x".repeat(PLAN_MODE_MAX_CHARS + 1)), {
    kind: "rejected",
    error: `plan must not exceed ${PLAN_MODE_MAX_CHARS} characters`,
  });
  assert.deepEqual(reviewEditedPlan(PLAN, `${PLAN}\n- Three\n`), { kind: "edited", plan: `${PLAN}\n- Three` });
  assert.deepEqual(reviewEditedPlan(PLAN, "x".repeat(PLAN_MODE_MAX_CHARS)), {
    kind: "edited",
    plan: "x".repeat(PLAN_MODE_MAX_CHARS),
  });
});

test("a single changed line produces one diff -u hunk with three lines of context", () => {
  const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].join("\n");
  const after = ["a", "b", "c", "d", "E", "f", "g", "h", "i"].join("\n");
  assert.equal(
    unifiedPlanDiff(before, after),
    ["--- earlier plan", "+++ edited plan", "@@ -2,7 +2,7 @@", " b", " c", " d", "-e", "+E", " f", " g", " h"].join(
      "\n",
    ),
  );
});

test("distant changes split into hunks and near changes merge", () => {
  const lines = Array.from({ length: 20 }, (_value, index) => `line ${index + 1}`);
  const distant = [...lines];
  distant[1] = "changed 2";
  distant[17] = "changed 18";
  const split = unifiedPlanDiff(lines.join("\n"), distant.join("\n")).split("\n");
  assert.deepEqual(
    split.filter((line) => line.startsWith("@@")),
    ["@@ -1,5 +1,5 @@", "@@ -15,6 +15,6 @@"],
  );

  const near = [...lines];
  near[4] = "changed 5";
  near[11] = "changed 12";
  const merged = unifiedPlanDiff(lines.join("\n"), near.join("\n")).split("\n");
  assert.deepEqual(
    merged.filter((line) => line.startsWith("@@")),
    ["@@ -2,14 +2,14 @@"],
  );
});

test("insertions and deletions at either end use diff -u zero-length ranges", () => {
  assert.equal(
    unifiedPlanDiff("only", "first\nonly"),
    ["--- earlier plan", "+++ edited plan", "@@ -1,1 +1,2 @@", "+first", " only"].join("\n"),
  );
  assert.equal(
    unifiedPlanDiff("a\nb", "a\nb\nc\nd"),
    ["--- earlier plan", "+++ edited plan", "@@ -1,2 +1,4 @@", " a", " b", "+c", "+d"].join("\n"),
  );
  assert.equal(
    unifiedPlanDiff("a\nb\nc\nd\ne", "e"),
    ["--- earlier plan", "+++ edited plan", "@@ -1,5 +1,1 @@", "-a", "-b", "-c", "-d", " e"].join("\n"),
  );
});

test("a reordered middle keeps the longest common subsequence", () => {
  assert.equal(
    unifiedPlanDiff("start\nx\ny\nz\nend", "start\ny\nz\nx\nend"),
    ["--- earlier plan", "+++ edited plan", "@@ -1,5 +1,5 @@", " start", "-x", " y", " z", "+x", " end"].join("\n"),
  );
});

test("an oversized rewrite falls back to one replacement hunk", () => {
  const before = Array.from({ length: 2_500 }, (_value, index) => `old ${index}`).join("\n");
  const after = Array.from({ length: 2_500 }, (_value, index) => `new ${index}`).join("\n");
  const diff = unifiedPlanDiff(before, after).split("\n");
  assert.equal(diff[2], "@@ -1,2500 +1,2500 @@");
  assert.equal(diff[3], "-old 0");
  assert.equal(diff[2_503], "+new 0");
  assert.equal(diff.length, 3 + 5_000);
});

test("the hidden edit message carries the diff in a fence longer than any backtick run", () => {
  const before = "# Plan\n\n```sh\nmake\n```";
  const after = "# Plan\n\n````sh\nmake check\n````";
  const message = createPlanEditMessage(before, after);
  assert.equal(message.customType, PLAN_EDIT_MESSAGE_TYPE);
  assert.equal(message.display, false);
  assert.deepEqual(message.details, { version: PLAN_EDIT_VERSION, source: PLAN_EDIT_SOURCE, plan: after });
  assert.match(message.content, /^\[PLAN EDITED BY USER\]\n/u);
  assert.ok(message.content.includes(`\`\`\`\`\`diff\n${unifiedPlanDiff(before, after)}\n\`\`\`\`\``));
  assert.ok(
    createPlanEditMessage("a", "b").content.endsWith(
      "```diff\n--- earlier plan\n+++ edited plan\n@@ -1,1 +1,1 @@\n-a\n+b\n```",
    ),
  );
});
