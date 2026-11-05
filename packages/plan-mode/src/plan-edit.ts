import { normalizePlanModeCompletion } from "./completion-tool.js";

/** Completion source recorded when the user replaces a ready or saved plan in their editor. */
export const PLAN_EDIT_SOURCE = "user_edit";
/** Hidden session message telling the model, once, how the user changed the plan. */
export const PLAN_EDIT_MESSAGE_TYPE = "plan-mode-plan-edit";
export const PLAN_EDIT_VERSION = 1;

/** Lines of unchanged context around each diff hunk, as in `diff -u`. */
const DIFF_CONTEXT_LINES = 3;
/** Above this many LCS cells the changed middle is reported as one replacement. */
const MAX_LCS_CELLS = 4_000_000;

export interface PlanEditDetails {
  version: typeof PLAN_EDIT_VERSION;
  source: typeof PLAN_EDIT_SOURCE;
  plan: string;
}

export type PlanEditReview =
  | { kind: "cancelled" }
  | { kind: "unchanged" }
  | { kind: "rejected"; error: string }
  | { kind: "edited"; plan: string };

/**
 * Classifies the editor result with the same normalization, empty-plan rejection and size limit
 * as `plan_mode_complete`. `undefined` is a cancelled editor.
 */
export function reviewEditedPlan(current: string, edited: string | undefined): PlanEditReview {
  if (edited === undefined) return { kind: "cancelled" };
  const normalized = normalizePlanModeCompletion({ plan: edited });
  if (!normalized.ok) return { kind: "rejected", error: normalized.error };
  if (normalized.plan === current) return { kind: "unchanged" };
  return { kind: "edited", plan: normalized.plan };
}

/** The hidden custom message announcing an edit, carrying a unified diff and the edited plan. */
export function createPlanEditMessage(before: string, after: string) {
  const diff = unifiedPlanDiff(before, after);
  const fence = "`".repeat(Math.max(3, longestBacktickRun(diff) + 1));
  return {
    customType: PLAN_EDIT_MESSAGE_TYPE,
    content: [
      "[PLAN EDITED BY USER]",
      "The user edited the plan in their editor. The edited plan replaces the earlier version; follow the edited version.",
      "Unified diff from the earlier version:",
      "",
      `${fence}diff`,
      diff,
      fence,
    ].join("\n"),
    display: false,
    details: { version: PLAN_EDIT_VERSION, source: PLAN_EDIT_SOURCE, plan: after } satisfies PlanEditDetails,
  };
}

type DiffLine = { kind: " " | "-" | "+"; text: string };

/** Line-based unified diff with `diff -u` hunk headers and three lines of context. */
export function unifiedPlanDiff(before: string, after: string): string {
  const lines = diffLines(before.split("\n"), after.split("\n"));
  return ["--- earlier plan", "+++ edited plan", ...formatHunks(lines)].join("\n");
}

function diffLines(before: readonly string[], after: readonly string[]): DiffLine[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  return [
    ...before.slice(0, start).map(unchanged),
    ...diffMiddle(before.slice(start, beforeEnd), after.slice(start, afterEnd)),
    ...before.slice(beforeEnd).map(unchanged),
  ];
}

function diffMiddle(before: readonly string[], after: readonly string[]): DiffLine[] {
  const removed = before.map((text): DiffLine => ({ kind: "-", text }));
  const added = after.map((text): DiffLine => ({ kind: "+", text }));
  if (before.length * after.length > MAX_LCS_CELLS) return [...removed, ...added];

  const width = after.length + 1;
  const lcs = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        before[i] === after[j]
          ? (lcs[(i + 1) * width + j + 1] as number) + 1
          : Math.max(lcs[(i + 1) * width + j] as number, lcs[i * width + j + 1] as number);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      lines.push(unchanged(before[i] as string));
      i += 1;
      j += 1;
    } else if ((lcs[(i + 1) * width + j] as number) >= (lcs[i * width + j + 1] as number)) {
      lines.push(removed[i] as DiffLine);
      i += 1;
    } else {
      lines.push(added[j] as DiffLine);
      j += 1;
    }
  }
  return [...lines, ...removed.slice(i), ...added.slice(j)];
}

function formatHunks(lines: readonly DiffLine[]): string[] {
  const oldBefore: number[] = [];
  const newBefore: number[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of lines) {
    oldBefore.push(oldLine);
    newBefore.push(newLine);
    if (line.kind !== "+") oldLine += 1;
    if (line.kind !== "-") newLine += 1;
  }

  const changed = lines.flatMap((line, index) => (line.kind === " " ? [] : [index]));
  const output: string[] = [];
  let next = 0;
  while (next < changed.length) {
    const first = changed[next] as number;
    let last = first;
    // Merge changes whose unchanged gap fits inside both hunks' context.
    while (next + 1 < changed.length && (changed[next + 1] as number) - last <= DIFF_CONTEXT_LINES * 2 + 1) {
      next += 1;
      last = changed[next] as number;
    }
    next += 1;
    const start = Math.max(0, first - DIFF_CONTEXT_LINES);
    const end = Math.min(lines.length, last + DIFF_CONTEXT_LINES + 1);
    const hunk = lines.slice(start, end);
    const oldCount = hunk.filter((line) => line.kind !== "+").length;
    const newCount = hunk.filter((line) => line.kind !== "-").length;
    // Plans are never empty, so every hunk holds at least one old and one new line.
    output.push(
      `@@ -${(oldBefore[start] as number) + 1},${oldCount} +${(newBefore[start] as number) + 1},${newCount} @@`,
      ...hunk.map((line) => `${line.kind}${line.text}`),
    );
  }
  return output;
}

function unchanged(text: string): DiffLine {
  return { kind: " ", text };
}

function longestBacktickRun(text: string) {
  return Math.max(0, ...(text.match(/`+/gu) ?? []).map((run) => run.length));
}
