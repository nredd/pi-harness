import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ChainEntry, Profile } from "../src/config.js";
import { ExhaustionTracker } from "../src/exhaustion.js";
import {
	ChainExhaustedError,
	isoSeconds,
	isQuotaError,
	type RouteEnv,
	Router,
	type UsageDecider,
} from "../src/router.js";
import { modelMatchesFamily, type UsageDecision, type UsageSnapshot } from "../src/usage.js";

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;

const SONNET_55: ChainEntry = { provider: "anthropic", id: "claude-sonnet-5-5" };
const TERRA: ChainEntry = { provider: "openai-codex", id: "gpt-5.6-terra", thinking: "high" };
const SONNET_5: ChainEntry = { provider: "anthropic", id: "claude-sonnet-5" };
const OPUS: ChainEntry = { provider: "anthropic", id: "claude-opus-5-5" };
const PROFILE: Profile = { id: "default", name: "Router default", chain: [SONNET_55, TERRA, SONNET_5] };

function model(entry: ChainEntry): Model<Api> {
	return { provider: entry.provider, id: entry.id, api: "test" } as unknown as Model<Api>;
}

/**
 * Usage as the router sees it: `cached` answers `decisionFor`, and `live` is
 * what a fresh read would reveal. `refresh` copies live into cached, the way a
 * real fresh read replaces the cache.
 */
function harness(options: { live?: Record<string, UsageDecision>; unknown?: string[]; stale?: boolean } = {}) {
	const clock = { now: T0 };
	const cached: Record<string, UsageDecision> = {};
	const live = options.live ?? {};
	const refreshed: string[] = [];
	const usage: UsageDecider = {
		decisionFor: (m) => {
			const decision = cached[`${m.provider}/${m.id}`] ?? cached[m.provider];
			if (!decision?.block) return { block: false };
			const applies = decision.scope !== "model" || decision.families?.some((f) => modelMatchesFamily(m.id, f));
			return applies ? decision : { block: false };
		},
	};
	const tracker = new ExhaustionTracker(() => clock.now);
	const env: RouteEnv = {
		resolve: (entry) => (options.unknown?.includes(entry.id) ? undefined : model(entry)),
		refresh: async (provider) => {
			refreshed.push(provider);
			if (options.stale) return false;
			for (const [key, decision] of Object.entries(live)) {
				if (key === provider || key.startsWith(`${provider}/`)) cached[key] = decision;
			}
			return true;
		},
	};
	return { router: new Router(usage, tracker), tracker, env, clock, cached, refreshed };
}

function request(overrides: Partial<ModelRouteRequest> = {}): ModelRouteRequest {
	return {
		model: { provider: "router", id: "default", api: "pi-virtual" } as unknown as Model<Api>,
		thinkingLevel: "medium",
		reason: "user",
		messages: [],
		...overrides,
	};
}

function failure(entry: ChainEntry, errorMessage: string): ModelRouteRequest["failed"] {
	return {
		model: model(entry),
		message: { role: "assistant", stopReason: "error", errorMessage, timestamp: T0 } as AssistantMessage,
	};
}

const sonnetWeekly: UsageDecision = {
	block: true,
	window: "seven_day_sonnet",
	scope: "model",
	families: ["sonnet"],
	resetAt: T0 + 60 * MINUTE,
};

describe("Router.route", () => {
	it("picks the first chain entry at user, direct, and first continuation", async () => {
		const { router, env } = harness();
		for (const reason of ["user", "direct", "continuation"] as const) {
			const route = await router.route(PROFILE, request({ reason }), env);
			expect(route.model.id, reason).toBe(SONNET_55.id);
			expect(route.thinkingLevel).toBe("medium");
		}
	});

	it("sticks with the previous model on continuation, even when it is not first", async () => {
		const { router, env } = harness();
		const route = await router.route(
			PROFILE,
			request({ reason: "continuation", previous: { model: model(TERRA), thinkingLevel: "high" } }),
			env,
		);
		expect(route).toMatchObject({ model: { id: TERRA.id }, thinkingLevel: "high" });
	});

	it("leaves a continuation's previous model once its family is marked", async () => {
		const { router, env, tracker } = harness();
		tracker.mark(model(TERRA), { block: true, window: "5h", scope: "provider", resetAt: T0 + MINUTE });
		const route = await router.route(
			PROFILE,
			request({ reason: "continuation", previous: { model: model(TERRA) } }),
			env,
		);
		expect(route.model.id).toBe(SONNET_55.id);
	});

	it("retries the same model on a 429 that a fresh usage read does not confirm", async () => {
		const { router, env, refreshed, tracker } = harness();
		const route = await router.route(
			PROFILE,
			request({ reason: "retry", failed: failure(TERRA, "429 Too Many Requests") }),
			env,
		);
		expect(route.model.id).toBe(TERRA.id);
		expect(refreshed).toEqual(["openai-codex"]);
		expect(tracker.active()).toEqual([]);
	});

	it("does not mark from a confirming read that returned no live data", async () => {
		const { router, env, tracker } = harness({
			live: { "openai-codex": { block: true, window: "5h", resetAt: T0 + MINUTE } },
			stale: true,
		});
		const route = await router.route(PROFILE, request({ reason: "retry", failed: failure(TERRA, "429") }), env);
		expect(route.model.id).toBe(TERRA.id);
		expect(tracker.active()).toEqual([]);
	});

	it("does not read usage for a non-quota retry", async () => {
		const { router, env, refreshed } = harness();
		const route = await router.route(
			PROFILE,
			request({ reason: "retry", failed: failure(SONNET_55, "overloaded_error") }),
			env,
		);
		expect(route.model.id).toBe(SONNET_55.id);
		expect(refreshed).toEqual([]);
	});

	it("advances the chain on a confirmed 429 and pins the entry's thinking level", async () => {
		const { router, env, tracker } = harness({ live: { anthropic: { ...sonnetWeekly } } });
		const route = await router.route(
			PROFILE,
			request({ reason: "retry", failed: failure(SONNET_55, "429 rate_limit_error") }),
			env,
		);
		expect(route).toMatchObject({ model: { id: TERRA.id }, thinkingLevel: "high" });
		expect(tracker.active()).toMatchObject([{ provider: "anthropic", families: ["sonnet"] }]);
	});

	it("keeps another family of the same provider eligible after a family-scoped block", async () => {
		const { router, env } = harness({ live: { anthropic: { ...sonnetWeekly } } });
		const deep: Profile = { id: "deep", name: "deep", chain: [SONNET_55, OPUS, TERRA] };
		const route = await router.route(
			deep,
			request({ reason: "retry", failed: failure(SONNET_55, "429 rate_limit_error") }),
			env,
		);
		expect(route.model.id).toBe(OPUS.id);
	});

	it("skips entries whose cached usage is already exhausted, without a network read", async () => {
		const { router, env, cached, refreshed } = harness();
		cached.anthropic = { block: true, window: "five_hour", scope: "provider", resetAt: T0 + MINUTE };
		const route = await router.route(PROFILE, request(), env);
		expect(route.model.id).toBe(TERRA.id);
		expect(refreshed).toEqual([]);
	});

	it("skips entries that are unknown or lack credentials", async () => {
		const { router, env } = harness({ unknown: [SONNET_55.id] });
		expect((await router.route(PROFILE, request(), env)).model.id).toBe(TERRA.id);
	});

	it("throws with the earliest reset when every entry is blocked", async () => {
		const { router, env, cached } = harness();
		cached.anthropic = { block: true, window: "five_hour", scope: "provider", resetAt: T0 + 90 * MINUTE };
		cached["openai-codex"] = { block: true, window: "5h", scope: "provider", resetAt: T0 + 30 * MINUTE };
		const attempt = router.route(PROFILE, request(), env);
		await expect(attempt).rejects.toBeInstanceOf(ChainExhaustedError);
		await expect(attempt).rejects.toMatchObject({ resetAt: T0 + 30 * MINUTE });
		await expect(attempt).rejects.toThrow(isoSeconds(T0 + 30 * MINUTE));
	});

	it("honors an aborted signal before routing and after a confirming read", async () => {
		const { router, env } = harness();
		const aborted = AbortSignal.abort();
		await expect(router.route(PROFILE, request({ signal: aborted }), env)).rejects.toThrow();

		const controller = new AbortController();
		const slow: RouteEnv = {
			...env,
			refresh: async () => {
				controller.abort();
				return true;
			},
		};
		await expect(
			router.route(
				PROFILE,
				request({ reason: "retry", signal: controller.signal, failed: failure(SONNET_55, "429") }),
				slow,
			),
		).rejects.toThrow();
	});

	it("falls through to the first eligible entry for a retry of a model outside the chain", async () => {
		const { router, env } = harness();
		const route = await router.route(
			PROFILE,
			request({ reason: "retry", failed: failure(OPUS, "429 rate limit") }),
			env,
		);
		expect(route.model.id).toBe(SONNET_55.id);
	});
});

describe("balanced routing", () => {
	const third: ChainEntry = { provider: "third", id: "third-model" };
	const profile: Profile = { ...PROFILE, strategy: "balanced", chain: [SONNET_55, TERRA, third] };
	function balanced() {
		const h = harness();
		const snapshots: Record<string, UsageSnapshot> = {};
		const usage: UsageDecider = {
			decisionFor: (entry) => h.cached[entry.provider] ?? { block: false },
			peek: (provider) => snapshots[provider],
		};
		const router = new Router(usage, h.tracker, () => T0);
		const set = (entry: ChainEntry, remaining: number) => {
			snapshots[entry.provider] = {
				provider: entry.provider,
				status: "available",
				windows: [{ name: "weekly", usedPercent: (1 - remaining) * 100, scope: "provider" }],
				retrievedAt: T0,
				expiresAt: T0 + MINUTE,
			};
		};
		return { ...h, router, snapshots, set };
	}
	it("shares pure >=3-provider selection with admission and diagnostic pick", async () => {
		const { router, env, set, refreshed, tracker } = balanced();
		set(SONNET_55, 0.2);
		set(TERRA, 0.4);
		set(third, 0.8);
		const picked = router.pick(profile, env);
		expect(picked).toMatchObject({
			ok: true,
			entry: third,
			candidates: [
				{ score: { kind: "measured", window: "weekly" } },
				{ score: { kind: "measured" } },
				{ score: { kind: "measured" } },
			],
		});
		expect(router.admit("router/default", new Map([["default", profile]]), env)).toEqual({
			ok: true,
			resolvedModel: "third/third-model",
		});
		expect((await router.route(profile, request(), env)).model.id).toBe(third.id);
		expect(refreshed).toEqual([]);
		expect(tracker.active()).toEqual([]);
	});
	it("switches on new prompts only above hysteresis and preserves balanced direct/continuations", async () => {
		const { router, env, set } = balanced();
		set(TERRA, 0.5);
		set(third, 0.59);
		const previous = { model: model(TERRA), thinkingLevel: "high" as const };
		expect((await router.route(profile, request({ previous }), env)).model.id).toBe(TERRA.id);
		set(third, 0.9);
		for (const reason of ["direct", "continuation"] as const) {
			expect((await router.route(profile, request({ reason, previous }), env)).model.id).toBe(TERRA.id);
		}
		expect((await router.route(profile, request({ previous }), env)).model.id).toBe(third.id);
		expect(
			(await router.route({ ...profile, strategy: "ordered" }, request({ reason: "direct", previous }), env)).model.id,
		).toBe(SONNET_55.id);
	});
	it("retains all-unmeasured incumbent, promotes measured, leaves sticky model when unavailable or blocked", async () => {
		const { router, env, set, tracker, snapshots } = balanced();
		const previous = { model: model(third) };
		expect((await router.route(profile, request({ previous }), env)).model.id).toBe(third.id);
		set(TERRA, 0.3);
		expect((await router.route(profile, request({ previous }), env)).model.id).toBe(TERRA.id);
		set(third, 0.9);
		const stale = snapshots[third.provider];
		if (!stale) throw new Error("missing fixture snapshot");
		stale.status = "stale";
		expect((await router.route(profile, request(), env)).model.id).toBe(TERRA.id);
		tracker.mark(model(third), { block: true, window: "weekly", resetAt: T0 + MINUTE });
		expect((await router.route(profile, request({ reason: "continuation", previous }), env)).model.id).toBe(TERRA.id);
		tracker.clear();
		expect(
			(
				await router.route(profile, request({ reason: "direct", previous }), {
					...env,
					resolve: (entry) => (entry.provider === third.provider ? undefined : model(entry)),
				})
			).model.id,
		).toBe(TERRA.id);
	});
	it("keeps confirmed and unconfirmed retry semantics under balancing", async () => {
		const { router, env, tracker, set, refreshed, cached } = balanced();
		set(SONNET_55, 0.2);
		set(TERRA, 0.4);
		set(third, 0.8);
		const failed = failure(SONNET_55, "429");
		expect((await router.route(profile, request({ reason: "retry", failed }), env)).model.id).toBe(SONNET_55.id);
		expect(refreshed).toEqual(["anthropic"]);
		expect(tracker.active()).toEqual([]);
		const confirmedEnv: RouteEnv = {
			...env,
			refresh: async () => {
				cached.anthropic = { block: true, window: "weekly", scope: "provider", resetAt: T0 + MINUTE };
				return true;
			},
		};
		expect((await router.route(profile, request({ reason: "retry", failed }), confirmedEnv)).model.id).toBe(third.id);
		expect(tracker.active()).toHaveLength(1);
	});
});

describe("ExhaustionTracker", () => {
	it("backs off 5m doubling to 60m when no reset is known, then starts over after a quiet cycle", () => {
		const { tracker, clock } = harness();
		const sonnet = model(SONNET_55);
		const durations: number[] = [];
		for (let i = 0; i < 6; i++) {
			const mark = tracker.mark(sonnet, { block: true, window: "five_hour", scope: "provider" });
			durations.push((mark.until - clock.now) / MINUTE);
			expect(mark.resetKnown).toBe(false);
			clock.now = mark.until;
		}
		expect(durations).toEqual([5, 10, 20, 40, 60, 60]);
		expect(tracker.blocking(sonnet)).toBeUndefined();
		clock.now += 61 * MINUTE;
		expect(tracker.mark(sonnet, { block: true, window: "five_hour", scope: "provider" }).until - clock.now).toBe(
			5 * MINUTE,
		);
	});

	it("uses a known future reset and ignores one already past", () => {
		const { tracker, clock } = harness();
		expect(tracker.mark(model(TERRA), { block: true, resetAt: T0 + 3 * MINUTE }).until).toBe(T0 + 3 * MINUTE);
		clock.now = T0 + 10 * MINUTE;
		const mark = tracker.mark(model(TERRA), { block: true, resetAt: T0 });
		expect(mark.resetKnown).toBe(false);
		expect(mark.until).toBeGreaterThan(clock.now);
	});
});

describe("isQuotaError", () => {
	it("matches retryable rate limits and upstream's terminal quota errors", () => {
		for (const text of [
			"429 Too Many Requests",
			"rate_limit_error",
			"insufficient_quota",
			"You exceeded your current quota exceeded",
			"subscription_sharing_usage_limit_exceeded",
			"Your credit balance is too low; check billing",
			`400 {"type":"error","error":{"type":"invalid_request_error","message":"You're out of extra usage. Add more at claude.ai/settings/usage and keep going."}}`,
		]) {
			expect(isQuotaError({ stopReason: "error", errorMessage: text }), text).toBe(true);
		}
	});

	it("ignores unrelated errors and non-error stops", () => {
		expect(isQuotaError({ stopReason: "error", errorMessage: "overloaded_error" })).toBe(false);
		expect(isQuotaError({ stopReason: "error", errorMessage: "request took 4290ms" })).toBe(false);
		expect(isQuotaError({ stopReason: "aborted", errorMessage: "429" })).toBe(false);
	});
});

describe("Router.admit", () => {
	const profiles = new Map([["default", PROFILE]]);

	it("admits a router profile with its current pick", () => {
		const { router, env } = harness();
		expect(router.admit("router/default", profiles, env)).toEqual({
			ok: true,
			resolvedModel: "anthropic/claude-sonnet-5-5",
		});
	});

	it("refuses a router profile only when a quota block leaves nothing eligible", () => {
		const { router, env, cached } = harness({ unknown: [TERRA.id] });
		cached.anthropic = { block: true, window: "5h", resetAt: T0 + MINUTE };
		expect(router.admit("router/default", profiles, env)).toEqual({ ok: false, resetAt: T0 + MINUTE, wait: true });
	});

	it("tells the caller to fail now when the profile's policy is fail", () => {
		const { router, env, cached } = harness({ unknown: [TERRA.id] });
		cached.anthropic = { block: true, window: "5h", resetAt: T0 + MINUTE };
		const failing = new Map([["default", { ...PROFILE, exhaustion: { policy: "fail" as const } }]]);
		expect(router.admit("router/default", failing, env)).toEqual({ ok: false, resetAt: T0 + MINUTE, wait: false });
	});

	it("tells the caller to fail when the reset is beyond maxWaitMs or unknown", () => {
		vi.useFakeTimers({ now: T0 });
		try {
			const { router, env, cached } = harness({ unknown: [TERRA.id] });
			const capped = new Map([["default", { ...PROFILE, exhaustion: { policy: "wait" as const, maxWaitMs: MINUTE } }]]);
			cached.anthropic = { block: true, window: "5h", resetAt: T0 + MINUTE };
			expect(router.admit("router/default", capped, env)).toMatchObject({ ok: false, wait: true });
			cached.anthropic = { block: true, window: "5h", resetAt: T0 + 2 * MINUTE };
			expect(router.admit("router/default", capped, env)).toMatchObject({ ok: false, wait: false });
			cached.anthropic = { block: true, window: "5h" };
			expect(router.admit("router/default", profiles, env)).toMatchObject({ ok: false, wait: false });
		} finally {
			vi.useRealTimers();
		}
	});

	it("admits a profile that is unusable only for config or credential reasons", () => {
		const { router, env } = harness({ unknown: [SONNET_55.id, TERRA.id, SONNET_5.id] });
		expect(router.admit("router/default", profiles, env)).toEqual({ ok: true });
	});

	it("refuses a blocked physical model and admits unknown refs", () => {
		const { router, env, cached } = harness();
		cached["openai-codex"] = { block: true, window: "5h", resetAt: T0 + MINUTE };
		expect(router.admit("openai-codex/gpt-5.6-terra", profiles, env)).toEqual({
			ok: false,
			resetAt: T0 + MINUTE,
			wait: true,
		});
		expect(router.admit("anthropic/claude-opus-5-5", profiles, env)).toEqual({
			ok: true,
			resolvedModel: "anthropic/claude-opus-5-5",
		});
		expect(router.admit("router/missing", profiles, env)).toEqual({ ok: true });
		expect(router.admit("garbage", profiles, env)).toEqual({ ok: true });
	});
});

describe("isoSeconds", () => {
	it("drops milliseconds so errors never carry a bare 500/502/503", () => {
		expect(isoSeconds(Date.UTC(2026, 8, 30, 18, 50, 3, 500))).toBe("2026-09-30T18:50:03Z");
		const error = new ChainExhaustedError("default", [], Date.UTC(2026, 8, 30, 18, 50, 3, 503));
		expect(error.message).not.toMatch(/50[023]/);
	});
});
