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
 * - After a compaction, the first request outside Plan mode gets the open
 *   todo list appended once, since the compacted context no longer carries it.
 */

import type {
	AgentBeforeSettleEvent,
	AgentBeforeSettleEventResult,
	ExtensionAPI,
	ExtensionContext,
	SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";
import {
	type AgentRunState,
	type AgentStateLookup,
	agentLookup,
	hasArmedAgent,
	isAbandoned,
	NO_AGENT_STATE,
	ownerKey,
	ownerLabel,
} from "../agents.ts";
import { getEmptyReminderConfig, getStaleAfterSettles } from "../config.ts";
import { monitorsByTodo } from "../monitors.ts";
import { selectVisibleTasks } from "../state/selectors.ts";
import type { TaskState } from "../state/state.ts";
import { commitState, getState, sid } from "../state/store.ts";
import { sanitizeTerminalText } from "../tool/sanitize.ts";
import {
	COMPACTION_LIST_MESSAGE_TYPE,
	EMPTY_REMINDER_MESSAGE_TYPE,
	HELD_REMINDER_MESSAGE_TYPE,
	NUDGE_BUDGET_ENTRY_TYPE,
	type NudgeBudgetEntry,
	PLAN_APPROVED_EVENT,
	PLAN_APPROVED_VERSION,
	PLAN_REMINDER_MESSAGE_TYPE,
	type PlanApprovedPayload,
	STALE_REMINDER_MESSAGE_TYPE,
	STATE_ENTRY_TYPE,
	type Task,
	type TaskSnapshot,
} from "../tool/types.ts";
import { isChildActivation, type ToolCompletion, trackEmptyReminder } from "./empty-reminder.ts";
import { applyPlanApproval, selectOpenPlanItems, selectPlanProgress } from "./reconcile.ts";
import { trackStaleLists } from "./stale-reminder.ts";

/** Persisted marker text; the `context` hook expands it on the request right after it. */
export const PLAN_REMINDER_MARKER = "[rpiv-todo] Plan items were still open when this run tried to finish.";

/** Persisted marker text for the held-work reminder. */
export const HELD_REMINDER_MARKER =
	"[rpiv-todo] Todos were held with nothing armed to wake you when this run tried to finish.";

export const STALE_REMINDER_MARKER = "[rpiv-todo] The open todo list went stale.";

export const EMPTY_REMINDER_MARKER = "[rpiv-todo] Autonomous work continued without a todo list.";

type SessionBranch = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;

/** Each budget kind's transcript marker: the kind alone picks the message type and text. */
const NUDGE_MARKERS: Readonly<Record<NudgeBudgetEntry["nudge"], { type: string; marker: string }>> = {
	stale: { type: STALE_REMINDER_MESSAGE_TYPE, marker: STALE_REMINDER_MARKER },
	empty: { type: EMPTY_REMINDER_MESSAGE_TYPE, marker: EMPTY_REMINDER_MARKER },
};

/** Narrow persisted entry data to the supported budget version and a known kind. */
function isNudgeBudgetEntry(value: unknown): value is NudgeBudgetEntry {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return v.persistenceVersion === 1 && typeof v.nudge === "string" && Object.hasOwn(NUDGE_MARKERS, v.nudge);
}

/** Whether the branch records a spent `nudge` budget. Transcript markers do not count. */
function budgetSpent(branch: SessionBranch, nudge: NudgeBudgetEntry["nudge"]): boolean {
	return branch.some(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === NUDGE_BUDGET_ENTRY_TYPE &&
			isNudgeBudgetEntry(entry.data) &&
			entry.data.nudge === nudge,
	);
}

function hasEmptyList(state: TaskState): boolean {
	return selectVisibleTasks(state).length === 0;
}

function hasOpenTodos(state: TaskState): boolean {
	return state.tasks.some((task) => task.status === "pending" || task.status === "in_progress");
}

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

function isReminder(message: SettleMessage | undefined, type: string = PLAN_REMINDER_MESSAGE_TYPE): boolean {
	return message?.role === "custom" && message.customType === type;
}

/**
 * True when a reminder already followed the latest user prompt: the run was
 * reminded once, so let it settle. Stateless, so it survives `/reload`.
 */
export function remindedSinceLastPrompt(
	messages: readonly SettleMessage[],
	type: string = PLAN_REMINDER_MESSAGE_TYPE,
): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isReminder(messages[i], type)) return true;
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

/** Why an `in_progress` todo is still open at a settle, most actionable first. */
export type InProgressKind =
	| "abandoned"
	| "lost"
	| "elsewhere"
	| "held"
	| "monitored"
	| "silent"
	| "blocked"
	| "running";

/** A settle report: the line, its severity and a key that changes whenever the classification does. */
export interface InProgressNotice {
	text: string;
	level: "info" | "warning";
	key: string;
}

/** Open statuses: a `blockedBy` dependency in one of these has not delivered yet. */
const OPEN = new Set(["pending", "in_progress", "deferred"]);

/**
 * Groups in report order. `warning` groups need the parent and repeat on every settle; `info`
 * groups wait on something that will wake it. Capped groups name three then count the rest;
 * `showDepStatus` groups name each blocker's status, since those blockers are why nothing moves.
 */
const GROUPS: ReadonlyArray<{
	kind: InProgressKind;
	label: string;
	capped: boolean;
	severity: InProgressNotice["level"];
	showDepStatus: boolean;
}> = [
	{
		kind: "abandoned",
		label: "owner agent failed or stopped",
		capped: false,
		severity: "warning",
		showDepStatus: false,
	},
	{
		kind: "lost",
		label: "owner agent not found after resume",
		capped: false,
		severity: "warning",
		showDepStatus: false,
	},
	{
		kind: "elsewhere",
		label: "agent running for another session, which it wakes instead of this one",
		capped: true,
		severity: "info",
		showDepStatus: false,
	},
	{ kind: "held", label: "held by the parent", capped: true, severity: "warning", showDepStatus: true },
	{
		kind: "monitored",
		label: "waiting on a monitor, which wakes the parent",
		capped: true,
		severity: "info",
		showDepStatus: false,
	},
	{
		kind: "silent",
		label: "agent running without a completion notice",
		capped: true,
		severity: "warning",
		showDepStatus: false,
	},
	{ kind: "blocked", label: "blocked", capped: true, severity: "info", showDepStatus: false },
	{ kind: "running", label: "agent running", capped: true, severity: "info", showDepStatus: false },
];

/** The owner key each `in_progress` todo had when its session resumed, by todo id. */
type Owners = ReadonlyMap<number, string | undefined>;

/** What a settle knows besides the todo list and agent states. */
export interface SettleFacts {
	/** Owners present at resume, see `classify`. */
	resumed?: Owners;
	/** Whether a running agent's completion notice will wake the parent session-wide; monitors arm only their linked todos. */
	armed?: boolean;
	/** Running monitors started for a todo, by todo id, see `monitorsByTodo`. */
	monitors?: ReadonlyMap<number, string>;
}

/** One classified `in_progress` todo. `deps` are the open blockers its group is about. */
interface Row {
	task: Task;
	kind: InProgressKind;
	agent: AgentRunState | undefined;
	deps: readonly Task[];
	/** The linked running monitor's name, for a `monitored` row. */
	monitor?: string;
}

/** Whether an agent is still running or queued, regardless of its wake eligibility. */
function isWorking(agent: AgentRunState | undefined): boolean {
	return agent === "running" || agent === "queued";
}

/**
 * Whether an open dependency is being worked: `in_progress` with no failed or stopped owner, or
 * `pending` with a running or queued owner whose completion notice wakes the parent. A deferred or unowned pending one never
 * delivers on its own, so a todo waiting only on those is the parent's to unblock.
 */
function isLive(dep: Task, lookup: AgentStateLookup): boolean {
	const agent = lookup(dep.owner);
	if (dep.status === "in_progress") return !isAbandoned(dep, agent);
	return dep.status === "pending" && isWorking(agent) && lookup.wakesParent?.(dep.owner) === true;
}

/**
 * Classify one `in_progress` todo. Its owner's failed or stopped agent makes it abandoned; a running
 * or queued one either has a verified wake or warns as silent; else a live `blockedBy` dependency makes it wait; anything else, including a todo
 * whose agent is done or whose open blockers are all dead, waits on the parent.
 */
function classify(
	task: Task,
	byId: ReadonlyMap<number, Task>,
	lookup: AgentStateLookup,
	resumed: Owners,
	monitors: ReadonlyMap<number, string>,
): Row {
	const agent = lookup(task.owner);
	if (isAbandoned(task, agent)) return { task, kind: "abandoned", agent, deps: [] };
	// Children die with the process, so an owner already set when the session resumed that no
	// agent event has named since is gone, not the parent's to hold.
	const owner = ownerKey(task.owner);
	if (agent === undefined && owner !== undefined && resumed.get(task.id) === owner)
		return { task, kind: "lost", agent, deps: [] };
	// Running for another session, which it wakes: not ours to take over or wait on.
	if (agent === undefined && lookup.elsewhere?.(task.owner) === true)
		return { task, kind: "elsewhere", agent, deps: [] };
	if (isWorking(agent))
		return { task, kind: lookup.wakesParent?.(task.owner) === true ? "running" : "silent", agent, deps: [] };
	// A running monitor started for this todo wakes the parent on its match or exit.
	const monitor = monitors.get(task.id);
	if (monitor !== undefined) return { task, kind: "monitored", agent, deps: [], monitor };
	const open = (task.blockedBy ?? []).flatMap((id) => {
		const dep = byId.get(id);
		return dep && OPEN.has(dep.status) ? [dep] : [];
	});
	const live = open.filter((dep) => isLive(dep, lookup));
	if (live.length) return { task, kind: "blocked", agent, deps: live };
	return { task, kind: "held", agent, deps: open };
}

/** One todo's entry: owner and agent state, plus blockers by id and optionally status. */
function entryText({ task, agent, deps, monitor }: Row, showDepStatus: boolean): string {
	const owner = ownerLabel(task.owner);
	const details = [];
	if (owner) details.push(agent ? `${owner} ${agent}` : owner);
	if (monitor !== undefined) details.push(`monitor ${sanitizeTerminalText(monitor)}`);
	if (deps.length)
		details.push(`by ${deps.map((d) => (showDepStatus ? `#${d.id} ${d.status}` : `#${d.id}`)).join(", ")}`);
	const detail = details.length ? ` (${details.join("; ")})` : "";
	return `#${task.id} ${sanitizeTerminalText(task.subject)}${detail}`;
}

/** The dedupe key: whether a wake is armed, plus every todo's group, owner, agent state and blockers. */
function reportKey(rows: readonly Row[], lookup: AgentStateLookup, armed: boolean): string {
	return JSON.stringify([
		armed,
		rows.map(({ task, kind, agent, deps, monitor }) => [
			task.id,
			kind,
			task.owner ?? null,
			agent ?? null,
			monitor ?? null,
			deps.map((d) => [d.id, d.status, d.owner ?? null, lookup(d.owner) ?? null]),
		]),
	]);
}

function classifyAll(
	state: TaskState,
	lookup: AgentStateLookup,
	resumed: Owners = new Map(),
	monitors: ReadonlyMap<number, string> = new Map(),
): Row[] {
	const byId = new Map(state.tasks.map((t) => [t.id, t]));
	return state.tasks
		.filter((t) => t.status === "in_progress")
		.map((task) => classify(task, byId, lookup, resumed, monitors));
}

/**
 * The `in_progress` todos only the parent can move: parent-held, or owned by an agent that no longer
 * exists. Empty when a background agent's completion notice is armed (monitors arm only the todos they are linked to, which are not held), since it will be woken without a nudge.
 */
export function unarmedHeld(state: TaskState, lookup: AgentStateLookup, facts: SettleFacts): Task[] {
	if (facts.armed) return [];
	return classifyAll(state, lookup, facts.resumed, facts.monitors)
		.filter((r) => r.kind === "held" || r.kind === "lost")
		.map((r) => r.task);
}

/** The transient reminder for `unarmedHeld` todos; the `context` hook swaps it in for the marker. */
export function formatHeldReminder(tasks: readonly Task[]): string {
	return [
		"Nothing is armed to wake you: no running background agent with a completion notice and no running monitor linked to them with `todo`. These todos are still in_progress and only you can move them:",
		...tasks.map((t) => {
			const owner = ownerLabel(t.owner);
			return `- #${t.id} ${sanitizeTerminalText(t.subject)}${owner ? ` (${owner})` : ""}`;
		}),
		"Keep working on them now. If one is actually done, complete it with evidence; if it cannot proceed, defer it with a reason. If you are waiting on something external, start a monitor or background agent that wakes you, or tell the user exactly what is pending. If a running monitor is a todo's continuation, monitor_stop it and monitor_start it again with todo: <id>. Do not end the turn by announcing an action you have not taken.",
	].join("\n");
}

/** The one-shot list for the first request after a compaction: every open todo, in id order. */
export function formatCompactionList(state: TaskState): string {
	const byId = new Map(state.tasks.map((t) => [t.id, t]));
	const open = state.tasks.filter((t) => t.status === "pending" || t.status === "in_progress");
	return [
		"[rpiv-todo] The conversation was compacted, so here is the todo list it no longer shows. These todos are still open:",
		...open.map((t) => {
			const owner = ownerLabel(t.owner);
			const blockers = (t.blockedBy ?? []).filter((id) => OPEN.has(byId.get(id)?.status ?? "deleted"));
			const details = [owner, blockers.length ? `blocked by ${blockers.map((id) => `#${id}`).join(", ")}` : ""];
			const detail = details.filter(Boolean).join("; ");
			return `- #${t.id} ${t.status} ${sanitizeTerminalText(t.subject)}${detail ? ` (${detail})` : ""}`;
		}),
		"They already exist: update them by id with `todo`, do not recreate them. Complete only with evidence and defer with a reason.",
	].join("\n");
}

/**
 * The report of `in_progress` todos a run stopped with, or `undefined` when there are none.
 * Same shape as the `subagents` and `session-kit` monitor settle notices,
 * `Run ended with N <work>, armed: <what wakes the parent>`. Todos arm nothing themselves, so the
 * armed clause says so and defers to those notices for session-wide wakes rather than reading as
 * "nothing is armed"; when a row is `monitored` it names the monitored todos instead. Each todo is then named under one group: failed or stopped owners uncapped,
 * the rest three per group. Its level is the most severe group's.
 */
export function formatInProgressNotice(
	state: TaskState,
	lookup: AgentStateLookup = NO_AGENT_STATE,
	facts: SettleFacts = {},
): InProgressNotice | undefined {
	const rows = classifyAll(state, lookup, facts.resumed, facts.monitors);
	if (!rows.length) return undefined;
	const armed = facts.armed === true;
	const present = GROUPS.filter(({ kind }) => rows.some((r) => r.kind === kind));
	const parts = present.map(({ kind, label, capped, showDepStatus }) => {
		const items = rows.filter((r) => r.kind === kind).map((r) => entryText(r, showDepStatus));
		const shown = capped ? items.slice(0, 3) : items;
		const more = items.length > shown.length ? `, +${items.length - shown.length} more` : "";
		return `${label}: ${shown.join(", ")}${more}`;
	});
	const n = rows.length;
	const monitored = rows.filter((r) => r.kind === "monitored").map((r) => `#${r.task.id}`);
	const armedClause = monitored.length
		? `monitor for ${monitored.join(", ")}`
		: "no todo-owned wake (agent notices list session wakes; unlinked monitors arm no todo)";
	const text = `Run ended with ${n} in_progress todo${n === 1 ? "" : "s"}, armed: ${armedClause}; ${parts.join("; ")}`;
	// Parent-held work only warns when nothing is armed; with a wake armed it is shown once like the rest.
	const level = present.some((g) => g.severity === "warning" && !(armed && g.kind === "held")) ? "warning" : "info";
	return { text, level, key: reportKey(rows, lookup, armed) };
}

/**
 * Register the plan-approval listener and the wrap-up reminder.
 *
 * Parameters:
 * - `onStateChange(sessionId)`: refresh the overlay after a plan approval
 *   changed that session's list.
 */
export interface PlanSessionHooks {
	/**
	 * Count one tool result toward the empty-list nudge. Feed it from `message_end`: core emits
	 * tool-result messages one at a time in assistant source order, while parallel
	 * `tool_execution_end` events run concurrently and an earlier extension's handler can reorder them.
	 */
	toolFinished(event: ToolCompletion, ctx: ExtensionContext): void;
	/**
	 * Call from `session_start` after replay: binds the session and applies a pending approval.
	 * `resumed` is true only for a process `startup`: `/new`, `/resume`, `/fork` and `/reload` detach live agents instead, so no owner is provably lost.
	 */
	sessionStarted(
		sessionId: string,
		resumed: boolean,
		branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>,
		mode: ExtensionContext["mode"],
	): Promise<void>;
	/** Call from `session_compact` after replay: the next request outside Plan mode gets the open list once. */
	sessionCompacted(sessionId: string): void;
	/** Whether `sessionId`'s next request outside Plan mode gets the open list: the pending flag `sessionCompacted` sets. */
	compactionListPending(sessionId: string): boolean;
	/** Call from `session_shutdown`. */
	sessionEnded(sessionId: string): void;
}

export function registerPlanHooks(
	pi: ExtensionAPI,
	onStateChange: (sessionId: string) => Promise<void>,
	/** Called at every settle: re-ask where other sessions' survivors stand before classifying. */
	refreshSurvivors: (sessionId: string) => void,
	options: { homeDir?: string },
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
			// A changed approval always carries the plan it installed.
			plan: result.state.plan!,
		};
		pi.appendEntry(STATE_ENTRY_TYPE, snapshot);
		await onStateChange(payload.sessionId);
	};

	pi.events.on(PLAN_APPROVED_EVENT, async (data) => {
		if (!isPlanApprovedPayload(data)) return;
		if (live.has(data.sessionId)) await seed(data);
		else pending.set(data.sessionId, data);
	});

	// Owners `in_progress` todos already had when a session resumed. Children die with the process,
	// so any of these that no agent event names afterwards is lost rather than parent-held.
	const resumedOwners = new Map<string, Map<number, string | undefined>>();
	const settleFacts = (id: string): SettleFacts => ({
		resumed: resumedOwners.get(id),
		armed: hasArmedAgent(id),
		monitors: monitorsByTodo(id),
	});

	const reminderDraft = (
		event: AgentBeforeSettleEvent,
		customType: string,
		content: string,
		details: Record<string, readonly number[]>,
	): AgentBeforeSettleEventResult => {
		const draft: SessionBoundaryDraft = {
			type: "custom_message",
			customType,
			content,
			display: false,
			details,
		};
		return { entries: [...event.entries, draft], continue: true };
	};

	const stale = trackStaleLists();
	// Sessions compacted since their last request outside Plan mode. In memory only, see the README.
	const compacted = new Set<string>();
	const parentTuiSessions = new Set<string>();
	// Core needs a persisted non-assistant tail to accept a continuation after a normal reply.
	// Keep the permission to expand that placeholder request-local, not in the restored branch.
	const pendingNudges = new Map<string, string>();
	// The spent budget is bookkeeping: a custom entry outside the projected context, ahead of the marker.
	const nudge = (
		id: string,
		event: AgentBeforeSettleEvent,
		kind: NudgeBudgetEntry["nudge"],
	): AgentBeforeSettleEventResult => {
		const { type, marker } = NUDGE_MARKERS[kind];
		pendingNudges.set(id, type);
		const data: NudgeBudgetEntry = { persistenceVersion: 1, nudge: kind };
		const budget: SessionBoundaryDraft = { type: "custom", customType: NUDGE_BUDGET_ENTRY_TYPE, data };
		return reminderDraft({ ...event, entries: [...event.entries, budget] }, type, marker, {});
	};
	const emptyConfig = getEmptyReminderConfig(options.homeDir);
	const childActivation = isChildActivation();
	const emptyTrackers = new Map<string, ReturnType<typeof trackEmptyReminder>>();

	const onSettle: SettleHandler = (event, ctx) => {
		const messages = event.context.contextMessages;
		const completed = event.outcome === "completed";
		const planning = completed && isPlanning(ctx, messages);
		const id = sid(ctx);
		if (completed && !planning) refreshSurvivors(id);
		const state = getState(id);
		if (emptyTrackers.get(id)?.beforeSettle(completed, planning, hasEmptyList(state))) {
			return nudge(id, event, "empty");
		}
		if (!completed || planning) return undefined;
		if (!remindedSinceLastPrompt(messages)) {
			const open = selectOpenPlanItems(state);
			if (open.length)
				return reminderDraft(event, PLAN_REMINDER_MESSAGE_TYPE, PLAN_REMINDER_MARKER, {
					open: open.map((t) => t.id),
				});
		}
		// Held work with nothing armed can never wake the parent: remind once per prompt, not every settle.
		if (!remindedSinceLastPrompt(messages, HELD_REMINDER_MESSAGE_TYPE)) {
			const held = unarmedHeld(state, agentLookup(id), settleFacts(id));
			if (held.length)
				return reminderDraft(event, HELD_REMINDER_MESSAGE_TYPE, HELD_REMINDER_MARKER, { held: held.map((t) => t.id) });
		}
		// Age only completed settles that would otherwise stop, independent of any armed wake.
		if (!parentTuiSessions.has(id) || !hasOpenTodos(state)) return undefined;
		return stale.due(id, state, getStaleAfterSettles(options.homeDir)) ? nudge(id, event, "stale") : undefined;
	};
	pi.on("agent_before_settle", onSettle);

	// A settle with `in_progress` todos is a stop with owned work pending. The reminder above only
	// covers plan items and only once, so report the state instead of leaving a quiet prompt. A warning
	// (abandoned or parent-held work) repeats on every settle, so that stop is never silent. An info
	// report (everything waits on a running agent or a live dependency, which will wake the parent)
	// is shown once per change: it returns when a todo changes group, agent state or blockers, or
	// after the next prompt from a person. Monitor and agent wakes arrive via `pi.sendMessage`, which
	// runs no `input` handlers; extension prompts (`sendUserMessage`) arrive as `extension`.
	const reported = new Map<string, string>();
	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return;
		const id = sid(ctx);
		reported.delete(id);
		stale.rearm(id);
		pendingNudges.delete(id);
		emptyTrackers.get(id)?.humanInput();
	});
	pi.on("agent_settled", (event, ctx) => {
		const id = sid(ctx);
		pendingNudges.delete(id);
		const planning = isPlanning(ctx, []);
		emptyTrackers.get(id)?.settled(event.aborted, planning);
		if (planning) return;
		refreshSurvivors(id);
		const notice = formatInProgressNotice(getState(id), agentLookup(id), settleFacts(id));
		if (notice?.level === "info") {
			if (reported.get(id) === notice.key) return;
			reported.set(id, notice.key);
		} else reported.delete(id);
		if (notice) ctx.ui.notify(notice.text, notice.level);
	});

	pi.on("context", async (event, ctx) => {
		const id = sid(ctx);
		const pendingNudge = pendingNudges.get(id);
		pendingNudges.delete(id);
		// Plan mode keeps a pending compaction list for the first request after it.
		if (isPlanning(ctx, event.messages)) return undefined;
		const state = getState(id);
		const swapped = swapMarker(id, event.messages, pendingNudge, state);
		// One request only: an empty open list spends the pending compaction list too.
		if (!compacted.delete(id) || !hasOpenTodos(state)) return swapped && { messages: swapped };
		// Appended last, like the reminders, so later requests keep the cached prefix.
		const list = {
			role: "custom",
			customType: COMPACTION_LIST_MESSAGE_TYPE,
			content: formatCompactionList(state),
			display: false,
			timestamp: Date.now(),
		} as (typeof event.messages)[number];
		return { messages: [...(swapped ?? event.messages), list] };
	});

	/** The request's messages with a trailing reminder marker expanded, or `undefined` to keep them. */
	function swapMarker<M>(
		id: string,
		messages: readonly M[],
		pendingNudge: string | undefined,
		state: TaskState,
	): M[] | undefined {
		const last = messages[messages.length - 1] as SettleMessage | undefined;
		if (isReminder(last, HELD_REMINDER_MESSAGE_TYPE)) refreshSurvivors(id);
		let content: string;
		if (isReminder(last)) {
			if (!selectOpenPlanItems(state).length) return undefined;
			content = formatPlanReminder(state);
		} else if (isReminder(last, HELD_REMINDER_MESSAGE_TYPE)) {
			const held = unarmedHeld(state, agentLookup(id), settleFacts(id));
			if (!held.length) return undefined;
			content = formatHeldReminder(held);
		} else if (isReminder(last, STALE_REMINDER_MESSAGE_TYPE)) {
			if (pendingNudge !== STALE_REMINDER_MESSAGE_TYPE || !hasOpenTodos(state)) return undefined;
			content =
				"The open todo list has not changed for several settles. Run `todo` with action `list` and reconcile it with what actually happened. Complete only with evidence, defer with a reason, and leave work that is still running open.";
		} else if (isReminder(last, EMPTY_REMINDER_MESSAGE_TYPE)) {
			if (pendingNudge !== EMPTY_REMINDER_MESSAGE_TYPE || !hasEmptyList(state)) return undefined;
			content =
				"You have been working without a todo list. If this work has multiple steps, use `todo` to record what is still open before continuing. Do not create tasks for a simple request that is already done.";
		} else return undefined;
		const swapped = [...messages];
		swapped[swapped.length - 1] = { ...(last as object), content } as M;
		return swapped;
	}

	return {
		toolFinished(event, ctx) {
			const id = sid(ctx);
			emptyTrackers.get(id)?.toolFinished(event, hasEmptyList(getState(id)) && !isPlanning(ctx, []));
		},
		async sessionStarted(sessionId, resumed, branch, mode) {
			live.add(sessionId);
			pendingNudges.delete(sessionId);
			compacted.delete(sessionId);
			const parentTui = mode === "tui" && !childActivation;
			if (parentTui) {
				parentTuiSessions.add(sessionId);
				// A persisted user message could be an extension prompt; only a live
				// human input event can safely rearm after restoring a spent budget.
				if (budgetSpent(branch, "stale")) stale.spend(sessionId);
			} else parentTuiSessions.delete(sessionId);
			if (parentTui && emptyConfig.toolCalls > 0) {
				emptyTrackers.set(sessionId, trackEmptyReminder(emptyConfig, budgetSpent(branch, "empty")));
			} else {
				emptyTrackers.delete(sessionId);
			}
			if (resumed)
				resumedOwners.set(
					sessionId,
					new Map(
						getState(sessionId)
							.tasks.filter((t) => t.status === "in_progress")
							.map((t) => [t.id, ownerKey(t.owner)]),
					),
				);
			else resumedOwners.delete(sessionId);
			const payload = pending.get(sessionId);
			pending.delete(sessionId);
			if (payload) await seed(payload);
		},
		sessionCompacted(sessionId) {
			compacted.add(sessionId);
		},
		compactionListPending(sessionId) {
			return compacted.has(sessionId);
		},
		sessionEnded(sessionId) {
			live.delete(sessionId);
			reported.delete(sessionId);
			resumedOwners.delete(sessionId);
			stale.rearm(sessionId);
			compacted.delete(sessionId);
			parentTuiSessions.delete(sessionId);
			pendingNudges.delete(sessionId);
			emptyTrackers.delete(sessionId);
		},
	};
}
