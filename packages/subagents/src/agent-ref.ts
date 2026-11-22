import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentManager, describeEvicted, describeEvictedResult, type EvictedNote } from "./agent-manager.ts";
import { listAllRunningDetached, listRunningDetached } from "./detached-results.ts";
import { stripAgentPrefix } from "./mention.ts";
import type { AgentRecord, AgentTombstone } from "./types.ts";
import type { WorkflowTask } from "./workflow/task.ts";

/** Longest handle worth looking up; anything longer names nothing. */
export const MAX_AGENT_HANDLE_CHARS = 128;

/** Claude Code's workflow run id shape, as minted by `newWorkflowId`. */
const WORKFLOW_RUN_ID = /^wf_[a-z0-9-]{6,}$/;

/** One handle as typed (`raw`, trimmed, one leading `@` dropped) and its lowercase name `key`. */
export interface AgentHandle {
	raw: string;
	key: string;
}

/** Normalize any string that names an agent; undefined when it is empty or too long to be one. */
export function normalizeHandle(input: string): AgentHandle | undefined {
	const raw = input.trim().replace(/^@/, "");
	if (raw === "" || raw.length > MAX_AGENT_HANDLE_CHARS) return undefined;
	return { raw, key: raw.toLowerCase() };
}

/** Who is asking. An agent sees only the nested children it owns. */
export type Asker = { kind: "session" } | { kind: "agent"; parentAgentId: string };

/** Which lookup step answered: the exact id, a run id, a workflow run id, a name, its `agent-` form, or saved history. */
export type AgentRefVia = "id" | "run" | "workflow-run" | "name" | "prefix" | "saved" | "none";

/** Why a saved agent cannot be reopened. */
export type SavedResumeRefusal = "tombstone-bound" | "name-taken" | "historical" | "no-saved-session";

/**
 * What a handle names from where the asker stands. `requested` is the normalized
 * input and `latest` the newest id it continues under. Resume reads only
 * `retained.resume` and `saved.resume`; steer and stop read only `state`, so a
 * stopped record steer refuses can still resume in place.
 */
export type AgentRef = { requested: string; latest: string; via: AgentRefVia } & (
	| { state: "live"; record: AgentRecord; home: "manager" | "survivor" }
	| { state: "queued"; record: AgentRecord; home: "manager" | "survivor" }
	| { state: "retained"; record: AgentRecord; resume: { mode: "in-place" } | { mode: "none"; why: "no-session" } }
	| {
			state: "saved";
			note?: EvictedNote;
			tombstone?: AgentTombstone;
			resume: { mode: "reopen"; entry: AgentTombstone } | { mode: "none"; why: SavedResumeRefusal };
	  }
	| {
			state: "workflow-owned";
			owner: { kind: "run"; task: WorkflowTask } | { kind: "child"; record: AgentRecord };
	  }
	| { state: "unknown" }
);

/** Everything a lookup reads. In-process only: no file system, and no `listAgents` sort. */
export interface AgentSources {
	getRecord(id: string): AgentRecord | undefined;
	records(): Iterable<AgentRecord>;
	latestId(id: string): string;
	tombstoneById(id: string): AgentTombstone | undefined;
	tombstoneByName(name: string): AgentTombstone | undefined;
	getEvictedNote(id: string): EvictedNote | undefined;
	/** Running records of orphaned managers a session switch left behind (#330). */
	survivors(): readonly AgentRecord[];
	workflowTasks(): ReadonlyMap<string, WorkflowTask>;
}

/** Sources backed by `manager`, plus the survivors and workflow runs it cannot see. */
export function agentSources(
	manager: AgentManager,
	survivors: () => readonly AgentRecord[],
	workflowTasks: () => ReadonlyMap<string, WorkflowTask>,
): AgentSources {
	return {
		getRecord: (id) => manager.getRecord(id),
		records: () => manager.records(),
		latestId: (id) => manager.latestId(id),
		tombstoneById: (id) => manager.tombstoneById(id),
		tombstoneByName: (name) => manager.tombstoneByName(name),
		getEvictedNote: (id) => manager.getEvictedNote(id),
		survivors,
		workflowTasks,
	};
}

type RefBase = { requested: string; latest: string; via: AgentRefVia };
type Home = "manager" | "survivor";

/** Live, queued or retained, by status. */
function byStatus(record: AgentRecord, home: Home, base: RefBase): AgentRef {
	if (record.status === "running") return { ...base, state: "live", record, home };
	if (record.status === "queued") return { ...base, state: "queued", record, home };
	return {
		...base,
		state: "retained",
		record,
		resume: record.session ? { mode: "in-place" } : { mode: "none", why: "no-session" },
	};
}

/** `record` as the asker may see it: a nested child only by its parent, a workflow child as owned. */
function visible(record: AgentRecord, home: Home, asker: Asker, base: RefBase): AgentRef {
	if (record.parentAgentId !== undefined) {
		const owns = asker.kind === "agent" && asker.parentAgentId === record.parentAgentId;
		return owns ? byStatus(record, home, base) : { ...base, state: "unknown" };
	}
	if (asker.kind === "agent") return { ...base, state: "unknown" };
	if (record.workflowId !== undefined) return { ...base, state: "workflow-owned", owner: { kind: "child", record } };
	return byStatus(record, home, base);
}

/** The first record matching `match`, this manager's before survivors. */
function locate(
	sources: AgentSources,
	survivors: readonly AgentRecord[],
	match: (record: AgentRecord) => boolean,
): { record: AgentRecord; home: Home } | undefined {
	for (const record of sources.records()) if (match(record)) return { record, home: "manager" };
	const survivor = survivors.find(match);
	return survivor && { record: survivor, home: "survivor" };
}

type SavedResume = Extract<AgentRef, { state: "saved" }>["resume"];

/** How saved history reopens: through its tombstone, else why its note cannot. */
function savedResume(tombstone: AgentTombstone | undefined, note: EvictedNote | undefined): SavedResume {
	if (tombstone) return { mode: "reopen", entry: tombstone };
	const why: SavedResumeRefusal = note?.tombstoneBoundSession
		? "tombstone-bound"
		: note?.nameTaken
			? "name-taken"
			: note?.fromSavedSession
				? "historical"
				: "no-saved-session";
	return { mode: "none", why };
}

/**
 * Resolve one handle in a fixed order: the successor chain, the exact id (this
 * manager, then survivors), a run id, a workflow run id, a handle or alias
 * (lowercase, as typed before its `agent-` form), then saved history (a
 * tombstone by name or id, else an eviction note by id). Id beats name, and
 * live beats saved. Reads memory only.
 */
export function resolveAgent(input: string, asker: Asker, sources: AgentSources): AgentRef {
	const handle = normalizeHandle(input);
	if (!handle) return { requested: input, latest: input, via: "none", state: "unknown" };
	const latest = sources.latestId(handle.raw);
	const base = (via: AgentRefVia): RefBase => ({ requested: handle.raw, latest, via });
	const survivors = sources.survivors();

	const own = sources.getRecord(latest);
	if (own) return visible(own, "manager", asker, base("id"));
	const survivor = survivors.find((record) => record.id === latest);
	if (survivor) return visible(survivor, "survivor", asker, base("id"));

	const run = locate(sources, survivors, (record) => record.runId === handle.raw);
	if (run) return visible(run.record, run.home, asker, base("run"));

	// Below here everything is the session's: workflow runs, top-level names and saved history.
	if (asker.kind === "agent") return { ...base("none"), state: "unknown" };

	const task = WORKFLOW_RUN_ID.test(handle.raw) ? sources.workflowTasks().get(handle.raw) : undefined;
	if (task) return { ...base("workflow-run"), state: "workflow-owned", owner: { kind: "run", task } };

	const prefixed = stripAgentPrefix(handle.key);
	const names: [AgentRefVia, string][] = [["name", handle.key]];
	if (prefixed) names.push(["prefix", prefixed]);
	for (const [via, key] of names) {
		const named = locate(sources, survivors, (record) => record.handle === key || record.alias === key);
		if (named) return visible(named.record, named.home, asker, base(via));
	}

	const tombstone =
		sources.tombstoneByName(handle.key) ??
		(prefixed ? sources.tombstoneByName(prefixed) : undefined) ??
		sources.tombstoneById(latest);
	const note = sources.getEvictedNote(tombstone?.id ?? latest);
	if (!tombstone && !note) return { ...base("none"), state: "unknown" };
	return { ...base("saved"), state: "saved", note, tombstone, resume: savedResume(tombstone, note) };
}

/** The record a ref carries, if any: a workflow run and saved history have none. */
export function refRecord(ref: AgentRef): AgentRecord | undefined {
	if (ref.state === "workflow-owned") return ref.owner.kind === "child" ? ref.owner.record : undefined;
	return "record" in ref ? ref.record : undefined;
}

const SESSION: Asker = { kind: "session" };
/** The legacy lookups never answered with a workflow run, so they read none. */
const NO_WORKFLOWS: ReadonlyMap<string, WorkflowTask> = new Map();

/**
 * What the pre-resolver lookups returned for `input`: a record matched by the
 * exact input under the given steps, with no normalization and no successor
 * followed (callers follow `latestId` themselves). A workflow child is still
 * returned for the caller's own ownership check; a nested child is not.
 */
function legacyRecord(ref: AgentRef, input: string, steps: readonly AgentRefVia[]): AgentRecord | undefined {
	if (ref.requested !== input || ref.latest !== input || !steps.includes(ref.via)) return undefined;
	return refRecord(ref);
}

export function createAgentLookup(manager: AgentManager, getCtx: () => ExtensionContext | undefined) {
	/** Any live record by exact id, including survivors registered under another session file. */
	const liveAgentById = (id: string) =>
		legacyRecord(
			resolveAgent(
				id,
				SESSION,
				agentSources(
					manager,
					() => listAllRunningDetached().map(({ agent }) => agent.record),
					() => NO_WORKFLOWS,
				),
			),
			id,
			["id"],
		);

	/**
	 * Resolve a tool's `agent_id` as an id OR a handle, so the model addresses
	 * agents by the same names the user types. Ids are tried first. Only live
	 * records: a tombstone has nothing to steer and no result to read. Callers
	 * still enforce the workflow-ownership rejection. Survivors of a /reload,
	 * /new or /resume live in the orphaned manager (#330) and answer by name
	 * case-insensitively, like this manager's own records.
	 */
	const resolveAgentRef = (ref: string): AgentRecord | undefined =>
		legacyRecord(
			resolveAgent(
				ref,
				SESSION,
				agentSources(
					manager,
					() => listRunningDetached(getCtx()?.sessionManager?.getSessionFile?.()).map((d) => d.record),
					() => NO_WORKFLOWS,
				),
			),
			ref,
			["id", "name"],
		);

	return { liveAgentById, resolveAgentRef };
}

/** "Not found", or what became of the agent when its record was evicted. */
export function agentNotFound(manager: AgentManager, ref: string, withResult = false): string {
	const note = manager.getEvictedNote(ref);
	const result = withResult && note ? describeEvictedResult(note) : undefined;
	return note
		? describeEvicted(note) + (result ? `\n\n${result}` : "")
		: `Agent not found: "${ref}". It may have been cleaned up.`;
}
