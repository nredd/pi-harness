/**
 * When completion notifications reach the parent, through the real extension:
 * held while the parent runs and sent at its turn's end, as in Claude Code, and
 * — in `group` join mode — batched by the turn that spawned them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunnerModule from "../src/agent-runner.js";
import type * as WorktreeModule from "../src/worktree.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunnerModule>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

vi.mock("../src/worktree.js", async () => {
  const actual = await vi.importActual<typeof WorktreeModule>("../src/worktree.js");
  return {
    ...actual,
    createWorktree: vi.fn(),
    cleanupWorktree: vi.fn(async () => ({ hasChanges: false })),
    isWorktreeIsolationEnabled: vi.fn(() => true),
  };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { createWorktree } from "../src/worktree.js";
import { type BootedPi, ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

let booted: BootedPi | undefined;
let hermetic: Hermetic | undefined;

afterEach(async () => {
  await booted?.lifecycle.get("session_shutdown")?.();
  delete (globalThis as any)[MANAGER_KEY];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
  vi.mocked(createWorktree).mockReset();
  vi.useRealTimers();
});

/** Boot the extension with a parent whose run state the test controls. */
async function boot(settings: Record<string, unknown> = {}, events?: unknown) {
  hermetic = hermeticDir({ settings: { outputTranscript: false, schedulingEnabled: false, ...settings } });
  booted = makePi();
  if (events) booted.pi.events = events;
  subagentsExtension(booted.pi);
  const parent = { running: true };
  const signal = new AbortController().signal;
  const parentCtx = ctx();
  Object.defineProperty(parentCtx, "signal", { get: () => (parent.running ? signal : undefined) });
  await booted.lifecycle.get("session_start")({ type: "session_start" }, parentCtx);
  return { ...booted, parent, parentCtx };
}

/** Runs that settle only when `settle(description)` is called. */
function controllableRuns() {
  const finishers = new Map<string, () => void>();
  vi.mocked(runAgent).mockImplementation((_c: any, _t: any, prompt: any) =>
    new Promise<any>(resolve => {
      finishers.set(prompt, () => resolve({
        responseText: `${prompt} done`, session: { dispose: vi.fn(), messages: [] }, aborted: false, steered: false,
      }));
    }) as any,
  );
  vi.mocked(resumeAgent).mockImplementation((_s: any, prompt: string) =>
    new Promise(resolve => { finishers.set(prompt, () => resolve({ text: `${prompt} done` })); }),
  );
  return { settle: (prompt: string) => finishers.get(prompt)!() };
}

const spawn = (b: BootedPi, parentCtx: any, prompt: string, extra: Record<string, unknown> = {}) =>
  b.tools.get("Agent").execute(
    `call-${prompt}`,
    { prompt, description: prompt, subagent_type: "general-purpose", run_in_background: true, ...extra },
    undefined, undefined, parentCtx,
  );

const agentIdOf = (result: any): string => /Agent ID: (\S+)/.exec(result.content[0].text)![1];

const turnEnd = (b: BootedPi, stopReason = "toolUse") =>
  b.lifecycle.get("turn_end")?.({ type: "turn_end", message: { role: "assistant", stopReason } });

const sentContents = (b: BootedPi): string[] => b.pi.sendMessage.mock.calls.map((c: any[]) => c[0].content);

describe("completion delivery to a running parent", () => {
  it("holds a completion until the parent's turn ends, then steers it in", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    await spawn(b, b.parentCtx, "alpha");

    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();

    turnEnd(b);
    expect(b.pi.sendMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ content: expect.stringContaining("alpha done") }),
      { deliverAs: "steer", triggerTurn: true },
    );
  });

  it("sends a completion that landed after the run's last turn once the run ends", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    await spawn(b, b.parentCtx, "alpha");
    turnEnd(b, "stop"); // the run's final turn: nothing pending yet

    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);
    b.lifecycle.get("agent_end")({ type: "agent_end", messages: [] });
    await vi.advanceTimersByTimeAsync(200);

    expect(sentContents(b)).toEqual([expect.stringContaining("alpha done")]);
  });

  it("sends a completion that landed while the ending run was still open, once the run settles", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    await spawn(b, b.parentCtx, "alpha");
    turnEnd(b, "stop");
    b.lifecycle.get("agent_end")({ type: "agent_end", messages: [] });

    runs.settle("alpha"); // lands while a later agent_end listener still holds the run open
    await vi.advanceTimersByTimeAsync(0);
    b.parent.running = false;
    b.lifecycle.get("agent_settled")?.({ type: "agent_settled", aborted: false });
    await vi.advanceTimersByTimeAsync(200);

    expect(sentContents(b)).toEqual([expect.stringContaining("alpha done")]);
  });

  it("drops what is still pending when the session shuts down", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    b.parent.running = false;
    await spawn(b, b.parentCtx, "alpha");
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);

    await b.lifecycle.get("session_shutdown")();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(b.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("delivers an aborted turn's completion once the run ends, starting a turn, as Claude Code does after Esc", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    await spawn(b, b.parentCtx, "alpha");
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);

    turnEnd(b, "aborted");
    // Sent now, it would land in the queue pi clears on Esc.
    expect(b.pi.sendMessage).not.toHaveBeenCalled();

    b.parent.running = false;
    b.lifecycle.get("agent_end")({ type: "agent_end", messages: [] });
    await vi.advanceTimersByTimeAsync(200);
    expect(b.pi.sendMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ content: expect.stringContaining("alpha done") }),
      { deliverAs: "steer", triggerTurn: true },
    );
  });
  it("drops a completion whose result another extension consumed over RPC before the boundary", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    const id = agentIdOf(await spawn(b, b.parentCtx, "alpha"));
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);

    const [, consume] = b.pi.events.on.mock.calls.find(([channel]: any[]) => channel === "subagents:rpc:consume");
    await consume({ requestId: "r1", agentId: id });
    turnEnd(b);

    expect(b.pi.events.emit).toHaveBeenCalledWith("subagents:rpc:consume:reply:r1", expect.objectContaining({ success: true }));
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
  });
});

describe("a completion pending while its agent is resumed", () => {
  const resume = (b: BootedPi, parentCtx: any, id: string, prompt: string, background: boolean) =>
    b.tools.get("Agent").execute(
      `call-${prompt}`,
      { prompt, description: prompt, subagent_type: "general-purpose", resume: id, run_in_background: background },
      undefined, undefined, parentCtx,
    );

  it("still reports the first run when a background resume starts before the boundary", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    const id = agentIdOf(await spawn(b, b.parentCtx, "alpha"));
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);

    await resume(b, b.parentCtx, id, "again", true);
    turnEnd(b);
    expect(sentContents(b)).toEqual([expect.stringContaining("alpha done")]);

    runs.settle("again");
    await vi.advanceTimersByTimeAsync(0);
    turnEnd(b);
    expect(sentContents(b)).toEqual([expect.stringContaining("alpha done"), expect.stringContaining("again done")]);
  });

  it("still reports the first run, not the inline result, when a foreground resume runs before the boundary", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    const id = agentIdOf(await spawn(b, b.parentCtx, "alpha"));
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);

    const inline = resume(b, b.parentCtx, id, "again", false);
    await vi.advanceTimersByTimeAsync(0);
    runs.settle("again");
    await inline;
    turnEnd(b);

    const sent = sentContents(b);
    expect(sent).toEqual([expect.stringContaining("alpha done")]);
    expect(sent[0]).not.toContain("again done");
  });

  it("does not report a run whose result was read before a background resume", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    const id = agentIdOf(await spawn(b, b.parentCtx, "alpha"));
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);

    await b.tools.get("get_subagent_result").execute("read", { agent_id: id }, undefined, undefined, b.parentCtx);
    await resume(b, b.parentCtx, id, "again", true);
    turnEnd(b);

    expect(b.pi.sendMessage).not.toHaveBeenCalled();
  });
});

describe("`group` join mode — one notification per turn's batch", () => {
  /** A worktree copy that takes `ms`, or fails after it. */
  function worktreeAfter(ms: number, ok = true) {
    vi.mocked(createWorktree).mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, ms));
      return ok ? { path: "/tmp/wt", branch: "b", baseSha: "s", workPath: "/tmp/wt" } as any : undefined;
    });
  }

  it("groups a turn's worktree spawns whose copies finish far apart", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({ defaultJoinMode: "group" });
    worktreeAfter(0);
    worktreeAfter(500);

    const calls = Promise.all([
      spawn(b, b.parentCtx, "fast-copy", { isolation: "worktree" }),
      spawn(b, b.parentCtx, "slow-copy", { isolation: "worktree" }),
    ]);
    await vi.advanceTimersByTimeAsync(500);
    await calls;
    turnEnd(b);

    runs.settle("fast-copy");
    runs.settle("slow-copy");
    await vi.advanceTimersByTimeAsync(1_000);
    turnEnd(b);

    expect(sentContents(b)).toEqual([expect.stringContaining("Background agent group completed: 2 agent(s) finished")]);
  });

  it("delivers a batch that finished before its turn ended, once, at that turn's end", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({ defaultJoinMode: "group" });
    await Promise.all([spawn(b, b.parentCtx, "one"), spawn(b, b.parentCtx, "two")]);
    runs.settle("one");
    runs.settle("two");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();

    turnEnd(b);

    // The group alone — not each member again beside it.
    expect(sentContents(b)).toEqual([expect.stringMatching(/^Background agent group completed: 2 agent\(s\) finished/)]);
  });

  it("leaves out a member whose result was consumed before the group was sent", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({ defaultJoinMode: "group" });
    const [first] = await Promise.all([spawn(b, b.parentCtx, "read-early"), spawn(b, b.parentCtx, "unread")]);
    turnEnd(b);
    runs.settle("read-early");
    runs.settle("unread");
    await vi.advanceTimersByTimeAsync(0);

    await b.tools.get("get_subagent_result").execute(
      "read", { agent_id: agentIdOf(first) }, undefined, undefined, b.parentCtx,
    );
    turnEnd(b);

    const [content] = sentContents(b);
    expect(content).toContain("unread done");
    expect(content).not.toContain("read-early done");
  });

  it("reports a turn's lone spawn as a single completion, not a group of one", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({ defaultJoinMode: "group" });
    await spawn(b, b.parentCtx, "solo");
    turnEnd(b);

    runs.settle("solo");
    await vi.advanceTimersByTimeAsync(1_000);
    turnEnd(b);

    expect(sentContents(b)).toEqual([expect.not.stringMatching(/^Background agent group completed/)]);
    expect(sentContents(b)[0]).toContain("solo done");
  });

  it("reports a lone spawn that finished before its turn ended as a single completion", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({ defaultJoinMode: "group" });
    await spawn(b, b.parentCtx, "solo");
    runs.settle("solo");
    await vi.advanceTimersByTimeAsync(1_000);

    turnEnd(b);

    expect(sentContents(b)).toEqual([expect.not.stringMatching(/^Background agent group completed/)]);
    expect(sentContents(b)[0]).toContain("solo done");
  });

  it("delivers a spawn made outside a parent turn, which has no turn end to wait for", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({ defaultJoinMode: "group" });
    b.parent.running = false; // e.g. an `@handle` mention's off-screen spawn
    await spawn(b, b.parentCtx, "mentioned");

    runs.settle("mentioned");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sentContents(b)).toEqual([expect.stringContaining("mentioned done")]);
  });

  it("does not hold a sibling for a spawn whose worktree failed late", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({ defaultJoinMode: "group" });
    worktreeAfter(500, false);

    const calls = Promise.allSettled([
      spawn(b, b.parentCtx, "doomed", { isolation: "worktree" }),
      spawn(b, b.parentCtx, "sibling"),
    ]);
    await vi.advanceTimersByTimeAsync(500);
    const [doomed] = await calls;
    expect(doomed.status).toBe("rejected");
    turnEnd(b);

    runs.settle("sibling");
    await vi.advanceTimersByTimeAsync(1_000);
    turnEnd(b);

    expect(sentContents(b)).toEqual([expect.stringContaining("sibling done")]);
  });
});

describe("settling with owned agents still running", () => {
  const notices = (parentCtx: any): any[][] => parentCtx.ui.notify.mock.calls;
  const settled = (b: BootedPi) => b.lifecycle.get("agent_settled")?.({ type: "agent_settled", aborted: false });
  /** The parent's run ends: its last turn ends, then nothing is in flight. */
  const runEnds = (b: Awaited<ReturnType<typeof boot>>) => {
    turnEnd(b, "stop");
    b.parent.running = false;
  };

  /** A minimal real event bus, so a spawn goes through the actual `subagents:rpc:spawn` handler. */
  function eventBus() {
    const handlers = new Map<string, Array<(data: unknown) => void>>();
    return {
      on: (event: string, handler: (data: unknown) => void) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        return () => {};
      },
      emit: (event: string, data: unknown) => { for (const h of handlers.get(event) ?? []) h(data); },
    };
  }

  /** Spawn over RPC without `isBackground`, as another extension may: running, but its settle notifies nobody. */
  async function rpcSpawn(bus: ReturnType<typeof eventBus>, prompt: string): Promise<string> {
    const reply = new Promise<any>((resolve) => bus.on(`subagents:rpc:spawn:reply:${prompt}`, resolve));
    bus.emit("subagents:rpc:spawn", { requestId: prompt, type: "general-purpose", prompt, options: { description: prompt } });
    return (await reply).data.id;
  }

  it.each(["async", "group", "smart"])(
    "counts background agents under `%s` join as armed, and their completion notice does start a parent turn",
    async (defaultJoinMode) => {
      vi.useFakeTimers();
      const runs = controllableRuns();
      const b = await boot({ defaultJoinMode });
      // Spawned inside the parent's turn: `group` defers them to `turnGroupSpawns` until it ends.
      await Promise.all([spawn(b, b.parentCtx, "alpha"), spawn(b, b.parentCtx, "beta")]);
      runEnds(b);
      b.parentCtx.ui.notify.mockClear();

      settled(b);
      expect(notices(b.parentCtx)).toEqual([
        ["Run ended with 2 agents running or queued, armed: 2 agent completion notices wake the parent", "info"],
      ]);

      runs.settle("alpha");
      runs.settle("beta");
      await vi.advanceTimersByTimeAsync(60_000);
      const calls = b.pi.sendMessage.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      for (const [, options] of calls) expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
      expect(sentContents(b).join("\n")).toMatch(/alpha done[\s\S]*beta done|beta done[\s\S]*alpha done/);

      b.parentCtx.ui.notify.mockClear();
      settled(b);
      expect(notices(b.parentCtx)).toEqual([]);
    },
  );

  it("says agent and notice in the singular", async () => {
    vi.useFakeTimers();
    controllableRuns();
    const b = await boot();
    await spawn(b, b.parentCtx, "alpha");
    runEnds(b);
    b.parentCtx.ui.notify.mockClear();
    settled(b);
    expect(notices(b.parentCtx)).toEqual([
      ["Run ended with 1 agent running or queued, armed: 1 agent completion notice wakes the parent", "info"],
    ]);
  });

  it("counts an `@handle` mention's agent as armed: it starts in the background", async () => {
    vi.useFakeTimers();
    controllableRuns();
    const b = await boot({ agentMentions: "direct" });
    b.parent.running = false;
    const handled = await b.lifecycle.get("input")({ type: "input", text: "@general-purpose look around", source: "interactive" }, b.parentCtx);
    expect(handled).toEqual({ action: "handled" });
    expect(notices(b.parentCtx)).toContainEqual(["Started @general-purpose", "info"]);
    b.parentCtx.ui.notify.mockClear();
    settled(b);
    expect(notices(b.parentCtx)).toEqual([
      ["Run ended with 1 agent running or queued, armed: 1 agent completion notice wakes the parent", "info"],
    ]);
  });

  it("names an RPC spawn without `isBackground` as not armed, beside an armed background agent", async () => {
    vi.useFakeTimers();
    controllableRuns();
    const bus = eventBus();
    const b = await boot({}, bus);
    await spawn(b, b.parentCtx, "alpha");
    const id = await rpcSpawn(bus, "gamma");
    expect((globalThis as any)[MANAGER_KEY].getRecord(id)).toMatchObject({ status: "running", isBackground: undefined });
    runEnds(b);
    b.parentCtx.ui.notify.mockClear();
    settled(b);
    expect(notices(b.parentCtx)).toEqual([
      ["Run ended with 2 agents running or queued, armed: 1 agent completion notice wakes the parent; 1 foreground or RPC-spawned agent will not", "info"],
    ]);
  });

  it("warns when no agent completion notice is armed, for an in-flight foreground agent", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    // A foreground `Agent` call blocks its tool call until the run settles.
    const call = b.tools.get("Agent").execute(
      "call-fg",
      { prompt: "fg", description: "fg", subagent_type: "general-purpose", run_in_background: false },
      undefined, undefined, b.parentCtx,
    );
    await vi.advanceTimersByTimeAsync(0);
    const started = b.pi.events.emit.mock.calls.find(([event]: [string]) => event === "subagents:started");
    const record = (globalThis as any)[MANAGER_KEY].getRecord(started[1].id);
    expect(record).toMatchObject({ status: "running", blocking: true });
    expect(record.isBackground).toBeFalsy();
    b.parentCtx.ui.notify.mockClear();
    settled(b);
    expect(notices(b.parentCtx)).toEqual([
      ["Run ended with 1 agent running or queued, armed: no agent completion notice wakes the parent; 1 foreground or RPC-spawned agent will not", "warning"],
    ]);
    runs.settle("fg");
    await call;
  });

  it("stays silent when no owned agent is pending", async () => {
    vi.useFakeTimers();
    controllableRuns();
    const b = await boot();
    b.parentCtx.ui.notify.mockClear();
    settled(b);
    expect(notices(b.parentCtx)).toEqual([]);
  });
});
