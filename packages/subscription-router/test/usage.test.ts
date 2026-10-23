import { describe, expect, it, vi } from "vitest";
import { modelMatchesFamily, UsageService, type UsageTransport } from "../src/usage.js";

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const FUTURE_RESET = "2023-11-15T00:00:00Z"; // ~1.5 days after T0
const FUTURE_RESET_MS = Date.parse(FUTURE_RESET);
const PAST_RESET = "2023-11-14T00:00:00Z"; // before T0
const SONNET = { provider: "anthropic", id: "claude-sonnet-5" };

type Reply = { body: unknown; status?: number; headers?: Record<string, string> };

/** Scripted transport: replies in order (last one repeats), controllable clock, recorded requests. */
function harness(replies: Reply[], token = "token") {
	const clock = { now: T0 };
	const requests: Array<{ url: string; headers: Record<string, string> }> = [];
	const tokens: string[] = [];
	const transport: UsageTransport = {
		fetch: async (url, init) => {
			const reply = replies[Math.min(requests.length, replies.length - 1)] ?? { body: {} };
			requests.push({ url, headers: init.headers as Record<string, string> });
			return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: reply.headers });
		},
		now: () => clock.now,
		getAccessToken: async (_ctx, provider) => {
			tokens.push(provider);
			return token;
		},
	};
	return { service: new UsageService(transport), clock, requests, tokens };
}

const ctx = {} as never;

function jwt(payload: unknown): string {
	return `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
}

describe("UsageService", () => {
	it("parses Anthropic's RFC 3339 resets_at and blocks exhausted included quota", async () => {
		const { service } = harness([
			{
				body: {
					five_hour: { utilization: 100.0, resets_at: FUTURE_RESET },
					seven_day: { utilization: 10, resets_at: "not a date" },
				},
			},
		]);
		const result = await service.get(ctx, "anthropic");
		expect(result.status).toBe("available");
		expect(result.windows.map((w) => w.resetAt)).toEqual([FUTURE_RESET_MS, undefined]);
		expect(service.decisionFor(SONNET)).toMatchObject({ block: true, window: "five_hour", resetAt: FUTURE_RESET_MS });
	});

	it("still accepts numeric reset times in seconds or milliseconds", async () => {
		const { service } = harness([
			{
				body: {
					five_hour: { utilization: 100, resets_at: 1_700_000_100 },
					seven_day: { utilization: 1, resets_at: 1_700_000_200_000 },
				},
			},
		]);
		const snapshot = await service.get(ctx, "anthropic");
		expect(snapshot.windows.map((w) => w.resetAt)).toEqual([1_700_000_100_000, 1_700_000_200_000]);
	});

	it("clamps over-limit utilization to 100 so it blocks, and drops negative values", async () => {
		const { service } = harness([{ body: { five_hour: { utilization: 101 }, seven_day: { utilization: -1 } } }]);
		const snapshot = await service.get(ctx, "anthropic");
		expect(snapshot.windows).toEqual([expect.objectContaining({ name: "five_hour", usedPercent: 100 })]);
		expect(service.decisionFor(SONNET).block).toBe(true);
	});

	it("keeps blocking on stale data while a known reset is still ahead", async () => {
		const { service, clock } = harness([
			{ body: { five_hour: { utilization: 100, resets_at: FUTURE_RESET } } },
			{ body: "denied", status: 429 },
		]);
		await service.get(ctx, "anthropic");
		clock.now += 6 * MINUTE;
		const snapshot = await service.get(ctx, "anthropic");
		expect(snapshot.status).toBe("stale");
		const decision = service.decisionFor(SONNET);
		expect(decision.block).toBe(true);
	});

	it("fails open on stale data whose reset is past or unknown", async () => {
		// A past reset never blocks, fresh or stale; an unknown one blocks only while fresh.
		for (const [five_hour, blocksFresh] of [
			[{ utilization: 100, resets_at: PAST_RESET }, false],
			[{ utilization: 100 }, true],
		] as const) {
			const { service } = harness([{ body: { five_hour } }, { body: "denied", status: 429 }]);
			await service.get(ctx, "anthropic");
			expect(service.decisionFor(SONNET).block).toBe(blocksFresh);
			const refreshed = await service.get(ctx, "anthropic", { force: true });
			expect(refreshed.status).toBe("stale");
			expect(service.decisionFor(SONNET).block).toBe(false);
		}
	});

	it("backs off after a failure across plain, fresh and force reads, then resumes", async () => {
		const { service, clock, requests } = harness([
			{ body: "denied", status: 500 },
			{ body: "denied", status: 500 },
			{ body: { five_hour: { utilization: 10 } } },
		]);
		expect((await service.get(ctx, "anthropic")).status).toBe("error");
		expect(requests).toHaveLength(1);

		await service.get(ctx, "anthropic");
		await service.get(ctx, "anthropic", { fresh: true });
		const forced = await service.get(ctx, "anthropic", { force: true });
		expect(forced.message).toMatch(/Backing off after a failed usage request/);
		expect(requests).toHaveLength(1);

		clock.now += MINUTE + 1; // first backoff step is 1m
		await service.get(ctx, "anthropic", { fresh: true });
		expect(requests).toHaveLength(2);

		clock.now += MINUTE + 1; // second failure -> 2m step
		await service.get(ctx, "anthropic", { fresh: true });
		expect(requests).toHaveLength(2);
		clock.now += MINUTE;
		const recovered = await service.get(ctx, "anthropic", { fresh: true });
		expect(requests).toHaveLength(3);
		expect(recovered.status).toBe("available");
	});

	it("returns the cached snapshot as stale during backoff", async () => {
		const { service, clock, requests } = harness([
			{ body: { five_hour: { utilization: 10 } } },
			{ body: "denied", status: 503 },
		]);
		await service.get(ctx, "anthropic");
		clock.now += 5 * MINUTE;
		await service.get(ctx, "anthropic");
		clock.now += 10_000;
		const result = await service.get(ctx, "anthropic");
		expect(requests).toHaveLength(2);
		expect(result.status).toBe("stale");
		expect(result.windows[0]?.usedPercent).toBe(10);
	});

	it("honors Retry-After (seconds and HTTP-date) beyond the backoff step, capped at an hour", async () => {
		const seconds = harness([
			{ body: "slow down", status: 429, headers: { "Retry-After": "300" } },
			{ body: { five_hour: { utilization: 1 } } },
		]);
		await seconds.service.get(ctx, "anthropic");
		seconds.clock.now += 5 * MINUTE - 1;
		await seconds.service.get(ctx, "anthropic");
		expect(seconds.requests).toHaveLength(1);
		seconds.clock.now += 2;
		await seconds.service.get(ctx, "anthropic");
		expect(seconds.requests).toHaveLength(2);

		const date = harness([
			{ body: "slow down", status: 429, headers: { "Retry-After": new Date(T0 + 10 * 60 * MINUTE).toUTCString() } },
		]);
		await date.service.get(ctx, "anthropic");
		date.clock.now += 60 * MINUTE - 1;
		await date.service.get(ctx, "anthropic");
		expect(date.requests).toHaveLength(1);
		date.clock.now += 2;
		await date.service.get(ctx, "anthropic");
		expect(date.requests).toHaveLength(2);
	});

	it("serves fresh reads from a snapshot retrieved within the last minute", async () => {
		const { service, clock, requests } = harness([{ body: { five_hour: { utilization: 10 } } }]);
		await service.get(ctx, "anthropic");
		clock.now += MINUTE - 1;
		const reused = await Promise.all([1, 2, 3].map(() => service.get(ctx, "anthropic", { fresh: true })));
		expect(reused.every((r) => r.status === "available")).toBe(true);
		expect(requests).toHaveLength(1);
		clock.now += 2;
		await service.get(ctx, "anthropic", { fresh: true });
		expect(requests).toHaveLength(2);
	});

	it("never lets a read from before notBefore confirm, yet shares one read per failure", async () => {
		// Warm at 99%, exhausted 30s later: the confirming read must not be the warm one.
		const { service, clock, requests } = harness([
			{ body: { five_hour: { utilization: 99 } } },
			{ body: { five_hour: { utilization: 100, resets_at: "2023-11-14T23:00:00Z" } } },
		]);
		await service.get(ctx, "anthropic");
		clock.now += 30_000;
		const failedAt = clock.now;
		const confirms = await Promise.all(
			[1, 2, 3].map(() => service.get(ctx, "anthropic", { fresh: true, notBefore: failedAt })),
		);
		expect(requests).toHaveLength(2);
		expect(confirms.every((snapshot) => snapshot.retrievedAt >= failedAt)).toBe(true);
		expect(service.decisionFor({ provider: "anthropic", id: "claude-sonnet-5-5" }).block).toBe(true);
	});

	it("does not join an in-flight read that started before notBefore", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const clock = { now: T0 };
		let calls = 0;
		const service = new UsageService({
			fetch: async () => {
				calls += 1;
				if (calls === 1) await gate;
				return new Response(JSON.stringify({ five_hour: { utilization: calls === 1 ? 99 : 100 } }));
			},
			now: () => clock.now,
			getAccessToken: async () => "token",
		});
		const early = service.get(ctx, "anthropic", { fresh: true });
		clock.now += 1_000;
		const confirm = service.get(ctx, "anthropic", { fresh: true, notBefore: clock.now });
		const confirmed = await confirm;
		release();
		await early;
		expect(calls).toBe(2);
		expect(confirmed.retrievedAt).toBe(T0 + 1_000);
	});

	it("serves plain reads from cache for five minutes", async () => {
		const { service, clock, requests } = harness([{ body: { five_hour: { utilization: 10 } } }]);
		await service.get(ctx, "anthropic");
		clock.now = T0 + 4 * MINUTE + 59_000;
		await service.get(ctx, "anthropic");
		expect(requests).toHaveLength(1);
		clock.now = T0 + 5 * MINUTE + 1_000;
		await service.get(ctx, "anthropic");
		expect(requests).toHaveLength(2);
	});

	it("applies model-scoped windows only to their family token", async () => {
		const { service } = harness([{ body: { five_hour: { utilization: 1 }, seven_day_opus: { utilization: 100 } } }]);
		await service.get(ctx, "anthropic");
		const blocked = (id: string) => service.decisionFor({ provider: "anthropic", id }).block;
		for (const id of [
			"claude-opus-4-1-20250805",
			"claude-3-opus-20240229",
			"anthropic/claude-opus-4-1",
			"us.anthropic.claude-opus-4-1-v1:0",
			"CLAUDE-OPUS-4",
		]) {
			expect(blocked(id), id).toBe(true);
		}
		expect(blocked("claude-sonnet-4")).toBe(false);
		expect(blocked("claude-sonnet-5")).toBe(false);
	});

	it("matches families as whole tokens", () => {
		expect(modelMatchesFamily("claude-sonnet-5", "sonnet")).toBe(true);
		expect(modelMatchesFamily("claude-sonnet-4", "opus")).toBe(false);
		expect(modelMatchesFamily("claude-magnopus-1", "opus")).toBe(false);
		expect(modelMatchesFamily("opus", "opus")).toBe(true);
	});

	it("reports API-key auth as unavailable without a network read", async () => {
		const { service, requests } = harness([{ body: {} }], "sk-ant-api03-PLAINKEY");
		const snapshot = await service.get(ctx, "anthropic");
		expect(snapshot).toMatchObject({
			status: "unavailable",
			message: "API-key auth has no subscription usage window.",
		});
		expect(requests).toHaveLength(0);
	});

	it("labels a weekly-only Codex primary window by its reported duration", async () => {
		const { service } = harness([
			{ body: { rate_limit: { primary_window: { used_percent: 38, limit_window_seconds: 604_800 } } } },
		]);
		const snapshot = await service.get(ctx, "openai-codex");
		expect(snapshot.windows).toEqual([
			{ name: "7d", usedPercent: 38, resetAt: undefined, durationMs: 604_800_000, scope: "provider" },
		]);
	});

	it("uses Codex window durations rather than primary and secondary positions", async () => {
		const { service } = harness([
			{
				body: {
					rate_limit: {
						primary_window: { used_percent: 38, limit_window_seconds: 604_800 },
						secondary_window: { used_percent: 10, limit_window_seconds: 18_000 },
					},
				},
			},
		]);
		expect((await service.get(ctx, "openai-codex")).windows.map((window) => window.name)).toEqual(["7d", "5h"]);
	});

	it("keeps unknown Codex durations explicit instead of mislabeling them", async () => {
		const { service } = harness([
			{ body: { rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 3600 } } } },
		]);
		expect((await service.get(ctx, "openai-codex")).windows[0]?.name).toBe("3600s");
		expect(service.decisionFor({ provider: "openai-codex", id: "gpt-5" }).block).toBe(true);
	});

	it("sends the Codex account id from the access token, and omits it when not decodable", async () => {
		const body = { rate_limit: { primary_window: { used_percent: 1 } } };
		const withId = harness([{ body }], jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" } }));
		await withId.service.get(ctx, "openai-codex");
		expect(withId.requests[0]?.headers["ChatGPT-Account-Id"]).toBe("acct-123");

		const opaque = harness([{ body }], "opaque-token");
		await opaque.service.get(ctx, "openai-codex");
		expect(opaque.requests[0]?.headers).not.toHaveProperty("ChatGPT-Account-Id");
	});

	it("does not treat a paid Codex credit balance as included capacity", async () => {
		const { service } = harness([
			{
				body: {
					rate_limit: { primary_window: { used_percent: 100, reset_at: 1_700_000_100 } },
					credits: { has_credits: true, unlimited: false, balance: "12.00" },
				},
			},
		]);
		await service.get(ctx, "openai-codex");
		const decision = service.decisionFor({ provider: "openai-codex", id: "gpt-5.6-sol" });
		expect(decision.block).toBe(true);
	});

	it("never blocks an unlimited Codex plan", async () => {
		const { service } = harness([
			{
				body: {
					rate_limit: { primary_window: { used_percent: 100 } },
					credits: { has_credits: true, unlimited: true },
				},
			},
		]);
		await service.get(ctx, "openai-codex");
		expect(service.decisionFor({ provider: "openai-codex", id: "gpt-5-codex" }).block).toBe(false);
	});

	it.each(["openrouter", "__proto__", "constructor", "toString"])(
		"does not resolve credentials for unknown collector %s",
		async (provider) => {
			const { service, requests, tokens } = harness([{ body: {} }]);
			expect((await service.get(ctx, provider)).status).toBe("unavailable");
			expect(requests).toHaveLength(0);
			expect(tokens).toHaveLength(0);
		},
	);

	it("renders prompt text in stable buckets", async () => {
		const render = async (utilization: number) => {
			const { service } = harness([
				{
					body: {
						five_hour: { utilization, resets_at: FUTURE_RESET },
						seven_day: { utilization: 100, resets_at: "2023-11-15T00:00:59Z" },
					},
				},
			]);
			const snapshot = await service.get(ctx, "anthropic");
			return service.formatForPrompt(snapshot);
		};
		expect(await render(31)).toBe(await render(44));
		expect(await render(31)).toBe("five_hour 25-50%; seven_day exhausted until 2023-11-15T00:00Z");
		expect(await render(10)).toMatch(/^five_hour <25%/);
		expect(await render(60)).toMatch(/^five_hour 50-75%/);
		expect(await render(99)).toMatch(/^five_hour 75-100%/);

		const { service } = harness([{ body: { five_hour: { utilization: 100 } } }]);
		const snapshot = await service.get(ctx, "anthropic");
		expect(service.formatForPrompt(snapshot)).toBe("five_hour exhausted, reset unknown");
		// Stale keeps last-known buckets so the prompt prefix survives a cache expiry.
		expect(service.formatForPrompt({ ...snapshot, status: "stale", message: "volatile detail" })).toBe(
			"five_hour exhausted, reset unknown",
		);
		expect(service.formatForPrompt({ ...snapshot, status: "stale", windows: [] })).toBe("usage stale");
		expect(service.formatForPrompt(undefined)).toBe("usage unavailable");
	});

	it("throttles manual refresh independently per provider", async () => {
		const fetch = vi.fn(
			async (url: string) =>
				new Response(
					JSON.stringify(
						url.includes("anthropic")
							? { five_hour: { utilization: 10 } }
							: { rate_limit: { primary_window: { used_percent: 20 } } },
					),
					{ status: 200 },
				),
		);
		const service = new UsageService({ fetch, now: () => T0, getAccessToken: async () => "token" });

		expect((await service.get(ctx, "anthropic", { force: true })).status).toBe("available");
		expect((await service.get(ctx, "openai-codex", { force: true })).status).toBe("available");
		expect((await service.get(ctx, "anthropic", { force: true })).message).toBe(
			"Manual refresh is limited to once per minute.",
		);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("converts credential lookup failures into a safe error snapshot", async () => {
		const service = new UsageService({
			fetch: vi.fn(),
			now: () => T0,
			getAccessToken: async () => {
				throw new Error("secret auth backend detail");
			},
		});
		const snapshot = await service.get(ctx, "anthropic");
		expect(snapshot.status).toBe("error");
		expect(snapshot.message).toBe("OAuth credential lookup failed.");
	});

	it("bounds a stalled credential owner without implementing OAuth refresh itself", async () => {
		vi.useFakeTimers();
		try {
			const lookup = vi.fn(() => new Promise<string>(() => {}));
			const fetch = vi.fn();
			const service = new UsageService({ fetch, now: () => T0, getAccessToken: lookup });
			let result: Awaited<ReturnType<UsageService["get"]>> | undefined;
			const pending = service.get(ctx, "anthropic").then((snapshot) => {
				result = snapshot;
			});
			await vi.advanceTimersByTimeAsync(10_000);
			expect(result).toMatchObject({ status: "error", message: "OAuth credential lookup timed out." });
			await pending;
			expect(fetch).not.toHaveBeenCalled();
			await service.get(ctx, "anthropic");
			expect(lookup).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports caller cancellation separately from a request timeout", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetch = vi.fn();
		const service = new UsageService({ fetch, now: () => T0, getAccessToken: async () => "token" });
		const snapshot = await service.get(ctx, "anthropic", { signal: controller.signal });
		expect(snapshot).toMatchObject({ status: "error", message: "Usage request was cancelled." });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("deduplicates concurrent fresh reads per provider", async () => {
		let resolveFetch!: (response: Response) => void;
		const fetch = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					resolveFetch = resolve;
				}),
		);
		const service = new UsageService({ fetch, now: () => T0, getAccessToken: async () => "token" });

		const first = service.get(ctx, "anthropic", { fresh: true });
		const second = service.get(ctx, "anthropic", { fresh: true });
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		resolveFetch(new Response(JSON.stringify({ five_hour: { utilization: 20 } }), { status: 200 }));

		const results = await Promise.all([first, second]);
		expect(results.map((result) => result.status)).toEqual(["available", "available"]);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("detaches a cancelled caller without aborting a shared refresh", async () => {
		let resolveFetch!: (response: Response) => void;
		let requestSignal: AbortSignal | undefined;
		const fetch = vi.fn((_url: string, init: RequestInit) => {
			requestSignal = init.signal as AbortSignal;
			return new Promise<Response>((resolve) => {
				resolveFetch = resolve;
			});
		});
		const service = new UsageService({ fetch, now: () => T0, getAccessToken: async () => "token" });
		const controller = new AbortController();

		const cancelled = service.get(ctx, "anthropic", { fresh: true, signal: controller.signal });
		const live = service.get(ctx, "anthropic", { fresh: true });
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		controller.abort();

		expect((await cancelled).message).toBe("Usage request was cancelled.");
		expect(requestSignal?.aborted).toBe(false);
		resolveFetch(new Response(JSON.stringify({ five_hour: { utilization: 20 } }), { status: 200 }));
		expect((await live).status).toBe("available");
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("does not block on a known reset that has already passed, even on fresh data", async () => {
		const { service, clock } = harness([
			{ body: { five_hour: { utilization: 100, resets_at: new Date(T0 + 1000).toISOString() } } },
		]);
		await service.get(ctx, "anthropic");
		expect(service.decisionFor(SONNET).block).toBe(true);
		clock.now = T0 + 2 * MINUTE;
		expect(service.decisionFor(SONNET).block).toBe(false);
	});
});

describe("UsageService.decisionFor scope", () => {
	it("reports the exhausted window's scope and families so marks cover the right models", async () => {
		const { service } = harness([
			{ body: { five_hour: { utilization: 1 }, seven_day_sonnet: { utilization: 100, resets_at: FUTURE_RESET } } },
		]);
		await service.get(ctx, "anthropic");
		expect(service.decisionFor(SONNET)).toMatchObject({
			block: true,
			scope: "model",
			families: ["sonnet"],
			resetAt: FUTURE_RESET_MS,
		});
		expect(service.decisionFor({ provider: "anthropic", id: "claude-opus-5-5" }).block).toBe(false);
	});
});
