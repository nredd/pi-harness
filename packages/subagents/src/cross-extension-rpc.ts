/**
 * Cross-extension RPC handlers for the subagents extension.
 *
 * Exposes ping, spawn, stop, consume, and steer RPCs over the pi.events event bus,
 * using per-request scoped reply channels.
 *
 * Reply envelope follows pi-mono convention:
 *   success → { success: true, data?: T }
 *   error   → { success: false, error: string }
 *
 * @see README.md ("Driving subagents from another extension"), the caller-facing integration reference: spawn options
 * (including the fields spawnTopLevel strips), every error string, the
 * completion-notification race, and what protocol version 2 does not promise.
 */

import type { AgentRef } from "./agent-ref.ts";
import type { ModelRegistry } from "./model-resolver.ts";
import { selectModel } from "./model-selection.ts";
import { planSteerBlocked, planSteerRefusal } from "./plan-mode-children.ts";
import type { AgentRecord } from "./types.ts";

/** Minimal event bus interface needed by the RPC handlers. */
export interface EventBus {
	on(event: string, handler: (data: unknown) => void): () => void;
	emit(event: string, data: unknown): void;
}

/** RPC reply envelope — matches pi-mono's RpcResponse shape. */
export type RpcReply<T = void> = { success: true; data?: T } | { success: false; error: string };

/** RPC protocol version — bumped when the envelope or method contracts change. */
export const PROTOCOL_VERSION = 2;

/** Minimal AgentManager interface needed by the spawn/stop/consume RPCs. */
export interface SpawnCapable {
	spawn(pi: unknown, ctx: unknown, type: string, prompt: string, options: any): string;
	/** Resolves once the spawned agent is running; rejects on a startup failure. */
	awaitStartup(id: string): Promise<void>;
	abort(id: string): boolean;
	/**
	 * What a handle names to the session, as `steer_subagent` reads it, but
	 * without survivors of a session switch: this RPC acts through this
	 * manager only. Stop, steer and consume switch on its state.
	 */
	resolve(agentId: string): AgentRef;
	/** Whether this manager holds a record under the exact id, seen by the session or not. */
	hasRecord(id: string): boolean;
	/**
	 * Mark a settled agent's result as read by the caller, suppressing the
	 * completion notification — what `get_subagent_result` does when it returns one.
	 */
	markRead(record: AgentRecord): void;
	/**
	 * Deliver a message to a running or queued agent's conversation — what
	 * `steer_subagent` does. False when the agent is unknown or has settled.
	 */
	steer(id: string, message: string): boolean;
}

const NOT_RUNNING = "Agent is not running";

export interface RpcDeps {
	homeDir?: string;
	events: EventBus;
	pi: unknown; // passed through to manager.spawn
	getCtx: () => unknown | undefined; // returns current ExtensionContext
	manager: SpawnCapable;
}

export interface RpcHandle {
	unsubPing: () => void;
	unsubSpawn: () => void;
	unsubStop: () => void;
	unsubConsume: () => void;
	unsubSteer: () => void;
}

/**
 * Wire a single RPC handler: listen on `channel`, run `fn(params)`,
 * emit the reply envelope on `channel:reply:${requestId}`.
 */
function handleRpc<P extends { requestId: string }>(
	events: EventBus,
	channel: string,
	fn: (params: P) => unknown | Promise<unknown>,
): () => void {
	return events.on(channel, async (raw: unknown) => {
		const params = raw as P;
		try {
			const data = await fn(params);
			const reply: { success: true; data?: unknown } = { success: true };
			if (data !== undefined) reply.data = data;
			events.emit(`${channel}:reply:${params.requestId}`, reply);
		} catch (err: any) {
			events.emit(`${channel}:reply:${params.requestId}`, {
				success: false,
				error: err?.message ?? String(err),
			});
		}
	});
}

/**
 * Register ping, spawn, stop, consume, and steer RPC handlers on the event bus.
 * Returns unsub functions for cleanup.
 */
export function registerRpcHandlers(deps: RpcDeps): RpcHandle {
	const { events, pi, getCtx, manager } = deps;

	const unsubPing = handleRpc(events, "subagents:rpc:ping", () => {
		return { version: PROTOCOL_VERSION };
	});

	const unsubSpawn = handleRpc<{ requestId: string; type: string; prompt: string; options?: any }>(
		events,
		"subagents:rpc:spawn",
		async ({ type, prompt, options }) => {
			const ctx = getCtx();
			if (!ctx) throw new Error("No active session");

			const normalizedOptions = options ?? {};
			const maxTurns = normalizedOptions.maxTurns;
			// `!= null` like `model` below: a JSON-forwarding caller may send null for unset.
			if (maxTurns != null && (typeof maxTurns !== "number" || !Number.isFinite(maxTurns))) {
				throw new Error("maxTurns must be a finite number");
			}
			// Validate the model through the shared selector, but preserve the raw
			// request for spawn, which records its source and outcome.
			// `!= null` on purpose: a JSON-forwarding caller can serialize an unset
			// field as null, and the runner reads `options.model ?? default`, so null
			// means "inherit" — not an override to resolve or scope-check.
			const override = normalizedOptions.model;
			if (override != null) {
				const { modelRegistry, cwd } = ctx as { modelRegistry?: ModelRegistry; cwd?: string };
				// Names the override the same way in both messages below; an object
				// override would otherwise interpolate as "[object Object]".
				const label = typeof override === "string" ? override : `${override.provider}/${override.id}`;
				if (!modelRegistry) {
					throw new Error(`Model override "${label}" provided but ctx.modelRegistry is unavailable`);
				}
				const selection = selectModel({
					homeDir: deps.homeDir,
					agentType: type,
					paramModel: override,
					parentModel: undefined,
					registry: modelRegistry,
					cwd: cwd ?? process.cwd(),
				});
				if (typeof selection === "string") throw new Error(selection);
			}

			const id = manager.spawn(pi, ctx, type, prompt, normalizedOptions);
			// With isolation: "worktree" the agent starts asynchronously — wait for
			// it, so a strict-isolation failure is still an error envelope rather
			// than an id for an agent that never ran.
			await manager.awaitStartup(id);
			return { id };
		},
	);

	// Only the session's own agents are this RPC's to stop or steer. A nested
	// child or a workflow's agent is owned by something that is *waiting on it*,
	// and aborting or redirecting it out from under that owner turns another
	// extension's request into a failed step here. Defence in depth rather than
	// a live hole: no RPC hands out agent ids, so a caller has no ordinary way to
	// name one it does not own — but the guard is cheap and the id may leak some
	// other way. Same refuse-what-we-should-not-touch stance as `consume` below.
	// A nested child is hidden from the session, so it is refused by its exact id
	// off the record existing at all; saved history and a workflow run name nothing to act on.
	const assertOwned = (agentId: string): Extract<AgentRef, { record: AgentRecord }> => {
		const ref = manager.resolve(agentId);
		if (ref.state === "live" || ref.state === "queued" || ref.state === "retained") return ref;
		const owned =
			ref.state === "workflow-owned"
				? ref.owner.kind === "child"
				: ref.state === "unknown" && manager.hasRecord(agentId);
		throw new Error(owned ? "Agent is owned by another agent or workflow" : "Agent not found");
	};

	const unsubStop = handleRpc<{ requestId: string; agentId: string }>(events, "subagents:rpc:stop", ({ agentId }) => {
		const ref = assertOwned(agentId);
		// Not "not found": the lookup above already proved it exists. A retained
		// record has already finished, and `abort` refuses one that settled since.
		if (ref.state === "retained" || !manager.abort(ref.record.id)) throw new Error(NOT_RUNNING);
	});

	// A caller that has already shown the model an agent's result — pi-tasks'
	// TaskOutput is the one in practice — says so here, so the completion
	// notification for that same result is not delivered on top of it and does
	// not cost the parent a turn. Deliberately outside the ping version
	// handshake: an extension built against protocol v2 simply never calls it.
	// Same guard as get_subagent_result: only a settled agent of the session's
	// own has a result to consume; a running one's notification is still the
	// caller's only signal that it finished.
	const unsubConsume = handleRpc<{ requestId: string; agentId: string }>(
		events,
		"subagents:rpc:consume",
		({ agentId }) => {
			const ref = manager.resolve(agentId);
			if (ref.state !== "retained") throw new Error("Agent not found or still running");
			manager.markRead(ref.record);
		},
	);

	// An extension that spawned an agent over the bus and then learns something
	// that agent needs — a second CI failure on the head it is already fixing, a
	// review that landed mid-run — can hand it over instead of spawning a second
	// agent for the same work or dropping the fact. Outside the ping version
	// handshake, like consume: additive and best-effort.
	const unsubSteer = handleRpc<{ requestId: string; agentId: string; message: unknown }>(
		events,
		"subagents:rpc:steer",
		({ agentId, message }) => {
			if (typeof message !== "string" || message.trim().length === 0)
				throw new Error("Steer message must be a non-empty string");
			const ref = assertOwned(agentId);
			// Same refusal as `steer_subagent`, so another extension cannot steer a pre-Plan agent into edits.
			if (planSteerBlocked(ref.record, events)) throw new Error(planSteerRefusal(agentId));
			if (ref.state === "retained" || !manager.steer(ref.record.id, message)) throw new Error(NOT_RUNNING);
		},
	);

	return { unsubPing, unsubSpawn, unsubStop, unsubConsume, unsubSteer };
}
