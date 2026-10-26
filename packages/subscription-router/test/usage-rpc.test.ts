import { EventEmitter } from "node:events";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type Profile } from "../src/config.js";
import { ExhaustionTracker } from "../src/exhaustion.js";
import subscriptionRouter from "../src/index.js";
import { UsageService, type UsageSnapshot } from "../src/usage.js";

vi.mock("../src/config.js", async (original) => ({
	...(await original<typeof import("../src/config.js")>()),
	loadConfig: vi.fn(async () => ({ ok: true, profiles: [] })),
}));

const SHARED_KEY = Symbol.for("pi-subscription-router.shared");
const host = globalThis as typeof globalThis & { [SHARED_KEY]?: unknown };
const MINUTE = 60_000;

/** Exercise the registered event-bus RPC with the real cache and injected transport. */
async function harness(startSession = true, profiles: Profile[] = []) {
	vi.mocked(loadConfig).mockResolvedValue({ ok: true, profiles });
	let now = 1_700_000_000_000;
	let fail = false;
	const fetch = vi.fn(async (url: string) => {
		const body = url.includes("anthropic")
			? { five_hour: { utilization: 24 }, seven_day: { utilization: 42 } }
			: { rate_limit: { primary_window: { used_percent: 18 }, secondary_window: { used_percent: 37 } } };
		return new Response(JSON.stringify(body), { status: fail ? 429 : 200 });
	});
	const usage = new UsageService({ fetch, now: () => now, getAccessToken: async () => "fake-token" });
	host[SHARED_KEY] = { usage, tracker: new ExhaustionTracker() };
	const events = new EventEmitter();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const pi = {
		events,
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(event, handler),
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		registerVirtualModel: vi.fn(),
		appendEntry: vi.fn(),
	} as unknown as ExtensionAPI;
	await subscriptionRouter(pi);
	if (startSession) {
		// No relevant models: session warm-up must not hide RPC-triggered reads.
		handlers.get("session_start")?.({}, { scopedModels: [], ui: { notify: vi.fn() } } as unknown as ExtensionContext);
	}
	let nextId = 0;
	const rpc = (params: Record<string, unknown> = {}) =>
		new Promise<{ success: boolean; data: { snapshots: UsageSnapshot[]; blocks: unknown[] } }>((resolve) => {
			const requestId = String(++nextId);
			events.once(`router:rpc:usage:reply:${requestId}`, resolve);
			events.emit("router:rpc:usage", { ...params, requestId });
		});
	const status = async (ctx: ExtensionCommandContext, action = "status") => {
		const registration = vi.mocked(pi.registerCommand).mock.calls.find(([name]) => name === "router");
		if (!registration) throw new Error("router command not registered");
		await registration[1].handler(action, ctx);
	};
	return { pi, rpc, fetch, usage, status, advance: (ms: number) => (now += ms), fail: () => (fail = true) };
}

afterEach(() => {
	vi.useRealTimers();
	delete host[SHARED_KEY];
});

describe("router usage RPC", () => {
	it("records the historical decision in full, and status renders it apart from the forecast", async () => {
		vi.useFakeTimers({ now: 1_700_000_000_000 });
		const profile: Profile = {
			id: "default",
			name: "Default",
			strategy: "balanced",
			chain: [
				{ provider: "anthropic", id: "sonnet" },
				{ provider: "openai-codex", id: "terra" },
			],
		};
		const h = await harness(false, [profile]);
		const notify = vi.fn();
		const ctx = {
			scopedModels: [],
			ui: { notify },
			modelRegistry: { find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true },
		} as unknown as ExtensionCommandContext;
		await h.status(ctx);
		expect(notify.mock.calls[0]?.[0]).not.toContain("last decisions");
		await h.usage.get(ctx, "anthropic");
		await h.usage.get(ctx, "openai-codex");
		// Both snapshots are 6 minutes old (past the 5 minute TTL) when the route happens.
		h.advance(6 * MINUTE);
		vi.setSystemTime(Date.now() + 6 * MINUTE);
		const registration = vi.mocked(h.pi.registerVirtualModel).mock.calls[0]?.[0];
		const route = await registration?.route({ reason: "user", thinkingLevel: "off" } as never, ctx);
		expect(route?.model).toMatchObject({ provider: "openai-codex", id: "terra" });
		expect(h.pi.appendEntry).toHaveBeenCalledTimes(1);
		const [type, entry] = vi.mocked(h.pi.appendEntry).mock.calls[0] ?? [];
		expect(type).toBe("router:decision");
		expect(entry).toMatchObject({
			at: 1_700_000_000_000 + 6 * MINUTE,
			profile: "default",
			strategy: "balanced",
			reason: "user",
			chosen: "openai-codex/terra",
			candidates: [
				{
					model: "anthropic/sonnet",
					ageMs: 6 * MINUTE,
					quota: { kind: "measured", score: expect.closeTo(0.58), window: "seven_day", stale: 6 * MINUTE },
				},
				{
					model: "openai-codex/terra",
					ageMs: 6 * MINUTE,
					quota: { kind: "measured", score: expect.closeTo(0.63), window: "7d", stale: 6 * MINUTE },
				},
			],
			blocked: [],
		});

		// Move well past the grace window: the forecast now says fallback, history must not change.
		h.advance(30 * MINUTE);
		vi.setSystemTime(Date.now() + 30 * MINUTE);
		await h.status(ctx);
		const text: string = notify.mock.calls[1]?.[0];
		const [forecast, history] = text.split("last decisions (newest last):");
		expect(forecast).toContain("anthropic/sonnet: fallback: usage stale");
		expect(forecast).not.toContain("score 0.");
		expect(history).toContain("router/default user -> openai-codex/terra (balanced)");
		expect(history).toContain("anthropic/sonnet: score 0.580, limiting seven_day, stale 6m, data 6m old");
		expect(history).toContain("openai-codex/terra: score 0.630, limiting 7d, stale 6m, data 6m old");
		expect(history).not.toContain("fallback");
	});

	/** Two-provider balanced profile with both usage snapshots cached, plus a `route()` and `status()` driver. */
	async function routed() {
		vi.useFakeTimers({ now: 1_700_000_000_000 });
		const profile: Profile = {
			id: "default",
			name: "Default",
			strategy: "balanced",
			chain: [
				{ provider: "anthropic", id: "sonnet" },
				{ provider: "openai-codex", id: "terra" },
			],
		};
		const h = await harness(false, [profile]);
		const notify = vi.fn();
		const ctx = {
			scopedModels: [],
			ui: { notify },
			modelRegistry: { find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true },
		} as unknown as ExtensionCommandContext;
		await h.usage.get(ctx, "anthropic");
		await h.usage.get(ctx, "openai-codex");
		const registration = vi.mocked(h.pi.registerVirtualModel).mock.calls[0]?.[0];
		const tick = (ms: number) => {
			h.advance(ms);
			vi.setSystemTime(Date.now() + ms);
		};
		const route = async () => {
			const result = await registration?.route({ reason: "user", thinkingLevel: "off" } as never, ctx);
			return `${result?.model.provider}/${result?.model.id}`;
		};
		return { h, ctx, notify, tick, route };
	}

	it("status keeps only the last five decisions", async () => {
		const { h, ctx, notify, tick, route } = await routed();
		for (let i = 0; i < 7; i++) {
			tick(MINUTE);
			await route();
		}
		await h.status(ctx);
		const history: string = notify.mock.calls[0]?.[0].split("last decisions (newest last):")[1];
		const headers = history.split("\n").filter((line) => line.includes("router/default user ->"));
		expect(headers).toHaveLength(5);
		// Routes 3..7 happened at T0 + 3..7 minutes; routes 1 and 2 were evicted.
		expect(headers[0]).toContain("2023-11-14T22:16:20Z");
		expect(history).not.toContain("2023-11-14T22:14:20Z");
		expect(history).not.toContain("2023-11-14T22:15:20Z");
	});

	it("persists a profile's first decision and each change of chosen model, not every route", async () => {
		const { h, ctx, tick, route } = await routed();
		for (let i = 0; i < 3; i++) {
			tick(MINUTE);
			expect(await route()).toBe("openai-codex/terra");
		}
		expect(h.pi.appendEntry).toHaveBeenCalledTimes(1);
		// Anthropic reports a nearly idle account on a forced refresh, so the pick flips.
		tick(2 * MINUTE);
		h.fetch.mockImplementation(
			async () => new Response(JSON.stringify({ five_hour: { utilization: 1 }, seven_day: { utilization: 1 } })),
		);
		await h.usage.get(ctx, "anthropic", { force: true });
		expect(await route()).toBe("anthropic/sonnet");
		expect(h.pi.appendEntry).toHaveBeenCalledTimes(2);
		expect(await route()).toBe("anthropic/sonnet");
		expect(h.pi.appendEntry).toHaveBeenCalledTimes(2);
		expect(vi.mocked(h.pi.appendEntry).mock.calls.map(([, entry]) => (entry as { chosen: string }).chosen)).toEqual([
			"openai-codex/terra",
			"anthropic/sonnet",
		]);
	});

	it("a throwing appendEntry neither fails the route nor drops the in-memory decision", async () => {
		const { h, ctx, notify, tick, route } = await routed();
		vi.mocked(h.pi.appendEntry).mockImplementation(() => {
			throw new Error("session write failed");
		});
		tick(MINUTE);
		await expect(route()).resolves.toBe("openai-codex/terra");
		expect(h.pi.appendEntry).toHaveBeenCalledTimes(1);
		await h.status(ctx);
		expect(notify.mock.calls[0]?.[0]).toContain("router/default user -> openai-codex/terra");
	});

	it("forecasts status from cached-only shared selection and shows scores/fallbacks", async () => {
		vi.useFakeTimers({ now: 1_700_000_000_000 });
		try {
			const profile: Profile = {
				id: "default",
				name: "Default",
				strategy: "balanced",
				chain: [
					{ provider: "anthropic", id: "sonnet" },
					{ provider: "openai-codex", id: "terra" },
					{ provider: "third", id: "third" },
				],
			};
			const h = await harness(false, [profile]);
			const notify = vi.fn();
			const ctx = {
				scopedModels: [],
				ui: { notify },
				modelRegistry: { find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true },
			} as unknown as ExtensionCommandContext;
			await h.status(ctx);
			expect(h.fetch).not.toHaveBeenCalled();
			expect(notify.mock.calls[0]?.[0]).toContain("fallback: usage missing");
			await h.usage.get(ctx, "anthropic");
			await h.usage.get(ctx, "openai-codex");
			await h.status(ctx);
			expect(h.fetch).toHaveBeenCalledTimes(2);
			const text = notify.mock.calls[1]?.[0];
			expect(text).toContain("router/default (balanced) -> openai-codex/terra");
			expect(text).toContain("score 0.630, limiting 7d");
			expect(text).toContain("third/third: fallback: usage missing");
			expect(h.usage.formatForPrompt(h.usage.peek("openai-codex"))).not.toContain("score");
		} finally {
			vi.useRealTimers();
		}
	});
	it("keeps omitted refresh cached-only, including expired snapshots", async () => {
		const h = await harness();
		expect((await h.rpc()).data).toEqual({ snapshots: [], blocks: [] });
		expect(h.fetch).not.toHaveBeenCalled();
		await h.rpc({ refresh: true });
		h.advance(6 * MINUTE);
		expect((await h.rpc()).data.snapshots.map((s) => s.status)).toEqual(["stale", "stale"]);
		expect(h.fetch).toHaveBeenCalledTimes(2);
	});

	it("refreshes both providers through the normal five-minute cache", async () => {
		const h = await harness();
		const result = await h.rpc({ refresh: true });
		expect(result.success).toBe(true);
		expect(result.data.snapshots.map((s) => s.provider)).toEqual(["anthropic", "openai-codex"]);
		expect(result.data.snapshots.map((s) => s.status)).toEqual(["available", "available"]);
		h.advance(MINUTE);
		await h.rpc({ refresh: true });
		expect(h.fetch).toHaveBeenCalledTimes(2);
		h.advance(4 * MINUTE);
		await h.rpc({ refresh: true });
		expect(h.fetch).toHaveBeenCalledTimes(4);
	});

	it("deduplicates concurrent footer refreshes", async () => {
		const h = await harness();
		const results = await Promise.all([h.rpc({ refresh: true }), h.rpc({ refresh: true })]);
		expect(results[0]).toEqual(results[1]);
		expect(h.fetch).toHaveBeenCalledTimes(2);
	});

	it("retains stale figures and honors failure backoff", async () => {
		const h = await harness();
		const initial = await h.rpc({ refresh: true });
		h.advance(5 * MINUTE);
		h.fail();
		const failed = await h.rpc({ refresh: true });
		expect(failed.data.snapshots.map((s) => s.status)).toEqual(["stale", "stale"]);
		expect(failed.data.snapshots.map((s) => s.windows)).toEqual(initial.data.snapshots.map((s) => s.windows));
		await h.rpc({ refresh: true });
		expect(h.fetch).toHaveBeenCalledTimes(4);
		h.advance(MINUTE);
		await h.rpc({ refresh: true });
		expect(h.fetch).toHaveBeenCalledTimes(6);
	});

	it("does not fetch before session start or for truthy non-boolean refresh", async () => {
		const cold = await harness(false);
		expect((await cold.rpc({ refresh: true })).data.snapshots).toEqual([]);
		expect(cold.fetch).not.toHaveBeenCalled();
		const h = await harness();
		await h.rpc({ refresh: "true" });
		expect(h.fetch).not.toHaveBeenCalled();
	});
});
