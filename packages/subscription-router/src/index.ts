/**
 * pi-subscription-router: `router/<profile>` virtual models that route across
 * included subscription quota.
 *
 * Wiring only; the logic lives in `router.ts` (chain routing), `recovery.ts`
 * (mid-run terminal quota errors), `evidence.ts` (what confirms a block),
 * `exhaustion.ts` (confirmed blocks) and `usage.ts` (collectors). Usage and exhaustion state are process-global so
 * every session in the process, including in-process subagent children that
 * load their own copy of this module, sees the same confirmed blocks.
 */

import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { showCodexResets } from "./codex-reset-command.ts";
import { CodexResets } from "./codex-resets.ts";
import { collectedProviders, collectorFor } from "./collectors.ts";
import {
	type ChainEntry,
	type ConfigResult,
	loadConfig,
	type Profile,
	type ProviderConfig,
	ROUTER_PROVIDER,
	THINKING_LEVELS,
} from "./config.ts";
import { confirmEvidence, FailureHistory, type UsageRead } from "./evidence.ts";
import { ExhaustionTracker } from "./exhaustion.ts";
import { refKey } from "./model-ref.ts";
import { compilePolicy } from "./policy.ts";
import { SettleRecovery } from "./recovery.ts";
import { ResetView, refreshSchedules } from "./reset-view.ts";
import { formatResets } from "./resets.ts";
import { formatDecision, type RouteDecision, type RouteEnv, Router } from "./router.ts";
import { formatScore } from "./selection.ts";
import { collectorIdFor, type RegistryContext, UsageService } from "./usage.ts";

export {
	type Collector,
	type CollectorHandle,
	type CollectorReading,
	collectedProviders,
	collectorFor,
	registerCollector,
} from "./collectors.ts";

const SHARED_KEY: unique symbol = Symbol.for("pi-subscription-router.shared");
const DECISIONS_KEY: unique symbol = Symbol.for("pi-subscription-router.decisions");
const SELECTIONS_KEY: unique symbol = Symbol.for("pi-subscription-router.selections");
const FAILURES_KEY: unique symbol = Symbol.for("pi-subscription-router.failures");

/**
 * Failure counts belong to the marks they can create: every router sharing a tracker, including
 * disk-loaded copies in in-process children, counts one model's failures together.
 */
function failureHistory(tracker: ExhaustionTracker): FailureHistory {
	const host = globalThis as typeof globalThis & { [FAILURES_KEY]?: WeakMap<ExhaustionTracker, FailureHistory> };
	host[FAILURES_KEY] ??= new WeakMap();
	let history = host[FAILURES_KEY].get(tracker);
	if (!history) {
		history = new FailureHistory();
		host[FAILURES_KEY].set(tracker, history);
	}
	return history;
}

/** Selection epochs belong to the requester, even when a sibling registered its route. */
function selectionEpoch(manager: object | undefined): { generation: number } {
	// Partial legacy hosts have no session identity, just like sessionDecisions below.
	if (!manager) return { generation: 0 };
	const host = globalThis as typeof globalThis & { [SELECTIONS_KEY]?: WeakMap<object, { generation: number }> };
	host[SELECTIONS_KEY] ??= new WeakMap();
	let epoch = host[SELECTIONS_KEY].get(manager);
	if (!epoch) {
		epoch = { generation: 0 };
		host[SELECTIONS_KEY].set(manager, epoch);
	}
	return epoch;
}

/** Capture before awaiting evidence. Physical response metadata never changes this epoch. */
function captureSelection(ctx: ExtensionContext, signal: AbortSignal | undefined): () => boolean {
	const manager = ctx.sessionManager;
	const epoch = selectionEpoch(manager);
	const generation = epoch.generation;
	// A runtime may serve a requester that never loaded this extension. Its durable
	// model-change identity still detects manual pins and ABA without an event listener.
	const selectionId = () =>
		manager
			?.getBranch?.()
			.filter((entry) => entry.type === "model_change")
			.at(-1)?.id;
	const selected = selectionId();
	return () => {
		if (signal?.aborted || epoch.generation !== generation) return false;
		try {
			return selectionId() === selected;
		} catch {
			// A retained manager view can become stale during session replacement.
			return false;
		}
	};
}
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
export type RouterUsage = Pick<UsageService, "get" | "peek" | "decisionFor" | "format" | "formatForPrompt"> &
	Partial<Pick<UsageService, "invalidate" | "configureCollectors">>;

/** Explicit dependencies isolate embedded sessions from process-global quota and credentials. */
export interface SubscriptionRouterOptions {
	config: ConfigResult;
	usage: RouterUsage;
	tracker?: ExhaustionTracker;
	now?: () => number;
	codexResets?: Pick<CodexResets, "inspect" | "redeem">;
}

interface Shared {
	usage: RouterUsage;
	tracker: ExhaustionTracker;
	codex?: CodexResets;
}

/** Decisions of one requesting session, for `/router status` and persistence de-duplication. */
interface SessionDecisions {
	recent: RouteDecision[];
	persisted: Map<string, string>;
}

/** What a core with request-owned routing passes to `route` instead of the registrant's context. */
interface RequesterContext {
	session?: ExtensionContext;
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

/** How a failure is confirmed: the shared usage cache and failure counts, per provider declaration. */
interface Confirmation {
	declarations: Readonly<Record<string, ProviderConfig>>;
	history: FailureHistory;
}

/** `RouteEnv` backed by the model registry, the shared usage cache and each provider's evidence chain. */
function routeEnv(ctx: RegistryContext, usage: RouterUsage, { declarations, history }: Confirmation): RouteEnv {
	const read: UsageRead = {
		get: (provider, options) => usage.get(ctx, provider, options),
		decisionFor: (model, snapshot) => usage.decisionFor(model, snapshot),
	};
	return {
		resolve: (entry: ChainEntry) => {
			const model = ctx.modelRegistry.find(entry.provider, entry.id);
			return model && ctx.modelRegistry.hasConfiguredAuth(model) ? model : undefined;
		},
		refresh: (model, signal, notBefore, failed) => {
			const declared = Object.hasOwn(declarations, model.provider) ? declarations[model.provider] : undefined;
			return confirmEvidence(
				read,
				history,
				declared,
			)({
				model,
				failedAt: notBefore,
				signal,
				message: failed,
			});
		},
	};
}

/** Collected providers relevant to this session: chains, scoped models and the selection. */
function sessionProviders(
	ctx: ExtensionContext,
	profiles: readonly Profile[],
	declarations: Readonly<Record<string, ProviderConfig>>,
): string[] {
	const providers = new Set<string>(profiles.flatMap((profile) => profile.chain.map((entry) => entry.provider)));
	for (const { model } of ctx.scopedModels) providers.add(model.provider);
	if (ctx.model) providers.add(ctx.model.provider);
	return [...providers].filter((provider) => collectorFor(collectorIdFor(provider, declarations)) !== undefined);
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
		const state: Shared = options
			? { usage: options.usage, tracker: options.tracker ?? new ExhaustionTracker(now) }
			: shared();
		const { usage, tracker } = state;
		let codexResets = options?.codexResets;
		if (!codexResets) {
			state.codex ??= new CodexResets({ root: join(getAgentDir(), "router-codex-resets"), usage, tracker, now });
			codexResets = state.codex;
		}
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
		const declarations = (config.ok ? config.providers : undefined) ?? {};
		usage.configureCollectors?.(declarations);
		const history = failureHistory(tracker);
		const confirmation: Confirmation = { declarations, history };
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
				route: async (request, ctx) => {
					const { session, appendEntry } = ctx as RequesterContext;
					// `in`, not a read: a stale session's `sessionManager` getter throws. A partial host without one has no owner to key on.
					if (!session || !appendEntry || !("sessionManager" in session)) {
						// Registrant context: `ctx` only serves the gap before session_start, when this session cannot have been disposed.
						return router.route(profile, request, routeEnv(registry ?? ctx, usage, confirmation));
					}
					const requester = { session, appendEntry };
					const current = request.reason === "retry" ? captureSelection(session, request.signal) : () => true;
					const assertCurrent = (): void => {
						if (!current()) throw new Error("subscription-router: request selection changed or was cancelled");
					};
					// Shared confirmation may finish, but only its original requester can commit a route.
					return router.route(
						profile,
						request,
						{ ...routeEnv(registry ?? ctx, usage, confirmation), assertCurrent },
						(decision) => recordFor(requester, decision),
					);
				},
			});
		}

		pi.on("session_start", (_event, ctx) => {
			selectionEpoch(ctx.sessionManager).generation++;
			registry = { modelRegistry: ctx.modelRegistry };
			// A new or resumed session has no durable decision yet; its first pick must persist.
			registrantState.persisted.clear();
			sessionDecisions(ctx.sessionManager).persisted.clear();
			if (!config.ok) ctx.ui.notify(`subscription-router: ignoring config. ${config.error}`, "error");
			warm(ctx, usage, sessionProviders(ctx, profiles, declarations));
		});

		// Cached data only: a slow usage endpoint must not delay the turn. Coarse
		// buckets keep the section stable so the prompt-cache prefix survives.
		pi.on("before_agent_start", (event, ctx) => {
			recovery.resetTurn();
			const providers = sessionProviders(ctx, profiles, declarations);
			warm(ctx, usage, providers);
			if (providers.length === 0) return;
			const lines = providers.map((provider) => `- ${provider}: ${usage.formatForPrompt(usage.peek(provider))}`);
			event.systemPromptOptions.sections[PROMPT_SECTION] = [
				...lines,
				...usageGuidance(event.systemPromptOptions.selectedTools),
			].join("\n");
		});

		// A success between two ambiguous quota failures means they were not one exhaustion.
		pi.on("message_end", (event) => {
			const { message } = event;
			if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") return;
			history.succeeded({ provider: message.provider, id: message.model }, message.timestamp);
		});

		pi.on("model_select", (_event, ctx) => {
			selectionEpoch(ctx.sessionManager).generation++;
		});
		pi.on("session_shutdown", (_event, ctx) => {
			selectionEpoch(ctx.sessionManager).generation++;
		});

		pi.on("agent_before_settle", async (event, ctx) => {
			const profile = selectedProfile(ctx);
			if (!profile) return undefined;
			const signal = ctx.signal;
			const current = captureSelection(ctx, signal);
			const env = routeEnv(ctx, usage, confirmation);
			// Partial output is marked for the next prompt but never omitted or continued.
			if (await recovery.markPartial(event, profile, env, signal)) return undefined;
			const outcome = await recovery.handle(event, profile, env, signal, current);
			if (!current()) return undefined;
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
				const providers = params.provider ? [params.provider] : sessionProviders(ctx, profiles, declarations);
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
				"Subscription router: status, explain <profile> [--json], resets [refresh|codex], refresh, or reset LOCAL blocks",
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
					const evaluation = router.explain(profile, routeEnv(ctx, usage, confirmation));
					const json = JSON.stringify(evaluation, null, 2);
					ctx.ui.notify(
						flags.length
							? json
							: `Cached fresh-dispatch forecast router/${id} -> ${evaluation.chosen ?? "exhausted"}\n${json}`,
						"info",
					);
					return;
				}
				if (action === "resets codex") {
					await showCodexResets(pi, ctx, codexResets, now);
					return;
				}
				if (action.split(/\s+/)[0] === "resets") {
					if (action !== "resets" && action !== "resets refresh") {
						ctx.ui.notify("subscription-router: expected resets [refresh|codex]", "error");
						return;
					}
					const providers = sessionProviders(ctx, profiles, declarations);
					let refresh = action === "resets refresh";
					do {
						const results = refresh ? await refreshSchedules(ctx, usage, providers) : [];
						const text = formatResets(
							providers,
							(provider) => {
								const result = results.find((snapshot) => snapshot.provider === provider);
								const cached = usage.peek(provider);
								// A cancelled/deadline-limited caller must not erase last-known windows.
								return result && result.windows.length === 0 && cached?.windows.length
									? { ...cached, status: "stale", message: result.message }
									: (result ?? cached);
							},
							now(),
						);
						if (ctx.mode !== "tui") {
							pi.sendMessage({ customType: "router:resets", content: text, display: true }, { triggerTurn: false });
							return;
						}
						refresh = await ctx.ui.custom<boolean>(
							(tui, _theme, _kb, done) =>
								new ResetView(
									text,
									() => tui.terminal.rows,
									() => tui.requestRender(),
									done,
								),
						);
					} while (refresh);
					return;
				}
				if (action === "reset") {
					tracker.clear();
					history.clear();
					ctx.ui.notify("subscription-router: cleared LOCAL confirmed blocks only; provider quota unchanged", "info");
					return;
				}
				if (action !== "status" && action !== "refresh") {
					ctx.ui.notify(
						`subscription-router: unknown action "${action}" (status, resets [refresh|codex], refresh, reset)`,
						"error",
					);
					return;
				}
				const providers = sessionProviders(ctx, profiles, declarations);
				const snapshots =
					action === "refresh"
						? await Promise.all(providers.map((provider) => usage.get(ctx, provider, { force: true })))
						: providers.flatMap((provider) => {
								const snapshot = usage.peek(provider);
								return snapshot ? [snapshot] : [];
							});
				const env = routeEnv(ctx, usage, confirmation);
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
			return ctx ? router.admit(ref, profileById, routeEnv(ctx, usage, confirmation)) : { ok: true };
		});

		const rpcProviders = () => [...new Set([...collectedProviders(), ...Object.keys(declarations)])];
		handleRpc(pi, RPC_USAGE, async (params) => {
			const ctx = registry;
			if (params.refresh === true && ctx) {
				await Promise.all(rpcProviders().map((provider) => usage.get(ctx, provider)));
			}
			return {
				snapshots: rpcProviders().flatMap((provider) => {
					const snapshot = usage.peek(provider);
					return snapshot ? [snapshot] : [];
				}),
				blocks: tracker.active(),
			};
		});
	};
}

export default createSubscriptionRouter();
