/**
 * plan-mode-children.test.ts -- #437 at the manager level: which runs are put
 * under Plan mode's policy. The query contract is pinned in
 * plan-mode-contract.test.ts, and real sessions in plan-mode-children-e2e.test.ts
 * and plan-mode-session.test.ts against the real pi-plan-mode extension.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});
vi.mock("../src/mention-clone.js", () => ({ runMentionClone: vi.fn() }));

import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { PLAN_MODE_STATE_QUERY, type PlanToolPolicy } from "../src/plan-mode-children.js";
import { buildInvocationTags } from "../src/ui/agent-widget.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const BLOCK_WRITE: PlanToolPolicy = ({ toolName }) => (toolName === "write" ? "Plan blocks write" : undefined);

/** A parent event bus whose pi-plan-mode answers with whatever `answer()` says now. */
function planBus(answer: () => unknown) {
  return {
    emit: (channel: string, data: unknown) => {
      if (channel !== PLAN_MODE_STATE_QUERY) return;
      const reply = (data as { reply: (state: unknown) => void }).reply;
      const state = answer();
      if (state !== undefined) reply(state);
    },
  };
}

function planningPi(planning: { active: boolean }) {
  return {
    events: planBus(() =>
      planning.active ? { version: 1, active: true, sessionId: "s", evaluate: BLOCK_WRITE } : { version: 1, active: false },
    ),
  } as any;
}

const call = (toolName: string) => ({ toolName, input: {}, cwd: "/repo", tool: undefined });

describe("AgentManager under Plan mode", () => {
  let manager: AgentManager | undefined;
  const mockCtx = { cwd: "/tmp" } as any;
  const session = () => ({ dispose: vi.fn() }) as any;

  afterEach(async () => {
    await manager?.dispose();
    manager = undefined;
    vi.mocked(runAgent).mockReset();
    vi.mocked(resumeAgent).mockReset();
  });

  const runOptions = () => vi.mocked(runAgent).mock.lastCall?.[3];

  it("restricts a child spawned while planning and keeps it restricted after Plan ends", async () => {
    const planning = { active: true };
    const pi = planningPi(planning);
    let finish!: () => void;
    vi.mocked(runAgent).mockImplementation(
      () => new Promise((resolve) => { finish = () => resolve({ responseText: "done", session: session(), aborted: false, steered: false } as any); }),
    );
    manager = new AgentManager();
    const id = manager.spawn(pi, mockCtx, "general-purpose", "plan it", { description: "d", isBackground: true });
    const record = manager.getRecord(id)!;
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalled());

    expect(runOptions()?.planGate).toBe(record.planGate);
    expect(record.planGate?.policy?.(call("write"))).toBe("Plan blocks write");
    expect(buildInvocationTags(record.invocation).tags).toContain("plan");

    // The parent approves and leaves Plan mid-run: the child was briefed as a planner.
    planning.active = false;
    expect(record.planGate?.policy?.(call("write"))).toBe("Plan blocks write");
    finish();
    await record.promise;

    // A resume after exit gets the normal surface back, on the same gate object.
    const gate = record.planGate;
    vi.mocked(resumeAgent).mockResolvedValue({ text: "again", aborted: false, steered: false } as any);
    await manager.resume(id, "continue");
    expect(record.planGate).toBe(gate);
    expect(record.planGate?.policy).toBeUndefined();
    expect(record.invocation?.planMode).toBeUndefined();
    expect(buildInvocationTags(record.invocation).tags).not.toContain("plan");

    // And a resume while planning again restricts it again, background included.
    planning.active = true;
    await manager.resume(id, "once more", undefined, { isBackground: true });
    expect(record.planGate?.policy?.(call("write"))).toBe("Plan blocks write");
    expect(record.invocation?.planMode).toBe(true);
    await record.promise;
  });

  it("leaves an agent started before Plan unrestricted, and it can still be steered", async () => {
    const planning = { active: false };
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager = new AgentManager();
    const id = manager.spawn(planningPi(planning), mockCtx, "general-purpose", "work", { description: "d", isBackground: true });
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalled());
    planning.active = true;

    const record = manager.getRecord(id)!;
    expect(record.planGate?.policy).toBeUndefined();
    expect(record.invocation).toBeUndefined();
    expect(manager.steer(id, "look at the parser too")).toBe(true);
    expect(record.pendingSteers).toEqual(["look at the parser too"]);
  });

  it("restricts workflow children and nested children of a restricted run", async () => {
    const planning = { active: true };
    const pi = planningPi(planning);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager = new AgentManager();

    const workflowChild = manager.spawn(pi, mockCtx, "general-purpose", "stage", { description: "w", workflowId: "wf-1" });
    expect(manager.getRecord(workflowChild)?.planGate?.policy).toBeDefined();

    const parent = manager.spawn(pi, mockCtx, "general-purpose", "orchestrate", { description: "p", isBackground: true });
    planning.active = false;
    const nested = manager.spawn(pi, mockCtx, "general-purpose", "leaf", {
      description: "n",
      isBackground: true,
      parentAgentId: parent,
      depth: 2,
    });
    // Plan is over for the session, but the owner was briefed as a planner and so is its child.
    expect(manager.getRecord(nested)?.planGate?.policy?.(call("write"))).toBe("Plan blocks write");
    const unrelated = manager.spawn(pi, mockCtx, "general-purpose", "later", { description: "u", isBackground: true });
    expect(manager.getRecord(unrelated)?.planGate?.policy).toBeUndefined();
  });

  it("restricts a nested child of a pre-Plan owner when Plan is on at its spawn", async () => {
    const planning = { active: false };
    const pi = planningPi(planning);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager = new AgentManager();

    const owner = manager.spawn(pi, mockCtx, "general-purpose", "orchestrate", { description: "o", isBackground: true });
    expect(manager.getRecord(owner)?.planGate?.policy).toBeUndefined();
    planning.active = true;
    const nested = manager.spawn(pi, mockCtx, "general-purpose", "leaf", {
      description: "n",
      isBackground: true,
      parentAgentId: owner,
      depth: 2,
    });
    expect(manager.getRecord(nested)?.planGate?.policy?.(call("write"))).toBe("Plan blocks write");
    expect(manager.getRecord(owner)?.planGate?.policy).toBeUndefined();
  });

  it("refuses worktree isolation while planning", async () => {
    vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session: session(), aborted: false, steered: false } as any);
    manager = new AgentManager();
    const id = manager.spawn(planningPi({ active: true }), mockCtx, "general-purpose", "edit", {
      description: "d",
      isBackground: true,
      isolation: "worktree",
    });
    await expect(manager.awaitStartup(id)).rejects.toThrow(
      'Cannot run with isolation: "worktree" while Plan mode is active: a worktree exists to make edits. Omit `isolation`, or leave Plan mode first.',
    );
    expect(runAgent).not.toHaveBeenCalled();
    // An immediate start that fails takes its record with it: nothing is left running in the fleet.
    expect(manager.getRecord(id)).toBeUndefined();
    expect(manager.listAgents()).toEqual([]);
  });
});

describe("an @handle mention while planning", () => {
  let hermetic: Hermetic | undefined;
  let lifecycle: Map<string, any> | undefined;

  afterEach(async () => {
    await lifecycle?.get("session_shutdown")?.();
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    lifecycle = undefined;
    hermetic?.restore();
    hermetic = undefined;
    vi.mocked(runAgent).mockReset();
  });

  it("starts a restricted child", async () => {
    hermetic = hermeticDir({ settings: { outputTranscript: false, agentMentions: "direct" } });
    const booted = makePi();
    booted.pi.events.emit = planBus(() => ({ version: 1, active: true, evaluate: BLOCK_WRITE })).emit;
    subagentsExtension(booted.pi);
    lifecycle = booted.lifecycle;
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    await lifecycle.get("input")({ type: "input", text: "@Explore find the parser", source: "interactive" }, ctx());
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalled());

    expect(vi.mocked(runAgent).mock.lastCall?.[3].planGate?.policy?.(call("write"))).toBe("Plan blocks write");
  });
});
