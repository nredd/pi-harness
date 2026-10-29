import type { Task, TaskAction, TaskMutationParams, TaskOpAction, TaskStatus } from "../tool/types.ts";
import { isTransitionValid } from "./invariants.ts";
import type { TaskState } from "./state.ts";
import { detectCycle } from "./task-graph.ts";

/**
 * Reducer outcome. Closed tagged union — adding a new action requires extending
 * this union AND the response-envelope's `formatContent` switch (compiler-
 * enforced exhaustive). Mirrors the `Effect` pattern in
 * `packages/rpiv-ask-user-question/state/state-reducer.ts:14-30`.
 *
 * `error` carries the message in-band so callers can pattern-match on
 * `op.kind === "error"` without a side-channel boolean.
 */
export type Op =
	| { kind: "create"; taskId: number; task?: Task }
	| {
			kind: "update";
			id: number;
			fromStatus: TaskStatus;
			toStatus: TaskStatus;
			changed: boolean;
			task?: Task;
			/** Present when this update newly defers the task or changes its deferred reason. */
			deferredReason?: string;
	  }
	| { kind: "delete"; id: number; subject: string; task?: Task }
	| { kind: "list"; statusFilter?: TaskStatus; includeDeleted: boolean }
	| { kind: "get"; task: Task }
	| { kind: "clear"; count: number; kept: number }
	| { kind: "batch"; results: Op[] }
	| { kind: "error"; message: string };

export interface ApplyResult {
	state: TaskState;
	op: Op;
}

/**
 * True when `op` changed the task state — the calls whose post-commit snapshot
 * must be persisted for replay. Reads (`list`/`get`), failures, and a no-effect
 * `update` leave state untouched. Exhaustive over `Op` (compiler-enforced), so a
 * new action must decide here whether it persists.
 */
export function changesState(op: Op): boolean {
	switch (op.kind) {
		case "create":
		case "delete":
		case "clear":
			return true;
		case "update":
			return op.changed;
		case "batch":
			return op.results.some(changesState);
		case "list":
		case "get":
		case "error":
			return false;
	}
}

function errorResult(state: TaskState, message: string): ApplyResult {
	return { state, op: { kind: "error", message } };
}

const normalizeSubject = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

/** The live plan item whose subject equals `subject` (case and whitespace-insensitive), if any. */
function findPlanItemBySubject(state: TaskState, subject: string): Task | undefined {
	if (!state.plan) return undefined;
	const key = normalizeSubject(subject);
	return state.tasks.find((t) => t.source === "plan" && t.status !== "deleted" && normalizeSubject(t.subject) === key);
}

export const ERR_EVIDENCE_REQUIRED =
	"evidence required to mark a task completed: pass evidence with the check that proves it (command + result, commit, or test name). If it isn't done, leave it open";
export const ERR_REASON_REQUIRED =
	"reason required to defer a task: pass reason saying why it is descoped; the user is told";

function planItemUndeletable(id: number): string {
	return `#${id} is a plan item from the approved plan and can't be deleted: complete it with evidence, or set status deferred with a reason`;
}

function planItemVerbatim(id: number): string {
	return `#${id} is a plan item; its subject and description are the approved plan's text and can't be edited`;
}

function sameNumberList(a: number[] | undefined, b: number[] | undefined): boolean {
	const x = a ?? [];
	const y = b ?? [];
	return x.length === y.length && x.every((v, i) => v === y[i]);
}

function sameRecord(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Did this `update` change anything? Compares the task before/after the params
 * are applied. A no-effect update — `status` set to its current value, or any
 * field re-sent unchanged — returns false, letting the response envelope say
 * "No change" instead of "Updated #N". Without this, a no-op update is
 * indistinguishable from a real mutation, which can drive a model to re-issue
 * the same call in a loop.
 *
 * blockedBy is order-sensitive (the reducer preserves insertion order);
 * metadata round-trips through JSON persistence, so JSON-equality is the
 * operative notion of "changed".
 */
function taskChanged(before: Task, after: Task): boolean {
	return (
		before.subject !== after.subject ||
		before.status !== after.status ||
		before.description !== after.description ||
		before.activeForm !== after.activeForm ||
		before.owner !== after.owner ||
		before.evidence !== after.evidence ||
		before.reason !== after.reason ||
		!sameNumberList(before.blockedBy, after.blockedBy) ||
		!sameRecord(before.metadata, after.metadata)
	);
}

/** Action-specific fields must never disappear behind a successful response. */
const ACTION_FIELDS: Record<TaskOpAction, ReadonlySet<string>> = {
	create: new Set(["subject", "description", "activeForm", "blockedBy", "owner", "metadata"]),
	update: new Set([
		"id",
		"subject",
		"description",
		"activeForm",
		"status",
		"evidence",
		"reason",
		"addBlockedBy",
		"removeBlockedBy",
		"owner",
		"metadata",
	]),
	list: new Set(["status", "includeDeleted"]),
	get: new Set(["id"]),
	delete: new Set(["id"]),
	clear: new Set(),
};

/**
 * Pure reducer: (state, action, params) → (state, op). The response envelope (`tool/response-envelope.ts`) owns
 * formatting, the store (`state/store.ts`) owns commit.
 *
 * Validation is in-line: structural guards (`subject required`, `id required`,
 * `at least one mutable field`) plus state-aware checks (transition legality,
 * dangling/deleted blockedBy, self-block, cycles). Decision: validation stays
 * in-reducer.
 */
export function applyTaskMutation(state: TaskState, action: TaskOpAction, params: TaskMutationParams): ApplyResult {
	for (const [field, value] of Object.entries(params)) {
		if (field === "action" || value === undefined || ACTION_FIELDS[action].has(field)) continue;
		const hint =
			action === "create" && field === "status"
				? "; create always starts pending -- use update with the created id to change status"
				: action === "update" && field === "blockedBy"
					? "; use addBlockedBy/removeBlockedBy for updates"
					: "";
		return errorResult(state, `${field} is not supported for ${action}${hint}`);
	}
	switch (action) {
		case "create": {
			if (!params.subject?.trim()) {
				return errorResult(state, "subject required for create");
			}
			const duplicate = findPlanItemBySubject(state, params.subject);
			if (duplicate) return errorResult(state, `#${duplicate.id} is already a plan item; update it`);
			if (params.blockedBy?.length) {
				for (const dep of params.blockedBy) {
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `blockedBy: #${dep} not found`);
					if (depTask.status === "deleted") return errorResult(state, `blockedBy: #${dep} is deleted`);
				}
			}
			const newTask: Task = { id: state.nextId, subject: params.subject, status: "pending" };
			if (params.description) newTask.description = params.description;
			if (params.activeForm) newTask.activeForm = params.activeForm;
			if (params.blockedBy?.length) newTask.blockedBy = [...params.blockedBy];
			if (params.owner) newTask.owner = params.owner;
			if (params.metadata) newTask.metadata = { ...params.metadata };

			const newTasks = [...state.tasks, newTask];
			return {
				state: { ...state, tasks: newTasks, nextId: state.nextId + 1 },
				op: { kind: "create", taskId: newTask.id, task: newTask },
			};
		}

		case "update": {
			if (params.id === undefined) return errorResult(state, "id required for update");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];

			const hasMutation =
				params.subject !== undefined ||
				params.description !== undefined ||
				params.activeForm !== undefined ||
				params.status !== undefined ||
				params.owner !== undefined ||
				params.metadata !== undefined ||
				params.evidence !== undefined ||
				params.reason !== undefined ||
				(params.addBlockedBy && params.addBlockedBy.length > 0) ||
				(params.removeBlockedBy && params.removeBlockedBy.length > 0);
			if (!hasMutation)
				return errorResult(
					state,
					"update requires at least one mutable field: subject, description, activeForm, status, evidence, reason, owner, metadata, addBlockedBy, or removeBlockedBy",
				);

			if (
				current.source === "plan" &&
				((params.subject !== undefined && params.subject !== current.subject) ||
					(params.description !== undefined && params.description !== current.description))
			) {
				return errorResult(state, planItemVerbatim(current.id));
			}

			let newStatus = current.status;
			if (params.status !== undefined) {
				if (!isTransitionValid(current.status, params.status)) {
					return errorResult(state, `illegal transition ${current.status} → ${params.status}`);
				}
				if (params.status === "deleted" && current.source === "plan") {
					return errorResult(state, planItemUndeletable(current.id));
				}
				newStatus = params.status;
			}

			// Completion costs proof; deferral costs a reason. Both are checked on
			// the resulting status so a stray field can't ride along unnoticed.
			const evidence = params.evidence?.trim();
			const reason = params.reason?.trim();
			if (params.evidence !== undefined && newStatus !== "completed") {
				return errorResult(state, "evidence only applies to a completed task (status: completed)");
			}
			if (params.reason !== undefined && newStatus !== "deferred") {
				return errorResult(state, "reason only applies to a deferred task (status: deferred)");
			}
			const completing =
				newStatus === "completed" && (current.status !== "completed" || params.evidence !== undefined);
			if (completing && !evidence) return errorResult(state, ERR_EVIDENCE_REQUIRED);
			const deferring = newStatus === "deferred" && (current.status !== "deferred" || params.reason !== undefined);
			if (deferring && !reason) return errorResult(state, ERR_REASON_REQUIRED);

			let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
			if (params.removeBlockedBy?.length) {
				const toRemove = new Set(params.removeBlockedBy);
				newBlockedBy = newBlockedBy.filter((dep) => !toRemove.has(dep));
			}
			if (params.addBlockedBy?.length) {
				for (const dep of params.addBlockedBy) {
					if (dep === current.id) return errorResult(state, `cannot block #${current.id} on itself`);
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `addBlockedBy: #${dep} not found`);
					if (depTask.status === "deleted") return errorResult(state, `addBlockedBy: #${dep} is deleted`);
					if (!newBlockedBy.includes(dep)) newBlockedBy.push(dep);
				}
				if (detectCycle(state.tasks, current.id, newBlockedBy)) {
					return errorResult(state, "addBlockedBy would create a cycle in the blockedBy graph");
				}
			}

			let newMetadata = current.metadata;
			if (params.metadata !== undefined) {
				const merged: Record<string, unknown> = { ...(current.metadata ?? {}) };
				for (const [k, v] of Object.entries(params.metadata)) {
					if (v === null) delete merged[k];
					else merged[k] = v;
				}
				newMetadata = Object.keys(merged).length ? merged : undefined;
			}

			const updated: Task = { ...current, status: newStatus };
			if (params.subject !== undefined) updated.subject = params.subject;
			if (params.description !== undefined) updated.description = params.description;
			if (params.activeForm !== undefined) updated.activeForm = params.activeForm;
			if (params.owner !== undefined) updated.owner = params.owner;
			if (evidence) updated.evidence = evidence;
			if (reason) updated.reason = reason;
			if (newStatus !== "deferred") delete updated.reason;
			if (newBlockedBy.length) updated.blockedBy = newBlockedBy;
			else delete updated.blockedBy;
			if (newMetadata === undefined) delete updated.metadata;
			else updated.metadata = newMetadata;

			const newTasks = [...state.tasks];
			newTasks[idx] = updated;
			return {
				state: { ...state, tasks: newTasks },
				op: {
					kind: "update",
					id: updated.id,
					fromStatus: current.status,
					toStatus: newStatus,
					changed: taskChanged(current, updated),
					task: updated,
					...(newStatus === "deferred" && current.reason !== updated.reason
						? { deferredReason: updated.reason }
						: {}),
				},
			};
		}

		case "list": {
			return {
				state,
				op: {
					kind: "list",
					includeDeleted: params.includeDeleted === true,
					...(params.status !== undefined ? { statusFilter: params.status } : {}),
				},
			};
		}

		case "get": {
			if (params.id === undefined) return errorResult(state, "id required for get");
			const task = state.tasks.find((t) => t.id === params.id);
			if (!task) return errorResult(state, `#${params.id} not found`);
			return { state, op: { kind: "get", task } };
		}

		case "delete": {
			if (params.id === undefined) return errorResult(state, "id required for delete");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];
			if (current.status === "deleted") return errorResult(state, `#${current.id} is already deleted`);
			if (current.source === "plan") return errorResult(state, planItemUndeletable(current.id));
			const updated: Task = { ...current, status: "deleted" };
			const newTasks = [...state.tasks];
			newTasks[idx] = updated;
			return {
				state: { ...state, tasks: newTasks },
				op: { kind: "delete", id: updated.id, subject: updated.subject, task: updated },
			};
		}

		case "clear": {
			// Plan items survive: they leave only by completion, deferral, or a
			// re-approved plan. Ids restart at 1 only when nothing is kept.
			const kept = state.tasks.filter((t) => t.source === "plan");
			const count = state.tasks.length - kept.length;
			if (!kept.length) {
				return { state: { tasks: [], nextId: 1 }, op: { kind: "clear", count, kept: 0 } };
			}
			const keptIds = new Set(kept.map((t) => t.id));
			const tasks = kept.map((t) => {
				if (!t.blockedBy?.some((id) => !keptIds.has(id))) return t;
				const blockedBy = t.blockedBy.filter((id) => keptIds.has(id));
				const next: Task = { ...t, blockedBy };
				if (!blockedBy.length) delete next.blockedBy;
				return next;
			});
			return { state: { ...state, tasks }, op: { kind: "clear", count, kept: kept.length } };
		}
	}
}

export interface CallResult extends ApplyResult {
	/** What the call did, as recorded in `details.action`. */
	action: TaskAction;
}

const READ_ACTIONS: ReadonlySet<TaskOpAction> = new Set(["list", "get"]);

/**
 * Entry point for one `todo` call: a single operation, or an `ops` batch.
 *
 * A batch is atomic. Mutations apply in order against a running state; the
 * first failure discards everything and the error names the op (`ops[3]: ...`).
 * `list`/`get` are answered from the FINAL state, so they report what the batch
 * produced. Ids of todos a batch creates are sequential from `nextId`, which a
 * later op in the same batch may reference but a caller should not rely on.
 */
export function applyTaskCall(state: TaskState, params: TaskMutationParams): CallResult {
	const { ops, action, ...flat } = params;
	if (ops === undefined) {
		if (!action) return { ...errorResult(state, "action required (or pass ops)"), action: "batch" };
		return { ...applyTaskMutation(state, action as TaskOpAction, params), action: action as TaskOpAction };
	}
	const fail = (message: string): CallResult => ({ ...errorResult(state, message), action: "batch" });
	if (action !== undefined || Object.values(flat).some((v) => v !== undefined)) {
		return fail("ops can't be combined with a top-level action or fields: put them inside each op");
	}
	if (ops.length === 0) return fail("ops must not be empty");

	let running = state;
	const results: Op[] = new Array(ops.length);
	for (const [index, op] of ops.entries()) {
		if (!op.action) return fail(`ops[${index}]: action required`);
		if (op.ops !== undefined) return fail(`ops[${index}]: ops can't be nested`);
		if (READ_ACTIONS.has(op.action)) continue;
		const applied = applyTaskMutation(running, op.action, op);
		if (applied.op.kind === "error") return fail(`ops[${index}]: ${applied.op.message}`);
		running = applied.state;
		results[index] = applied.op;
	}
	for (const [index, op] of ops.entries()) {
		if (!READ_ACTIONS.has(op.action as TaskOpAction)) continue;
		const read = applyTaskMutation(running, op.action as TaskOpAction, op);
		if (read.op.kind === "error") return fail(`ops[${index}]: ${read.op.message}`);
		results[index] = read.op;
	}
	return { state: running, op: { kind: "batch", results }, action: "batch" };
}
