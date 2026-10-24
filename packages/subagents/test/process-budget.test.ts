/**
 * process-budget.test.ts -- the process-wide `maxActiveSubagents` ceiling.
 *
 * Exercised through real `AgentManager`s with a scripted runner, because the
 * point of the budget is the paths the per-manager pools never saw: a second
 * manager, nested children, workflow children,
 * scheduled (`bypassQueue`) and detached RPC spawns, and both kinds of resume.
 * A separate static-import fixture checks shared state across module copies.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ModuleKind, transpileModule } from "typescript";
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
import { setMaxSubagentDepth } from "../src/nested-tools.js";
import {
  admissionLimit,
  BUDGET_QUEUE_FULL_ERROR,
  budgetUsage,
  enqueueBudget,
  getBudgetPolicy,
  getPendingBudgetPolicy,
  isCoherent,
  MAX_PENDING_SUBAGENTS,
  pumpBudget,
  releaseBudget,
  resetBudgetForTests,
  setBudgetPolicy,
  tryAcquireBudget,
} from "../src/process-budget.js";
import type { AgentRecord } from "../src/types.js";
import { cleanupWorktree, createWorktree } from "../src/worktree.js";

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

function newManager(): AgentManager {
  const manager = new AgentManager(undefined, 10);
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
  setBudgetPolicy({ maxActive: 12, nestedReserve: 2, maxDepth: 2 });
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

describe("admissionLimit and coherence", () => {
  it("holds back the reserve per nesting level below the run", () => {
    expect(admissionLimit({ maxActive: 12, nestedReserve: 2, maxDepth: 2 }, 1)).toBe(10);
    expect(admissionLimit({ maxActive: 12, nestedReserve: 2, maxDepth: 2 }, 2)).toBe(12);
    expect(admissionLimit({ maxActive: 12, nestedReserve: 2, maxDepth: 3 }, 1)).toBe(8);
    expect(admissionLimit({ maxActive: 12, nestedReserve: 2, maxDepth: 3 }, 2)).toBe(10);
    // Nesting disabled: top-level runs are leaves and get the whole cap.
    expect(admissionLimit({ maxActive: 12, nestedReserve: 2, maxDepth: 1 }, 1)).toBe(12);
    expect(admissionLimit({ maxActive: 12, nestedReserve: 2, maxDepth: 0 }, 1)).toBe(12);
    expect(admissionLimit({ maxActive: 0, nestedReserve: 2, maxDepth: 2 }, 1)).toBe(Number.POSITIVE_INFINITY);
  });

  it("accepts only policies whose limits rise strictly from at least one", () => {
    expect(isCoherent({ maxActive: 12, nestedReserve: 2, maxDepth: 2 })).toBe(true);
    expect(isCoherent({ maxActive: 0, nestedReserve: 0, maxDepth: 8 })).toBe(true);
    expect(isCoherent({ maxActive: 1, nestedReserve: 0, maxDepth: 1 })).toBe(true);
    expect(isCoherent({ maxActive: 15, nestedReserve: 2, maxDepth: 8 })).toBe(true);
    // A plain cap with nesting on: parents can fill it and wait forever.
    expect(isCoherent({ maxActive: 12, nestedReserve: 0, maxDepth: 2 })).toBe(false);
    // The old `Math.max(1, ...)` floor: limit(1) = limit(2) = 1 at depth 8.
    expect(isCoherent({ maxActive: 12, nestedReserve: 2, maxDepth: 8 })).toBe(false);
    expect(isCoherent({ maxActive: 2, nestedReserve: 2, maxDepth: 2 })).toBe(false);
  });

  it("refuses an incoherent policy with a warning, keeping the one in force", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setBudgetPolicy({ maxActive: 12, nestedReserve: 2, maxDepth: 8 });
    setBudgetPolicy({ maxActive: 12, nestedReserve: 0, maxDepth: 2 });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("it could deadlock"));
    expect(getBudgetPolicy()).toEqual({ maxActive: 12, nestedReserve: 2, maxDepth: 2 });
    warn.mockRestore();
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
    setBudgetPolicy({ maxActive: 1, nestedReserve: 0, maxDepth: 1 });
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
    setBudgetPolicy({ maxActive: 2, nestedReserve: 0, maxDepth: 1 });
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

  it("does not let a synchronous completion listener jump an eligible waiter", async () => {
    setBudgetPolicy({ maxActive: 1, nestedReserve: 0, maxDepth: 1 });
    let blocker: string | undefined;
    let newcomer: string | undefined;
    const m = new AgentManager(record => {
      if (record.id === blocker) newcomer = bg(m);
    }, 10);
    managers.push(m);
    blocker = bg(m);
    const waiting = bg(m);
    await flush();
    expect(m.getRecord(waiting)!.status).toBe("queued");

    await finish(blocker);
    expect(newcomer).toBeDefined();
    expect(m.getRecord(waiting)!.status).toBe("running");
    expect(m.getRecord(newcomer!)!.status).toBe("queued");
    await finish(waiting);
    expect(m.getRecord(newcomer!)!.status).toBe("running");
  });

  it("does not let a re-entrant grant callback jump the next eligible waiter", () => {
    setBudgetPolicy({ maxActive: 2, nestedReserve: 0, maxDepth: 1 });
    const blocker = tryAcquireBudget(1)!;
    const held = tryAcquireBudget(1)!;
    const order: string[] = [];
    let barged = false;
    enqueueBudget({ depth: 1, ready: () => true, grant: lease => {
      order.push("first");
      releaseBudget(lease);
      const newcomer = tryAcquireBudget(1);
      barged = newcomer !== undefined;
      releaseBudget(newcomer);
    } });
    enqueueBudget({ depth: 1, ready: () => true, grant: lease => {
      order.push("second");
      releaseBudget(lease);
    } });
    releaseBudget(blocker);
    pumpBudget();
    expect(order).toEqual(["first", "second"]);
    expect(barged).toBe(false);
    expect(budgetUsage()).toMatchObject({ active: 1, pending: 0 });
    releaseBudget(held);
  });

  it("settles an old manager to wake a genuine reloaded manager's waiter", () => {
    const dir = mkdtempSync(join(tmpdir(), "manager-reload-"));
    const sourceDir = fileURLToPath(new URL("../src/", import.meta.url));
    try {
      // Compile the actual trees into separate ESM identities. Only the LLM
      // runner is scripted, as in the in-process manager tests above.
      symlinkSync(fileURLToPath(new URL("../../../node_modules", import.meta.url)), join(dir, "node_modules"), "dir");
      for (const name of ["old", "fresh"]) {
        const root = join(dir, name);
        mkdirSync(root);
        writeFileSync(join(root, "package.json"), '{"type":"module"}');
        for (const entry of readdirSync(sourceDir, { recursive: true, withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
          const sourcePath = join(entry.parentPath, entry.name);
          const outputPath = join(root, relative(sourceDir, sourcePath).replace(/\.ts$/, ".js"));
          mkdirSync(dirname(outputPath), { recursive: true });
          writeFileSync(outputPath, transpileModule(readFileSync(sourcePath, "utf8"), {
            compilerOptions: { module: ModuleKind.ESNext },
          }).outputText);
        }
        copyFileSync(new URL("./fixtures/budget-scripted-runner.mjs", import.meta.url), join(root, "agent-runner.js"));
      }
      copyFileSync(new URL("./fixtures/budget-manager-reload.mjs", import.meta.url), join(dir, "check.mjs"));
      expect(execFileSync(process.execPath, [join(dir, "check.mjs")], { encoding: "utf8", timeout: 10_000 })).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shares the cap and waiters with a separately loaded copy of the budget module", () => {
    // Compile the actual source once, then load two physical ESM files in one
    // process. Static imports in the fixture give distinct module instances,
    // not two references to one cached module, without keeping a source fork.
    // Real managers' admission/release wiring is exercised by the tests above.
    const dir = mkdtempSync(join(tmpdir(), "budget-reload-"));
    try {
      const source = readFileSync(new URL("../src/process-budget.ts", import.meta.url), "utf8");
      const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext } });
      writeFileSync(join(dir, "old.mjs"), outputText);
      writeFileSync(join(dir, "fresh.mjs"), outputText);
      // Model a reload onto the next incompatible state version, using the
      // same source apart from its version marker, not a handwritten budget.
      const incompatibleSource = source.replace(/const BUDGET_VERSION = (\d+);/, (_, version: string) =>
        `const BUDGET_VERSION = ${Number(version) + 1};`);
      expect(incompatibleSource).not.toBe(source);
      writeFileSync(join(dir, "incompatible.mjs"), transpileModule(incompatibleSource, {
        compilerOptions: { module: ModuleKind.ESNext },
      }).outputText);
      copyFileSync(new URL("./fixtures/process-budget-reload.mjs", import.meta.url), join(dir, "check.mjs"));
      expect(execFileSync(process.execPath, [join(dir, "check.mjs")], { encoding: "utf8", timeout: 10_000 })).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    setBudgetPolicy({ maxActive: 3, nestedReserve: 1, maxDepth: 2 });
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
    setBudgetPolicy({ maxActive: 1, nestedReserve: 0, maxDepth: 1 });
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
    setBudgetPolicy({ maxActive: 1, nestedReserve: 0, maxDepth: 1 });
    const m = newManager();
    bg(m);
    for (let i = 0; i < MAX_PENDING_SUBAGENTS; i++) bg(m);
    const before = m.listAgents().length;
    expect(() => bg(m)).toThrow(BUDGET_QUEUE_FULL_ERROR);
    expect(m.listAgents()).toHaveLength(before);
  });

  it("is off by default: counted, never enforced, and turned on only once idle", async () => {
    resetBudgetForTests();
    const m = newManager();
    const ids = Array.from({ length: 20 }, (_, i) =>
      m.spawn(pi, ctx, "general-purpose", "x", { description: `n${i}`, depth: 2, parentAgentId: "p", maxSubagentDepth: 2 }));
    await flush();
    expect(ids.every(id => m.getRecord(id)!.status === "running")).toBe(true);
    expect(budgetUsage()).toMatchObject({ active: 20, pending: 0, maxActive: 0 });

    // Twenty runs admitted with no reserve: enforcing now could strand their
    // children, so the policy waits for the last of them.
    setBudgetPolicy({ maxActive: 12, nestedReserve: 2, maxDepth: 2 });
    expect(getPendingBudgetPolicy()).toEqual({ maxActive: 12, nestedReserve: 2, maxDepth: 2 });
    const late = bg(m);
    expect(m.getRecord(late)!.status).toBe("running");
    for (const id of [...ids, late]) await finish(id);
    expect(budgetUsage()).toMatchObject({ active: 0, maxActive: 12 });
    expect(getPendingBudgetPolicy()).toBeUndefined();
  });

  it("raising the cap starts waiters at once", async () => {
    setBudgetPolicy({ maxActive: 1, nestedReserve: 0, maxDepth: 1 });
    const m = newManager();
    bg(m);
    const queued = bg(m);
    await flush();
    expect(m.getRecord(queued)!.status).toBe("queued");
    setBudgetPolicy({ maxActive: 2, nestedReserve: 0, maxDepth: 1 });
    await flush();
    expect(m.getRecord(queued)!.status).toBe("running");
  });

  it("holds a lowered cap until idle, so a waiting child of a running parent still starts", async () => {
    setBudgetPolicy({ maxActive: 3, nestedReserve: 1, maxDepth: 2 });
    const m = newManager();
    const [p1, p2] = [bg(m), bg(m)];
    await flush();
    const child = (parent: string) =>
      m.spawn(pi, ctx, "general-purpose", "review", { description: "review", depth: 2, parentAgentId: parent });
    const c1 = child(p1);
    const c2 = child(p2);
    await flush();
    expect(m.getRecord(c2)!.status).toBe("queued");

    // Applied now, maxActive 2 would leave c2 behind two parents waiting on it forever.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setBudgetPolicy({ maxActive: 2, nestedReserve: 1, maxDepth: 2 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("change deferred until all running subagents settle"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("continuous work can delay this indefinitely"));
    warn.mockRestore();
    expect(getBudgetPolicy().maxActive).toBe(3);
    await finish(c1);
    expect(m.getRecord(c2)!.status).toBe("running");

    for (const id of [c2, p1, p2]) await finish(id);
    expect(getBudgetPolicy()).toEqual({ maxActive: 2, nestedReserve: 1, maxDepth: 2 });
  });

  it("checks every deeper level, so later roots cannot take the slots grandchildren need", async () => {
    // limit(1) = 10, limit(2) = 12, limit(3) = 14. The old check looked only at
    // the run's own level: two more roots fit there, filled the process to 14,
    // and every depth-2 parent then waited forever on a grandchild.
    setBudgetPolicy({ maxActive: 14, nestedReserve: 2, maxDepth: 3 });
    const m = newManager();
    const roots = [bg(m), bg(m)];
    await flush();
    const nested = (parent: string, depth: number) =>
      m.spawn(pi, ctx, "general-purpose", "n", { description: "n", depth, parentAgentId: parent });
    const children = Array.from({ length: 10 }, (_, i) => nested(roots[i % 2], 2));
    await flush();
    expect(children.every(id => m.getRecord(id)!.status === "running")).toBe(true);

    const lateRoots = [bg(m), bg(m)];
    await flush();
    expect(lateRoots.map(id => m.getRecord(id)!.status)).toEqual(["queued", "queued"]);
    const grandchild = nested(children[0], 3);
    await flush();
    expect(m.getRecord(grandchild)!.status).toBe("running");
    expect(budgetUsage()).toMatchObject({ active: 13, pending: 2 });
  });

  it("refuses a run deeper than the policy reserves for instead of parking it", async () => {
    // A project file set its own maxSubagentDepth to 8; the global policy covers 2.
    const m = newManager();
    const root = bg(m, { maxSubagentDepth: 8 });
    await flush();
    const child = m.spawn(pi, ctx, "general-purpose", "c", { description: "c", depth: 2, parentAgentId: root, maxSubagentDepth: 8 });
    await flush();
    expect(m.getRecord(child)!.status).toBe("running");
    const before = m.listAgents().length;
    expect(() => m.spawn(pi, ctx, "general-purpose", "g", { description: "g", depth: 3, parentAgentId: child, maxSubagentDepth: 8 }))
      .toThrow(/exceeds the process budget's depth 2/);
    expect(m.listAgents()).toHaveLength(before);
    expect(budgetUsage()).toMatchObject({ active: 2, pending: 0 });
  });

  it("admits against the policy depth, not the live nesting setting", async () => {
    // Twelve finished roots whose sessions kept depth-2 nested tools; then the
    // user drops Nested depth to 1 and resumes all twelve at once. Admission
    // under the live depth (12 roots, no reserve) stranded every child.
    const resumes: Array<() => void> = [];
    vi.mocked(resumeAgent).mockImplementation((() =>
      new Promise(resolve => {
        resumes.push(() => resolve({ text: "resumed", aborted: false, steered: false }));
      })) as any);
    const m = newManager();
    const roots = Array.from({ length: 12 }, () => bg(m));
    await flush();
    for (const id of roots) await finish(id);
    setMaxSubagentDepth(1);
    try {
      const resumed = roots.map(id => m.resume(id, "again"));
      await flush();
      expect(roots.map(id => m.getRecord(id)!.status)).toEqual([...Array(10).fill("running"), "queued", "queued"]);
      const child = m.spawn(pi, ctx, "general-purpose", "c", { description: "c", depth: 2, parentAgentId: roots[0] });
      await flush();
      expect(m.getRecord(child)!.status).toBe("running");

      // Settle everything: the child, then each resume (each frees the slot
      // the next queued one takes) until all twelve have returned.
      await finish(child);
      while (resumes.length > 0) {
        resumes.shift()!();
        await flush();
      }
      expect((await Promise.all(resumed)).map(r => r!.status)).toEqual(Array(12).fill("completed"));
      expect(budgetUsage()).toMatchObject({ active: 0, pending: 0 });
    } finally {
      setMaxSubagentDepth(2);
    }
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
    setBudgetPolicy({ maxActive: 1, nestedReserve: 0, maxDepth: 1 });
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
    setBudgetPolicy({ maxActive: 1, nestedReserve: 0, maxDepth: 1 });
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
    setBudgetPolicy({ maxActive: 1, nestedReserve: 0, maxDepth: 1 });
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

  it("refuses either resume when the queue is full, leaving the record unchanged", async () => {
    setBudgetPolicy({ maxActive: 1, nestedReserve: 0, maxDepth: 1 });
    const m = newManager();
    const x = await finishedAgent(m);
    bg(m);
    for (let i = 0; i < MAX_PENDING_SUBAGENTS; i++) bg(m);
    const snapshot = { ...x };

    await expect(m.resume(x.id, "fg")).rejects.toThrow(BUDGET_QUEUE_FULL_ERROR);
    await expect(m.resume(x.id, "bg", undefined, { isBackground: true })).rejects.toThrow(BUDGET_QUEUE_FULL_ERROR);
    expect(m.getRecord(x.id)).toEqual(snapshot);
    expect(resumeAgent).not.toHaveBeenCalled();
  });

  it("hands back a background resume's slot and lease when its start throws", async () => {
    setBudgetPolicy({ maxActive: 1, nestedReserve: 0, maxDepth: 1 });
    let failResume = false;
    const completed: string[] = [];
    const m = new AgentManager(r => completed.push(`${r.id}:${r.status}`), 1, () => {
      if (failResume) throw new Error("onStart blew up");
    });
    managers.push(m);
    const x = await finishedAgent(m);
    const blocker = bg(m);
    await flush();
    failResume = true;
    expect((await m.resume(x.id, "again", undefined, { isBackground: true }))!.status).toBe("queued");

    // Queued path: granted when the blocker settles, fails in onStart.
    await finish(blocker);
    expect(x.status).toBe("error");
    expect(x.error).toBe("onStart blew up");
    expect(completed).toContain(`${x.id}:error`);
    expect(budgetUsage()).toMatchObject({ active: 0, pending: 0 });

    // Immediate path: the throw reaches the caller, nothing stays charged.
    await expect(m.resume(x.id, "again", undefined, { isBackground: true })).rejects.toThrow("onStart blew up");
    expect(x.status).toBe("error");
    expect(budgetUsage()).toMatchObject({ active: 0, pending: 0 });
    failResume = false;
    const next = bg(m);
    await flush();
    expect(m.getRecord(next)!.status).toBe("running");
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
    setBudgetPolicy({ maxActive: 1, nestedReserve: 0, maxDepth: 1 });
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
    setBudgetPolicy({ maxActive: 1, nestedReserve: 0, maxDepth: 1 });
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

  it("releases a queued start's lease and drains even when onComplete throws on its startup failure", async () => {
    setBudgetPolicy({ maxActive: 1, nestedReserve: 0, maxDepth: 1 });
    const m = new AgentManager(() => { throw new Error("onComplete blew up"); }, 10);
    managers.push(m);
    const blocker = bg(m);
    const dir = mkdtempSync(join(tmpdir(), "budget-cwd-"));
    const doomed = bg(m, { cwd: dir });
    const next = bg(m);
    await flush();
    rmSync(dir, { recursive: true, force: true });

    await finish(blocker);
    expect(m.getRecord(doomed)!.status).toBe("error");
    expect(m.getRecord(doomed)!.error).toMatch(/does not exist/);
    expect(m.getRecord(next)!.status).toBe("running");
    expect(budgetUsage()).toMatchObject({ active: 1, pending: 0 });
  });

  it("drains after an error settle whose onComplete throws, so a parent's queued child starts", async () => {
    setBudgetPolicy({ maxActive: 2, nestedReserve: 1, maxDepth: 2 });
    const m = new AgentManager(() => { throw new Error("onComplete blew up"); }, 10);
    managers.push(m);
    const parent = bg(m);
    await flush();
    // The first child's runner rejects; the second waits for its slot.
    vi.mocked(runAgent).mockImplementationOnce((() => Promise.reject(new Error("provider down"))) as any);
    const child = (description: string) =>
      m.spawn(pi, ctx, "general-purpose", "review", { description, depth: 2, parentAgentId: parent });
    const failing = child("c1");
    const waiting = child("c2");
    expect(m.getRecord(waiting)!.status).toBe("queued");

    // The unguarded error-path onComplete still rejects the run's promise.
    await expect(m.getRecord(failing)!.promise).rejects.toThrow("onComplete blew up");
    await flush();
    expect(m.getRecord(failing)!.status).toBe("error");
    expect(m.getRecord(waiting)!.status).toBe("running");
    expect(budgetUsage()).toMatchObject({ active: 2, pending: 0 });
  });

  it("hands back a spawn's pool slot and lease when its onStart throws", async () => {
    let failStart = true;
    const m = new AgentManager(undefined, 1, () => {
      if (failStart) throw new Error("onStart blew up");
    });
    managers.push(m);
    const doomed = bg(m);
    await expect(m.awaitStartup(doomed)).rejects.toThrow("onStart blew up");
    expect(m.getRecord(doomed)).toBeUndefined();
    expect(budgetUsage()).toMatchObject({ active: 0, pending: 0 });

    // maxConcurrent 1: a leaked slot would queue this forever.
    failStart = false;
    const next = bg(m);
    await flush();
    expect(m.getRecord(next)!.status).toBe("running");
  });

  it("removes the worktree and frees the slot when onStart throws after the copy", async () => {
    vi.mocked(cleanupWorktree).mockClear();
    vi.mocked(createWorktree).mockResolvedValueOnce({ path: "/tmp/wt", workPath: "/tmp/wt", repoRoot: "/tmp", branch: "b" } as any);
    const m = new AgentManager(undefined, 1, () => { throw new Error("onStart blew up"); });
    managers.push(m);
    const doomed = bg(m, { isolation: "worktree" });
    await expect(m.awaitStartup(doomed)).rejects.toThrow("onStart blew up");
    expect(cleanupWorktree).toHaveBeenCalledWith(pi, "/tmp", expect.objectContaining({ path: "/tmp/wt" }), "bg");
    expect(runAgent).not.toHaveBeenCalled();
    expect(budgetUsage()).toMatchObject({ active: 0, pending: 0 });
  });

  it("releases an immediate start's lease when worktree creation fails", async () => {
    vi.mocked(createWorktree).mockRejectedValueOnce(new Error("not a git repo"));
    const m = newManager();
    const id = bg(m, { isolation: "worktree" });
    await expect(m.awaitStartup(id)).rejects.toThrow(/not a git repo/);
    expect(budgetUsage().active).toBe(0);
  });

  it("holds a lease stopped mid-copy until the copy is cleaned up", async () => {
    setBudgetPolicy({ maxActive: 1, nestedReserve: 0, maxDepth: 1 });
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

  it("keeps a run's lease through dispose until the run itself settles", async () => {
    setBudgetPolicy({ maxActive: 2, nestedReserve: 0, maxDepth: 1 });
    const a = newManager();
    const ids = [bg(a), bg(a)];
    await flush();
    const stillRunning = ids.map(id => runs.get(id)!);

    await a.dispose();
    // The sessions are shut down, but the runs have not returned: still counted.
    expect(budgetUsage().active).toBe(2);
    const b = newManager();
    const waiting = bg(b);
    await flush();
    expect(b.getRecord(waiting)!.status).toBe("queued");

    stillRunning[0].finish();
    await flush();
    expect(b.getRecord(waiting)!.status).toBe("running");
    stillRunning[1].finish();
    await flush();
    expect(budgetUsage()).toMatchObject({ active: 1, pending: 0 });
  });

  it("keeps a lease stopped mid-copy through dispose until the worktree cleanup finishes", async () => {
    setBudgetPolicy({ maxActive: 1, nestedReserve: 0, maxDepth: 1 });
    let copied!: (wt: any) => void;
    vi.mocked(createWorktree).mockReturnValueOnce(new Promise(r => { copied = r; }) as any);
    let cleaned!: () => void;
    vi.mocked(cleanupWorktree).mockReturnValueOnce(new Promise(r => { cleaned = () => r({ hasChanges: false }); }) as any);
    const m = newManager();
    bg(m, { isolation: "worktree" });
    await flush();

    // `/new` with no survivors: abortAll, then dispose.
    m.abortAll();
    await m.dispose();
    expect(budgetUsage().active).toBe(1);
    copied({ path: "/tmp/wt", workPath: "/tmp/wt", repoRoot: "/tmp", branch: "b" });
    await flush();
    expect(cleanupWorktree).toHaveBeenCalled();
    expect(budgetUsage().active).toBe(1);
    cleaned();
    await flush();
    expect(budgetUsage().active).toBe(0);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("marks a foreground resume still waiting for a lease stopped when dispose removes it", async () => {
    setBudgetPolicy({ maxActive: 1, nestedReserve: 0, maxDepth: 1 });
    const m = newManager();
    const id = bg(m);
    await flush();
    await finish(id);
    const x = m.getRecord(id)!;
    const blocker = bg(m);
    await flush();

    const pending = m.resume(x.id, "again");
    await flush();
    expect(x.status).toBe("queued");
    await m.dispose();
    const resumed = (await pending)!;
    expect(resumed.status).toBe("stopped");
    expect(resumed.completedAt).toBeDefined();
    expect(resumeAgent).not.toHaveBeenCalled();
    expect(budgetUsage()).toMatchObject({ active: 1, pending: 0 });
    runs.get(blocker)!.finish();
    await flush();
    expect(budgetUsage().active).toBe(0);
  });

  it("turns off at once with leases held, starting every waiter and dropping a held change", async () => {
    setBudgetPolicy({ maxActive: 1, nestedReserve: 0, maxDepth: 1 });
    const m = newManager();
    const blocker = bg(m);
    const queued = [bg(m), bg(m)];
    await flush();
    setBudgetPolicy({ maxActive: 2, nestedReserve: 1, maxDepth: 2 });
    expect(getPendingBudgetPolicy()).toBeDefined();

    setBudgetPolicy({ maxActive: 0, nestedReserve: 0, maxDepth: 1 });
    expect(getBudgetPolicy().maxActive).toBe(0);
    expect(getPendingBudgetPolicy()).toBeUndefined();
    await flush();
    expect(queued.map(id => m.getRecord(id)!.status)).toEqual(["running", "running"]);
    // Still counted while off, so turning it back on waits for all three.
    expect(budgetUsage()).toMatchObject({ active: 3, pending: 0, maxActive: 0 });
    for (const id of [blocker, ...queued]) await finish(id);
    expect(budgetUsage().active).toBe(0);
  });

  it("keeps a survivor's queued nested child through detach", async () => {
    setBudgetPolicy({ maxActive: 3, nestedReserve: 1, maxDepth: 2 });
    const m = newManager();
    const [p1, p2] = [bg(m), bg(m)];
    await flush();
    const child = (parent: string) =>
      m.spawn(pi, ctx, "general-purpose", "review", { description: "review", depth: 2, parentAgentId: parent });
    const c1 = child(p1);
    const c2 = child(p2);
    await flush();
    expect(m.getRecord(c2)!.status).toBe("queued");

    expect(m.detach()).toBe(3);
    expect(m.getRecord(c2)!.status).toBe("queued");
    await finish(c1);
    expect(m.getRecord(c2)!.status).toBe("running");

    // A stopped parent still takes its queued child with it.
    const c3 = child(p1);
    await flush();
    expect(m.getRecord(c3)!.status).toBe("queued");
    m.abort(p1);
    await flush();
    expect(m.getRecord(c3)!.status).toBe("stopped");
    expect(budgetUsage().pending).toBe(0);
  });
});
