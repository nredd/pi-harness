/** Group-join delivery edges: a partial group, an all-read group, and a member whose record is gone. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunnerModule from "../src/agent-runner.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunnerModule>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { type BootedPi, ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
const GROUP_TIMEOUT_MS = 30_000;

let booted: BootedPi | undefined;
let hermetic: Hermetic | undefined;

afterEach(async () => {
  await booted?.lifecycle.get("session_shutdown")?.();
  delete (globalThis as any)[MANAGER_KEY];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
  vi.mocked(runAgent).mockReset();
  vi.useRealTimers();
});

/** Boot in group join mode with a parent that is running a turn. */
async function boot() {
  hermetic = hermeticDir({ settings: { outputTranscript: false, schedulingEnabled: false, defaultJoinMode: "group" } });
  booted = makePi();
  subagentsExtension(booted.pi);
  const signal = new AbortController().signal;
  const parentCtx = ctx();
  Object.defineProperty(parentCtx, "signal", { get: () => signal });
  await booted.lifecycle.get("session_start")({ type: "session_start" }, parentCtx);
  return { ...booted, parentCtx };
}

/** Each prompt's run settles when `settle(prompt)` is called. */
function runs() {
  const finishers = new Map<string, () => void>();
  vi.mocked(runAgent).mockImplementation((_c: any, _t: any, prompt: any) =>
    new Promise<any>(resolve => {
      finishers.set(prompt, () => resolve({ responseText: `${prompt} result`, session: { dispose: vi.fn(), messages: [] }, aborted: false, steered: false }));
    }) as any,
  );
  return { settle: (...prompts: string[]) => { for (const p of prompts) finishers.get(p)!(); } };
}

const spawn = async (b: BootedPi, parentCtx: any, prompt: string): Promise<string> => {
  const result = await b.tools.get("Agent").execute(
    `call-${prompt}`,
    { prompt, description: prompt, subagent_type: "general-purpose", run_in_background: true },
    undefined, undefined, parentCtx,
  );
  return result.details.agentId;
};
const turnEnd = (b: BootedPi) =>
  b.lifecycle.get("turn_end")?.({ type: "turn_end", message: { role: "assistant", stopReason: "toolUse" } });
const sent = (b: BootedPi): any[] => b.pi.sendMessage.mock.calls.map((c: any[]) => c[0]);

describe("a group whose members are not all done", () => {
  it("delivers the finished member on timeout, labelled partial", async () => {
    vi.useFakeTimers();
    const r = runs();
    const b = await boot();
    await spawn(b, b.parentCtx, "fast");
    await spawn(b, b.parentCtx, "slow");
    turnEnd(b);
    r.settle("fast");
    await vi.advanceTimersByTimeAsync(GROUP_TIMEOUT_MS);
    turnEnd(b);

    const [message] = sent(b);
    expect(message.content).toContain("Background agent group completed: 1 agent(s) finished (partial — others still running)");
    expect(message.content).toContain("fast result");
  });

  it("delivers nothing when every finished member was already read", async () => {
    vi.useFakeTimers();
    const r = runs();
    const b = await boot();
    const fast = await spawn(b, b.parentCtx, "fast");
    await spawn(b, b.parentCtx, "slow");
    turnEnd(b);
    r.settle("fast");
    await vi.advanceTimersByTimeAsync(0);
    await b.tools.get("get_subagent_result").execute("read", { agent_id: fast }, undefined, undefined, b.parentCtx);
    await vi.advanceTimersByTimeAsync(GROUP_TIMEOUT_MS);
    expect(() => turnEnd(b)).not.toThrow();

    expect(sent(b)).toEqual([]);
  });
});

describe("a turn's group whose member record was already collected", () => {
  it("skips it and still delivers the survivor", async () => {
    vi.useFakeTimers();
    const r = runs();
    const b = await boot();
    const gone = await spawn(b, b.parentCtx, "gone");
    await spawn(b, b.parentCtx, "kept");
    r.settle("gone");
    await vi.advanceTimersByTimeAsync(0);
    // Read, then aged out of the manager before the turn ends.
    await b.tools.get("get_subagent_result").execute("read", { agent_id: gone }, undefined, undefined, b.parentCtx);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect((globalThis as any)[MANAGER_KEY].getRecord(gone)).toBeUndefined();

    expect(() => turnEnd(b)).not.toThrow();
    r.settle("kept");
    await vi.advanceTimersByTimeAsync(GROUP_TIMEOUT_MS);
    turnEnd(b);

    expect(sent(b)[0].content).toContain("kept result");
  });
});
