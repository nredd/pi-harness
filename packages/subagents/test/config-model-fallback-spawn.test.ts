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
import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { modelFallbackNote, setAgentModels } from "../src/model-resolver.js";
import { SubagentScheduler } from "../src/schedule.js";
import { ScheduleStore } from "../src/schedule-store.js";
import type { AgentConfig } from "../src/types.js";
import { createWorkflowHost } from "../src/workflow/host.js";
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

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "config-model-fallback-sched-"));
    scheduler = new SubagentScheduler();
    manager = new AgentManager();
    scheduler.start({ events: { emit: vi.fn() } } as any, ctx(), manager, new ScheduleStore(join(tmp, "s.json")));
  });

  afterEach(() => {
    scheduler.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function fire(model?: string) {
    scheduler.addJob({
      name: "job", description: "job", schedule: new Date(Date.now() + 50).toISOString(),
      subagent_type: "scout", prompt: "go", ...(model ? { model } : {}),
    });
    await vi.waitFor(() => expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1), { timeout: 2000 });
    return manager.listAgents()[0]!;
  }

  it("a job whose stored model no longer resolves says so, naming the parent it ran on", async () => {
    registerAgents(new Map([agent("scout")]));

    const record = await fire("claude-haiku-4-5");

    expect(record.modelFallback).toEqual({ input: "claude-haiku-4-5", used: "anthropic/claude-sonnet-5-5", via: "parent" });
  });

  it("a job on an agent whose definition `model:` does not resolve says so, from the runner", async () => {
    registerAgents(new Map([agent("scout", "claude-haiku-4-5")]));

    const record = await fire();

    expect(record.modelFallback).toEqual({ input: "claude-haiku-4-5", used: "anthropic/claude-sonnet-5-5" });
  });

  it("a job with no stored model honors an unavailable agentModels override and discloses it", async () => {
    registerAgents(new Map([agent("scout", "anthropic/claude-sonnet-5-5")]));
    setAgentModels({ scout: "claude-haiku-4-5" });

    const record = await fire();

    // The override outranks the (resolving) definition model, so nothing silently ran it.
    expect(record.modelFallback).toEqual({ input: "claude-haiku-4-5", used: "anthropic/claude-sonnet-5-5" });
  });

  it("a stored model that does not resolve is still disclosed when the definition's own model took over", async () => {
    // Selection is unchanged (the definition's model runs), but the failed stored
    // input is named, along with what actually ran.
    registerAgents(new Map([agent("scout", "anthropic/claude-sonnet-5-5")]));

    const record = await fire("claude-haiku-4-5");

    expect(record.modelFallback).toEqual({
      input: "claude-haiku-4-5", used: "anthropic/claude-sonnet-5-5", via: "agent",
    });
    expect(modelFallbackNote(record.modelFallback)).toBe(
      'Note: configured model "claude-haiku-4-5" did not resolve; running on the agent\'s own model anthropic/claude-sonnet-5-5.',
    );
    expect(vi.mocked(runAgent).mock.calls[0]?.[3].model).toBeUndefined();
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
});
