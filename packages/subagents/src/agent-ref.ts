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
interface AgentHandle {
	raw: string;
	key: string;
}

/** Normalize any string that names an agent; undefined when it is empty or too long to be one. */
function normalizeHandle(input: string): AgentHandle | undefined {
	const raw = input.trim().replace(/^@/, "");
	if (raw === "" || raw.length > MAX_AGENT_HANDLE_CHARS) return undefined;
	return { raw, key: raw.toLowerCase() };
}

/** Who is asking. An agent sees only the nested children it owns. */
export type Asker = { kind: "session" } | { kind: "agent"; parentAgentId: string };

/** Which lookup step answered: the exact id, a run id, a workflow run id, a name, its `agent-` form, or saved history. */
type AgentRefVia = "id" | "run" | "workflow-run" | "name" | "prefix" | "saved" | "none";

/** Why a saved agent cannot be reopened. */
type SavedResumeRefusal = "tombstone-bound" | "name-taken" | "historical" | "no-saved-session";

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
	workflowTasks: ReadonlyMap<string, WorkflowTask>,
): AgentSources {
	return {
		getRecord: (id) => manager.getRecord(id),
		records: () => manager.records(),
		latestId: (id) => manager.latestId(id),
		tombstoneById: (id) => manager.tombstoneById(id),
		tombstoneByName: (name) => manager.tombstoneByName(name),
		getEvictedNote: (id) => manager.getEvictedNote(id),
		survivors,
		workflowTasks: () => workflowTasks,
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

/** Whether `asker` may see `record`: a nested child only by its parent, an agent nothing else. */
function sees(asker: Asker, record: AgentRecord): boolean {
	if (record.parentAgentId !== undefined) return asker.kind === "agent" && asker.parentAgentId === record.parentAgentId;
	return asker.kind === "session";
}

/** A record the asker sees: a top-level workflow child as owned, anything else by status. */
function classify(record: AgentRecord, home: Home, base: RefBase): AgentRef {
	if (record.parentAgentId === undefined && record.workflowId !== undefined)
		return { ...base, state: "workflow-owned", owner: { kind: "child", record } };
	return byStatus(record, home, base);
}

/** Names nothing. A hidden match answers this too, so no step or successor id gives it away. */
function miss(requested: string): AgentRef {
	return { requested, latest: requested, via: "none", state: "unknown" };
}

/** The first record the asker sees matching `match`, this manager's before survivors. */
function locate(
	sources: AgentSources,
	survivors: readonly AgentRecord[],
	asker: Asker,
	match: (record: AgentRecord) => boolean,
): { record: AgentRecord; home: Home } | undefined {
	const found = (record: AgentRecord) => sees(asker, record) && match(record);
	for (const record of sources.records()) if (found(record)) return { record, home: "manager" };
	const survivor = survivors.find(found);
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

/** A lookup step that can answer; `none` is the miss. */
type Step = Exclude<AgentRefVia, "none">;

const EVERY_STEP: ReadonlySet<Step> = new Set(["id", "run", "workflow-run", "name", "prefix", "saved"]);

/**
 * Resolve one handle in a fixed order: the successor chain, the exact id (this
 * manager, then survivors), a run id, a workflow run id, a handle or alias
 * (lowercase, as typed before its `agent-` form), then saved history (a
 * tombstone by id, then by name, else an eviction note by id). Id beats name, and
 * live beats saved. Reads memory only.
 */
export function resolveAgent(input: string, asker: Asker, sources: AgentSources): AgentRef {
	const handle = normalizeHandle(input);
	if (!handle) return miss(input);
	return lookup(handle, sources.latestId(handle.raw), asker, sources, EVERY_STEP);
}

/** `resolveAgent`'s order after normalization, running only `steps`: a skipped step cannot shadow a later one. */
function lookup(
	handle: AgentHandle,
	latest: string,
	asker: Asker,
	sources: AgentSources,
	steps: ReadonlySet<Step>,
): AgentRef {
	const base = (via: AgentRefVia): RefBase => ({ requested: handle.raw, latest, via });
	const survivors = sources.survivors();

	const own = sources.getRecord(latest);
	if (own && sees(asker, own)) return classify(own, "manager", base("id"));
	const survivor = survivors.find((record) => record.id === latest && sees(asker, record));
	if (survivor) return classify(survivor, "survivor", base("id"));

	const run = steps.has("run") ? locate(sources, survivors, asker, (record) => record.runId === handle.raw) : undefined;
	if (run) return classify(run.record, run.home, base("run"));

	// Below here everything is the session's: workflow runs, top-level names and saved history.
	if (asker.kind === "agent") return miss(handle.raw);

	const workflowRun = steps.has("workflow-run") && WORKFLOW_RUN_ID.test(handle.raw);
	const task = workflowRun ? sources.workflowTasks().get(handle.raw) : undefined;
	if (task) return { ...base("workflow-run"), state: "workflow-owned", owner: { kind: "run", task } };

	const prefixed = steps.has("prefix") ? stripAgentPrefix(handle.key) : undefined;
	const names: [AgentRefVia, string][] = steps.has("name") ? [["name", handle.key]] : [];
	if (prefixed) names.push(["prefix", prefixed]);
	for (const [via, key] of names) {
		const named = locate(sources, survivors, asker, (record) => record.handle === key || record.alias === key);
		if (named) return classify(named.record, named.home, base(via));
	}

	if (!steps.has("saved")) return miss(handle.raw);
	// Id beats name here too: another conversation's alias must not take a saved id.
	const tombstone =
		sources.tombstoneById(latest) ??
		sources.tombstoneByName(handle.key) ??
		(prefixed ? sources.tombstoneByName(prefixed) : undefined);
	const note = sources.getEvictedNote(tombstone?.id ?? latest);
	if (!tombstone && !note) return miss(handle.raw);
	return { ...base("saved"), state: "saved", note, tombstone, resume: savedResume(tombstone, note) };
}

/** The record a ref carries, if any: a workflow run and saved history have none. */
export function refRecord(ref: AgentRef): AgentRecord | undefined {
	switch (ref.state) {
		case "live":
		case "queued":
		case "retained":
			return ref.record;
		case "workflow-owned":
			if (ref.owner.kind === "child") return ref.owner.record;
			// Exhaustive: a new owner kind fails to compile here instead of mapping to undefined.
			ref.owner.kind satisfies "run";
			return undefined;
		default:
			// Exhaustive likewise for a new state.
			ref.state satisfies "saved" | "unknown";
			return undefined;
	}
}

const SESSION: Asker = { kind: "session" };
/** The legacy lookups never answered with a workflow run, so they read none. */
const NO_WORKFLOWS: ReadonlyMap<string, WorkflowTask> = new Map();

/**
 * What the pre-resolver lookups returned for `input`: a record matched by the
 * exact input under only `steps`, with no normalization and no successor
 * followed (callers follow `latestId` themselves). A workflow child is still
 * returned for the caller's own ownership check; a nested child is not.
 */
function legacyRecord(input: string, sources: AgentSources, steps: ReadonlySet<Step>): AgentRecord | undefined {
	return refRecord(lookup({ raw: input, key: input.toLowerCase() }, input, SESSION, sources, steps));
}

const ID_ONLY: ReadonlySet<Step> = new Set(["id"]);
const ID_THEN_NAME: ReadonlySet<Step> = new Set(["id", "name"]);

export function createAgentLookup(manager: AgentManager, getCtx: () => ExtensionContext | undefined) {
	/** Any live record by exact id, including survivors registered under another session file. */
	const liveAgentById = (id: string) =>
		legacyRecord(
			id,
			agentSources(manager, () => listAllRunningDetached().map(({ agent }) => agent.record), NO_WORKFLOWS),
			ID_ONLY,
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
			ref,
			agentSources(
				manager,
				() => listRunningDetached(getCtx()?.sessionManager?.getSessionFile?.()).map((d) => d.record),
				NO_WORKFLOWS,
			),
			ID_THEN_NAME,
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
