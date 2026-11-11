/** Side-effecting capture preserves safety while explanation/traces remain sanitized and cached. */
import { type Api, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import type { Profile } from "../src/config.js";
import { ExhaustionTracker } from "../src/exhaustion.js";
import { compilePolicy } from "../src/policy.js";
import { type RouteDecision, Router } from "../src/router.js";
import { CachedUsage, Clock } from "./scenarios/support.js";

it("explain empty sets and registry failures without refreshing, tracing or leaking raw snapshot fields", () => {
	const clock = new Clock();
	const usage = new CachedUsage(clock);
	usage.set("a", 100);
	usage.set("b", 20);
	const snapshot = usage.peek("a");
	if (!snapshot) throw new Error("fixture missing");
	snapshot.message = "private-error";
	snapshot.credits = { available: true, unlimited: false, balance: "private-balance" };
	const profile: Profile = {
		id: "test",
		name: "test",
		chain: [
			{ provider: "a", id: "sonnet" },
			{ provider: "b", id: "terra" },
		],
		policy: { version: 1, kind: "lexicographic", by: [{ metric: "chain-index", direction: "asc" }] },
	};
	expect(compilePolicy(profile).stickiness).toBe("none");
	const decisions: RouteDecision[] = [];
	const router = new Router(usage, new ExhaustionTracker(clock.now), clock.now, (decision) => decisions.push(decision));
	const env = {
		resolve: (entry: { provider: string; id: string }) =>
			entry.provider === "b" ? undefined : ({ ...entry, api: "test" } as unknown as Model<Api>),
		refresh: async () => {
			throw new Error("must not refresh");
		},
	};
	const result = router.explain(profile, env);
	expect(router.explain({ ...profile, policy: undefined }, env).chosen).toBeNull();
	expect(result).toMatchObject({
		forecast: true,
		chosen: null,
		emptyReason: "no eligible members",
		recheckAt: clock.now() + 3_600_000,
	});
	expect(result.members[0]?.windows).toHaveLength(1);
	expect(JSON.stringify(result)).not.toMatch(/private-error|private-balance/);
	expect(decisions).toEqual([]);
	expect(usage.reads).toEqual([]);
	const noPeek = new Router({ decisionFor: () => ({ block: true }) }, new ExhaustionTracker(clock.now), clock.now);
	expect(
		noPeek.explain(
			{ ...profile, policy: undefined },
			{ ...env, resolve: (entry) => ({ ...entry, api: "test" }) as unknown as Model<Api> },
		),
	).toMatchObject({ chosen: null, recheckAt: null });
});

it("new traces cover no-data candidates, unknown registry members, and unconfirmed transport exceptions", async () => {
	const clock = new Clock();
	const profile: Profile = {
		id: "test",
		name: "test",
		policy: { version: 1, kind: "remaining-balanced" },
		chain: [
			{ provider: "a", id: "a" },
			{ provider: "b", id: "b" },
		],
	};
	const model = { provider: "a", id: "a", api: "test" } as unknown as Model<Api>;
	const env = {
		resolve: (entry: { provider: string }) => (entry.provider === "a" ? model : undefined),
		refresh: async () => undefined,
	};
	const decisions: RouteDecision[] = [];
	const router = new Router(
		{ decisionFor: () => ({ block: false }) },
		new ExhaustionTracker(clock.now),
		clock.now,
		(decision) => decisions.push(decision),
	);
	const request: ModelRouteRequest = { model, reason: "user", thinkingLevel: "off", messages: [] };
	await router.route(profile, request, env);
	expect(decisions[0]).toMatchObject({
		version: 1,
		candidates: [{ model: "a/a", quota: { kind: "fallback" } }],
		blocked: [{ model: "b/b", reason: "not available (unknown model or no credentials)" }],
	});
	const silent = new Router({ decisionFor: () => ({ block: false }) }, new ExhaustionTracker(clock.now), clock.now);
	await silent.route(profile, request, env);
	await router.route(
		profile,
		{
			...request,
			reason: "retry",
			failed: {
				model,
				message: fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded", timestamp: clock.now() }),
			},
		},
		env,
	);
	expect(decisions.at(-1)?.evaluation?.override).toBe("unconfirmed-retry");
});
