/** Shared faux-provider helper for the e2e harnesses; never installed. */

import { createFauxCore } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Register provider `provider` with one model `id` and return its scripted core. */
export function register(pi: ExtensionAPI, provider: string, id: string) {
	const core = createFauxCore({ api: `${provider}-api`, provider, models: [{ id }] });
	pi.registerProvider(provider, {
		baseUrl: "http://127.0.0.1:9",
		apiKey: "faux",
		api: `${provider}-api`,
		streamSimple: core.streamSimple,
		models: [
			{
				id,
				name: id,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 4_096,
			},
		],
	});
	return core;
}
