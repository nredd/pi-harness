/** Manager callbacks, resumed-turn ownership and eviction through public APIs. */
import { getEventListeners } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FakeClock } from "@nredd/pi-test-lib/clock";
import { deferred } from "@nredd/pi-test-lib/deferred";
import { makeTestTempDir } from "@nredd/pi-test-lib/temp-dir";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { AgentManager, markConsumed } from "../src/agent-manager.ts";
import { resumeAgent, runAgent } from "../src/agent-runner.ts";
import { streamToOutputFile } from "../src/output-file.ts";
import * as budget from "../src/process-budget.ts";
import { createWorkflowHost } from "../src/workflow/host.ts";
import { runWorkflow } from "../src/workflow/runtime.ts";
import {
	completeWorkflowTask,
	createWorkflowTask,
	pauseWorkflowTask,
	resumeWorkflowTask,
	workflowHostRun,
} from "../src/workflow/task.ts";
import * as worktrees from "../src/worktree.ts";

vi.mock("../src/agent-runner.ts", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));

const pi = {} as ExtensionAPI;
const ctx = { cwd: "/tmp" } as ExtensionContext;
const session = { dispose: vi.fn() } as unknown as AgentSession;
const managers: AgentManager[] = [];
beforeEach(() => {
	vi.mocked(runAgent).mockReset().mockResolvedValue({ responseText: "spawn", session, aborted: false, steered: false });
	vi.mocked(resumeAgent).mockReset();
});
afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.dispose();
	vi.restoreAllMocks();
});

/** Match the typed record callback installed by the extension, with a real final flush. */
function transcriptCleanup(id: string) {
	const root = makeTestTempDir("lifecycle-cleanup-", onTestFinished);
	const path = join(root, "child.output");
	const unsubscribe = vi.fn();
	const child = {
		messages: [{ role: "assistant", content: [{ type: "text", text: "final answer" }] }],
		subscribe: () => unsubscribe,
	} as unknown as AgentSession;
	const flush = streamToOutputFile(child, path, id, root, 0);
	const cleanup = vi.fn(() => {
		flush();
		throw new Error("flush observer failed");
	});
	return { cleanup, unsubscribe, path };
}

/** A caller-controlled runner boundary, no timer or scheduling assumptions. */
function managerWithClock(onStart?: ConstructorParameters<typeof AgentManager>[2]) {
	const clock = new FakeClock();
	const onComplete = vi.fn();
	const onCompact = vi.fn();
	const onUsage = vi.fn();
	const manager = new AgentManager(onComplete, 1, onStart, onCompact, onUsage, undefined, clock);
	managers.push(manager);
	return { manager, clock, onComplete, onCompact, onUsage };
}

describe("retained manager safety guards", () => {
	it("rolls back failed preparation and pumps a reentrant waiter", async () => {
		const f = managerWithClock();
		budget.setBudgetPolicy({ maxActive: 1, nestedReserve: 0, maxDepth: 1 });
		let waiting = "";
		try {
			expect(() =>
				f.manager.spawn(pi, ctx, "general-purpose", "failure", {
					description: "failure",
					isBackground: true,
					onPrepare: () => {
						waiting = f.manager.spawn(pi, ctx, "general-purpose", "waiting", {
							description: "waiting",
							isBackground: true,
						});
						expect(f.manager.getRecord(waiting)?.status).toBe("queued");
						throw new Error("EPERM spool");
					},
				}),
			).toThrow("EPERM spool");
			await f.manager.waitForAll();
			expect(f.manager.listAgents().map((record) => record.id)).toEqual([waiting]);
			expect(f.manager.getRecord(waiting)?.status).toBe("completed");
			expect(runAgent).toHaveBeenCalledTimes(1);
			expect(budget.budgetUsage()).toMatchObject({ active: 0, pending: 0 });
		} finally {
			budget.setBudgetPolicy({ maxActive: 0, nestedReserve: 0, maxDepth: 1 });
		}
	});

	it("does not enqueue a child whose preparation fails while its pool is full", async () => {
		const f = managerWithClock();
		const held = deferred<Awaited<ReturnType<typeof runAgent>>>();
		vi.mocked(runAgent).mockReturnValueOnce(held.promise);
		const running = f.manager.spawn(pi, ctx, "general-purpose", "running", {
			description: "running",
			isBackground: true,
		});
		expect(() =>
			f.manager.spawn(pi, ctx, "general-purpose", "failure", {
				description: "failure",
				isBackground: true,
				onPrepare: () => {
					throw new Error("EPERM spool");
				},
			}),
		).toThrow("EPERM spool");
		expect(f.manager.listAgents().map((record) => record.id)).toEqual([running]);
		expect(budget.budgetUsage()).toMatchObject({ active: 1, pending: 0 });
		held.resolve({ responseText: "done", session, aborted: false, steered: false });
		await f.manager.waitForAll();
		expect(runAgent).toHaveBeenCalledTimes(1);
		expect(budget.budgetUsage()).toMatchObject({ active: 0, pending: 0 });
	});
	it("returns a late budget grant after a faulty cancellation without starting the stopped child", async () => {
		const f = managerWithClock();
		const held = deferred<Awaited<ReturnType<typeof runAgent>>>();
		vi.mocked(runAgent).mockReturnValueOnce(held.promise);
		const enqueue = budget.enqueueBudget;
		// The collaborator retains its waiter despite cancellation. The REAL pump,
		// not this test, later invokes grant through the normal queue protocol.
		vi.spyOn(budget, "enqueueBudget").mockImplementation((waiter) => {
			enqueue(waiter);
			return () => {};
		});
		const running = f.manager.spawn(pi, ctx, "general-purpose", "running", {
			description: "running",
			isBackground: true,
		});
		const blocked = f.manager.spawn(pi, ctx, "general-purpose", "queued", {
			description: "queued",
			isBackground: true,
		});
		expect(f.manager.getRecord(blocked)?.status).toBe("queued");
		expect(f.manager.abort(blocked)).toBe(true);
		held.resolve({ responseText: "done", session, aborted: false, steered: false });
		await f.manager.getRecord(running)?.promise;
		await f.manager.waitForAll();
		expect(f.manager.getRecord(blocked)?.status).toBe("stopped");
		expect(runAgent).toHaveBeenCalledTimes(1);
		expect(budget.budgetUsage()).toMatchObject({ active: 0, pending: 0 });
	});

	it("releases admission when a reentrant budget collaborator evicts the resume session", async () => {
		vi.mocked(resumeAgent).mockResolvedValue({
			text: "must not run without a session",
			aborted: false,
			steered: false,
		});
		const f = managerWithClock();
		const prior = await f.manager.spawnAndWait(pi, ctx, "general-purpose", "prior", { description: "prior" });
		const acquire = budget.tryAcquireBudget;
		vi.spyOn(budget, "tryAcquireBudget").mockImplementationOnce((depth) => {
			f.manager.clearCompleted();
			return acquire(depth);
		});
		await expect(f.manager.resume(prior.id, "again", undefined, { isBackground: true })).resolves.toBe(prior.record);
		expect(prior.record.session).toBeUndefined();
		expect(resumeAgent).not.toHaveBeenCalled();
		expect(budget.budgetUsage()).toMatchObject({ active: 0, pending: 0 });
		const next = await f.manager.spawnAndWait(pi, ctx, "general-purpose", "next", { description: "next" });
		expect(next.record.status).toBe("completed");
	});
});

describe("resumed-turn lifecycle", () => {
	it("flushes and clears output cleanup when a spawned runner rejects", async () => {
		const f = managerWithClock();
		vi.mocked(runAgent).mockRejectedValueOnce(new Error("runner failed"));
		const id = f.manager.spawn(pi, ctx, "general-purpose", "fail", { description: "fail", isBackground: true });
		const record = f.manager.getRecord(id);
		if (!record) throw new Error("record missing");
		const transcript = transcriptCleanup(id);
		// Public record setup at the extension/manager boundary, not private state.
		record.outputCleanup = transcript.cleanup;
		await record.promise;
		expect(JSON.parse(readFileSync(transcript.path, "utf8"))).toMatchObject({
			agentId: id,
			message: { content: [{ type: "text", text: "final answer" }] },
		});
		expect(transcript.unsubscribe).toHaveBeenCalledOnce();
		expect(transcript.cleanup).toHaveBeenCalledOnce();
		expect(record).toMatchObject({ status: "error", error: "runner failed", outputCleanup: undefined });
	});

	it("detaches a queued top-level start without later running it against the old session", async () => {
		const f = managerWithClock();
		const held = deferred<Awaited<ReturnType<typeof runAgent>>>();
		vi.mocked(runAgent).mockReturnValueOnce(held.promise);
		const running = f.manager.spawn(pi, ctx, "general-purpose", "running", {
			description: "running",
			isBackground: true,
		});
		const queued = f.manager.spawn(pi, ctx, "general-purpose", "queued", { description: "queued", isBackground: true });
		expect(f.manager.getRecord(queued)?.status).toBe("queued");
		expect(f.manager.detach()).toBe(1);
		expect(f.manager.getRecord(queued)).toMatchObject({ status: "stopped", completedAt: f.clock.now() });
		held.resolve({ responseText: "done", session, aborted: false, steered: false });
		await f.manager.getRecord(running)?.promise;
		await f.manager.waitForAll();
		expect(runAgent).toHaveBeenCalledTimes(1);
	});

	it("contains rejected live steering and best-effort worktree-prune failures", async () => {
		const f = managerWithClock();
		const child = {
			dispose: vi.fn(),
			steer: vi.fn().mockRejectedValue(new Error("steer failed")),
		} as unknown as AgentSession;
		const held = deferred<Awaited<ReturnType<typeof runAgent>>>();
		vi.mocked(runAgent).mockImplementationOnce((_ctx, _type, _prompt, options) => {
			options.onSessionCreated?.(child);
			return held.promise;
		});
		const id = f.manager.spawn(pi, ctx, "general-purpose", "first", { description: "first", isBackground: true });
		expect(f.manager.steer(id, "late instruction")).toBe(true);
		await expect(vi.mocked(child.steer).mock.results[0]!.value).rejects.toThrow("steer failed");
		held.resolve({ responseText: "done", session: child, aborted: false, steered: false });
		await f.manager.getRecord(id)?.promise;
		expect(f.manager.getRecord(id)?.status).toBe("completed");
		const prune = vi.spyOn(worktrees, "pruneWorktrees").mockRejectedValue(new Error("prune failed"));
		await expect(f.manager.dispose(pi)).resolves.toBeUndefined();
		expect(prune).toHaveBeenCalledWith(pi, process.cwd());
		expect(f.manager.listAgents()).toEqual([]);
	});

	it("stops a foreground owner at detach without overwriting the stop on late runner settlement", async () => {
		const f = managerWithClock();
		const held = deferred<Awaited<ReturnType<typeof runAgent>>>();
		vi.mocked(runAgent).mockReturnValueOnce(held.promise);
		const pending = f.manager.spawnAndWait(pi, ctx, "general-purpose", "foreground", { description: "foreground" });
		const record = f.manager.listAgents()[0]!;
		expect(f.manager.detach()).toBe(0);
		expect(record.abortController?.signal.aborted).toBe(true);
		expect(record.status).toBe("stopped");
		held.resolve({ responseText: "late", session, aborted: false, steered: false });
		expect((await pending).record).toMatchObject({ status: "stopped", result: "late" });
	});

	it("forwards detached activity, usage and compaction, detaches parent abort, and flushes output once", async () => {
		const f = managerWithClock();
		const { id, record } = await f.manager.spawnAndWait(pi, ctx, "general-purpose", "first", { description: "first" });
		const held = deferred<Awaited<ReturnType<typeof resumeAgent>>>();
		vi.mocked(resumeAgent).mockReturnValue(held.promise);
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		const transcript = transcriptCleanup(id);
		record.outputCleanup = transcript.cleanup;
		const onToolActivity = vi.fn();
		const onAssistantUsage = vi.fn();
		const onCompaction = vi.fn();
		await f.manager.resume(id, "again", controller.signal, {
			isBackground: true,
			onToolActivity,
			onAssistantUsage,
			onCompaction,
		});
		const opts = vi.mocked(resumeAgent).mock.calls[0]![2];
		const activity = { type: "end" as const, toolName: "read", id: "tool" };
		const usage = { input: 3, output: 4, cacheWrite: 5, cost: 0.1 };
		const compact = { reason: "manual" as const, tokensBefore: 99 };
		opts?.onToolActivity?.(activity);
		opts?.onAssistantUsage?.(usage, {});
		opts?.onCompaction?.(compact);
		expect(record.toolUses).toBe(1);
		expect(record.lifetimeUsage).toMatchObject(usage);
		expect(record.compactionCount).toBe(1);
		expect(onToolActivity).toHaveBeenCalledWith(activity);
		expect(onAssistantUsage).toHaveBeenCalledWith(usage);
		expect(onCompaction).toHaveBeenCalledWith(compact);
		expect(f.onUsage).toHaveBeenCalledWith(record, usage);
		expect(f.onCompact).toHaveBeenCalledWith(record, compact);
		held.resolve({ text: "resumed", aborted: false, steered: false });
		await record.promise;
		expect(record).toMatchObject({ status: "completed", result: "resumed", outputCleanup: undefined });
		expect(JSON.parse(readFileSync(transcript.path, "utf8"))).toMatchObject({
			agentId: id,
			message: { content: [{ type: "text", text: "final answer" }] },
		});
		expect(transcript.unsubscribe).toHaveBeenCalledOnce();
		expect(transcript.cleanup).toHaveBeenCalledOnce();
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
		controller.abort();
		expect(record.status).toBe("completed");
	});

	it("stops the actual detached resume when its parent aborts", async () => {
		const f = managerWithClock();
		const { id, record } = await f.manager.spawnAndWait(pi, ctx, "general-purpose", "first", { description: "first" });
		const held = deferred<Awaited<ReturnType<typeof resumeAgent>>>();
		vi.mocked(resumeAgent).mockReturnValue(held.promise);
		const parent = new AbortController();
		await f.manager.resume(id, "again", parent.signal, { isBackground: true });
		parent.abort();
		expect(vi.mocked(resumeAgent).mock.calls[0]![2]?.signal?.aborted).toBe(true);
		held.resolve({ text: "late text", aborted: false, steered: false });
		await record.promise;
		expect(record).toMatchObject({ status: "stopped", result: "late text" });
	});

	it("does not strand the pool when a queued resume's startup observer throws", async () => {
		let failingId: string | undefined;
		const f = managerWithClock((record) => {
			if (record.id === failingId) throw new Error("resume observer failed");
		});
		const prior = await f.manager.spawnAndWait(pi, ctx, "general-purpose", "prior", { description: "prior" });
		const held = deferred<Awaited<ReturnType<typeof runAgent>>>();
		vi.mocked(runAgent).mockReturnValueOnce(held.promise);
		const blocker = f.manager.spawn(pi, ctx, "general-purpose", "blocker", {
			description: "blocker",
			isBackground: true,
		});
		failingId = prior.id;
		f.onComplete.mockImplementation((record) => {
			if (record.error) throw new Error("completion observer failed");
		});
		await f.manager.resume(prior.id, "again", undefined, { isBackground: true });
		expect(prior.record.status).toBe("queued");
		held.resolve({ responseText: "blocker done", session, aborted: false, steered: false });
		await f.manager.getRecord(blocker)?.promise;
		await f.manager.waitForAll();
		expect(prior.record).toMatchObject({ status: "error", error: "resume observer failed" });
		expect(f.onComplete).toHaveBeenCalledWith(prior.record);
		expect(resumeAgent).not.toHaveBeenCalled();
		failingId = undefined;
		const next = f.manager.spawn(pi, ctx, "general-purpose", "next", { description: "next", isBackground: true });
		await f.manager.getRecord(next)?.promise;
		expect(f.manager.getRecord(next)?.status).toBe("completed");
	});
});

describe("workflow host lifecycle", () => {
	let workflowCtx: ExtensionContext;
	beforeEach(() => {
		workflowCtx = {
			...ctx,
			cwd: makeTestTempDir("workflow-roster-", onTestFinished),
			sessionManager: { getSessionId: () => "root" },
		} as ExtensionContext;
	});
	const allowed = new Set(["general-purpose"]);
	const readRoster = (manager: AgentManager, id: string) => manager.roster.child(id, allowed).agents;

	const request = (label: string) => ({ agentId: label, index: 0, label, prompt: label, agentType: "general-purpose" });

	it("denies roster while paused and restores it after resume", async () => {
		const { manager } = managerWithClock();
		const task = createWorkflowTask({ id: "wf_pause", script: "" });
		task.control = {
			pause: vi.fn(),
			resume: vi.fn(),
			isPaused: () => task.status === "paused",
			skip: () => false,
			retry: () => false,
		};
		const host = createWorkflowHost({
			pi,
			ctx: workflowCtx,
			manager,
			...workflowHostRun(task),
		});
		await host.spawnAgent(request("sibling"));
		const done = { responseText: "done", session, aborted: false, steered: false };
		const held = deferred<typeof done>();
		vi.mocked(runAgent).mockReturnValueOnce(held.promise);
		const wait = host.spawnAgent(request("caller"));
		try {
			const caller = manager.listAgents().find((record) => record.description === "caller")!;
			const assignments = () => readRoster(manager, caller.id).map((entry) => entry.assignment);
			expect(assignments()).toEqual(["", "caller", "sibling"]);
			expect(pauseWorkflowTask(task, 1)).toBe(true);
			expect(task.abortController.signal.aborted).toBe(false);
			expect(caller.status).toBe("running");
			expect(assignments).toThrow("no active workflow run");
			expect(manager.roster.audit("root")).toHaveLength(1);
			expect(resumeWorkflowTask(task, 2)).toBe(true);
			expect(assignments()).toEqual(["", "caller", "sibling"]);
		} finally {
			held.resolve(done);
			await wait;
		}
	}, 10_000);

	it("detaches the workflow abort listener when cancelling a queued worker", async () => {
		const { manager } = managerWithClock();
		const policy = budget.getBudgetPolicy();
		budget.setBudgetPolicy({ maxActive: 1, nestedReserve: 0, maxDepth: 1 });
		const signal = new AbortController().signal;
		const host = createWorkflowHost({
			pi,
			ctx: workflowCtx,
			manager,
			workflowId: "wf_queued",
			signal,
			isRunning: () => true,
		});
		const done = { responseText: "done", session, aborted: false, steered: false };
		const held = deferred<typeof done>();
		vi.mocked(runAgent).mockReturnValueOnce(held.promise);
		const blocker = host.spawnAgent(request("blocker"));
		const listenerCount = () => getEventListeners(signal, "abort").length;
		const before = listenerCount();
		const queued = host.spawnAgent(request("queued"));
		try {
			expect(manager.listAgents().find((record) => record.description === "queued")?.status).toBe("queued");
			expect(listenerCount()).toBe(before + 1);
			host.abortAgent("queued");
			expect(listenerCount()).toBe(before);
			expect(await queued).toMatchObject({ skipped: true });
		} finally {
			held.resolve(done);
			await Promise.all([blocker, queued]);
			budget.setBudgetPolicy(policy);
		}
	}, 10_000);

	it("does not publish an inspector id for an unretained startup failure", async () => {
		const { manager } = managerWithClock();
		vi.spyOn(worktrees, "createWorktree").mockRejectedValueOnce(new Error("no git repo"));
		const host = createWorkflowHost({ pi, ctx: workflowCtx, manager });
		const onResolved = vi.fn();
		const result = await host.spawnAgent({ ...request("broken"), isolation: "worktree", onResolved });
		expect(result).toMatchObject({ ok: false, error: expect.stringContaining("no git repo") });
		expect(manager.listAgents()).toEqual([]);
		expect(onResolved).not.toHaveBeenCalled();
	});

	it("denies roster after workflow failure", async () => {
		const { manager } = managerWithClock();
		const path = makeTestTempDir("workflow-pending-", onTestFinished);
		const copy = { path, workPath: path, repoRoot: path, branch: "test", baseSha: "abc" };
		const pending = deferred<typeof copy>();
		const create = vi.spyOn(worktrees, "createWorktree").mockReturnValue(pending.promise);
		const cleanup = vi.spyOn(worktrees, "cleanupWorktree").mockResolvedValue({ hasChanges: false });
		const task = createWorkflowTask({
			id: "wf_shared",
			script: `export const meta = { name: "roster", description: "fixture" };
				await agent("retained assignment", { label: "retained" });
				agent("pending worker", { label: "pending", isolation: "worktree" });`,
		});
		const host = createWorkflowHost({
			pi,
			ctx: workflowCtx,
			manager,
			...workflowHostRun(task),
		});
		let startup: Promise<void> | undefined;
		try {
			const result = await runWorkflow({ script: task.script, host, signal: AbortSignal.timeout(10_000) });
			completeWorkflowTask(task, result);
			const worker = manager.listAgents().find((record) => record.description === "pending")!;
			const retained = manager.listAgents().find((record) => record.description === "retained")!;
			startup = manager.awaitStartup(worker.id);
			expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("unawaited agent launch") });
			expect(create).toHaveBeenCalledOnce();
			expect(worker.status).toBe("stopped");
			expect(() => readRoster(manager, worker.id)).toThrow("Agent roster unavailable");

			// Exercise the workflow guard independently of the worker status guard
			// by reopening a retained worker directly through the manager.
			const held = deferred<Awaited<ReturnType<typeof resumeAgent>>>();
			vi.mocked(resumeAgent).mockReturnValueOnce(held.promise);
			const resume = manager.resume(retained.id, "late turn");
			try {
				expect(retained.status).toBe("running");
				expect(() => readRoster(manager, retained.id)).toThrow("no active workflow run");
				expect(manager.roster.audit("root")).toEqual([]);
			} finally {
				held.resolve({ text: "done", aborted: false, steered: false });
				await resume;
			}
		} finally {
			pending.resolve(copy);
			await startup;
		}
		expect(cleanup).toHaveBeenCalledOnce();
		expect(runAgent).toHaveBeenCalledOnce();
	}, 15_000);

	it("isolates duplicate workflow IDs", async () => {
		const { manager } = managerWithClock();
		const host = () =>
			createWorkflowHost({
				pi,
				ctx: workflowCtx,
				manager,
				workflowId: "wf_shared",
				signal: new AbortController().signal,
				isRunning: () => true,
			});
		const [first, second] = [host(), host()];
		const request = (label: string) => ({
			agentId: label,
			index: 0,
			label,
			prompt: label,
			agentType: "general-purpose",
		});
		await first.spawnAgent(request("first assignment"));
		await second.spawnAgent(request("second assignment"));
		const done = { responseText: "done", session, aborted: false, steered: false };
		const held = deferred<typeof done>();
		vi.mocked(runAgent).mockReturnValueOnce(held.promise);
		const wait = second.spawnAgent(request("caller"));
		try {
			const caller = manager.listAgents().find((record) => record.description === "caller")!;
			expect(manager.listAgents().map((record) => record.workflowId)).toEqual(["wf_shared", "wf_shared", "wf_shared"]);
			expect(readRoster(manager, caller.id).map((entry) => entry.assignment)).toEqual([
				"",
				"caller",
				"second assignment",
			]);
		} finally {
			held.resolve(done);
			await wait;
		}
	}, 10_000);

	it("reports retained model provenance before resume and resolves an explicit nested script file", async () => {
		const dir = makeTestTempDir("lifecycle-host-", onTestFinished);
		const f = managerWithClock((record) => {
			record.modelFallback = { input: "expired-pin", used: "p/model" };
		});
		const host = createWorkflowHost({ pi, ctx, manager: f.manager, homeDir: dir });
		const source = 'export const meta = {name: "nested", description: "d"};';
		const path = join(dir, "nested.js");
		writeFileSync(path, source);
		expect(await host.loadWorkflow?.({ scriptPath: path })).toEqual({ ok: true, script: source, path });
		const initial = await host.spawnAgent({
			agentId: "runtime-id",
			index: 0,
			prompt: "p",
			label: "child",
			agentType: "general-purpose",
		});
		expect(initial.text).toContain('configured model "expired-pin" did not resolve');
		vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed", aborted: false, steered: false });
		const onResolved = vi.fn();
		const resumed = await host.resumeAgent?.("runtime-id", "again", onResolved);
		expect(onResolved).toHaveBeenCalledWith(
			expect.objectContaining({ recordId: expect.any(String), modelNote: expect.stringContaining("expired-pin") }),
		);
		expect(resumed).toMatchObject({
			ok: true,
			text: expect.stringContaining("resumed"),
			modelNote: expect.stringContaining("expired-pin"),
		});
		const id = f.manager.listAgents()[0]!.id;
		f.manager.clearCompleted();
		expect(await host.resumeAgent?.("runtime-id", "too late")).toEqual({
			ok: false,
			error: `Agent ${id} has no session left to resume — records are dropped ten minutes after they finish.`,
		});
	});
});

describe("eviction records", () => {
	it("retains every evicted id for the session, past the old 500 cap", async () => {
		const f = managerWithClock();
		const ids: string[] = [];
		let newest = "";
		for (let i = 0; i < 502; i++) {
			const { id, record } = await f.manager.spawnAndWait(pi, ctx, "general-purpose", `run-${i}`, {
				description: `run-${i}`,
			});
			ids.push(id);
			newest = id;
			markConsumed(record, f.clock.now());
			expect(record).toMatchObject({ resultConsumed: true, consumedAt: f.clock.now() });
			f.clock.advance(600000);
		}
		expect(f.manager.getRecord(newest)).toBeUndefined();
		expect(f.manager.getEvictedNote(ids[0]!)).toMatchObject({ id: ids[0], description: "run-0" });
		expect(f.manager.getEvictedNote(ids[1]!)).toMatchObject({ id: ids[1], description: "run-1" });
		expect(f.manager.getEvictedNote(ids[2]!)).toMatchObject({ id: ids[2], description: "run-2", status: "completed" });
		expect(f.manager.getEvictedNote(newest)).toMatchObject({
			id: newest,
			description: "run-501",
			status: "completed",
			evictedAfterMin: 10,
		});
	});
});
