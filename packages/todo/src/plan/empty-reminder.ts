import type { AsyncLocalStorage } from "node:async_hooks";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { getEmptyReminderConfig } from "../config.ts";
import { TOOL_NAME } from "../tool/types.ts";

const CHILD_CONTEXT = Symbol.for("pi-subagents:child-session-context");

/** Read the optional pi-subagents loader marker at registration, not during later child events.
 * In-memory children have no parent file, and a parent file alone can also mean a user's fork. */
export function isChildActivation(): boolean {
	const globals = globalThis as typeof globalThis & { [CHILD_CONTEXT]?: AsyncLocalStorage<boolean> };
	return globals[CHILD_CONTEXT]?.getStore() === true;
}

/** The fields of a tool-result message the work counter reads. */
export type ToolCompletion = Pick<ToolResultMessage, "toolName" | "isError">;

/** One session's empty-list work counter, prompt budget and settle cooldown. */
export function trackEmptyReminder(config: ReturnType<typeof getEmptyReminderConfig>, previouslyReminded: boolean) {
	let calls = 0;
	let spawned = false;
	let worked = false;
	let completedBoundary = false;
	let reminded = previouslyReminded;
	let remainingSettles = previouslyReminded ? config.cooldownSettles : 0;

	function resetWork(): void {
		calls = 0;
		spawned = false;
		worked = false;
	}

	return {
		toolFinished(event: ToolCompletion, eligible: boolean) {
			if (event.toolName === TOOL_NAME) {
				resetWork();
				return;
			}
			if (!eligible) return;
			calls = Math.min(calls + 1, config.toolCalls);
			if (event.toolName === "Agent" && !event.isError) spawned = true;
			worked = true;
		},
		humanInput() {
			reminded = false;
			worked = false;
		},
		// A completed boundary can still continue. Only the terminal signal ages the cooldown.
		settled(aborted: boolean, planning: boolean) {
			if (completedBoundary && !aborted && !planning) remainingSettles = Math.max(0, remainingSettles - 1);
			completedBoundary = false;
			worked = false;
		},
		beforeSettle(completed: boolean, planning: boolean, empty: boolean): boolean {
			completedBoundary = completed && !planning;
			const hadWork = worked;
			worked = false;
			if (!empty) resetWork();
			if (!completedBoundary) return false;
			if (!empty || !hadWork || reminded || remainingSettles > 0 || (!spawned && calls < config.toolCalls)) {
				return false;
			}
			resetWork();
			reminded = true;
			remainingSettles = config.cooldownSettles;
			return true;
		},
	};
}
