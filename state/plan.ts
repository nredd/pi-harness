import type { PlanRef, Task } from "../tool/types.js";
import type { TaskState } from "./state.js";

/**
 * Approved-plan -> todos. Pure of module state: `parsePlanItems` turns plan
 * Markdown into verbatim items, `applyPlanApproval` swaps them into a
 * `TaskState`. The event wiring lives in `plan-hooks.ts`.
 */

/** One actionable plan item, text copied verbatim from the plan. */
export interface PlanItem {
	/** Nearest heading above the item, verbatim (`""` when the plan has no section headings). */
	group: string;
	/** The bullet's first line without its list marker, or the heading of a bullet-less section. */
	subject: string;
	/** Nested lines under the bullet (sub-bullets, continuation), dedented, verbatim. */
	detail?: string;
}

/**
 * Sections and list lead-ins that describe the plan rather than name work.
 * Matched against heading text or a `Lead-in:` paragraph, after stripping
 * Markdown emphasis and a leading section number.
 */
const CONTEXT_LABEL =
	/^(summary|overview|context|background|(key )?findings|not adopted|non-goals|out of scope|assumptions|risks|open questions|notes|references|alternatives( considered)?|rejected)\b/i;

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const BULLET = /^([-*+]|\d+[.)])\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;

function plainLabel(text: string): string {
	return text
		.replace(/[*_`]/g, "")
		.replace(/^\d+(\.\d+)*[.)]?\s+/, "")
		.trim();
}

function isContextLabel(text: string): boolean {
	return CONTEXT_LABEL.test(plainLabel(text));
}

function indentOf(line: string): number {
	return line.length - line.trimStart().length;
}

/** Remove the smallest common indentation from non-blank lines. */
function dedent(lines: readonly string[]): string[] {
	const indents = lines.filter((l) => l.trim()).map(indentOf);
	const cut = indents.length ? Math.min(...indents) : 0;
	return lines.map((l) => l.slice(Math.min(cut, indentOf(l))));
}

/** First `#` heading, else first non-empty line, else `plan`; Markdown emphasis stripped. */
export function planTitle(markdown: string): string {
	const lines = markdown.split("\n").map((l) => l.trim());
	const heading = lines.find((l) => /^#\s+\S/.test(l)) ?? lines.find((l) => HEADING.test(l));
	const raw = heading ? (HEADING.exec(heading)?.[2] ?? heading) : (lines.find(Boolean) ?? "");
	return raw.replace(/[*_`]/g, "").trim() || "plan";
}

/**
 * Parse plan Markdown into actionable items.
 *
 * - `##`+ headings are groups (the `#` title is not). A heading whose text is
 *   context (`Summary`, `Key findings`, `Not adopted`, `Assumptions`, ...)
 *   skips its whole subtree.
 * - Each top-level bullet (unordered or numbered) is one item; its nested
 *   lines are kept verbatim as `detail`, so nothing in the plan is
 *   paraphrased or dropped.
 * - A paragraph lead-in like `Not adopted:` skips the list that follows it.
 * - A non-context section with prose but no bullets becomes one item named
 *   by its heading.
 * - Fenced code never starts an item.
 */
export function parsePlanItems(markdown: string): PlanItem[] {
	const items: PlanItem[] = [];
	const headingStack: Array<{ level: number; text: string; context: boolean }> = [];
	let group = "";
	let sectionSkipped = false;
	let listSkipped = false;
	let sectionHasItems = false;
	let sectionHasProse = false;
	// `discard` swallows a skipped bullet together with its nested lines.
	let current: { item: PlanItem; base: number; lines: string[]; discard: boolean } | undefined;
	let inFence = false;

	const flushItem = () => {
		if (!current) return;
		if (current.discard) {
			current = undefined;
			return;
		}
		const lines = dedent(current.lines);
		while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
		if (lines.length) current.item.detail = lines.join("\n");
		items.push(current.item);
		current = undefined;
	};
	const flushSection = () => {
		flushItem();
		if (group && !sectionSkipped && !sectionHasItems && sectionHasProse) {
			items.push({ group, subject: group });
		}
	};

	for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
		if (FENCE.test(line)) inFence = !inFence;
		if (inFence || FENCE.test(line)) {
			if (current) current.lines.push(line);
			else if (!sectionSkipped && !listSkipped) sectionHasProse = true;
			continue;
		}

		const heading = HEADING.exec(line);
		if (heading && indentOf(line) === 0) {
			flushSection();
			const level = heading[1].length;
			const text = heading[2];
			while (headingStack.length && headingStack[headingStack.length - 1].level >= level) headingStack.pop();
			headingStack.push({ level, text, context: isContextLabel(text) });
			group = level === 1 ? "" : text;
			sectionSkipped = headingStack.some((h) => h.level > 1 && h.context);
			listSkipped = false;
			sectionHasItems = false;
			sectionHasProse = false;
			continue;
		}

		if (!line.trim()) {
			if (current) current.lines.push(line);
			continue;
		}

		const indent = indentOf(line);
		const bullet = BULLET.exec(line.trimStart());
		if (current && indent > current.base) {
			current.lines.push(line);
			continue;
		}

		if (bullet && (!current || indent <= current.base)) {
			flushItem();
			const discard = sectionSkipped || listSkipped;
			current = { item: { group, subject: bullet[2].trim() }, base: indent, lines: [], discard };
			if (!discard) sectionHasItems = true;
			continue;
		}

		// A paragraph at item level ends the current list.
		flushItem();
		if (sectionSkipped) continue;
		listSkipped = isContextLabel(line.trim()) && /:\s*$/.test(line.trim());
		if (!listSkipped) sectionHasProse = true;
	}
	flushSection();
	return items;
}

/** Key that identifies "the same item" across a re-approved plan. */
function itemKey(task: Pick<Task, "planGroup" | "subject" | "planText">): string {
	return JSON.stringify([task.planGroup ?? "", task.subject, task.planText ?? ""]);
}

export interface PlanApprovalResult {
	state: TaskState;
	/** False when `planId` is already the active plan (re-announcement). */
	changed: boolean;
}

/**
 * Replace the plan-sourced todos with the items of a newly approved plan.
 *
 * Agent-created todos are untouched, except that `blockedBy` references to
 * removed plan items are dropped. An item whose group, subject, and detail are
 * identical to an item of the previous plan keeps its status, evidence, and
 * reason, so re-approving a revised plan doesn't throw away proven work.
 */
export function applyPlanApproval(state: TaskState, planId: string, markdown: string): PlanApprovalResult {
	if (state.plan?.id === planId) return { state, changed: false };

	const previous = new Map<string, Task>();
	const removed = new Set<number>();
	for (const task of state.tasks) {
		if (task.source !== "plan") continue;
		removed.add(task.id);
		if (task.status !== "deleted") previous.set(itemKey(task), task);
	}

	let nextId = state.nextId;
	const planTasks: Task[] = parsePlanItems(markdown).map((item) => {
		const task: Task = { id: nextId++, subject: item.subject, status: "pending", source: "plan" };
		if (item.group) task.planGroup = item.group;
		if (item.detail) task.planText = item.detail;
		const prior = previous.get(itemKey(task));
		if (prior && (prior.status === "completed" || prior.status === "deferred")) {
			task.status = prior.status;
			if (prior.evidence) task.evidence = prior.evidence;
			if (prior.reason) task.reason = prior.reason;
		}
		return task;
	});

	const kept = state.tasks
		.filter((task) => task.source !== "plan")
		.map((task) => {
			if (!task.blockedBy?.some((id) => removed.has(id))) return task;
			const blockedBy = task.blockedBy.filter((id) => !removed.has(id));
			const next: Task = { ...task, blockedBy };
			if (!blockedBy.length) delete next.blockedBy;
			return next;
		});

	const plan: PlanRef = { id: planId, title: planTitle(markdown) };
	return { state: { tasks: [...planTasks, ...kept], nextId, plan }, changed: true };
}

/** Plan items still to do (`pending` / `in_progress`). */
export function selectOpenPlanItems(state: TaskState): readonly Task[] {
	return state.tasks.filter((t) => t.source === "plan" && (t.status === "pending" || t.status === "in_progress"));
}

/** `{ open, total }` over plan items, tombstones excluded; `undefined` without plan items. */
export function selectPlanProgress(state: TaskState): { open: number; total: number } | undefined {
	const items = state.tasks.filter((t) => t.source === "plan" && t.status !== "deleted");
	if (!items.length) return undefined;
	return { open: selectOpenPlanItems(state).length, total: items.length };
}
