import { EventEmitter } from "node:events";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ConfigResult, loadConfig, type Profile } from "../src/config.js";
import { ExhaustionTracker } from "../src/exhaustion.js";
import subscriptionRouter from "../src/index.js";
import { ResetView } from "../src/reset-view.js";
import { UsageService, type UsageSnapshot } from "../src/usage.js";

vi.mock("../src/config.js", async (original) => ({
	...(await original<typeof import("../src/config.js")>()),
	loadConfig: vi.fn(async () => ({ ok: true, profiles: [] })),
}));

const SHARED_KEY = Symbol.for("pi-subscription-router.shared");
const host = globalThis as typeof globalThis & { [SHARED_KEY]?: unknown };
const MINUTE = 60_000;
const T0 = 1_700_000_000_000;
const EXHAUSTED_RESET = T0 + MINUTE;

/** Exercise the registered event-bus RPC with the real cache and injected transport. */
async function harness(startSession = true, profiles: Profile[] = [], config: ConfigResult = { ok: true, profiles }) {
	vi.mocked(loadConfig).mockResolvedValue(config);
	let now = T0;
	let fail = false;
	const fetch = vi.fn(async (url: string) => {
		const body = url.includes("anthropic")
			? { five_hour: { utilization: 24 }, seven_day: { utilization: 42 } }
			: { rate_limit: { primary_window: { used_percent: 18 }, secondary_window: { used_percent: 37 } } };
		return new Response(JSON.stringify(body), { status: fail ? 429 : 200 });
	});
	const usage = new UsageService({ fetch, now: () => now, getAccessToken: async () => "fake-token" });
	const tracker = new ExhaustionTracker();
	host[SHARED_KEY] = { usage, tracker };
	const events = new EventEmitter();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const pi = {
		events,
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(event, handler),
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		registerVirtualModel: vi.fn(),
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
	} as unknown as ExtensionAPI;
	await subscriptionRouter(pi);
	if (startSession) {
		// No relevant models: session warm-up must not hide RPC-triggered reads.
		handlers.get("session_start")?.({}, { scopedModels: [], ui: { notify: vi.fn() } } as unknown as ExtensionContext);
	}
	let nextId = 0;
	const rpc = (params: Record<string, unknown> = {}) =>
		new Promise<{ success: boolean; data: { snapshots: UsageSnapshot[]; blocks: unknown[] }; error?: string }>(
			(resolve) => {
				const requestId = String(++nextId);
				events.once(`router:rpc:usage:reply:${requestId}`, resolve);
				events.emit("router:rpc:usage", { ...params, requestId });
			},
		);
	/** Send an admission request and resolve only the matching `router:rpc:admit` envelope. */
	const admit = (params: Record<string, unknown> = {}) =>
		new Promise<{ success: boolean; data: unknown }>((resolve) => {
			const requestId = String(++nextId);
			events.once(`router:rpc:admit:reply:${requestId}`, resolve);
			events.emit("router:rpc:admit", { ...params, requestId });
		});
	const status = async (ctx: ExtensionCommandContext, action = "status") => {
		const registration = vi.mocked(pi.registerCommand).mock.calls.find(([name]) => name === "router");
		if (!registration) throw new Error("router command not registered");
		await registration[1].handler(action, ctx);
	};
	const tool = async (params: Record<string, unknown>, ctx: ExtensionContext) => {
		const registration = vi.mocked(pi.registerTool).mock.calls.find(([t]) => t.name === "subscription_usage");
		if (!registration) throw new Error("subscription_usage registration missing");
		const result = await registration[0].execute("tool-id", params as never, undefined, () => {}, ctx as never);
		return (result.content[0] as { text: string }).text;
	};
	return {
		pi,
		events,
		tool,
		handlers,
		rpc,
		admit,
		fetch,
		usage,
		tracker,
		status,
		advance: (ms: number) => (now += ms),
		fail: () => (fail = true),
	};
}

afterEach(() => {
	vi.useRealTimers();
	delete host[SHARED_KEY];
});

describe("router usage RPC", () => {
	it("opens reset schedules cached-only, closes/cancels without reads, and bounds explicit refresh", async () => {
		const h = await harness(false);
		const notify = vi.fn();
		const screens: string[] = [];
		const choices = [false, true, false, false, false];
		let cancelRefresh = false;
		const custom = vi.fn(async (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) => {
			let finish: (value: unknown) => void = () => {};
			const result = new Promise((resolve) => {
				finish = resolve;
			});
			const component = await factory(
				{ terminal: { rows: 40 }, requestRender: vi.fn() } as never,
				{ fg: (_color: string, text: string) => text } as never,
				{} as never,
				finish,
			);
			try {
				component.render(120);
				if (component instanceof ResetView) {
					screens.push(component.render(120).join("\n"));
					component.handleInput(choices.shift() ? "r" : "q");
				} else if (cancelRefresh) component.handleInput?.("\u001b");
				return await result;
			} finally {
				if ("dispose" in component) component.dispose?.();
			}
		});
		const ctx = {
			mode: "tui",
			scopedModels: [{ model: { provider: "anthropic" } }],
			ui: { notify, custom },
		} as unknown as ExtensionCommandContext;
		await h.status(ctx, "resets invalid");
		expect(notify).toHaveBeenLastCalledWith("subscription-router: expected resets [refresh]", "error");
		await h.status(ctx, "resets");
		expect(h.fetch).not.toHaveBeenCalled();
		expect(custom).toHaveBeenCalledTimes(1);
		await h.status(ctx, "resets");
		expect(h.fetch).toHaveBeenCalledTimes(1);
		await h.status(ctx, "resets refresh");
		expect(h.fetch).toHaveBeenCalledTimes(1);
		expect(custom).toHaveBeenCalledTimes(6);
		expect(screens.at(-1)).toContain("once per minute");
		expect(screens.at(-1)).toContain("24% used");
		h.advance(MINUTE);
		cancelRefresh = true;
		await h.status(ctx, "resets refresh");
		expect(screens.at(-1)).toContain("cancelled");
		expect(screens.at(-1)).toContain("24% used");
		expect(h.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("coalesces schedule refresh with a shared read without clearing confirmed blocks", async () => {
		const h = await harness(false);
		const ctx = {
			mode: "json",
			scopedModels: [{ model: { provider: "anthropic" } }],
		} as unknown as ExtensionCommandContext;
		let release: () => void = () => {};
		let started: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		h.fetch.mockImplementationOnce(async () => {
			started();
			await held;
			return new Response(JSON.stringify({ five_hour: { utilization: 10 } }));
		});
		h.tracker.mark(
			{ provider: "anthropic", id: "sample" },
			{ block: true, window: "weekly", resetAt: Date.now() + MINUTE },
		);
		const blocks = h.tracker.active();
		const warm = h.usage.get(ctx, "anthropic");
		await ready;
		const command = h.status(ctx, "resets refresh");
		release();
		await Promise.all([warm, command]);
		expect(h.fetch).toHaveBeenCalledTimes(1);
		expect(h.tracker.active()).toEqual(blocks);
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining("10% used") }),
			{ triggerTurn: false },
		);
	});

	it("reports non-TUI schedules without a model turn and keeps windows on caller cancellation", async () => {
		vi.useFakeTimers({ now: T0 });
		const h = await harness(false);
		const controller = new AbortController();
		const ctx = {
			mode: "print",
			scopedModels: [{ model: { provider: "anthropic" } }],
			signal: controller.signal,
			ui: { notify: vi.fn() },
		} as unknown as ExtensionCommandContext;
		await h.usage.get(ctx, "anthropic");
		controller.abort();
		await h.status(ctx, "resets refresh");
		expect(h.fetch).toHaveBeenCalledTimes(1);
		expect(h.pi.sendMessage).toHaveBeenLastCalledWith(
			{ customType: "router:resets", display: true, content: expect.stringContaining("cancelled") },
			{ triggerTurn: false },
		);
		const message = vi.mocked(h.pi.sendMessage).mock.calls.at(-1)?.[0];
		expect(message?.content).toContain("24% used");
		expect(message?.content).toContain("stale");
		expect(h.tracker.active()).toEqual([]);
		expect(h.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("explain validates flags/profile and is a cached, sanitized, nonpersisting forecast", async () => {
		const profile: Profile = {
			id: "new",
			name: "New",
			policy: { version: 1, kind: "remaining-balanced" },
			chain: [{ provider: "anthropic", id: "sonnet" }],
		};
		const h = await harness(false, [profile]);
		const notify = vi.fn();
		const ctx = {
			scopedModels: [],
			ui: { notify },
			modelRegistry: { find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true },
		} as unknown as ExtensionCommandContext;
		for (const action of ["explain", "explain new --bad", "explain new --json --json"]) {
			await h.status(ctx, action);
			expect(notify.mock.calls.at(-1)).toEqual(["subscription-router: expected explain <profile> [--json]", "error"]);
		}
		await h.status(ctx, "explain missing");
		expect(notify.mock.calls.at(-1)).toEqual(["subscription-router: unknown profile 'missing'", "error"]);
		await h.status(ctx, "explain new --json");
		expect(JSON.parse(notify.mock.calls.at(-1)?.[0] as string)).toMatchObject({
			version: 1,
			forecast: true,
			reason: "direct",
			caller: "unknown",
			chosen: "anthropic/sonnet",
		});
		await h.status(ctx, "explain new");
		expect(notify.mock.calls.at(-1)?.[0]).toContain("Cached fresh-dispatch forecast");
		expect(h.fetch).not.toHaveBeenCalled();
		expect(h.pi.appendEntry).not.toHaveBeenCalled();
		await h.status(
			{ ...ctx, modelRegistry: { ...ctx.modelRegistry, find: () => undefined } } as unknown as ExtensionCommandContext,
			"explain new",
		);
		expect(notify.mock.calls.at(-1)?.[0]).toContain("-> exhausted");
	});
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

	it("a new session persists its first decision even when it picks the previous session's model", async () => {
		const { h, ctx, tick, route } = await routed();
		tick(MINUTE);
		expect(await route()).toBe("openai-codex/terra");
		expect(await route()).toBe("openai-codex/terra");
		expect(h.pi.appendEntry).toHaveBeenCalledTimes(1);
		// Session switch (new/resume): same extension instance, same chosen model.
		h.handlers.get("session_start")?.({}, ctx as unknown as ExtensionContext);
		tick(MINUTE);
		expect(await route()).toBe("openai-codex/terra");
		expect(h.pi.appendEntry).toHaveBeenCalledTimes(2);
		expect(await route()).toBe("openai-codex/terra");
		expect(h.pi.appendEntry).toHaveBeenCalledTimes(2);
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

	/** Refs #581: what a core with request-owned routing passes to `route`. */
	function requesterContext(ctx: ExtensionCommandContext, sessionManager = SessionManager.inMemory()) {
		const appendEntry = vi.fn();
		const session = Object.assign(Object.create(ctx), { sessionManager }) as ExtensionCommandContext;
		return { session, appendEntry, routeContext: { modelRegistry: ctx.modelRegistry, session, appendEntry } };
	}

	it("keeps versioned policy traces requester-local, bounded and deduplicated", async () => {
		const profile: Profile = {
			id: "new",
			name: "New",
			policy: { version: 1, kind: "remaining-balanced" },
			chain: [{ provider: "synthetic", id: "a" }],
		};
		const h = await harness(false, [profile]);
		const notify = vi.fn();
		const ctx = {
			scopedModels: [],
			ui: { notify },
			modelRegistry: { find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true },
		} as unknown as ExtensionCommandContext;
		const first = requesterContext(ctx);
		const second = requesterContext(ctx);
		const registration = vi.mocked(h.pi.registerVirtualModel).mock.calls[0]?.[0];
		for (let i = 0; i < 7; i++)
			await registration?.route(
				{
					reason: "continuation",
					thinkingLevel: "off",
					previous: { model: { provider: "synthetic", id: "a" } },
				} as never,
				first.routeContext as never,
			);
		expect(first.appendEntry).toHaveBeenCalledTimes(1);
		expect(first.appendEntry.mock.calls[0]?.[1]).toMatchObject({
			version: 1,
			evaluation: { override: "sticky", caller: "unknown" },
		});
		expect(second.appendEntry).not.toHaveBeenCalled();
		await h.status(first.session);
		expect(
			String(notify.mock.calls.at(-1)?.[0])
				.split("\n")
				.filter((line) => line.includes("router/new continuation ->")),
		).toHaveLength(5);
		await h.status(second.session);
		expect(notify.mock.calls.at(-1)?.[0]).not.toContain("last decisions");
		expect(h.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("logs a requested route to the requester, deduplicated, with its own status history", async () => {
		const { h, ctx, notify, tick } = await routed();
		const registration = vi.mocked(h.pi.registerVirtualModel).mock.calls[0]?.[0];
		const requester = requesterContext(ctx);
		const route = () =>
			registration?.route({ reason: "user", thinkingLevel: "off" } as never, requester.routeContext as never);
		tick(MINUTE);
		await expect(route()).resolves.toMatchObject({ model: { provider: "openai-codex", id: "terra" } });
		await route();
		expect(requester.appendEntry).toHaveBeenCalledTimes(1);
		expect(requester.appendEntry).toHaveBeenCalledWith(
			"router:decision",
			expect.objectContaining({ chosen: "openai-codex/terra" }),
		);
		// The registrant's own pi never logs for a requester.
		expect(h.pi.appendEntry).not.toHaveBeenCalled();
		await h.status(requester.session);
		expect(notify.mock.calls[0]?.[0]).toContain("router/default user -> openai-codex/terra");
		// Another session's status does not show this requester's decisions.
		await h.status(ctx);
		expect(notify.mock.calls[1]?.[0]).not.toContain("last decisions");
		// Starting the requester's session again forgets what it persisted.
		h.handlers.get("session_start")?.({}, requester.session as unknown as ExtensionContext);
		await route();
		expect(requester.appendEntry).toHaveBeenCalledTimes(2);
	});

	it("keeps only the last five decisions per requester and survives a throwing appendEntry", async () => {
		const { h, ctx, notify, tick } = await routed();
		const registration = vi.mocked(h.pi.registerVirtualModel).mock.calls[0]?.[0];
		const requester = requesterContext(ctx);
		requester.appendEntry.mockImplementation(() => {
			throw new Error("session write failed");
		});
		for (let i = 0; i < 7; i++) {
			tick(MINUTE);
			await registration?.route({ reason: "user", thinkingLevel: "off" } as never, requester.routeContext as never);
		}
		await h.status(requester.session);
		const history: string = notify.mock.calls[0]?.[0].split("last decisions (newest last):")[1];
		expect(history.split("\n").filter((line) => line.includes("router/default user ->"))).toHaveLength(5);
		expect(requester.appendEntry).toHaveBeenCalledTimes(1);
	});

	it("never fails a route when the requester session went stale", async () => {
		const { h, ctx, tick } = await routed();
		// The registrant's session_start registry stays valid after the requester's runner goes stale.
		h.handlers.get("session_start")?.({}, ctx as unknown as ExtensionContext);
		const registration = vi.mocked(h.pi.registerVirtualModel).mock.calls[0]?.[0];
		const session = {
			get sessionManager(): never {
				throw new Error("stale");
			},
		};
		tick(MINUTE);
		await expect(
			registration?.route(
				{ reason: "user", thinkingLevel: "off" } as never,
				{
					// A stale requester runner guards every getter, the registry included.
					get modelRegistry(): never {
						throw new Error("stale");
					},
					session,
					appendEntry: vi.fn(),
				} as never,
			),
		).resolves.toMatchObject({ model: { provider: "openai-codex", id: "terra" } });
	});

	it("deduplicates through the registrant when the session has no sessionManager", async () => {
		const { h, ctx, tick } = await routed();
		const registration = vi.mocked(h.pi.registerVirtualModel).mock.calls[0]?.[0];
		const appendEntry = vi.fn();
		const routeContext = { modelRegistry: ctx.modelRegistry, session: {}, appendEntry };
		tick(MINUTE);
		await registration?.route({ reason: "user", thinkingLevel: "off" } as never, routeContext as never);
		await registration?.route({ reason: "user", thinkingLevel: "off" } as never, routeContext as never);
		expect(h.pi.appendEntry).toHaveBeenCalledTimes(1);
		expect(appendEntry).not.toHaveBeenCalled();
	});

	it("falls back to the registrant when the host passes a session without appendEntry", async () => {
		const { h, ctx, tick } = await routed();
		const registration = vi.mocked(h.pi.registerVirtualModel).mock.calls[0]?.[0];
		const { session } = requesterContext(ctx);
		tick(MINUTE);
		await registration?.route(
			{ reason: "user", thinkingLevel: "off" } as never,
			{
				modelRegistry: ctx.modelRegistry,
				session,
			} as never,
		);
		expect(h.pi.appendEntry).toHaveBeenCalledTimes(1);
		// An `appendEntry` without a session is no requester either: nothing writes through it.
		const stray = vi.fn();
		tick(MINUTE);
		await registration?.route(
			{ reason: "user", thinkingLevel: "off" } as never,
			{
				modelRegistry: ctx.modelRegistry,
				appendEntry: stray,
			} as never,
		);
		expect(stray).not.toHaveBeenCalled();
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
		// Span provenance travels through the RPC: Anthropic fixed windows are reported; this fixture's
		// Codex windows carry no `limit_window_seconds`, so their names are positional guesses.
		expect(result.data.snapshots.map((s) => s.windows.map((w) => w.spanSource))).toEqual([
			["reported", "reported"],
			["assumed", "assumed"],
		]);
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

	it("returns RPC errors without leaving callers waiting", async () => {
		const h = await harness();
		vi.spyOn(h.usage, "get").mockRejectedValue(new Error("collector failed"));
		expect(await h.rpc({ refresh: true })).toMatchObject({ success: false, error: "collector failed" });
	});

	it("notifies a terminal quota error instead of continuing", async () => {
		const profile: Profile = {
			id: "default",
			name: "Default",
			chain: [{ provider: "anthropic", id: "sonnet" }],
		};
		const h = await harness(false, [profile]);
		h.fetch.mockResolvedValue(
			new Response(
				JSON.stringify({ five_hour: { utilization: 100, resets_at: new Date(EXHAUSTED_RESET).toISOString() } }),
			),
		);
		const notify = vi.fn();
		const ctx = {
			model: { provider: "router", id: "default" },
			scopedModels: [],
			ui: { notify },
			modelRegistry: { find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true },
		} as unknown as ExtensionContext;
		await h.usage.get(ctx, "anthropic");
		const onSettle = h.handlers.get("agent_before_settle");
		if (!onSettle) throw new Error("agent_before_settle handler missing");
		const outcome = await (onSettle as (event: unknown, context: ExtensionContext) => Promise<unknown>)(
			{
				entries: [],
				context: {
					contextEntries: [
						{
							sourceEntry: { id: "failed", type: "message", message: {} },
							messages: [
								{
									role: "assistant",
									content: [],
									provider: "anthropic",
									model: "sonnet",
									stopReason: "error",
									errorMessage: "insufficient_quota",
									timestamp: T0,
								},
							],
						},
					],
				},
			},
			ctx,
		);
		expect(outcome).toBeUndefined();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("router/default: every model is unavailable"), "error");
	});

	it("runs the admission RPC only after session context exists", async () => {
		const profile: Profile = {
			id: "default",
			name: "Default",
			chain: [{ provider: "anthropic", id: "sonnet" }],
		};
		const cold = await harness(false, [profile]);
		expect((await cold.admit({ model: "anthropic/sonnet" })).data).toEqual({ ok: true });
		const h = await harness(true, [profile]);
		expect((await h.admit({ model: "anthropic/sonnet" })).data).toEqual({
			ok: true,
			resolvedModel: "anthropic/sonnet",
		});
	});

	it.each([
		["the tool is active", ["subscription_usage"], true],
		["the tool is discoverable through tool search", ["search_tools"], true],
		["neither the tool nor tool search is selected", ["read"], false],
	])("names subscription_usage in the prompt section only when %s", async (_label, selectedTools, named) => {
		const profile: Profile = { id: "default", name: "Default", chain: [{ provider: "anthropic", id: "sonnet" }] };
		const h = await harness(false, [profile]);
		const sections: Record<string, string> = {};
		h.handlers.get("before_agent_start")?.({ systemPrompt: "", systemPromptOptions: { selectedTools, sections } }, {
			scopedModels: [],
			ui: { notify: vi.fn() },
		} as unknown as ExtensionContext);
		const section = sections.subscription_usage ?? "";
		expect(section).toContain("- anthropic: ");
		expect(section).toContain("Treat usage as decision support");
		expect(section.includes("subscription_usage")).toBe(named);
		expect(section.includes("tool-search facility")).toBe(named);
	});

	it("renders active blocks in the tool and executes router command actions", async () => {
		const profile: Profile = {
			id: "default",
			name: "Default",
			chain: [{ provider: "anthropic", id: "sonnet" }],
		};
		const h = await harness(true, [profile]);
		const ctx = {
			scopedModels: [],
			ui: { notify: vi.fn() },
			modelRegistry: { find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true },
		} as unknown as ExtensionCommandContext;
		h.tracker.mark({ provider: "anthropic", id: "sonnet" } as never, {
			block: true,
			window: "five_hour",
			scope: "provider",
			resetAt: EXHAUSTED_RESET,
		});
		const registration = vi.mocked(h.pi.registerTool).mock.calls.find(([tool]) => tool.name === "subscription_usage");
		if (!registration) throw new Error("subscription_usage registration missing");
		const result = await registration[0].execute(
			"tool-id",
			{ provider: "anthropic" },
			undefined,
			() => {},
			ctx as never,
		);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("blocked anthropic: five_hour") });
		await h.status(ctx, "refresh");
		expect(h.fetch).toHaveBeenCalledTimes(2);
		await h.status(ctx, "reset");
		expect(h.tracker.active()).toEqual([]);
		await h.status(ctx, "invalid");
		expect(vi.mocked(ctx.ui.notify)).toHaveBeenLastCalledWith(
			expect.stringContaining('unknown action "invalid"'),
			"error",
		);
	});

	it("ignores a rejected config: no router models, and session start says why", async () => {
		const h = await harness(false, [], { ok: false, error: "bad.json: profiles: expected an object" });
		expect(h.pi.registerVirtualModel).not.toHaveBeenCalled();
		const notify = vi.fn();
		h.handlers.get("session_start")?.({}, { scopedModels: [], ui: { notify } } as unknown as ExtensionContext);
		expect(notify).toHaveBeenCalledWith(
			"subscription-router: ignoring config. bad.json: profiles: expected an object",
			"error",
		);
	});

	it("drops RPC requests without a string requestId instead of replying or reading usage", async () => {
		const h = await harness();
		const stray = vi.fn();
		h.events.on("router:rpc:usage:reply:7", stray);
		h.events.on("router:rpc:usage:reply:undefined", stray);
		const read = vi.spyOn(h.usage, "peek");
		for (const payload of [undefined, null, "refresh", { refresh: true }, { requestId: 7, refresh: true }]) {
			h.events.emit("router:rpc:usage", payload);
		}
		await new Promise((resolve) => setImmediate(resolve));
		expect(stray).not.toHaveBeenCalled();
		expect(read).not.toHaveBeenCalled();
		expect(h.fetch).not.toHaveBeenCalled();
		// The channel still serves well-formed requests.
		expect((await h.rpc()).success).toBe(true);
	});

	it("returns a non-Error rejection as its string form", async () => {
		const h = await harness();
		vi.spyOn(h.usage, "get").mockRejectedValue("collector down");
		expect(await h.rpc({ refresh: true })).toMatchObject({ success: false, error: "collector down" });
	});

	it("admits a dispatch whose model is not a string as an unknown ref, never coercing it", async () => {
		const profile: Profile = { id: "default", name: "Default", chain: [{ provider: "anthropic", id: "sonnet" }] };
		const h = await harness(true, [profile]);
		h.tracker.mark(
			{ provider: "anthropic", id: "sonnet" },
			{ block: true, window: "five_hour", resetAt: EXHAUSTED_RESET },
		);
		expect((await h.admit({ model: "anthropic/sonnet" })).data).toMatchObject({ ok: false });
		expect((await h.admit({ model: 42 })).data).toEqual({ ok: true });
		// `String(["anthropic/sonnet"])` would name the blocked model.
		expect((await h.admit({ model: ["anthropic/sonnet"] })).data).toEqual({ ok: true });
	});

	it("tool reads every session provider when none is named, and says when there are none", async () => {
		const notify = vi.fn();
		const empty = await harness(true, []);
		expect(await empty.tool({}, { scopedModels: [], ui: { notify } } as unknown as ExtensionContext)).toBe(
			"No subscription providers in use.",
		);
		const profile: Profile = { id: "default", name: "Default", chain: [{ provider: "anthropic", id: "sonnet" }] };
		const h = await harness(true, [profile]);
		const ctx = {
			scopedModels: [{ model: { provider: "openai-codex" } }],
			ui: { notify },
		} as unknown as ExtensionContext;
		const text = await h.tool({}, ctx);
		expect(text.split("\n").map((line) => line.split(":")[0])).toEqual(["anthropic", "openai-codex"]);
		expect(h.fetch).toHaveBeenCalledTimes(2);
	});

	it("tool names the families of a model-scoped block", async () => {
		const h = await harness(true, []);
		h.tracker.mark(
			{ provider: "anthropic", id: "claude-opus-5-5" },
			{ block: true, window: "seven_day_opus", scope: "model", families: ["opus"], resetAt: Date.now() + MINUTE },
		);
		const text = await h.tool({ provider: "anthropic" }, {
			scopedModels: [],
			ui: { notify: vi.fn() },
		} as unknown as ExtensionContext);
		expect(text).toContain("blocked anthropic opus: seven_day_opus until ");
	});

	it("treats a blank /router argument as status and reports a chain without credentials as exhausted", async () => {
		const profile: Profile = { id: "default", name: "Default", chain: [{ provider: "anthropic", id: "sonnet" }] };
		const h = await harness(false, [profile]);
		const notify = vi.fn();
		const ctx = {
			scopedModels: [],
			ui: { notify },
			modelRegistry: { find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => false },
		} as unknown as ExtensionCommandContext;
		await h.status(ctx, "   ");
		expect(h.fetch).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			"router/default (ordered) -> exhausted\n  anthropic/sonnet: not available (unknown model or no credentials)",
			"info",
		);
	});
});
