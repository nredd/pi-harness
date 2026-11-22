import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentManager, describeEvicted, describeEvictedResult } from "./agent-manager.ts";
import { listAllRunningDetached, listRunningDetached } from "./detached-results.ts";
import type { AgentRecord } from "./types.ts";

export function createAgentLookup(manager: AgentManager, getCtx: () => ExtensionContext | undefined) {
	const liveAgentById = (id: string) =>
		manager.getRecord(id) ?? listAllRunningDetached().find(({ agent }) => agent.record.id === id)?.agent.record;

	/**
	 * Resolve a tool's `agent_id` as an id OR a handle, so the model addresses
	 * agents by the same names the user types. Ids are tried first, keeping the
	 * existing behaviour exact — a handle is only consulted when the string is
	 * not an id at all. Only live records: a tombstone has nothing to steer and
	 * no result to read. Callers still enforce the nested-ownership rejection.
	 */
	const resolveAgentRef = (ref: string): AgentRecord | undefined => {
		const byId = manager.getRecord(ref);
		if (byId) return byId;
		const resolved = manager.resolveMention(ref);
		if (resolved?.kind === "live") return resolved.record;
		// Survivors of a /reload, /new or /resume live in the orphaned manager, so
		// this fresh one has never heard of them (#330). Same live records, so
		// reading and steering them work unchanged.
		const survivors = listRunningDetached(getCtx()?.sessionManager?.getSessionFile?.()).map((d) => d.record);
		return survivors.find((r) => r.id === ref) ?? survivors.find((r) => r.handle === ref || r.alias === ref);
	};

	return { liveAgentById, resolveAgentRef };
}

/** "Not found", or what became of the agent when its record was evicted. */
export function agentNotFound(manager: AgentManager, ref: string, withResult = false): string {
	const note = manager.getEvictedNote(ref);
	const result = withResult && note ? describeEvictedResult(note) : undefined;
	return note
		? describeEvicted(note) + (result ? `\n\n${result}` : "")
		: `Agent not found: "${ref}". It may have been cleaned up.`;
}
