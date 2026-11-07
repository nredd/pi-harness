// The 10-minute record GC (AgentManager.cleanup) has never run in a test: the
// main agent-manager suite uses real timers throughout, and nothing calls the
// private method. Its two guards are load-bearing in opposite directions —
// inverting the cutoff disposes results the LLM hasn't read yet, and dropping
// the running/queued skip disposes a LIVE agent's session mid-run.
//
// It lives in its own file because vi.useFakeTimers() has to be installed
// BEFORE `new AgentManager()` (the constructor starts the interval), and fake
// timers are hostile to the promise-settling style of the main suite.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager, describeEvicted, markConsumed } from "../src/agent-manager.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { resetBudgetForTests, setBudgetPolicy } from "../src/process-budget.js";
import { createWorktree } from "../src/worktree.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

const TEN_MINUTES = 10 * 60_000;
const TICK = 60_000;

describe("AgentManager — record GC", () => {
  let manager: AgentManager;

  beforeEach(() => {
    // Before construction: the cleanup interval is started in the constructor.
    vi.useFakeTimers();
  });

  afterEach(() => {
    resetBudgetForTests();
    manager?.dispose();
    vi.useRealTimers();
  });

  /** Spawn a background agent and settle it, returning its id and record. */
  async function settled(prompt: string) {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    } as any);
    manager ??= new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", prompt, { description: prompt, isBackground: true });
    await manager.getRecord(id)!.promise;
    // Read, so the 10-minute consumed window applies; the unread window has its own tests.
    manager.getRecord(id)!.resultConsumed = true;
    return { id, record: manager.getRecord(id)! };
  }

  it("keeps a record that completed inside the retention window", async () => {
    manager = new AgentManager();
    const { id, record } = await settled("recent");
    // Age at sweep time is (TEN_MINUTES - 2*TICK) + TICK — just inside the window.
    // Advancing the timers moves Date.now() too, so the margin has to outlast it.
    record.completedAt = Date.now() - (TEN_MINUTES - 2 * TICK);

    await vi.advanceTimersByTimeAsync(TICK);

    expect(manager.getRecord(id)).toBeDefined();
  });

  it("evicts a record that completed before the cutoff and disposes its session", async () => {
    manager = new AgentManager();
    const { id, record } = await settled("stale");
    const dispose = vi.fn();
    record.session = { dispose } as any;
    record.completedAt = Date.now() - (TEN_MINUTES + 30_000);

    await vi.advanceTimersByTimeAsync(TICK);

    expect(manager.getRecord(id)).toBeUndefined();
    expect(manager.listAgents().map(a => a.id)).not.toContain(id);
    expect(dispose).toHaveBeenCalled();
  });

  it("closes the evicted session's extension lifecycle before disposing it (#242)", async () => {
    // The reported crash, on its own path: this sweep is what fires ~10 min after a
    // subagent finishes. Disposing only invalidates the ExtensionRunner, so whatever
    // an extension armed in `session_start` stayed armed — and its next tick threw
    // `assertActive()` from a bare timer callback, killing interactive pi.
    manager = new AgentManager();
    const { id, record } = await settled("stale");
    const emit = vi.fn(async () => {});
    const dispose = vi.fn();
    record.session = {
      dispose,
      extensionRunner: { hasHandlers: (event: string) => event === "session_shutdown", emit },
    } as any;
    record.completedAt = Date.now() - (TEN_MINUTES + 30_000);

    await vi.advanceTimersByTimeAsync(TICK);

    expect(manager.getRecord(id)).toBeUndefined();
    expect(emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
    // After dispose() the runner is invalidated and every ctx getter throws, so an
    // emit that landed afterwards would be worse than none.
    expect(emit.mock.invocationCallOrder[0]).toBeLessThan(dispose.mock.invocationCallOrder[0]);
  });

  describe("reap notice (#330)", () => {
    const SIXTY = 60 * 60_000;

    it("reports an unread result evicted by the sweep, with where it went", async () => {
      const reaped = vi.fn();
      manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, undefined, undefined, undefined, reaped);
      const { id, record } = await settled("lost");
      record.resultConsumed = false;
      record.outputFile = "/tmp/pi-subagents-1/x/tasks/lost.output";
      record.completedAt = Date.now() - (SIXTY + 30_000);

      await vi.advanceTimersByTimeAsync(TICK);

      expect(manager.getRecord(id)).toBeUndefined();
      expect(reaped).toHaveBeenCalledTimes(1);
      expect(reaped).toHaveBeenCalledWith(expect.objectContaining({ id, status: "completed", transcript: "/tmp/pi-subagents-1/x/tasks/lost.output" }));
    });

    it("stays quiet for a result that was read", async () => {
      const reaped = vi.fn();
      manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, undefined, undefined, undefined, reaped);
      const { id, record } = await settled("read");
      record.completedAt = Date.now() - (TEN_MINUTES + 30_000);

      await vi.advanceTimersByTimeAsync(TICK);

      expect(manager.getRecord(id)).toBeUndefined();
      expect(reaped).not.toHaveBeenCalled();
    });

    it("stays quiet for an unread nested child, which only its owner reads", async () => {
      const reaped = vi.fn();
      manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, undefined, undefined, undefined, reaped);
      const { id, record } = await settled("child");
      record.resultConsumed = false;
      record.parentAgentId = "owner";
      record.completedAt = Date.now() - (SIXTY + 30_000);

      await vi.advanceTimersByTimeAsync(TICK);

      expect(manager.getRecord(id)).toBeUndefined();
      expect(reaped).not.toHaveBeenCalled();
    });

    it("stays quiet for a queued agent stopped before it ever ran", async () => {
      const reaped = vi.fn();
      let release!: () => void;
      vi.mocked(runAgent).mockImplementationOnce(() => new Promise(resolve => {
        release = () => resolve({ responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false } as any);
      }));
      manager = new AgentManager(undefined, 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, reaped);
      const first = manager.spawn(mockPi, mockCtx, "X", "first", { description: "first", isBackground: true });
      const queued = manager.spawn(mockPi, mockCtx, "X", "second", { description: "second", isBackground: true });
      expect(manager.getRecord(queued)!.status).toBe("queued");
      expect(manager.abort(queued, "parent")).toBe(true);
      release();
      await manager.getRecord(first)!.promise;
      markConsumed(manager.getRecord(first)!);

      await vi.advanceTimersByTimeAsync(SIXTY + TICK);

      expect(manager.getRecord(queued)).toBeUndefined();
      expect(reaped).not.toHaveBeenCalled();
    });

    it("stays quiet for a foreground spawn refused because its signal was already aborted", async () => {
      const reaped = vi.fn();
      let release!: () => void;
      vi.mocked(runAgent).mockImplementationOnce(() => new Promise(resolve => {
        release = () => resolve({ responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false } as any);
      }));
      manager = new AgentManager(undefined, 4, undefined, undefined, undefined, undefined, undefined, undefined, undefined, reaped);
      manager.setMaxConcurrentForeground(1);
      const holder = manager.spawnAndWait(mockPi, mockCtx, "X", "holder", { description: "holder" });
      const refused = await manager.spawnAndWait(mockPi, mockCtx, "X", "refused", {
        description: "refused",
        signal: AbortSignal.abort(),
      });
      expect(refused.record.status).toBe("stopped");
      release();
      const held = await holder;
      markConsumed(held.record);

      await vi.advanceTimersByTimeAsync(SIXTY + TICK);

      expect(manager.getRecord(refused.id)).toBeUndefined();
      expect(reaped).not.toHaveBeenCalled();
    });

    it("stays quiet for a spawn stopped while its worktree copy was being made", async () => {
      const reaped = vi.fn();
      let copied!: (wt: any) => void;
      vi.mocked(createWorktree).mockReturnValueOnce(new Promise(r => { copied = r; }) as any);
      manager = new AgentManager(undefined, 4, undefined, undefined, undefined, undefined, undefined, undefined, undefined, reaped);
      const id = manager.spawn(mockPi, mockCtx, "X", "copying", { description: "copying", isBackground: true, isolation: "worktree" });
      await vi.advanceTimersByTimeAsync(0);
      expect(manager.abort(id)).toBe(true);
      copied({ path: "/tmp/wt", workPath: "/tmp/wt", repoRoot: "/tmp", branch: "b" });
      await vi.advanceTimersByTimeAsync(0);
      expect(runAgent).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(SIXTY + TICK);

      expect(manager.getRecord(id)).toBeUndefined();
      expect(reaped).not.toHaveBeenCalled();
    });

    it("stays quiet for a queued resume stopped before it ran again", async () => {
      const reaped = vi.fn();
      const done = () => ({ responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false } as any);
      let release!: () => void;
      vi.mocked(runAgent)
        .mockResolvedValueOnce(done())
        .mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(done()); }));
      manager = new AgentManager(undefined, 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, reaped);
      const first = manager.spawn(mockPi, mockCtx, "X", "first", { description: "first", isBackground: true });
      await manager.getRecord(first)!.promise;
      markConsumed(manager.getRecord(first)!);
      // Holds the only slot, so the resume queues.
      const holder = manager.spawn(mockPi, mockCtx, "X", "holder", { description: "holder", isBackground: true });
      await manager.resume(first, "again", undefined, { isBackground: true });
      expect(manager.getRecord(first)!.status).toBe("queued");
      // The previous run's session is still on the record; it must not count as a run.
      expect(manager.getRecord(first)!.session).toBeDefined();
      expect(manager.abort(first, "parent")).toBe(true);
      release();
      await manager.getRecord(holder)!.promise;
      markConsumed(manager.getRecord(holder)!);

      await vi.advanceTimersByTimeAsync(SIXTY + TICK);

      expect(manager.getRecord(first)).toBeUndefined();
      expect(reaped).not.toHaveBeenCalled();
    });

    it("still reports a background resume stopped mid-run after a queued resume was stopped", async () => {
      const reaped = vi.fn();
      const done = () => ({ responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false } as any);
      let release!: () => void;
      vi.mocked(runAgent)
        .mockResolvedValueOnce(done())
        .mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(done()); }));
      vi.mocked(resumeAgent).mockImplementationOnce(() => new Promise(resolve => {
        release = () => resolve({ text: "", aborted: true, steered: false } as any);
      }));
      manager = new AgentManager(undefined, 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, reaped);
      const first = manager.spawn(mockPi, mockCtx, "X", "first", { description: "first", isBackground: true });
      await manager.getRecord(first)!.promise;
      const holder = manager.spawn(mockPi, mockCtx, "X", "holder", { description: "holder", isBackground: true });
      await manager.resume(first, "again", undefined, { isBackground: true });
      expect(manager.abort(first, "parent")).toBe(true);
      release();
      await manager.getRecord(holder)!.promise;
      markConsumed(manager.getRecord(holder)!);

      // The slot is free again: this resume runs at once and is stopped mid-run.
      await manager.resume(first, "once more", undefined, { isBackground: true });
      expect(manager.getRecord(first)!.status).toBe("running");
      expect(manager.abort(first, "parent")).toBe(true);
      release();
      await manager.getRecord(first)!.promise;
      manager.getRecord(first)!.resultConsumed = false;

      await vi.advanceTimersByTimeAsync(SIXTY + TICK);

      expect(manager.getRecord(first)).toBeUndefined();
      expect(reaped).toHaveBeenCalledWith(expect.objectContaining({ id: first, status: "stopped" }));
    });

    it("still reports an unread agent that was stopped mid-run", async () => {
      const reaped = vi.fn();
      manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, undefined, undefined, undefined, reaped);
      const { id, record } = await settled("stopped");
      record.resultConsumed = false;
      record.status = "stopped";
      record.completedAt = Date.now() - (SIXTY + 30_000);

      await vi.advanceTimersByTimeAsync(TICK);

      expect(manager.getRecord(id)).toBeUndefined();
      expect(reaped).toHaveBeenCalledWith(expect.objectContaining({ id, status: "stopped" }));
    });

    describe("every terminal path: reap only where a run produced an unseen result", () => {
      const SIXTY_MIN = 60 * 60_000;
      const done = () => ({ responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false } as any);
      const aborted = () => ({ responseText: "", session: { dispose: vi.fn() } as any, aborted: true, steered: false } as any);
      // resumeAgent's outcome shape: `text`, not `responseText`.
      const resumed = (isAborted = false) => ({ text: isAborted ? "" : "again", aborted: isAborted, steered: false } as any);
      const spawnOpts = (extra: object = {}) => ({ description: "d", isBackground: true, ...extra });

      let reaped: ReturnType<typeof vi.fn>;
      let failStart = false;

      beforeEach(() => {
        vi.mocked(runAgent).mockReset();
        vi.mocked(resumeAgent).mockReset();
        vi.mocked(createWorktree).mockReset();
        reaped = vi.fn();
        failStart = false;
        manager = new AgentManager(
          undefined, 1,
          () => { if (failStart) throw new Error("onStart boom"); },
          undefined, undefined, undefined, undefined, undefined, undefined, reaped,
        );
      });

      /** A pending run that holds the only slot; `finish` settles it and marks it read. */
      async function hold() {
        let release!: () => void;
        vi.mocked(runAgent).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(done()); }));
        const id = manager.spawn(mockPi, mockCtx, "X", "holder", spawnOpts());
        return {
          id,
          finish: async () => {
            release();
            await manager.getRecord(id)!.promise;
            markConsumed(manager.getRecord(id)!);
          },
        };
      }

      /** A settled agent whose first result is left UNREAD, so only the new run's flag can silence it. */
      async function finished() {
        vi.mocked(runAgent).mockResolvedValueOnce(done());
        const id = manager.spawn(mockPi, mockCtx, "X", "first", spawnOpts());
        await manager.getRecord(id)!.promise;
        return id;
      }

      const cases: Array<{ name: string; reap: boolean; run: () => Promise<string> }> = [
        {
          name: "spawn: immediate background run completes unseen",
          reap: true,
          run: async () => {
            vi.mocked(runAgent).mockResolvedValueOnce(done());
            const id = manager.spawn(mockPi, mockCtx, "X", "p", spawnOpts());
            await manager.getRecord(id)!.promise;
            return id;
          },
        },
        {
          name: "spawn: immediate foreground run returns inline",
          reap: false,
          run: async () => {
            vi.mocked(runAgent).mockResolvedValueOnce(done());
            return (await manager.spawnAndWait(mockPi, mockCtx, "X", "p", { description: "d" })).id;
          },
        },
        {
          name: "spawn: queued background run starts later and completes unseen",
          reap: true,
          run: async () => {
            const holder = await hold();
            vi.mocked(runAgent).mockResolvedValueOnce(done());
            const id = manager.spawn(mockPi, mockCtx, "X", "p", spawnOpts());
            await holder.finish();
            await vi.advanceTimersByTimeAsync(0);
            await manager.getRecord(id)!.promise;
            return id;
          },
        },
        {
          name: "spawn: queued background stopped before it started",
          reap: false,
          run: async () => {
            const holder = await hold();
            const id = manager.spawn(mockPi, mockCtx, "X", "p", spawnOpts());
            expect(manager.abort(id, "parent")).toBe(true);
            await holder.finish();
            return id;
          },
        },
        {
          name: "spawn: background spawn with an already-aborted signal",
          reap: false,
          run: async () => {
            vi.mocked(runAgent).mockResolvedValue(done());
            const id = manager.spawn(mockPi, mockCtx, "X", "p", spawnOpts({ signal: AbortSignal.abort() }));
            await vi.advanceTimersByTimeAsync(0);
            return id;
          },
        },
        {
          name: "spawn: stopped while the worktree copy was made",
          reap: false,
          run: async () => {
            let copied!: (wt: any) => void;
            vi.mocked(createWorktree).mockReturnValueOnce(new Promise(r => { copied = r; }) as any);
            const id = manager.spawn(mockPi, mockCtx, "X", "p", spawnOpts({ isolation: "worktree" }));
            await vi.advanceTimersByTimeAsync(0);
            manager.abort(id);
            copied({ path: "/tmp/wt", workPath: "/tmp/wt", repoRoot: "/tmp", branch: "b" });
            await vi.advanceTimersByTimeAsync(0);
            return id;
          },
        },
        {
          name: "spawn: queued startup failure (worktree creation rejects)",
          reap: false,
          run: async () => {
            const holder = await hold();
            vi.mocked(createWorktree).mockRejectedValueOnce(new Error("no repo"));
            const id = manager.spawn(mockPi, mockCtx, "X", "p", spawnOpts({ isolation: "worktree" }));
            await holder.finish();
            await vi.advanceTimersByTimeAsync(0);
            expect(manager.getRecord(id)!.status).toBe("error");
            return id;
          },
        },
        {
          name: "spawn: queued start whose onStart throws",
          reap: false,
          run: async () => {
            const holder = await hold();
            const id = manager.spawn(mockPi, mockCtx, "X", "p", spawnOpts());
            failStart = true;
            await holder.finish();
            await vi.advanceTimersByTimeAsync(0);
            expect(manager.getRecord(id)!.status).toBe("error");
            return id;
          },
        },
        {
          name: "spawn: background run stopped mid-run",
          reap: true,
          run: async () => {
            let release!: () => void;
            vi.mocked(runAgent).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(aborted()); }));
            const id = manager.spawn(mockPi, mockCtx, "X", "p", spawnOpts());
            expect(manager.abort(id, "parent")).toBe(true);
            release();
            await manager.getRecord(id)!.promise;
            return id;
          },
        },
        {
          name: "resume: immediate foreground resume returns inline",
          reap: false,
          run: async () => {
            const id = await finished();
            vi.mocked(resumeAgent).mockResolvedValueOnce(resumed());
            await manager.resume(id, "again");
            return id;
          },
        },
        {
          name: "resume: foreground resume stopped mid-run returns inline",
          reap: false,
          run: async () => {
            const id = await finished();
            let release!: () => void;
            vi.mocked(resumeAgent).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(resumed(true)); }));
            const resuming = manager.resume(id, "again");
            expect(manager.abort(id, "parent")).toBe(true);
            release();
            await resuming;
            return id;
          },
        },
        {
          name: "resume: foreground resume queued, then granted and run inline",
          reap: false,
          run: async () => {
            const id = await finished();
            setBudgetPolicy({ maxActive: 1, nestedReserve: 0, maxDepth: 1 });
            const holder = await hold();
            vi.mocked(resumeAgent).mockResolvedValueOnce(resumed());
            const resuming = manager.resume(id, "again");
            expect(manager.getRecord(id)!.status).toBe("queued");
            await holder.finish();
            await resuming;
            return id;
          },
        },
        {
          name: "resume: foreground resume stopped while queued",
          reap: false,
          run: async () => {
            const id = await finished();
            setBudgetPolicy({ maxActive: 1, nestedReserve: 0, maxDepth: 1 });
            const holder = await hold();
            const resuming = manager.resume(id, "again");
            expect(manager.abort(id, "parent")).toBe(true);
            await resuming;
            await holder.finish();
            return id;
          },
        },
        {
          name: "resume: foreground resume with an already-aborted signal and a free lease",
          reap: false,
          run: async () => {
            const id = await finished();
            vi.mocked(resumeAgent).mockResolvedValueOnce(resumed(true));
            await manager.resume(id, "again", AbortSignal.abort());
            return id;
          },
        },
        {
          name: "resume: immediate background resume completes unseen",
          reap: true,
          run: async () => {
            const id = await finished();
            vi.mocked(resumeAgent).mockResolvedValueOnce(resumed());
            await manager.resume(id, "again", undefined, { isBackground: true });
            await manager.getRecord(id)!.promise;
            return id;
          },
        },
        {
          name: "resume: queued background resume starts later and completes unseen",
          reap: true,
          run: async () => {
            const id = await finished();
            const holder = await hold();
            vi.mocked(resumeAgent).mockResolvedValueOnce(resumed());
            await manager.resume(id, "again", undefined, { isBackground: true });
            expect(manager.getRecord(id)!.status).toBe("queued");
            await holder.finish();
            await vi.advanceTimersByTimeAsync(0);
            await manager.getRecord(id)!.promise;
            return id;
          },
        },
        {
          name: "resume: queued background resume stopped before it ran",
          reap: false,
          run: async () => {
            const id = await finished();
            const holder = await hold();
            await manager.resume(id, "again", undefined, { isBackground: true });
            expect(manager.abort(id, "parent")).toBe(true);
            await holder.finish();
            return id;
          },
        },
        {
          name: "resume: immediate background resume whose onStart throws",
          reap: false,
          run: async () => {
            const id = await finished();
            failStart = true;
            await expect(manager.resume(id, "again", undefined, { isBackground: true })).rejects.toThrow("onStart boom");
            expect(manager.getRecord(id)!.status).toBe("error");
            return id;
          },
        },
        {
          name: "resume: background resume stopped mid-run",
          reap: true,
          run: async () => {
            const id = await finished();
            let release!: () => void;
            vi.mocked(resumeAgent).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(resumed(true)); }));
            await manager.resume(id, "again", undefined, { isBackground: true });
            expect(manager.abort(id, "parent")).toBe(true);
            release();
            await manager.getRecord(id)!.promise;
            return id;
          },
        },
      ];

      it.each(cases)("$name", async ({ reap, run }) => {
        const id = await run();

        await vi.advanceTimersByTimeAsync(SIXTY_MIN + 2 * TICK);

        expect(manager.getRecord(id)).toBeUndefined();
        if (reap) expect(reaped).toHaveBeenCalledWith(expect.objectContaining({ id }));
        else expect(reaped).not.toHaveBeenCalled();
      });
    });

    it("does not report records that a session boundary clears", async () => {
      const reaped = vi.fn();
      manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, undefined, undefined, undefined, reaped);
      const { record } = await settled("boundary");
      record.resultConsumed = false;

      manager.clearCompleted();

      expect(reaped).not.toHaveBeenCalled();
    });
  });

  it("never evicts a running agent, however old its timestamp looks", async () => {
    // A live agent's session being disposed mid-run is the worst failure this
    // guard prevents, and `completedAt` on a running record is meaningless.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", "live", { description: "live", isBackground: true });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");
    record.completedAt = Date.now() - 10 * TEN_MINUTES;
    const dispose = vi.fn();
    record.session = { dispose } as any;

    await vi.advanceTimersByTimeAsync(TICK * 5);

    expect(manager.getRecord(id)).toBeDefined();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("never evicts a queued agent", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager = new AgentManager(undefined, 1);
    manager.spawn(mockPi, mockCtx, "X", "holder", { description: "holder", isBackground: true });
    const queuedId = manager.spawn(mockPi, mockCtx, "X", "waiter", { description: "waiter", isBackground: true });
    const queued = manager.getRecord(queuedId)!;
    expect(queued.status).toBe("queued");
    queued.completedAt = Date.now() - 10 * TEN_MINUTES;

    await vi.advanceTimersByTimeAsync(TICK * 5);

    expect(manager.getRecord(queuedId)?.status).toBe("queued");
  });

  it("sweeps repeatedly, not just once", async () => {
    // The interval must keep firing: a record that ages past the cutoff on a
    // later tick has to be collected too.
    manager = new AgentManager();
    const { id, record } = await settled("ages-out");
    record.completedAt = Date.now() - (TEN_MINUTES - 3 * TICK);

    await vi.advanceTimersByTimeAsync(TICK);
    expect(manager.getRecord(id)).toBeDefined(); // still inside the window

    await vi.advanceTimersByTimeAsync(TICK * 4);
    expect(manager.getRecord(id)).toBeUndefined(); // aged out on a later tick
  });
});

const SIXTY_MINUTES = 60 * 60_000;

describe("AgentManager — retention windows", () => {
  let manager: AgentManager;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    manager?.dispose();
    vi.useRealTimers();
  });

  async function finished(opts: { sessionFile?: string; outputFile?: string } = {}) {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    } as any);
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", "work", { description: "the work", isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;
    record.sessionFile = opts.sessionFile;
    record.outputFile = opts.outputFile;
    return { id, record };
  }

  it("keeps an unread result past the consumed window", async () => {
    const { id, record } = await finished();
    record.completedAt = Date.now() - (TEN_MINUTES + 5 * TICK);

    await vi.advanceTimersByTimeAsync(TICK);

    expect(manager.getRecord(id)).toBeDefined();
  });

  it("evicts an unread result once 60 minutes have passed", async () => {
    const { id, record } = await finished();
    record.completedAt = Date.now() - (SIXTY_MINUTES + 30_000);

    await vi.advanceTimersByTimeAsync(TICK);

    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("counts the consumed window from the moment the result was read, not from completion", async () => {
    const { id, record } = await finished();
    record.completedAt = Date.now() - 30 * 60_000;
    markConsumed(record);

    await vi.advanceTimersByTimeAsync(TICK);
    expect(manager.getRecord(id)).toBeDefined();

    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("leaves a note saying what happened, with the transcript path", async () => {
    const { id, record } = await finished({ outputFile: "/tmp/t/agent.output", sessionFile: "/s/agent.jsonl" });
    markConsumed(record);
    record.consumedAt = Date.now() - (TEN_MINUTES + 30_000);
    record.completedAt = Date.now() - (TEN_MINUTES + 30_000);

    await vi.advanceTimersByTimeAsync(TICK);

    const note = manager.getEvictedNote(id);
    expect(note).toMatchObject({ id, status: "completed", evictedAfterMin: 12, transcript: "/tmp/t/agent.output" });
    expect(describeEvicted(note!)).toBe(
      `Agent "${id}" (the work) completed, evicted after 12 min; transcript: /tmp/t/agent.output`,
    );
  });

  it("falls back to the session file, and says nothing about a transcript when there is none", async () => {
    const { id, record } = await finished({ sessionFile: "/s/agent.jsonl" });
    markConsumed(record);
    record.consumedAt = record.completedAt = Date.now() - (TEN_MINUTES + 30_000);
    await vi.advanceTimersByTimeAsync(TICK);
    expect(manager.getEvictedNote(id)?.transcript).toBe("/s/agent.jsonl");

    manager.dispose();
    const second = await finished();
    markConsumed(second.record);
    second.record.consumedAt = second.record.completedAt = Date.now() - (TEN_MINUTES + 30_000);
    await vi.advanceTimersByTimeAsync(TICK);
    expect(describeEvicted(manager.getEvictedNote(second.id)!)).not.toContain("transcript");
  });

  it.each([
    ["nested", { parentAgentId: "parent-1" }],
    ["workflow", { workflowId: "run-1" }],
  ] as const)("leaves no note for an evicted %s child, which top-level tools must not reach", async (_kind, owner) => {
    const { id, record } = await finished({ outputFile: "/tmp/t/child.output" });
    Object.assign(record, owner);
    markConsumed(record);
    record.consumedAt = record.completedAt = Date.now() - (TEN_MINUTES + 30_000);

    await vi.advanceTimersByTimeAsync(TICK);

    expect(manager.getRecord(id)).toBeUndefined();
    expect(manager.getEvictedNote(id)).toBeUndefined();
  });

  it("forgets evicted notes at a session boundary", async () => {
    const { id, record } = await finished();
    markConsumed(record);
    record.consumedAt = record.completedAt = Date.now() - (TEN_MINUTES + 30_000);
    await vi.advanceTimersByTimeAsync(TICK);
    expect(manager.getEvictedNote(id)).toBeDefined();

    manager.clearCompleted(true);

    expect(manager.getEvictedNote(id)).toBeUndefined();
  });
});

// Eviction is exactly the moment a handle would otherwise stop working. These
// cover what outlives it: enough to find the agent's session on disk and
// reopen the conversation, and the name held so nothing else claims it.
describe("AgentManager — tombstones outliving the GC", () => {
  let manager: AgentManager;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    manager?.dispose();
    vi.useRealTimers();
  });

  /** Spawn, settle, and age past the cutoff so the next tick evicts it. */
  async function evictable(type: string, prompt: string, sessionFile?: string) {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    } as any);
    manager ??= new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, type, prompt, { description: prompt, isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;
    record.resultConsumed = true;
    record.sessionFile = sessionFile;
    record.completedAt = Date.now() - (TEN_MINUTES + 30_000);
    return { id, record };
  }

  it("keeps an evicted agent reachable by name when its session is on disk", async () => {
    manager = new AgentManager();
    await evictable("Explore", "audit the RPC path", "/sessions/explore.jsonl");

    await vi.advanceTimersByTimeAsync(TICK);

    const resolved = manager.resolveMention("explore");
    expect(resolved?.kind).toBe("tombstone");
    expect(resolved).toMatchObject({
      entry: { handle: "explore", type: "Explore", description: "audit the RPC path", sessionFile: "/sessions/explore.jsonl" },
    });
  });

  it("leaves nothing behind when the session was only ever in memory", async () => {
    // Without a file there is no conversation to reopen, so promising a resume
    // would be a lie — the mention has to fall through to starting a new agent.
    manager = new AgentManager();
    await evictable("Explore", "ephemeral", undefined);

    await vi.advanceTimersByTimeAsync(TICK);

    expect(manager.resolveMention("explore")).toBeUndefined();
    expect(manager.listTombstones()).toHaveLength(0);
  });

  it("holds the evicted handle so a later agent of the same type can't shadow it", async () => {
    manager = new AgentManager();
    await evictable("Explore", "first", "/sessions/first.jsonl");
    await vi.advanceTimersByTimeAsync(TICK);

    const id = manager.spawn(mockPi, mockCtx, "Explore", "second", { description: "second", isBackground: true });

    expect(manager.getRecord(id)!.handle).toBe("explore-2");
    // ...and `@explore` still means the conversation you can resume.
    expect(manager.resolveMention("explore")?.kind).toBe("tombstone");
  });

  it("prefers a live agent over a tombstone holding the same name", async () => {
    manager = new AgentManager();
    await evictable("Explore", "old", "/sessions/old.jsonl");
    await vi.advanceTimersByTimeAsync(TICK);
    // Give the live agent the tombstone's name directly: the collision this
    // guards against is resolution order, not allocation.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const id = manager.spawn(mockPi, mockCtx, "Explore", "live", { description: "live", isBackground: true });
    manager.getRecord(id)!.handle = "explore";

    const resolved = manager.resolveMention("explore");
    expect(resolved?.kind).toBe("live");
    expect(resolved).toMatchObject({ record: { id } });
  });

  it("drops the oldest once the cap is reached, keeping the most recent", async () => {
    manager = new AgentManager();
    for (let i = 0; i < 101; i++) {
      const { record } = await evictable("Explore", `run-${i}`, `/sessions/${i}.jsonl`);
      // Distinct ages so "oldest" is well defined; run-0 is the oldest. Set on
      // the record we just made — under fake timers every startedAt is equal,
      // so listAgents() has no meaningful order to index into.
      record.completedAt = Date.now() - (TEN_MINUTES + 101_000 - i * 1000);
    }
    await vi.advanceTimersByTimeAsync(TICK);

    expect(manager.listTombstones()).toHaveLength(100);
    expect(manager.resolveMention("explore")).toBeUndefined(); // run-0's handle
    expect(manager.resolveMention("explore-101")?.kind).toBe("tombstone");
  });

  it("hands a reclaimed name straight back, numbering nothing", async () => {
    // The resume path's whole contract: `handleBase(type)` cannot reproduce a
    // numbered handle, so the spawn takes the tombstone's names verbatim.
    manager = new AgentManager();
    await evictable("Explore", "first", "/sessions/first.jsonl");
    manager.spawn(mockPi, mockCtx, "Explore", "second", { description: "second", isBackground: true });
    await vi.advanceTimersByTimeAsync(TICK);

    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const id = manager.spawn(mockPi, mockCtx, "Explore", "resumed", {
      description: "first",
      isBackground: true,
      reclaim: { handle: "explore", alias: "auth-audit" },
    } as any);

    expect(manager.getRecord(id)).toMatchObject({ handle: "explore", alias: "auth-audit" });
  });

  it("ignores a reclaim on a nested child, which has no name to hold", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const id = manager.spawn(mockPi, mockCtx, "Explore", "child", {
      description: "child",
      parentAgentId: "parent-id",
      reclaim: { handle: "explore", alias: "auth-audit" },
    } as any);

    expect(manager.getRecord(id)).toMatchObject({ handle: undefined, alias: undefined });
  });

  it("stops answering a name once its tombstone is dropped", async () => {
    manager = new AgentManager();
    await evictable("Explore", "done", "/sessions/done.jsonl");
    await vi.advanceTimersByTimeAsync(TICK);
    expect(manager.resolveMention("explore")?.kind).toBe("tombstone");

    manager.dropTombstone("explore");

    expect(manager.resolveMention("explore")).toBeUndefined();
    expect(manager.listTombstones()).toHaveLength(0);
  });

  it("frees a dropped name for the next agent of that type", async () => {
    // Otherwise a resumed agent's own handle stays reserved by the corpse and
    // every later spawn climbs: explore-2, explore-3, …
    manager = new AgentManager();
    await evictable("Explore", "done", "/sessions/done.jsonl");
    await vi.advanceTimersByTimeAsync(TICK);
    manager.dropTombstone("explore");

    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const id = manager.spawn(mockPi, mockCtx, "Explore", "next", { description: "next", isBackground: true });

    expect(manager.getRecord(id)!.handle).toBe("explore");
  });

  it("forgets every name when the session ends", async () => {
    // A handle from a conversation the user has left must not resolve, or
    // `@explore` reaches an agent they have no memory of starting.
    manager = new AgentManager();
    await evictable("Explore", "prior session", "/sessions/prior.jsonl");
    await vi.advanceTimersByTimeAsync(TICK);
    expect(manager.listTombstones()).toHaveLength(1);

    manager.clearCompleted(true);

    expect(manager.listTombstones()).toHaveLength(0);
    expect(manager.resolveMention("explore")).toBeUndefined();
  });
});

// The windows are an hour and ten minutes, so an end-to-end test cannot watch
// eviction without an override. Read at construction, so each case sets the
// env before `new AgentManager()`.
describe("AgentManager — retention override (PI_SUBAGENTS_*_TTL_MIN)", () => {
  let manager: AgentManager | undefined;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    manager?.dispose();
    manager = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function finishedAndRead() {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    } as any);
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", "work", { description: "the work", isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;
    markConsumed(record);
    return id;
  }

  it("evicts a read result within a second at a consumed TTL of 0, leaving the note", async () => {
    vi.stubEnv("PI_SUBAGENTS_CONSUMED_TTL_MIN", "0");
    const id = await finishedAndRead();

    // The sweep tightens to the floor of one second rather than staying at a minute.
    await vi.advanceTimersByTimeAsync(1_000);

    expect(manager!.getRecord(id)).toBeUndefined();
    expect(describeEvicted(manager!.getEvictedNote(id)!)).toContain("completed, evicted after 0 min");
  });

  it("takes fractional minutes for the unread window", async () => {
    vi.stubEnv("PI_SUBAGENTS_UNREAD_TTL_MIN", "0.05"); // 3 s
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false,
    } as any);
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", "work", { description: "unread", isBackground: true });
    await manager.getRecord(id)!.promise;

    await vi.advanceTimersByTimeAsync(2_000);
    expect(manager.getRecord(id)).toBeDefined();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("warns and keeps the default for a value that is not minutes >= 0", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("PI_SUBAGENTS_CONSUMED_TTL_MIN", "-1");
    const id = await finishedAndRead();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(manager!.getRecord(id)).toBeDefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignoring PI_SUBAGENTS_CONSUMED_TTL_MIN="-1"'));
  });

  it("follows reopen links to the newest id and bounds them like the eviction notes (#330)", () => {
    manager = new AgentManager();
    expect(manager.latestId("a")).toBe("a");
    manager.linkSuccessor("a", "b");
    manager.linkSuccessor("b", "c");
    expect(manager.latestId("a")).toBe("c");
    manager.unlinkSuccessor("b");
    expect(manager.latestId("a")).toBe("b");

    // 500 more links push the oldest, "a", out; the newest still resolves.
    for (let i = 0; i < 500; i++) manager.linkSuccessor(`old-${i}`, `new-${i}`);
    expect(manager.latestId("a")).toBe("a");
    expect(manager.latestId("old-0")).toBe("new-0");
    expect(manager.latestId("old-499")).toBe("new-499");

    manager.clearCompleted();
    expect(manager.latestId("old-499")).toBe("old-499");
  });
});
