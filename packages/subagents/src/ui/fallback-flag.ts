/**
 * fallback-flag.ts -- the ONE compact indicator for "this agent ran on another
 * model than configured", shared by every renderer that shows model info.
 *
 * Rows are `label + stats` clamped from the right, so anything appended after
 * unbounded text (a description, an error, a canonical model id) is the first
 * thing a narrow terminal cuts. The flag is therefore always rendered FIRST and
 * the rest is truncated around it. Renderers must use these helpers rather than
 * building their own marker; `test/fallback-flag-renderers.test.ts` walks every
 * renderer and fails the ones that do not.
 */
import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TierDisclosure } from "../model-tiers.js";

/** Minimal theme surface, so this module has no dependency on the widgets that use it. */
interface FlagTheme {
  fg(color: string, text: string): string;
}

/** Anything that can carry the fallback: a record, details or notice details. */
export interface FallbackCarrier {
  modelFallback?: unknown;
  modelNote?: string;
  modelTier?: TierDisclosure;
}

/** Whether this tier's answer differs from the member/profile admitted for it. */
function switchedWithinTier(tier: TierDisclosure): boolean {
  if (tier.kind !== "routed" && tier.kind !== "static") return false;
  const baseline = tier.kind === "routed" ? tier.admitted : tier.member;
  return baseline !== undefined && tier.answered !== undefined && tier.answered !== baseline;
}

/** Whether `carrier` needs an actionable fallback warning, not merely tier identity. */
export const hasFallback = (carrier: FallbackCarrier | undefined): boolean => {
  if (carrier?.modelFallback !== undefined) return true;
  const tier = carrier?.modelTier;
  if (!tier) return carrier?.modelNote !== undefined;
  return tier.kind === "unmapped" || tier.kind === "unavailable" || switchedWithinTier(tier);
};

/** Plain tier identity/outcome flag, or `[fallback]`; group counts retain the same identity. */
export function fallbackFlagText(count = 1, carrier?: FallbackCarrier): string {
  const tier = carrier?.modelTier;
  const suffix = count > 1 ? ` x${count}` : "";
  return tier ? `[@${tier.tier}${tier.kind !== "routed" && tier.kind !== "static" ? ` ${tier.kind}` : ""}${suffix}]`
    : `[fallback${suffix}]`;
}

/** The themed tier identity or actionable fallback flag for `carrier`. */
export function fallbackFlag(theme: FlagTheme, carrier: FallbackCarrier | undefined, count = 1): string {
  if (carrier?.modelTier) return theme.fg(hasFallback(carrier) ? "warning" : "dim", fallbackFlagText(count, carrier));
  return hasFallback(carrier) ? theme.fg("warning", fallbackFlagText(count, carrier)) : "";
}

/** What a flag degrades to when even it does not fit; plain so it cannot depend on a theme. */
const MINIMAL_FLAGS = ["[fb]", "!"] as const;

/**
 * Wrap control text into a fixed row budget while preserving both its opening
 * and final diagnosis around an explicit omitted-rows marker.
 */
export function boundedWrappedRows(text: string, width: number, maxRows: number, marker: string): string[] {
  const rows = wrapTextWithAnsi(text, width);
  const budget = Math.max(1, Math.trunc(maxRows));
  if (rows.length <= budget) return rows;
  if (budget === 1) return [stripTerminalSequences(truncateToWidth(marker, width, ""))];
  // Two rows have no room for a truthful omission marker, so retain the control
  // text's opening and diagnosis rather than exceeding the caller's budget.
  if (budget === 2) return [rows[0]!, rows.at(-1)!];

  // Reserve a row for the omission marker and favor the final rows: fallback
  // diagnoses live at the end, while the first row still names the control text.
  const firstCount = Math.max(1, Math.floor((budget - 1) / 2));
  const lastCount = budget - firstCount - 1;
  const omitted = rows.length - firstCount - lastCount;
  const omission = stripTerminalSequences(
    truncateToWidth(`${marker} ${omitted} more line${omitted === 1 ? "" : "s"}`, width, ""),
  );
  return [...rows.slice(0, firstCount), omission, ...rows.slice(-lastCount)];
}

/**
 * `prefix + flag + rest`, never wider than `width`, and the flag is never cut.
 *
 * Normal case: the prefix and the flag are reserved first and `rest` (a string,
 * or a function of the width left for it) is truncated to what remains.
 *
 * Narrow case, when `prefix + flag + " "` exceeds `width`: the prefix and then
 * the rest are dropped before the flag is. If the flag alone still does not
 * fit, it degrades to a plain `[fb]`, then `!`. Only a zero width renders
 * nothing.
 */
export function withLeadingFlag(
  prefix: string,
  flag: string,
  rest: string | ((inner: number) => string),
  width: number,
): string {
  const lead = flag ? `${prefix}${flag} ` : prefix;
  if (!flag || visibleWidth(lead) <= width) {
    const inner = Math.max(0, width - visibleWidth(lead));
    const body = typeof rest === "function" ? rest(inner) : truncateToWidth(rest, inner);
    return truncateToWidth(lead + body, width);
  }
  const flagWidth = visibleWidth(flag);
  if (flagWidth <= width) {
    const inner = width - flagWidth - 1;
    if (inner < 1) return flag;
    const body = typeof rest === "function" ? rest(inner) : truncateToWidth(rest, inner);
    return truncateToWidth(`${flag} ${body}`, width);
  }
  return MINIMAL_FLAGS.find(m => visibleWidth(m) <= width) ?? "";
}
