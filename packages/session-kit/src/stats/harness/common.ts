/**
 * Shared vocabulary for the Claude Code, Codex and OpenCode usage readers.
 *
 * Readers only ever project counts, timestamps, model/provider names and hashed IDs. Anything else
 * a transcript carries (text, tool arguments, cwd, titles, directory names) is never copied out of
 * the parsed row, so it cannot reach a cache, a snapshot or a diagnostic.
 */

import { type Call, type Harness, opaqueId, type Session } from "../load.ts";

/** One subscription quota reading, as persisted by the harness that observed it. */
export interface QuotaObservation {
	/** Who observed it, for display. */
	harness: Harness;
	/** Router provider name, so readings from different harnesses of one account merge. */
	provider: string;
	/** Provider-native limit bucket, e.g. Codex `limit_id`. */
	limitId: string;
	/** Router window name: `5h`, `7d`, or `<seconds>s`. */
	window: string;
	/** 0-100, as reported. */
	usedPercent: number;
	/** Epoch ms the window resets. */
	resetAt: number;
	/** Full window length in ms. */
	durationMs: number;
	/** Epoch ms of the reading. */
	observedAt: number;
	planType: string | null;
}

/** What one reader found. Diagnostics are counts only: no paths, names or row content. */
export interface HarnessScan {
	/** The harness's data root exists on this machine. Absent is silent, never an error. */
	found: boolean;
	calls: Call[];
	/** Top-level sessions with a counted call. Child sessions are in `sessionMetadata` only. */
	sessions: Session[];
	sessionMetadata: Session[];
	quota: QuotaObservation[];
	problems: string[];
}

export const emptyScan = (found: boolean, problems: string[] = []): HarnessScan => ({
	found,
	calls: [],
	sessions: [],
	sessionMetadata: [],
	quota: [],
	problems,
});

/** `<harness>:<native id>`: never the native ID itself. */
export const entryHash = (harness: Harness, native: string): string => opaqueId(`${harness}:${native}`);
export const sessionHash = (harness: Harness, native: string): string => opaqueId(`${harness}-session:${native}`);

export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** `value` as a record, or an empty one. */
export const asRecordOf = (value: unknown): Record<string, unknown> => asRecord(value) ?? {};

export const str = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Token counters from raw fields. Absent (`undefined`/`null`) counts as 0; anything else that is not
 * a non-negative safe integer makes the whole record unreadable (`null`).
 */
export function counters(values: readonly unknown[]): number[] | null {
	const out: number[] = [];
	for (const v of values) {
		if (v === undefined || v === null) out.push(0);
		else if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) out.push(v);
		else return null;
	}
	return out;
}

/** Router-style window name for a span in seconds. */
export const windowName = (seconds: number): string =>
	seconds === 604_800 ? "7d" : seconds === 18_000 ? "5h" : `${seconds}s`;

/** The diagnostic every reader emits for lines it could not read. */
export const unreadable = (harness: Harness, n: number): string[] =>
	n > 0 ? [`${harness}: ! ${n} unreadable lines`] : [];
