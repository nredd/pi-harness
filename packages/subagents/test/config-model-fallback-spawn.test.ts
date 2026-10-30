/**
 * config-model-fallback-spawn.test.ts -- the scheduler-at-fire and workflow-host
 * entry paths of the config-model fallback disclosure (see
 * config-model-fallback-wiring.test.ts for the rest). Both run a real
 * `AgentManager`, so what is asserted is `AgentRecord.modelFallback` as the shared
 * spawn path leaves it, plus what each path's own reporter hands on.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunner from "../src/agent-runner.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunner>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(async () => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(async () => {}),
  isWorktreeIsolationEnabled: vi.fn(() => false),
}));

import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { setAgentModels } from "../src/model-resolver.js";
import { SubagentScheduler } from "../src/schedule.js";
import { ScheduleStore } from "../src/schedule-store.js";
import type { AgentConfig } from "../src/types.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { runnerResolution } from "./helpers/runner-resolution.js";

const PARENT = { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" };
const NOTE = 'Note: configured model "claude-haiku-4-5" did not resolve; running on parent model anthropic/claude-sonnet-5-5.';

const agent = (name: string, model?: string): [string, AgentConfig] => [
  name,
  {
    name, description: name, builtinToolNames: ["read"], skills: false, systemPrompt: name, promptMode: "replace",
    inheritContext: false, runInBackground: false, isolated: false, ...(model ? { model } : {}),
  } as AgentConfig,
];

function ctx() {
  return {
    cwd: "/tmp",
    model: PARENT,
    ui: { notify: vi.fn() },
    modelRegistry: {
      find: (provider: string, id: string) => (provider === PARENT.provider && id === PARENT.id ? PARENT : undefined),
      getAll: () => [PARENT],
      getAvailable: () => [PARENT],
    },
    sessionManager: { getSessionId: () => "s" },
  } as any;
}

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  vi.mocked(runAgent).mockImplementation(runnerResolution() as any);
});

afterEach(() => {
  setAgentModels(undefined);
  registerAgents(new Map());
});

describe("scheduler at fire time", () => {
  let tmp: string;
  let scheduler: SubagentScheduler;
  let manager: AgentManager;
  let clock: FakeClock;
  const emit = vi.fn();

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "config-model-fallback-sched-"));
    clock = new FakeClock();
    scheduler = new SubagentScheduler({ clock });
    manager = new AgentManager();
    emit.mockClear();
    scheduler.start({ events: { emit } } as any, ctx(), manager, new ScheduleStore(join(tmp, "s.json")));
  });

  afterEach(async () => {
    scheduler.stop();
    await manager.dispose();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function fire(model?: string) {
    const job = scheduler.addJob({
      name: "job", description: "job", schedule: new Date(clock.now() + 50).toISOString(),
      subagent_type: "scout", prompt: "go", ...(model ? { model } : {}),
    });
    expect(clock.pending).toBe(1);
    clock.advance(49);
    expect(scheduler.list()[0].lastStatus).toBeUndefined();
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
    clock.advance(1);
    // Drain runner/manager/scheduler promises, not a wall-time polling deadline.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(scheduler.list()[0]).toMatchObject({
      id: job.id, enabled: false, lastStatus: expect.stringMatching(/success|error/),
      lastRun: new Date(clock.now()).toISOString(),
    });
    expect(clock.pending).toBe(0);
    clock.advance(50);
    return manager.listAgents()[0]!;
  }

  it("rejects a deadline that the injected clock has already passed, before model selection", () => {
    registerAgents(new Map([agent("scout")]));
    const schedule = new Date(clock.now() + 50).toISOString();
    clock.advance(51);

    expect(() => scheduler.addJob({
      name: "late", description: "late", schedule, subagent_type: "scout", prompt: "go", model: "claude-haiku-4-5",
    })).toThrow(/Scheduled time .* is in the past/);
    expect(scheduler.list()).toEqual([]);
    expect(clock.pending).toBe(0);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("stamps createdAt from the injected clock, not the wall clock", () => {
    registerAgents(new Map([agent("scout")]));
    clock.advance(7);

    const job = scheduler.addJob({
      name: "stamped", description: "stamped", schedule: new Date(clock.now() + 50).toISOString(),
      subagent_type: "scout", prompt: "go",
    });

    expect(job.createdAt).toBe(new Date(clock.now()).toISOString());
    expect(scheduler.list()[0]?.createdAt).toBe(job.createdAt);
  });

  it("refuses a job whose explicit stored model no longer resolves", async () => {
    registerAgents(new Map([agent("scout")]));

    const record = await fire("claude-haiku-4-5");

    expect(record).toBeUndefined();
    expect(runAgent).not.toHaveBeenCalled();
    expect(scheduler.list()[0].lastStatus).toBe("error");
  });

  it("a job on an agent whose definition `model:` does not resolve says so, from the runner", async () => {
    registerAgents(new Map([agent("scout", "claude-haiku-4-5")]));

    const record = await fire();

    expect(record.modelFallback).toEqual({ input: "claude-haiku-4-5", used: "anthropic/claude-sonnet-5-5" });
  });

  it("executes a resolved explicit model once at the injected deadline", async () => {
    registerAgents(new Map([agent("scout")]));

    const record = await fire("anthropic/claude-sonnet-5-5");

    expect(record.status).toBe("completed");
    expect(record.modelFallback).toBeUndefined();
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAgent).mock.calls[0][3]).toMatchObject({ model: PARENT });
    expect(scheduler.list()[0]).toMatchObject({ lastStatus: "success", runCount: 1 });
    expect(emit).toHaveBeenCalledWith("subagents:scheduled", {
      type: "fired", jobId: scheduler.list()[0].id, agentId: record.id, name: "job",
    });
  });

  it.each(["remove", "stop"])("cancels a pending model job on %s without resolving or executing it", action => {
    registerAgents(new Map([agent("scout")]));
    const job = scheduler.addJob({
      name: "cancelled", description: "cancelled", schedule: new Date(clock.now() + 50).toISOString(),
      subagent_type: "scout", prompt: "go", model: "claude-haiku-4-5",
    });
    clock.advance(49);
    expect(clock.pending).toBe(1);
    expect(runAgent).not.toHaveBeenCalled();
    emit.mockClear();
    if (action === "remove") expect(scheduler.removeJob(job.id)).toBe(true);
    else scheduler.stop();
    expect(clock.pending).toBe(0);
    clock.advance(51);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
    expect(emit.mock.calls.filter(([, event]) => event.type === "error" || event.type === "fired")).toEqual([]);
  });

  it("does not replace an unresolved explicit job model with the definition's model", async () => {
    registerAgents(new Map([agent("scout", "anthropic/claude-sonnet-5-5")]));

    const record = await fire("claude-haiku-4-5");

    expect(record).toBeUndefined();
    expect(runAgent).not.toHaveBeenCalled();
    expect(scheduler.list()[0].lastStatus).toBe("error");
  });
});

describe("workflow host", () => {
  const request = (over: Record<string, unknown> = {}) => ({
    agentId: "wf-0", index: 0, prompt: "go", label: "impl", agentType: "scout", ...over,
  }) as any;

  it("hands the note over through onResolved when agentModels does not resolve", async () => {
    registerAgents(new Map([agent("scout")]));
    setAgentModels({ scout: "claude-haiku-4-5" });
    const reports: Record<string, unknown>[] = [];
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: new AgentManager() });

    await host.spawnAgent(request({ onResolved: (info: Record<string, unknown>) => reports.push(info) }));

    expect(reports.find(r => r.modelNote !== undefined)).toMatchObject({ modelNote: NOTE });
    expect(vi.mocked(runAgent).mock.calls[0]?.[3]).toMatchObject({ model: PARENT });
  });

  it("reports no note when the model resolves", async () => {
    registerAgents(new Map([agent("scout", "anthropic/claude-sonnet-5-5")]));
    const reports: Record<string, unknown>[] = [];
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: new AgentManager() });

    await host.spawnAgent(request({ onResolved: (info: Record<string, unknown>) => reports.push(info) }));

    expect(reports.every(r => r.modelNote === undefined)).toBe(true);
  });

  it("still refuses a script-named model that does not resolve", async () => {
    registerAgents(new Map([agent("scout")]));
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: new AgentManager() });

    const result = await host.spawnAgent(request({ model: "claude-haiku-4-5" }));

    expect(result.ok).toBe(false);
    expect(runAgent).not.toHaveBeenCalled();
  });

  describe("the result the script reads", () => {
    it("leads the text with the note and carries it as a field", async () => {
      registerAgents(new Map([agent("scout", "claude-haiku-4-5")]));
      const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: new AgentManager() });

      const result = await host.spawnAgent(request());

      expect(result.ok).toBe(true);
      expect(result.text?.startsWith(NOTE)).toBe(true);
      expect(result.text).toContain("done");
      expect(result.modelNote).toBe(NOTE);
    });

    it("leads the error with the note", async () => {
      registerAgents(new Map([agent("scout", "claude-haiku-4-5")]));
      vi.mocked(runAgent).mockImplementation((async (c: any, t: string, p: string, o: any) => {
        await runnerResolution()(c, t, p, o);
        throw new Error("boom");
      }) as any);
      const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: new AgentManager() });

      const result = await host.spawnAgent(request());

      expect(result.ok).toBe(false);
      expect(result.error?.startsWith(NOTE)).toBe(true);
      expect(result.error).toContain("boom");
    });

    it("leaves a schema'd payload parseable and carries the note as a field only", async () => {
      registerAgents(new Map([agent("scout", "claude-haiku-4-5")]));
      const manager = new AgentManager();
      const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager });
      vi.mocked(runAgent).mockImplementation((async (c: any, t: string, p: string, o: any) => {
        const out = await runnerResolution()(c, t, p, o);
        return { ...out, structuredJson: '{"a":1}' };
      }) as any);

      const result = await host.spawnAgent(request({ schema: { compiled: true } }));

      expect(result.text).toBe('{"a":1}');
      expect(result.modelNote).toBe(NOTE);
    });

    it("adds nothing when the model resolved", async () => {
      registerAgents(new Map([agent("scout", "anthropic/claude-sonnet-5-5")]));
      const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: new AgentManager() });

      const result = await host.spawnAgent(request());

      expect(result.text).toBe("done");
      expect(result.modelNote).toBeUndefined();
    });
  });

  describe("resume reports the known provenance BEFORE awaiting completion", () => {
    it("the running row has the note while the resume is still in flight", async () => {
      registerAgents(new Map([agent("scout", "claude-haiku-4-5")]));
      vi.mocked(runAgent).mockImplementation(runnerResolution() as any);
      let release!: () => void;
      vi.mocked(resumeAgent).mockImplementation((() => new Promise((resolve) => {
        release = () => resolve({ text: "later", aborted: false, steered: false });
      })) as any);
      const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: new AgentManager() });
      await host.spawnAgent(request());

      const reports: Record<string, unknown>[] = [];
      const pending = host.resumeAgent!("wf-0", "more", (info) => reports.push(info as Record<string, unknown>));
      await Promise.resolve();

      expect(reports.find(r => r.modelNote !== undefined)).toMatchObject({ modelNote: NOTE });
      release();
      await pending;
    });
  });

  describe("resuming a schema-origin child", () => {
    it("returns the resumed prose with the note, never the stale structured JSON", async () => {
      registerAgents(new Map([agent("scout", "claude-haiku-4-5")]));
      vi.mocked(runAgent).mockImplementation((async (c: any, t: string, p: string, o: any) => {
        const out = await runnerResolution()(c, t, p, o);
        return { ...out, structuredJson: '{"a":1}' };
      }) as any);
      vi.mocked(resumeAgent).mockResolvedValue({ text: "follow-up answer", aborted: false, steered: false } as any);
      const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: new AgentManager() });
      await host.spawnAgent(request({ schema: { compiled: true } }));

      const resumed = await host.resumeAgent!("wf-0", "more");

      expect(resumed.ok).toBe(true);
      expect(resumed.text).toBe(`${NOTE}\n\nfollow-up answer`);
      expect(resumed.modelNote).toBe(NOTE);
    });
  });
});
