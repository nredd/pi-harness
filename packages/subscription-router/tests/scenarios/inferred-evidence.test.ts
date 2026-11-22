/** Evidence-chain failover through real sessions: faux `google` (metered) and `anthropic` (OAuth or API key). */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createHarness,
	createTestUiContext,
	fauxAssistantMessage,
	type Harness,
	registerFauxProvider,
} from "@nredd/pi-test-lib/harness";
import { afterEach, describe, expect, it } from "vitest";
import type { ChainEntry, Profile, ProviderConfig } from "../../src/config.ts";
import { ExhaustionTracker, markEvidence } from "../../src/exhaustion.ts";
import { nextPacificMidnight } from "../../src/failure.ts";
import { createSubscriptionRouter } from "../../src/index.ts";
import { refKey } from "../../src/model-ref.ts";
import { UsageService } from "../../src/usage.ts";
import { Clock } from "../fixtures/router.ts";

const MINUTE = 60_000;
const CARBON: ChainEntry = { provider: "google", id: "gemini-4-carbon" };
const NEON: ChainEntry = { provider: "google", id: "gemini-4-neon" };
const VERTEX: ChainEntry = { provider: "google-vertex", id: "gemini-4-carbon" };
const SONNET: ChainEntry = { provider: "anthropic", id: "claude-sonnet-5-5" };
const TERRA: ChainEntry = { provider: "openai-codex", id: "gpt-5.6-terra" };

function rpc(...details: unknown[]): string {
	return `429: ${JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details } })}`;
}
const quotaId = (id: string) => ({
	"@type": "type.googleapis.com/google.rpc.QuotaFailure",
	violations: [{ quotaId: id }],
});
const retryDelay = (delay: string) => ({ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: delay });

const DAILY = rpc(quotaId("GenerateRequestsPerDayPerProjectPerModel"));
const PER_MINUTE = rpc(quotaId("GenerateRequestsPerMinutePerProjectPerModel"));
const HINT_95S = rpc(retryDelay("95s"));
const HINT_2H = rpc(retryDelay("7200s"));
const BARE = "429 Too Many Requests";
const BILLING = "402: prepayment credits depleted";
const AUTH = '403 {"error":{"code":403,"message":"quota project permission denied","status":"PERMISSION_DENIED"}}';

/** One scripted outcome: an error message, partial text plus an error, or success. */
type Step = "ok" | string | { partial: string; error: string };

interface Options {
	chain: ChainEntry[];
	strategy?: Profile["strategy"];
	providers?: Record<string, ProviderConfig>;
	/** Credentials per provider; `anthropic` OAuth reads usage through `usagePercent`. */
	tokens?: Record<string, string>;
	/** Anthropic usage utilization, or an HTTP status for a failed read. Mutable through `Scenario.usage`. */
	usage?: { percent: number } | { status: number };
	clock?: Clock;
}

/** A real router session with a real usage service whose only transport is scripted. */
class Scenario {
	readonly calls: string[] = [];
	/** Each response's message timestamp, parallel to `calls`. */
	readonly times: number[] = [];
	readonly fetches: string[] = [];
	readonly clock: Clock;
	readonly tracker: ExhaustionTracker;
	readonly notifications: string[] = [];
	readonly scripts = new Map<string, Step[]>();
	harness!: Harness;
	usage: { percent: number } | { status: number };
	/** Runs inside each usage fetch, before it answers. */
	onFetch?: () => void;
	/** The session's extension event bus, for the pi-subagents RPCs. */
	events!: ExtensionAPI["events"];
	private readonly registrations = [
		registerFauxProvider({ provider: "google", models: [{ id: CARBON.id }, { id: NEON.id }] }),
		registerFauxProvider({ provider: "google-vertex", models: [{ id: VERTEX.id }] }),
		registerFauxProvider({ provider: "anthropic", models: [{ id: SONNET.id }] }),
		registerFauxProvider({ provider: "openai-codex", models: [{ id: TERRA.id }] }),
	];

	constructor(readonly options: Options) {
		this.clock = options.clock ?? new Clock();
		this.tracker = new ExhaustionTracker(this.clock.now);
		this.usage = options.usage ?? { percent: 0 };
	}

	async start(): Promise<this> {
		const { clock, options } = this;
		const usage = new UsageService({
			now: clock.now,
			getAccessToken: async (_ctx, provider) => options.tokens?.[provider],
			fetch: async (url) => {
				this.fetches.push(url);
				this.onFetch?.();
				const read = this.usage;
				if ("status" in read) return new Response(null, { status: read.status });
				const resets_at = new Date(clock.now() + 3 * 3_600_000).toISOString();
				return new Response(JSON.stringify({ five_hour: { utilization: read.percent, resets_at } }));
			},
		});
		const profile: Profile = {
			id: "mixed",
			name: "Mixed",
			chain: options.chain,
			...(options.strategy ? { strategy: options.strategy } : {}),
		};
		this.harness = await createHarness({
			useModelRuntimeStream: true,
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 0 } },
			extensionFactories: [
				(pi) => {
					this.events = pi.events;
				},
				createSubscriptionRouter({
					config: { ok: true, profiles: [profile], ...(options.providers ? { providers: options.providers } : {}) },
					usage,
					tracker: this.tracker,
					now: clock.now,
				}),
			],
		});
		for (const registration of this.registrations) {
			const model = registration.getModel();
			this.harness.session.modelRuntime.registerProvider(model.provider, {
				baseUrl: model.baseUrl,
				apiKey: "faux",
				api: registration.api,
				models: registration.models,
			});
			registration.setResponses(
				Array.from({ length: 16 }, () => (_context, _options, _state, physical) => this.respond(physical)),
			);
		}
		await this.harness.session.bindExtensions({
			mode: "rpc",
			uiContext: createTestUiContext({
				notify: (message) => {
					this.notifications.push(message);
				},
			}),
		});
		const model = this.harness.session.modelRuntime.getModel("router", "mixed");
		if (!model) throw new Error("router/mixed was not registered");
		await this.harness.session.setModel(model);
		return this;
	}

	script(entry: ChainEntry, ...steps: Step[]): this {
		this.scripts.set(refKey(entry), steps);
		return this;
	}

	private respond(physical: { provider: string; id: string }): AssistantMessage {
		const key = refKey(physical);
		this.calls.push(key);
		const step = this.scripts.get(key)?.shift() ?? "ok";
		// Every response takes a second, so distinct failures have distinct timestamps.
		this.clock.advance(1000);
		const timestamp = this.clock.now();
		this.times.push(timestamp);
		if (step === "ok") return fauxAssistantMessage(`answered by ${key}`, { timestamp });
		if (typeof step === "string")
			return fauxAssistantMessage("", { stopReason: "error", errorMessage: step, timestamp });
		return fauxAssistantMessage(step.partial, { stopReason: "error", errorMessage: step.error, timestamp });
	}

	/** Assistant completions for one prompt. */
	async prompt(): Promise<AssistantMessage[]> {
		const before = this.harness.events.length;
		await this.harness.session.prompt("exercise evidence");
		return this.harness.events
			.slice(before)
			.flatMap((event) => (event.type === "message_end" && event.message.role === "assistant" ? [event.message] : []));
	}

	/** One `router:rpc:admit` round trip. */
	admit(model: string): Promise<unknown> {
		return new Promise((resolve) => {
			this.events.on("router:rpc:admit:reply:admission", (reply) => resolve((reply as { data: unknown }).data));
			this.events.emit("router:rpc:admit", { requestId: "admission", model });
		});
	}

	cleanup(): void {
		this.harness?.cleanup();
		for (const registration of this.registrations) registration.unregister();
	}
}

let scenario: Scenario | undefined;
afterEach(() => scenario?.cleanup());

async function run(options: Options): Promise<Scenario> {
	scenario = new Scenario(options);
	return scenario.start();
}

describe("uncollected metered providers fail over on inferred evidence", () => {
	it("P2/S5/K1/L3: a daily 429 marks only that model until Pacific midnight; the next member answers", async () => {
		const s = await run({ chain: [CARBON, NEON] });
		s.script(CARBON, DAILY);
		const messages = await s.prompt();
		expect(s.calls).toEqual(["google/gemini-4-carbon", "google/gemini-4-neon"]);
		expect(messages.at(-1)).toMatchObject({ stopReason: "stop", provider: "google", model: NEON.id });
		expect(s.tracker.active()).toEqual([
			{
				provider: "google",
				families: [CARBON.id],
				window: "inferred:daily",
				until: nextPacificMidnight(s.times[0] as number),
				resetKnown: true,
				confirmations: 1,
				evidence: "inferred",
				expiry: "window-reset",
				cause: "quota",
				markedAt: s.times[0],
			},
		]);
		expect(s.fetches).toEqual([]);
	});

	it("S6/L1/L2: a hint of 95s marks until the hint, then the model is eligible again", async () => {
		const s = await run({ chain: [CARBON, NEON] });
		s.script(CARBON, HINT_95S);
		await s.prompt();
		const until = (s.times[0] as number) + 95_000;
		expect(s.tracker.active()).toMatchObject([{ window: "inferred:hint", until, expiry: "hinted" }]);
		s.clock.advance(until - s.clock.now());
		expect(s.tracker.active()).toEqual([]);
		await s.prompt();
		expect(s.calls.at(-1)).toBe("google/gemini-4-carbon");
	});

	it("caps a two-hour hint at 60 minutes", async () => {
		const s = await run({ chain: [CARBON, NEON] });
		s.script(CARBON, HINT_2H);
		await s.prompt();
		expect(s.tracker.active()).toMatchObject([{ until: (s.times[0] as number) + 60 * MINUTE, resetKnown: true }]);
	});

	it("S7: per-minute throttles never mark and core retries the same model", async () => {
		const s = await run({ chain: [CARBON, NEON] });
		s.script(CARBON, PER_MINUTE, PER_MINUTE, PER_MINUTE, PER_MINUTE);
		await s.prompt();
		expect(s.calls).toEqual(Array(4).fill("google/gemini-4-carbon"));
		expect(s.tracker.active()).toEqual([]);
	});

	it("S8/L7: an unknown 429 marks on its second distinct failure with a 5-minute backoff", async () => {
		const s = await run({ chain: [CARBON, NEON] });
		s.script(CARBON, BARE, BARE);
		await s.prompt();
		expect(s.calls).toEqual(["google/gemini-4-carbon", "google/gemini-4-carbon", "google/gemini-4-neon"]);
		expect(s.tracker.active()).toMatchObject([
			{ window: "inferred:backoff", expiry: "backoff", confirmations: 1, until: (s.times[1] as number) + 5 * MINUTE },
		]);
	});

	it("S8: a success between two unknown 429s resets the count", async () => {
		const s = await run({ chain: [CARBON, NEON] });
		s.script(CARBON, BARE, "ok", BARE, "ok");
		await s.prompt();
		s.clock.advance(MINUTE);
		await s.prompt();
		expect(s.calls).toEqual(Array(4).fill("google/gemini-4-carbon"));
		expect(s.tracker.active()).toEqual([]);
	});

	it("S9/K3: a 402 blocks the whole provider and leaves google-vertex untouched", async () => {
		const s = await run({ chain: [CARBON, NEON, VERTEX] });
		s.script(CARBON, BILLING);
		const messages = await s.prompt();
		expect(s.calls).toEqual(["google/gemini-4-carbon", "google-vertex/gemini-4-carbon"]);
		expect(messages.at(-1)).toMatchObject({ provider: "google-vertex", stopReason: "stop" });
		expect(s.tracker.active()).toMatchObject([
			{ provider: "google", families: undefined, window: "inferred:billing", cause: "billing", expiry: "backoff" },
		]);
		expect(s.notifications).toEqual([
			"subscription-router: google/gemini-4-carbon is out of quota, continuing on google-vertex/gemini-4-carbon",
		]);
	});

	it("auth failures surface and never mark, even when they mention quota", async () => {
		const s = await run({ chain: [CARBON, NEON] });
		s.script(CARBON, AUTH, AUTH, AUTH, AUTH);
		const messages = await s.prompt();
		expect(s.calls.every((call) => call === "google/gemini-4-carbon")).toBe(true);
		expect(messages.at(-1)).toMatchObject({ stopReason: "error", errorMessage: AUTH });
		expect(s.tracker.active()).toEqual([]);
	});
});

describe("collected providers keep read-only confirmation", () => {
	const OAUTH = { anthropic: "synthetic-oauth" };

	it("P5: anthropic with an API key reads nothing and fails over on inferred evidence", async () => {
		const s = await run({ chain: [SONNET, NEON], tokens: { anthropic: "sk-ant-api03-synthetic" } });
		s.script(SONNET, BARE, BARE);
		await s.prompt();
		expect(s.calls).toEqual(["anthropic/claude-sonnet-5-5", "anthropic/claude-sonnet-5-5", "google/gemini-4-neon"]);
		expect(s.fetches).toEqual([]);
		expect(s.tracker.active()).toMatchObject([{ provider: "anthropic", evidence: "inferred" }]);
	});

	it("S1: a fresh read showing the block marks it as read-confirmed", async () => {
		const s = await run({ chain: [SONNET, NEON], tokens: OAUTH });
		s.usage = { percent: 100 };
		s.script(SONNET, BARE);
		await s.prompt();
		expect(s.calls).toEqual(["anthropic/claude-sonnet-5-5", "google/gemini-4-neon"]);
		const [mark] = s.tracker.active();
		expect(mark).toMatchObject({ provider: "anthropic", window: "five_hour", resetKnown: true });
		expect(mark && markEvidence(mark)).toBe("read");
		expect(mark).not.toHaveProperty("evidence");
	});

	it.each([
		[
			"quota-worded 401",
			'401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token lacks quota scope"}}',
		],
		["quota-worded 503", "503: quota backend failed"],
		["safety stop mentioning quota", "Provider stopped with: SAFETY (quota)"],
		["per-minute throttle", PER_MINUTE],
	])("S10-S12: a %s never marks, even when a fresh read would show the block", async (_name, text) => {
		const s = await run({ chain: [SONNET, NEON], tokens: OAUTH });
		s.usage = { percent: 100 };
		s.script(SONNET, text, text, text, text);
		const messages = await s.prompt();
		expect(s.calls.every((call) => call === "anthropic/claude-sonnet-5-5")).toBe(true);
		expect(messages.at(-1)).toMatchObject({ stopReason: "error", errorMessage: text });
		expect(s.tracker.active()).toEqual([]);
	});

	it("S2: a fresh read with room is authoritative; a daily token never reaches inference", async () => {
		const s = await run({ chain: [SONNET, NEON], tokens: OAUTH, usage: { percent: 40 } });
		s.script(SONNET, DAILY, DAILY, DAILY, DAILY);
		await s.prompt();
		expect(s.calls).toEqual(Array(4).fill("anthropic/claude-sonnet-5-5"));
		expect(s.tracker.active()).toEqual([]);
	});

	it("S3: a failed read confirms nothing by default", async () => {
		const s = await run({ chain: [SONNET, NEON], tokens: OAUTH, usage: { status: 500 } });
		s.script(SONNET, DAILY, DAILY, DAILY, DAILY);
		await s.prompt();
		expect(s.calls).toEqual(Array(4).fill("anthropic/claude-sonnet-5-5"));
		expect(s.fetches.length).toBeGreaterThan(0);
		expect(s.tracker.active()).toEqual([]);
	});

	it("S3: fallbackOnReadError lets the failure adapter infer the block", async () => {
		const s = await run({
			chain: [SONNET, NEON],
			tokens: OAUTH,
			usage: { status: 500 },
			providers: { anthropic: { fallbackOnReadError: true } },
		});
		s.script(SONNET, DAILY);
		await s.prompt();
		expect(s.calls).toEqual(["anthropic/claude-sonnet-5-5", "google/gemini-4-neon"]);
		expect(s.tracker.active()).toMatchObject([
			{ provider: "anthropic", window: "inferred:daily", evidence: "inferred" },
		]);
	});

	it("a declared evidence list without read skips the usage read", async () => {
		const s = await run({
			chain: [SONNET, NEON],
			tokens: OAUTH,
			usage: { percent: 40 },
			providers: { anthropic: { evidence: ["failure"] } },
		});
		const before = s.fetches.length;
		s.script(SONNET, DAILY);
		await s.prompt();
		expect(s.fetches.length).toBe(before);
		expect(s.calls).toEqual(["anthropic/claude-sonnet-5-5", "google/gemini-4-neon"]);
	});
});

describe("chain situations", () => {
	it("C1/C3: a single uncollected member fails fast with the inferred reason and reset", async () => {
		const s = await run({ chain: [CARBON] });
		s.script(CARBON, BARE, BARE);
		const messages = await s.prompt();
		expect(s.calls).toEqual(["google/gemini-4-carbon", "google/gemini-4-carbon"]);
		const until = (s.times[1] as number) + 5 * MINUTE;
		expect(messages.at(-1)?.errorMessage ?? "").toContain(
			`router/mixed: every model is unavailable (google/gemini-4-carbon: inferred:backoff exhausted, backing off until ${new Date(until).toISOString().replace(".000Z", "Z")})`,
		);
	});

	it("C1: every member exhausted reports the earliest reset", async () => {
		const s = await run({ chain: [CARBON, NEON] });
		s.script(CARBON, HINT_95S);
		s.script(NEON, HINT_2H);
		const messages = await s.prompt();
		const earliest = new Date((s.times[0] as number) + 95_000).toISOString().replace(".000Z", "Z");
		expect(messages.at(-1)?.errorMessage ?? "").toContain(`Earliest reset ${earliest}.`);
		expect(s.tracker.active()).toHaveLength(2);
	});

	it("C2: a balanced chain uses the metered member only while measured ones are blocked", async () => {
		const s = await run({
			chain: [NEON, SONNET],
			strategy: "balanced",
			tokens: { anthropic: "synthetic-oauth" },
			usage: { percent: 90 },
		});
		await s.prompt();
		// Warm the anthropic cache, then route again: measured beats fallback even at 90% used.
		await s.prompt();
		expect(s.calls.at(-1)).toBe("anthropic/claude-sonnet-5-5");
	});

	it("C4: a three-provider profile fails over past a read mark and an inferred mark", async () => {
		const s = await run({
			chain: [SONNET, CARBON, TERRA],
			tokens: { anthropic: "synthetic-oauth" },
		});
		s.usage = { percent: 100 };
		s.script(SONNET, BARE);
		s.script(CARBON, DAILY);
		const messages = await s.prompt();
		expect(s.calls).toEqual(["anthropic/claude-sonnet-5-5", "google/gemini-4-carbon", "openai-codex/gpt-5.6-terra"]);
		expect(messages.at(-1)).toMatchObject({ provider: "openai-codex", stopReason: "stop" });
		expect(s.tracker.active().map(markEvidence)).toEqual(["read", "inferred"]);
	});

	it("C6: a continuation leaves a marked incumbent", async () => {
		const s = await run({ chain: [CARBON, NEON] });
		await s.prompt();
		s.script(CARBON, DAILY);
		await s.prompt();
		await s.prompt();
		expect(s.calls).toEqual([
			"google/gemini-4-carbon",
			"google/gemini-4-carbon",
			"google/gemini-4-neon",
			"google/gemini-4-neon",
		]);
	});

	it("C8: admission honours inferred marks", async () => {
		const s = await run({ chain: [CARBON, NEON] });
		s.script(CARBON, DAILY);
		await s.prompt();
		const until = nextPacificMidnight(s.times[0] as number);
		expect(await s.admit("router/mixed")).toEqual({ ok: true, resolvedModel: "google/gemini-4-neon" });
		expect(await s.admit("google/gemini-4-carbon")).toEqual({ ok: false, resetAt: until, wait: true });
	});

	it.each([true, false])(
		"C9: cancellation during the evidence wait (%s) writes no mark and no context edit",
		async (abort) => {
			const s = await run({
				chain: [SONNET, NEON],
				tokens: { anthropic: "synthetic-oauth" },
				providers: { anthropic: { fallbackOnReadError: true } },
			});
			await s.harness.session.prompt("/router refresh");
			const before = s.fetches.length;
			s.usage = { status: 500 };
			if (abort) s.onFetch = () => void s.harness.session.abort();
			s.script(SONNET, BILLING);
			await s.prompt();
			expect(s.fetches.length).toBe(before + 1);
			const switched = s.notifications.filter((text) => text.includes("out of quota"));
			if (abort) {
				expect(s.calls).toEqual(["anthropic/claude-sonnet-5-5"]);
				expect(s.tracker.active()).toEqual([]);
				expect(switched).toEqual([]);
				expect(s.harness.eventsOfType("message_end").at(-1)?.message).toMatchObject({ errorMessage: BILLING });
			} else {
				// Control: the same failure without cancellation is inferred and recovered.
				expect(s.calls).toEqual(["anthropic/claude-sonnet-5-5", "google/gemini-4-neon"]);
				expect(s.tracker.active()).toMatchObject([{ provider: "anthropic", window: "inferred:billing" }]);
				expect(switched).toHaveLength(1);
			}
		},
	);

	it("C10: partial output is marked, then replay is refused", async () => {
		const s = await run({ chain: [CARBON, NEON] });
		s.script(CARBON, { partial: "visible", error: DAILY });
		const messages = await s.prompt();
		expect(s.calls).toEqual(["google/gemini-4-carbon"]);
		expect(messages.at(-1)?.errorMessage ?? "").toContain("refusing to replay a partial response");
		expect(s.tracker.active()).toMatchObject([{ window: "inferred:daily", evidence: "inferred" }]);
	});

	it("/router reset forgets failure counts", async () => {
		const s = await run({ chain: [CARBON, NEON] });
		// One counted unknown 429, then per-minute throttles exhaust core retries without a success.
		s.script(CARBON, BARE, PER_MINUTE, PER_MINUTE, PER_MINUTE);
		await s.prompt();
		await s.harness.session.prompt("/router reset");
		// The first unknown 429 was forgotten: one more within 10 minutes is not a repeat.
		s.script(CARBON, BARE, "ok");
		s.clock.advance(MINUTE);
		await s.prompt();
		expect(s.tracker.active()).toEqual([]);
		expect(s.calls).toEqual(Array(6).fill("google/gemini-4-carbon"));
	});
});
