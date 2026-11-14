/** Deterministic exhaustive properties over small domains and focused numeric/trust boundaries. */
import { describe, expect, it } from "vitest";
import { type Profile, parseConfig } from "../src/config.js";
import {
	compilePolicy,
	evaluatePolicy,
	metricScore,
	type PolicyContext,
	type PolicyMember,
	type PolicyV1,
	parsePolicy,
	remainingMetric,
} from "../src/policy.js";
import { STALE_GRACE_MS } from "../src/selection.js";
import type { UsageSnapshot, UsageWindow } from "../src/usage.js";
import { POLICY_CASES } from "./policy-cases.js";

const NOW = 1_800_000_000_000;
const remaining: PolicyV1 = { version: 1, kind: "remaining-balanced", stickiness: "none" };
function member(index: number, used = 50): PolicyMember {
	return {
		index,
		ref: { provider: `p${index}`, id: "sonnet" },
		filters: [{ name: "registered-authenticated", result: { outcome: "pass" } }],
		snapshot: {
			provider: `p${index}`,
			status: "available",
			retrievedAt: NOW,
			expiresAt: NOW + 300_000,
			windows: [{ name: "weekly", scope: "provider", usedPercent: used, resetAt: NOW + 1000, durationMs: 1000 }],
		},
	};
}
function profile(policy: PolicyV1): Profile {
	return { id: "test", name: "Test", chain: [member(0).ref, member(1).ref], policy };
}
function evaluate(policy: PolicyV1, members: PolicyMember[], context: PolicyContext = { reason: "user" }) {
	return evaluatePolicy(compilePolicy(profile(policy)), members, NOW, context);
}
function snapshot(m: PolicyMember): UsageSnapshot {
	if (!m.snapshot) throw new Error("fixture snapshot missing");
	return m.snapshot;
}
function window(m: PolicyMember): UsageWindow {
	const w = snapshot(m).windows[0];
	if (!w) throw new Error("fixture window missing");
	return w;
}

const CASES: { policy: unknown; valid: boolean; error?: string }[] = [
	...POLICY_CASES,
	{ policy: { version: 1, kind: "strict-priority" }, valid: true },
	{ policy: { version: 1, kind: "remaining-balanced" }, valid: true },
	{ policy: { version: 1, kind: "remaining-balanced", switchMargin: 0, stickiness: "none" }, valid: true },
	{ policy: { version: 1, kind: "remaining-balanced", switchMargin: 1, stickiness: "continuation" }, valid: true },
	{ policy: { version: 1, kind: "lexicographic", by: [{ metric: "chain-index", direction: "asc" }] }, valid: true },
	{
		policy: { version: 1, kind: "lexicographic", by: [{ metric: "remaining", window: "binding", direction: "desc" }] },
		valid: true,
	},
	{
		policy: {
			version: 1,
			kind: "lexicographic",
			by: [
				{ metric: "remaining", window: { name: "weekly" }, direction: "desc" },
				{ metric: "chain-index", direction: "asc" },
			],
			switchMargin: 0.2,
		},
		valid: true,
	},
	...[null, [], false].map((policy) => ({ policy, valid: false, error: "expected an object" })),
	{ policy: {}, valid: false, error: ".version: expected 1" },
	{ policy: { version: 2 }, valid: false, error: ".version: expected 1" },
	{ policy: { version: 1, kind: "weighted" }, valid: false, error: ".kind: unsupported" },
	{
		policy: { version: 1, kind: "strict-priority", switchMargin: 0 },
		valid: false,
		error: ".switchMargin: unsupported",
	},
	{ policy: { version: 1, kind: "remaining-balanced", by: [] }, valid: false, error: ".by: unsupported" },
	{ policy: { version: 1, kind: "remaining-balanced", extra: true }, valid: false, error: ".extra: unsupported" },
	...["0", -0.1, 1.1].map((switchMargin) => ({
		policy: { version: 1, kind: "remaining-balanced", switchMargin },
		valid: false,
		error: ".switchMargin: expected finite",
	})),
	{
		policy: { version: 1, kind: "remaining-balanced", stickiness: "session" },
		valid: false,
		error: ".stickiness: expected",
	},
	...[undefined, [], "x"].map((by) => ({
		policy: { version: 1, kind: "lexicographic", by },
		valid: false,
		error: ".by: expected a non-empty",
	})),
	{ policy: { version: 1, kind: "lexicographic", by: [null] }, valid: false, error: ".by[0]: expected an object" },
	{
		policy: { version: 1, kind: "lexicographic", by: [{ metric: "cost" }] },
		valid: false,
		error: ".metric: unsupported",
	},
	{
		policy: { version: 1, kind: "lexicographic", by: [{ metric: "chain-index", direction: "desc" }] },
		valid: false,
		error: ".direction: expected asc",
	},
	{
		policy: { version: 1, kind: "lexicographic", by: [{ metric: "chain-index", direction: "asc", window: "binding" }] },
		valid: false,
		error: ".window: unsupported",
	},
	{
		policy: {
			version: 1,
			kind: "lexicographic",
			by: [
				{ metric: "chain-index", direction: "asc" },
				{ metric: "remaining", direction: "desc", window: "binding" },
			],
		},
		valid: false,
		error: "chain-index must be last",
	},
	{
		policy: {
			version: 1,
			kind: "lexicographic",
			by: [
				{ metric: "remaining", direction: "desc", window: "binding" },
				{ metric: "remaining", direction: "desc", window: "binding" },
			],
		},
		valid: false,
		error: "remaining must be first and unique",
	},
	{
		policy: { version: 1, kind: "lexicographic", by: [{ metric: "remaining", direction: "asc", window: "binding" }] },
		valid: false,
		error: ".direction: expected desc",
	},
	{
		policy: { version: 1, kind: "lexicographic", by: [{ metric: "remaining", direction: "desc" }] },
		valid: false,
		error: ".window: expected an object",
	},
	{
		policy: {
			version: 1,
			kind: "lexicographic",
			by: [{ metric: "remaining", direction: "desc", window: { name: "" } }],
		},
		valid: false,
		error: ".window.name: expected a non-empty",
	},
	{
		policy: {
			version: 1,
			kind: "lexicographic",
			by: [{ metric: "remaining", direction: "desc", window: { name: 42 } }],
		},
		valid: false,
		error: ".window.name: expected a non-empty",
	},
	{
		policy: {
			version: 1,
			kind: "lexicographic",
			by: [{ metric: "remaining", direction: "desc", window: { name: "x", extra: true } }],
		},
		valid: false,
		error: ".window.extra: unsupported",
	},
	{
		policy: { version: 1, kind: "lexicographic", by: [{ metric: "chain-index", direction: "asc" }], switchMargin: 0 },
		valid: false,
		error: "requires a leading remaining",
	},
];

describe("v1 parser and compiler", () => {
	it.each(CASES)("validates $policy", ({ policy, valid, error }) => {
		if (valid) expect(parsePolicy(policy, "profiles.test.policy")).toEqual(policy);
		else expect(() => parsePolicy(policy, "profiles.test.policy")).toThrow(error);
	});
	it("rejects nonfinite margins, mutual exclusion and caller overrides without changing legacy omissions", () => {
		for (const switchMargin of [NaN, Infinity, -Infinity])
			expect(() => parsePolicy({ ...remaining, switchMargin }, "p")).toThrow("finite");
		const chain = [{ model: "p/a" }];
		for (const extra of [{ strategy: "ordered" }, { policyByCaller: {} }])
			expect(() => parseConfig({ profiles: { test: { chain, policy: remaining, ...extra } } })).toThrow(
				extra.strategy ? "mutually exclusive" : "policyByCaller",
			);
		expect(parseConfig({ profiles: { test: { chain, policy: remaining } } })[0]?.policy).toEqual(remaining);
		const p = profile(remaining);
		expect(compilePolicy(p)).toBe(compilePolicy(p));
		expect(
			compilePolicy(
				profile({
					version: 1,
					kind: "lexicographic",
					by: [{ metric: "remaining", direction: "desc", window: "binding" }],
				}),
			),
		).toEqual(compilePolicy(profile({ version: 1, kind: "remaining-balanced" })));
	});
});

it("strict priority never selects B while an earlier A is eligible, for every score and allocation boundary", () => {
	for (const a of [0, 10, 99, 100])
		for (const b of [0, 10, 99, 100])
			for (const reason of ["user", "direct", "continuation", "retry"] as const) {
				const members = [member(0, a), member(1, b)];
				expect(
					evaluate({ version: 1, kind: "strict-priority" }, members, { reason, previous: "p1/sonnet" }).chosen,
				).toBe("p0/sonnet");
				members[0]?.filters.push({
					name: "confirmed-quota",
					result: { outcome: "reject", reason: "blocked", recheckAt: NOW + 20 },
				});
				expect(evaluate({ version: 1, kind: "strict-priority" }, members, { reason }).chosen).toBe("p1/sonnet");
			}
});

it("remaining maximum, stable ties and zero margin ignore later incumbents on user/direct for every knowledge tier", () => {
	for (const a of [0, 10, 50, 90, 100])
		for (const b of [0, 10, 50, 90, 100])
			for (const reason of ["user", "direct"] as const) {
				for (const switchMargin of [undefined, 0]) {
					const result = evaluate({ ...remaining, switchMargin }, [member(0, a), member(1, b)], {
						reason,
						previous: "p1/sonnet",
						caller: "background",
					});
					expect(result.chosen).toBe(a <= b ? "p0/sonnet" : "p1/sonnet");
				}
			}
	for (const kind of ["unlimited", "unknown"])
		for (const reason of ["user", "direct"] as const) {
			const members = [member(0), member(1)];
			for (const m of members) {
				if (kind === "unlimited") snapshot(m).credits = { available: true, unlimited: true };
				else delete m.snapshot;
			}
			expect(evaluate(remaining, members, { reason, previous: "p1/sonnet" }).chosen).toBe("p0/sonnet");
		}
});

it("sticky and positive prompt hysteresis never bypass safety filters and use declared boundaries", () => {
	const policy: PolicyV1 = { version: 1, kind: "remaining-balanced", switchMargin: 0.2 };
	for (const [challenger, chosen] of [
		[40.0000001, "p1/sonnet"],
		[40, "p1/sonnet"],
		[39.9999999, "p0/sonnet"],
	] as const)
		expect(
			evaluate(policy, [member(0, challenger), member(1, 50)], { reason: "user", previous: "p1/sonnet" }).chosen,
		).toBe(chosen);
	for (const [a, b, chosen] of [
		[100, 100, "p1/sonnet"],
		[99.99999999999999, 100, "p0/sonnet"],
		[99.99999999999999, 99.99999999999999, "p1/sonnet"],
	] as const)
		expect(evaluate(policy, [member(0, a), member(1, b)], { reason: "user", previous: "p1/sonnet" }).chosen).toBe(
			chosen,
		);
	const members = [member(0, 0), member(1, 99)];
	expect(evaluate(policy, members, { reason: "continuation", previous: "p1/sonnet" }).override).toBe("sticky");
	expect(evaluate(policy, members, { reason: "direct", previous: "p1/sonnet" }).chosen).toBe("p0/sonnet");
	members[1]?.filters.push({ name: "cached-exhaustion", result: { outcome: "reject", reason: "quota" } });
	expect(evaluate(policy, members, { reason: "continuation", previous: "p1/sonnet" }).chosen).toBe("p0/sonnet");
});

it("positive margin promotes knowledge and retains unlimited/all-unknown incumbents", () => {
	const policy: PolicyV1 = { ...remaining, switchMargin: 0.2 };
	const a = member(0);
	const b = member(1);
	for (const m of [a, b]) snapshot(m).status = "error";
	expect(evaluate(policy, [a, b], { reason: "user", previous: "p1/sonnet" }).chosen).toBe("p1/sonnet");
	snapshot(a).status = "available";
	expect(evaluate(policy, [a, b], { reason: "user", previous: "p1/sonnet" }).chosen).toBe("p0/sonnet");
	snapshot(b).status = "available";
	snapshot(b).credits = { available: true, unlimited: true };
	expect(evaluate(policy, [a, b], { reason: "user", previous: "p1/sonnet" }).chosen).toBe("p1/sonnet");
	snapshot(a).credits = { available: true, unlimited: true };
	expect(evaluate(policy, [a, b], { reason: "user", previous: "p1/sonnet" }).chosen).toBe("p1/sonnet");
});

it("remaining trust, applicability, expiry and named selectors disclose rather than invent evidence", () => {
	const m = member(0, 40);
	expect(remainingMetric({ ...m, snapshot: undefined }, "binding", NOW)).toEqual({
		kind: "unknown",
		reason: "usage missing",
	});
	for (const status of ["unavailable", "error"] as const) {
		snapshot(m).status = status;
		expect(remainingMetric(m, "binding", NOW)).toEqual({ kind: "unknown", reason: `usage ${status}` });
	}
	snapshot(m).status = "stale";
	snapshot(m).retrievedAt = NOW - STALE_GRACE_MS;
	expect(remainingMetric(m, "binding", NOW)).toMatchObject({ kind: "measured", value: 0.6 });
	snapshot(m).retrievedAt--;
	expect(remainingMetric(m, "binding", NOW)).toMatchObject({ kind: "unknown", reason: "usage stale" });
	snapshot(m).retrievedAt = NOW + 1000;
	snapshot(m).status = "available";
	snapshot(m).credits = { available: true, unlimited: true };
	expect(remainingMetric(m, "binding", NOW)).toEqual({ kind: "unlimited" });
	snapshot(m).expiresAt = NOW;
	expect(remainingMetric(m, "binding", NOW)).toMatchObject({ kind: "measured" });
	delete snapshot(m).credits;
	expect(remainingMetric(m, { name: "absent" }, NOW)).toMatchObject({ kind: "unknown" });
	expect(remainingMetric(m, { name: "weekly" }, NOW)).toMatchObject({ kind: "measured", value: 0.6 });
	const original = remainingMetric(m, "binding", NOW);
	for (const resetAt of [undefined, NaN, NOW + 1, NOW + 1e10]) {
		window(m).resetAt = resetAt;
		expect(remainingMetric(m, "binding", NOW)).toEqual(original);
	}
	window(m).resetAt = NOW;
	expect(remainingMetric(m, "binding", NOW)).toMatchObject({ kind: "unknown" });
	window(m).resetAt = NOW + 10;
	for (const usedPercent of [NaN, Infinity, -1]) {
		window(m).usedPercent = usedPercent;
		expect(remainingMetric(m, "binding", NOW)).toMatchObject({ kind: "unknown" });
	}
	window(m).usedPercent = 150;
	expect(remainingMetric(m, "binding", NOW)).toMatchObject({ value: 0 });
	window(m).usedPercent = 40;
	snapshot(m).windows.push({ name: "opus", scope: "model", families: ["opus"], usedPercent: 99 });
	expect(remainingMetric(m, "binding", NOW)).toEqual(original);
	snapshot(m).windows.push({ name: "no-families", scope: "model", usedPercent: 99 });
	expect(remainingMetric(m, "binding", NOW)).toEqual(original);
	snapshot(m).windows.push(
		{ name: "sonnet", scope: "model", families: ["sonnet"], usedPercent: 60 },
		{ name: "tied", scope: "provider", usedPercent: 60 },
	);
	expect(remainingMetric(m, "binding", NOW)).toEqual({ kind: "measured", value: 0.4, limiters: ["sonnet", "tied"] });
	window(m).durationMs = NaN;
	const before = structuredClone(m);
	const result = evaluate(remaining, [m]);
	expect(result).toEqual(evaluate(remaining, [m]));
	expect(m).toEqual(before);
	expect(result.members[0]?.snapshot).toMatchObject({ ageMs: 0, futureRetrieval: true });
	expect(result.members[0]?.windows[0]?.durationMs).toBeNull();
	for (const metric of [
		remainingMetric(m, "binding", NOW),
		remainingMetric(m, { name: "absent" }, NOW),
		{ kind: "unlimited" } as const,
	])
		expect(metricScore(metric)).toHaveProperty("kind");
});

it("adding an applicable active window cannot increase a measured binding score", () => {
	for (let first = 0; first <= 100; first += 10)
		for (let second = 0; second <= 100; second += 10) {
			const m = member(0, first);
			snapshot(m).windows.push({ name: "second", scope: "provider", usedPercent: second });
			expect(remainingMetric(m, "binding", NOW)).toMatchObject({ value: 1 - Math.max(first, second) / 100 });
		}
});

it("empty sets, unknown rules and retry exception are typed and deterministic", () => {
	const a = member(0);
	const b = member(1);
	a.filters.push({ name: "confirmed-quota", result: { outcome: "unknown", reason: "unknown", rule: "pass" } });
	b.filters.push({ name: "cached-exhaustion", result: { outcome: "unknown", reason: "unknown", rule: "reject" } });
	expect(evaluate(remaining, [a, b]).chosen).toBe("p0/sonnet");
	a.filters.push({ name: "cached-exhaustion", result: { outcome: "reject", reason: "quota", recheckAt: NOW + 10 } });
	expect(evaluate(remaining, [a, b])).toMatchObject({
		chosen: null,
		emptyReason: "no eligible members",
		recheckAt: NOW + 10,
	});
	expect(evaluate(remaining, [a, b], { reason: "retry", retryUnconfirmed: "p1/sonnet" })).toMatchObject({
		chosen: "p1/sonnet",
		override: "unconfirmed-retry",
	});
	expect(evaluate(remaining, [], { reason: "retry", retryUnconfirmed: "missing/ref" }).chosen).toBeNull();
	const legacy = { id: "l", name: "l", chain: [a.ref, b.ref], strategy: "balanced" as const };
	b.filters = [];
	a.filters = [];
	expect(evaluatePolicy(compilePolicy(legacy), [a, b], NOW, { reason: "direct", previous: "p1/sonnet" }).override).toBe(
		"sticky",
	);
});
