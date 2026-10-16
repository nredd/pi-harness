import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

// ---------------------------------------------------------------------------
// Tool / command identity — verbatim string boundaries.
// Tool name "todo" is the persistence key for branch replay (filtering
// `toolResult.toolName === "todo"`) AND the permissions entry at
// `templates/pi-permissions.jsonc:26`. DO NOT rename.
// ---------------------------------------------------------------------------

export const TOOL_NAME = "todo";
export const TOOL_LABEL = "Todo";
export const COMMAND_NAME = "todos";

/**
 * Custom session-entry type carrying the `details` snapshot of every
 * state-changing `todo` call — the replay source that survives calls made
 * through another tool (`ctx.executeTool`, e.g. Pi's codemode), whose results
 * never land on the branch as standalone `toolResult` messages. Persistence key
 * for branch replay, like `TOOL_NAME`. DO NOT rename.
 */
export const STATE_ENTRY_TYPE = "rpiv-todo-state";

// ---------------------------------------------------------------------------
// User-facing strings (kept stable for /todos UX parity).
// ---------------------------------------------------------------------------

export const ERR_REQUIRES_INTERACTIVE = "/todos requires interactive mode";
export const MSG_NO_TODOS = "No todos yet. Ask the agent to add some!";

// ---------------------------------------------------------------------------
// Plan integration. pi-plan-mode emits PLAN_APPROVED_EVENT on `pi.events` when
// the user approves a plan and implementation starts. The payload shape is a
// cross-package contract (pi-plan-mode `src/plan-approval.ts`); neither
// package imports the other, so both declare it. Version-gated so a future
// shape change is ignored instead of misread.
// ---------------------------------------------------------------------------

export const PLAN_APPROVED_EVENT = "pi-plan-mode:plan-approved";
export const PLAN_APPROVED_VERSION = 1;

export interface PlanApprovedPayload {
	version: typeof PLAN_APPROVED_VERSION;
	/** Unique per approval; re-announcing the same id is a no-op. */
	planId: string;
	/** The approved plan Markdown, verbatim. */
	plan: string;
	/** Session the plan was approved for. */
	sessionId: string;
}

/**
 * Hidden custom message appended at `agent_before_settle` when the run would
 * end with plan items open. Persisted only as a short marker; the `context`
 * hook swaps in the open-item list for the one request that follows it.
 */
export const PLAN_REMINDER_MESSAGE_TYPE = "rpiv-todo-plan-reminder";

// ---------------------------------------------------------------------------
// Public domain types
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "in_progress" | "completed" | "deferred" | "deleted";

/** One operation of the `todo` tool. */
export type TaskOpAction = "create" | "update" | "list" | "get" | "delete" | "clear";

/** What a call did: a single operation, or an `ops` batch of them. */
export type TaskAction = TaskOpAction | "batch";

/** Stable, versioned source identity for reconciling an approved plan item. */
export interface PlanTaskIdentity {
	version: 1;
	/** Every enclosing work-section heading (`##` and deeper), verbatim. */
	headingPath: string[];
	/** The item's actual Markdown work body, excluding its heading, verbatim. */
	workBody: string;
}

/** The prior plan task from which status-bearing work was carried forward. */
export interface PlanTaskProvenance {
	planId: string;
	taskId: number;
}

export interface Task {
	id: number;
	subject: string;
	description?: string;
	activeForm?: string;
	status: TaskStatus;
	blockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
	/** `"plan"` for items seeded verbatim from an approved plan; absent for agent-created todos. */
	source?: "plan";
	/** Plan section (heading text, verbatim) the item came from. */
	planGroup?: string;
	/** Nested plan lines under the item's bullet, verbatim. */
	planText?: string;
	/** Versioned, verbatim source identity used only for plan re-approval reconciliation. */
	planIdentity?: PlanTaskIdentity;
	/** Previous plan task that supplied this task's carried status-bearing state. */
	planProvenance?: PlanTaskProvenance;
	/** The check that proves a `completed` task: command + result, commit, or test name. */
	evidence?: string;
	/** Why a `deferred` task was descoped. */
	reason?: string;
}

/** The approved plan the `source: "plan"` todos came from. */
export interface PlanRef {
	id: string;
	title: string;
}

/**
 * Persistence + replay snapshot. Every successful `todo` tool call returns this
 * shape under `details`; `state/replay.ts` reads the latest one from the branch
 * to reconstruct module state. Field order and field names are pinned by
 * cross-version replay compatibility.
 */
export interface TaskDetails {
	action: TaskAction;
	params: Record<string, unknown>;
	tasks: Task[];
	nextId: number;
	error?: string;
	plan?: PlanRef;
}

/** Payload of a `rpiv-todo-state` custom entry: the replay-relevant part of `TaskDetails`. */
export type TaskSnapshot = Pick<TaskDetails, "tasks" | "nextId" | "plan">;

/**
 * Open-shape input bag the reducer accepts. Stays an interface so the index
 * signature (`[key: string]: unknown`) lets the runtime pass through TypeBox
 * `Static<typeof TodoParamsSchema>` without `as` casts.
 */
export interface TaskMutationParams {
	[key: string]: unknown;
	subject?: string;
	description?: string;
	activeForm?: string;
	status?: TaskStatus;
	blockedBy?: number[];
	addBlockedBy?: number[];
	removeBlockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
	id?: number;
	includeDeleted?: boolean;
	evidence?: string;
	reason?: string;
	/** An `ops` batch; mutually exclusive with every other field. */
	ops?: Array<TaskMutationParams & { action?: TaskOpAction }>;
}

// ---------------------------------------------------------------------------
// TypeBox parameter schema — every `description` doubles as LLM-facing prompt
// copy. Field order and wording are pinned by registration tests.
// ---------------------------------------------------------------------------

const OP_ACTIONS = ["create", "update", "list", "get", "delete", "clear"] as const;

/** Fields shared by a flat call and each entry of `ops`. Descriptions double as LLM-facing prompt copy. */
const OpFields = {
	subject: Type.Optional(Type.String({ description: "Task subject line (required for create)" })),
	description: Type.Optional(Type.String({ description: "Long-form task description" })),
	activeForm: Type.Optional(
		Type.String({
			description: "Present-continuous spinner label shown while status is in_progress (e.g. 'writing tests')",
		}),
	),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed", "deferred", "deleted"] as const, {
			description:
				"Set this task's status (update): one of pending, in_progress, completed, deferred, deleted. completed requires evidence; deferred requires reason. When action is list, filters returned tasks by this status.",
		}),
	),
	evidence: Type.Optional(
		Type.String({
			description:
				"Required with status completed: the check that proves it (command + result, commit, or test name)",
		}),
	),
	reason: Type.Optional(
		Type.String({ description: "Required with status deferred: why the task is descoped (the user is told)" }),
	),
	blockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Initial blockedBy ids (create only)" })),
	addBlockedBy: Type.Optional(
		Type.Array(Type.Number(), { description: "Task ids to add to blockedBy (update only, additive merge)" }),
	),
	removeBlockedBy: Type.Optional(
		Type.Array(Type.Number(), { description: "Task ids to remove from blockedBy (update only, additive merge)" }),
	),
	owner: Type.Optional(Type.String({ description: "Agent/owner assigned to this task" })),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "Arbitrary metadata; pass null value for a key to delete that key on update",
		}),
	),
	id: Type.Optional(Type.Number({ description: "Task id (required for update, get, delete)" })),
	includeDeleted: Type.Optional(
		Type.Boolean({ description: "If true, list action returns deleted (tombstoned) tasks as well. Default: false." }),
	),
};

const OpSchema = Type.Object({ action: StringEnum(OP_ACTIONS), ...OpFields });

export const TodoParamsSchema = Type.Object({
	action: Type.Optional(StringEnum(OP_ACTIONS, { description: "The operation. Omit when passing ops." })),
	...OpFields,
	ops: Type.Optional(
		Type.Array(OpSchema, {
			description:
				"Batch: many operations in ONE call, instead of the top-level action and fields (mutually exclusive). Applied in order and atomically: if any op is invalid nothing changes and the error names the op index (ops[3]: ...). list/get ops are answered from the final state. Give each completed op its own evidence.",
		}),
	),
});

export type TodoParams = Static<typeof TodoParamsSchema>;
