/**
 * Last known state of the top-level subagents this process has heard about,
 * fed by pi-subagents' lifecycle events on `pi.events`. A todo's free-text
 * `owner` is matched against an agent's id, `handle` or `name` purely for
 * display: nothing here reads or writes any todo list, so a child session
 * still cannot touch the parent's tasks.
 *
 * Either package works without the other: no pi-subagents means no events,
 * so owners render without a state. An evicted agent or a session switch emits
 * nothing further, so the last known state stays until the entry ages out.
 */

import { sanitizeTerminalText } from "../tool/sanitize.ts";
import { SUBAGENT_COMPLETED_EVENT, SUBAGENT_FAILED_EVENT, SUBAGENT_STARTED_EVENT, type Task } from "../tool/types.ts";

/** What a todo row shows for its owner's agent. */
export type AgentRunState = "running" | "done" | "failed" | "stopped";

/** Looks up an owner's agent state; injectable so history and tests stay deterministic. */
export type AgentStateLookup = (owner: string | undefined) => AgentRunState | undefined;

interface AgentEntry {
	id: string;
	handle?: string;
	name?: string;
	state: AgentRunState;
}

/** Bound memory in a long session; the oldest-updated agents drop first. */
export const MAX_TRACKED_AGENTS = 256;

// Insertion order is update order: every write deletes then re-inserts.
const agents = new Map<string, AgentEntry>();

/** Lowercased owner or identity key without a leading `@`, or `undefined` when empty. */
function key(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().replace(/^@/, "").toLowerCase();
	return normalized || undefined;
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
 * Record one lifecycle event. Returns `true` when an agent's tracked state or
 * identity changed, so the caller refreshes the overlay only then. Malformed
 * payloads and unknown channels are ignored.
 */
export function applyAgentEvent(channel: string, payload: unknown): boolean {
	if (!payload || typeof payload !== "object") return false;
	const data = payload as Record<string, unknown>;
	if (typeof data.id !== "string" || data.id.length === 0) return false;
	const state = stateFor(channel, data.status);
	if (!state) return false;
	const previous = agents.get(data.id);
	const next: AgentEntry = {
		id: data.id,
		// A later payload without a field keeps the identity an earlier one gave.
		handle: typeof data.handle === "string" ? data.handle : previous?.handle,
		name: typeof data.name === "string" ? data.name : previous?.name,
		state,
	};
	agents.delete(data.id);
	agents.set(data.id, next);
	while (agents.size > MAX_TRACKED_AGENTS) {
		const oldest = agents.keys().next().value as string;
		agents.delete(oldest);
	}
	return (
		previous === undefined ||
		previous.state !== next.state ||
		previous.handle !== next.handle ||
		previous.name !== next.name
	);
}

/** The most recently updated agent whose id, handle or name equals `owner` (case-insensitive, `@` optional). */
export const agentStateForOwner: AgentStateLookup = (owner) => {
	const wanted = key(owner);
	if (!wanted) return undefined;
	const entries = [...agents.values()];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (key(entry.id) === wanted || key(entry.handle) === wanted || key(entry.name) === wanted) return entry.state;
	}
	return undefined;
};

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

/** Test-only: forget every tracked agent. */
export function __resetAgents(): void {
	agents.clear();
}
