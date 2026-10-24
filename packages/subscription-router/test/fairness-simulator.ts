/** Deterministic quota accounting around the production Router, never a second selector. */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import type { Profile } from "../src/config.js";
import { ExhaustionTracker } from "../src/exhaustion.js";
import { type RouteEnv, Router } from "../src/router.js";
import { CachedUsage, Clock } from "./scenarios/support.js";

/** One quota unit is a synthetic debit, not a token or a provider billing conversion. */
export class FairnessSimulation {
	readonly clock = new Clock();
	readonly usage = new CachedUsage(this.clock);
	readonly router = new Router(this.usage, new ExhaustionTracker(this.clock.now), this.clock.now);
	readonly profile: Profile;
	readonly env: RouteEnv;
	readonly debits: number[];
	readonly dispatches: number[] = [];
	private previous: ModelRoute | undefined;

	constructor(
		readonly capacities: readonly number[],
		strategy: Profile["strategy"] = "balanced",
	) {
		this.debits = capacities.map(() => 0);
		this.profile = {
			id: "simulation",
			name: "Simulation",
			strategy,
			chain: capacities.map((_, i) => ({ provider: `quota-${i}`, id: "sonnet-test" })),
		};
		this.env = {
			resolve: (entry) => ({ ...entry, api: "test" }) as unknown as Model<Api>,
			refresh: async () => {
				throw new Error("Simulation must not refresh or authenticate");
			},
		};
		this.publish();
	}

	/** Publish account-wide truth; withholding this operation models telemetry lag. */
	publish(): void {
		for (const [i, capacity] of this.capacities.entries())
			this.usage.set(`quota-${i}`, (100 * (this.debits[i] ?? 0)) / capacity);
	}

	/** Advance actual routing with explicit session affinity and debit only after dispatch. */
	async step(
		options: { cost?: number; fresh?: boolean; incumbent?: boolean; reason?: ModelRouteRequest["reason"] } = {},
	): Promise<number> {
		if (options.fresh !== false) this.publish();
		const route = await this.router.route(
			this.profile,
			{
				model: { provider: "router", id: this.profile.id } as Model<Api>,
				thinkingLevel: "off",
				reason: options.reason ?? "user",
				messages: [],
				previous: options.incumbent === false ? undefined : this.previous,
			},
			this.env,
		);
		this.previous = route;
		const index = this.profile.chain.findIndex((entry) => entry.provider === route.model.provider);
		if (index < 0) throw new Error("Router selected a model outside the simulated chain");
		this.debits[index] = (this.debits[index] ?? 0) + (options.cost ?? 1);
		this.dispatches.push(index);
		return index;
	}
}
