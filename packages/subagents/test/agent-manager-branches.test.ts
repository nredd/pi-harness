/** AgentManager arms the main suite never takes: owned-record resumes, stops racing a rejection, name bookkeeping. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { resetBudgetForTests, setBudgetPolicy } from "../src/process-budget.js";
import { FakeClock } from "./helpers/fake-clock.js";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

import { resumeAgent, runAgent } from "../src/agent-runner.js";

const pi = {} as any;
const ctx = { cwd: "/tmp" } as any;
let manager: AgentManager | undefined;
/** Past both retention windows, so the next sweep evicts every settled record. */
const PAST_RETENTION_MS = 2 * 60 * 60_000;

/** A manager on a fake clock, so the retention sweep (which keeps tombstones) can be driven. */
function clocked(clock: FakeClock, maxConcurrent = 4) {
  return new AgentManager(undefined, maxConcurrent, undefined, undefined, undefined, undefined, clock);
}

afterEach(() => {
  resetBudgetForTests();
  manager?.dispose();
  manager = undefined;
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
});

/** A runner that hands the manager a session (with a transcript path) and answers `text`. */
function answering(text = "done", sessionFile?: string) {
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
    const session = { dispose: vi.fn(), sessionManager: { getSessionFile: () => sessionFile } } as any;
    options.onSessionCreated?.(session);
    return { responseText: text, session, aborted: false, steered: false };
  });
}

async function settledSpawn(m: AgentManager, options: Record<string, unknown>) {
  const id = m.spawn(pi, ctx, "general-purpose", "go", { description: "child", isBackground: true, ...options });
  await m.getRecord(id)!.promise;
  return m.getRecord(id)!;
}

describe("AgentManager owned-record background resume", () => {
  it("starts a nested child's background resume outside the full background pool, and leaves the pool count alone", async () => {
    manager = new AgentManager(undefined, 1);
    answering();
    const child = await settledSpawn(manager, { parentAgentId: "parent-1" });
    // Hold the only background slot with a live top-level agent.
    let finishBlocker!: () => void;
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise(resolve => {
      finishBlocker = () => resolve({ responseText: "blocker", session: { dispose: vi.fn() } as any, aborted: false, steered: false });
    }));
    const blocker = manager.spawn(pi, ctx, "general-purpose", "block", { description: "blocker", isBackground: true });
    expect(manager.getRecord(blocker)!.status).toBe("running");

    let finishResume!: () => void;
    vi.mocked(resumeAgent).mockImplementationOnce(() => new Promise(resolve => {
      finishResume = () => resolve({ text: "resumed", aborted: false, steered: false } as any);
    }));
    const resumed = await manager.resume(child.id, "again", undefined, { isBackground: true });
    expect(resumed?.status).toBe("running");
    finishResume();
    await resumed!.promise;
    expect(manager.getRecord(child.id)).toMatchObject({ status: "completed", result: "resumed" });

    // The pool still counts exactly the blocker: a second top-level spawn queues behind it.
    answering();
    const queued = manager.spawn(pi, ctx, "general-purpose", "next", { description: "next", isBackground: true });
    expect(manager.getRecord(queued)!.status).toBe("queued");
    finishBlocker();
    await manager.waitForAll();
    expect(manager.getRecord(queued)!.status).toBe("completed");
  });

  it("fails a workflow child's background resume whose onStart throws, without touching the pool", async () => {
    let throwOnStart = false;
    manager = new AgentManager(undefined, 1, () => { if (throwOnStart) throw "start hook refused"; });
    answering();
    const child = await settledSpawn(manager, { workflowId: "wf_1" });
    throwOnStart = true;
    await expect(manager.resume(child.id, "again", undefined, { isBackground: true })).rejects.toBe("start hook refused");
    expect(manager.getRecord(child.id)).toMatchObject({ status: "error", error: "start hook refused" });
    expect(resumeAgent).not.toHaveBeenCalled();

    throwOnStart = false;
    answering();
    const first = manager.spawn(pi, ctx, "general-purpose", "one", { description: "one", isBackground: true });
    const second = manager.spawn(pi, ctx, "general-purpose", "two", { description: "two", isBackground: true });
    expect([manager.getRecord(first)!.status, manager.getRecord(second)!.status]).toEqual(["running", "queued"]);
    await manager.waitForAll();
  });
});

describe("AgentManager stop racing a rejected run", () => {
  it("keeps an external stop when the runner then rejects with a non-Error", async () => {
    manager = new AgentManager();
    let reject!: (reason: unknown) => void;
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const id = manager.spawn(pi, ctx, "general-purpose", "go", { description: "child", isBackground: true });
    expect(manager.abort(id)).toBe(true);
    reject("socket closed");
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)).toMatchObject({ status: "stopped", error: "socket closed" });
  });
});

describe("AgentManager foreground resume stops", () => {
  it("keeps an external stop when the resumed run then rejects", async () => {
    manager = new AgentManager();
    answering();
    const record = await settledSpawn(manager, {});
    let reject!: (reason: unknown) => void;
    vi.mocked(resumeAgent).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const resuming = manager.resume(record.id, "again");
    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalled());
    expect(manager.abort(record.id)).toBe(true);
    reject(new Error("aborted by signal"));
    await expect(resuming).resolves.toMatchObject({ status: "stopped", error: undefined });
  });

  it("stops a resume that waits for a budget lease on an already-cancelled call, without queueing it", async () => {
    setBudgetPolicy({ maxActive: 1, nestedReserve: 0, maxDepth: 1 });
    manager = new AgentManager();
    answering();
    const record = await settledSpawn(manager, {});
    // Hold the only process-wide lease.
    let finishBlocker!: () => void;
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise(resolve => {
      finishBlocker = () => resolve({ responseText: "blocker", session: { dispose: vi.fn() } as any, aborted: false, steered: false });
    }));
    manager.spawn(pi, ctx, "general-purpose", "block", { description: "blocker", isBackground: true });

    const cancelled = new AbortController();
    cancelled.abort();
    const resumed = await manager.resume(record.id, "again", cancelled.signal);
    expect(resumed).toMatchObject({ status: "stopped" });
    expect(resumeAgent).not.toHaveBeenCalled();
    finishBlocker();
    await manager.waitForAll();
    expect(resumeAgent).not.toHaveBeenCalled();
  });
});

describe("AgentManager names", () => {
  it("keeps an evicted agent's alias taken, so a same-named spawn numbers past it", async () => {
    const clock = new FakeClock();
    manager = clocked(clock);
    answering("done", "/tmp/scout.jsonl");
    const first = await settledSpawn(manager, { name: "scout" });
    expect(first.alias).toBe("scout");
    clock.advance(PAST_RETENTION_MS);
    expect(manager.getRecord(first.id)).toBeUndefined();

    const second = await settledSpawn(manager, { name: "scout" });
    expect(second.alias).toBe("scout-2");
    expect(manager.resolveMention("scout")).toMatchObject({ kind: "tombstone", entry: { id: first.id } });
    expect(manager.resolveMention("scout-2")).toMatchObject({ kind: "live", record: { id: second.id } });
  });

  it("drops the oldest tombstone by completion time, not by eviction order", async () => {
    const clock = new FakeClock();
    manager = clocked(clock, 200);
    const finishers: (() => void)[] = [];
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, prompt, options: any) => {
      const session = { dispose: vi.fn(), sessionManager: { getSessionFile: () => `/tmp/${prompt}.jsonl` } } as any;
      options.onSessionCreated?.(session);
      await new Promise<void>(resolve => finishers.push(resolve));
      return { responseText: prompt, session, aborted: false, steered: false };
    });
    // 101 tombstones (one over the cap), evicted in spawn order but finished in reverse,
    // so the record evicted first is the newest and the last one evicted is the oldest.
    const ids = Array.from({ length: 101 }, (_, i) => manager!.spawn(pi, ctx, "general-purpose", `p${i}`, { description: `d${i}`, isBackground: true }));
    await vi.waitFor(() => expect(finishers).toHaveLength(101));
    for (const finish of [...finishers].reverse()) {
      clock.advance(1_000);
      finish();
      await Promise.resolve();
      await Promise.resolve();
    }
    await manager.waitForAll();
    clock.advance(PAST_RETENTION_MS);
    expect(ids.every(id => manager!.getRecord(id) === undefined)).toBe(true);
    // The cap dropped the earliest-completed (last-spawned) agent; the first-spawned survives.
    expect(manager.resolveMention(ids[100])).toBeUndefined();
    expect(manager.resolveMention(ids[99])).toMatchObject({ kind: "tombstone", entry: { id: ids[99] } });
    expect(manager.resolveMention(ids[0])).toMatchObject({ kind: "tombstone", entry: { id: ids[0] } });
  });
});
