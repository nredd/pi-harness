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
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

/** Whether `carrier` ran on a substituted model. */
export const hasFallback = (carrier: FallbackCarrier | undefined): boolean =>
  carrier?.modelFallback !== undefined || carrier?.modelNote !== undefined || carrier?.modelTier !== undefined;

/** Plain tier/outcome flag, or `[fallback]`; group counts retain the same identity. */
export function fallbackFlagText(count = 1, carrier?: FallbackCarrier): string {
  const tier = carrier?.modelTier;
  const suffix = count > 1 ? ` x${count}` : "";
  return tier ? `[@${tier.tier}${tier.kind !== "routed" && tier.kind !== "static" ? ` ${tier.kind}` : ""}${suffix}]`
    : `[fallback${suffix}]`;
}

/** The themed flag for `carrier`, or "" when it did not fall back. */
export function fallbackFlag(theme: FlagTheme, carrier: FallbackCarrier | undefined, count = 1): string {
  return hasFallback(carrier) ? theme.fg("warning", fallbackFlagText(count, carrier)) : "";
}

/** What a flag degrades to when even it does not fit; plain so it cannot depend on a theme. */
const MINIMAL_FLAGS = ["[fb]", "!"] as const;

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
