/**
 * E2E harness for dispatch admission and the exhaustion policy; never installed.
 *
 * Load BEFORE pi-subagents and the router. `spike-main` is the parent model: it
 * calls the `Agent` tool once (`SPIKE_AGENT_MODEL`, `SPIKE_BACKGROUND`) and then
 * finishes. With `SPIKE_BLOCKED=1` the router's usage state is pre-seeded so
 * both `spike-a` and `spike-b` are exhausted until an hour from now. Without a
 * router loaded the seed is inert, which is the enterprise-profile case.
 * `spike-b` answers, so an admitted child visibly runs.
 */

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ExhaustionTracker } from "../src/exhaustion.js";
import type { UsageDecision, UsageSnapshot } from "../src/usage.js";
import { register } from "./faux.js";

const AGENT_MODEL = process.env.SPIKE_AGENT_MODEL ?? "router/spike";
const BACKGROUND = process.env.SPIKE_BACKGROUND !== "0";
const BLOCKED = process.env.SPIKE_BLOCKED === "1";

export default function fauxAdmission(pi: ExtensionAPI): void {
	const main = register(pi, "spike-main", "driver");
	register(pi, "spike-a", "sonnet-a");
	const b = register(pi, "spike-b", "terra-b");
	main.setResponses([
		fauxAssistantMessage(
			fauxToolCall("Agent", {
				subagent_type: "general-purpose",
				description: "e2e admission",
				prompt: "say hi",
				model: AGENT_MODEL,
				run_in_background: BACKGROUND,
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("DRIVER DONE"),
	]);
	b.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("ANSWERED on spike-b")));

	if (!BLOCKED) return;
	const resetAt = Date.now() + 3_600_000;
	const snapshot = (provider: string): UsageSnapshot => ({
		provider,
		status: "available",
		windows: [],
		retrievedAt: Date.now(),
		expiresAt: Date.now() + 60_000,
	});
	const usage = {
		get: async (_ctx: unknown, provider: string) => snapshot(provider),
		peek: snapshot,
		decisionFor: (model: { provider: string }): UsageDecision =>
			model.provider.startsWith("spike-") && model.provider !== "spike-main"
				? { block: true, window: "five_hour", scope: "provider", resetAt }
				: { block: false },
		format: () => "spike",
		formatForPrompt: () => "spike",
	};
	(globalThis as Record<symbol, unknown>)[Symbol.for("pi-subscription-router.shared")] = {
		usage,
		tracker: new ExhaustionTracker(),
	};
}
