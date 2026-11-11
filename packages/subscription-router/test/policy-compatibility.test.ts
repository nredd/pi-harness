/** Golden receipts captured on the pre-calculus implementation, never derived from its compiler. */
import { type Api, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { ExhaustionTracker } from "../src/exhaustion.js";
import { formatDecision, type RouteDecision, Router } from "../src/router.js";
import { CachedUsage, Clock } from "./scenarios/support.js";

it("preserves legacy routes, diagnostics, errors and admissions byte for byte", async () => {
	const results = [];
	for (const strategy of [undefined, "ordered", "balanced"]) {
		for (const state of ["measured", "fallback", "unlimited", "stale", "expired", "blocked"]) {
			for (const reason of ["user", "direct", "continuation", "retry"] as const) {
				const profile = parseConfig({
					profiles: {
						golden: {
							strategy,
							chain: [{ model: "a/sonnet", thinking: "high" }, { model: "b/terra" }, { model: "c/third" }],
						},
					},
				})[0];
				if (!profile) throw new Error("missing fixture");
				const clock = new Clock();
				const usage = new CachedUsage(clock);
				usage.set("a", state === "blocked" ? 100 : 70);
				usage.set("b", state === "blocked" ? 100 : 20);
				usage.set("c", state === "blocked" ? 100 : 30);
				for (const snapshot of usage.snapshots.values()) {
					if (state === "fallback") snapshot.status = "unavailable";
					if (state === "unlimited") snapshot.credits = { available: true, unlimited: true };
					if (state === "stale" || state === "expired") {
						snapshot.status = "stale";
						snapshot.retrievedAt -= state === "stale" ? 900_000 : 900_001;
					}
				}
				const model = (provider: string): Model<Api> =>
					({
						provider,
						id: provider === "a" ? "sonnet" : provider === "b" ? "terra" : "third",
						api: "test",
					}) as unknown as Model<Api>;
				const decisions: RouteDecision[] = [];
				const router = new Router(usage, new ExhaustionTracker(clock.now), clock.now, (decision) =>
					decisions.push(decision),
				);
				const reads: string[] = [];
				const env = {
					resolve: (entry: { provider: string }) => model(entry.provider),
					refresh: async (failed: Model<Api>) => {
						reads.push(failed.provider);
						return { block: false };
					},
				};
				const request: ModelRouteRequest = {
					model: model("router"),
					thinkingLevel: "low",
					reason,
					messages: [],
					previous: { model: model("b") },
					failed: {
						model: model("b"),
						message: fauxAssistantMessage([], { stopReason: "error", errorMessage: "429", timestamp: clock.now() }),
					},
				};
				let route: unknown;
				try {
					route = await router.route(profile, request, env);
				} catch (error) {
					route = (error as Error).message;
				}
				results.push({
					strategy,
					state,
					reason,
					profile,
					route,
					decisions,
					text: decisions.map(formatDecision),
					reads,
					admission: router.admit("router/golden", new Map([["golden", profile]]), env),
				});
			}
		}
	}
	expect(JSON.stringify(results, null, 2)).toMatchSnapshot();
});
