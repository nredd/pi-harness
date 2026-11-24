import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { BUILTIN_COLLECTORS, parseAntigravity } from "../src/builtin-collectors.ts";
import { collectedProviders, collectorFor, registerCollector } from "../src/collectors.ts";
import type { ChainEntry, Profile } from "../src/config.ts";
import { ExhaustionTracker } from "../src/exhaustion.ts";
import { refKey } from "../src/model-ref.ts";
import { type RouteEnv, Router } from "../src/router.ts";
import { scoreQuota } from "../src/selection.ts";
import { UsageService, type UsageTransport } from "../src/usage.ts";
import { describe as describeViews } from "../src/view.ts";

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;
const RESET_5H = new Date(T0 + 2 * HOUR).toISOString();
const RESET_WEEK = new Date(T0 + 72 * HOUR).toISOString();
const URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const CREDENTIAL = JSON.stringify({ token: "ya29.synthetic", projectId: "synthetic-project" });
const GEMINI: ChainEntry = { provider: "antigravity", id: "gemini-4-neon" };
const SONNET: ChainEntry = { provider: "anthropic", id: "claude-sonnet-5-5" };

/** A `groups[].buckets[]` entry; `resetTime` is omitted like an untouched bucket unless given. */
function bucket(bucketId: string, window: string, remainingFraction: unknown, resetTime?: string) {
	return { bucketId, window, remainingFraction, ...(resetTime && { resetTime }) };
}

/** The live payload shape: a Gemini group and a Claude/GPT group, 5h and weekly each. */
function summary(gemini5h = 0.99497, geminiWeekly = 0.9966) {
	return {
		description: "Quota summary",
		groups: [
			{
				displayName: "Gemini Models",
				buckets: [
					{ ...bucket("gemini-weekly", "weekly", geminiWeekly, RESET_WEEK), displayName: "Weekly Limit Remaining" },
					bucket("gemini-5h", "5h", gemini5h, RESET_5H),
				],
			},
			{ displayName: "Claude and GPT models", buckets: [bucket("3p-weekly", "weekly", 1), bucket("3p-5h", "5h", 1)] },
		],
	};
}

const antigravity = BUILTIN_COLLECTORS.find((collector) => collector.provider === "antigravity");

describe("parseAntigravity", () => {
	it("maps Gemini and Claude/GPT buckets to model-scoped 5h and 7d windows", () => {
		expect(parseAntigravity(summary())).toEqual({
			windows: [
				{
					name: "7d",
					usedPercent: expect.closeTo(0.34, 6),
					resetAt: Date.parse(RESET_WEEK),
					durationMs: 168 * HOUR,
					spanSource: "reported",
					scope: "model",
					families: ["gemini"],
				},
				{
					name: "5h",
					usedPercent: expect.closeTo(0.503, 6),
					resetAt: Date.parse(RESET_5H),
					durationMs: 5 * HOUR,
					spanSource: "reported",
					scope: "model",
					families: ["gemini"],
				},
				{
					name: "3p-7d",
					usedPercent: 0,
					resetAt: undefined,
					durationMs: 168 * HOUR,
					spanSource: "reported",
					scope: "model",
					families: ["claude", "gpt"],
				},
				{
					name: "3p-5h",
					usedPercent: 0,
					resetAt: undefined,
					durationMs: 5 * HOUR,
					spanSource: "reported",
					scope: "model",
					families: ["claude", "gpt"],
				},
			],
		});
	});

	it("leaves the reset unknown when resetTime is absent, unparseable, offsetless or not a string", () => {
		const reading = parseAntigravity({
			groups: [
				{
					buckets: [
						bucket("gemini-5h", "5h", 0.5),
						bucket("gemini-weekly", "weekly", 0.5, "soon"),
						bucket("3p-5h", "5h", 0.5, "2026-11-30T21:10:54"),
						{ ...bucket("3p-weekly", "weekly", 0.5), resetTime: T0 },
					],
				},
			],
		});
		expect(reading?.windows.map(({ name, usedPercent, resetAt }) => ({ name, usedPercent, resetAt }))).toEqual([
			{ name: "5h", usedPercent: 50, resetAt: undefined },
			{ name: "7d", usedPercent: 50, resetAt: undefined },
			{ name: "3p-5h", usedPercent: 50, resetAt: undefined },
			{ name: "3p-7d", usedPercent: 50, resetAt: undefined },
		]);
		const invalid = parseAntigravity({
			groups: [
				{
					buckets: [
						bucket("gemini-feb", "5h", 0.5, "2026-02-30T21:10:54Z"),
						bucket("gemini-space", "weekly", 0.5, "2026-11-30 21:10:54Z"),
						bucket("3p-hour", "5h", 0.5, "2026-11-30T24:00:00+00:00"),
					],
				},
			],
		});
		expect(invalid?.windows.map(({ name, resetAt }) => [name, resetAt])).toEqual([
			["5h", undefined],
			["7d", undefined],
			["3p-5h", undefined],
		]);
		const offsets = parseAntigravity({
			groups: [
				{
					buckets: [
						bucket("gemini-5h", "5h", 0, "2026-11-30T13:10:54.250-08:00"),
						bucket("gemini-weekly", "weekly", 0, "2026-12-01t02:40:54+05:30"),
					],
				},
			],
		});
		expect(offsets?.windows.map(({ resetAt }) => resetAt)).toEqual([
			Date.parse("2026-11-30T21:10:54.250Z"),
			Date.parse("2026-11-30T21:10:54Z"),
		]);
	});

	it("clamps out-of-range fractions and skips non-finite ones", () => {
		const reading = parseAntigravity({
			groups: [
				{
					buckets: [
						bucket("gemini-5h", "5h", -0.25),
						bucket("gemini-weekly", "weekly", 1.5),
						bucket("3p-5h", "5h", Number.NaN),
						bucket("3p-weekly", "weekly", "0.5"),
					],
				},
			],
		});
		expect(reading?.windows.map(({ name, usedPercent }) => ({ name, usedPercent }))).toEqual([
			{ name: "5h", usedPercent: 100 },
			{ name: "7d", usedPercent: 0 },
		]);
	});

	it("skips unknown bucket prefixes, unknown windows, duplicates and malformed entries", () => {
		const reading = parseAntigravity({
			groups: [
				null,
				{ buckets: "none" },
				{
					buckets: [
						bucket("imagen-5h", "5h", 0),
						bucket("gemini-daily", "daily", 0),
						bucket("gemini-proto", "constructor", 0),
						bucket("gemini-string", "toString", 0),
						{ bucketId: 7, window: "5h", remainingFraction: 0 },
						{ bucketId: "gemini-5h", window: 5, remainingFraction: 0 },
						"gemini-5h",
						bucket("gemini-5h", "5h", 0.25),
						bucket("gemini-5h-again", "5h", 0.75),
					],
				},
			],
		});
		expect(reading?.windows.map(({ name, usedPercent }) => ({ name, usedPercent }))).toEqual([
			{ name: "5h", usedPercent: 75 },
		]);
	});

	it.each([
		["a non-object payload", "maintenance"],
		["null", null],
		["no groups", { description: "x" }],
		["non-array groups", { groups: {} }],
		["only unknown buckets", { groups: [{ buckets: [bucket("imagen-5h", "5h", 0)] }] }],
	])("returns undefined for %s", (_label, payload) => {
		expect(parseAntigravity(payload)).toBeUndefined();
	});
});

describe("antigravity collector", () => {
	it("is a reserved built-in with a Gemini footer display", () => {
		expect(collectorFor("antigravity")).toBe(antigravity);
		expect(collectedProviders()).toContain("antigravity");
		expect(antigravity?.display).toEqual({
			full: "Gemini",
			compact: "Gem",
			footer: { show: [{ name: "5h" }, { name: "7d" }], placeholder: true },
		});
		expect(describeViews(["antigravity"], [], [])[0]?.display).toEqual(antigravity?.display);
		expect(() => registerCollector({ provider: "antigravity", kind: "custom", read: async () => undefined })).toThrow(
			'Cannot register collector "antigravity": ID is reserved for a built-in.',
		);
	});

	it("posts an empty body with the access token from the Pi credential", () => {
		if (antigravity?.kind !== "http") throw new Error("antigravity must be an http collector");
		expect(antigravity.request(CREDENTIAL)).toEqual({
			url: URL,
			method: "POST",
			redirect: "error",
			headers: {
				Authorization: "Bearer ya29.synthetic",
				"Content-Type": "application/json",
				Accept: "application/json",
				"User-Agent":
					"antigravity/cli/1.5.5 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)",
			},
			body: "{}",
		});
		// The router never calls request for a credential acceptsCredential refused.
		expect(antigravity.request("not json").headers.Authorization).toBe("Bearer ");
	});

	it.each([
		["a bare token", "ya29.bare", false],
		["malformed JSON", "{token", false],
		["a JSON string", '"ya29"', false],
		["null", "null", false],
		["a missing token", JSON.stringify({ projectId: "p" }), false],
		["an empty token", JSON.stringify({ token: "" }), false],
		["a non-string token", JSON.stringify({ token: 42 }), false],
		["the pi-antigravity credential", CREDENTIAL, true],
	])("acceptsCredential for %s", (_label, credential, accepted) => {
		expect(antigravity?.acceptsCredential?.(credential)).toBe(accepted);
	});
});

/** Real UsageService over a scripted transport that answers per URL. */
function service(bodies: Record<string, unknown>, credential = CREDENTIAL) {
	const clock = { now: T0 };
	const requests: Array<{ url: string; init: RequestInit }> = [];
	const transport: UsageTransport = {
		fetch: async (url, init) => {
			requests.push({ url, init });
			return Response.json(bodies[url] ?? {});
		},
		now: () => clock.now,
		monotonicNow: () => clock.now - T0,
		getAccessToken: async (_ctx, provider) => (provider === "antigravity" ? credential : "anthropic-token"),
	};
	return { usage: new UsageService(transport), clock, requests };
}

const ctx = {} as never;

describe("antigravity usage", () => {
	it("reads the endpoint and blocks only Gemini models on an exhausted Gemini 5h window", async () => {
		const { usage, requests } = service({ [URL]: summary(0) });
		const snapshot = await usage.get(ctx, "antigravity");
		expect(snapshot.status).toBe("available");
		expect(requests).toEqual([
			{
				url: URL,
				init: expect.objectContaining({ method: "POST", redirect: "error", body: "{}" }),
			},
		]);
		expect(usage.decisionFor(GEMINI)).toMatchObject({
			block: true,
			window: "5h",
			scope: "model",
			families: ["gemini"],
			resetAt: Date.parse(RESET_5H),
		});
		expect(usage.decisionFor({ provider: "antigravity", id: "claude-opus-4-6-thinking" })).toEqual({ block: false });
		expect(usage.decisionFor({ provider: "antigravity", id: "gpt-oss-120b-medium" })).toEqual({ block: false });
		expect(usage.format(snapshot)).toMatch(
			/^7d 0% used, resets .+; 5h 100% used, resets .+; 3p-7d 0% used; 3p-5h 0% used$/,
		);
	});

	it("scores Gemini models by their windows and Claude models by the 3p windows", async () => {
		const payload = summary(0.5, 0.9);
		payload.groups[1] = {
			displayName: "Claude and GPT models",
			buckets: [bucket("3p-weekly", "weekly", 0.2, RESET_WEEK)],
		};
		const { usage } = service({ [URL]: payload });
		const snapshot = await usage.get(ctx, "antigravity");
		expect(scoreQuota(GEMINI, snapshot, T0)).toMatchObject({ kind: "measured", window: "5h" });
		expect(scoreQuota({ provider: "antigravity", id: "claude-sonnet-4-6" }, snapshot, T0)).toMatchObject({
			kind: "measured",
			window: "3p-7d",
		});
	});

	it("disables redirects", async () => {
		const marker = "redirect-marker-synthetic";
		const hits: string[] = [];
		const server = createServer((req, res) => {
			hits.push(req.url ?? "");
			if (req.url === "/quota") {
				res.writeHead(307, { Location: `/target?leak=${marker}` });
				res.end();
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end("{}");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const { port } = server.address() as AddressInfo;
			const loopback = `http://127.0.0.1:${port}`;
			const requests: Array<{ url: string; init: RequestInit }> = [];
			const usage = new UsageService({
				fetch: async (url, init) => {
					requests.push({ url, init });
					if (url === URL) return fetch(`${loopback}/quota`, init);
					return Response.json({ five_hour: { utilization: 10, resets_at: RESET_5H } });
				},
				now: () => T0,
				getAccessToken: async (_ctx, provider) => (provider === "antigravity" ? CREDENTIAL : "anthropic-token"),
			});
			const antigravitySnap = await usage.get(ctx, "antigravity");
			expect(antigravitySnap).toMatchObject({ status: "error", message: "Usage request failed." });
			expect(hits).toEqual(["/quota"]);
			const serialized = JSON.stringify(antigravitySnap);
			expect(serialized).not.toContain("ya29.synthetic");
			expect(serialized).not.toContain(marker);
			const anthropicSnap = await usage.get(ctx, "anthropic");
			expect(anthropicSnap.status).toBe("available");
			expect(requests).toHaveLength(2);
			expect(requests[0]?.init.redirect).toBe("error");
			expect(requests[1]?.init).not.toHaveProperty("redirect");
		} finally {
			await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
		}
	});

	it("reports an unreadable credential as having no usage source without a request", async () => {
		const { usage, requests } = service({}, "ya29.bare");
		const snapshot = await usage.get(ctx, "antigravity");
		expect(snapshot).toMatchObject({
			status: "unavailable",
			message: "This credential has no subscription usage window (e.g. an API key).",
		});
		expect(JSON.stringify(snapshot)).not.toContain("ya29");
		expect(requests).toEqual([]);
	});
});

function model(entry: ChainEntry): Model<Api> {
	return { provider: entry.provider, id: entry.id, api: "test" } as unknown as Model<Api>;
}

function request(): ModelRouteRequest {
	return {
		model: { provider: "router", id: "balanced", api: "pi-virtual" } as unknown as Model<Api>,
		thinkingLevel: "medium",
		reason: "user",
		messages: [],
	};
}

describe("antigravity balanced routing", () => {
	const profile: Profile = { id: "balanced", name: "Balanced", strategy: "balanced", chain: [GEMINI, SONNET] };
	const anthropic = (utilization: number) => ({
		five_hour: { utilization, resets_at: RESET_5H },
		seven_day: { utilization, resets_at: RESET_WEEK },
	});

	async function route(gemini5h: number, sonnetUsed: number) {
		const { usage, clock } = service({
			[URL]: summary(gemini5h, 0.9),
			"https://api.anthropic.com/api/oauth/usage": anthropic(sonnetUsed),
		});
		await Promise.all([usage.get(ctx, "antigravity"), usage.get(ctx, "anthropic")]);
		const router = new Router(usage, new ExhaustionTracker(() => clock.now), () => clock.now);
		const env: RouteEnv = { resolve: model, refresh: async () => undefined };
		return (await router.route(profile, request(), env)).model;
	}

	it("prefers Gemini while its windows have more headroom", async () => {
		expect(await route(0.95, 80)).toMatchObject({ provider: "antigravity", id: GEMINI.id });
	});

	it("picks the later chain entry when both are eligible and it has more headroom", async () => {
		expect(await route(0.1, 10)).toMatchObject({ provider: "anthropic", id: SONNET.id });
	});

	it("steers to another provider once the Gemini 5h window is exhausted", async () => {
		expect(await route(0, 80)).toMatchObject({ provider: "anthropic", id: SONNET.id });
	});

	it("admission parks only Gemini dispatches on a cached exhausted Gemini 5h window", async () => {
		const { usage, clock } = service({ [URL]: summary(0, 0.9) });
		await usage.get(ctx, "antigravity");
		const router = new Router(usage, new ExhaustionTracker(() => clock.now), () => clock.now);
		const env: RouteEnv = { resolve: model, refresh: async () => undefined };
		const profiles = new Map([[profile.id, profile]]);
		expect(router.admit("antigravity/gemini-4-neon", profiles, env)).toEqual({
			ok: false,
			resetAt: Date.parse(RESET_5H),
			wait: true,
		});
		expect(router.admit("antigravity/claude-sonnet-4-6", profiles, env)).toEqual({
			ok: true,
			resolvedModel: "antigravity/claude-sonnet-4-6",
		});
		expect(router.admit("router/balanced", profiles, env)).toEqual({ ok: true, resolvedModel: refKey(SONNET) });
	});

	it.each(["cached", "confirmed", "stale"] as const)(
		"does not extend or revive a %s reset after rollback",
		async (source) => {
			let wall = T0;
			let elapsed = 0;
			let fail = false;
			const transport = {
				fetch: async () => (fail ? new Response(null, { status: 503 }) : Response.json(summary(0, 0.9))),
				now: () => wall,
				monotonicNow: () => elapsed,
				getAccessToken: async () => CREDENTIAL,
			};
			const usage = new UsageService(transport);
			const tracker = new ExhaustionTracker(() => wall);
			const router = new Router(usage, tracker, () => wall);
			const env: RouteEnv = {
				resolve: model,
				refresh: async (target) => usage.decisionFor(target, await usage.get(ctx, target.provider, { fresh: true })),
			};
			const admit = () => router.admit(refKey(GEMINI), new Map(), env);
			await usage.get(ctx, GEMINI.provider);
			if (source === "confirmed") {
				expect(await router.confirm(model(GEMINI), env, undefined, T0)).toBe(true);
				usage.invalidate(GEMINI.provider);
			}
			if (source === "stale") {
				fail = true;
				expect((await usage.get(ctx, GEMINI.provider, { force: true })).status).toBe("stale");
			}
			expect(admit()).toEqual({ ok: false, resetAt: T0 + 2 * HOUR, wait: true });
			wall = T0 - HOUR;
			elapsed = HOUR / 2;
			expect(admit()).toEqual({ ok: false, resetAt: T0 + HOUR / 2, wait: true });
			elapsed = 2 * HOUR;
			expect(admit()).toEqual({ ok: true, resolvedModel: refKey(GEMINI) });
		},
	);

	it("shortens admission on a forward step without restoring the wait on rollback", async () => {
		let wall = T0;
		let elapsed = 0;
		const transport = {
			fetch: async () => Response.json(summary(0, 0.9)),
			now: () => wall,
			monotonicNow: () => elapsed,
			getAccessToken: async () => CREDENTIAL,
		};
		const usage = new UsageService(transport);
		const tracker = new ExhaustionTracker(() => wall);
		const router = new Router(usage, tracker, () => wall);
		const env: RouteEnv = {
			resolve: model,
			refresh: async (target) => usage.decisionFor(target, await usage.get(ctx, target.provider, { fresh: true })),
		};
		const admit = () => router.admit(refKey(GEMINI), new Map(), env);
		expect(await router.confirm(model(GEMINI), env, undefined, T0)).toBe(true);
		wall = T0 + HOUR;
		expect(admit()).toEqual({ ok: false, resetAt: T0 + 2 * HOUR, wait: true });
		wall = T0;
		expect(admit()).toEqual({ ok: false, resetAt: T0 + HOUR, wait: true });
		elapsed = HOUR;
		expect(admit()).toEqual({ ok: true, resolvedModel: refKey(GEMINI) });
	});

	it("bounds implausible resets", async () => {
		const skew = 5 * 60_000;
		const edge5h = T0 + 5 * HOUR + skew;
		const edgeWeek = T0 + 168 * HOUR + skew;
		let fail = false;
		let body: unknown = {
			groups: [
				{
					buckets: [
						bucket("gemini-5h", "5h", 0, new Date(edge5h).toISOString()),
						bucket("gemini-weekly", "weekly", 0.5, new Date(edgeWeek).toISOString()),
						bucket("3p-5h", "5h", 0, new Date(edge5h + 1).toISOString()),
						bucket("3p-weekly", "weekly", 0, new Date(edgeWeek + 1).toISOString()),
					],
				},
			],
		};
		const clock = { now: T0 };
		const usage = new UsageService({
			fetch: async () => (fail ? new Response("unavailable", { status: 503 }) : Response.json(body)),
			now: () => clock.now,
			getAccessToken: async () => CREDENTIAL,
		});
		const bounded = await usage.get(ctx, "antigravity");
		expect(bounded.windows.map(({ name, resetAt }) => [name, resetAt])).toEqual([
			["5h", edge5h],
			["7d", edgeWeek],
			["3p-5h", undefined],
			["3p-7d", undefined],
		]);

		// Now test an exhausted Gemini 5h window with a 2099 reset: fresh admission refuses without wait:true,
		// confirmation falls back to bounded backoff instead of copying 2099, and a failed refresh lifts the block.
		usage.invalidate("antigravity");
		body = {
			groups: [{ buckets: [bucket("gemini-5h", "5h", 0, "2099-01-01T00:00:00Z")] }],
		};
		const fresh = await usage.get(ctx, "antigravity");
		expect(fresh).toMatchObject({
			status: "available",
			windows: [{ name: "5h", usedPercent: 100, resetAt: undefined }],
		});
		const tracker = new ExhaustionTracker(() => clock.now);
		const router = new Router(usage, tracker, () => clock.now);
		const env: RouteEnv = {
			resolve: model,
			refresh: async (target) => usage.decisionFor(target, await usage.get(ctx, target.provider, { fresh: true })),
		};
		const geminiOnly: Profile = { id: "gemini-only", name: "Gemini", strategy: "balanced", chain: [GEMINI] };
		const profiles = new Map([[geminiOnly.id, geminiOnly]]);
		expect(router.admit("antigravity/gemini-4-neon", profiles, env)).toEqual({
			ok: false,
			resetAt: undefined,
			wait: false,
		});
		expect(router.admit("router/gemini-only", profiles, env)).toEqual({
			ok: false,
			resetAt: undefined,
			wait: false,
		});
		expect(await router.confirm(model(GEMINI), env, undefined, T0)).toBe(true);
		expect(tracker.blocking(GEMINI)).toMatchObject({ resetKnown: false, until: T0 + 5 * 60_000 });
		tracker.clear();

		// After the cache TTL expires and a refresh fails, the stale reading has no future reset and fails open.
		fail = true;
		clock.now = T0 + 5 * 60_000 + 1;
		const stale = await usage.get(ctx, "antigravity");
		expect(stale).toMatchObject({
			status: "stale",
			windows: [{ name: "5h", usedPercent: 100, resetAt: undefined }],
		});
		expect(usage.decisionFor(GEMINI)).toEqual({ block: false });
		expect(router.admit("antigravity/gemini-4-neon", profiles, env)).toEqual({
			ok: true,
			resolvedModel: "antigravity/gemini-4-neon",
		});
		expect(router.admit("router/gemini-only", profiles, env)).toEqual({
			ok: true,
			resolvedModel: "antigravity/gemini-4-neon",
		});
	});
});
