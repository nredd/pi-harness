/** Extended receipts generated against immutable pre-calculus base 1e93038c, not the new compiler. */
import { EventEmitter } from "node:events";
import { type Api, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { ExhaustionTracker } from "../src/exhaustion.js";
import { createSubscriptionRouter } from "../src/index.js";
import { SettleRecovery } from "../src/recovery.js";
import { formatDecision, type RouteDecision, Router } from "../src/router.js";
import { UsageService } from "../src/usage.js";
import { CachedUsage, Clock } from "./fixtures/router.js";

const STATES = [
	"hysteresis-below",
	"hysteresis-equal",
	"hysteresis-above",
	"roundoff-clamp",
	"roundoff-tiny",
	"missing-reset",
	"missing-duration",
	"reset-equal",
	"reset-past",
	"grace-before",
	"grace-equal",
	"grace-after",
	"stale-unlimited",
	"family-overlap",
	"all-blocked",
	"confirmed-retry",
	"partial-retry",
	"nonquota-retry",
	"cancelled",
	"cancelled-confirmation",
	"no-credentials",
] as const;

it("preserves boundary route, full status, decision JSON/text, confirmation and wake receipts", async () => {
	const results = [];
	for (const strategy of [undefined, "ordered", "balanced"] as const)
		for (const state of STATES) {
			const profile = parseConfig({
				profiles: {
					edges: {
						strategy,
						chain: [{ model: "a/sonnet", thinking: "high" }, { model: "b/terra" }, { model: "a/opus" }],
						exhaustionPolicy: "wait",
						maxWaitMinutes: 90,
					},
				},
			})[0];
			if (!profile) throw new Error("fixture profile missing");
			const clock = new Clock();
			const usage = new CachedUsage(clock);
			const tracker = new ExhaustionTracker(clock.now);
			usage.set("a", 50);
			usage.set("b", 40);
			const a = usage.peek("a");
			const b = usage.peek("b");
			if (!a?.windows[0] || !b?.windows[0]) throw new Error("fixture windows missing");
			if (state === "hysteresis-below") b.windows[0].usedPercent = 40.000001;
			if (state === "hysteresis-above") b.windows[0].usedPercent = 39.999999;
			if (state === "roundoff-clamp") {
				a.windows[0].usedPercent = 99.99;
				b.windows[0].usedPercent = 99.988;
				a.windows[0].resetAt = b.windows[0].resetAt = clock.now() + 1;
			}
			if (state === "roundoff-tiny") {
				a.windows[0].usedPercent = 99.9999999999999;
				b.windows[0].usedPercent = 99.9999999999998;
			}
			if (state === "missing-reset") {
				delete a.windows[0].resetAt;
				delete b.windows[0].resetAt;
			}
			if (state === "missing-duration") {
				delete a.windows[0].durationMs;
				delete b.windows[0].durationMs;
			}
			if (state === "reset-equal" || state === "reset-past")
				a.windows[0].resetAt = clock.now() - (state === "reset-past" ? 1 : 0);
			if (state.startsWith("grace-")) {
				a.status = "stale";
				a.retrievedAt -= 900_000 + (state === "grace-before" ? -1 : state === "grace-after" ? 1 : 0);
				a.windows[0].usedPercent = 1;
			}
			if (state === "stale-unlimited") {
				a.status = "stale";
				a.windows = [];
				a.credits = { available: true, unlimited: true };
			}
			if (state === "family-overlap")
				a.windows.push(
					{
						name: "sonnet-weekly",
						scope: "model",
						families: ["sonnet"],
						usedPercent: 100,
						resetAt: clock.now() + 120_000,
					},
					{ name: "opus-weekly", scope: "model", families: ["opus"], usedPercent: 60 },
				);
			if (state === "all-blocked") {
				const active = a.windows[0];
				if (!active) throw new Error("fixture window missing");
				active.usedPercent = b.windows[0].usedPercent = 100;
				a.windows.push({ name: "later", scope: "provider", usedPercent: 100, resetAt: clock.now() + 7_200_000 });
			}
			const controller = new AbortController();
			if (state === "cancelled") controller.abort(new Error("synthetic cancellation"));
			if (["confirmed-retry", "partial-retry", "cancelled-confirmation"].includes(state))
				usage.onRefresh = (provider) => {
					usage.set(provider, 100);
					if (state === "cancelled-confirmation") controller.abort(new Error("synthetic cancellation"));
				};
			const entries: unknown[] = [];
			const notifications: string[] = [];
			let registration: Parameters<ExtensionAPI["registerVirtualModel"]>[0] | undefined;
			let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
			const pi = {
				events: new EventEmitter(),
				on: () => {},
				registerVirtualModel: (value: NonNullable<typeof registration>) => {
					registration = value;
				},
				registerCommand: (_name: string, value: NonNullable<typeof command>) => {
					command = value;
				},
				registerTool: () => {},
				appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
			} as unknown as ExtensionAPI;
			await createSubscriptionRouter({ config: { ok: true, profiles: [profile] }, usage, tracker, now: clock.now })(pi);
			const model = (provider: string, id: string): Model<Api> =>
				({ provider, id, api: "test" }) as unknown as Model<Api>;
			const ctx = {
				scopedModels: [],
				sessionManager: {},
				modelRegistry: {
					find: (provider: string, id: string) => (state === "no-credentials" ? undefined : model(provider, id)),
					hasConfiguredAuth: () => true,
				},
				ui: { notify: (message: string) => notifications.push(message) },
			} as unknown as ExtensionCommandContext;
			const retry = state.endsWith("retry") || state === "cancelled-confirmation";
			const request: ModelRouteRequest = {
				model: model("router", "edges"),
				thinkingLevel: "low",
				reason: retry ? "retry" : "user",
				messages: [],
				previous: { model: model("a", "sonnet") },
				signal: controller.signal,
				failed: {
					model: model("a", "sonnet"),
					message: fauxAssistantMessage(state === "partial-retry" ? "visible partial" : [], {
						stopReason: "error",
						errorMessage: state === "nonquota-retry" ? "overloaded" : "429",
						timestamp: clock.now(),
					}),
				},
			};
			let route: unknown;
			try {
				route = await registration?.route(request, ctx);
			} catch (error) {
				route = { name: (error as Error).name, message: (error as Error).message };
			}
			await command?.handler("status", ctx);
			const router = new Router(usage, tracker, clock.now);
			const admission = router.admit("router/edges", new Map([["edges", profile]]), {
				resolve: (entry) => ctx.modelRegistry.find(entry.provider, entry.id),
				refresh: async () => undefined,
			});
			results.push({
				strategy,
				state,
				route,
				entries,
				decisionText: entries.flatMap((entry) => {
					const record = entry as { data: RouteDecision };
					return [formatDecision(record.data)];
				}),
				status: notifications,
				reads: usage.reads.map(({ provider, options }) => ({
					provider,
					fresh: options.fresh,
					notBefore: options.notBefore,
					aborted: options.signal?.aborted,
				})),
				blocks: tracker.active(),
				admission,
			});
		}
	expect(JSON.stringify(results, null, 2)).toMatchSnapshot();
});

it("preserves overlapping exact-snapshot confirmations in both completion orders", async () => {
	const results = [];
	for (const strategy of [undefined, "ordered", "balanced"] as const)
		for (const newerFirst of [false, true]) {
			const profile = parseConfig({
				profiles: { race: { strategy, chain: [{ model: "anthropic/sonnet" }, { model: "other/terra" }] } },
			})[0];
			if (!profile) throw new Error("fixture profile missing");
			let now = 1_700_000_000_000;
			const pending: ((value: Response) => void)[] = [];
			const usage = new UsageService({
				now: () => now,
				getAccessToken: async () => "synthetic",
				fetch: async () => new Promise<Response>((resolve) => pending.push(resolve)),
			});
			const tracker = new ExhaustionTracker(() => now);
			const decisions: RouteDecision[] = [];
			const router = new Router(
				usage,
				tracker,
				() => now,
				(decision) => decisions.push(decision),
			);
			const physical = { provider: "anthropic", id: "sonnet", api: "test" } as unknown as Model<Api>;
			const env = {
				resolve: (entry: { provider: string; id: string }) => ({ ...entry, api: "test" }) as unknown as Model<Api>,
				refresh: async (m: Model<Api>, signal: AbortSignal | undefined, notBefore: number) => {
					const snapshot = await usage.get({} as never, m.provider, { fresh: true, signal, notBefore });
					return snapshot.status === "available" && snapshot.retrievedAt >= notBefore
						? usage.decisionFor(m, snapshot)
						: undefined;
				},
			};
			const request = (): ModelRouteRequest => ({
				model: physical,
				reason: "retry",
				thinkingLevel: "off",
				messages: [],
				failed: {
					model: physical,
					message: fauxAssistantMessage([], { stopReason: "error", errorMessage: "429", timestamp: now }),
				},
			});
			const early = router.route(profile, request(), env);
			await vi.waitFor(() => expect(pending).toHaveLength(1));
			now++;
			const late = router.route(profile, request(), env);
			await vi.waitFor(() => expect(pending).toHaveLength(2));
			const response = (used: number) =>
				new Response(
					JSON.stringify({ five_hour: { utilization: used, resets_at: new Date(now + 60_000).toISOString() } }),
				);
			if (newerFirst) {
				pending[1]?.(response(100));
				await late;
				pending[0]?.(response(1));
			} else {
				pending[0]?.(response(1));
				pending[1]?.(response(100));
			}
			const routes = await Promise.all([early, late]);
			results.push({
				strategy,
				newerFirst,
				routes,
				reads: pending.length,
				decisions,
				text: decisions.map(formatDecision),
				blocks: tracker.active(),
				cached: usage.peek("anthropic"),
				admission: router.admit("router/race", new Map([["race", profile]]), env),
			});
		}
	expect(JSON.stringify(results, null, 2)).toMatchSnapshot();
});

it("preserves terminal partial refusal and empty-output recovery receipts", async () => {
	const results = [];
	for (const strategy of [undefined, "ordered", "balanced"] as const)
		for (const partial of [false, true]) {
			const profile = parseConfig({
				profiles: { recovery: { strategy, chain: [{ model: "a/sonnet" }, { model: "b/terra" }] } },
			})[0];
			if (!profile) throw new Error("fixture profile missing");
			const clock = new Clock();
			const usage = new CachedUsage(clock);
			usage.set("a", 0);
			usage.set("b", 0);
			const tracker = new ExhaustionTracker(clock.now);
			const router = new Router(usage, tracker, clock.now);
			const recovery = new SettleRecovery(router);
			let reads = 0;
			const env = {
				resolve: (entry: { provider: string; id: string }) => ({ ...entry, api: "test" }) as unknown as Model<Api>,
				refresh: async () => {
					reads++;
					usage.set("a", 100);
					return { block: true, window: "weekly", scope: "provider" as const, resetAt: clock.now() + 60_000 };
				},
			};
			const message = {
				...fauxAssistantMessage(partial ? "visible partial" : [], {
					stopReason: "error",
					errorMessage: "insufficient_quota",
					timestamp: clock.now(),
				}),
				provider: "a",
				model: "sonnet",
			};
			const event = {
				entries: [],
				context: { contextEntries: [{ sourceEntry: { id: "failed", type: "message", message }, messages: [message] }] },
			} as unknown as Parameters<SettleRecovery["handle"]>[0];
			results.push({
				strategy,
				partial,
				outcome: await recovery.handle(event, profile, env, undefined),
				reads,
				blocks: tracker.active(),
			});
		}
	expect(JSON.stringify(results, null, 2)).toMatchSnapshot();
});
