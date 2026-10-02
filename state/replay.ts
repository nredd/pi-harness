import type { TaskDetails } from "../tool/types.ts";
import { EMPTY_STATE, type TaskState } from "./state.ts";

/** Discriminate persisted task snapshots, ignoring unrelated branch entries. */
export function isTaskDetails(value: unknown): value is TaskDetails {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return Array.isArray(v.tasks) && typeof v.nextId === "number";
}

/** Copy persisted state so replay never aliases branch data. */
function stateOf(details: TaskDetails): TaskState {
	return {
		tasks: details.tasks.map((t) => ({ ...t })),
		nextId: details.nextId,
		...(details.plan ? { plan: { ...details.plan } } : {}),
	};
}

/** Prefer mutation-time custom entries over potentially stale outer tool results. */
export function replayFromBranch(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TaskState {
	let fromEntries: TaskState | undefined;
	let fromToolResults: TaskState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		const e = entry as {
			type?: string;
			customType?: string;
			data?: unknown;
			message?: { role?: string; toolName?: string; details?: unknown };
		};
		if (e.type === "custom") {
			if (e.customType === "rpiv-todo-state" && isTaskDetails(e.data)) fromEntries = stateOf(e.data);
			continue;
		}
		if (e.type !== "message") continue;
		const msg = e.message;
		if (msg?.role !== "toolResult" || msg.toolName !== "todo") continue;
		if (!isTaskDetails(msg.details)) continue;
		fromToolResults = stateOf(msg.details);
	}
	return fromEntries ?? fromToolResults ?? { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
}
