/**
 * process-budget.test.ts -- the process-wide `maxActiveSubagents` ceiling.
 *
 * Exercised through real `AgentManager`s with a scripted runner, because the
 * point of the budget is the paths the per-manager pools never saw: a second
 * manager, a reloaded module instance, nested children, workflow children,
 * scheduled (`bypassQueue`) and detached RPC spawns, and both kinds of resume.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(async () => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(async () => {}),
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import {
  admissionLimit,
  BUDGET_QUEUE_FULL_ERROR,
  budgetUsage,
  MAX_PENDING_SUBAGENTS,
  resetBudgetForTests,
  setBudgetPolicy,
} from "../src/process-budget.js";
import type { AgentRecord } from "../src/types.js";
import { createWorktree } from "../src/worktree.js";

const pi = {} as any;
const ctx = { cwd: "/tmp" } as any;

interface Run {
  type: string;
  options: any;
  finish: (text?: string) => void;
}

/** Live runs by agent id; a run settles only when the test finishes it (or it is aborted). */
let runs: Map<string, Run>;
let managers: AgentManager[];

const mockSession = () => ({ dispose: vi.fn(), steer: vi.fn(async () => {}) }) as any;

/**
 * Script `runAgent` (of whichever module instance `fn` is): every run stays
 * live until finished, and resolves early on abort the way the real runner
 * does. `body` runs inside the agent, e.g. to spawn a nested child.
 */
function scriptRuns(fn: typeof runAgent, body?: (run: Run) => Promise<void> | void): void {
  vi.mocked(fn).mockImplementation(((_ctx: unknown, type: string, _prompt: string, options: any) => {
    const session = mockSession();
    options.onSessionCreated?.(session);
    return new Promise(resolve => {
      const settle = (text: string) => resolve({ responseText: text, session, aborted: false, steered: false });
      const run: Run = { type, options, finish: (text = "done") => settle(text) };
      runs.set(options.agentId, run);
      options.signal?.addEventListener("abort", () => settle(""), { once: true });
      if (body) void Promise.resolve(body(run)).then(() => run.finish());
    });
  }) as any);
}

function newManager(Ctor: typeof AgentManager = AgentManager): AgentManager {
  const manager = new Ctor(undefined, 10);
  managers.push(manager);
  return manager;
}

/** Let startups, grants and settle chains run. */
const flush = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve));
};

const bg = (manager: AgentManager, extra: Record<string, unknown> = {}) =>
  manager.spawn(pi, ctx, "general-purpose", "work", { description: "bg", isBackground: true, ...extra });

const finish = async (id: string) => {
  runs.get(id)!.finish();
  await flush();
};

beforeEach(() => {
  resetBudgetForTests();
  setBudgetPolicy({ maxActive: 12, nestedReserve: 2 });
  runs = new Map();
  managers = [];
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
  scriptRuns(runAgent);
});

afterEach(async () => {
  for (const manager of managers) await manager.dispose();
  resetBudgetForTests();
});

describe("admissionLimit", () => {
  it("holds back the reserve per nesting level below the run", () => {
    const policy = { maxActive: 12, nestedReserve: 2 };
    expect(admissionLimit(policy, 1, 2)).toBe(10);
    expect(admissionLimit(policy, 2, 2)).toBe(12);
    expect(admissionLimit(policy, 1, 3)).toBe(8);
    expect(admissionLimit(policy, 2, 3)).toBe(10);
    // Nesting disabled: top-level runs are leaves and get the whole cap.
    expect(admissionLimit(policy, 1, 1)).toBe(12);
    expect(admissionLimit(policy, 1, 0)).toBe(12);
  });

  it("is unlimited when off and never drops below one", () => {
    expect(admissionLimit({ maxActive: 0, nestedReserve: 2 }, 1, 2)).toBe(Number.POSITIVE_INFINITY);
    expect(admissionLimit({ maxActive: 2, nestedReserve: 5 }, 1, 2)).toBe(1);
  });
});

describe("process budget across managers", () => {
  it("caps top-level runs at ten and the process at twelve across two managers", async () => {
    const a = newManager();
    const b = newManager();
    const aIds = Array.from({ length: 6 }, () => bg(a));
    const bIds = Array.from({ length: 6 }, () => bg(b));
    await flush();

    const status = (m: AgentManager, ids: string[]) => ids.map(id => m.getRecord(id)!.status);
    expect(status(a, aIds)).toEqual(Array(6).fill("running"));
    expect(status(b, bIds)).toEqual([...Array(4).fill("running"), "queued", "queued"]);
    expect(budgetUsage()).toMatchObject({ active: 10, pending: 2 });

    // Depth-2 children get the two reserved slots; a third waits.
    const child = (m: AgentManager, parent: string) =>
      m.spawnAndWait(pi, ctx, "general-purpose", "review", {
        description: "review", depth: 2, parentAgentId: parent, maxSubagentDepth: 2,
      });
    const c1 = child(a, aIds[0]);
    const c2 = child(b, bIds[0]);
    const c3 = child(a, aIds[1]);
    await flush();
    expect(budgetUsage()).toMatchObject({ active: 12, pending: 3 });

    // A root finishing frees a root slot: the earliest waiter, a root, takes it.
    await finish(aIds[2]);
    expect(status(b, bIds).slice(4)).toEqual(["running", "queued"]);
    expect(budgetUsage()).toMatchObject({ active: 12, pending: 2 });

    // A child finishing frees a slot the queued root may not take (ten roots
    // hold slots), so the later child passes it: eligible-first FIFO.
    const children = () => [...runs.values()].filter(r => r.options.nestedRuntime.depth === 2);
    children()[0].finish();
    await c1;
    await flush();
    expect(budgetUsage()).toMatchObject({ active: 12, pending: 1 });
    expect(status(b, bIds)[5]).toBe("queued");

    for (const run of children()) run.finish();
    await Promise.all([c2, c3]);
    await flush();
    // Ten roots and no children: the last two slots stay a child's.
    expect(status(b, bIds)[5]).toBe("queued");
    expect(budgetUsage()).toMatchObject({ active: 10, pending: 1 });

    await finish(aIds[3]);
    expect(status(b, bIds)[5]).toBe("running");
  });

  it("waitForAll waits out a start queued behind another manager's leases", async () => {
    setBudgetPolicy({ maxActive: 1, nestedReserve: 0 });
    const a = newManager();
    const b = newManager();
    const blocker = bg(a);
    const waiting = bg(b);
    await flush();
    let done = false;
    const all = b.waitForAll().then(() => { done = true; });
    await flush();
    expect(done).toBe(false);

    await finish(blocker);
    expect(b.getRecord(waiting)!.status).toBe("running");
    expect(done).toBe(false);
    await finish(waiting);
    await all;
    expect(b.getRecord(waiting)!.status).toBe("completed");
  });

  it("starts the earliest eligible waiter in any manager", async () => {
    setBudgetPolicy({ maxActive: 2, nestedReserve: 0 });
    const a = newManager();
    const b = newManager();
    const [a1] = [bg(a), bg(a)];
    const bQueued = bg(b);
    const aQueued = bg(a);
    await flush();
    expect(b.getRecord(bQueued)!.status).toBe("queued");

    await finish(a1);
    expect(b.getRecord(bQueued)!.status).toBe("running");
    expect(a.getRecord(aQueued)!.status).toBe("queued");
  });

  it("is shared with a reloaded module instance and its manager", async () => {
    setBudgetPolicy({ maxActive: 2, nestedReserve: 0 });
    const old = newManager();
    const [o1] = [bg(old), bg(old)];
    await flush();

    // `/reload` loads a fresh copy of every module while `old` keeps running.
    vi.resetModules();
    const freshBudget = await import("../src/process-budget.js");
    const freshRunner = await import("../src/agent-runner.js");
    const { AgentManager: FreshManager } = await import("../src/agent-manager.js");
    expect(FreshManager).not.toBe(AgentManager);
    scriptRuns(freshRunner.runAgent);
    expect(freshBudget.budgetUsage()).toMatchObject({ active: 2, maxActive: 2 });

    const fresh = newManager(FreshManager);
    const f1 = bg(fresh);
    await flush();
    expect(fresh.getRecord(f1)!.status).toBe("queued");

    // The OLD manager's settle starts the NEW manager's waiter.
    await finish(o1);
    expect(fresh.getRecord(f1)!.status).toBe("running");
    expect(budgetUsage()).toMatchObject({ active: 2, pending: 0 });
  });
});

describe("process budget with nested reviewers", () => {
  it("completes ten parents that each wait on a depth-2 reviewer, two reviewers at a time", async () => {
    let reviewing = 0;
    let maxReviewingWithTenRoots = 0;
    let maxActive = 0;
    let maxRoots = 0;
    const roots = () => [...runs.values()].filter(r => r.options.nestedRuntime.depth === 1).length;
    scriptRuns(runAgent, async (run) => {
      maxActive = Math.max(maxActive, budgetUsage().active);
      const { nestedRuntime } = run.options;
      if (nestedRuntime.depth === 1) {
        maxRoots = Math.max(maxRoots, roots());
        // Let every parent start before any asks for a reviewer, so the ten
        // roots really are all holding slots while they wait.
        await flush(1);
        const { record } = await nestedRuntime.manager.spawnAndWait(pi, ctx, "general-purpose", "review", {
          description: "review",
          depth: 2,
          parentAgentId: nestedRuntime.parentAgentId,
          maxSubagentDepth: 2,
        });
        expect(record.status).toBe("completed");
        runs.delete(run.options.agentId);
        return;
      }
      reviewing++;
      if (roots() === 10) maxReviewingWithTenRoots = Math.max(maxReviewingWithTenRoots, reviewing);
      await flush(2);
      reviewing--;
      runs.delete(run.options.agentId);
    });

    const a = newManager();
    const b = newManager();
    // Twelve parents: ten start, two wait for a root slot behind them.
    const ids = Array.from({ length: 12 }, (_, i) => [i % 2 ? b : a, bg(i % 2 ? b : a)] as const);
    await vi.waitFor(() => {
      expect(ids.map(([m, id]) => m.getRecord(id)!.status)).toEqual(Array(12).fill("completed"));
    }, { timeout: 5_000 });

    expect(maxRoots).toBe(10);
    expect(maxReviewingWithTenRoots).toBe(2);
    expect(maxActive).toBeLessThanOrEqual(12);
    expect(budgetUsage()).toMatchObject({ active: 0, pending: 0 });
  });

  it("keeps the parent's lease while a sibling tool runs beside its queued child", async () => {
    setBudgetPolicy({ maxActive: 3, nestedReserve: 1 });
    const observed: number[] = [];
    let releaseChildren!: () => void;
    const childrenMayFinish = new Promise<void>(r => { releaseChildren = r; });
    scriptRuns(runAgent, async (run) => {
      const { nestedRuntime } = run.options;
      if (nestedRuntime.depth === 2) {
        await childrenMayFinish;
        return;
      }
      // One turn, two parallel tool calls: a nested Agent call and a sibling
      // tool that finishes while the child is still waiting for a slot.
      const child = nestedRuntime.manager.spawnAndWait(pi, ctx, "general-purpose", "review", {
        description: "review", depth: 2, parentAgentId: nestedRuntime.parentAgentId, maxSubagentDepth: 2,
      });
      const sibling = (async () => {
        await flush(3);
        observed.push(budgetUsage().active);
      })();
      await Promise.all([child, sibling]);
    });

    const m = newManager();
    const p1 = bg(m);
    const p2 = bg(m);
    await flush(8);
    // Both parents (roots limited to 2) plus the one child that fits; the
    // second child waits, and no parent gave its slot up for it.
    expect(budgetUsage()).toMatchObject({ active: 3, pending: 1 });
    expect(observed).toEqual([3, 3]);

    releaseChildren();
    await vi.waitFor(() => {
      expect([m.getRecord(p1)!.status, m.getRecord(p2)!.status]).toEqual(["completed", "completed"]);
    });
    expect(budgetUsage()).toMatchObject({ active: 0, pending: 0 });
  });
});

describe("process budget covers every start path", () => {
  it("queues foreground, workflow, scheduled and detached RPC spawns behind the cap", async () => {
    setBudgetPolicy({ maxActive: 1, nestedReserve: 0 });
    const m = newManager();
    const first = bg(m);
    await flush();

    const foreground = m.spawnAndWait(pi, ctx, "general-purpose", "fg", { description: "fg" });
    const workflow = m.spawnAndWait(pi, ctx, "general-purpose", "wf", { description: "wf", workflowId: "run-1" });
    const scheduled = bg(m, { bypassQueue: true });
    const rpc = m.spawn(pi, ctx, "general-purpose", "rpc", { description: "rpc" });
    await flush();
    expect(budgetUsage()).toMatchObject({ active: 1, pending: 4 });
    expect(m.getRecord(scheduled)!.status).toBe("queued");
    expect(m.getRecord(rpc)!.status).toBe("queued");

    // Each finish admits exactly the next one, in arrival order.
    const order: string[] = [];
    const runningIds = () => m.listAgents().filter(r => r.status === "running").map(r => r.description);
    await finish(first);
    for (let i = 0; i < 4; i++) {
      const live = runningIds();
      expect(live).toHaveLength(1);
      order.push(live[0]);
      await finish(m.listAgents().find(r => r.status === "running")!.id);
    }
    expect(order).toEqual(["fg", "wf", "bg", "rpc"]);
    expect((await foreground).record.status).toBe("completed");
    expect((await workflow).record.status).toBe("completed");
    expect(budgetUsage()).toMatchObject({ active: 0, pending: 0 });
  });

  it("fails a spawn fast once the pending queue is full, leaving no record", async () => {
    setBudgetPolicy({ maxActive: 1, nestedReserve: 0 });
    const m = newManager();
    bg(m);
    for (let i = 0; i < MAX_PENDING_SUBAGENTS; i++) bg(m);
    const before = m.listAgents().length;
    expect(() => bg(m)).toThrow(BUDGET_QUEUE_FULL_ERROR);
    expect(m.listAgents()).toHaveLength(before);
  });

  it("is off by default: counted, never enforced", async () => {
    resetBudgetForTests();
    const m = newManager();
    const ids = Array.from({ length: 20 }, (_, i) =>
      m.spawn(pi, ctx, "general-purpose", "x", { description: `n${i}`, depth: 2, parentAgentId: "p", maxSubagentDepth: 2 }));
    await flush();
    expect(ids.every(id => m.getRecord(id)!.status === "running")).toBe(true);
    expect(budgetUsage()).toMatchObject({ active: 20, pending: 0, maxActive: 0 });

    // Turning it on mid-run counts what is already running.
    setBudgetPolicy({ maxActive: 12 });
    const late = bg(m);
    expect(m.getRecord(late)!.status).toBe("queued");
  });

  it("raising the cap starts waiters at once", async () => {
    setBudgetPolicy({ maxActive: 1, nestedReserve: 0 });
    const m = newManager();
    bg(m);
    const queued = bg(m);
    await flush();
    expect(m.getRecord(queued)!.status).toBe("queued");
    setBudgetPolicy({ maxActive: 2 });
    await flush();
    expect(m.getRecord(queued)!.status).toBe("running");
  });
});

describe("process budget and resumes", () => {
  /** A finished agent with a session, ready to resume. */
  async function finishedAgent(m: AgentManager): Promise<AgentRecord> {
    const id = bg(m);
    await flush();
    await finish(id);
    const record = m.getRecord(id)!;
    expect(record.status).toBe("completed");
    return record;
  }

  let resumes: Array<() => void>;
  beforeEach(() => {
    resumes = [];
    vi.mocked(resumeAgent).mockImplementation((() =>
      new Promise(resolve => {
        resumes.push(() => resolve({ text: "resumed", aborted: false, steered: false }));
      })) as any);
  });

  it("queues a background resume at the cap and starts it on release", async () => {
    setBudgetPolicy({ maxActive: 1, nestedReserve: 0 });
    const m = newManager();
    const x = await finishedAgent(m);
    const blocker = bg(m);
    await flush();

    const resumed = await m.resume(x.id, "again", undefined, { isBackground: true });
    expect(resumed!.status).toBe("queued");
    expect(resumeAgent).not.toHaveBeenCalled();

    await finish(blocker);
    expect(x.status).toBe("running");
    expect(budgetUsage().active).toBe(1);
    resumes[0]();
    await flush();
    expect(x.status).toBe("completed");
    expect(budgetUsage()).toMatchObject({ active: 0, pending: 0 });
  });

  it("makes a foreground resume wait for a lease, and runs it once one frees", async () => {
    setBudgetPolicy({ maxActive: 1, nestedReserve: 0 });
    const m = newManager();
    const x = await finishedAgent(m);
    const blocker = bg(m);
    await flush();

    const pending = m.resume(x.id, "again");
    await flush();
    expect(x.status).toBe("queued");
    expect(resumeAgent).not.toHaveBeenCalled();

    await finish(blocker);
    expect(resumeAgent).toHaveBeenCalledTimes(1);
    resumes[0]();
    expect((await pending)!.status).toBe("completed");
    expect(budgetUsage()).toMatchObject({ active: 0, pending: 0 });
  });

  it("releases a foreground resume's wait on abort without running it", async () => {
    setBudgetPolicy({ maxActive: 1, nestedReserve: 0 });
    const m = newManager();
    const x = await finishedAgent(m);
    bg(m);
    await flush();

    const caller = new AbortController();
    const pending = m.resume(x.id, "again", caller.signal);
    await flush();
    expect(budgetUsage().pending).toBe(1);
    caller.abort();
    expect((await pending)!.status).toBe("stopped");
    expect(resumeAgent).not.toHaveBeenCalled();
    expect(budgetUsage()).toMatchObject({ active: 1, pending: 0 });
  });

  it("refuses a second resume of the same record in the same tick, on both paths", async () => {
    const m = newManager();
    const x = await finishedAgent(m);

    const first = m.resume(x.id, "one");
    const second = m.resume(x.id, "two");
    const third = m.resume(x.id, "three", undefined, { isBackground: true });
    expect(await second).toBeUndefined();
    expect(await third).toBeUndefined();
    expect(resumeAgent).toHaveBeenCalledTimes(1);
    expect(budgetUsage().active).toBe(1);
    resumes[0]();
    expect((await first)!.status).toBe("completed");
    expect(budgetUsage().active).toBe(0);
  });
});

describe("process budget lease release", () => {
  it("drops a queued spawn's waiter on abort and wakes its blocked caller", async () => {
    setBudgetPolicy({ maxActive: 1, nestedReserve: 0 });
    const m = newManager();
    bg(m);
    await flush();
    const caller = new AbortController();
    const waiting = m.spawnAndWait(pi, ctx, "general-purpose", "fg", { description: "fg", signal: caller.signal });
    await flush();
    expect(budgetUsage()).toMatchObject({ active: 1, pending: 1 });

    caller.abort();
    expect((await waiting).record.status).toBe("stopped");
    expect(budgetUsage()).toMatchObject({ active: 1, pending: 0 });
  });

  it("releases the lease of a queued start that fails at startup", async () => {
    setBudgetPolicy({ maxActive: 1, nestedReserve: 0 });
    const m = newManager();
    const blocker = bg(m);
    const dir = mkdtempSync(join(tmpdir(), "budget-cwd-"));
    const doomed = bg(m, { cwd: dir });
    const next = bg(m);
    await flush();
    rmSync(dir, { recursive: true, force: true });

    await finish(blocker);
    expect(m.getRecord(doomed)!.status).toBe("error");
    expect(m.getRecord(next)!.status).toBe("running");
    expect(budgetUsage()).toMatchObject({ active: 1, pending: 0 });
  });

  it("releases an immediate start's lease when worktree creation fails", async () => {
    vi.mocked(createWorktree).mockRejectedValueOnce(new Error("not a git repo"));
    const m = newManager();
    const id = bg(m, { isolation: "worktree" });
    await expect(m.awaitStartup(id)).rejects.toThrow(/not a git repo/);
    expect(budgetUsage().active).toBe(0);
  });

  it("holds a lease stopped mid-copy until the copy is cleaned up", async () => {
    setBudgetPolicy({ maxActive: 1, nestedReserve: 0 });
    let copied!: (wt: any) => void;
    vi.mocked(createWorktree).mockReturnValueOnce(new Promise(r => { copied = r; }) as any);
    const m = newManager();
    const id = bg(m, { isolation: "worktree" });
    const next = bg(m);
    await flush();
    m.abort(id);
    await flush();
    // Stopped, but the copy is still being made: the slot stays taken.
    expect(m.getRecord(id)!.status).toBe("stopped");
    expect(m.getRecord(next)!.status).toBe("queued");

    copied({ path: "/tmp/wt", workPath: "/tmp/wt", repoRoot: "/tmp", branch: "b" });
    await flush();
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(m.getRecord(next)!.status).toBe("running");
  });

  it("releases leases on dispose, and a late settle does not release twice", async () => {
    const a = newManager();
    const ids = [bg(a), bg(a)];
    await flush();
    expect(budgetUsage().active).toBe(2);
    const stranded = ids.map(id => runs.get(id)!);

    await a.dispose();
    expect(budgetUsage().active).toBe(0);

    const b = newManager();
    bg(b);
    await flush();
    for (const run of stranded) run.finish();
    await flush();
    expect(budgetUsage().active).toBe(1);
  });
});
