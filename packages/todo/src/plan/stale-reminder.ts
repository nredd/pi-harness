import type { TaskState } from "../state/state.ts";

/**
 * Stale-list policy for one extension instance. The age is keyed by the `TaskState` object
 * `getState` returns, so it counts settles since that object was committed. A successful todo
 * write replaces it, and so do compaction and `/tree` replay even when the tasks are unchanged,
 * which restarts the age; reads and rejected writes keep its identity. The budget is per session
 * and only human input rearms it.
 */
export function trackStaleLists() {
	const age = new WeakMap<TaskState, number>();
	const reminded = new Set<string>();
	return {
		/** Age `state` by one settle that would otherwise stop; true spends the budget and nudges. */
		due(id: string, state: TaskState, threshold: number): boolean {
			const next = Math.min((age.get(state) ?? 0) + 1, threshold);
			age.set(state, next);
			if (next < threshold || reminded.has(id)) return false;
			reminded.add(id);
			return true;
		},
		/** Mark `id`'s budget spent, as restored from its branch. */
		spend(id: string): void {
			reminded.add(id);
		},
		/** Rearm `id` on human input, or forget it at shutdown. */
		rearm(id: string): void {
			reminded.delete(id);
		},
	};
}
