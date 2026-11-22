/**
 * Quota presentation for `/stats`: pure functions over the merged readings. Readings come from local
 * and imported files only; nothing here fetches. A reading whose window has reset says nothing about the
 * current one, so it renders as "reset, no newer reading" with no percentage (unknown, not the old value).
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { sanitize } from "../diff/view.ts";
import { duration } from "./format.ts";
import { isExpired, type QuotaObservation } from "./harness/common.ts";

/** A reading older than this renders dimmed. */
export const QUOTA_DIM_AFTER_MS = 15 * 60_000;
/** Shown for a provider whose harness persists no quota. */
export const NO_LOCAL_READING = "no local reading";
const BAR_CELLS = 10;
/** Widest quota label, in columns; longer labels end in `…` in both the overlay and print. */
export const QUOTA_LABEL_MAX = 160;

/** `text` with control characters made visible, cut to `max` columns ending in `…`; never adds ANSI codes. */
export function clipLabel(text: string, max: number): string {
	const clean = sanitize(text);
	if (visibleWidth(clean) <= max) return clean;
	let kept = "";
	let width = 0;
	for (const { segment } of new Intl.Segmenter().segment(clean)) {
		width += visibleWidth(segment);
		if (width > max - 1) break;
		kept += segment;
	}
	return `${kept}…`;
}

export interface QuotaRow {
	/** `provider[/limit] window`, plus an account tag when the same window has readings for several. */
	readonly label: string;
	/** The window has reset since the reading: no percentage is known. */
	readonly expired: boolean;
	readonly head:
		| { readonly kind: "gauge"; readonly percent: number }
		| { readonly kind: "text"; readonly text: string };
	readonly basis?: "reported" | "observed" | "inferred";
	/** `resets in 3h 12m`, or `reset 5m ago, no newer reading`. */
	readonly reset?: string;
	/** Legacy harness provenance, e.g. `observed 12m ago via codex`. */
	readonly observed?: string;
	/** Observed more than `QUOTA_DIM_AFTER_MS` ago. */
	readonly old: boolean;
}

/** `[#####-----]`-style gauge, `BAR_CELLS` cells wide; out-of-range percentages clamp. */
export function gauge(percent: number): string {
	const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * BAR_CELLS);
	return `${"█".repeat(filled)}${"░".repeat(BAR_CELLS - filled)}`;
}

/** One row per reading (see the filter for expired ones), ordered by provider, limit, then window length. Readings are already merged. */
export function quotaRows(allReadings: readonly QuotaObservation[], now: number): QuotaRow[] {
	const windowKey = (q: QuotaObservation) => JSON.stringify([q.provider, q.limitId, q.window]);
	const live = new Set(allReadings.filter((q) => !isExpired(q, now)).map(windowKey));
	// A window reset more than one window length ago is long stale; a reset one is moot beside a live
	// reading of the same window, whichever account it came from.
	const readings = allReadings.filter(
		(q) => !isExpired(q, now) || (now - q.resetAt <= q.durationMs && !live.has(windowKey(q))),
	);
	const base = (q: QuotaObservation) => `${q.provider}${q.limitId === q.provider ? "" : `/${q.limitId}`} ${q.window}`;
	const siblings = new Map<string, number>();
	for (const q of readings) siblings.set(base(q), (siblings.get(base(q)) ?? 0) + 1);
	return [...readings]
		.sort(
			(a, b) =>
				a.provider.localeCompare(b.provider) ||
				a.limitId.localeCompare(b.limitId) ||
				a.durationMs - b.durationMs ||
				a.account.localeCompare(b.account),
		)
		.map((q) => {
			const expired = isExpired(q, now);
			// An account tag only where it tells readings apart; the hash is salted, so a prefix leaks nothing.
			const tag = (siblings.get(base(q)) as number) > 1 ? ` acct ${q.account.slice(0, 4) || "none"}` : "";
			return {
				label: `${base(q)}${tag}`,
				expired,
				head: expired ? { kind: "text", text: "" } : { kind: "gauge", percent: q.usedPercent },
				basis: "reported",
				reset: expired
					? `reset ${duration(now - q.resetAt)} ago, no newer reading`
					: `resets in ${duration(q.resetAt - now)}`,
				observed: `observed ${duration(Math.max(0, now - q.observedAt))} ago via ${q.harness}`,
				old: now - q.observedAt > QUOTA_DIM_AFTER_MS,
			};
		});
}

/** Preserve legacy harness provenance; router rows use the view's explicit evidence basis. */
export function quotaDetails(row: QuotaRow): string[] {
	if (row.observed !== undefined && row.reset !== undefined) return [row.reset, row.observed];
	return [row.basis, row.reset].filter((detail) => detail !== undefined);
}

/** `47.3%`, or `100%` / `5%` without a pointless decimal. */
export const usedLabel = (percent: number): string => `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;

/** Claude without a valid local capture or imported reading: say so rather than invent usage. */
export const claudeHasNoReading = (readings: readonly QuotaObservation[], claudeSeen: boolean): boolean =>
	claudeSeen && !readings.some((q) => q.provider === "anthropic");
