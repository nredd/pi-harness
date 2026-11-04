/**
 * stop_subagent and the stop-all paths, through the real extension with a held
 * runner (#443, #454). The real-host proof that a stop lands before the child's
 * next tool call is stop-subagent-scenarios; this covers who can be stopped,
 * what an unmatched id answers, and what stop-all reaches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn(), steerAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import { registerRunningDetached, unregisterRunningDetached } from "../src/detached-results.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const SESSION_FILE = "/sessions/stop-wiring.jsonl";

/** The live manager record behind an id, through the extension's public registry. */
const recordOf = (id: string) => (globalThis as any)[Symbol.for("pi-subagents:manager")].getRecord(id);

/** Runs that settle only when `finish`ed by prompt or aborted, like a real run. */
function heldRuns() {
  const runs = new Map<string, { finish: () => void }>();
  vi.mocked(runAgent).mockImplementation(
    (_ctx: any, _type: any, prompt: any, opts: any) =>
      new Promise((resolve) => {
        const settle = (aborted: boolean) => resolve({ responseText: `${prompt} done`, aborted, steered: false } as any);
        opts.signal.addEventListener("abort", () => settle(true), { once: true });
        runs.set(prompt, { finish: () => settle(false) });
      }) as any,
  );
  return runs;
}

let hermetic: Hermetic;
let booted: ReturnType<typeof makePi>;
const context = (overrides: Record<string, unknown> = {}) =>
  ctx({ sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []), getSessionFile: () => SESSION_FILE }, ...overrides });

async function boot(settings: Record<string, unknown> = {}) {
  hermetic = hermeticDir({ settings });
  booted = makePi();
  subagentsExtension(booted.pi);
  await booted.lifecycle.get("session_start")?.({ type: "session_start", reason: "startup" } as any, context());
}

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
});
afterEach(async () => {
  await booted.lifecycle.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" } as any, context());
  hermetic.restore();
});

async function spawn(prompt: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await booted.tools.get("Agent").execute(
    "tc-spawn",
    { prompt, description: `${prompt} task`, subagent_type: "general-purpose", run_in_background: true, ...extra },
    undefined,
    undefined,
    context(),
  );
  return /Agent ID: (\S+)/.exec(textOf(r))![1];
}

const stop = (agent_id: string) => booted.tools.get("stop_subagent").execute("tc-stop", { agent_id }, undefined, undefined, context());

describe("stop_subagent", () => {
  it("stops a running agent by name, marks it parent-stopped, and reports its state", async () => {
    await boot();
    heldRuns();
    const id = await spawn("alpha", { name: "auth-audit" });
    await flush();

    const result = await stop("auth-audit");

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain(`Agent ${id} stopped.`);
    expect(textOf(result)).toContain("Status: stopped | Tool uses: 0");
    expect(textOf(result)).toContain("Description: alpha task");
    expect(textOf(result)).toContain("One completion notice with its partial output follows.");
    expect(recordOf(id)).toMatchObject({ status: "stopped", stoppedBy: "parent" });
  });

  it("stops a queued agent: it never starts, and its slot goes to the next one", async () => {
    await boot({ maxConcurrent: 1 });
    const runs = heldRuns();
    await spawn("blocker");
    const queued = await spawn("queued");
    const next = await spawn("next");
    await flush();
    expect(recordOf(queued).status).toBe("queued");

    const result = await stop(queued);

    expect(textOf(result)).toContain("It was still queued, so it never started and no completion notice follows.");
    expect(recordOf(queued)).toMatchObject({ status: "stopped", stoppedBy: "parent" });
    runs.get("blocker")!.finish();
    await vi.waitFor(() => expect(runs.has("next")).toBe(true));
    expect(runs.has("queued")).toBe(false);
    expect(recordOf(next).status).toBe("running");
  });

  it("lists what is running when the id is unknown or already finished", async () => {
    await boot();
    const runs = heldRuns();
    const running = await spawn("alpha", { name: "keeper" });
    const done = await spawn("beta");
    await flush();
    runs.get("beta")!.finish();
    await vi.waitFor(() => expect(recordOf(done).status).toBe("completed"));

    const unknown = await stop("nope");
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toBe(
      `No agent or workflow "nope", so there is nothing to stop.\nRunning or queued:\n- ${running} @keeper (running): alpha task`,
    );
    const finished = await stop(done);
    expect(finished.isError).toBe(true);
    expect(textOf(finished)).toContain(`"${done}" is not running (status: completed), so there is nothing to stop.`);
    expect(textOf(finished)).toContain(`- ${running} @keeper (running): alpha task`);
    expect(recordOf(done).status).toBe("completed");
  });

  it("says nothing is running when nothing is", async () => {
    await boot();
    const result = await stop("nope");
    expect(textOf(result)).toBe(`No agent or workflow "nope", so there is nothing to stop.\nNothing is running or queued.`);
  });

  it.each([
    ["a nested child", { parentAgentId: "someone-else" }],
    ["a workflow child", { workflowId: "wf-1" }],
  ])("cannot reach %s: it belongs to its owner", async (_label, owner) => {
    await boot();
    heldRuns();
    const id = await spawn("owned");
    await flush();
    const record = recordOf(id);
    Object.assign(record, owner);

    const result = await stop(id);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`No agent or workflow "${id}", so there is nothing to stop.`);
    expect(textOf(result)).not.toContain(`- ${id}`);
    expect(record.status).toBe("running");
  });

  it("stops a survivor of a session switch through its own manager", async () => {
    await boot();
    const record = { id: "orphan-1", handle: "explore", type: "Explore", description: "orphaned work", status: "running", toolUses: 3, startedAt: 0 } as any;
    const abort = vi.fn((by?: string) => { Object.assign(record, { status: "stopped", stoppedBy: by }); return true; });
    registerRunningDetached(SESSION_FILE, { record, abort, steer: vi.fn() });
    try {
      expect(textOf(await stop("nope"))).toContain("- orphan-1 @explore (running): orphaned work");
      const result = await stop("orphan-1");
      expect(textOf(result)).toContain("Agent orphan-1 stopped.");
      expect(textOf(result)).toContain("Tool uses: 3");
      expect(abort).toHaveBeenCalledExactlyOnceWith("parent");
      expect(record).toMatchObject({ status: "stopped", stoppedBy: "parent" });
      // Stopped but not yet settled: no longer offered as stoppable.
      expect(textOf(await stop("nope"))).toContain("Nothing is running or queued.");
    } finally {
      unregisterRunningDetached(SESSION_FILE, "orphan-1");
    }
  });
});

describe("FleetView stop-all chord", () => {
  it("stops every running agent through the extension on the second press", async () => {
    hermetic = hermeticDir();
    booted = makePi();
    subagentsExtension(booted.pi);
    const listeners: ((data: string) => unknown)[] = [];
    const notify = vi.fn();
    const ui = {
      ...context().ui,
      notify,
      getEditorText: () => "",
      onTerminalInput: (handler: (data: string) => unknown) => { listeners.push(handler); return () => {}; },
    };
    await booted.lifecycle.get("session_start")?.({ type: "session_start", reason: "startup" } as any, context({ hasUI: true, ui }));
    heldRuns();
    const id = await spawn("alpha");
    await flush();

    for (const listener of listeners) listener("\x1b[107;6u");
    expect(recordOf(id).status).toBe("running");
    for (const listener of listeners) listener("\x1b[107;6u");

    expect(notify).toHaveBeenCalledWith("Stopped 1 agent(s) and 0 workflow(s).", "info");
    expect(recordOf(id)).toMatchObject({ status: "stopped", stoppedBy: undefined });
  });
});

describe("/agents -> Stop all running", () => {
  /** Drive `/agents` through the given picks; returns every menu it was shown. */
  async function agentsMenu(picks: ((options: string[]) => string | undefined)[], confirm: boolean) {
    const menus: string[][] = [];
    const notify = vi.fn();
    const ui = {
      ...context().ui,
      notify,
      confirm: vi.fn(async () => confirm),
      select: vi.fn(async (_title: string, options: string[]) => {
        menus.push(options);
        return picks.shift()?.(options);
      }),
    };
    await booted.commands.get("agents").handler("", context({ hasUI: true, ui }));
    return { menus, notify, confirm: ui.confirm };
  }

  it("stops every running and queued agent after confirming, and leaves a scheduled job alone", async () => {
    await boot({ maxConcurrent: 1 });
    heldRuns();
    const running = await spawn("alpha");
    const queued = await spawn("beta");
    const scheduled = await booted.tools.get("Agent").execute(
      "tc-schedule",
      { prompt: "later", description: "later task", subagent_type: "general-purpose", schedule: "1h", name: "nightly" },
      undefined,
      undefined,
      context(),
    );
    expect(textOf(scheduled)).toContain("Scheduled");
    await flush();

    const { menus, notify, confirm } = await agentsMenu([options => options.find(o => o.startsWith("Stop all running ("))], true);

    expect(menus[0]).toContain("Stop all running (2)");
    expect(confirm).toHaveBeenCalledWith("Stop all running", "Stop every running or queued agent and workflow?");
    expect(notify).toHaveBeenCalledWith("Stopped 2 agent(s) and 0 workflow(s).", "info");
    for (const id of [running, queued]) expect(recordOf(id)).toMatchObject({ status: "stopped", stoppedBy: undefined });
    // The menu reopens without the entry, and the job is still scheduled.
    expect(menus[1].some(o => o.startsWith("Stop all running"))).toBe(false);
    expect(menus[1]).toContain("Scheduled jobs (1)");
  });

  it("stops nothing when the confirmation is declined", async () => {
    await boot();
    heldRuns();
    const id = await spawn("alpha");
    await flush();

    const { notify } = await agentsMenu([options => options.find(o => o.startsWith("Stop all running ("))], false);

    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("Stopped"), "info");
    expect(recordOf(id).status).toBe("running");
  });
});
