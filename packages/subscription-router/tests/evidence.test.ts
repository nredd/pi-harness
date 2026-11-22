/** Evidence chain and inferred mark model: thresholds, caps, labels and idempotence. */
import { type Api, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { Profile } from "../src/config.ts";
import {
	type ConfirmationEvidence,
	composeEvidence,
	confirmEvidence,
	type Evidence,
	evidenceChain,
	type FailureContext,
	FailureHistory,
	failureEvidence,
	MAX_BLOCK_MS,
	MAX_DAILY_BLOCK_MS,
	readEvidence,
	type UsageRead,
} from "../src/evidence.ts";
import { ExhaustionTracker, markEvidence } from "../src/exhaustion.ts";
import { nextPacificMidnight } from "../src/failure.ts";
import { isQuotaError, type RouteEnv, Router } from "../src/router.ts";
import {
	NO_USAGE_SOURCE,
	type RegistryContext,
	type UsageDecision,
	UsageService,
	type UsageSnapshot,
} from "../src/usage.ts";

const T0 = Date.parse("2030-07-01T18:00:00Z");
const MINUTE = 60_000;
const CARBON = { provider: "google", id: "gemini-4-carbon" };

function rpc(...details: unknown[]): string {
	return `429: ${JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details } })}`;
}
const quotaId = (id: string) => ({
	"@type": "type.googleapis.com/google.rpc.QuotaFailure",
	violations: [{ quotaId: id }],
});
const retryDelay = (delay: string) => ({ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: delay });

const DAILY = rpc(quotaId("GenerateRequestsPerDayPerProjectPerModel"));
const PER_MINUTE = rpc(quotaId("GenerateRequestsPerMinutePerProjectPerModel"), retryDelay("95s"));
const HINT_95S = rpc(retryDelay("95s"));
const SPEND = rpc(quotaId("SpendPer10Minutes"));
const BARE = "429 Too Many Requests";

function failure(errorMessage: string, failedAt = T0, model = CARBON): FailureContext {
	return { model, failedAt, message: { stopReason: "error", errorMessage, timestamp: failedAt } };
}

async function decide(adapter: ConfirmationEvidence, context: FailureContext): Promise<Evidence> {
	return adapter.decide(context);
}

const NEON = { provider: "google", id: "gemini-4-neon" };

describe("failure-inferred evidence", () => {
	it("marks a daily token on the first failure until the next Pacific midnight", async () => {
		const evidence = await decide(failureEvidence(new FailureHistory()), failure(DAILY));
		expect(evidence).toEqual({
			kind: "block",
			decision: {
				block: true,
				evidence: "inferred",
				evidenceAt: T0,
				scope: "model",
				families: ["gemini-4-carbon"],
				cause: "quota",
				window: "inferred:daily",
				resetAt: nextPacificMidnight(T0),
				expiry: "window-reset",
			},
		});
	});

	it("marks a daily 429 on the first failure even when its prose says requests are blocked", async () => {
		const text = "429: Daily quota exceeded; requests are blocked until reset";
		expect(await decide(failureEvidence(new FailureHistory()), failure(text))).toMatchObject({
			kind: "block",
			decision: { window: "inferred:daily", resetAt: nextPacificMidnight(T0) },
		});
	});

	it("caps a daily mark at 24 hours on the 25-hour fall-back day", async () => {
		// 00:00:30 PDT on 2030-11-03: the next Pacific midnight is 25 hours away.
		const failedAt = Date.parse("2030-11-03T07:00:30Z");
		expect(nextPacificMidnight(failedAt) - failedAt).toBeGreaterThan(MAX_DAILY_BLOCK_MS);
		const evidence = await decide(failureEvidence(new FailureHistory()), failure(DAILY, failedAt));
		expect(evidence).toMatchObject({ decision: { resetAt: failedAt + MAX_DAILY_BLOCK_MS } });
	});

	it("marks a hint of at least 60s until the hint, capped at 60 minutes", async () => {
		const adapter = failureEvidence(new FailureHistory());
		expect(await decide(adapter, failure(HINT_95S))).toMatchObject({
			kind: "block",
			decision: { window: "inferred:hint", resetAt: T0 + 95_000, expiry: "hinted", evidence: "inferred" },
		});
		expect(await decide(adapter, failure(rpc(retryDelay("7200s"))))).toMatchObject({
			decision: { resetAt: T0 + MAX_BLOCK_MS },
		});
	});

	it("caps a spend-window mark at its 10-minute window", async () => {
		expect(await decide(failureEvidence(new FailureHistory()), failure(SPEND))).toMatchObject({
			decision: { window: "inferred:rolling", resetAt: T0 + 10 * MINUTE, expiry: "window-reset" },
		});
	});

	it("lets maxBlockMinutes lower every cap but never raise one", async () => {
		const tight = failureEvidence(new FailureHistory(), { maxBlockMinutes: 1 });
		expect(await decide(tight, failure(DAILY))).toMatchObject({ decision: { resetAt: T0 + MINUTE } });
		const loose = failureEvidence(new FailureHistory(), { maxBlockMinutes: 1440 });
		expect(await decide(loose, failure(rpc(retryDelay("7200s"))))).toMatchObject({
			decision: { resetAt: T0 + MAX_BLOCK_MS },
		});
	});

	it("treats the 60-second hint floor as a default that a lower minHintSeconds lowers", async () => {
		const HINT_45S = rpc(retryDelay("45s"));
		const low = { failure: { minHintSeconds: 30 } };
		expect(await decide(failureEvidence(new FailureHistory(), low.failure), failure(HINT_45S))).toMatchObject({
			kind: "block",
			decision: { window: "inferred:hint", resetAt: T0 + 45_000 },
		});
		const { usage } = reader(noSource());
		expect(await confirmEvidence(usage, new FailureHistory(), low)(failure(HINT_45S))).toMatchObject({
			resetAt: T0 + 45_000,
		});
		// Without the setting a 45-second hint is a throttle on every path.
		expect(await confirmEvidence(usage, new FailureHistory(), undefined)(failure(HINT_45S))).toBeUndefined();
	});

	it("lets maxBlockMinutes cap the billing and unknown-shape backoff too", async () => {
		const clock = { now: T0 };
		const tracker = new ExhaustionTracker(() => clock.now);
		const adapter = failureEvidence(new FailureHistory(), {
			maxBlockMinutes: 2,
			repeat: { count: 1, withinMinutes: 10 },
		});
		const billing = await decide(adapter, failure("402: credits depleted"));
		expect(tracker.record(CARBON, (billing as { decision: UsageDecision }).decision)).toMatchObject({
			until: T0 + 2 * MINUTE,
			resetKnown: false,
		});
		const unknown = await decide(adapter, failure(BARE, T0, NEON));
		expect(tracker.record(NEON, (unknown as { decision: UsageDecision }).decision)).toMatchObject({
			until: T0 + 2 * MINUTE,
		});
		// Unconfigured, the backoff keeps its 5-minute first step.
		const plain = await decide(failureEvidence(new FailureHistory()), failure("402: credits depleted"));
		expect(
			new ExhaustionTracker(() => T0).record(CARBON, (plain as { decision: UsageDecision }).decision),
		).toMatchObject({ until: T0 + 5 * MINUTE });
	});

	it("raises the hint floor with minHintSeconds", async () => {
		const adapter = failureEvidence(new FailureHistory(), { minHintSeconds: 120 });
		expect(await decide(adapter, failure(HINT_95S))).toEqual({ kind: "clear" });
	});

	it("marks billing for the whole provider with a backoff expiry", async () => {
		expect(await decide(failureEvidence(new FailureHistory()), failure("402: prepayment credits depleted"))).toEqual({
			kind: "block",
			decision: {
				block: true,
				evidence: "inferred",
				evidenceAt: T0,
				window: "inferred:billing",
				scope: "provider",
				cause: "billing",
				expiry: "backoff",
			},
		});
	});

	it.each([
		["per-minute", PER_MINUTE],
		["short hint", rpc(retryDelay("20s"))],
		["401", '401 {"error":{"code":401,"message":"quota project unauthenticated","status":"UNAUTHENTICATED"}}'],
		["403", '403 {"error":{"code":403,"message":"quota denied","status":"PERMISSION_DENIED"}}'],
		["5xx", "503 overloaded: quota"],
		["safety", "Provider stopped with: SAFETY quota"],
		["weak prose", "processed 429 tokens"],
		["parenthesized 503 mentioning billing", 'OpenAI API error (503): {"error":{"message":"billing service failed"}}'],
		["400 mentioning billing", "400: Invalid billing address"],
	])("never marks %s", async (_name, text) => {
		const history = new FailureHistory();
		const adapter = failureEvidence(history);
		for (let index = 0; index < 3; index++)
			expect(await decide(adapter, failure(text, T0 + index * MINUTE))).toEqual({ kind: "clear" });
	});

	it("abstains without a failed message", async () => {
		const adapter = failureEvidence(new FailureHistory());
		expect(await decide(adapter, { model: CARBON, failedAt: T0 })).toEqual({ kind: "abstain" });
		expect(
			await decide(adapter, { model: CARBON, failedAt: T0, message: { stopReason: "stop", timestamp: T0 } }),
		).toEqual({ kind: "abstain" });
	});

	it("marks an unknown shape on the second distinct failure within 10 minutes", async () => {
		const adapter = failureEvidence(new FailureHistory());
		expect(await decide(adapter, failure(BARE, T0))).toEqual({ kind: "abstain" });
		// The same failure confirmed twice counts once.
		expect(await decide(adapter, failure(BARE, T0))).toEqual({ kind: "abstain" });
		expect(await decide(adapter, failure(BARE, T0 + 9 * MINUTE))).toEqual({
			kind: "block",
			decision: {
				block: true,
				evidence: "inferred",
				evidenceAt: T0 + 9 * MINUTE,
				scope: "model",
				families: ["gemini-4-carbon"],
				cause: "quota",
				window: "inferred:backoff",
				expiry: "backoff",
			},
		});
	});

	it("forgets an unknown-shape failure older than the window or before a success", async () => {
		const history = new FailureHistory();
		const adapter = failureEvidence(history);
		expect(await decide(adapter, failure(BARE, T0))).toEqual({ kind: "abstain" });
		expect(await decide(adapter, failure(BARE, T0 + 10 * MINUTE))).toEqual({ kind: "abstain" });
		history.succeeded(CARBON, T0 + 11 * MINUTE);
		expect(await decide(adapter, failure(BARE, T0 + 12 * MINUTE))).toEqual({ kind: "abstain" });
		// Counts are per model.
		expect(await decide(adapter, failure(BARE, T0 + 13 * MINUTE, { provider: "google", id: "neon" }))).toEqual({
			kind: "abstain",
		});
		expect(await decide(adapter, failure(BARE, T0 + 13 * MINUTE))).toMatchObject({ kind: "block" });
	});

	it("honours a configured repeat threshold", async () => {
		const adapter = failureEvidence(new FailureHistory(), { repeat: { count: 3, withinMinutes: 1 } });
		expect(await decide(adapter, failure(BARE, T0))).toEqual({ kind: "abstain" });
		expect(await decide(adapter, failure(BARE, T0 + 1000))).toEqual({ kind: "abstain" });
		expect(await decide(adapter, failure(BARE, T0 + 2000))).toMatchObject({ kind: "block" });
	});

	it("never counts a failure at or before the model's last success, however late it is recorded", () => {
		const history = new FailureHistory();
		history.succeeded(CARBON, T0 + 2 * MINUTE);
		// An older success never lowers the watermark.
		history.succeeded(CARBON, T0);
		expect(history.record(CARBON, T0 + MINUTE, 10 * MINUTE)).toBe(0);
		expect(history.record(CARBON, T0 + 2 * MINUTE, 10 * MINUTE)).toBe(0);
		expect(history.record(CARBON, T0 + 3 * MINUTE, 10 * MINUTE)).toBe(1);
		history.clear();
		expect(history.record(CARBON, T0 + MINUTE, 10 * MINUTE)).toBe(1);
	});

	it("lets a success erase a failure whose confirmation was still pending", async () => {
		const history = new FailureHistory();
		let release: () => void = () => {};
		const usage: UsageRead = {
			get: (provider) =>
				new Promise((resolve) => {
					const read = { provider, status: "unavailable" as const, windows: [], retrievedAt: T0, expiresAt: T0 };
					release = () => resolve(Object.defineProperty(read, NO_USAGE_SOURCE, { value: true }));
				}),
			decisionFor: () => ({ block: false }),
		};
		const confirm = confirmEvidence(usage, history, undefined);
		const late = confirm(failure(BARE, T0));
		history.succeeded(CARBON, T0 + MINUTE);
		release();
		expect(await late).toBeUndefined();
		const next = confirm(failure(BARE, T0 + 2 * MINUTE));
		release();
		expect(await next).toBeUndefined();
		// A first-failure class confirmed after a later success is superseded too.
		const daily = confirm(failure(DAILY, T0));
		release();
		expect(await daily).toBeUndefined();
	});

	it("keeps failures later than a success and counts out-of-order timestamps up to the failure", () => {
		const history = new FailureHistory();
		expect(history.record(CARBON, T0 + 2 * MINUTE, 10 * MINUTE)).toBe(1);
		expect(history.record(CARBON, T0, 10 * MINUTE)).toBe(1);
		history.succeeded(CARBON, T0 + MINUTE);
		expect(history.record(CARBON, T0 + 3 * MINUTE, 10 * MINUTE)).toBe(2);
		history.clear();
		expect(history.record(CARBON, T0 + 3 * MINUTE, 10 * MINUTE)).toBe(1);
		history.succeeded({ provider: "google", id: "unseen" }, T0);
	});
});

/** An `unavailable` read for a provider without any usage source. */
function noSource(): Partial<UsageSnapshot> {
	return Object.defineProperty({ status: "unavailable" as const }, NO_USAGE_SOURCE, { value: true });
}

function reader(snapshot: Partial<UsageSnapshot>, decision: UsageDecision = { block: false }) {
	const reads: unknown[] = [];
	const usage: UsageRead = {
		get: async (provider, options) => {
			reads.push({ provider, options });
			const read: UsageSnapshot = {
				provider,
				status: "available",
				windows: [],
				retrievedAt: T0,
				expiresAt: T0,
				...snapshot,
			};
			return NO_USAGE_SOURCE in snapshot ? Object.defineProperty(read, NO_USAGE_SOURCE, { value: true }) : read;
		},
		decisionFor: () => decision,
	};
	return { usage, reads };
}

describe("read evidence", () => {
	it("reads fresh after the failure and passes a block decision through", async () => {
		const block: UsageDecision = { block: true, window: "five_hour", scope: "provider" };
		const { usage, reads } = reader({}, block);
		const evidence = await readEvidence(usage).decide(failure(BARE));
		expect(evidence).toEqual({ kind: "block", decision: block });
		expect((evidence as { decision: UsageDecision }).decision).toBe(block);
		expect(reads).toEqual([{ provider: "google", options: { fresh: true, notBefore: T0, signal: undefined } }]);
	});

	it("clears on an available read with room, even with fallbackOnReadError", async () => {
		expect(await readEvidence(reader({}).usage, true).decide(failure(BARE))).toEqual({ kind: "clear" });
	});

	it("abstains only when the provider has no usage source", async () => {
		expect(await readEvidence(reader(noSource()).usage).decide(failure(BARE))).toEqual({ kind: "abstain" });
	});

	it.each([
		["unavailable (no credential, or a retired collector)", { status: "unavailable" as const }],
		["error", { status: "error" as const }],
		["stale", { status: "stale" as const }],
		["older than the failure", { retrievedAt: T0 - 1 }],
	])("clears on an %s read unless fallbackOnReadError", async (_name, snapshot) => {
		expect(await readEvidence(reader(snapshot).usage).decide(failure(BARE))).toEqual({ kind: "clear" });
		expect(await readEvidence(reader(snapshot).usage, true).decide(failure(BARE))).toEqual({ kind: "abstain" });
	});
});

describe("usage sources", () => {
	const ctx = { modelRegistry: {} } as RegistryContext;

	it("flags only a missing collector or an incompatible credential as no usage source", async () => {
		const tokens: Record<string, string> = { anthropic: "sk-ant-api03-synthetic" };
		const usage = new UsageService({
			now: () => T0,
			getAccessToken: async (_ctx, provider) => tokens[provider],
			fetch: async () => new Response("{}"),
		});
		const flagged = async (provider: string) => {
			const snapshot = await usage.get(ctx, provider, { fresh: true, notBefore: T0 });
			return [snapshot.status, NO_USAGE_SOURCE in snapshot];
		};
		expect(await flagged("google")).toEqual(["unavailable", true]);
		expect(await flagged("anthropic")).toEqual(["unavailable", true]);
		// A registered collector without a credential is a failed read, not a missing source.
		expect(await flagged("openai-codex")).toEqual(["unavailable", false]);
		// The flag never changes snapshot equality.
		expect(Object.getOwnPropertyDescriptor(await usage.get(ctx, "google"), NO_USAGE_SOURCE)).toMatchObject({
			enumerable: false,
		});
	});
});

function fixed(name: ConfirmationEvidence["name"], evidence: Evidence, calls: string[]): ConfirmationEvidence {
	return {
		name,
		decide: async () => {
			calls.push(name);
			return evidence;
		},
	};
}

describe("composeEvidence", () => {
	const block = { kind: "block", decision: { block: true, window: "w" } } as const;

	it("asks adapters in order until one blocks or clears", async () => {
		const calls: string[] = [];
		const chain = [
			fixed("read", { kind: "abstain" }, calls),
			fixed("failure", block, calls),
			fixed("observed", { kind: "clear" }, calls),
		];
		expect(await composeEvidence(chain)(failure(BARE))).toBe(block.decision);
		expect(calls).toEqual(["read", "failure"]);
	});

	it("stops at an authoritative clear", async () => {
		const calls: string[] = [];
		const chain = [fixed("read", { kind: "clear" }, calls), fixed("failure", block, calls)];
		expect(await composeEvidence(chain)(failure(BARE))).toBeUndefined();
		expect(calls).toEqual(["read"]);
	});

	it("confirms nothing when every adapter abstains", async () => {
		expect(await composeEvidence([fixed("read", { kind: "abstain" }, [])])(failure(BARE))).toBeUndefined();
	});

	it("asks no further adapter once cancelled", async () => {
		const calls: string[] = [];
		const controller = new AbortController();
		const chain: ConfirmationEvidence[] = [
			{
				name: "read",
				decide: async () => {
					controller.abort();
					return { kind: "abstain" };
				},
			},
			fixed("failure", block, calls),
		];
		expect(await composeEvidence(chain)({ ...failure(BARE), signal: controller.signal })).toBeUndefined();
		expect(calls).toEqual([]);
	});
});

describe("confirmEvidence", () => {
	const block: UsageDecision = { block: true, window: "five_hour", scope: "provider" };

	it.each([
		["401", "401: quota project unauthenticated"],
		["503", "503: quota backend failed"],
		["safety", "Provider stopped with: SAFETY (quota)"],
		["per-minute", PER_MINUTE],
	])("applies the never-mark rules before a %s reaches the read", async (_name, text) => {
		const { usage, reads } = reader({}, block);
		expect(await confirmEvidence(usage, new FailureHistory(), undefined)(failure(text))).toBeUndefined();
		expect(reads).toEqual([]);
	});

	it("lets a quota failure, or a confirmation without a failed message, reach the read", async () => {
		const { usage, reads } = reader({}, block);
		const confirm = confirmEvidence(usage, new FailureHistory(), undefined);
		expect(await confirm(failure(BARE))).toBe(block);
		expect(await confirm({ model: CARBON, failedAt: T0 })).toBe(block);
		expect(reads).toHaveLength(2);
	});
});

describe("evidenceChain", () => {
	const history = new FailureHistory();
	const { usage } = reader({});

	it("defaults to read then failure and skips observed until the ledger exists", () => {
		expect(evidenceChain(usage, history, undefined).map((adapter) => adapter.name)).toEqual(["read", "failure"]);
	});

	it("follows the declared order", () => {
		expect(
			evidenceChain(usage, history, { evidence: ["failure", "observed", "read"] }).map((adapter) => adapter.name),
		).toEqual(["failure", "read"]);
		expect(evidenceChain(usage, history, { evidence: ["read"] }).map((adapter) => adapter.name)).toEqual(["read"]);
	});

	it("passes fallbackOnReadError and failure settings to their adapters", async () => {
		const [read, inferred] = evidenceChain(reader({ status: "error" }).usage, new FailureHistory(), {
			fallbackOnReadError: true,
			failure: { minHintSeconds: 120 },
		});
		expect(await read?.decide(failure(BARE))).toEqual({ kind: "abstain" });
		expect(await inferred?.decide(failure(HINT_95S))).toEqual({ kind: "clear" });
	});
});

describe("inferred marks", () => {
	function tracked() {
		const clock = { now: T0 };
		return { clock, tracker: new ExhaustionTracker(() => clock.now) };
	}

	it("labels failure marks inferred and read marks read, keeping read marks at six fields", async () => {
		const { tracker } = tracked();
		const decision = await decide(failureEvidence(new FailureHistory()), failure(DAILY));
		const inferred = tracker.mark(CARBON, (decision as { decision: UsageDecision }).decision);
		expect(inferred).toEqual({
			provider: "google",
			families: ["gemini-4-carbon"],
			window: "inferred:daily",
			until: nextPacificMidnight(T0),
			resetKnown: true,
			confirmations: 1,
			evidence: "inferred",
			expiry: "window-reset",
			cause: "quota",
			markedAt: T0,
		});
		expect(markEvidence(inferred)).toBe("inferred");
		const read = tracker.mark({ provider: "anthropic", id: "claude-sonnet-5" }, { block: true, window: "five_hour" });
		expect(Object.keys(read)).toEqual(["provider", "families", "window", "until", "resetKnown", "confirmations"]);
		expect(markEvidence(read)).toBe("read");
	});

	it("copies only the provenance a decision carries", () => {
		const { tracker } = tracked();
		const mark = tracker.mark(CARBON, { block: true, window: "observed:rpd", evidence: "observed" });
		expect(mark).toMatchObject({ evidence: "observed", markedAt: T0 });
		expect(mark).not.toHaveProperty("expiry");
		expect(mark).not.toHaveProperty("cause");
	});

	it("counts one failure once, but a later failure grows the backoff", () => {
		const { clock, tracker } = tracked();
		const decision = { block: true, window: "inferred:backoff", evidence: "inferred", evidenceAt: T0 } as const;
		const first = tracker.mark(CARBON, decision);
		clock.now += 1000;
		expect(tracker.mark(CARBON, decision)).toBe(first);
		expect(first).toMatchObject({ confirmations: 1, until: T0 + 5 * MINUTE });
		const later = tracker.mark(CARBON, { ...decision, evidenceAt: T0 + 1000 });
		expect(later).toMatchObject({ confirmations: 2, until: T0 + 1000 + 10 * MINUTE });
	});

	it("re-counts after the mark lapses, and never dedupes read marks", () => {
		const { clock, tracker } = tracked();
		const decision = { block: true, window: "inferred:backoff", evidence: "inferred", evidenceAt: T0 } as const;
		tracker.mark(CARBON, decision);
		clock.now += 5 * MINUTE;
		expect(tracker.mark(CARBON, decision).confirmations).toBe(2);
		const read = { provider: "anthropic", id: "claude-sonnet-5" };
		tracker.mark(read, { block: true, window: "five_hour" });
		expect(tracker.mark(read, { block: true, window: "five_hour", evidenceAt: T0 }).confirmations).toBe(2);
	});

	it("is never cleared by a fresh read, even one naming its window", () => {
		const { tracker } = tracked();
		tracker.mark(CARBON, {
			block: true,
			window: "inferred:daily",
			scope: "model",
			families: ["gemini-4-carbon"],
			resetAt: T0 + MINUTE,
			evidence: "inferred",
		});
		tracker.reconcile({
			provider: "google",
			status: "available",
			windows: [{ name: "inferred:daily", usedPercent: 0, scope: "model", families: ["gemini-4-carbon"] }],
			retrievedAt: T0,
			expiresAt: T0 + MINUTE,
		});
		expect(tracker.active()).toHaveLength(1);
	});

	it("scopes model marks by whole token and provider marks to every model", () => {
		const { tracker } = tracked();
		tracker.mark(CARBON, { block: true, window: "inferred:daily", scope: "model", families: [CARBON.id] });
		expect(tracker.blocking({ provider: "google", id: "gemini-4-neon" })).toBeUndefined();
		// K2: a suffixed id shares the token and is covered too.
		expect(tracker.blocking({ provider: "google", id: "gemini-4-carbon-preview" })).toBeDefined();
		expect(tracker.blocking({ provider: "google-vertex", id: CARBON.id })).toBeUndefined();
		tracker.mark(CARBON, { block: true, window: "inferred:billing", scope: "provider" });
		expect(tracker.blocking({ provider: "google", id: "gemini-4-neon" })).toMatchObject({ window: "inferred:billing" });
	});
});

describe("routing on the composed chain", () => {
	const profile: Profile = { id: "metered", name: "Metered", chain: [CARBON, { ...NEON, thinking: "xhigh" }] };
	const asModel = (ref: { provider: string; id: string }) => ({ ...ref, api: "test" }) as unknown as Model<Api>;

	function routed() {
		const clock = { now: T0 };
		const tracker = new ExhaustionTracker(() => clock.now);
		const router = new Router({ decisionFor: () => ({ block: false }) }, tracker, () => clock.now);
		const history = new FailureHistory();
		const confirm = composeEvidence(evidenceChain(reader(noSource()).usage, history, undefined));
		const env: RouteEnv = {
			resolve: (entry) => asModel(entry),
			refresh: (model, signal, failedAt, message) => confirm({ model, signal, failedAt, message }),
		};
		return { clock, tracker, router, env };
	}

	const retry = (errorMessage: string): ModelRouteRequest => ({
		model: asModel({ provider: "router", id: "metered" }),
		reason: "retry",
		thinkingLevel: "low",
		messages: [],
		failed: {
			model: asModel(CARBON),
			message: fauxAssistantMessage("", { stopReason: "error", errorMessage, timestamp: T0 }),
		},
	});

	it("L7: racing confirmations of one failure mark once", async () => {
		const { tracker, router, env } = routed();
		const message = fauxAssistantMessage("", { stopReason: "error", errorMessage: DAILY, timestamp: T0 });
		const results = await Promise.all([
			router.confirm(asModel(CARBON), env, undefined, T0, message),
			router.confirm(asModel(CARBON), env, undefined, T0, message),
		]);
		expect(results).toEqual([true, true]);
		expect(tracker.active()).toMatchObject([{ confirmations: 1, evidence: "inferred" }]);
	});

	it("C5: fails over to a member pinned xhigh", async () => {
		const { router, env } = routed();
		const route = await router.route(profile, retry(DAILY), env);
		expect(route).toMatchObject({ model: { id: NEON.id }, thinkingLevel: "xhigh" });
	});

	it("C7: concurrent requests all see the mark", async () => {
		const { router, env } = routed();
		await router.route(profile, retry(DAILY), env);
		const user = { ...retry(DAILY), reason: "user" as const, failed: undefined };
		const routes = await Promise.all([router.route(profile, user, env), router.route(profile, user, env)]);
		expect(routes.map((route) => route.model.id)).toEqual([NEON.id, NEON.id]);
	});

	it("discards an inferred deadline that elapsed before confirmation finished", async () => {
		const { clock, tracker, router, env } = routed();
		const text = rpc(retryDelay("60s"));
		const message = fauxAssistantMessage("", { stopReason: "error", errorMessage: text, timestamp: T0 });
		clock.now = T0 + 61_000;
		expect(await router.confirm(asModel(CARBON), env, undefined, T0, message)).toBe(false);
		expect(tracker.active()).toEqual([]);
		// The same hint confirmed in time marks until failedAt + hint.
		clock.now = T0 + 59_000;
		expect(await router.confirm(asModel(CARBON), env, undefined, T0, message)).toBe(true);
		expect(tracker.active()).toMatchObject([{ until: T0 + 60_000, expiry: "hinted" }]);
	});

	it("never confirms a cancelled failure", async () => {
		const { tracker, router, env } = routed();
		const controller = new AbortController();
		controller.abort();
		const message = fauxAssistantMessage("", { stopReason: "error", errorMessage: DAILY, timestamp: T0 });
		expect(await router.confirm(asModel(CARBON), env, controller.signal, T0, message)).toBe(false);
		expect(tracker.active()).toEqual([]);
	});
});

describe("the confirmation gate", () => {
	it.each([
		"RESOURCE_EXHAUSTED",
		"402",
		"Payment required",
		"credits depleted",
		"Insufficient credits for this request",
		"insufficient balance",
		"insufficient funds",
		"Credits exhausted",
		"No prepayment credits",
	])("confirms %s", (errorMessage) => {
		expect(isQuotaError({ stopReason: "error", errorMessage })).toBe(true);
	});

	it("ignores digits that merely contain 402", () => {
		expect(isQuotaError({ stopReason: "error", errorMessage: "request took 4020ms" })).toBe(false);
	});
});
