/** Manager callbacks, resumed-turn ownership and bounded eviction through public APIs. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager, markConsumed } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { streamToOutputFile } from "../src/output-file.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import * as worktrees from "../src/worktree.js";
import { FakeClock } from "./helpers/fake-clock.js";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));

const pi = {} as ExtensionAPI;
const ctx = { cwd: "/tmp" } as ExtensionContext;
const session = { dispose: vi.fn() } as unknown as AgentSession;
const managers: AgentManager[] = [];
const transcriptRoots: string[] = [];
beforeEach(() => {
  vi.mocked(runAgent).mockReset().mockResolvedValue({ responseText: "spawn", session, aborted: false, steered: false });
  vi.mocked(resumeAgent).mockReset();
});
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
  for (const root of transcriptRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Match the typed record callback installed by the extension, with a real final flush. */
function transcriptCleanup(id: string) {
  const root = mkdtempSync(join(tmpdir(), "lifecycle-cleanup-"));
  transcriptRoots.push(root);
  const path = join(root, "child.output");
  const unsubscribe = vi.fn();
  const child = { messages: [{ role: "assistant", content: [{ type: "text", text: "final answer" }] }], subscribe: () => unsubscribe } as unknown as AgentSession;
  const flush = streamToOutputFile(child, path, id, root, 0);
  const cleanup = vi.fn(() => { flush(); throw new Error("flush observer failed"); });
  return { cleanup, unsubscribe, path };
}

/** A caller-controlled runner boundary, no timer or scheduling assumptions. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function managerWithClock(onStart?: ConstructorParameters<typeof AgentManager>[2]) {
  const clock = new FakeClock();
  const onComplete = vi.fn();
  const onCompact = vi.fn();
  const onUsage = vi.fn();
  const manager = new AgentManager(onComplete, 1, onStart, onCompact, onUsage, undefined, clock);
  managers.push(manager);
  return { manager, clock, onComplete, onCompact, onUsage };
}

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
    expect(JSON.parse(readFileSync(transcript.path, "utf8"))).toMatchObject({ agentId: id, message: { content: [{ type: "text", text: "final answer" }] } });
    expect(transcript.unsubscribe).toHaveBeenCalledOnce();
    expect(transcript.cleanup).toHaveBeenCalledOnce();
    expect(record).toMatchObject({ status: "error", error: "runner failed", outputCleanup: undefined });
  });

  it("detaches a queued top-level start without later running it against the old session", async () => {
    const f = managerWithClock();
    const held = deferred<Awaited<ReturnType<typeof runAgent>>>();
    vi.mocked(runAgent).mockReturnValueOnce(held.promise);
    const running = f.manager.spawn(pi, ctx, "general-purpose", "running", { description: "running", isBackground: true });
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
    const child = { dispose: vi.fn(), steer: vi.fn().mockRejectedValue(new Error("steer failed")) } as unknown as AgentSession;
    const held = deferred<Awaited<ReturnType<typeof runAgent>>>();
    vi.mocked(runAgent).mockImplementationOnce((_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.(child);
      return held.promise;
    });
    const id = f.manager.spawn(pi, ctx, "general-purpose", "first", { description: "first", isBackground: true });
    expect(f.manager.steer(id, "late instruction")).toBe(true);
    await expect(vi.mocked(child.steer).mock.results[0].value).rejects.toThrow("steer failed");
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
    const record = f.manager.listAgents()[0];
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
    await f.manager.resume(id, "again", controller.signal, { isBackground: true, onToolActivity, onAssistantUsage, onCompaction });
    const opts = vi.mocked(resumeAgent).mock.calls[0][2];
    const activity = { type: "end" as const, name: "read", id: "tool" };
    const usage = { input: 3, output: 4, cacheWrite: 5, cost: .1 };
    const compact = { reason: "manual" as const, tokensBefore: 99 };
    opts?.onToolActivity?.(activity);
    opts?.onAssistantUsage?.(usage);
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
    expect(JSON.parse(readFileSync(transcript.path, "utf8"))).toMatchObject({ agentId: id, message: { content: [{ type: "text", text: "final answer" }] } });
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
    expect(vi.mocked(resumeAgent).mock.calls[0][2]?.signal?.aborted).toBe(true);
    held.resolve({ text: "late text", aborted: false, steered: false });
    await record.promise;
    expect(record).toMatchObject({ status: "stopped", result: "late text" });
  });

  it("does not strand the pool when a queued resume's startup observer throws", async () => {
    let failingId: string | undefined;
    const f = managerWithClock(record => { if (record.id === failingId) throw new Error("resume observer failed"); });
    const prior = await f.manager.spawnAndWait(pi, ctx, "general-purpose", "prior", { description: "prior" });
    const held = deferred<Awaited<ReturnType<typeof runAgent>>>();
    vi.mocked(runAgent).mockReturnValueOnce(held.promise);
    const blocker = f.manager.spawn(pi, ctx, "general-purpose", "blocker", { description: "blocker", isBackground: true });
    failingId = prior.id;
    f.onComplete.mockImplementation(record => { if (record.error) throw new Error("completion observer failed"); });
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
  it("reports retained model provenance before resume and resolves an explicit nested script file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lifecycle-host-"));
    const f = managerWithClock(record => { record.modelFallback = { input: "expired-pin", used: "p/model" }; });
    const host = createWorkflowHost({ pi, ctx, manager: f.manager, homeDir: dir });
    try {
      const source = 'export const meta = {name: "nested", description: "d"};';
      const path = join(dir, "nested.js");
      writeFileSync(path, source);
      expect(await host.loadWorkflow?.({ scriptPath: path })).toEqual({ ok: true, script: source, path });
      const initial = await host.spawnAgent({ agentId: "runtime-id", index: 0, prompt: "p", label: "child", agentType: "general-purpose" });
      expect(initial.text).toContain('configured model "expired-pin" did not resolve');
      vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed", aborted: false, steered: false });
      const onResolved = vi.fn();
      const resumed = await host.resumeAgent?.("runtime-id", "again", onResolved);
      expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ recordId: expect.any(String), modelNote: expect.stringContaining("expired-pin") }));
      expect(resumed).toMatchObject({ ok: true, text: expect.stringContaining("resumed"), modelNote: expect.stringContaining("expired-pin") });
      const id = f.manager.listAgents()[0].id;
      f.manager.clearCompleted();
      expect(await host.resumeAgent?.("runtime-id", "too late")).toEqual({ ok: false, error: `Agent ${id} has no session left to resume — records are dropped ten minutes after they finish.` });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("bounded eviction records", () => {
  it("retains only the newest 500 evicted ids, without dropping the newest result", async () => {
    const f = managerWithClock();
    const ids: string[] = [];
    let newest = "";
    for (let i = 0; i < 502; i++) {
      const { id, record } = await f.manager.spawnAndWait(pi, ctx, "general-purpose", `run-${i}`, { description: `run-${i}` });
      ids.push(id);
      newest = id;
      markConsumed(record, f.clock.now());
      expect(record).toMatchObject({ resultConsumed: true, consumedAt: f.clock.now() });
      f.clock.advance(600000);
    }
    expect(f.manager.getRecord(newest)).toBeUndefined();
    expect(f.manager.getEvictedNote(ids[0])).toBeUndefined();
    expect(f.manager.getEvictedNote(ids[1])).toBeUndefined();
    expect(f.manager.getEvictedNote(ids[2])).toMatchObject({ id: ids[2], description: "run-2", status: "completed" });
    expect(f.manager.getEvictedNote(newest)).toMatchObject({ id: newest, description: "run-501", status: "completed", evictedAfterMin: 10 });
  });
});
