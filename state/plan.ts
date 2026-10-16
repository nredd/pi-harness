import type { PlanRef, PlanTaskIdentity, Task } from "../tool/types.js";
import type { TaskState } from "./state.js";

/** Approved-plan parsing and deterministic reconciliation. */

/** One actionable plan item, with its exact source identity. */
export interface PlanItem {
	/** Nearest heading above the item, verbatim (`""` when the plan has no section headings). */
	group: string;
	/** The bullet's first line without its list marker, or the heading of a prose-only section. */
	subject: string;
	/** Nested bullet lines, or the full prose-only body, verbatim. */
	detail?: string;
	/** Stable source identity persisted on the seeded task. */
	identity: PlanTaskIdentity;
}

const CONTEXT_LABEL =
	/^(summary|overview|context|background|(key )?findings|not adopted|non-goals|out of scope|assumptions|risks|open questions|notes|references|alternatives( considered)?|rejected|decisions?|scope|diagnosis|current state|constraints|defaults?|goals?|success criteria|intent|compatibility|rationale|approved)\b/i;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const BULLET = /^([-*+]|\d+[.)])\s+(.*)$/;
const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})(?:.*)$/;

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

function dedent(lines: readonly string[]): string[] {
	const indents = lines.filter((line) => line.trim()).map(indentOf);
	const cut = indents.length ? Math.min(...indents) : 0;
	return lines.map((line) => line.slice(Math.min(cut, indentOf(line))));
}

/** First `#` heading, else first non-empty line, else `plan`; Markdown emphasis stripped. */
export function planTitle(markdown: string): string {
	const lines = markdown.split("\n").map((line) => line.trim());
	const heading = lines.find((line) => /^#\s+\S/.test(line)) ?? lines.find((line) => HEADING.test(line));
	const raw = heading ? (HEADING.exec(heading)?.[2] ?? heading) : (lines.find(Boolean) ?? "");
	return raw.replace(/[*_`]/g, "").trim() || "plan";
}

/**
 * Parse actionable work from plan Markdown. The parser deliberately handles
 * only headings, top-level bullets, prose-only sections, and fenced code: its
 * output is persisted, so exact source identity is more valuable than broad
 * Markdown interpretation.
 */
export function parsePlanItems(markdown: string): PlanItem[] {
	const items: PlanItem[] = [];
	const headings: Array<{ level: number; text: string; context: boolean; workContext?: string }> = [];
	let sectionSkipped = false;
	let listSkipped = false;
	let prose: string[] = [];
	// Code before any prose is retained only if prose later establishes a work item.
	let leadingCode: string[] = [];
	let sectionItems: PlanItem[] = [];
	let fence: { char: "`" | "~"; length: number; minIndent: number; maxIndent: number } | undefined;
	let current:
		| {
				group: string;
				path: string[];
				subject: string;
				base: number;
				contentIndent: number;
				detail: string[];
				body: string[];
				discard: boolean;
		  }
		| undefined;

	const path = () => headings.filter((heading) => heading.level > 1).map((heading) => heading.text);
	const group = () => [...headings].reverse().find((heading) => heading.level > 1)?.text ?? "";
	const inContext = () => headings.some((heading) => heading.level > 1 && heading.context);
	const makeIdentity = (headingPath: string[], workBody: string): PlanTaskIdentity => ({
		version: 1,
		headingPath,
		workBody,
	});
	const appendProse = (line: string) => {
		if (leadingCode.length) prose.push(...leadingCode);
		leadingCode = [];
		prose.push(line);
	};
	const appendCode = (line: string) => {
		if (prose.length) prose.push(line);
		else leadingCode.push(line);
	};
	const flushItem = () => {
		if (!current) return;
		if (!current.discard) {
			const bodyLines = [...current.body, ...current.detail];
			while (bodyLines.length && !bodyLines.at(-1)?.trim()) bodyLines.pop();
			const detail = dedent(current.detail);
			while (detail.length && !detail.at(-1)?.trim()) detail.pop();
			const item: PlanItem = {
				group: current.group,
				subject: current.subject,
				identity: makeIdentity(current.path, bodyLines.join("\n")),
			};
			if (detail.length) item.detail = detail.join("\n");
			sectionItems.push(item);
		}
		current = undefined;
	};
	const flushSection = () => {
		flushItem();
		if (!sectionSkipped) {
			const body = [...prose, ...leadingCode];
			while (body.length && !body.at(-1)?.trim()) body.pop();
			const sectionBody = body.join("\n");
			const scopedBody = [...headings.slice(0, -1).map((heading) => heading.workContext), sectionBody]
				.filter(Boolean)
				.join("\n\n");
			const heading = headings.at(-1);
			if (heading) heading.workContext = sectionBody;
			if (sectionBody && group()) {
				// A list lead-in scopes its bullets without creating a label-only task.
				// Code-only work sections still need a task, even without prose.
				if (!sectionItems.length || prose.some((line) => line.trim() && !/:\s*$/.test(line))) {
					items.push({
						group: group(),
						subject: group(),
						detail: sectionBody,
						identity: makeIdentity(path(), scopedBody),
					});
				}
			}
			for (const item of sectionItems) {
				if (scopedBody)
					item.identity = makeIdentity(item.identity.headingPath, `${scopedBody}\n\n${item.identity.workBody}`);
			}
			items.push(...sectionItems);
		}
		prose = [];
		leadingCode = [];
		sectionItems = [];
	};

	for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
		const opener = FENCE_OPEN.exec(line);
		const indent = indentOf(line);
		// A nested fenced block ends with its list container on dedent.
		if (fence && line.trim() && indent < fence.minIndent) fence = undefined;
		if (fence) {
			if (current) current.detail.push(line);
			else appendCode(line);
			if (
				opener &&
				indent <= fence.maxIndent &&
				opener[2][0] === fence.char &&
				opener[2].length >= fence.length &&
				/^\s*$/.test(line.slice(opener[1].length + opener[2].length))
			) {
				fence = undefined;
			}
			continue;
		}
		const nestedIndent = current && indent >= current.contentIndent ? current.contentIndent : 0;
		const opensFence = opener && indent <= nestedIndent + 3;
		if (opensFence) {
			fence = {
				char: opener[2][0] as "`" | "~",
				length: opener[2].length,
				minIndent: nestedIndent,
				maxIndent: nestedIndent + 3,
			};
			if (current) current.detail.push(line);
			else appendCode(line);
			continue;
		}

		const heading = HEADING.exec(line);
		if (heading && indent === 0) {
			flushSection();
			const level = heading[1].length;
			while (headings.length && headings.at(-1)!.level >= level) headings.pop();
			headings.push({ level, text: heading[2], context: isContextLabel(heading[2]) });
			sectionSkipped = inContext();
			listSkipped = false;
			continue;
		}

		if (!line.trim()) {
			if (current) current.detail.push(line);
			else if (prose.length || leadingCode.length) appendCode(line);
			continue;
		}

		const bullet = BULLET.exec(line.trimStart());
		if (current && indent > current.base) {
			current.detail.push(line);
			continue;
		}
		if (bullet && indent <= 3) {
			flushItem();
			const discard = sectionSkipped || listSkipped;
			current = {
				group: group(),
				path: path(),
				subject: bullet[2].trim(),
				base: indent,
				contentIndent:
					indent + bullet[1].length + (line.trimStart().slice(bullet[1].length).match(/^\s+/)?.[0].length ?? 1),
				detail: [],
				body: [bullet[2]],
				discard,
			};
			continue;
		}

		if (current) flushItem();
		if (sectionSkipped) continue;
		if (indent >= 4) {
			appendCode(line);
			continue;
		}
		listSkipped = isContextLabel(line.trim()) && /:\s*$/.test(line.trim());
		if (!listSkipped) appendProse(line);
	}
	flushSection();
	return items;
}

function identityKey(identity: PlanTaskIdentity): string {
	return JSON.stringify([identity.version, identity.headingPath, identity.workBody]);
}

function singletonByIdentity<T>(
	entries: readonly T[],
	identity: (entry: T) => PlanTaskIdentity | undefined,
): Map<string, T> {
	const grouped = new Map<string, T[]>();
	for (const entry of entries) {
		const value = identity(entry);
		if (value?.version !== 1) continue;
		const key = identityKey(value);
		grouped.set(key, [...(grouped.get(key) ?? []), entry]);
	}
	return new Map([...grouped].flatMap(([key, values]) => (values.length === 1 ? [[key, values[0]]] : [])));
}

export interface PlanApprovalResult {
	state: TaskState;
	/** False when `planId` is already the active plan (re-announcement). */
	changed: boolean;
}

/** Replace approved-plan tasks while carrying only unambiguous exact identity matches. */
export function applyPlanApproval(state: TaskState, planId: string, markdown: string): PlanApprovalResult {
	if (state.plan?.id === planId) return { state, changed: false };

	const removed = new Set<number>();
	const priorTasks = state.tasks.filter((task) => {
		if (task.source !== "plan") return false;
		removed.add(task.id);
		return task.status !== "deleted";
	});
	const prior = state.plan?.id
		? singletonByIdentity(priorTasks, (task) => task.planIdentity)
		: new Map<string, Task>();
	const parsed = parsePlanItems(markdown);
	const incoming = singletonByIdentity(parsed, (item) => item.identity);
	let nextId = state.nextId;
	const planTasks = parsed.map((item) => {
		const task: Task = {
			id: nextId++,
			subject: item.subject,
			status: "pending",
			source: "plan",
			planIdentity: item.identity,
		};
		if (item.group) task.planGroup = item.group;
		if (item.detail) task.planText = item.detail;
		const key = identityKey(item.identity);
		const old = prior.get(key);
		if (old && incoming.get(key) === item && (old.status === "completed" || old.status === "deferred")) {
			task.status = old.status;
			if (old.evidence) task.evidence = old.evidence;
			if (old.reason) task.reason = old.reason;
			task.planProvenance = { planId: state.plan!.id, taskId: old.id };
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
	return state.tasks.filter(
		(task) => task.source === "plan" && (task.status === "pending" || task.status === "in_progress"),
	);
}

/** `{ open, total }` over plan items, tombstones excluded; `undefined` without plan items. */
export function selectPlanProgress(state: TaskState): { open: number; total: number } | undefined {
	const items = state.tasks.filter((task) => task.source === "plan" && task.status !== "deleted");
	if (!items.length) return undefined;
	return { open: selectOpenPlanItems(state).length, total: items.length };
}
