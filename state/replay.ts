import { STATE_ENTRY_TYPE, type Task, type TaskSnapshot } from "../tool/types.js";
import { EMPTY_STATE, type TaskState } from "./state.js";

/**
 * Discriminator for `details` envelopes that match the persisted `TaskDetails`
 * shape. Defensive — branch entries from older or corrupt sessions are
 * skipped silently.
 */
export function isTaskDetails(value: unknown): value is TaskSnapshot {
	if (!isRecord(value)) return false;
	if (!Array.isArray(value.tasks) || !positiveId(value.nextId)) return false;
	if (!value.tasks.every(isTask)) return false;
	const ids = new Set(value.tasks.map((task) => task.id));
	if (ids.size !== value.tasks.length || value.tasks.some((task) => task.id >= (value.nextId as number))) return false;
	if (value.tasks.some((task) => task.blockedBy?.some((id) => id === task.id || !ids.has(id)))) return false;
	return (
		value.plan === undefined ||
		(isRecord(value.plan) && typeof value.plan.id === "string" && typeof value.plan.title === "string")
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Validate structure, not newer business rules: old completions need not have evidence. */
function isTask(value: unknown): value is Task {
	if (!isRecord(value) || !positiveId(value.id) || typeof value.subject !== "string") return false;
	if (!["pending", "in_progress", "completed", "deferred", "deleted"].includes(value.status as string)) return false;
	for (const field of ["description", "activeForm", "owner", "planGroup", "planText", "evidence", "reason"]) {
		if (value[field] !== undefined && typeof value[field] !== "string") return false;
	}
	if (value.source !== undefined && value.source !== "plan") return false;
	if (value.planIdentity !== undefined) {
		const identity = value.planIdentity;
		if (
			!isRecord(identity) ||
			identity.version !== 1 ||
			typeof identity.workBody !== "string" ||
			!Array.isArray(identity.headingPath) ||
			!identity.headingPath.every((heading) => typeof heading === "string")
		)
			return false;
	}
	if (value.planProvenance !== undefined) {
		const provenance = value.planProvenance;
		if (!isRecord(provenance) || typeof provenance.planId !== "string" || !positiveId(provenance.taskId))
			return false;
	}
	if (value.metadata !== undefined && !isRecord(value.metadata)) return false;
	if (value.blockedBy !== undefined && (!Array.isArray(value.blockedBy) || !value.blockedBy.every(positiveId)))
		return false;
	return true;
}

/** Snapshot carried by a branch entry: a `todo` tool result, or a `rpiv-todo-state` custom entry. */
function snapshotOf(entry: unknown): TaskSnapshot | undefined {
	if (!isRecord(entry)) return undefined;
	const e = entry as {
		type?: string;
		customType?: string;
		data?: unknown;
		message?: { role?: string; toolName?: string; details?: unknown };
	};
	if (e.type === "custom" && e.customType === STATE_ENTRY_TYPE) {
		return isTaskDetails(e.data) ? e.data : undefined;
	}
	if (e.type !== "message") return undefined;
	const msg = e.message;
	if (msg?.role !== "toolResult" || msg.toolName !== "todo") return undefined;
	return isTaskDetails(msg.details) ? msg.details : undefined;
}

/**
 * Walk the current branch in chronological order; the LAST snapshot wins
 * (last-write-wins). Snapshots are `todo` tool results whose `details` match
 * `TaskDetails`, and `rpiv-todo-state` custom entries written when a plan
 * approval changes the list outside a tool call. When none exists, returns
 * `EMPTY_STATE`.
 *
 * Pure of module state — `index.ts` writes the returned snapshot into the
 * store after this returns. The function explicitly does NOT touch the store
 * cell.
 */
export function replayFromBranch(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TaskState {
	let result: TaskState = { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
	for (const entry of ctx.sessionManager.getBranch()) {
		const details = snapshotOf(entry);
		if (!details) continue;
		result = {
			tasks: details.tasks.map((t) => ({ ...t })),
			nextId: details.nextId,
			...(details.plan ? { plan: { ...details.plan } } : {}),
		};
	}
	return result;
}
