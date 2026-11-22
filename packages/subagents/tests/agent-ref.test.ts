/** The agent-id resolver: every state, every transition, the lookup order, visibility and the legacy lookups. */
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FakeClock } from "@nredd/pi-test-lib/clock";
import { deferred } from "@nredd/pi-test-lib/deferred";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { AgentManager, type EvictedNote, markConsumed } from "../src/agent-manager.ts";
import {
	type AgentRef,
	type AgentSources,
	type Asker,
	agentSources,
	createAgentLookup,
	MAX_AGENT_HANDLE_CHARS,
	refRecord,
	resolveAgent,
} from "../src/agent-ref.ts";
import { resumeAgent, runAgent } from "../src/agent-runner.ts";
import { registerRunningDetached, unregisterRunningDetached } from "../src/detached-results.ts";
import type { AgentRecord } from "../src/types.ts";
import { createWorkflowTask, type WorkflowTask } from "../src/workflow/task.ts";

vi.mock("../src/agent-runner.ts", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));

type RunResult = Awaited<ReturnType<typeof runAgent>>;

const pi = {} as ExtensionAPI;
const ctx = { cwd: "/tmp" } as ExtensionContext;
const session = { dispose: vi.fn() } as unknown as AgentSession;
const SESSION: Asker = { kind: "session" };
const managers: AgentManager[] = [];

beforeEach(() => {
	vi.mocked(runAgent).mockReset();
	vi.mocked(resumeAgent).mockReset();
});
afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.dispose();
	vi.restoreAllMocks();
});

function newManager(clock = new FakeClock()) {
	const manager = new AgentManager(undefined, 1, undefined, undefined, undefined, undefined, clock);
	managers.push(manager);
	return manager;
}

/** Hold the next run until `finish` is called. */
function holdRun() {
	const run = deferred<RunResult>();
	vi.mocked(runAgent).mockImplementationOnce(() => run.promise);
	return () => run.resolve({ responseText: "done", session, aborted: false, steered: false });
}

/** Hold every run until the returned release is called. */
function holdAll() {
	const run = deferred<RunResult>();
	vi.mocked(runAgent).mockImplementation(() => run.promise);
	return () => run.resolve({ responseText: "done", session, aborted: false, steered: false });
}

function spawn(manager: AgentManager, description: string, options: Record<string, unknown> = {}): AgentRecord {
	const id = manager.spawn(pi, ctx, "general-purpose", description, { description, isBackground: true, ...options });
	return manager.getRecord(id)!;
}

function sourcesOf(
	manager: AgentManager,
	survivors: readonly AgentRecord[] = [],
	tasks: ReadonlyMap<string, WorkflowTask> = new Map(),
): AgentSources {
	return agentSources(
		manager,
		() => survivors,
		() => tasks,
	);
}

/** The parts of a ref worth comparing: state, step, ids and the record it names. */
function shape(ref: AgentRef) {
	return { state: ref.state, via: ref.via, requested: ref.requested, latest: ref.latest, id: refRecord(ref)?.id };
}

it("tracks one agent from launch through grant, settle, resume in place, eviction, reopen and tombstone drop", async () => {
	const clock = new FakeClock();
	const manager = newManager(clock);
	const sources = sourcesOf(manager);
	const at = (input: string) => resolveAgent(input, SESSION, sources);
	expect(at("explore").state).toBe("unknown");

	// unknown -> live and unknown -> queued on launch: one pool slot.
	const finishFirst = holdRun();
	const first = spawn(manager, "first");
	const finishSecond = holdRun();
	const second = spawn(manager, "second");
	const third = spawn(manager, "third");
	expect(at(first.id)).toMatchObject({ state: "live", home: "manager", via: "id", record: first });
	expect(at(second.id)).toMatchObject({ state: "queued", home: "manager", record: second });

	// queued -> retained when stopped while queued: no session to resume.
	manager.abort(third.id);
	expect(at(third.id)).toMatchObject({ state: "retained", resume: { mode: "none", why: "no-session" } });

	// queued -> live on grant; live -> retained on settle, resumable in place.
	const granted = second.startGate;
	finishFirst();
	await first.promise;
	await granted;
	expect(at(second.id).state).toBe("live");
	finishSecond();
	await second.promise;
	expect(at(second.id)).toMatchObject({ state: "retained", resume: { mode: "in-place" } });

	// retained -> live on resume in place, under a new run id that resolves too.
	const runBefore = second.runId;
	const resumed = deferred<Awaited<ReturnType<typeof resumeAgent>>>();
	const entered = deferred();
	vi.mocked(resumeAgent).mockImplementation(() => {
		entered.resolve();
		return resumed.promise;
	});
	const resuming = manager.resume(second.id, "again");
	await entered.promise;
	expect(at(second.id).state).toBe("live");
	expect(second.runId).not.toBe(runBefore);
	expect(shape(at(second.runId!))).toMatchObject({ state: "live", via: "run", id: second.id });
	expect(at(runBefore!).state).toBe("unknown");
	resumed.resolve({ text: "again", aborted: false, steered: false } as Awaited<ReturnType<typeof resumeAgent>>);
	await resuming;

	// retained -> saved on eviction: reopenable by id and by name.
	second.sessionFile = "/sessions/second.jsonl";
	markConsumed(second, clock.now());
	clock.advance(11 * 60_000);
	expect(manager.getRecord(second.id)).toBeUndefined();
	const handle = second.handle!;
	for (const input of [second.id, handle, handle.toUpperCase(), `agent-${handle}`]) {
		expect(at(input)).toMatchObject({
			state: "saved",
			via: "saved",
			note: { id: second.id },
			resume: { mode: "reopen", entry: { id: second.id } },
		});
	}

	// saved -> live under a new id on reopen; the old id follows the successor link.
	const finishReopen = holdRun();
	const reopened = spawn(manager, "reopened", { reclaim: { handle } });
	manager.linkSuccessor(second.id, reopened.id);
	expect(shape(at(second.id))).toEqual({
		state: "live",
		via: "id",
		requested: second.id,
		latest: reopened.id,
		id: reopened.id,
	});
	expect(shape(at(handle))).toMatchObject({ state: "live", via: "name", id: reopened.id });
	finishReopen();
	await reopened.promise;

	// saved -> unknown once the tombstone is dropped: the name goes, the id keeps its note.
	manager.unlinkSuccessor(second.id);
	manager.dropTombstone(handle);
	reopened.handle = undefined;
	expect(at(handle).state).toBe("unknown");
	expect(at(second.id)).toMatchObject({ state: "saved", resume: { mode: "none", why: "no-saved-session" } });
});

it("reports restart history as saved and a session-switch survivor as live, live beating saved", async () => {
	const before = newManager();
	const release = holdAll();
	const survivor = spawn(before, "survivor");

	// After a restart there are only saved rows, with and without a reopenable session.
	const after = newManager();
	const note = (id: string, extra: Partial<EvictedNote> = {}): EvictedNote => ({
		id,
		type: "general-purpose",
		description: id,
		status: "completed",
		evictedAfterMin: 0,
		fromSavedSession: true,
		...extra,
	});
	after.rememberEvicted(note("reopenable"));
	after.rememberTombstone({
		id: "reopenable",
		handle: "scout",
		type: "general-purpose",
		description: "reopenable",
		sessionFile: "/sessions/reopenable.jsonl",
		completedAt: 0,
	});
	after.rememberEvicted(note("historical"));
	after.rememberEvicted(note("bounded", { fromSavedSession: undefined, tombstoneBoundSession: "/sessions/b.jsonl" }));
	after.rememberEvicted(note("taken", { fromSavedSession: undefined, nameTaken: "scout" }));
	// The survivor's own id also has saved terminal history; the live run wins.
	after.rememberEvicted(note(survivor.id));
	const at = (input: string) => resolveAgent(input, SESSION, sourcesOf(after, [survivor]));

	expect(at("SCOUT")).toMatchObject({ state: "saved", resume: { mode: "reopen", entry: { id: "reopenable" } } });
	expect(at("historical")).toMatchObject({ state: "saved", resume: { mode: "none", why: "historical" } });
	expect(at("bounded")).toMatchObject({ state: "saved", resume: { mode: "none", why: "tombstone-bound" } });
	expect(at("taken")).toMatchObject({ state: "saved", resume: { mode: "none", why: "name-taken" } });
	for (const input of [survivor.id, survivor.handle!, survivor.runId!])
		expect(at(input)).toMatchObject({ state: "live", home: "survivor", record: survivor });

	survivor.status = "queued";
	expect(at(survivor.id)).toMatchObject({ state: "queued", home: "survivor" });
	survivor.status = "running";
	release();
	await before.waitForAll();
});

it("resolves id before run id, workflow run, name, prefix form and saved history", async () => {
	const manager = newManager();
	const release = holdAll();
	const a = spawn(manager, "a");
	const b = spawn(manager, "b");
	// B's alias spells A's id, and C's alias spells B's run id: each lower step loses.
	b.alias = a.id;
	const c = spawn(manager, "c");
	c.alias = b.runId;
	const task = createWorkflowTask({ id: "wf_abc123def456", script: "" });
	const tasks = new Map([[task.id, task]]);
	const at = (input: string) => resolveAgent(input, SESSION, sourcesOf(manager, [], tasks));

	expect(shape(at(a.id))).toMatchObject({ via: "id", id: a.id });
	expect(shape(at(b.runId!))).toMatchObject({ via: "run", id: b.id });
	expect(at(task.id)).toMatchObject({ state: "workflow-owned", via: "workflow-run", owner: { kind: "run", task } });
	expect(refRecord(at(task.id))).toBeUndefined();
	expect(at("wf_abc123ffffff").state).toBe("unknown");

	// A live name beats a tombstone of the same name; the as-typed name beats its `agent-` form.
	manager.rememberTombstone({
		id: "gone",
		handle: "general-purpose-9",
		type: "general-purpose",
		description: "gone",
		sessionFile: "/sessions/gone.jsonl",
		completedAt: 0,
	});
	a.alias = "general-purpose-9";
	b.alias = "agent-scout";
	c.alias = "scout";
	expect(shape(at("General-Purpose-9"))).toMatchObject({ state: "live", via: "name", id: a.id });
	expect(shape(at("agent-scout"))).toMatchObject({ via: "name", id: b.id });
	b.alias = undefined;
	expect(shape(at("@agent-scout"))).toMatchObject({ via: "prefix", requested: "agent-scout", id: c.id });

	// Normalization: one leading `@` and surrounding space go; empty or overlong names nothing.
	expect(shape(at("  @scout "))).toMatchObject({ via: "name", requested: "scout", id: c.id });
	for (const input of ["", " @ ", "x".repeat(MAX_AGENT_HANDLE_CHARS + 1)])
		expect(at(input)).toMatchObject({ state: "unknown", via: "none" });
	expect(at("x".repeat(MAX_AGENT_HANDLE_CHARS)).state).toBe("unknown");
	release();
	await manager.waitForAll();
});

it("shows a nested child only to its parent and a workflow child as owned", async () => {
	const manager = newManager();
	const release = holdAll();
	const parent = spawn(manager, "parent");
	const child = spawn(manager, "child", { parentAgentId: parent.id, depth: 2, isBackground: false });
	const worker = spawn(manager, "worker", { workflowId: "wf_abc123def456" });
	const sources = sourcesOf(manager);
	const asParent: Asker = { kind: "agent", parentAgentId: parent.id };
	const asStranger: Asker = { kind: "agent", parentAgentId: worker.id };

	for (const input of [child.id, child.runId!]) {
		expect(resolveAgent(input, asParent, sources)).toMatchObject({ state: "live", record: child });
		expect(resolveAgent(input, SESSION, sources).state).toBe("unknown");
		expect(resolveAgent(input, asStranger, sources).state).toBe("unknown");
	}
	expect(resolveAgent(worker.id, SESSION, sources)).toMatchObject({
		state: "workflow-owned",
		via: "id",
		owner: { kind: "child", record: worker },
	});
	expect(refRecord(resolveAgent(worker.id, SESSION, sources))).toBe(worker);
	// An agent reaches none of the session's agents, names or history.
	for (const input of [parent.id, worker.id, parent.handle!, "wf_abc123def456"])
		expect(resolveAgent(input, asParent, sources).state).toBe("unknown");

	release();
	await manager.waitForAll();
});

it("keeps the legacy lookups' contract, now matching survivor names case-insensitively", async () => {
	const orphaned = newManager();
	const release = holdAll();
	const survivor = spawn(orphaned, "survivor", { name: "auth-audit" });
	const own = "/sessions/own.jsonl";
	const other = "/sessions/other.jsonl";
	registerRunningDetached(own, { record: survivor, abort: () => false, steer: () => false });
	onTestFinished(() => unregisterRunningDetached(own, survivor.id));
	const manager = newManager();
	const parent = spawn(manager, "parent");
	const nested = spawn(manager, "nested", { parentAgentId: parent.id, depth: 2, isBackground: false });
	const worker = spawn(manager, "worker", { workflowId: "wf_abc123def456" });
	const elsewhere = spawn(orphaned, "elsewhere");
	registerRunningDetached(other, { record: elsewhere, abort: () => false, steer: () => false });
	onTestFinished(() => unregisterRunningDetached(other, elsewhere.id));
	const sessionCtx = { sessionManager: { getSessionFile: () => own } } as unknown as ExtensionContext;
	const { liveAgentById, resolveAgentRef } = createAgentLookup(manager, () => sessionCtx);

	expect(resolveAgentRef("AUTH-AUDIT")).toBe(survivor);
	expect(resolveAgentRef(survivor.id)).toBe(survivor);
	expect(resolveAgentRef(parent.handle!.toUpperCase())).toBe(parent);
	expect(resolveAgentRef(worker.id)).toBe(worker);
	// Unchanged: no normalization, no run ids, no nested children, no other session's survivors.
	for (const input of [
		`@${parent.handle}`,
		` ${parent.id}`,
		parent.runId!,
		nested.id,
		elsewhere.id,
		worker.workflowId!,
	])
		expect(resolveAgentRef(input)).toBeUndefined();
	expect(createAgentLookup(manager, () => undefined).resolveAgentRef("auth-audit")).toBeUndefined();

	expect(liveAgentById(elsewhere.id)).toBe(elsewhere);
	expect(liveAgentById(parent.id)).toBe(parent);
	for (const input of [parent.handle!, nested.id, parent.runId!, worker.workflowId!])
		expect(liveAgentById(input)).toBeUndefined();
	// Neither follows a successor link: callers resolve `latestId` themselves.
	manager.linkSuccessor("gone", parent.id);
	expect(resolveAgentRef("gone")).toBeUndefined();
	expect(liveAgentById("gone")).toBeUndefined();

	release();
	await Promise.all([manager.waitForAll(), orphaned.waitForAll()]);
});
