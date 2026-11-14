/**
 * Shared vocabulary for the Claude Code, Codex and OpenCode usage readers.
 *
 * Readers only ever project counts, timestamps, model/provider names and hashed IDs. Anything else
 * a transcript carries (text, tool arguments, cwd, titles, directory names) is never copied out of
 * the parsed row, so it cannot reach a cache, a snapshot or a diagnostic. The projection is counts,
 * timestamps, raw provider/model names, Codex quota labels and percentages, and hashed IDs.
 */

import { stat } from "node:fs/promises";
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
	/**
	 * Which account the reading belongs to: a salted hash computed locally from the harness's own account
	 * ID (never the ID, and the salt never leaves the machine), or `""` where the harness exposes none.
	 * `""` assumes a single account per harness; two accounts with no ID would merge.
	 */
	account: string;
}

/** A reading whose window has already reset says nothing about the current one. */
export const isExpired = (q: QuotaObservation, now: number): boolean => q.resetAt <= now;

/**
 * One reading per `(provider, limitId, window, account)`, whichever harness or machine saw it. A reading
 * that has not yet reset beats an expired one, then the freshest `observedAt` wins. Never summed. Ties
 * break on the serialized reading so the result does not depend on input order. An expired winner is
 * kept (the window has reset, with no newer reading) for the caller to show as such.
 */
export function mergeQuota(readings: Iterable<QuotaObservation>, now: number): QuotaObservation[] {
	const best = new Map<string, QuotaObservation>();
	const beats = (a: QuotaObservation, b: QuotaObservation): boolean =>
		isExpired(a, now) !== isExpired(b, now)
			? isExpired(b, now)
			: a.observedAt !== b.observedAt
				? a.observedAt > b.observedAt
				: JSON.stringify(a) > JSON.stringify(b);
	for (const q of readings) {
		const key = JSON.stringify([q.provider, q.limitId, q.window, q.account]);
		const prev = best.get(key);
		if (!prev || beats(q, prev)) best.set(key, q);
	}
	return [...best.values()];
}

/** Account discriminator: salted, so the ID cannot be recovered or matched across machines. */
export const accountHash = (salt: string, harness: Harness, native: string): string =>
	opaqueId(`${salt}\0${harness}-account\0${native}`);

/**
 * Whether a harness's data root is there. Only "does not exist" is `absent` (not installed, silent): any
 * other failure (permissions on a parent, I/O) is `unreadable`, so an installed harness that cannot be
 * reached is never mistaken for an uninstalled one.
 */
export async function probe(path: string, kind: "file" | "directory"): Promise<"found" | "absent" | "unreadable"> {
	try {
		const info = await stat(path);
		return (kind === "file" ? info.isFile() : info.isDirectory()) ? "found" : "absent";
	} catch (error) {
		return ["ENOENT", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code)) ? "absent" : "unreadable";
	}
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

/** Whether any counter field exists at all; none means the row's schema drifted, not that usage was zero. */
export const anyPresent = (values: readonly unknown[]): boolean => values.some((v) => v !== undefined && v !== null);

/** Router-style window name for a span in seconds. */
export const windowName = (seconds: number): string =>
	seconds === 604_800 ? "7d" : seconds === 18_000 ? "5h" : `${seconds}s`;

/** The diagnostic every reader emits for lines it could not read. */
export const unreadable = (harness: Harness, n: number): string[] =>
	n > 0 ? [`${harness}: ! ${n} unreadable lines`] : [];
