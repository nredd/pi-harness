/**
 * todo tool + /todos command — thin registration shell.
 *
 * Tool/command identity, schema, types, reducer, store, replay, response
 * envelope, selectors, and view formatters live in the layered modules under
 * `tool/`, `state/`, and `view/`. This file is the package-root registration
 * surface — it mirrors `packages/rpiv-ask-user-question/ask-user-question.ts`
 * which keeps the tool registration at the package root.
 *
 * Public re-exports below preserve the package-root import surface so that
 * `index.ts`, `todo-overlay.ts`, and the global `test/setup.ts` `beforeEach`
 * continue to import from `./todo.js`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, validateGuidanceFields } from "./config.ts";
import { formatProgress, t } from "./state/i18n-bridge.ts";
import { isTaskDetails } from "./state/replay.ts";
import { selectTasksByStatus, selectVisibleTasks } from "./state/selectors.ts";
import type { TaskState } from "./state/state.ts";
import { applyTaskCall, changesState } from "./state/state-reducer.ts";
import {
	commitState,
	getRenderState,
	getState,
	type RenderStateObserver,
	sid,
	watchRenderState,
} from "./state/store.ts";
import { buildToolResult } from "./tool/response-envelope.ts";
import { sanitizeTerminalText } from "./tool/sanitize.ts";
import {
	COMMAND_NAME,
	ERR_REQUIRES_INTERACTIVE,
	MSG_NO_TODOS,
	STATE_ENTRY_TYPE,
	type TaskMutationParams,
	TOOL_LABEL,
	TOOL_NAME,
	TodoParamsSchema,
} from "./tool/types.ts";
import { formatCommandTaskLine, renderTodoCall, renderTodoResult } from "./view/format.ts";

// English fallbacks for localized /todos section headers — the box-drawing
// decoration is part of the localized string so translators can adjust spacing.
const SECTION_PENDING = "── Pending ──";
const SECTION_IN_PROGRESS = "── In Progress ──";
const SECTION_COMPLETED = "── Completed ──";
const SECTION_DEFERRED = "── Deferred ──";

// ---------------------------------------------------------------------------
// Public re-exports — existing consumers (overlay, tests, index.ts) keep
// importing from `./todo.js`. New code may opt into deeper imports.
// ---------------------------------------------------------------------------

export { isTransitionValid } from "./state/invariants.ts";
export { applyTaskCall, applyTaskMutation } from "./state/state-reducer.ts";
export { __resetState, getNextId, getTodos, setActiveRenderSession, sid } from "./state/store.ts";
export { deriveBlocks, detectCycle } from "./state/task-graph.ts";
export type { Task, TaskAction, TaskDetails, TaskStatus } from "./tool/types.ts";
export { TOOL_NAME } from "./tool/types.ts";

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export const DEFAULT_PROMPT_SNIPPET = "Manage a task list to track multi-step progress";
export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	"Use `todo` for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.",
	"When starting a task from the todo list, mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done — never batch completions. Exactly one task in_progress at a time.",
	"Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors — keep it in_progress and create a new task for the blocker instead.",
	"Task status: pending → in_progress → completed, plus deferred (descoped, needs a reason) and deleted as a tombstone. Pass activeForm (present-continuous label, e.g. 'researching existing tool') when marking in_progress.",
	'To change a task\'s status, call update with the task id and the target status, e.g. {"action":"update","id":3,"status":"in_progress","activeForm":"writing tests"}. status is the field that changes the task; an update without a mutable field (status or another) is rejected.',
	'Marking a task completed requires evidence: the check that proves it (command + result, commit, or test name), e.g. {"action":"update","id":3,"status":"completed","evidence":"npm test: 42 passed"}. No evidence means it is not done.',
	"Todos marked [plan] preserve the approved plan's text: their subject and description cannot change and they cannot be deleted. Update activity labels, ownership, dependencies, or metadata as needed. Complete each with evidence, or defer with a reason and tell the user. Never tell the user the work is done while plan items are open.",
	"Use blockedBy to express dependencies (A is blocked by B). On create, pass blockedBy as the initial set. On update, use addBlockedBy / removeBlockedBy (additive merge — do not resend the full array). Cycles are rejected.",
	'Batch with ops: to open or close many todos, pass ONE call {"ops":[{"action":"update","id":1,"status":"completed","evidence":"..."}, ...]} instead of one call per todo. Each op carries its own evidence/reason. A batch is atomic: if any op is invalid nothing changes and the error names the op (ops[3]: ...). list/get ops are answered from the final state. Do not mix ops with top-level fields.',
	"list hides tombstoned (deleted) tasks by default; pass includeDeleted:true to see them. Pass status to filter by a single status.",
	"Subject must be short and imperative (e.g. 'Research existing tool'); description is for long-form detail. activeForm is a present-continuous label shown while in_progress.",
];

export function registerTodoTool(pi: ExtensionAPI): void {
	const guidance = validateGuidanceFields(loadConfig().guidance);
	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description:
			"Manage a task list for tracking multi-step progress. Actions: create (new task), update (change status/fields/dependencies), list (all tasks, optionally filtered by status), get (single task details), delete (tombstone), clear (reset all). Status: pending → in_progress → completed, plus deleted tombstone. Use this to plan and track multi-step work like research, design, and implementation.",
		promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
		parameters: TodoParamsSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const before = getState(sid(ctx));
			const result = applyTaskCall(before, params as TaskMutationParams);
			commitState(sid(ctx), result.state);
			notifyPlanDeferral(ctx, before, result.state);
			const toolResult = buildToolResult(result.action, params as TaskMutationParams, result.state, result.op);
			// Persist the snapshot as a custom entry on the calling session's branch, however the
			// tool was reached: a call made through another tool (`ctx.executeTool`, e.g. codemode)
			// never lands as a standalone `toolResult`, so its `details` alone would not survive
			// replay. Pi's own codemode persists its `store()` the same way.
			if (changesState(result.op))
				pi.appendEntry(STATE_ENTRY_TYPE, { ...toolResult.details, persistenceVersion: 1 });
			return toolResult;
		},

		// `ToolRenderContext` has no session identity, so a call renders from the
		// foreground while it is running. Once it settles, its shared render state
		// holds the result snapshot -- never search another session because ids can
		// collide between foreground and child task slots.
		renderCall(args, theme, context) {
			const state = context?.state as ({ taskSnapshot?: TaskState } & RenderStateObserver) | undefined;
			// Legacy/error rows without a result snapshot still read the live store.
			// A repaint alone cannot refresh Pi's settled-row cache. Subscribe weakly
			// instead of polling forever; valid historical snapshots remain immutable.
			if (state && !state.taskSnapshot && !context?.probe && context?.invalidate) {
				state.onRenderStateChange = () => {
					if (!state.taskSnapshot) context.invalidate();
				};
				watchRenderState(state);
			}
			return renderTodoCall(args as never, theme, state?.taskSnapshot ?? getRenderState());
		},

		renderResult(result, opts, theme, context) {
			// Pi shares `state` between this result and its call renderer. Once the
			// call settles, preserve the result's immutable transcript snapshot so
			// historical rows never resolve an id against today's foreground tasks.
			// The first result render happens while Pi is building the collapsed row,
			// so invalidate on the next microtask after that row commits. Probes
			// receive disposable state and a no-op invalidator, and must stay effect-free.
			const probe = (context as { probe?: boolean } | undefined)?.probe === true;
			const details = result.details;
			const state = context?.state as { taskSnapshot?: TaskState } | undefined;
			if (state && !probe && !opts.isPartial && state.taskSnapshot === undefined && isTaskDetails(details)) {
				state.taskSnapshot = { tasks: details.tasks, nextId: details.nextId };
				queueMicrotask(() => context?.invalidate());
			}
			return renderTodoResult(result, theme, opts);
		},
	});
}

/**
 * Descoping a plan item is the user's call to review, so tell them directly
 * instead of trusting the model to mention it. Headless runs have no UI.
 */
function notifyPlanDeferral(
	ctx: { hasUI?: boolean; ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
	before: TaskState,
	after: TaskState,
): void {
	if (!ctx.hasUI) return;
	for (const task of after.tasks) {
		if (task.source !== "plan" || task.status !== "deferred") continue;
		const previous = before.tasks.find((candidate) => candidate.id === task.id);
		if (previous?.source === "plan" && previous.status === "deferred" && previous.reason === task.reason) continue;
		ctx.ui.notify(
			`Plan item deferred: #${task.id} ${sanitizeTerminalText(task.subject)} -- ${sanitizeTerminalText(task.reason ?? "")}`,
			"warning",
		);
	}
}

// ---------------------------------------------------------------------------
// /todos slash command
// ---------------------------------------------------------------------------

export function registerTodosCommand(pi: ExtensionAPI): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "Show all todos on the current branch, grouped by status",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(t("command.requires_interactive", ERR_REQUIRES_INTERACTIVE), "error");
				return;
			}
			const state = getState(sid(ctx));
			const visible = selectVisibleTasks(state);
			if (visible.length === 0) {
				ctx.ui.notify(t("command.no_todos", MSG_NO_TODOS), "info");
				return;
			}
			const groups = selectTasksByStatus(state);

			const lines: string[] = [formatProgress(state)];
			if (groups.pending.length > 0) {
				lines.push(t("command.section.pending", SECTION_PENDING));
				for (const task of groups.pending) lines.push(formatCommandTaskLine(task, "○"));
			}
			if (groups.inProgress.length > 0) {
				lines.push(t("command.section.in_progress", SECTION_IN_PROGRESS));
				for (const task of groups.inProgress) lines.push(formatCommandTaskLine(task, "◐"));
			}
			if (groups.completed.length > 0) {
				lines.push(t("command.section.completed", SECTION_COMPLETED));
				for (const task of groups.completed) lines.push(formatCommandTaskLine(task, "✓"));
			}
			if (groups.deferred.length > 0) {
				lines.push(t("command.section.deferred", SECTION_DEFERRED));
				for (const task of groups.deferred) lines.push(formatCommandTaskLine(task, "⊖"));
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
