/**
 * Plan integration: seed todos from an approved plan, and stop a run from
 * wrapping up silently while plan items are open.
 *
 * - pi-plan-mode emits `PLAN_APPROVED_EVENT` on `pi.events`. Either package
 *   works without the other: no listener means no todos, no emitter means
 *   this never fires.
 * - At `agent_before_settle` with plan items open, one hidden marker message
 *   is appended and one more model request is requested. The `context` hook
 *   swaps the marker for the live open-item list on that request only, so the
 *   list itself is never persisted.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyPlanApproval, selectOpenPlanItems, selectPlanProgress } from "./state/plan.js";
import type { TaskState } from "./state/state.js";
import { commitState, getState, sid } from "./state/store.js";
import { sanitizeTerminalText } from "./tool/sanitize.js";
import {
	PLAN_APPROVED_EVENT,
	PLAN_APPROVED_VERSION,
	PLAN_REMINDER_MESSAGE_TYPE,
	type PlanApprovedPayload,
	STATE_ENTRY_TYPE,
	type TaskSnapshot,
} from "./tool/types.js";

/** Persisted marker text; the `context` hook expands it on the request right after it. */
export const PLAN_REMINDER_MARKER = "[rpiv-todo] Plan items were still open when this run tried to finish.";

// `agent_before_settle` landed in Pi 1.0; rpiv-mono still type-checks against
// 0.80.6, which doesn't declare it. These mirror the 1.0 declarations we use.
interface SettleMessage {
	role?: string;
	customType?: string;
}
interface AgentBeforeSettleEvent {
	outcome: "completed" | "aborted" | "error";
	entries: unknown[];
	context: { contextMessages: SettleMessage[] };
}
interface ReminderDraft {
	type: "custom_message";
	customType: string;
	content: string;
	display: boolean;
	details?: unknown;
}
type SettleHandler = (
	event: AgentBeforeSettleEvent,
	ctx: Parameters<typeof sid>[0],
) => { entries: unknown[]; continue: boolean } | undefined;

/** Narrow an event-bus payload to the versioned plan-approval contract. */
export function isPlanApprovedPayload(value: unknown): value is PlanApprovedPayload {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		v.version === PLAN_APPROVED_VERSION &&
		typeof v.planId === "string" &&
		v.planId.length > 0 &&
		typeof v.plan === "string" &&
		typeof v.sessionId === "string"
	);
}

function isReminder(message: SettleMessage | undefined): boolean {
	return message?.role === "custom" && message.customType === PLAN_REMINDER_MESSAGE_TYPE;
}

/**
 * True when a reminder already followed the latest user prompt: the run was
 * reminded once, so let it settle. Stateless, so it survives `/reload`.
 */
export function remindedSinceLastPrompt(messages: readonly SettleMessage[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isReminder(messages[i])) return true;
		if (messages[i].role === "user") return false;
	}
	return false;
}

/** The transient reminder: open plan items verbatim, deferred ones with their reasons. */
export function formatPlanReminder(state: TaskState): string {
	const progress = selectPlanProgress(state);
	const open = selectOpenPlanItems(state);
	const title = sanitizeTerminalText(state.plan?.title ?? "plan");
	const line = (id: number, group: string | undefined, subject: string) =>
		`- #${id}${group ? ` [${sanitizeTerminalText(group)}]` : ""} ${sanitizeTerminalText(subject)}`;
	const lines = [
		`Plan check: the approved plan "${title}" still has ${progress?.open ?? open.length}/${progress?.total ?? open.length} items open. Do not tell the user the work is done.`,
		"Open plan items:",
		...open.map((t) => line(t.id, t.planGroup, t.subject)),
		"Keep working on them now. For any item you can't finish in this run: if it is actually done, complete it with evidence; otherwise set status deferred with a reason. Then tell the user exactly which plan items are still open or deferred, and why.",
	];
	const deferred = state.tasks.filter((t) => t.source === "plan" && t.status === "deferred");
	if (deferred.length) {
		lines.push("Deferred plan items (tell the user):");
		for (const t of deferred)
			lines.push(`${line(t.id, t.planGroup, t.subject)} -- ${sanitizeTerminalText(t.reason ?? "")}`);
	}
	return lines.join("\n");
}

/**
 * Register the plan-approval listener and the wrap-up reminder.
 *
 * Parameters:
 * - `onStateChange(sessionId)`: refresh the overlay after a plan approval
 *   changed that session's list.
 */
export interface PlanSessionHooks {
	/** Call from `session_start` after replay: binds the session and applies a pending approval. */
	sessionStarted(sessionId: string): Promise<void>;
	/** Call from `session_shutdown`. */
	sessionEnded(sessionId: string): void;
}

export function registerPlanHooks(
	pi: ExtensionAPI,
	onStateChange: (sessionId: string) => Promise<void>,
): PlanSessionHooks {
	// Sessions this extension instance is bound to. An approval for another
	// session (a child, a stale emitter) waits until that session starts here.
	const live = new Set<string>();
	const pending = new Map<string, PlanApprovedPayload>();

	const seed = async (payload: PlanApprovedPayload): Promise<void> => {
		const result = applyPlanApproval(getState(payload.sessionId), payload.planId, payload.plan);
		if (!result.changed) return;
		commitState(payload.sessionId, result.state);
		const snapshot: TaskSnapshot = {
			tasks: result.state.tasks,
			nextId: result.state.nextId,
			...(result.state.plan ? { plan: result.state.plan } : {}),
		};
		pi.appendEntry(STATE_ENTRY_TYPE, snapshot);
		await onStateChange(payload.sessionId);
	};

	pi.events.on(PLAN_APPROVED_EVENT, async (data) => {
		if (!isPlanApprovedPayload(data)) return;
		if (live.has(data.sessionId)) await seed(data);
		else pending.set(data.sessionId, data);
	});

	const onSettle: SettleHandler = (event, ctx) => {
		if (event.outcome !== "completed") return undefined;
		if (remindedSinceLastPrompt(event.context.contextMessages)) return undefined;
		const open = selectOpenPlanItems(getState(sid(ctx)));
		if (!open.length) return undefined;
		const draft: ReminderDraft = {
			type: "custom_message",
			customType: PLAN_REMINDER_MESSAGE_TYPE,
			content: PLAN_REMINDER_MARKER,
			display: false,
			details: { open: open.map((t) => t.id) },
		};
		return { entries: [...event.entries, draft], continue: true };
	};
	(pi.on as unknown as (event: "agent_before_settle", handler: SettleHandler) => void)(
		"agent_before_settle",
		onSettle,
	);

	pi.on("context", async (event, ctx) => {
		const last = event.messages[event.messages.length - 1] as SettleMessage | undefined;
		if (!isReminder(last)) return undefined;
		const state = getState(sid(ctx));
		if (!selectOpenPlanItems(state).length) return undefined;
		const messages = [...event.messages];
		messages[messages.length - 1] = {
			...(last as object),
			content: formatPlanReminder(state),
		} as (typeof messages)[number];
		return { messages };
	});

	return {
		async sessionStarted(sessionId) {
			live.add(sessionId);
			const payload = pending.get(sessionId);
			pending.delete(sessionId);
			if (payload) await seed(payload);
		},
		sessionEnded(sessionId) {
			live.delete(sessionId);
		},
	};
}
