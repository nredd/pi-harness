import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { QuestionnaireAnswer, QuestionnaireQuestion, RunQuestionnaireResult } from "@narumitw/pi-tui-kit";

export const PLAN_MODE_QUESTION_TOOL_NAME = "plan_mode_question";
export const MAX_PLAN_MODE_RESPONSE_LENGTH = 4_000;
export const REPROPOSAL_CONFIRMATION_MODE = "reproposal_confirmation";
export const REPROPOSAL_CONFIRMATION_OPTIONS = [
  { label: "Re-propose now", description: "Submit the revised plan for review." },
  { label: "Not yet", description: "Keep planning before another proposal." },
] as const;
export const REPROPOSAL_CONFIRMATION_QUESTION =
  "May I submit the revised plan for your review? This does not start implementation.";

export type PlanModeQuestionMode = typeof REPROPOSAL_CONFIRMATION_MODE;

export type PlanModeQuestionOption = {
  label: string;
  description?: string;
};

export type PlanModeQuestion = {
  id: string;
  header: string;
  question: string;
  options: PlanModeQuestionOption[];
};

export type PlanModeQuestionAnswer = {
  id: string;
  header: string;
  question: string;
  answer: string;
  wasCustom: boolean;
  optionIndex?: number;
  note?: string;
};

type PlanModeQuestionReason = "cancelled" | "ui_unavailable" | "plan_mode_inactive" | "invalid_input";

type PlanModeQuestionDetails = {
  cancelled: boolean;
  mode?: PlanModeQuestionMode;
  reason?: PlanModeQuestionReason;
  questions: PlanModeQuestion[];
  answers?: PlanModeQuestionAnswer[];
};

export const PLAN_MODE_QUESTION_PARAMS = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    mode: {
      type: "string",
      enum: [REPROPOSAL_CONFIRMATION_MODE],
      description:
        "Use reproposal_confirmation only to ask permission to submit a replacement plan after a declined proposal.",
    },
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      description: "Questions to show the user. Prefer 1 and do not exceed 3.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "header", "question", "options"],
        properties: {
          id: {
            type: "string",
            description: "Stable identifier for mapping answers (snake_case).",
          },
          header: {
            type: "string",
            description: "Short header label shown in the UI (12 or fewer chars).",
          },
          question: { type: "string", description: "Single-sentence prompt shown to the user." },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            description:
              "Provide 2-4 mutually exclusive choices. Put the recommended option first when there is a clear default.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "description"],
              properties: {
                label: { type: "string", description: "User-facing label (1-5 words)." },
                description: {
                  type: "string",
                  description: "One short sentence explaining impact/tradeoff if selected.",
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

type NormalizePlanModeQuestionParamsResult =
  | { ok: true; questions: PlanModeQuestion[]; mode?: PlanModeQuestionMode }
  | { ok: false; error: string };

export function normalizePlanModeQuestionParams(input: unknown): NormalizePlanModeQuestionParamsResult {
  if (!isRecord(input) || !Array.isArray(input.questions)) {
    return { ok: false, error: "questions must be an array" };
  }
  if (input.questions.length < 1 || input.questions.length > 3) {
    return { ok: false, error: "questions must contain 1-3 items" };
  }

  const mode =
    input.mode === undefined
      ? undefined
      : input.mode === REPROPOSAL_CONFIRMATION_MODE
        ? REPROPOSAL_CONFIRMATION_MODE
        : undefined;
  if (input.mode !== undefined && !mode) {
    return { ok: false, error: `mode must be ${REPROPOSAL_CONFIRMATION_MODE}` };
  }

  const questions: PlanModeQuestion[] = [];
  for (const [questionIndex, rawQuestion] of input.questions.entries()) {
    if (!isRecord(rawQuestion)) {
      return { ok: false, error: `question ${questionIndex + 1} must be an object` };
    }
    const id = stringField(rawQuestion.id);
    const header = stringField(rawQuestion.header);
    const question = stringField(rawQuestion.question);
    if (!id || !header || !question) {
      return {
        ok: false,
        error: `question ${questionIndex + 1} requires non-empty id, header, and question`,
      };
    }
    if (!Array.isArray(rawQuestion.options)) {
      return { ok: false, error: `question ${questionIndex + 1} options must be an array` };
    }
    if (rawQuestion.options.length < 2 || rawQuestion.options.length > 4) {
      return { ok: false, error: `question ${questionIndex + 1} options must contain 2-4 items` };
    }
    const options: PlanModeQuestionOption[] = [];
    for (const [optionIndex, rawOption] of rawQuestion.options.entries()) {
      if (!isRecord(rawOption)) {
        return {
          ok: false,
          error: `question ${questionIndex + 1} option ${optionIndex + 1} must be an object`,
        };
      }
      const label = stringField(rawOption.label);
      if (!label) {
        return {
          ok: false,
          error: `question ${questionIndex + 1} option ${optionIndex + 1} requires a label`,
        };
      }
      const description = stringField(rawOption.description);
      if (!description) {
        return {
          ok: false,
          error: `question ${questionIndex + 1} option ${optionIndex + 1} requires a description`,
        };
      }
      options.push({ label, description });
    }
    questions.push({ id, header, question, options });
  }
  if (mode) {
    if (questions.length !== 1) {
      return { ok: false, error: `${REPROPOSAL_CONFIRMATION_MODE} requires exactly one question` };
    }
    const question = questions[0];
    if (!question) throw new Error("Validated question unexpectedly missing");
    questions[0] = {
      ...question,
      question: REPROPOSAL_CONFIRMATION_QUESTION,
      options: [...REPROPOSAL_CONFIRMATION_OPTIONS],
    };
  }
  return { ok: true, questions, ...(mode ? { mode } : {}) };
}

export async function answerPlanModeQuestions(
  questions: PlanModeQuestion[],
  ctx: ExtensionContext,
  lifecycle: { isCurrent(): boolean; isEnabled(): boolean },
  mode?: PlanModeQuestionMode,
) {
  const answers = await askPlanModeQuestions(questions, ctx, () => lifecycle.isCurrent() && lifecycle.isEnabled());
  if (!lifecycle.isCurrent()) {
    return planModeQuestionCancelled(
      questions,
      "cancelled",
      "Plan-mode question cancelled because the session changed.",
      mode,
    );
  }
  if (!lifecycle.isEnabled()) {
    return planModeQuestionCancelled(
      questions,
      "plan_mode_inactive",
      "Plan-mode question cancelled because Plan mode is no longer active.",
      mode,
    );
  }
  if (!answers) {
    return planModeQuestionCancelled(questions, "cancelled", "User cancelled the Plan-mode question prompt.", mode);
  }
  return planModeQuestionAnswered(questions, answers, mode);
}

export async function askPlanModeQuestions(
  questions: PlanModeQuestion[],
  ctx: ExtensionContext,
  shouldContinue: () => boolean = () => true,
): Promise<PlanModeQuestionAnswer[] | undefined> {
  const { runQuestionnaire, sanitizeTerminalText } = await import("@narumitw/pi-tui-kit");
  if (!shouldContinue()) return undefined;
  const runnerQuestions: QuestionnaireQuestion<string>[] = questions.map((question, index) => ({
    id: String(index),
    header: displayText(question.header, `Question ${index + 1}`, sanitizeTerminalText),
    prompt: displayText(question.question, `Question ${index + 1}`, sanitizeTerminalText),
    options: question.options.map((option, optionIndex) => ({
      ...option,
      label: displayText(option.label, `Option ${optionIndex + 1}`, sanitizeTerminalText),
    })),
  }));
  const result = await runQuestionnaire(ctx, {
    questions: runnerQuestions,
    allowNotes: true,
    maxTextLength: MAX_PLAN_MODE_RESPONSE_LENGTH,
    signal: ctx.signal,
    isCurrent: shouldContinue,
  });
  if (!shouldContinue()) return undefined;
  return mapQuestionnaireResult(questions, result);
}

function mapQuestionnaireResult(
  questions: PlanModeQuestion[],
  result: RunQuestionnaireResult<string>,
): PlanModeQuestionAnswer[] | undefined {
  if (result.kind !== "submitted") return undefined;
  if (result.answers.length !== questions.length) {
    throw new Error("Questionnaire returned an incomplete answer set");
  }

  const answers = new Map<number, QuestionnaireAnswer<string>>();
  for (const answer of result.answers) {
    const index = Number(answer.questionId);
    if (!Number.isSafeInteger(index) || String(index) !== answer.questionId || !questions[index]) {
      throw new Error("Questionnaire returned an answer for an unknown question");
    }
    if (answers.has(index)) throw new Error("Questionnaire returned duplicate answers");
    if (answer.wasCustom) {
      if (answer.optionIndex !== undefined) {
        throw new Error("Questionnaire returned a custom answer with an option index");
      }
      if (!answer.answer.trim()) return undefined;
    } else if (answer.optionIndex === undefined || !questions[index]?.options[answer.optionIndex - 1]) {
      throw new Error("Questionnaire returned an invalid selected option");
    }
    answers.set(index, answer);
  }

  return questions.map((question, index) => {
    const answer = answers.get(index);
    if (!answer) throw new Error("Questionnaire returned an incomplete answer set");
    const answerText = answer.wasCustom
      ? answer.answer
      : (question.options[(answer.optionIndex ?? 0) - 1]?.label ?? answer.answer);
    return answerFor(question, answerText, {
      wasCustom: answer.wasCustom,
      optionIndex: answer.optionIndex,
      note: answer.note,
    });
  });
}

function displayText(value: string, fallback: string, sanitize: (value: string) => string): string {
  const sanitized = sanitize(value);
  return sanitized.trim() ? sanitized : fallback;
}

function answerFor(
  question: PlanModeQuestion,
  answer: string,
  options: { wasCustom: boolean; optionIndex?: number; note?: string },
): PlanModeQuestionAnswer {
  const result: PlanModeQuestionAnswer = {
    id: question.id,
    header: question.header,
    question: question.question,
    answer,
    wasCustom: options.wasCustom,
  };
  if (options.optionIndex !== undefined) result.optionIndex = options.optionIndex;
  if (options.note !== undefined) result.note = options.note;
  return result;
}

export function planModeQuestionAnswered(
  questions: PlanModeQuestion[],
  answers: PlanModeQuestionAnswer[],
  mode?: PlanModeQuestionMode,
) {
  return {
    content: [{ type: "text" as const, text: formatPlanModeQuestionPayload({ cancelled: false, answers, mode }) }],
    details: { cancelled: false, questions, answers, ...(mode ? { mode } : {}) } satisfies PlanModeQuestionDetails,
  };
}

/** Only the canonical first option in explicit confirmation mode permits a re-proposal. */
export function isReproposalConfirmed(result: { details: PlanModeQuestionDetails }) {
  const answer = result.details.answers?.[0];
  return (
    result.details.cancelled === false &&
    result.details.mode === REPROPOSAL_CONFIRMATION_MODE &&
    answer?.wasCustom === false &&
    answer.optionIndex === 1
  );
}

export function planModeQuestionCancelled(
  questions: PlanModeQuestion[],
  reason: PlanModeQuestionReason,
  message: string,
  mode?: PlanModeQuestionMode,
) {
  return {
    content: [
      {
        type: "text" as const,
        text: formatPlanModeQuestionPayload({ cancelled: true, reason, message, mode }),
      },
    ],
    details: { cancelled: true, reason, questions, ...(mode ? { mode } : {}) } satisfies PlanModeQuestionDetails,
  };
}

function formatPlanModeQuestionPayload(payload: {
  cancelled: boolean;
  reason?: PlanModeQuestionReason;
  message?: string;
  answers?: PlanModeQuestionAnswer[];
  mode?: PlanModeQuestionMode;
}) {
  return JSON.stringify(payload, null, 2);
}

type PlanModeQuestionRenderResult = {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
};

/** A one-line-per-row component; core folds and truncates collapsed rows itself. */
function textLines(lines: string[]): Component {
  return { render: () => lines, invalidate() {} };
}

/**
 * `renderCall`: the first line is what Pi core folds into the collapsed row, so it carries the
 * question headers (`plan question · Scope, Tests`).
 */
export function renderPlanModeQuestionCall(args: unknown): Component {
  return textLines([planModeQuestionCallSummary(args)]);
}

export function planModeQuestionCallSummary(args: unknown): string {
  const questions = isRecord(args) && Array.isArray(args.questions) ? args.questions : [];
  const headers = questions
    .map((question) => (isRecord(question) ? stringField(question.header) : undefined))
    .filter((header): header is string => Boolean(header));
  return headers.length > 0 ? `plan question \u00b7 ${headers.join(", ")}` : "plan question";
}

/**
 * `renderResult`: collapsed -> `H1 \u2192 answer \u00b7 H2 \u2192 answer` or `cancelled (reason)`;
 * expanded -> every question with its options, the chosen one marked, and any notes.
 */
export function renderPlanModeQuestion(result: PlanModeQuestionRenderResult, options?: { expanded?: boolean }) {
  const text = options?.expanded ? planModeQuestionExpandedText(result) : planModeQuestionCollapsedText(result);
  return textLines(text.split("\n"));
}

export function planModeQuestionCollapsedText(result: PlanModeQuestionRenderResult): string {
  const details = isPlanModeQuestionDetails(result.details) ? result.details : undefined;
  if (!details) return singleLine(fallbackText(result));
  if (details.cancelled) return cancelledText(details);
  const answers = details.answers ?? [];
  if (answers.length === 0) return singleLine(fallbackText(result));
  return answers.map((answer) => `${answer.header} \u2192 ${singleLine(answer.answer)}`).join(" \u00b7 ");
}

export function planModeQuestionExpandedText(result: PlanModeQuestionRenderResult): string {
  const details = isPlanModeQuestionDetails(result.details) ? result.details : undefined;
  if (!details) return fallbackText(result);
  const lines: string[] = [];
  for (const [index, question] of details.questions.entries()) {
    const answer = details.answers?.[index];
    if (lines.length > 0) lines.push("");
    lines.push(`${question.header}: ${question.question}`);
    for (const [optionIndex, option] of question.options.entries()) {
      const chosen = answer !== undefined && !answer.wasCustom && answer.optionIndex === optionIndex + 1;
      lines.push(
        `  ${chosen ? "\u25cf" : "\u25cb"} ${option.label}${option.description ? ` -- ${option.description}` : ""}`,
      );
    }
    if (answer?.wasCustom) lines.push(`  \u25cf (custom) ${answer.answer}`);
    if (answer?.note?.trim()) lines.push(`  note: ${answer.note.trim()}`);
  }
  if (details.cancelled) lines.push("", cancelledText(details));
  return lines.join("\n");
}

function cancelledText(details: PlanModeQuestionDetails) {
  return details.reason ? `cancelled (${details.reason})` : "cancelled";
}

function singleLine(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function fallbackText(result: PlanModeQuestionRenderResult): string {
  return result.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function isPlanModeQuestionDetails(value: unknown): value is PlanModeQuestionDetails {
  return isRecord(value) && typeof value.cancelled === "boolean" && Array.isArray(value.questions);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: unknown) {
  return typeof value === "string" ? value.trim() : undefined;
}
