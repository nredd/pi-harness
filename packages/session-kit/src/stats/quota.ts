/**
 * Quota presentation for `/stats`: pure functions over the merged readings. Readings come from local
 * and imported files only; nothing here fetches. A reading whose window has reset says nothing about the
 * current one, so it renders as "reset, no newer reading" with no percentage (unknown, not the old value).
 */

import { duration } from "./format.ts";
import { isExpired, type QuotaObservation } from "./harness/common.ts";

/** A reading older than this renders dimmed. */
export const QUOTA_DIM_AFTER_MS = 15 * 60_000;
/** Shown for a provider whose harness persists no quota. */
export const NO_LOCAL_READING = "no local reading";
const BAR_CELLS = 10;

export interface QuotaRow {
	/** `provider[/limit] window`, plus an account tag when the same window has readings for several. */
	label: string;
	/** The window has reset since the reading: no percentage is known. */
	expired: boolean;
	usedPercent: number;
	/** `resets in 3h 12m`, or `reset 5m ago, no newer reading`. */
	reset: string;
	/** `observed 12m ago via codex` */
	observed: string;
	/** Observed more than `QUOTA_DIM_AFTER_MS` ago. */
	old: boolean;
}

/** `[#####-----]`-style gauge, `BAR_CELLS` cells wide; out-of-range percentages clamp. */
export function gauge(percent: number): string {
	const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * BAR_CELLS);
	return `${"█".repeat(filled)}${"░".repeat(BAR_CELLS - filled)}`;
}

/** One row per reading, ordered by provider, limit, then window length. Readings are already merged. */
export function quotaRows(readings: readonly QuotaObservation[], now: number): QuotaRow[] {
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
				usedPercent: q.usedPercent,
				reset: expired
					? `reset ${duration(now - q.resetAt)} ago, no newer reading`
					: `resets in ${duration(q.resetAt - now)}`,
				observed: `observed ${duration(Math.max(0, now - q.observedAt))} ago via ${q.harness}`,
				old: now - q.observedAt > QUOTA_DIM_AFTER_MS,
			};
		});
}

/** `47.3%`, or `100%` / `5%` without a pointless decimal. */
export const usedLabel = (percent: number): string => `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;

/** Claude Code persists no quota locally (see dotfiles#131): say so rather than show nothing. */
export const claudeHasNoReading = (readings: readonly QuotaObservation[], claudeSeen: boolean): boolean =>
	claudeSeen && !readings.some((q) => q.provider === "anthropic");
