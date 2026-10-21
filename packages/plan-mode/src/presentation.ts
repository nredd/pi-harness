import {
  type ExtensionAPI,
  type ExtensionContext,
  getMarkdownTheme,
  type MessageRenderer,
  type MessageRenderOptions,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import { planTitle } from "./completion-tool.js";
import type { PlanModeState } from "./state.js";

const STATUS_KEY = "plan-mode";

/** `customType` of the transcript message that shows a proposed, saved, or active plan. */
export const PLAN_MESSAGE_TYPE = "proposed-plan";
export const PLAN_MESSAGE_VERSION = 1;

type PlanMessage = Parameters<MessageRenderer>[0];
type TextBlock = Extract<Exclude<PlanMessage["content"], string>[number], { type: "text" }>;

export type PlanMessageDetails = {
  version: typeof PLAN_MESSAGE_VERSION;
  title: string;
  plan: string;
};
const PLAN_WIDGET_KEY = "plan-mode-plan";
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

export function updatePlanModeUi(ctx: ExtensionContext, state: PlanModeState, toolSummary: () => string) {
  ctx.ui.setStatus(STATUS_KEY, formatStatus(state, ctx));
  // Kept deliberately minimal: the full tool policy and next-step guidance
  // are still one `/plan` away. The footer status chip (Codex-style,
  // accent-colored) is the sole indicator for "planning" and "implementing";
  // both are otherwise steady states with no immediate decision pending, so
  // an above-editor line would just duplicate the footer. Only "ready" and
  // "saved" -- states with a concrete pending action -- get a widget line.
  void toolSummary;
  let lines: string[] | undefined;
  if (state.enabled && state.latestPlan) {
    lines = ["Plan ready — /plan to implement, save, revise, or exit"];
  } else if (state.savedPlan) {
    lines = ["Plan saved — /plan to show, implement, or clear"];
  }

  publishPlanModeWidget(ctx, lines);
}

export function renderPlanModeWidget(lines: readonly string[], theme: Theme, width: number): string[] {
  const renderWidth = Math.max(0, width);
  return [
    theme.fg("borderMuted", "─".repeat(renderWidth)),
    ...lines.map((line) => truncateToWidth(sanitizePlanModeWidgetLine(line), renderWidth, "")),
  ];
}

export function sanitizePlanModeWidgetLine(value: string): string {
  let text = "";
  for (const character of stripTerminalSequences(value).replace(BIDI_CONTROLS, "")) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControl = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    text += isControl ? " " : character;
  }
  return text;
}

export function clearPlanModeUi(ctx: ExtensionContext) {
  ctx.ui.setStatus(STATUS_KEY, undefined);
  ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
}

export function showStoredPlan(pi: ExtensionAPI, ctx: ExtensionContext, state: PlanModeState) {
  const readyPlan = state.enabled ? state.latestPlan?.trim() : undefined;
  const savedPlan = state.savedPlan?.plan.trim();
  if (savedPlan && (ctx.mode === "print" || ctx.mode === "json")) {
    throw new Error("Saved plan display is unavailable in print/JSON mode. Use TUI or RPC.");
  }
  const activePlan = state.activeImplementation?.plan.trim();
  const plan = readyPlan ?? savedPlan ?? activePlan;
  if (!plan) {
    ctx.ui.notify("No completed plan is available. Use /plan finalize when planning is complete.", "info");
    return;
  }
  const title = readyPlan ? "Proposed Plan" : savedPlan ? "Saved Plan" : "Active Implementation Plan";
  showPlanModePlan(pi, ctx, title, plan);
}

export function showPlanModePlan(pi: ExtensionAPI, ctx: ExtensionContext, title: string, plan: string) {
  try {
    pi.sendMessage(
      {
        customType: PLAN_MESSAGE_TYPE,
        content: planMessageMarkdown(title, plan),
        display: true,
        details: { version: PLAN_MESSAGE_VERSION, title, plan } satisfies PlanMessageDetails,
      },
      { triggerTurn: false },
    );
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Unable to show completed plan: ${detail}`, "error");
  }
}

export function planMessageMarkdown(title: string, plan: string) {
  return `**${title}**\n\n${plan}`;
}

/**
 * Title and plan of a plan message. Prefers `details`; older sessions persisted only the
 * `**Title**\n\nplan` content, so that shape is parsed as a fallback.
 */
export function planMessageParts(message: Pick<PlanMessage, "content" | "details">): PlanMessageDetails {
  const details = message.details;
  if (
    isRecord(details) &&
    details.version === PLAN_MESSAGE_VERSION &&
    typeof details.title === "string" &&
    typeof details.plan === "string"
  ) {
    return { version: PLAN_MESSAGE_VERSION, title: details.title, plan: details.plan };
  }
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((block): block is TextBlock => block.type === "text")
          .map((block) => block.text)
          .join("\n");
  const match = /^\*\*(?<title>[^*\n]+)\*\*\n+(?<plan>[\s\S]*)$/u.exec(text.trim());
  if (match?.groups) {
    return { version: PLAN_MESSAGE_VERSION, title: match.groups.title.trim(), plan: match.groups.plan.trim() };
  }
  return { version: PLAN_MESSAGE_VERSION, title: "Plan", plan: text.trim() };
}

/**
 * Message renderer for `proposed-plan`. Collapsed (core's disclosure gutter keeps only the first
 * line) it is `<Title> · <plan heading>`; expanded it is the full plan as Markdown.
 */
export function renderPlanMessage(message: PlanMessage, options: MessageRenderOptions, theme: Theme): Component {
  const { title, plan } = planMessageParts(message);
  if (options.expanded) {
    return new Markdown(planMessageMarkdown(title, plan), options.outputPad, 0, getMarkdownTheme());
  }
  const heading = planTitle(plan);
  const line = `${theme.bold(title)}${heading === "plan" ? "" : `${theme.fg("muted", " · ")}${heading}`}`;
  return { render: () => [line], invalidate() {} };
}

export function planModeStatusText(state: PlanModeState, toolSummary: () => string) {
  if (state.enabled) {
    if (state.latestPlan) {
      return `Plan mode is active and a proposed plan is ready. ${toolSummary()}`;
    }
    return `Plan mode is active. ${toolSummary()} Explore, ask, and finish with plan_mode_complete when decision-ready.`;
  }
  if (state.savedPlan) return "A plan is saved for later.";
  if (state.activeImplementation) return "An implementation plan is active.";
  return "Plan mode is off.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publishPlanModeWidget(ctx: ExtensionContext, lines: readonly string[] | undefined) {
  if (!lines) {
    ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
    return;
  }
  if (ctx.mode !== "tui") {
    ctx.ui.setWidget(PLAN_WIDGET_KEY, [...lines]);
    return;
  }

  const snapshot = [...lines];
  ctx.ui.setWidget(PLAN_WIDGET_KEY, (_tui, theme) => ({
    render: (width) => renderPlanModeWidget(snapshot, theme, width),
    invalidate: () => {},
  }));
}

function formatStatus(state: PlanModeState, ctx: ExtensionContext) {
  let text: string | undefined;
  if (state.enabled) {
    text = state.awaitingAction || state.latestPlan ? "plan ready" : "plan active";
  } else if (state.savedPlan) {
    text = "plan saved";
  } else if (state.activeImplementation) {
    text = "plan implementing";
  }
  if (!text) return undefined;
  // Codex-style: accent-colored so the footer chip reads as a mode indicator
  // rather than blending into the rest of the status line. Headless sessions (print, JSON, SDK)
  // have no initialized theme, and the status is invisible there anyway.
  if (!ctx.hasUI) return text;
  try {
    return ctx.ui.theme.fg("accent", text);
  } catch {
    return text;
  }
}
