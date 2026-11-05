/**
 * Last known state of each session's top-level subagents, fed by pi-subagents'
 * lifecycle events on `pi.events`. A todo's free-text `owner` is matched
 * against an agent's id, `handle`, `name`, `nameBase` or a reopened agent's previous id,
 * purely for display: nothing here reads or writes any todo list, so a child
 * session still cannot touch the parent's tasks.
 *
 * Agents are keyed by the session that heard them, so after `/new` or
 * `/resume` a todo never shows another session's agent. Either package works
 * without the other: no pi-subagents means no events, so owners render without
 * a state. An evicted agent emits nothing further, so its last known state
 * stays until the session ends or the entry ages out.
 */

import { sanitizeTerminalText } from "../tool/sanitize.ts";
import { SUBAGENT_COMPLETED_EVENT, SUBAGENT_FAILED_EVENT, SUBAGENT_STARTED_EVENT, type Task } from "../tool/types.ts";

/** What a todo row shows for its owner's agent. */
export type AgentRunState = "running" | "done" | "failed" | "stopped";

/** Looks up an owner's agent state; injectable so history and tests stay deterministic. */
export type AgentStateLookup = (owner: string | undefined) => AgentRunState | undefined;

interface AgentEntry {
	/** Exact match keys: the id, every previous id, `handle` and `name`. */
	keys: Set<string>;
	/** The spawner `name` before collision numbering; matches only as a fallback, see `agentStateFor`. */
	nameBase?: string;
	state: AgentRunState;
	/**
	 * Sequence number of this conversation's first `started`: set once per id and carried
	 * over a `previousId` fold, so a resume or reopen never makes a sibling look like a retry.
	 */
	firstStartedAt: number;
	/** Sequence number of the latest `started`; orders retries. */
	startedAt: number;
	/** Sequence number of the latest settle, unset while running. */
	settledAt?: number;
}

/** Bound memory in a long session; the oldest-updated agents drop first. */
export const MAX_TRACKED_AGENTS = 256;

// Per session, insertion order is update order: every write deletes then re-inserts.
const sessions = new Map<string, Map<string, AgentEntry>>();
// Orders starts and settles across every agent; only comparisons matter, never values.
let sequence = 0;

/** pi-subagents' `MAX_HANDLE_LENGTH`; `ownerKey` must cut where `handleBase` does. */
const MAX_KEY_LENGTH = 64;

/**
 * The comparison key for an owner or an agent identity, slugged exactly the way
 * pi-subagents' `handleBase` turns a spawner `name` into a handle, so the owner
 * `Auth Audit` or `@auth-audit` matches the payload `nameBase` `auth-audit`.
 * Unlike `handleBase`, an empty slug is no key rather than `agent`.
 * `agents.test.ts` pins the two against each other.
 */
export function ownerKey(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_KEY_LENGTH)
		.replace(/-+$/, "");
	return slug || undefined;
}

/**
 * `subagents:failed` covers error, abort and stop. A stop is someone's
 * decision rather than a fault, so it reads `stopped`; the rest read `failed`.
 */
function stateFor(channel: string, status: unknown): AgentRunState | undefined {
	if (channel === SUBAGENT_STARTED_EVENT) return "running";
	if (channel === SUBAGENT_COMPLETED_EVENT) return "done";
	if (channel === SUBAGENT_FAILED_EVENT) return status === "stopped" ? "stopped" : "failed";
	return undefined;
}

/**
 * Record one lifecycle event heard by `sessionId`. Returns `true` when an
 * agent's tracked state or identity changed, so the caller refreshes the
 * overlay only then. A `previousId` (an evicted agent reopened under a new id)
 * folds the old entry into the new one, so an owner set to the old id follows
 * the conversation. Malformed payloads and unknown channels are ignored.
 */
export function applyAgentEvent(sessionId: string, channel: string, payload: unknown): boolean {
	if (!payload || typeof payload !== "object") return false;
	const data = payload as Record<string, unknown>;
	if (typeof data.id !== "string" || data.id.length === 0) return false;
	const state = stateFor(channel, data.status);
	if (!state) return false;
	let agents = sessions.get(sessionId);
	if (!agents) {
		agents = new Map();
		sessions.set(sessionId, agents);
	}
	const previous = agents.get(data.id);
	const predecessor = typeof data.previousId === "string" ? agents.get(data.previousId) : undefined;
	// A later payload without a field keeps the identity an earlier one gave.
	const keys = new Set([...(predecessor?.keys ?? []), ...(previous?.keys ?? [])]);
	for (const value of [data.id, data.previousId, data.handle, data.name]) {
		const k = ownerKey(value);
		if (k) keys.add(k);
	}
	const nameBase = ownerKey(data.nameBase) ?? previous?.nameBase ?? predecessor?.nameBase;
	// A repeated `started` keeps its start; any other transition is a new point in the sequence.
	const restarted = state === "running" && previous?.state !== "running";
	const startedAt = restarted || !previous ? ++sequence : previous.startedAt;
	const firstStartedAt = previous?.firstStartedAt ?? predecessor?.firstStartedAt ?? startedAt;
	const settledAt = state === "running" ? undefined : previous?.state === state ? previous.settledAt : ++sequence;
	if (typeof data.previousId === "string") agents.delete(data.previousId);
	agents.delete(data.id);
	agents.set(data.id, { keys, nameBase, state, firstStartedAt, startedAt, settledAt });
	while (agents.size > MAX_TRACKED_AGENTS) {
		const oldest = agents.keys().next().value as string;
		agents.delete(oldest);
	}
	return (
		previous === undefined ||
		previous.state !== state ||
		previous.keys.size !== keys.size ||
		previous.nameBase !== nameBase
	);
}

/** The state of the agent in `sessionId` that `owner` names, per `docs/overlay.md#owner-match-rule`. */
export function agentStateFor(sessionId: string, owner: string | undefined): AgentRunState | undefined {
	const wanted = ownerKey(owner);
	const agents = sessions.get(sessionId);
	if (!wanted || !agents) return undefined;
	const entries = [...agents.values()].reverse();
	const exact = entries.find((entry) => entry.keys.has(wanted));
	const byBase = entries.filter((entry) => entry !== exact && entry.nameBase === wanted);
	if (!exact) return byBase[0]?.state;
	const settledAt = exact.settledAt;
	if (settledAt === undefined) return exact.state;
	const retries = byBase.filter((entry) => entry.firstStartedAt > settledAt);
	retries.sort((a, b) => b.startedAt - a.startedAt);
	return retries[0]?.state ?? exact.state;
}

/** The lookup for a surface with no live agent state: owners render alone. */
export const NO_AGENT_STATE: AgentStateLookup = () => undefined;

/** Bind `agentStateFor` to one session. */
export function agentLookup(sessionId: string): AgentStateLookup {
	return (owner) => agentStateFor(sessionId, owner);
}

/** Drop everything `sessionId` tracked; called when that session shuts down. */
export function forgetAgents(sessionId: string): void {
	sessions.delete(sessionId);
}

/** `@owner` for display (terminal-safe, one leading `@`), or `undefined` for a blank owner. */
export function ownerLabel(owner: string | undefined): string | undefined {
	const bare = sanitizeTerminalText(owner ?? "")
		.trim()
		.replace(/^@/, "");
	return bare ? `@${bare}` : undefined;
}

/** An `in_progress` todo whose owning agent ended without finishing it. */
export function isAbandoned(task: Pick<Task, "status">, state: AgentRunState | undefined): boolean {
	return task.status === "in_progress" && (state === "failed" || state === "stopped");
}

/** Test-only: forget every tracked agent in every session. */
export function __resetAgents(): void {
	sessions.clear();
	sequence = 0;
}
