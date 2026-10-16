import { selectPlanProgress } from "../state/plan.ts";
import type { TaskState } from "../state/state.ts";
import type { Op } from "../state/state-reducer.ts";
import { deriveBlocks } from "../state/task-graph.ts";
import { sanitizeTerminalText } from "./sanitize.ts";
import type { Task, TaskAction, TaskDetails, TaskMutationParams } from "./types.ts";

/**
 * Format a single task as a `[status] #id subject [(activeForm)] [⛓ #dep,…]`
 * line. Used by the `list` content branch only — the overlay and `/todos`
 * formatting paths use `view/format.ts` for richer presentations.
 */
function formatListLine(t: Task): string {
	const block = t.blockedBy?.length ? ` ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
	const form = t.status === "in_progress" && t.activeForm ? ` (${sanitizeTerminalText(t.activeForm)})` : "";
	const plan = t.source === "plan" ? ` [plan${t.planGroup ? `: ${sanitizeTerminalText(t.planGroup)}` : ""}]` : "";
	const lines = [`[${t.status}] #${t.id} ${sanitizeTerminalText(t.subject)}${form}${block}${plan}`];
	// Open plan items carry their verbatim nested plan text, so the model works
	// from the plan, not from a paraphrase of it.
	if (t.planText && (t.status === "pending" || t.status === "in_progress")) {
		lines.push(...indented(t.planText));
	}
	if (t.evidence) lines.push(`    evidence: ${sanitizeTerminalText(t.evidence)}`);
	if (t.evidence && t.planProvenance) {
		lines.push(
			`    carried from plan ${sanitizeTerminalText(t.planProvenance.planId)} task #${t.planProvenance.taskId}`,
		);
	}
	if (t.reason) lines.push(`    deferred: ${sanitizeTerminalText(t.reason)}`);
	return lines.join("\n");
}

/** Multi-line verbatim text, each line sanitized and indented four spaces. */
function indented(text: string): string[] {
	return text.split("\n").map((line) => `    ${sanitizeTerminalText(line)}`);
}

/** `Plan: <title> -- N/M plan items open`, or nothing without plan items. */
function formatPlanHeader(state: TaskState): string | undefined {
	const progress = selectPlanProgress(state);
	if (!state.plan || !progress) return undefined;
	return `Plan: ${sanitizeTerminalText(state.plan.title)} -- ${progress.open}/${progress.total} plan items open`;
}

/**
 * Multi-line presentation for the `get` action. Order of rows is pinned by
 * pre-refactor `todo.ts:354-376` — description, activeForm, blockedBy, blocks,
 * owner — so envelope-level snapshot tests stay byte-equivalent.
 */
function formatGetLines(task: Task, state: TaskState): string {
	const blocks = deriveBlocks(state.tasks).get(task.id) ?? [];
	const lines = [`#${task.id} [${task.status}] ${sanitizeTerminalText(task.subject)}`];
	if (task.description) lines.push(`  description: ${sanitizeTerminalText(task.description)}`);
	if (task.activeForm) lines.push(`  activeForm: ${sanitizeTerminalText(task.activeForm)}`);
	if (task.blockedBy?.length) {
		lines.push(`  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
	}
	if (blocks.length) {
		lines.push(`  blocks: ${blocks.map((id) => `#${id}`).join(", ")}`);
	}
	if (task.owner) lines.push(`  owner: ${sanitizeTerminalText(task.owner)}`);
	if (task.source === "plan") {
		lines.push(`  plan item${task.planGroup ? `: ${sanitizeTerminalText(task.planGroup)}` : ""}`);
		if (task.planText) lines.push(...indented(task.planText));
	}
	if (task.evidence) lines.push(`  evidence: ${sanitizeTerminalText(task.evidence)}`);
	if (task.evidence && task.planProvenance) {
		lines.push(
			`  carried from plan ${sanitizeTerminalText(task.planProvenance.planId)} task #${task.planProvenance.taskId}`,
		);
	}
	if (task.reason) lines.push(`  deferred: ${sanitizeTerminalText(task.reason)}`);
	return lines.join("\n");
}

/**
 * Pure formatter: `(op, state) → string`. Closed switch on `op.kind` —
 * adding a new `Op` variant fails to compile here until a branch is added.
 * The strings on each branch are byte-equivalent to pre-refactor `todo.ts`
 * reducer output.
 */
export function formatContent(op: Op, state: TaskState): string {
	switch (op.kind) {
		case "create": {
			const task = op.task ?? state.tasks.find((candidate) => candidate.id === op.taskId);
			return task ? `Created #${task.id}: ${sanitizeTerminalText(task.subject)} (pending)` : `Created #${op.taskId}`;
		}
		case "update": {
			if (!op.changed) {
				return `No change: #${op.id} already matches the requested values (status: ${op.toStatus})`;
			}
			const transition = op.fromStatus !== op.toStatus ? ` (${op.fromStatus} → ${op.toStatus})` : "";
			const task = op.task ?? state.tasks.find((candidate) => candidate.id === op.id);
			if (task?.source === "plan" && op.deferredReason !== undefined) {
				return `Updated #${op.id}${transition}. Tell the user this plan item is descoped and why: ${sanitizeTerminalText(op.deferredReason)}`;
			}
			return `Updated #${op.id}${transition}`;
		}
		case "delete": {
			const task = op.task;
			return task
				? `Deleted #${task.id}: ${sanitizeTerminalText(task.subject)}`
				: `Deleted #${op.id}: ${sanitizeTerminalText(op.subject)}`;
		}
		case "clear":
			return op.kept > 0
				? `Cleared ${op.count} tasks; kept ${op.kept} plan items (complete them with evidence or defer them with a reason)`
				: `Cleared ${op.count} tasks`;
		case "list": {
			let view = state.tasks;
			if (!op.includeDeleted) view = view.filter((t) => t.status !== "deleted");
			if (op.statusFilter) view = view.filter((t) => t.status === op.statusFilter);
			const header = formatPlanHeader(state);
			const body = view.length === 0 ? "No tasks" : view.map(formatListLine).join("\n");
			return header ? `${header}\n${body}` : body;
		}
		case "get":
			return formatGetLines(op.task, state);
		case "batch": {
			const lines = op.results.map((result, index) => `[${index}] ${formatContent(result, state)}`);
			const header = formatPlanHeader(state);
			return [`Applied ${op.results.length} ops`, ...lines, ...(header ? [header] : [])].join("\n");
		}
		case "error":
			return `Error: ${op.message}`;
	}
}

/**
 * Build the LLM-facing tool envelope after the store has committed the
 * reducer's new state. `details` is the persistence + replay snapshot —
 * `state/replay.ts` consumes this exact shape on session lifecycle events.
 *
 * Mirrors `packages/rpiv-ask-user-question/tool/response-envelope.ts:13-47`.
 */
export function buildToolResult(
	action: TaskAction,
	params: TaskMutationParams,
	state: TaskState,
	op: Op,
): { content: Array<{ type: "text"; text: string }>; details: TaskDetails } {
	const text = formatContent(op, state);
	const details: TaskDetails = {
		action,
		params: params as Record<string, unknown>,
		tasks: state.tasks,
		nextId: state.nextId,
		...(op.kind === "error" ? { error: op.message } : {}),
		...(state.plan ? { plan: state.plan } : {}),
	};
	return { content: [{ type: "text", text }], details };
}
