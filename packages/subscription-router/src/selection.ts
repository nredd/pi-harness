/** Pure reset-aware ranking. Eligibility and quota confirmation remain the router's job. */
import type { Strategy } from "./config.js";
import type { ModelRef } from "./model-ref.js";
import { modelMatchesFamily, type UsageSnapshot } from "./usage.js";

/** A score is diagnostic only: it never blocks quota or refreshes usage. */
export type QuotaScore =
	| { kind: "unlimited" }
	| { kind: "measured"; score: number; window: string; roundoff?: number }
	| { kind: "fallback"; reason: string };

type MeasuredScore = Extract<QuotaScore, { kind: "measured" }>;

/** Rank applicable fresh windows by the tightest remaining quota per time left. */
export function scoreQuota(model: ModelRef, snapshot: UsageSnapshot | undefined, now: number): QuotaScore {
	if (!snapshot) return { kind: "fallback", reason: "usage missing" };
	if (snapshot.status !== "available" || snapshot.expiresAt <= now) {
		return { kind: "fallback", reason: `usage ${snapshot.status === "available" ? "stale" : snapshot.status}` };
	}
	if (snapshot.credits?.unlimited) return { kind: "unlimited" };
	let limiting: MeasuredScore | undefined;
	for (const window of snapshot.windows) {
		if (window.scope === "model" && !window.families?.some((family) => modelMatchesFamily(model.id, family))) continue;
		if (window.resetAt !== undefined && Number.isFinite(window.resetAt) && window.resetAt <= now) continue;
		if (!Number.isFinite(window.usedPercent) || window.usedPercent < 0) continue;
		const duration = window.durationMs;
		const timeLeft =
			window.resetAt !== undefined &&
			Number.isFinite(window.resetAt) &&
			duration !== undefined &&
			Number.isFinite(duration) &&
			duration > 0
				? Math.max(0.05, Math.min(1, (window.resetAt - now) / duration))
				: 1;
		const score = (1 - Math.min(window.usedPercent, 100) / 100) / timeLeft;
		// Subtracting utilization from one has absolute error even when remaining quota is tiny.
		if (!limiting || score < limiting.score)
			limiting = { kind: "measured", score, window: window.name, roundoff: (Number.EPSILON * 4) / timeLeft };
	}
	return limiting ?? { kind: "fallback", reason: "no applicable active windows" };
}

/** Strict ordering: unlimited, measured, fallback; equal values retain chain order. */
function better(a: QuotaScore, b: QuotaScore): boolean {
	if (a.kind === "unlimited") return b.kind !== "unlimited";
	if (b.kind === "unlimited" || a.kind === "fallback") return false;
	return b.kind === "fallback" || a.score > b.score;
}

/** Keep a mathematical 20% tie sticky despite quota-percentage floating-point roundoff. */
function beatsHysteresis(challenger: MeasuredScore, incumbent: MeasuredScore): boolean {
	if (incumbent.score === 0) return challenger.score > 0;
	const threshold = incumbent.score * 1.2;
	const roundoff =
		(Math.abs(challenger.score) + Math.abs(threshold)) * Number.EPSILON * 4 +
		(challenger.roundoff ?? 0) +
		(incumbent.roundoff ?? 0) * 1.2;
	return challenger.score - threshold > roundoff;
}

/** Select an eligible candidate index, optionally preserving a new prompt's incumbent. */
export function selectCandidate(
	scores: readonly QuotaScore[],
	strategy: Strategy = "ordered",
	incumbent?: number,
): number {
	const first = scores[0];
	if (!first) return -1;
	if (strategy === "ordered") return 0;
	let best = 0;
	let challenger = first;
	for (const [i, score] of scores.entries()) {
		if (better(score, challenger)) {
			best = i;
			challenger = score;
		}
	}
	const current = incumbent === undefined ? undefined : scores[incumbent];
	if (current && incumbent !== undefined) {
		if (current.kind === "unlimited") return incumbent;
		if (current.kind === "fallback" && challenger.kind === "fallback") return incumbent;
		if (current.kind === "measured" && challenger.kind === "measured" && !beatsHysteresis(challenger, current))
			return incumbent;
	}
	return best;
}

/** Human-readable status, deliberately never injected into the prompt. */
export function formatScore(score: QuotaScore): string {
	if (score.kind === "fallback") return `fallback: ${score.reason}`;
	if (score.kind === "unlimited") return "unlimited";
	return `score ${score.score.toFixed(3)}, limiting ${score.window}`;
}
