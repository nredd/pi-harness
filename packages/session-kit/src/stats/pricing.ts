/** Offline valuation of immutable usage records through the host's shared pricing engine. */
// Stock extension loaders bridge root host peers, not every package subpath.
import * as modelApi from "@earendil-works/pi-ai";
import { tokensOf } from "./aggregate.ts";
import { money } from "./format.ts";
import type { Call } from "./load.ts";

/** Structural boundary keeps older hosts honest: absent pricing support means unknown, not zero. */
export interface PricingModel {
	provider: string;
	id: string;
	cost: unknown;
	type?: string;
}
export type Estimate = (
	model: PricingModel | undefined,
	tokens: Call,
) => { cost: { total: number } | null; reason?: string };
export type ValueCall = (call: Call) => { cost: number | null; reason?: string; basis?: string };

/** Capture only already-loaded models. This function never refreshes catalogs or resolves authentication. */
export function createValuer(
	models: readonly PricingModel[],
	estimate: Estimate | null | undefined = (modelApi as typeof modelApi & { estimateTokenCost?: Estimate })
		.estimateTokenCost,
): ValueCall {
	const byId = new Map(models.map((model) => [JSON.stringify([model.provider, model.id]), model]));
	return (call) => {
		if (!estimate) return { cost: null, reason: "Host has no verified pricing estimator." };
		const model = byId.get(JSON.stringify([call.provider, call.model]));
		const result = estimate(model, call);
		if (result.cost === null) return { cost: null, reason: result.reason ?? "Price unavailable." };
		if (!Number.isFinite(result.cost.total) || result.cost.total < 0)
			return { cost: null, reason: "Invalid estimate." };
		const cost = model?.cost;
		const assessment = typeof cost === "object" && cost !== null && "assessment" in cost ? cost.assessment : undefined;
		const basis =
			typeof assessment === "object" && assessment !== null
				? ["source", "checkedAt", "unit", "conditions"]
						.map((key) => Reflect.get(assessment, key))
						.filter((v): v is string => typeof v === "string")
						.join("; ")
				: undefined;
		return { cost: result.cost.total, basis };
	};
}

export interface Valuation {
	/** Null when nothing is priced. A partial sum is explicitly a priced subset, never a full total. */
	cost: number | null;
	pricedEvents: number;
	unpricedEvents: number;
	pricedTokens: number;
	unpricedTokens: number;
	reasons: Map<string, number>;
	bases: Set<string>;
}

/** Value each physical event before summing; never price aggregated tokens across context tiers. */
export function valuation(calls: readonly Call[], value: ValueCall): Valuation {
	const out: Valuation = {
		cost: null,
		pricedEvents: 0,
		unpricedEvents: 0,
		pricedTokens: 0,
		unpricedTokens: 0,
		reasons: new Map(),
		bases: new Set(),
	};
	for (const call of calls) {
		const result = value(call);
		if (result.cost === null) {
			out.unpricedEvents++;
			out.unpricedTokens += tokensOf(call);
			const reason = result.reason ?? "Price unavailable.";
			out.reasons.set(reason, (out.reasons.get(reason) ?? 0) + 1);
		} else {
			if (result.basis) out.bases.add(result.basis);
			out.pricedEvents++;
			out.pricedTokens += tokensOf(call);
			out.cost = (out.cost ?? 0) + result.cost;
		}
	}
	return out;
}

/** Labels are deliberately separate from recorded cost and subscription cash charges. */
export function valuationLines(calls: readonly Call[], value: ValueCall): string[] {
	const out = valuation(calls, value);
	return [
		`Current-rate API-equivalent estimate: ${out.cost === null ? "unknown" : money(out.cost)}${out.unpricedEvents ? " (priced subset only)" : ""}`,
		`Pricing coverage: ${out.pricedEvents} priced / ${out.unpricedEvents} unpriced events; ${out.pricedTokens} priced / ${out.unpricedTokens} unpriced tokens`,
		"Assumes loaded catalog list-price conditions, not request-date billing or subscription spend; missing cache TTL stays unknown.",
		...Array.from(out.bases, (basis) => `Price basis: ${basis}`),
		...Array.from(out.reasons, ([reason, count]) => `Unpriced: ${count} events: ${reason}`),
	];
}
