/** Version 1's bounded, pure policy calculus. No I/O, clocks, randomness or observation mutation. */
import type { Profile, Strategy } from "./config.js";
import { type ModelRef, refKey } from "./model-ref.js";
import { type QuotaScore, STALE_GRACE_MS, scoreQuota, selectCandidate } from "./selection.js";
import { modelMatchesFamily, type UsageSnapshot } from "./usage.js";

export type WindowSelector = "binding" | { name: string };
export type OrderKey =
	| { metric: "remaining"; window: WindowSelector; direction: "desc" }
	| { metric: "chain-index"; direction: "asc" };
export type PolicyV1 =
	| { version: 1; kind: "strict-priority" }
	| { version: 1; kind: "remaining-balanced"; switchMargin?: number; stickiness?: "none" | "continuation" }
	| { version: 1; kind: "lexicographic"; by: OrderKey[]; switchMargin?: number; stickiness?: "none" | "continuation" };

/** Unknown is explicit, never coerced to eligibility by truthiness. */
export type FilterResult =
	| { outcome: "pass" }
	| { outcome: "reject"; reason: string; recheckAt?: number }
	| { outcome: "unknown"; reason: string; rule: "pass" | "reject" };
export interface SafetyFilter {
	name: "registered-authenticated" | "confirmed-quota" | "cached-exhaustion";
	result: FilterResult;
}
export interface PolicyMember {
	ref: ModelRef;
	index: number;
	filters: SafetyFilter[];
	snapshot?: UsageSnapshot;
}
export interface PolicyContext {
	reason: "user" | "direct" | "continuation" | "retry";
	previous?: string;
	caller?: "interactive" | "subagent" | "background" | "unknown";
	/** A transport retry is not a fresh allocation; confirmation is outside evaluation. */
	retryUnconfirmed?: string;
}
export interface CompiledPolicy {
	version: 1;
	legacy?: Strategy;
	by: readonly (OrderKey | { metric: "legacy-reset-headroom"; direction: "desc" })[];
	stickiness: "none" | "continuation" | "legacy-balanced";
	switchMargin: number;
}
export type Metric =
	| { kind: "unlimited" }
	| { kind: "measured"; value: number; limiters: string[] }
	| { kind: "unknown"; reason: string };

/** Strict object validation is confined to new syntax; legacy outer keys remain permissive. */
function object(raw: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path}: expected an object`);
	for (const key of Object.keys(raw))
		if (!keys.includes(key)) throw new Error(`${path}.${key}: unsupported in policy v1`);
	return raw as Record<string, unknown>;
}

/** Parse a closed, nonrecursive v1 expression with path-qualified errors. */
export function parsePolicy(raw: unknown, path: string): PolicyV1 {
	const node = object(raw, path, ["version", "kind", "by", "switchMargin", "stickiness"]);
	if (node.version !== 1) throw new Error(`${path}.version: expected 1`);
	if (node.kind === "strict-priority") {
		object(raw, path, ["version", "kind"]);
		return { version: 1, kind: node.kind };
	}
	if (node.kind !== "remaining-balanced" && node.kind !== "lexicographic")
		throw new Error(`${path}.kind: unsupported in policy v1`);
	if (node.kind === "remaining-balanced") object(raw, path, ["version", "kind", "switchMargin", "stickiness"]);
	const by: OrderKey[] = [];
	if (node.kind === "lexicographic") {
		if (!Array.isArray(node.by) || node.by.length === 0) throw new Error(`${path}.by: expected a non-empty array`);
		for (const [index, rawKey] of node.by.entries()) {
			const where = `${path}.by[${index}]`;
			const key = object(rawKey, where, ["metric", "direction", "window"]);
			if (key.metric === "chain-index") {
				object(rawKey, where, ["metric", "direction"]);
				if (key.direction !== "asc") throw new Error(`${where}.direction: expected asc`);
				if (index !== node.by.length - 1) throw new Error(`${path}.by: chain-index must be last`);
				by.push({ metric: "chain-index", direction: "asc" });
			} else if (key.metric === "remaining") {
				if (index !== 0) throw new Error(`${path}.by: remaining must be first and unique`);
				if (key.direction !== "desc") throw new Error(`${where}.direction: expected desc`);
				let window: WindowSelector = "binding";
				if (key.window !== "binding") {
					const selected = object(key.window, `${where}.window`, ["name"]);
					if (typeof selected.name !== "string" || selected.name.length === 0)
						throw new Error(`${where}.window.name: expected a non-empty string`);
					window = { name: selected.name };
				}
				by.push({ metric: "remaining", window, direction: "desc" });
			} else throw new Error(`${where}.metric: unsupported in policy v1`);
		}
	}
	const { switchMargin, stickiness } = node;
	if (switchMargin !== undefined) {
		if (typeof switchMargin !== "number" || !Number.isFinite(switchMargin) || switchMargin < 0 || switchMargin > 1)
			throw new Error(`${path}.switchMargin: expected finite number in [0,1]`);
		if (node.kind === "lexicographic" && by[0]?.metric !== "remaining")
			throw new Error(`${path}.switchMargin: requires a leading remaining metric`);
	}
	if (stickiness !== undefined && stickiness !== "none" && stickiness !== "continuation")
		throw new Error(`${path}.stickiness: expected none or continuation`);
	return {
		version: 1,
		kind: node.kind,
		...(node.kind === "lexicographic" ? { by } : {}),
		...(switchMargin === undefined ? {} : { switchMargin }),
		...(stickiness === undefined ? {} : { stickiness }),
	} as PolicyV1;
}

const CHAIN: OrderKey = { metric: "chain-index", direction: "asc" };
const REMAINING: OrderKey = { metric: "remaining", window: "binding", direction: "desc" };
const compiled = new WeakMap<Profile, CompiledPolicy>();

/** Compile once per immutable loaded profile; preserve legacy profile serialization. */
export function compilePolicy(profile: Profile): CompiledPolicy {
	const cached = compiled.get(profile);
	if (cached) return cached;
	const policy = profile.policy;
	let result: CompiledPolicy;
	if (!policy) {
		const legacy = profile.strategy ?? "ordered";
		result = {
			version: 1,
			legacy,
			by: legacy === "balanced" ? [{ metric: "legacy-reset-headroom", direction: "desc" }, CHAIN] : [CHAIN],
			stickiness: legacy === "balanced" ? "legacy-balanced" : "continuation",
			switchMargin: legacy === "balanced" ? 0.2 : 0,
		};
	} else {
		const by =
			policy.kind === "strict-priority"
				? [CHAIN]
				: policy.kind === "remaining-balanced"
					? [REMAINING, CHAIN]
					: [...policy.by];
		if (by[by.length - 1]?.metric !== "chain-index") by.push(CHAIN);
		result = {
			version: 1,
			by,
			stickiness:
				policy.kind === "strict-priority"
					? "none"
					: (policy.stickiness ?? (by[0]?.metric === "remaining" ? "continuation" : "none")),
			switchMargin: policy.kind === "strict-priority" ? 0 : (policy.switchMargin ?? 0),
		};
	}
	compiled.set(profile, result);
	return result;
}

/** Every applicable window, including inactive and invalid evidence, with no sensitive snapshot fields. */
function windows(member: PolicyMember, now: number) {
	return (member.snapshot?.windows ?? [])
		.filter(
			(window) =>
				window.scope !== "model" || window.families?.some((family) => modelMatchesFamily(member.ref.id, family)),
		)
		.map((window) => ({
			name: window.name,
			scope: window.scope,
			usedPercent: Number.isFinite(window.usedPercent) && window.usedPercent >= 0 ? window.usedPercent : null,
			remaining:
				Number.isFinite(window.usedPercent) && window.usedPercent >= 0
					? 1 - Math.min(window.usedPercent, 100) / 100
					: null,
			resetAt: window.resetAt !== undefined && Number.isFinite(window.resetAt) ? window.resetAt : null,
			durationMs: window.durationMs !== undefined && Number.isFinite(window.durationMs) ? window.durationMs : null,
			active: !(window.resetAt !== undefined && Number.isFinite(window.resetAt) && window.resetAt <= now),
		}));
}

/** Raw remaining, deliberately independent of reset duration or time left until expiry. */
export function remainingMetric(member: PolicyMember, selector: WindowSelector, now: number): Metric {
	const snapshot = member.snapshot;
	if (!snapshot) return { kind: "unknown", reason: "usage missing" };
	if (snapshot.status !== "available" && snapshot.status !== "stale")
		return { kind: "unknown", reason: `usage ${snapshot.status}` };
	const expired = snapshot.status === "stale" || snapshot.expiresAt <= now;
	if (expired && Math.max(0, now - snapshot.retrievedAt) > STALE_GRACE_MS)
		return { kind: "unknown", reason: "usage stale" };
	if (!expired && snapshot.credits?.unlimited) return { kind: "unlimited" };
	const selected = windows(member, now).filter(
		(window) => window.active && window.remaining !== null && (selector === "binding" || window.name === selector.name),
	);
	if (!selected.length) return { kind: "unknown", reason: "no applicable active windows" };
	const value = Math.min(...selected.map((window) => window.remaining as number));
	return {
		kind: "measured",
		value,
		limiters: selected.filter((window) => window.remaining === value).map((window) => window.name),
	};
}

/** Knowledge is ordered before numeric value; unknown remains an eligible fallback. */
function rank(metric: Metric): number {
	return metric.kind === "unlimited" ? 2 : metric.kind === "measured" ? 1 : 0;
}

/** Positive-margin prompt hysteresis; exact zero disables even incumbent tie retention. */
function keepIncumbent(best: Metric, current: Metric, margin: number): boolean {
	if (rank(best) !== rank(current)) return rank(best) < rank(current);
	if (best.kind !== "measured" || current.kind !== "measured") return true;
	if (current.value === 0) return best.value === 0;
	const threshold = (1 + margin) * current.value;
	const d = 4 * Number.EPSILON;
	const error = d * (Math.abs(best.value) + Math.abs(threshold)) + d + (1 + margin) * d;
	return best.value - threshold <= error;
}

/** Evaluate captured safety verdicts, sticky boundary, lex order and prompt hysteresis in that order. */
export function evaluatePolicy(
	policy: CompiledPolicy,
	members: readonly PolicyMember[],
	now: number,
	context: PolicyContext,
) {
	const rows = members.map((member) => {
		const snapshot = member.snapshot;
		const legacyScore = scoreQuota(member.ref, snapshot, now);
		const metric = policy.by[0]?.metric === "remaining" ? remainingMetric(member, policy.by[0].window, now) : undefined;
		return {
			model: refKey(member.ref),
			index: member.index,
			filters: member.filters,
			eligible: member.filters.every(
				({ result }) => result.outcome === "pass" || (result.outcome === "unknown" && result.rule === "pass"),
			),
			snapshot: {
				status: snapshot?.status ?? "missing",
				ageMs: snapshot ? Math.max(0, now - snapshot.retrievedAt) : null,
				expiresAt: snapshot?.expiresAt ?? null,
				ttlMs: 300_000,
				graceMs: STALE_GRACE_MS,
				futureRetrieval: snapshot ? snapshot.retrievedAt > now : false,
			},
			windows: windows(member, now),
			legacyScore,
			tuple: metric
				? [metric, member.index]
				: policy.legacy === "balanced"
					? [legacyScore, member.index]
					: [member.index],
			metric,
		};
	});
	const eligible = rows.filter((row) => row.eligible);
	const incumbent = eligible.find((row) => row.model === context.previous);
	let selected = eligible[0];
	let override = "none";
	if (policy.legacy) {
		selected =
			eligible[
				selectCandidate(
					eligible.map((row) => row.legacyScore),
					policy.legacy,
					context.reason === "user" && incumbent ? eligible.indexOf(incumbent) : undefined,
				)
			];
	} else if (policy.by[0]?.metric === "remaining") {
		selected = [...eligible].sort((a, b) => {
			const am = a.metric as Metric;
			const bm = b.metric as Metric;
			return (
				rank(bm) - rank(am) ||
				(am.kind === "measured" && bm.kind === "measured" ? bm.value - am.value : 0) ||
				a.index - b.index
			);
		})[0];
	}
	if (
		incumbent &&
		policy.stickiness !== "none" &&
		(context.reason === "continuation" || (context.reason === "direct" && policy.stickiness === "legacy-balanced"))
	) {
		selected = incumbent;
		override = "sticky";
	} else if (
		!policy.legacy &&
		incumbent?.metric &&
		selected?.metric &&
		policy.switchMargin > 0 &&
		context.reason === "user" &&
		keepIncumbent(selected.metric, incumbent.metric, policy.switchMargin)
	) {
		selected = incumbent;
		override = "hysteresis";
	}
	if (context.retryUnconfirmed) {
		// Transport retries preserve the failed chain member even if a concurrent cache read blocks it.
		selected = rows.find((row) => row.model === context.retryUnconfirmed);
		override = "unconfirmed-retry";
	}
	const rechecks = rows.flatMap((row) =>
		row.filters.flatMap(({ result }) =>
			result.outcome === "reject" && result.recheckAt !== undefined ? [result.recheckAt] : [],
		),
	);
	return {
		version: 1 as const,
		policy,
		at: now,
		reason: context.reason,
		caller: context.caller ?? "unknown",
		forecast: false,
		previous: context.previous ?? null,
		override,
		tieBreak: "chain-index asc",
		members: rows,
		chosen: selected?.model ?? null,
		emptyReason: selected ? null : "no eligible members",
		recheckAt: rechecks.length ? Math.min(...rechecks) : null,
	};
}
export type PolicyEvaluation = ReturnType<typeof evaluatePolicy>;

/** Reuse the legacy display score shape without changing legacy serialized decisions. */
export function metricScore(metric: Metric): QuotaScore {
	if (metric.kind === "unknown") return { kind: "fallback", reason: metric.reason };
	if (metric.kind === "unlimited") return metric;
	return { kind: "measured", score: metric.value, window: metric.limiters.join(",") };
}
