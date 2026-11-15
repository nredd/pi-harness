/** Read terminal history as lookup diagnostics, never as live agents or executable resume state. */
import { capRetained, type EvictedNote } from "./agent-manager.js";

/** Validate saved custom-entry data before handing it to the eviction-note index. */
export function savedAgentNote(data: unknown): EvictedNote | undefined {
  if (!data || typeof data !== "object") return undefined;
  const row = data as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.type !== "string" || typeof row.description !== "string") return undefined;
  if (row.status !== "completed" && row.status !== "steered" && row.status !== "error" && row.status !== "aborted" && row.status !== "stopped") return undefined;
  const transcript = typeof row.outputFile === "string" ? row.outputFile : typeof row.sessionFile === "string" ? row.sessionFile : undefined;
  return {
    id: row.id,
    type: row.type,
    description: row.description,
    status: row.status,
    evictedAfterMin: 0,
    fromSavedSession: true,
    ...(transcript ? { transcript } : {}),
    ...(typeof row.result === "string" ? { result: capRetained(row.result, transcript) } : {}),
    ...(typeof row.error === "string" ? { error: capRetained(row.error, transcript) } : {}),
  };
}
