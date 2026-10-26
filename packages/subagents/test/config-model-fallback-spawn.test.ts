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

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
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
import { setAgentModels } from "../src/model-resolver.js";
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

    expect(record.modelFallback).toEqual({ input: "claude-haiku-4-5", used: "anthropic/claude-sonnet-5-5" });
  });

  it("a job on an agent whose definition `model:` does not resolve says so, from the runner", async () => {
    registerAgents(new Map([agent("scout", "claude-haiku-4-5")]));

    const record = await fire();

    expect(record.modelFallback).toEqual({ input: "claude-haiku-4-5", used: "anthropic/claude-sonnet-5-5" });
  });

  it("a stored model that does not resolve is not blamed when the definition's own model took over", async () => {
    // The runner picks the definition's model, so the parent was never used.
    registerAgents(new Map([agent("scout", "anthropic/claude-sonnet-5-5")]));

    const record = await fire("claude-haiku-4-5");

    expect(record.modelFallback).toBeUndefined();
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
});
