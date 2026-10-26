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
	it("persists each routing decision as a session entry and lists the last ones in status", async () => {
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
		const registration = vi.mocked(h.pi.registerVirtualModel).mock.calls[0]?.[0];
		const route = await registration?.route({ reason: "user", thinkingLevel: "off" } as never, ctx);
		const chosen = `${route?.model.provider}/${route?.model.id}`;
		expect(h.pi.appendEntry).toHaveBeenCalledWith(
			"router:decision",
			expect.objectContaining({ profile: "default", chosen, reason: "user" }),
		);
		await h.status(ctx);
		const text = notify.mock.calls[1]?.[0];
		expect(text).toContain("last decisions");
		expect(text).toContain(`router/default user -> ${chosen}`);
		expect(text).toContain("anthropic/sonnet: score");
		expect(text).toContain("data 0m old");
		vi.useRealTimers();
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
