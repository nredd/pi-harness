/** Deterministic quota accounting around the production Router, never a second selector. */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import type { Profile } from "../src/config.js";
import { ExhaustionTracker } from "../src/exhaustion.js";
import { type RouteEnv, Router } from "../src/router.js";
import type { UsageSnapshot } from "../src/usage.js";
import { CachedUsage, Clock } from "./fixtures/router.js";

/** An offline normalized observation, never a provider payload or token conversion. */
export interface ReplayFrame {
	at: number;
	snapshots: UsageSnapshot[];
	reason: ModelRouteRequest["reason"];
	previous?: number;
	outsideDebits?: number[];
	cost?: number;
}

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
		strategy: Profile["strategy"] | Profile["policy"] = "balanced",
	) {
		this.debits = capacities.map(() => 0);
		this.profile = {
			id: "simulation",
			name: "Simulation",
			...(typeof strategy === "object" ? { policy: strategy } : { strategy }),
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

	/** Replay explicit sanitized cache observations through production routing, without physical execution. */
	async replay(frames: readonly ReplayFrame[]) {
		const counts = this.capacities.map(() => 0);
		let switches = 0;
		let unknownExposures = 0;
		let previous: number | undefined;
		for (const frame of frames) {
			this.clock.advance(frame.at - this.clock.now());
			this.usage.snapshots.clear();
			for (const snapshot of frame.snapshots) this.usage.snapshots.set(snapshot.provider, structuredClone(snapshot));
			for (const [index, debit] of (frame.outsideDebits ?? []).entries())
				this.debits[index] = (this.debits[index] ?? 0) + debit;
			const entry = frame.previous === undefined ? undefined : this.profile.chain[frame.previous];
			const route = await this.router.route(
				this.profile,
				{
					model: { provider: "router", id: this.profile.id } as Model<Api>,
					thinkingLevel: "off",
					reason: frame.reason,
					messages: [],
					previous: entry ? { model: this.env.resolve(entry) as Model<Api> } : undefined,
				},
				this.env,
				(decision) => {
					if (decision.candidates.find((candidate) => candidate.model === decision.chosen)?.quota.kind === "fallback")
						unknownExposures++;
				},
			);
			const index = this.profile.chain.findIndex((candidate) => candidate.provider === route.model.provider);
			counts[index] = (counts[index] ?? 0) + 1;
			this.debits[index] = (this.debits[index] ?? 0) + (frame.cost ?? 1);
			if (previous !== undefined && previous !== index) switches++;
			previous = index;
		}
		const remaining = this.capacities.map((capacity, index) => 1 - (this.debits[index] ?? 0) / capacity);
		return {
			counts,
			switches,
			unknownExposures,
			normalizedRemainingSkew: Math.max(...remaining) - Math.min(...remaining),
		};
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
