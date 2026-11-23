/**
 * Confirmation evidence: who may turn a quota-looking failure into an exhaustion mark.
 *
 * Each provider runs an ordered chain of adapters. An adapter answers `block` (mark this
 * scope), `clear` (authoritative "not blocked": stop) or `abstain` (no opinion: ask the next
 * one). A fresh usage read is one adapter; the failure text is another. A collected provider
 * keeps read-only confirmation by default, because its read always answers block or clear.
 * Uncollected providers, and collected ids used with an API key, reach the failure adapter.
 *
 * Failure-inferred thresholds: a daily or spend-window token, a 402/billing failure, or a
 * retry hint of at least `minHintSeconds` (default 60) marks on the first failure. A bare quota
 * status marks on the second distinct failure of that model within 10 minutes, with no success
 * between. Per-minute throttles, weak gate matches, auth (401/403), 5xx, transport and safety
 * failures never mark, read included. A raised `minHintSeconds` narrows inference only.
 * Inferred marks end at 24 hours for daily windows and 60 minutes otherwise; `maxBlockMinutes`
 * lowers every end, the billing and unknown-shape backoff included.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ProviderConfig } from "./config.ts";
import { classify } from "./failure.ts";
import { type ModelRef, refKey } from "./model-ref.ts";
import { NO_USAGE_SOURCE, type UsageDecision, type UsageSnapshot } from "./usage.ts";

const MINUTE = 60_000;
/** Longest inferred mark for a daily (calendar) window. */
export const MAX_DAILY_BLOCK_MS = 24 * 60 * MINUTE;
/** Longest inferred mark for every other expiry with a known end. */
export const MAX_BLOCK_MS = 60 * MINUTE;
const DEFAULT_MIN_HINT_SECONDS = 60;
const DEFAULT_REPEAT = { count: 2, withinMinutes: 10 } as const;

/** The failure being confirmed. `failedAt` is the failed message's timestamp. */
export interface FailureContext {
	model: ModelRef;
	failedAt: number;
	signal?: AbortSignal;
	message?: Pick<AssistantMessage, "errorMessage" | "stopReason" | "timestamp">;
}

/** A block decision with its provenance. Read-confirmed decisions carry none of the extra fields. */
export type EvidenceDecision = UsageDecision & {
	evidence?: "inferred" | "observed";
	expiry?: "hinted" | "window-reset" | "backoff";
	cause?: "quota" | "billing";
	/** The failure this decision is about; a mark made at or after it is not re-counted. */
	evidenceAt?: number;
	/** Longest backoff for a decision without a deadline, from the provider's `maxBlockMinutes`. */
	maxBlockMs?: number;
};

/** The hint floor for `settings`: `minHintSeconds`, default 60 seconds. */
function minHintMs(settings: ProviderConfig["failure"] = {}): number {
	return (settings.minHintSeconds ?? DEFAULT_MIN_HINT_SECONDS) * 1000;
}

export type Evidence = { kind: "block"; decision: EvidenceDecision } | { kind: "clear" } | { kind: "abstain" };

/** One evidence source. `decide` must not reject. */
export interface ConfirmationEvidence {
	name: "read" | "failure" | "observed";
	decide(failure: FailureContext): Promise<Evidence>;
}

const CLEAR: Evidence = { kind: "clear" };
const ABSTAIN: Evidence = { kind: "abstain" };

/** Run `chain` in order: the first block or clear wins; all abstaining confirms nothing. */
export function composeEvidence(
	chain: readonly ConfirmationEvidence[],
): (failure: FailureContext) => Promise<EvidenceDecision | undefined> {
	return async (failure) => {
		for (const adapter of chain) {
			if (failure.signal?.aborted) return undefined;
			const evidence = await adapter.decide(failure);
			if (evidence.kind === "block") return evidence.decision;
			if (evidence.kind === "clear") return undefined;
		}
		return undefined;
	};
}

/**
 * Never-mark rules: auth (401/403), 5xx, transport, safety, per-minute and weak (a stray gate match
 * with no quota verdict, S15) failures, whatever their wording. Checked before any adapter, so not
 * even a collected provider's read can mark one: a weak match never reads.
 */
export function neverMarks({ message, failedAt }: FailureContext, settings?: ProviderConfig["failure"]): boolean {
	if (message?.stopReason !== "error") return false;
	// S7 fixes the never-mark line at a 60-second hint. A lower `minHintSeconds` lowers it; a higher
	// one only narrows what the failure adapter infers, never the authoritative read (S1, S6).
	const floor = Math.min(minHintMs(settings), DEFAULT_MIN_HINT_SECONDS * 1000);
	const found = classify(message.errorMessage, failedAt, floor);
	return found.class === "not-quota" || found.class === "per-minute" || found.class === "weak";
}

/** The read the `read` adapter needs: an exact snapshot plus the per-model decision on it. */
export interface UsageRead {
	get(provider: string, options: { fresh: true; notBefore: number; signal?: AbortSignal }): Promise<UsageSnapshot>;
	decisionFor(model: ModelRef, snapshot: UsageSnapshot): UsageDecision;
}

/**
 * A fresh usage read taken at or after the failure. An available read is authoritative either
 * way. No usage source (no collector, or an API-key credential) abstains. Any other read, failed,
 * stale, older, credential-less or from a collector retired mid-read, clears, unless
 * `fallbackOnReadError` lets the next adapter decide.
 */
export function readEvidence(usage: UsageRead, fallbackOnReadError = false): ConfirmationEvidence {
	return {
		name: "read",
		async decide({ model, failedAt, signal }) {
			const snapshot = await usage.get(model.provider, { fresh: true, notBefore: failedAt, signal });
			if (NO_USAGE_SOURCE in snapshot) return ABSTAIN;
			if (snapshot.status !== "available" || snapshot.retrievedAt < failedAt) {
				return fallbackOnReadError ? ABSTAIN : CLEAR;
			}
			// Pass the decision object through: it carries the collector's lifetime signal.
			const decision = usage.decisionFor(model, snapshot);
			return decision.block ? { kind: "block", decision } : CLEAR;
		},
	};
}

/**
 * Distinct failures per model since its last success, for the repeat threshold. Shared like
 * the exhaustion tracker, so in-process sessions count one model's failures together. One
 * failure (same model and message timestamp) counts once however many paths confirm it.
 * Each model keeps a success watermark, so a confirmation that finishes after a later success
 * cannot resurrect the failure that success erased.
 */
export class FailureHistory {
	private readonly failures = new Map<string, number[]>();
	private readonly successes = new Map<string, number>();

	/** Whether a success at or after `failedAt` already superseded this failure. */
	superseded(model: ModelRef, failedAt: number): boolean {
		return failedAt <= (this.successes.get(refKey(model)) ?? -Infinity);
	}

	/**
	 * Record a failure and return how many distinct failures fall within `windowMs` of it.
	 * A superseded failure is not recorded and counts zero.
	 */
	record(model: ModelRef, failedAt: number, windowMs: number): number {
		if (this.superseded(model, failedAt)) return 0;
		const key = refKey(model);
		const kept = (this.failures.get(key) ?? []).filter((at) => at > failedAt - windowMs);
		if (!kept.includes(failedAt)) kept.push(failedAt);
		this.failures.set(key, kept);
		return kept.filter((at) => at <= failedAt).length;
	}

	/** A successful response resets the count for failures at or before it. */
	succeeded(model: ModelRef, at: number): void {
		const key = refKey(model);
		this.successes.set(key, Math.max(at, this.successes.get(key) ?? -Infinity));
		const kept = this.failures.get(key)?.filter((failedAt) => failedAt > at);
		if (kept?.length) this.failures.set(key, kept);
		else this.failures.delete(key);
	}

	/** Forget every count, e.g. from `/router reset`. */
	clear(): void {
		this.failures.clear();
		this.successes.clear();
	}
}

/** Classify the failure text and apply this provider's thresholds and caps. */
export function failureEvidence(
	history: FailureHistory,
	settings: ProviderConfig["failure"] = {},
): ConfirmationEvidence {
	const floor = minHintMs(settings);
	const repeat = settings.repeat ?? DEFAULT_REPEAT;
	const configuredCap = settings.maxBlockMinutes === undefined ? Infinity : settings.maxBlockMinutes * MINUTE;
	const cap = (failedAt: number, end: number, classCap: number) =>
		Math.min(end, failedAt + Math.min(classCap, configuredCap));
	// Without a deadline the tracker backs off; a configured cap shortens that backoff too.
	const backoff = {
		expiry: "backoff",
		...(Number.isFinite(configuredCap) ? { maxBlockMs: configuredCap } : {}),
	} as const;
	return {
		name: "failure",
		async decide({ model, failedAt, message }) {
			if (message?.stopReason !== "error") return ABSTAIN;
			// A later success of this model already disproved the failure.
			if (history.superseded(model, failedAt)) return CLEAR;
			const found = classify(message.errorMessage, failedAt, floor);
			const base = { block: true, evidence: "inferred", evidenceAt: failedAt } as const;
			const modelScope = { scope: "model" as const, families: [model.id], cause: "quota" as const };
			switch (found.class) {
				case "billing":
					return {
						kind: "block",
						decision: { ...base, ...backoff, window: "inferred:billing", scope: "provider", cause: "billing" },
					};
				case "daily":
					return {
						kind: "block",
						decision: {
							...base,
							...modelScope,
							window: "inferred:daily",
							resetAt: cap(failedAt, found.resetAt, MAX_DAILY_BLOCK_MS),
							expiry: "window-reset",
						},
					};
				case "rolling":
					return {
						kind: "block",
						decision: {
							...base,
							...modelScope,
							window: "inferred:rolling",
							resetAt: cap(failedAt, found.resetAt, MAX_BLOCK_MS),
							expiry: "window-reset",
						},
					};
				case "hinted":
					return {
						kind: "block",
						decision: {
							...base,
							...modelScope,
							window: "inferred:hint",
							resetAt: cap(failedAt, failedAt + found.hintMs, MAX_BLOCK_MS),
							expiry: "hinted",
						},
					};
				case "unknown-quota":
					if (history.record(model, failedAt, repeat.withinMinutes * MINUTE) < repeat.count) return ABSTAIN;
					return {
						kind: "block",
						decision: { ...base, ...modelScope, ...backoff, window: "inferred:backoff" },
					};
				default:
					// per-minute, weak and not-quota (auth, transport, safety) never mark.
					return CLEAR;
			}
		},
	};
}

/** Confirm one failure for `provider`: the never-mark rules first, then its evidence chain. */
export function confirmEvidence(
	usage: UsageRead,
	history: FailureHistory,
	provider: ProviderConfig | undefined,
): (failure: FailureContext) => Promise<EvidenceDecision | undefined> {
	const confirm = composeEvidence(evidenceChain(usage, history, provider));
	return async (failure) => (neverMarks(failure, provider?.failure) ? undefined : confirm(failure));
}

/**
 * The default chain is `read`, then `failure`. `observed` needs the request ledger, which is
 * not wired yet, so it is skipped wherever it appears.
 */
export function evidenceChain(
	usage: UsageRead,
	history: FailureHistory,
	provider: ProviderConfig | undefined,
): ConfirmationEvidence[] {
	const sources = provider?.evidence ?? ["read", "failure", "observed"];
	return sources.flatMap((source) =>
		source === "read"
			? [readEvidence(usage, provider?.fallbackOnReadError)]
			: source === "failure"
				? [failureEvidence(history, provider?.failure)]
				: [],
	);
}
