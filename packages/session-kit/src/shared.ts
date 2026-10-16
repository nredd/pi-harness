/**
 * Coordination shared by `/goal` and `/loop`. Everything here is keyed by the `pi` object of one
 * extension runtime, never a module global, so two sessions in one process (or two tmux panes)
 * cannot see each other.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isChildSession } from "./child.ts";

/** `customType` of the session entry pi-plan-mode persists on every state change. */
export const PLAN_STATE_ENTRY = "plan-mode-state";

interface EntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

/**
 * Whether Plan mode is on, from the latest `plan-mode-state` entry of a branch.
 *
 * pi-plan-mode exposes no "active" event or getter; its persisted state entry (`data.enabled`) is
 * the only external signal, and it is appended synchronously on every transition.
 */
export function isPlanModeActive(entries: readonly EntryLike[]): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.customType !== PLAN_STATE_ENTRY) continue;
		const data = entry.data;
		return typeof data === "object" && data !== null && (data as { enabled?: unknown }).enabled === true;
	}
	return false;
}

/**
 * Whether Plan mode was switched ON after the last `marker` entry of a branch, even if it has
 * been switched off again since. An idle goal sees no events while the user runs `/plan start`
 * then `/plan exit`; this finds that excursion afterwards.
 */
export function planModeEnteredSince(entries: readonly EntryLike[], marker: string): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom") continue;
		if (entry.customType === marker) return false;
		if (entry.customType === PLAN_STATE_ENTRY && (entry.data as { enabled?: unknown } | null)?.enabled === true)
			return true;
	}
	return false;
}

/** Plan mode for the current branch of `ctx`'s session. */
export function planModeActive(ctx: ExtensionContext): boolean {
	return isPlanModeActive(ctx.sessionManager.getBranch() as readonly EntryLike[]);
}

/** In-process state `/goal` and `/loop` agree on. */
export interface Coordination {
	/** A goal is active: loop ticks must not fire. */
	goalActive: boolean;
	/** Router-owned quota jobs still parked; clearing them never auto-resumes kit work. */
	quotaParked: Set<string>;
	/** Reconcile an idle Plan-mode excursion before another feature handles a command. */
	reconcilePlanMode?: (ctx: ExtensionContext) => void;
}

const COORDINATION = new WeakMap<object, Coordination>();

/** The coordination record of one `pi` runtime. */
export function coordination(pi: object): Coordination {
	let state = COORDINATION.get(pi);
	if (!state) {
		state = { goalActive: false, quotaParked: new Set() };
		COORDINATION.set(pi, state);
	}
	return state;
}

/** Quota admission is distinct from a recoverable provider error. */
export type QuotaPause = "quota parked" | "quota refused";

interface QuotaWatch {
	listeners: Set<(reason: QuotaPause, ctx: ExtensionContext) => void>;
}

const QUOTA_WATCHES = new WeakMap<object, QuotaWatch>();

/**
 * Watch real pi-subagents admission, once per kit runtime. Parking happens before
 * an Agent record exists: `subagents:scheduled`, not `subagents:created`, owns it.
 * Pause immediately on additions/reparks and direct admission refusal. Removing,
 * disabling or firing a job releases the resume guard, but NEVER resumes work.
 * The current in-flight turn is allowed to finish; no new goal or loop turn starts.
 */
export function watchQuota(pi: ExtensionAPI, onQuota: (reason: QuotaPause, ctx: ExtensionContext) => void): void {
	let watch = QUOTA_WATCHES.get(pi);
	if (!watch) {
		watch = { listeners: new Set() };
		QUOTA_WATCHES.set(pi, watch);
		const listeners = watch.listeners;
		const shared = coordination(pi);
		let ctx: ExtensionContext | undefined;
		let detach: (() => void) | undefined;
		const pause = (reason: QuotaPause): void => {
			if (ctx && !isChildSession(pi)) for (const listener of listeners) listener(reason, ctx);
		};
		pi.on("session_start", (_event, context) => {
			detach?.();
			detach = undefined;
			shared.quotaParked.clear();
			ctx = context;
			if (isChildSession(pi)) return;
			detach = pi.events.on("subagents:scheduled", (raw) => {
				if (!raw || typeof raw !== "object") return;
				const event = raw as { type?: unknown; jobId?: unknown; job?: unknown };
				if (event.type === "removed" || event.type === "fired" || event.type === "error") {
					if (typeof event.jobId === "string") shared.quotaParked.delete(event.jobId);
					return;
				}
				if (event.type !== "added" && event.type !== "updated") return;
				if (!event.job || typeof event.job !== "object") return;
				const job = event.job as { id?: unknown; quotaParked?: unknown; enabled?: unknown; lastStatus?: unknown };
				if (typeof job.id !== "string") return;
				if (job.quotaParked === true && job.enabled === true && job.lastStatus !== "running") {
					shared.quotaParked.add(job.id);
					pause("quota parked");
				} else shared.quotaParked.delete(job.id);
			});
		});
		pi.on("before_agent_start", (_event, context) => {
			ctx = context;
		});
		pi.on("tool_execution_end", (event, context) => {
			ctx = context;
			if (event.toolName !== "Agent" || !event.isError || isChildSession(pi)) return;
			// The admission client has no refusal event. Match its canonical error,
			// not arbitrary quota-looking tool output or provider retry messages.
			const text = event.result.content
				.filter((block: { type?: string }) => block.type === "text")
				.map((block: { text?: string }) => block.text)
				.join("\n");
			if (/Subscription quota for .+ is exhausted; it resets at .+\. The agent was not started\./.test(text))
				pause("quota refused");
		});
		pi.on("session_shutdown", () => {
			detach?.();
			detach = undefined;
			ctx = undefined;
			shared.quotaParked.clear();
		});
	}
	watch.listeners.add(onQuota);
}

/** How a run ended when nobody continued it. */
export type StopOutcome = "aborted" | "error";

/**
 * Report runs that ended in `aborted` or `error` once pi has truly stopped.
 *
 * `agent_before_settle` is too early: pi may still auto-retry, or another handler (the
 * subscription router's quota recovery) may continue the run. So the outcome is only recorded
 * there, forgotten when a new turn starts, and reported from `agent_settled`.
 */
export function watchStops(pi: ExtensionAPI, onStop: (outcome: StopOutcome, ctx: ExtensionContext) => void): void {
	let pending: StopOutcome | undefined;
	pi.on("agent_before_settle", (event) => {
		pending = !event.continue && event.outcome !== "completed" ? event.outcome : undefined;
	});
	pi.on("turn_start", () => {
		pending = undefined;
	});
	pi.on("agent_settled", (_event, ctx) => {
		const outcome = pending;
		pending = undefined;
		if (outcome) onStop(outcome, ctx);
	});
}
