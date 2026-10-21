import type { TaskStatus } from "../tool/types.ts";

/**
 * Allowed forward transitions per source status. `completed` is one-way to
 * `deleted` (never back to `in_progress`); `deleted` is terminal. `deferred`
 * (descoped with a reason) can be reopened. Plan items additionally can't
 * reach `deleted`; that rule lives in the reducer, it depends on the task.
 *
 * Idempotent same→same is checked separately in `isTransitionValid` so this
 * table only enumerates actual transitions.
 */
export const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
	pending: new Set(["in_progress", "completed", "deferred", "deleted"]),
	in_progress: new Set(["pending", "completed", "deferred", "deleted"]),
	completed: new Set(["deleted"]),
	deferred: new Set(["pending", "in_progress", "deleted"]),
	deleted: new Set(),
};

export function isTransitionValid(from: TaskStatus, to: TaskStatus): boolean {
	if (from === to) return true;
	return VALID_TRANSITIONS[from].has(to);
}
