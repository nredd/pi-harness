/**
 * E2E harness for mid-run quota recovery; never installed.
 *
 * Registers two faux providers, `spike-a` (fails) and `spike-b` (answers), and
 * pre-seeds the router's process-global state with a usage stub that confirms
 * `spike-a` exhausted after a fresh read. Load it BEFORE the router so the seed
 * wins. `SPIKE_ERROR` picks the failure text: a terminal quota error exercises
 * the settle hook, a plain 429 exercises `retry` routing.
 */

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ExhaustionTracker } from "../src/exhaustion.js";
import type { UsageDecision, UsageSnapshot } from "../src/usage.js";
import { register } from "./faux.js";

const ERROR_TEXT = process.env.SPIKE_ERROR ?? "insufficient_quota: You exceeded your current quota";
/** `unconfirmed` leaves usage saying "fine", so recovery must not happen. */
const CONFIRM = process.env.SPIKE_CONFIRM !== "unconfirmed";

export default function fauxQuota(pi: ExtensionAPI): void {
	const a = register(pi, "spike-a", "sonnet-a");
	const b = register(pi, "spike-b", "terra-b");
	// Turn 1 on spike-a calls a tool; the follow-up request then fails. Every
	// later spike-a request fails too, so a loop would show up as repeats.
	a.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: "echo tool-ran" }), { stopReason: "toolUse" }),
		...Array.from({ length: 8 }, () => fauxAssistantMessage("", { stopReason: "error", errorMessage: ERROR_TEXT })),
	]);
	b.setResponses(
		Array.from({ length: 4 }, () => (context: { messages: readonly { role: string }[] }) => {
			const roles = context.messages.map((message) => message.role).join(",");
			console.error(`[spike] spike-b request roles: ${roles}`);
			return fauxAssistantMessage("RECOVERED on spike-b/terra-b");
		}),
	);

	let confirmed = false;
	const snapshot = (provider: string): UsageSnapshot => ({
		provider,
		status: "available",
		windows: [],
		retrievedAt: Date.now(),
		expiresAt: Date.now() + 60_000,
	});
	const usage = {
		get: async (_ctx: unknown, provider: string) => {
			if (provider === "spike-a" && CONFIRM) confirmed = true;
			console.error(`[spike] usage.get ${provider} -> confirmed=${confirmed}`);
			return snapshot(provider);
		},
		peek: (provider: string) => snapshot(provider),
		decisionFor: (model: { provider: string }): UsageDecision =>
			model.provider === "spike-a" && confirmed
				? { block: true, window: "five_hour", scope: "provider", resetAt: Date.now() + 3_600_000 }
				: { block: false },
		format: () => "spike",
		formatForPrompt: () => "spike",
	};
	(globalThis as Record<symbol, unknown>)[Symbol.for("pi-subscription-router.shared")] = {
		usage,
		tracker: new ExhaustionTracker(),
	};
}
