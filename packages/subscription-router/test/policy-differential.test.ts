/** Fixed-seed differential property against a byte-pinned, independent merge-base implementation. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Api, fauxAssistantMessage, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import type { ChainEntry, Profile } from "../src/config.js";
import { ExhaustionTracker } from "../src/exhaustion.js";
import { type ModelRef, refKey } from "../src/model-ref.js";
import { formatDecision, type PickResult, type RouteDecision, type RouteEnv, Router } from "../src/router.js";
import { type QuotaScore, selectCandidate } from "../src/selection.js";
import { type UsageDecision, UsageService, type UsageSnapshot, type UsageWindow } from "../src/usage.js";
import { ExhaustionTracker as LegacyTracker } from "./legacy-oracle/exhaustion.js";
import {
	type RouteDecision as LegacyDecision,
	Router as LegacyRouter,
	formatDecision as legacyFormatDecision,
} from "./legacy-oracle/router.js";
import { selectCandidate as legacySelectCandidate } from "./legacy-oracle/selection.js";
import { UsageService as LegacyUsage } from "./legacy-oracle/usage.js";

const BASE = "1e93038cffd4d2ca92ffd7bc8edeeebce389890d";
const SEED = 0x741c0de;
const CASES = 4096;
const NOW = 1_800_000_000_000;
const ORACLE_BLOBS = {
	config: "2cf08201e3a535b3068e005764640fb1c511f0e4",
	exhaustion: "361b7367b78d06b231eaebc3401ffea22512a7c6",
	"model-ref": "e3aed68269d1ebe65d15fda75ae3a4836f0af01d",
	router: "1246a5018362f5d0fe64c2b3f3f8a02c11756c1a",
	selection: "5e6b82bce3d04f7634a961d0ab5b7449884d4246",
	usage: "abfe3898a5be6125279f84c558953200d235980f",
};

/** Mulberry32's fixed integer operations make the seed reproducible across Node and Bun. */
class Generator {
	private state = SEED;
	next(): number {
		this.state += 0x6d2b79f5;
		let value = this.state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	}
	integer(max: number): number {
		return Math.floor(this.next() * max);
	}
	choose<T>(values: readonly T[]): T {
		if (!values.length) throw new Error("empty generator domain");
		return values[this.integer(values.length)] as T;
	}
}

interface Input {
	profile: Profile;
	snapshots: Record<string, UsageSnapshot>;
	marks: { ref: ModelRef; decision: UsageDecision; repeats: number }[];
	unavailable: string[];
	incumbent?: ModelRef;
	reason: ModelRouteRequest["reason"];
	failed: ModelRef;
	error: string;
	partial: "none" | "text" | "thinking" | "toolCall";
	confirmation?: UsageDecision;
	preCancelled: boolean;
	cancelConfirmation: boolean;
}

/** Mix continuous operands with exact timing, utilization, grace and floating-point boundaries. */
function window(random: Generator, index: number): UsageWindow {
	return {
		name: `window-${index}`,
		scope: random.choose(["provider", "model"]),
		families: random.choose([undefined, ["sonnet"], ["opus"], ["terra"], ["other"], ["sonnet", "opus"]]),
		usedPercent: random.choose([
			random.next() * 110,
			0,
			50,
			40,
			39.999999,
			40.000001,
			99.99,
			99.988,
			99.9999999999999,
			100,
			101,
			-1,
			NaN,
			Infinity,
		]),
		resetAt: random.choose([undefined, NOW - 1, NOW, NOW + 1, NOW + 60_000, NOW + 3_600_000, NOW + 604_800_000]),
		durationMs: random.choose([undefined, 0, -1, NaN, Infinity, 60_000, 3_600_000, 604_800_000]),
	};
}

/** Unique physical refs include shared providers and overlapping family/provider windows. */
function input(random: Generator): Input {
	const chain: ChainEntry[] = [
		{ provider: "a", id: "sonnet" },
		{ provider: "a", id: "opus" },
		{ provider: "b", id: "terra" },
		{ provider: "c", id: "other" },
		{ provider: "b", id: "sonnet" },
		{ provider: "d", id: "opus" },
	].map((entry) => ({
		...entry,
		thinking: random.choose<ModelThinkingLevel | undefined>([undefined, "off", "low", "high", "max"]),
	}));
	for (let index = chain.length - 1; index > 0; index--) {
		const other = random.integer(index + 1);
		const entry = chain[index] as ChainEntry;
		chain[index] = chain[other] as ChainEntry;
		chain[other] = entry;
	}
	chain.length = 2 + random.integer(5);
	const snapshots: Record<string, UsageSnapshot> = {};
	for (const provider of new Set(chain.map((entry) => entry.provider))) {
		if (random.integer(6) === 0) continue;
		snapshots[provider] = {
			provider,
			status: random.choose(["available", "available", "stale", "error", "unavailable"]),
			retrievedAt: NOW - random.choose([-1000, 0, 300_000, 899_999, 900_000, 900_001, 3_600_000]),
			expiresAt: NOW + random.choose([-1, 0, 1, 300_000]),
			windows: Array.from({ length: random.integer(6) }, (_, index) => window(random, index)),
			credits: random.integer(4) === 0 ? { available: true, unlimited: random.integer(2) === 0 } : undefined,
		};
	}
	const marks = chain
		.filter(() => random.integer(5) === 0)
		.map((entry) => ({
			ref: entry,
			repeats: 1 + random.integer(3),
			decision: {
				block: true,
				window: "confirmed",
				scope: random.choose(["provider", "model"] as const),
				families: random.choose([undefined, [entry.id], ["other"]]),
				resetAt: random.choose([undefined, NOW - 1, NOW, NOW + 1, NOW + 3_600_000]),
			},
		}));
	return {
		profile: {
			id: "property",
			name: "Seeded property",
			chain,
			strategy: random.choose([undefined, "ordered", "balanced"]),
			exhaustion: random.choose([
				undefined,
				{ policy: "wait" },
				{ policy: "fail" },
				{ policy: "wait", maxWaitMs: 60_000 },
			]),
		},
		snapshots,
		marks,
		unavailable: chain.filter(() => random.integer(5) === 0).map(refKey),
		incumbent: random.choose([...chain, undefined, { provider: "outside", id: "foreign" }]),
		reason: random.choose(["user", "direct", "continuation", "retry"]),
		failed: random.choose([...chain, { provider: "outside", id: "foreign" }]),
		error: random.choose(["429", "insufficient_quota", "overloaded", "billing limit", "cancelled"]),
		partial: random.choose(["none", "none", "text", "thinking", "toolCall"]),
		confirmation: random.choose([
			undefined,
			{ block: false },
			{ block: true, window: "live", scope: "provider", resetAt: NOW + 60_000 },
			{ block: true, window: "live-family", scope: "model", families: ["sonnet"] },
		]),
		preCancelled: random.integer(30) === 0,
		cancelConfirmation: random.integer(8) === 0,
	};
}

/** Independent copies isolate mutable tracker/cache/abort state and record dependency call ordering. */
function pair(state: Input) {
	const now = () => NOW;
	const currentTracker = new ExhaustionTracker(now);
	const oracleTracker = new LegacyTracker(now);
	for (const mark of state.marks)
		for (let index = 0; index < mark.repeats; index++) {
			currentTracker.mark(mark.ref, mark.decision);
			oracleTracker.mark(mark.ref, mark.decision);
		}
	const transport = {
		now,
		fetch: async (): Promise<Response> => {
			throw new Error("differential property must not fetch");
		},
		getAccessToken: async () => {
			throw new Error("differential property must not authenticate");
		},
	};
	const currentUsage = new UsageService(transport);
	const oracleUsage = new LegacyUsage(transport);
	const currentCalls: string[] = [];
	const oracleCalls: string[] = [];
	const currentDecisions: RouteDecision[] = [];
	const oracleDecisions: LegacyDecision[] = [];
	const currentSnapshots = structuredClone(state.snapshots);
	const oracleSnapshots = structuredClone(state.snapshots);
	const decider = (usage: UsageService | LegacyUsage, snapshots: Input["snapshots"], calls: string[]) => ({
		decisionFor: (ref: ModelRef) => {
			calls.push(`decision ${refKey(ref)}`);
			return usage.decisionFor(ref, snapshots[ref.provider]);
		},
		peek: (provider: string) => {
			calls.push(`peek ${provider}`);
			return snapshots[provider];
		},
	});
	const controller = (): AbortController => {
		const value = new AbortController();
		if (state.preCancelled) value.abort(new Error("synthetic cancellation"));
		return value;
	};
	const currentAbort = controller();
	const oracleAbort = controller();
	const model = (ref: ModelRef): Model<Api> => ({ ...ref, api: "test" }) as unknown as Model<Api>;
	const env = (calls: string[], abort: AbortController): RouteEnv => ({
		resolve: (entry) => {
			calls.push(`resolve ${refKey(entry)}`);
			return state.unavailable.includes(refKey(entry)) ? undefined : model(entry);
		},
		refresh: async (ref, signal, notBefore) => {
			calls.push(`refresh ${refKey(ref)} ${notBefore} ${signal?.aborted}`);
			if (state.cancelConfirmation) abort.abort(new Error("synthetic cancellation"));
			return state.confirmation;
		},
	});
	const request = (abort: AbortController): ModelRouteRequest => ({
		model: model({ provider: "router", id: state.profile.id }),
		reason: state.reason,
		thinkingLevel: "medium",
		messages: [],
		signal: abort.signal,
		previous: state.incumbent ? { model: model(state.incumbent), thinkingLevel: "low" } : undefined,
		failed: {
			model: model(state.failed),
			message: fauxAssistantMessage(
				state.partial === "none"
					? []
					: state.partial === "text"
						? "partial"
						: state.partial === "thinking"
							? [{ type: "thinking", thinking: "partial" }]
							: [{ type: "toolCall", id: "tool-1", name: "example", arguments: {} }],
				{ stopReason: "error", errorMessage: state.error, timestamp: NOW },
			),
		},
	});
	return {
		current: new Router(decider(currentUsage, currentSnapshots, currentCalls), currentTracker, now, (decision) =>
			currentDecisions.push(decision),
		),
		oracle: new LegacyRouter(decider(oracleUsage, oracleSnapshots, oracleCalls), oracleTracker, now, (decision) =>
			oracleDecisions.push(decision),
		),
		currentEnv: env(currentCalls, currentAbort),
		oracleEnv: env(oracleCalls, oracleAbort),
		currentRequest: request(currentAbort),
		oracleRequest: request(oracleAbort),
		currentCalls,
		oracleCalls,
		currentDecisions,
		oracleDecisions,
		currentTracker,
		oracleTracker,
	};
}

/** The added opt-in explanation is not part of the legacy pick result contract. */
function legacyPick(picked: PickResult) {
	const { evaluation, ...legacy } = picked;
	void evaluation;
	return legacy;
}

/** Capture the entire public error payload, without relying on cross-implementation instanceof. */
async function outcome(call: () => Promise<unknown>) {
	try {
		return { ok: true, value: await call() };
	} catch (error) {
		const failure = error as Error & { profile?: string; blocked?: unknown; resetAt?: number };
		return {
			ok: false,
			name: failure.name,
			message: failure.message,
			profile: failure.profile,
			blocked: failure.blocked,
			resetAt: failure.resetAt,
		};
	}
}

it("pins verbatim merge-base oracle Git blobs", () => {
	for (const [name, blob] of Object.entries(ORACLE_BLOBS)) {
		const source = readFileSync(new URL(`./legacy-oracle/${name}.ts`, import.meta.url));
		expect(
			createHash("sha1").update(`blob ${source.length}\0`).update(source).digest("hex"),
			`${BASE}:${name}.ts`,
		).toBe(blob);
	}
});

it("legacy differential property: 4096 random states, fixed seed 0x741c0de", async () => {
	const random = new Generator();
	let mixedKnowledge = 0;
	let nonBestIncumbents = 0;
	const reasons = new Set<string>();
	const strategies = new Set<string>();
	for (let index = 0; index < CASES; index++) {
		const state = input(random);
		const before = structuredClone(state);
		const h = pair(state);
		const label = `seed=0x${SEED.toString(16)} case=${index}`;
		reasons.add(state.reason);
		strategies.add(state.profile.strategy ?? "omitted");
		const best = h.oracle.pick(state.profile, h.oracleEnv);
		if (best.ok && new Set(best.candidates.map((candidate) => candidate.score.kind)).size > 1) mixedKnowledge++;
		if (state.profile.strategy === "balanced" && best.ok && state.incumbent) {
			const incumbentKey = refKey(state.incumbent);
			const incumbentScore = best.candidates.find((candidate) => refKey(candidate.entry) === incumbentKey)?.score;
			const bestScore = best.candidates.find((candidate) => refKey(candidate.entry) === refKey(best.entry))?.score;
			// Require strictly better quota knowledge/value, not merely an earlier chain-order tie.
			if (incumbentScore && bestScore && legacySelectCandidate([incumbentScore, bestScore], "balanced") === 1)
				nonBestIncumbents++;
		}
		h.oracleCalls.length = 0;
		expect(legacyPick(h.current.pick(state.profile, h.currentEnv, state.incumbent)), label).toEqual(
			h.oracle.pick(state.profile, h.oracleEnv, state.incumbent),
		);
		expect(h.currentCalls, label).toEqual(h.oracleCalls);
		const profiles = new Map([[state.profile.id, state.profile]]);
		for (const ref of [`router/${state.profile.id}`, refKey(state.failed), "router/unknown", "malformed"])
			expect(h.current.admit(ref, profiles, h.currentEnv), label).toEqual(h.oracle.admit(ref, profiles, h.oracleEnv));
		expect(await outcome(() => h.current.route(state.profile, h.currentRequest, h.currentEnv)), label).toEqual(
			await outcome(() => h.oracle.route(state.profile, h.oracleRequest, h.oracleEnv)),
		);
		expect(h.currentDecisions, label).toEqual(h.oracleDecisions);
		expect(JSON.stringify(h.currentDecisions), label).toBe(JSON.stringify(h.oracleDecisions));
		expect(h.currentDecisions.map(formatDecision), label).toEqual(h.oracleDecisions.map(legacyFormatDecision));
		expect(h.current.admit(`router/${state.profile.id}`, profiles, h.currentEnv), label).toEqual(
			h.oracle.admit(`router/${state.profile.id}`, profiles, h.oracleEnv),
		);
		expect(h.currentTracker.active(), label).toEqual(h.oracleTracker.active());
		expect(h.currentCalls, label).toEqual(h.oracleCalls);
		expect(state, label).toEqual(before);
		const scores: QuotaScore[] = Array.from({ length: random.integer(8) }, () =>
			random.choose<QuotaScore>([
				{ kind: "unlimited" },
				{ kind: "fallback", reason: "synthetic unknown" },
				{
					kind: "measured",
					window: "synthetic",
					score: random.choose([0, 1e-20, 1.2e-20, random.next() * 20]),
					roundoff: random.choose([undefined, 4 * Number.EPSILON, 80 * Number.EPSILON]),
				},
			]),
		);
		const incumbent = random.choose([undefined, -1, random.integer(8)]);
		expect(selectCandidate(scores, state.profile.strategy, incumbent), label).toBe(
			legacySelectCandidate(scores, state.profile.strategy, incumbent),
		);
	}
	expect(mixedKnowledge).toBeGreaterThan(100);
	expect(nonBestIncumbents).toBeGreaterThan(100);
	expect([...reasons].sort()).toEqual(["continuation", "direct", "retry", "user"]);
	expect([...strategies].sort()).toEqual(["balanced", "omitted", "ordered"]);
}, 30_000);
