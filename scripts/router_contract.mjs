/** Stock-Pi fixture: embed ONLY installed tarball code, never workspace sources or owner auth. */
import { createSubscriptionRouter } from "PACKED_ROUTER_INDEX";
import { UsageService } from "PACKED_ROUTER_USAGE";

const mode = "CONTRACT_MODE";

/**
 * Synthetic subscription utilization the contract's usage collector reports.
 *
 * @param {string} scenario `fallback` exhausts both subscriptions, `recovery` exhausts anthropic from
 *   its second read on, and any other scenario (`balanced`) leaves openai-codex the less used.
 * @param {string} provider `anthropic` or `openai-codex`.
 * @param {number} read 1-based count of this provider's usage reads.
 * @returns {number} Utilization percent, 0 to 100.
 */
export function syntheticUsedPercent(scenario, provider, read) {
	if (scenario === "fallback") return 100;
	if (scenario === "recovery") return provider === "anthropic" && read > 1 ? 100 : 0;
	return provider === "anthropic" ? 90 : 20;
}

const reads = new Map();
const usage = new UsageService({
	now: Date.now,
	getAccessToken: async () => "synthetic-contract-token",
	fetch: async (url) => {
		const provider = url.includes("anthropic") ? "anthropic" : "openai-codex";
		const count = (reads.get(provider) ?? 0) + 1;
		reads.set(provider, count);
		const used = syntheticUsedPercent(mode, provider, count);
		return new Response(
			JSON.stringify(
				provider === "anthropic"
					? { five_hour: { utilization: used, resets_at: new Date(Date.now() + 3_600_000).toISOString() } }
					: { rate_limit: { primary_window: { used_percent: used, reset_at: (Date.now() + 3_600_000) / 1000 } } },
			),
		);
	},
});

export default async function routerContract(pi) {
	// Prewarm before registration; failure confirmation still calls the real collector/cache.
	await usage.get({}, "anthropic");
	await usage.get({}, "openai-codex");
	await createSubscriptionRouter({
		config: {
			ok: true,
			profiles: [
				{
					id: "default",
					name: "Packed multi-provider",
					strategy: "balanced",
					chain: [
						{ provider: "anthropic", id: "m-a" },
						{ provider: "openai-codex", id: "m-b" },
						{ provider: "local", id: "m-c" },
					],
				},
			],
		},
		usage,
	})(pi);
}
