/** Synthetic pricing fixtures shared by the current-rate valuation tests. */
import type { PricingModel } from "../../../src/stats/pricing.ts";

export const PRICING_DATE = "2026-11-12";
export const PRICING_ASSESSMENT = {
	status: "verified",
	source: "https://example.test/pricing",
	checkedAt: PRICING_DATE,
	unit: "usd-per-million-tokens",
	conditions: "Synthetic Standard token baseline",
};
export const PRICING_RATES = {
	input: 2,
	output: 10,
	cacheRead: 0.1,
	cacheWrite: 2.5,
	cacheWrite1h: 4,
	cacheWrite12h: 5,
};
/** Base rates plus one request-wide context tier above 100 prompt tokens. */
export const PRICING_MODEL: PricingModel = {
	provider: "example-provider",
	id: "physical",
	cost: {
		...PRICING_RATES,
		assessment: PRICING_ASSESSMENT,
		tiers: [
			{
				inputTokensAbove: 100,
				input: 4,
				output: 15,
				cacheRead: 0.2,
				cacheWrite: 5,
				cacheWrite1h: 8,
				cacheWrite12h: 10,
			},
		],
	},
};
