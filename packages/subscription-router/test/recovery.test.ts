import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { AgentBeforeSettleEvent, ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { ChainEntry, Profile } from "../src/config.js";
import { ExhaustionTracker } from "../src/exhaustion.js";
import { SettleRecovery } from "../src/recovery.js";
import { type RouteEnv, Router } from "../src/router.js";
import type { UsageDecision, UsageSnapshot } from "../src/usage.js";

const T0 = 1_700_000_000_000;
const SONNET: ChainEntry = { provider: "anthropic", id: "claude-sonnet-5-5" };
const TERRA: ChainEntry = { provider: "openai-codex", id: "gpt-5.6-terra" };
const PROFILE: Profile = { id: "default", name: "default", chain: [SONNET, TERRA] };

function harness(live: Record<string, UsageDecision>, snapshots: Record<string, UsageSnapshot> = {}) {
	const cached: Record<string, UsageDecision> = {};
	const tracker = new ExhaustionTracker(() => T0);
	const router = new Router(
		{ decisionFor: (m) => cached[m.provider] ?? { block: false }, peek: (provider) => snapshots[provider] },
		tracker,
		() => T0,
	);
	const env: RouteEnv = {
		resolve: (entry) => ({ provider: entry.provider, id: entry.id, api: "test" }) as unknown as Model<Api>,
		refresh: async ({ provider }) => {
			const decision = live[provider];
			if (decision) cached[provider] = decision;
			return decision;
		},
	};
	return { recovery: new SettleRecovery(router), env, tracker };
}

function entry(id: string, message: Record<string, unknown>): ProjectedSessionEntry {
	return {
		sourceEntry: { id, type: "message", message } as unknown as ProjectedSessionEntry["sourceEntry"],
		messages: [message as unknown as AssistantMessage],
	};
}

/** Settle event whose context ends with `tail`, after a user prompt. */
function settle(tail: ProjectedSessionEntry): Pick<AgentBeforeSettleEvent, "entries" | "context"> {
	const prompt = entry("u1", { role: "user", content: "hi" });
	return {
		entries: [{ type: "custom", customType: "other-extension" }],
		context: {
			contextEntries: [prompt, tail],
			contextMessages: [],
			llmMessages: [],
			pendingMessages: [],
			canContinue: false,
		},
	};
}

function quotaError(chain: ChainEntry, text = "insufficient_quota"): ProjectedSessionEntry {
	return entry("a1", {
		role: "assistant",
		content: [],
		provider: chain.provider,
		model: chain.id,
		stopReason: "error",
		errorMessage: text,
	});
}

const blocked: UsageDecision = { block: true, window: "five_hour", scope: "provider", resetAt: T0 + 60_000 };

describe("SettleRecovery", () => {
	it("omits the failed message and continues on the next chain model once usage confirms", async () => {
		const { recovery, env, tracker } = harness({ anthropic: blocked });
		const event = settle(quotaError(SONNET));
		const outcome = await recovery.handle(event, PROFILE, env, undefined);
		expect(outcome).toMatchObject({
			kind: "continue",
			from: "anthropic/claude-sonnet-5-5",
			to: "openai-codex/gpt-5.6-terra",
		});
		if (outcome.kind !== "continue") throw new Error("unreachable");
		expect(outcome.result).toEqual({
			entries: [...event.entries, { type: "context_edit", targetId: "a1", replacement: null }],
			continue: true,
		});
		expect(tracker.active()).toHaveLength(1);
	});

	it("recovers to the shared balanced pick rather than the next chain entry", async () => {
		const third: ChainEntry = { provider: "third", id: "third-model" };
		const data = (provider: string, usedPercent: number): UsageSnapshot => ({
			provider,
			status: "available",
			windows: [{ name: "weekly", scope: "provider", usedPercent }],
			retrievedAt: T0,
			expiresAt: T0 + 60_000,
		});
		const { recovery, env } = harness(
			{ anthropic: blocked },
			{ "openai-codex": data("openai-codex", 90), third: data("third", 10) },
		);
		const profile: Profile = { ...PROFILE, strategy: "balanced", chain: [SONNET, TERRA, third] };
		expect(await recovery.handle(settle(quotaError(SONNET)), profile, env, undefined)).toMatchObject({
			kind: "continue",
			to: "third/third-model",
		});
	});

	it("does nothing when usage does not confirm the block", async () => {
		const { recovery, env, tracker } = harness({});
		expect(await recovery.handle(settle(quotaError(SONNET)), PROFILE, env, undefined)).toEqual({ kind: "none" });
		expect(tracker.active()).toEqual([]);
	});

	it("finds a trailing quota error after an empty projected entry", async () => {
		const { recovery, env } = harness({ anthropic: blocked });
		const event = settle(quotaError(SONNET));
		event.context.contextEntries.push({
			sourceEntry: { id: "empty", type: "message", message: {} } as ProjectedSessionEntry["sourceEntry"],
			messages: [],
		});
		expect(await recovery.handle(event, PROFILE, env, undefined)).toMatchObject({
			kind: "continue",
			to: "openai-codex/gpt-5.6-terra",
		});
	});

	it("does nothing when projected context has no messages", async () => {
		const { recovery, env } = harness({ anthropic: blocked });
		const event = settle(quotaError(SONNET));
		event.context.contextEntries = [
			{
				sourceEntry: { id: "empty", type: "message", message: {} } as ProjectedSessionEntry["sourceEntry"],
				messages: [],
			},
		];
		expect(await recovery.handle(event, PROFILE, env, undefined)).toEqual({ kind: "none" });
	});

	it("ignores successful endings, non-quota errors, and models outside the chain", async () => {
		const { recovery, env } = harness({ anthropic: blocked });
		const ok = entry("a1", { role: "assistant", provider: "anthropic", model: SONNET.id, stopReason: "stop" });
		const other = quotaError({ provider: "anthropic", id: "claude-haiku-4-5" });
		for (const tail of [ok, quotaError(SONNET, "overloaded_error"), other]) {
			expect(await recovery.handle(settle(tail), PROFILE, env, undefined)).toEqual({ kind: "none" });
		}
	});

	it("recovers each chain model at most once per user prompt", async () => {
		const { recovery, env } = harness({ anthropic: blocked });
		expect((await recovery.handle(settle(quotaError(SONNET)), PROFILE, env, undefined)).kind).toBe("continue");
		expect((await recovery.handle(settle(quotaError(SONNET)), PROFILE, env, undefined)).kind).toBe("none");
		recovery.resetTurn();
		expect((await recovery.handle(settle(quotaError(SONNET)), PROFILE, env, undefined)).kind).toBe("continue");
	});

	it("reports exhaustion with the earliest reset when the last chain model runs out", async () => {
		const { recovery, env } = harness({ anthropic: blocked, "openai-codex": { ...blocked, resetAt: T0 + 30_000 } });
		expect((await recovery.handle(settle(quotaError(SONNET)), PROFILE, env, undefined)).kind).toBe("continue");
		const outcome = await recovery.handle(settle(quotaError(TERRA)), PROFILE, env, undefined);
		expect(outcome).toMatchObject({ kind: "exhausted", error: { resetAt: T0 + 30_000 } });
	});
});
