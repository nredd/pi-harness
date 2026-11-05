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

import type {
	AgentBeforeSettleEvent,
	AgentBeforeSettleEventResult,
	ExtensionAPI,
	SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";
import { type AgentStateLookup, agentLookup, isAbandoned, ownerLabel } from "./state/agents.ts";
import { applyPlanApproval, selectOpenPlanItems, selectPlanProgress } from "./state/plan.ts";
import type { TaskState } from "./state/state.ts";
import { commitState, getState, sid } from "./state/store.ts";
import { sanitizeTerminalText } from "./tool/sanitize.ts";
import {
	PLAN_APPROVED_EVENT,
	PLAN_APPROVED_VERSION,
	PLAN_REMINDER_MESSAGE_TYPE,
	type PlanApprovedPayload,
	STATE_ENTRY_TYPE,
	type TaskSnapshot,
} from "./tool/types.ts";

/** Persisted marker text; the `context` hook expands it on the request right after it. */
export const PLAN_REMINDER_MARKER = "[rpiv-todo] Plan items were still open when this run tried to finish.";

interface SettleMessage {
	role?: string;
	customType?: string;
}
type PlanContext = Parameters<typeof sid>[0] & { sessionManager: { getBranch(): readonly unknown[] } };
type SettleHandler = (event: AgentBeforeSettleEvent, ctx: PlanContext) => AgentBeforeSettleEventResult | undefined;

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

/**
 * Read the active branch rather than only its compacted model projection. The
 * versioned mode contract survives reload/tree navigation; legacy restored
 * workflows may instead have only a plan-mode-state entry. No runtime import
 * or event cache couples the independently installable packages.
 */
function planningMode(entries: readonly unknown[]): boolean | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (record.type === "custom" && record.customType === "plan-mode-state") {
			const data = record.data as { enabled?: unknown } | undefined;
			if (data && typeof data.enabled === "boolean") return data.enabled;
		}
		const message = (record.type === "message" ? record.message : record) as
			| { role?: string; customType?: string; details?: { version?: unknown; mode?: unknown } }
			| undefined;
		if (message?.role !== "custom" || message.customType !== "plan-mode-transition") continue;
		if (message.details?.version !== 1) continue;
		if (message.details.mode === "plan") return true;
		if (message.details.mode === "normal") return false;
	}
	return undefined;
}

/** The persisted branch is authoritative after compaction or a mode change. */
function isPlanning(ctx: PlanContext, messages: readonly unknown[]): boolean {
	return planningMode(ctx.sessionManager.getBranch()) ?? planningMode(messages) ?? false;
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
		"These already exist as todos: update them by id (complete with evidence, or defer with a reason). Do not create new todos for them.",
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
 * One-line report of `in_progress` todos a run stopped with, or `undefined` when there are none.
 * Same shape as the `subagents` and `session-kit` monitor settle notices,
 * `Run ended with N <work>, armed: <what wakes the parent>`, naming only todos. Todos arm nothing:
 * no todo wakes the parent, so the report says so rather than leaving the stop to read as resumable.
 * Every todo whose owning subagent failed or stopped is then named, uncapped: that work has no
 * worker left, so it is the part the parent must act on.
 */
export function formatInProgressNotice(
	state: TaskState,
	lookup: AgentStateLookup = () => undefined,
): string | undefined {
	const active = state.tasks.filter((t) => t.status === "in_progress");
	if (!active.length) return undefined;
	const shown = active.slice(0, 3).map((t) => `#${t.id} ${sanitizeTerminalText(t.subject)}`);
	const more = active.length > shown.length ? `, +${active.length - shown.length} more` : "";
	const notice = `Run ended with ${active.length} in_progress todo${active.length === 1 ? "" : "s"} (${shown.join(", ")}${more}), armed: no todo wakes the parent`;
	const abandoned = active.flatMap((t) => {
		const agent = lookup(t.owner);
		if (!isAbandoned(t, agent)) return [];
		return [`#${t.id} ${sanitizeTerminalText(t.subject)} (${ownerLabel(t.owner)} ${agent})`];
	});
	return abandoned.length ? `${notice}; owner agent failed or stopped: ${abandoned.join(", ")}` : notice;
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
			persistenceVersion: 1,
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
		if (event.outcome !== "completed" || isPlanning(ctx, event.context.contextMessages)) return undefined;
		if (remindedSinceLastPrompt(event.context.contextMessages)) return undefined;
		const open = selectOpenPlanItems(getState(sid(ctx)));
		if (!open.length) return undefined;
		const draft: SessionBoundaryDraft = {
			type: "custom_message",
			customType: PLAN_REMINDER_MESSAGE_TYPE,
			content: PLAN_REMINDER_MARKER,
			display: false,
			details: { open: open.map((t) => t.id) },
		};
		return { entries: [...event.entries, draft], continue: true };
	};
	pi.on("agent_before_settle", onSettle);

	// A settle with `in_progress` todos is a stop with owned work pending. The reminder above only
	// covers plan items and only once, so report the state instead of leaving a quiet prompt.
	pi.on("agent_settled", (_event, ctx) => {
		if (isPlanning(ctx, [])) return;
		const id = sid(ctx);
		const message = formatInProgressNotice(getState(id), agentLookup(id));
		if (message) ctx.ui.notify(message, "warning");
	});

	pi.on("context", async (event, ctx) => {
		if (isPlanning(ctx, event.messages)) return undefined;
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
