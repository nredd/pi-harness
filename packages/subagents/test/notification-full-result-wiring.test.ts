/**
 * A background completion notice carries the agent's whole result up to
 * `notificationResultChars`, through the real extension (#441): delivered
 * whole, a non-failure counts as read; clipped, it keeps head and tail and names the
 * transcript; a batch that lands together shares one budget; `0` keeps the
 * 500/300-character preview.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunnerModule from "../src/agent-runner.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunnerModule>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
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
  vi.useRealTimers();
});

/** Boot with a parent that is running a turn. */
async function boot(settings: Record<string, unknown> = {}) {
  hermetic = hermeticDir({ settings: { outputTranscript: false, schedulingEnabled: false, ...settings } });
  booted = makePi();
  subagentsExtension(booted.pi);
  const signal = new AbortController().signal;
  const parentCtx = ctx();
  Object.defineProperty(parentCtx, "signal", { get: () => signal });
  await booted.lifecycle.get("session_start")({ type: "session_start" }, parentCtx);
  return { ...booted, parentCtx };
}

/** Each prompt's run settles with `outcomes[prompt]` when `settle(prompt)` is called. */
function runs(outcomes: Record<string, { text: string; failure?: string }>) {
  const finishers = new Map<string, () => void>();
  vi.mocked(runAgent).mockImplementation((_c: any, _t: any, prompt: any) =>
    new Promise<any>(resolve => {
      finishers.set(prompt, () => resolve({
        responseText: outcomes[prompt].text, failure: outcomes[prompt].failure,
        session: { dispose: vi.fn(), messages: [] }, aborted: false, steered: false,
      }));
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

const record = (id: string): AgentRecord => (globalThis as any)[MANAGER_KEY].getRecord(id);
const sent = (b: BootedPi): any[] => b.pi.sendMessage.mock.calls.map((c: any[]) => c[0]);
/** The `<result>` of the notice for `id`, unescaped enough for these fixtures. */
function resultOf(content: string, id: string): string {
  const notice = content.slice(content.indexOf(`<task-id>${id}</task-id>`));
  return notice.slice(notice.indexOf("<result>") + 8, notice.indexOf("</result>"));
}

/** `n` chars that start with `head` and end with `tail`, so clipping shows on both ends. */
const text = (n: number, head = "HEAD", tail = "TAIL") => head + "x".repeat(n - head.length - tail.length) + tail;

describe("full result in a completion notice", () => {
  it("carries a result under the cap whole, with no truncation note, and marks it read", async () => {
    vi.useFakeTimers();
    const body = text(2_000);
    const r = runs({ alpha: { text: body } });
    const b = await boot();
    const id = await spawn(b, b.parentCtx, "alpha");
    r.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);
    expect(record(id).resultConsumed).toBeFalsy();

    turnEnd(b);

    const [message] = sent(b);
    expect(resultOf(message.content, id)).toBe(body);
    expect(message.content).not.toContain("truncated");
    // Only the model-facing content grows: the rendered box keeps its preview.
    expect(message.details.resultPreview).toBe(`${body.slice(0, 500)}…`);
    expect(record(id).resultConsumed).toBe(true);
  });

  it("keeps head and tail of a result over the cap, names its transcript, and leaves it unread", async () => {
    vi.useFakeTimers();
    const r = runs({ alpha: { text: text(5_000) } });
    const b = await boot({ notificationResultChars: 1_000, outputTranscript: true });
    const id = await spawn(b, b.parentCtx, "alpha");
    r.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);

    turnEnd(b);

    const outputFile = record(id).outputFile;
    expect(outputFile).toBeDefined();
    const result = resultOf(sent(b)[0].content, id);
    expect(result).toMatch(/^HEADx{496}\n/);
    expect(result).toMatch(/\nx{496}TAIL$/);
    expect(result).toContain(`...(truncated: 4000 of 5000 chars omitted; full result in ${outputFile}, or use get_subagent_result)...`);
    expect(record(id).resultConsumed).toBeFalsy();
  });

  it("carries a failed agent's error and partial output under the same cap, and leaves the failure unread", async () => {
    vi.useFakeTimers();
    const partial = text(3_000, "PARTIAL");
    const r = runs({ small: { text: "half done", failure: "provider exploded" }, big: { text: partial, failure: "provider exploded" } });
    const b = await boot({ notificationResultChars: 1_000 });
    const small = await spawn(b, b.parentCtx, "small");
    const big = await spawn(b, b.parentCtx, "big");
    r.settle("small", "big");
    await vi.advanceTimersByTimeAsync(0);

    turnEnd(b);

    const [message] = sent(b);
    expect(resultOf(message.content, small)).toBe("Error: provider exploded\n\nPartial output before the failure:\nhalf done");
    // Whole, but a failure: delivering it must not acknowledge it in FleetView.
    expect(record(small).resultConsumed).toBeFalsy();
    const clipped = resultOf(message.content, big);
    expect(clipped).toMatch(/^Error: provider exploded\n\nPartial output before the failure:\nPARTIAL/);
    expect(clipped).toContain("use get_subagent_result for full output");
    expect(record(big).resultConsumed).toBeFalsy();
  });

  it("splits one batch's budget fairly across agents that finish together, each naming its transcript", async () => {
    vi.useFakeTimers();
    const prompts = ["a1", "a2", "a3", "a4", "a5"];
    const r = runs({ short: { text: "short and whole" }, ...Object.fromEntries(prompts.map(p => [p, { text: text(1_000) }])) });
    // Budget 4 x 1000: the short one keeps all of it, five long ones split the rest.
    const b = await boot({ notificationResultChars: 1_000, outputTranscript: true, defaultJoinMode: "group" });
    const ids = await Promise.all(prompts.map(p => spawn(b, b.parentCtx, p)));
    const short = await spawn(b, b.parentCtx, "short");
    turnEnd(b);
    r.settle(...prompts, "short");
    await vi.advanceTimersByTimeAsync(0);

    turnEnd(b);

    const [message] = sent(b);
    expect(message.content).toMatch(/^Background agent group completed: 6 agent\(s\) finished/);
    expect(message.content).not.toContain("Use get_subagent_result for full output.");
    expect(resultOf(message.content, short)).toBe("short and whole");
    expect(record(short).resultConsumed).toBe(true);
    const share = Math.floor((4_000 - "short and whole".length) / 5);
    for (const id of ids) {
      const result = resultOf(message.content, id);
      expect(result.length - result.indexOf("TAIL") - 4).toBe(0);
      expect(result.replace(/\n\.\.\.\(truncated[^\n]*\n/, "")).toHaveLength(share);
      expect(result).toContain(`full result in ${record(id).outputFile}`);
      expect(record(id).resultConsumed).toBeFalsy();
    }
  });

  it("shares the budget across separate completions coalesced into one message", async () => {
    vi.useFakeTimers();
    const r = runs({ one: { text: text(3_000) }, two: { text: text(3_000) } });
    // Budget 4 x 1000 per batch, 1000 per agent: each long result keeps 1000.
    const b = await boot({ notificationResultChars: 1_000 });
    const one = await spawn(b, b.parentCtx, "one");
    const two = await spawn(b, b.parentCtx, "two");
    r.settle("one", "two");
    await vi.advanceTimersByTimeAsync(0);

    turnEnd(b);

    const [message] = sent(b);
    expect(message.content).toMatch(/^2 background tasks finished\./);
    for (const id of [one, two]) {
      expect(resultOf(message.content, id).replace(/\n\.\.\.\(truncated[^\n]*\n/, "")).toHaveLength(1_000);
    }
  });

  it("keeps today's 500-char preview and leaves the result unread at 0", async () => {
    vi.useFakeTimers();
    const body = text(2_000);
    const r = runs({ alpha: { text: body } });
    const b = await boot({ notificationResultChars: 0 });
    const id = await spawn(b, b.parentCtx, "alpha");
    r.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);

    turnEnd(b);

    expect(resultOf(sent(b)[0].content, id)).toBe(`${body.slice(0, 500)}\n...(truncated, use get_subagent_result for full output)`);
    expect(record(id).resultConsumed).toBeFalsy();
  });

  it("keeps today's 300-char group preview and its pointer at 0", async () => {
    vi.useFakeTimers();
    const body = text(2_000);
    const r = runs({ one: { text: body }, two: { text: "brief" } });
    const b = await boot({ notificationResultChars: 0, defaultJoinMode: "group" });
    const one = await spawn(b, b.parentCtx, "one");
    const two = await spawn(b, b.parentCtx, "two");
    turnEnd(b);
    r.settle("one", "two");
    await vi.advanceTimersByTimeAsync(0);

    turnEnd(b);

    const [message] = sent(b);
    expect(resultOf(message.content, one)).toBe(`${body.slice(0, 300)}\n...(truncated, use get_subagent_result for full output)`);
    expect(resultOf(message.content, two)).toBe("brief");
    expect(message.content).toMatch(/\n\nUse get_subagent_result for full output\.$/);
    expect(record(one).resultConsumed).toBeFalsy();
    expect(record(two).resultConsumed).toBeFalsy();
  });

  it("does not mark a result read when the notice could not be sent", async () => {
    vi.useFakeTimers();
    const r = runs({ alpha: { text: "whole" } });
    const b = await boot();
    const id = await spawn(b, b.parentCtx, "alpha");
    r.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);
    b.pi.sendMessage.mockImplementationOnce(() => { throw new Error("stale ctx"); });

    turnEnd(b);

    expect(record(id).resultConsumed).toBeFalsy();
  });
});
