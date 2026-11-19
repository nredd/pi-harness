/** Read lookup diagnostics and resume metadata from the saved parent branch. */
import { capRetained, type EvictedNote } from "./agent-manager.ts";

interface SavedAgentNote extends EvictedNote {
	handle: string;
	alias?: string;
	previousId?: string;
	completedAt: number;
}

/** Validate saved custom-entry data before handing it to the eviction-note index. */
export function savedAgentNote(data: unknown): SavedAgentNote | undefined {
	if (!data || typeof data !== "object") return undefined;
	const row = data as Record<string, unknown>;
	if (typeof row.id !== "string" || typeof row.type !== "string" || typeof row.description !== "string")
		return undefined;
	if (
		row.status !== "running" &&
		row.status !== "completed" &&
		row.status !== "steered" &&
		row.status !== "error" &&
		row.status !== "aborted" &&
		row.status !== "stopped"
	)
		return undefined;
	const sessionFile = typeof row.sessionFile === "string" ? row.sessionFile : undefined;
	const transcript = row.status !== "running" && typeof row.outputFile === "string" ? row.outputFile : sessionFile;
	return {
		id: row.id,
		type: row.type,
		description: row.description,
		status: row.status,
		evictedAfterMin: 0,
		fromSavedSession: true,
		// Legacy terminal records have no handle; use the id without claiming a type name.
		handle: typeof row.handle === "string" ? row.handle : row.id,
		alias: typeof row.alias === "string" ? row.alias : undefined,
		previousId: typeof row.previousId === "string" ? row.previousId : undefined,
		completedAt: typeof row.completedAt === "number" ? row.completedAt : 0,
		sessionFile,
		sessionCwd: typeof row.sessionCwd === "string" ? row.sessionCwd : undefined,
		...(transcript ? { transcript } : {}),
		...(typeof row.result === "string" ? { result: capRetained(row.result, transcript) } : {}),
		...(typeof row.error === "string" ? { error: capRetained(row.error, transcript) } : {}),
	};
}
