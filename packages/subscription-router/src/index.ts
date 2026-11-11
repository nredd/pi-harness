/**
 * pi-subscription-router: `router/<profile>` virtual models that route across
 * included subscription quota.
 *
 * Wiring only; the logic lives in `router.ts` (chain routing), `recovery.ts`
 * (mid-run terminal quota errors), `exhaustion.ts` (confirmed blocks) and
 * `usage.ts` (collectors). Usage and exhaustion state are process-global so
 * every session in the process, including in-process subagent children that
 * load their own copy of this module, sees the same confirmed blocks.
 */

import {
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type ChainEntry,
	type ConfigResult,
	loadConfig,
	type Profile,
	ROUTER_PROVIDER,
	THINKING_LEVELS,
} from "./config.js";
import { ExhaustionTracker } from "./exhaustion.js";
import { refKey } from "./model-ref.js";
import { compilePolicy } from "./policy.js";
import { SettleRecovery } from "./recovery.js";
import { formatDecision, type RouteDecision, type RouteEnv, Router } from "./router.js";
import { formatScore } from "./selection.js";
import { COLLECTED_PROVIDERS, type RegistryContext, UsageService } from "./usage.js";

const SHARED_KEY: unique symbol = Symbol.for("pi-subscription-router.shared");
const DECISIONS_KEY: unique symbol = Symbol.for("pi-subscription-router.decisions");
const RPC_ADMIT = "router:rpc:admit";
const RPC_USAGE = "router:rpc:usage";
const PROMPT_SECTION = "subscription_usage";
const USAGE_GUIDANCE =
	"- Treat usage as decision support. Prefer cheaper models for bounded reconnaissance when capacity is low.";
const USAGE_TOOL_GUIDANCE =
	"- Before subagent fan-out, check current quota with subscription_usage when available; if deferred, discover it with the available tool-search facility first.";
/** Custom session entry type carrying one `RouteDecision`. */
const DECISION_ENTRY = "router:decision";
/** Decisions kept in memory for `/router status`; the session entries are the full record. */
const RECENT_DECISIONS = 5;

/** The usage cache surface consumed by the extension, including routing decisions. */
export type RouterUsage = Pick<UsageService, "get" | "peek" | "decisionFor" | "format" | "formatForPrompt">;

/** Explicit dependencies isolate embedded sessions from process-global quota and credentials. */
export interface SubscriptionRouterOptions {
	config: ConfigResult;
	usage: RouterUsage;
	tracker?: ExhaustionTracker;
	now?: () => number;
}

interface Shared {
	usage: RouterUsage;
	tracker: ExhaustionTracker;
}

/** Decisions of one requesting session, for `/router status` and persistence de-duplication. */
interface SessionDecisions {
	recent: RouteDecision[];
	persisted: Map<string, string>;
}

/** What a core with request-owned routing passes to `route` instead of the registrant's context. */
interface RequesterContext {
	session?: Pick<ExtensionContext, "sessionManager">;
	appendEntry?: (customType: string, data: unknown) => void;
}

/**
 * Weak session-owned diagnostics shared across disk-loaded copies of this extension, never a
 * model registry. Copies in sibling sessions then agree on what each requester has persisted.
 */
function sessionDecisions(manager: object | undefined): SessionDecisions {
	// A host context without a session manager has no durable owner to key diagnostics on.
	if (!manager) return { recent: [], persisted: new Map() };
	const host = globalThis as typeof globalThis & { [DECISIONS_KEY]?: WeakMap<object, SessionDecisions> };
	host[DECISIONS_KEY] ??= new WeakMap();
	let state = host[DECISIONS_KEY].get(manager);
	if (!state) {
		state = { recent: [], persisted: new Map() };
		host[DECISIONS_KEY].set(manager, state);
	}
	return state;
}

function shared(): Shared {
	const host = globalThis as typeof globalThis & { [SHARED_KEY]?: Shared };
	host[SHARED_KEY] ??= { usage: new UsageService(), tracker: new ExhaustionTracker() };
	return host[SHARED_KEY];
}

/** `RouteEnv` backed by the model registry and the shared usage cache. */
function routeEnv(ctx: RegistryContext, usage: RouterUsage): RouteEnv {
	return {
		resolve: (entry: ChainEntry) => {
			const model = ctx.modelRegistry.find(entry.provider, entry.id);
			return model && ctx.modelRegistry.hasConfiguredAuth(model) ? model : undefined;
		},
		refresh: async (model, signal, notBefore) => {
			const snapshot = await usage.get(ctx, model.provider, { fresh: true, notBefore, signal });
			return snapshot.status === "available" && snapshot.retrievedAt >= notBefore
				? usage.decisionFor(model, snapshot)
				: undefined;
		},
	};
}

/** Collected providers relevant to this session: chains, scoped models and the selection. */
function sessionProviders(ctx: ExtensionContext, profiles: readonly Profile[]): string[] {
	const providers = new Set<string>(profiles.flatMap((profile) => profile.chain.map((entry) => entry.provider)));
	for (const { model } of ctx.scopedModels) providers.add(model.provider);
	if (ctx.model) providers.add(ctx.model.provider);
	return [...providers].filter((provider) => COLLECTED_PROVIDERS.includes(provider));
}

/** Name the usage tool only when this session can call it or discover it through tool search. */
function usageGuidance(selectedTools: readonly string[]): string[] {
	const reachable = selectedTools.includes("subscription_usage") || selectedTools.includes("search_tools");
	return reachable ? [USAGE_GUIDANCE, USAGE_TOOL_GUIDANCE] : [USAGE_GUIDANCE];
}

/** Warm cold usage caches in the background; never awaited on the hot path. */
function warm(ctx: ExtensionContext, usage: RouterUsage, providers: readonly string[]): void {
	for (const provider of providers) {
		if (usage.peek(provider)?.status !== "available") void usage.get(ctx, provider);
	}
}

/** Reply on `${channel}:reply:${requestId}` with the pi-subagents RPC envelope. */
function handleRpc(
	pi: ExtensionAPI,
	channel: string,
	fn: (params: Record<string, unknown>) => unknown | Promise<unknown>,
): void {
	pi.events.on(channel, async (raw) => {
		const params = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
		const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
		if (!requestId) return;
		try {
			pi.events.emit(`${channel}:reply:${requestId}`, { success: true, data: await fn(params) });
		} catch (error) {
			pi.events.emit(`${channel}:reply:${requestId}`, {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
}

/** Create an isolated router when dependencies are explicit; otherwise share state across real children. */
export function createSubscriptionRouter(options?: SubscriptionRouterOptions): ExtensionFactory {
	return async (pi: ExtensionAPI): Promise<void> => {
		const now = options?.now ?? Date.now;
		const { usage, tracker } = options
			? { usage: options.usage, tracker: options.tracker ?? new ExhaustionTracker(now) }
			: shared();
		const registrantState: SessionDecisions = { recent: [], persisted: new Map() };
		/**
		 * Remember a decision for `/router status` and append it to the session log unless the profile
		 * already persisted that pick. Session entries are never pruned, so this slows growth but is
		 * not a bound (flapping appends).
		 */
		const log = (
			stateOf: () => SessionDecisions,
			append: (type: string, data: RouteDecision) => void,
			decision: RouteDecision,
		): void => {
			// Logging must never fail a route, including a stale requester whose state lookup throws.
			try {
				const state = stateOf();
				state.recent.push(decision);
				if (state.recent.length > RECENT_DECISIONS) state.recent.shift();
				if (state.persisted.get(decision.profile) === decision.chosen) return;
				state.persisted.set(decision.profile, decision.chosen);
				append(DECISION_ENTRY, decision);
			} catch {}
		};
		/** Older cores and raw runtime calls: the registrant logs, as before. */
		const record = (decision: RouteDecision): void =>
			log(
				() => registrantState,
				(type, data) => pi.appendEntry(type, data),
				decision,
			);
		/** Cores with request-owned routing log to the requester, never to a possibly disposed registrant. */
		const recordFor = (requester: Required<RequesterContext>, decision: RouteDecision): void =>
			log(() => sessionDecisions(requester.session.sessionManager), requester.appendEntry, decision);
		const router = new Router(usage, tracker, now, record);
		const recovery = new SettleRecovery(router);
		const config = options?.config ?? (await loadConfig(getAgentDir()));
		const profiles = config.ok ? config.profiles : [];
		const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
		/**
		 * Child sessions share their parent's model runtime and each re-registers `router/*` into it,
		 * so a registered route can outlive this session and serve its siblings and parent. Its
		 * extension ctx dies with this session; the registry fronts the shared runtime and does not.
		 */
		let registry: RegistryContext | undefined;

		/** The router profile behind the current selection, if it is one of ours. */
		const selectedProfile = (ctx: ExtensionContext): Profile | undefined =>
			ctx.model?.provider === ROUTER_PROVIDER ? profileById.get(ctx.model.id) : undefined;

		for (const profile of profiles) {
			compilePolicy(profile);
			pi.registerVirtualModel({
				provider: ROUTER_PROVIDER,
				id: profile.id,
				name: profile.name,
				thinkingLevels: THINKING_LEVELS,
				route: (request, ctx) => {
					const { session, appendEntry } = ctx as RequesterContext;
					// `in`, not a read: a stale session's `sessionManager` getter throws. A partial host without one has no owner to key on.
					if (!session || !appendEntry || !("sessionManager" in session)) {
						// Registrant context: `ctx` only serves the gap before session_start, when this session cannot have been disposed.
						return router.route(profile, request, routeEnv(registry ?? ctx, usage));
					}
					const requester = { session, appendEntry };
					// Only logging belongs to the requester; its route ctx getters can be stale, the registrant's registry is not.
					return router.route(profile, request, routeEnv(registry ?? ctx, usage), (decision) =>
						recordFor(requester, decision),
					);
				},
			});
		}

		pi.on("session_start", (_event, ctx) => {
			registry = { modelRegistry: ctx.modelRegistry };
			// A new or resumed session has no durable decision yet; its first pick must persist.
			registrantState.persisted.clear();
			sessionDecisions(ctx.sessionManager).persisted.clear();
			if (!config.ok) ctx.ui.notify(`subscription-router: ignoring config. ${config.error}`, "error");
			warm(ctx, usage, sessionProviders(ctx, profiles));
		});

		// Cached data only: a slow usage endpoint must not delay the turn. Coarse
		// buckets keep the section stable so the prompt-cache prefix survives.
		pi.on("before_agent_start", (event, ctx) => {
			recovery.resetTurn();
			const providers = sessionProviders(ctx, profiles);
			warm(ctx, usage, providers);
			if (providers.length === 0) return;
			const lines = providers.map((provider) => `- ${provider}: ${usage.formatForPrompt(usage.peek(provider))}`);
			event.systemPromptOptions.sections[PROMPT_SECTION] = [
				...lines,
				...usageGuidance(event.systemPromptOptions.selectedTools),
			].join("\n");
		});

		pi.on("agent_before_settle", async (event, ctx) => {
			const profile = selectedProfile(ctx);
			if (!profile) return undefined;
			const outcome = await recovery.handle(event, profile, routeEnv(ctx, usage), ctx.signal);
			if (outcome.kind === "exhausted") {
				ctx.ui.notify(outcome.error.message, "error");
				return undefined;
			}
			if (outcome.kind !== "continue") return undefined;
			ctx.ui.notify(`subscription-router: ${outcome.from} is out of quota, continuing on ${outcome.to}`, "warning");
			return outcome.result;
		});

		pi.registerTool({
			name: "subscription_usage",
			label: "Subscription Usage",
			description:
				"Inspect subscription quota windows and the router's confirmed exhaustion blocks. Exhausted families are skipped by router/* models until they reset.",
			promptSnippet: "Inspect subscription quota before expensive subagent fan-out",
			parameters: Type.Object({
				provider: Type.Optional(Type.String({ description: "Provider to inspect. Omit for every relevant provider." })),
				refresh: Type.Optional(Type.Boolean({ description: "Request a live refresh. Limited to once per minute." })),
			}),
			async execute(_id, params, signal, _update, ctx) {
				const providers = params.provider ? [params.provider] : sessionProviders(ctx, profiles);
				const snapshots = await Promise.all(
					providers.map((provider) => usage.get(ctx, provider, { force: params.refresh, signal })),
				);
				const lines = snapshots.map((snapshot) => `${snapshot.provider}: ${usage.format(snapshot)}`);
				for (const mark of tracker.active()) {
					const scope = mark.families ? `${mark.provider} ${mark.families.join(",")}` : mark.provider;
					lines.push(`blocked ${scope}: ${mark.window} until ${new Date(mark.until).toISOString()}`);
				}
				return {
					content: [{ type: "text", text: lines.join("\n") || "No subscription providers in use." }],
					details: { snapshots, blocks: tracker.active() },
				};
			},
		});

		pi.registerCommand("router", {
			description:
				"Subscription router: status (default), explain <profile> [--json], refresh, or reset confirmed blocks",
			handler: async (args, ctx) => {
				const action = args.trim() || "status";
				if (action.split(/\s+/)[0] === "explain") {
					const [, id, ...flags] = action.split(/\s+/);
					if (!id || flags.length > 1 || (flags.length === 1 && flags[0] !== "--json")) {
						ctx.ui.notify("subscription-router: expected explain <profile> [--json]", "error");
						return;
					}
					const profile = profileById.get(id);
					if (!profile) {
						ctx.ui.notify(`subscription-router: unknown profile '${id}'`, "error");
						return;
					}
					const evaluation = router.explain(profile, routeEnv(ctx, usage));
					const json = JSON.stringify(evaluation, null, 2);
					ctx.ui.notify(
						flags.length
							? json
							: `Cached fresh-dispatch forecast router/${id} -> ${evaluation.chosen ?? "exhausted"}\n${json}`,
						"info",
					);
					return;
				}
				if (action === "reset") {
					tracker.clear();
					ctx.ui.notify("subscription-router: cleared confirmed blocks", "info");
					return;
				}
				if (action !== "status" && action !== "refresh") {
					ctx.ui.notify(`subscription-router: unknown action "${action}" (status, refresh, reset)`, "error");
					return;
				}
				const providers = sessionProviders(ctx, profiles);
				const snapshots =
					action === "refresh"
						? await Promise.all(providers.map((provider) => usage.get(ctx, provider, { force: true })))
						: providers.flatMap((provider) => {
								const snapshot = usage.peek(provider);
								return snapshot ? [snapshot] : [];
							});
				const env = routeEnv(ctx, usage);
				const lines = snapshots.map((snapshot) => `${snapshot.provider}: ${usage.format(snapshot)}`);
				for (const profile of profiles) {
					const picked = router.pick(profile, env);
					lines.push(
						`router/${profile.id} (${profile.policy?.kind ?? profile.strategy ?? "ordered"}) -> ${picked.ok ? refKey(picked.entry) : "exhausted"}`,
					);
					if (picked.ok) {
						for (const candidate of picked.candidates)
							lines.push(`  ${refKey(candidate.entry)}: ${formatScore(candidate.score)}`);
					}
					for (const block of picked.blocked) lines.push(`  ${refKey(block.entry)}: ${block.reason}`);
				}
				const own = sessionDecisions(ctx.sessionManager).recent;
				const decisions = own.length > 0 ? own : registrantState.recent;
				if (decisions.length > 0) {
					lines.push("last decisions (newest last):", ...decisions.map(formatDecision));
				}
				ctx.ui.notify(lines.join("\n"), "info");
			},
		});

		// `{ model: "provider/id" }` -> `Admission`. Before the first session_start
		// there is no context to read usage through, so everything is admitted.
		handleRpc(pi, RPC_ADMIT, (params) => {
			const ctx = registry;
			const ref = typeof params.model === "string" ? params.model : "";
			return ctx ? router.admit(ref, profileById, routeEnv(ctx, usage)) : { ok: true };
		});

		handleRpc(pi, RPC_USAGE, async (params) => {
			const ctx = registry;
			if (params.refresh === true && ctx) {
				await Promise.all(COLLECTED_PROVIDERS.map((provider) => usage.get(ctx, provider)));
			}
			return {
				snapshots: COLLECTED_PROVIDERS.flatMap((provider) => {
					const snapshot = usage.peek(provider);
					return snapshot ? [snapshot] : [];
				}),
				blocks: tracker.active(),
			};
		});
	};
}

export default createSubscriptionRouter();
