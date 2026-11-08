/**
 * #145: a child shares its parent's model runtime, and a virtual model used to route
 * through a closure over the PARENT's extension runner. Invalidating that runner
 * (what core does on reload and session replacement) killed a running background
 * child with a stale-ctx error and "No output". Refs #581: core now routes with the
 * requesting session's context, so a parent reload no longer interrupts a child.
 * Retry still bounds any other stale-ctx route failure, injected via `routeBroken`.
 */
import { join } from "node:path";
import { type AgentSession, type ExtensionFactory, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-coding-agent/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resumeAgent, retryStaleCtx, staleCtxOutcome } from "../src/agent-runner.js";
import * as worktrees from "../src/worktree.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { answer, barrier, calls, ScenarioSession, spawn } from "./helpers/scenario-session.js";

let fixture: ScenarioSession;
afterEach(async () => {
  routeBroken.on = false;
  await fixture?.dispose();
  Reflect.deleteProperty(globalThis, Symbol.for("pi-subagents:manager"));
});

/** Flip to make routing die with the stale-ctx error without touching the real runner. */
const routeBroken = { on: false };

/** A real virtual model whose route reads the requesting session's ctx; injected stale failures still exercise recovery. */
function routedModel(getModel: () => unknown): ExtensionFactory {
  return pi => {
    pi.registerVirtualModel({
      provider: "vroute",
      id: "default",
      name: "vroute default",
      route: async (_request, ctx) => {
        void ctx.session?.sessionManager;
        if (routeBroken.on) throw new Error("This extension ctx is stale after session replacement or reload. Do not use a captured pi.");
        return { model: getModel() as never };
      },
    });
  };
}

/** The default backoff schedule: the extension clock must be asked for exactly these sleeps, in order. */
const BACKOFF_DELAYS_MS = [1_000, 3_000, 9_000];

/**
 * Let a recovering child finish without waiting out its backoff: whenever the fixture clock has been asked for
 * the next scheduled backoff delay (1s, 3s, 9s), advance it by exactly that delay, so fake time never moves
 * past other timers or when no sleep is armed. Returns how many sleeps were advanced; a run that timed its
 * backoff on native timers never asks the clock, so the caller's count assertion fails. `since` is how many
 * one-shot timers the clock had scheduled before the recovery under test began.
 */
async function settleThroughBackoff(record: { promise?: Promise<unknown> }, since: number) {
  let settled = false;
  let advances = 0;
  let cursor = since;
  const finished = Promise.resolve(record.promise).then(() => { settled = true; }, () => { settled = true; });
  while (!settled) {
    const next = BACKOFF_DELAYS_MS[advances];
    const armed = next === undefined ? -1 : fixture.clock.timeoutDelays.indexOf(next, cursor);
    if (next !== undefined && armed >= 0) {
      cursor = armed + 1;
      advances++;
      fixture.clock.advance(next);
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  await finished;
  await record.promise;
  return advances;
}

/** Re-prompts after the task prompt: each one followed exactly one backoff sleep. */
function retries(record: { session?: { messages: { role: string }[] } }) {
  return (record.session?.messages.filter(m => m.role === "user").length ?? 0) - 1;
}

/** Spawn a background child that runs one held tool, so its next model step happens after we act. */
async function startHeldChild(responses: ReturnType<typeof answer>[], virtual = true, earlierProse = false) {
  fixture = new ScenarioSession();
  const hold = fixture.heldTool();
  // Count real executions of the side-effecting tool in the disk-loaded child.
  const original = Reflect.get(globalThis, "__subagentScenarioHold") as () => Promise<unknown>;
  let executions = 0;
  Reflect.set(globalThis, "__subagentScenarioHold", async () => { executions++; return original(); });
  const first = earlierProse
    ? fauxAssistantMessage([{ type: "text", text: "EARLIER PROGRESS" }, fauxToolCall("hold", {})], { stopReason: "toolUse" })
    : calls({ name: "hold", args: {} });
  const physical = fixture.physical("fauxphys", "physical", [first, ...responses]);
  // A persisted session: only then does a reload detach (not abort) running children.
  const sessionManager = SessionManager.create(fixture.cwd, join(fixture.root, "sessions"));
  const h = await fixture.start({ factories: [routedModel(() => physical.getModel())], harness: { sessionManager } });
  h.setResponses([calls(spawn("probe child", { model: virtual ? "vroute/default" : "fauxphys/physical" })), answer("SPAWNED")]);
  await h.session.prompt("go");
  await hold.entered;
  const id = h.session.messages.filter(m => m.role === "toolResult" && m.toolName === "Agent").flatMap(m => m.content).find(p => p.type === "text")?.text.match(/Agent ID: (\S+)/)?.[1];
  if (!id) throw new Error("Missing spawn id");
  return { h, timersBefore: fixture.clock.timeoutDelays.length, hold, physical, record: fixture.record(id), executions: () => executions };
}

it("#581: routes during the parent's invalidated reload gap without retrying", { timeout: 30_000 }, async () => {
  const { h, hold, record, executions } = await startHeldChild([answer("CHILD DONE")]);
  // Stop core's reload after `oldRunner.invalidate()` but before the new runner binds.
  const entered = barrier();
  const gate = barrier();
  const settings = h.session.settingsManager;
  const reloadSettings = settings.reload.bind(settings);
  settings.reload = async () => { entered.resolve(); await gate.promise; return reloadSettings(); };
  const reloading = h.session.reload();
  try {
    await entered.promise;
    hold.release();
    await record.promise;
  } finally {
    gate.resolve();
    await reloading;
    // Core's reload resets global transports; restore the faux provider.
    fixture.restoreProviders(h);
  }
  expect(record.error).toBeUndefined();
  expect(record.status).toBe("completed");
  expect(record.result).toBe("CHILD DONE");
  // No stale error, no recovery prompt, no replay of the side-effecting tool batch.
  expect(executions()).toBe(1);
  expect(record.session?.messages.filter(m => m.role === "toolResult")).toHaveLength(1);
  expect(record.session?.messages.filter(m => m.role === "user")).toHaveLength(1);
});

it("retries a stale-ctx route failure once routing recovers, without replaying the tool batch", { timeout: 30_000 }, async () => {
  const { hold, record, executions, timersBefore } = await startHeldChild([answer("CHILD DONE")]);
  routeBroken.on = true;
  hold.release();
  await untilBackoff(record);
  routeBroken.on = false;
  const advances = await settleThroughBackoff(record, timersBefore);
  expect(advances).toBe(1);
  expect(retries(record)).toBe(advances);
  expect(record.error).toBeUndefined();
  expect(record.status).toBe("completed");
  expect(record.result).toBe("CHILD DONE");
  // Recovery re-prompts the model; it must never replay the tool batch.
  expect(executions()).toBe(1);
  expect(record.session?.messages.filter(m => m.role === "toolResult")).toHaveLength(1);
  // One original task prompt plus one continue prompt: the task is not re-sent.
  expect(record.session?.messages.filter(m => m.role === "user")).toHaveLength(2);
});

it("reports later tool activity after earlier prose when a real child fails", { timeout: 30_000 }, async () => {
  const { hold, record, timersBefore } = await startHeldChild([], true, true);
  routeBroken.on = true;
  hold.release();
  const advances = await settleThroughBackoff(record, timersBefore);
  expect(advances).toBe(BACKOFF_DELAYS_MS.length);
  expect(retries(record)).toBe(advances);
  expect(record.status).toBe("error");
  expect(record.error).toContain("This extension ctx is stale");
  expect(record.result).toContain("Earlier progress:");
  expect(record.result).toContain("EARLIER PROGRESS");
  expect(record.result).toContain("Latest activity:");
  expect(record.result).toContain("other tool");
  expect(record.result).not.toContain("SLEPT");
  const messages = record.session?.messages ?? [];
  const proseIndex = messages.findIndex(m => m.role === "assistant" && m.content.some(part => part.type === "text" && part.text === "EARLIER PROGRESS"));
  const toolIndex = messages.findIndex(m => m.role === "toolResult" && m.toolName === "hold");
  expect(proseIndex).toBeGreaterThanOrEqual(0);
  expect(toolIndex).toBeGreaterThan(proseIndex);
});

it("a detached child outlives a reload: usage observers closed over the old pi cannot fail its turn", { timeout: 30_000 }, async () => {
  // No virtual model, so routing cannot be the cause: the stale `pi` in the
  // manager's usage callback (`subagents:usage`) used to kill the child's next turn.
  const { h, hold, record } = await startHeldChild([answer("CHILD DONE")], false);
  await h.session.reload();
  fixture.restoreProviders(h);
  hold.release();
  await record.promise;
  expect(record.error).toBeUndefined();
  expect(record.status).toBe("completed");
  expect(record.result).toBe("CHILD DONE");
});

/** A session whose every step died on the stale-ctx error, with one tool call behind it. */
function deadSession(prompt: () => Promise<void>) {
  const stale = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession().";
  return {
    prompt,
    messages: [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "1", name: "bash", arguments: {} }] },
      { role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: "pushed branch redd/x" }] },
      { role: "assistant", stopReason: "error", errorMessage: stale, content: [{ type: "text", text: "" }] },
    ],
  } as unknown as AgentSession;
}

it("retries a bounded number of times, then reports an interruption with the last tool output", async () => {
  const prompts = vi.fn(async () => {});
  const session = deadSession(prompts);
  await retryStaleCtx(session, 0, undefined, [0, 0, 0]);
  expect(prompts).toHaveBeenCalledTimes(3);
  const outcome = staleCtxOutcome(session, 0);
  expect(outcome?.failure).toMatch(/interrupted by a session reload/);
  expect(outcome?.partial).toContain("Latest activity: bash (completed)");
  expect(outcome?.partial).not.toContain("pushed branch redd/x");
});

it("does not retry when the final step failed for another reason", async () => {
  const prompts = vi.fn(async () => {});
  const session = deadSession(prompts);
  (session.messages.at(-1) as { errorMessage: string }).errorMessage = "overloaded";
  await retryStaleCtx(session, 0, undefined, [0]);
  expect(prompts).not.toHaveBeenCalled();
  expect(staleCtxOutcome(session, 0)).toBeUndefined();
});

/** Wait until the child's last step is the stale-ctx error, i.e. recovery is in its first backoff. */
async function untilBackoff(record: { session?: { messages: { role: string }[] } }) {
  await vi.waitFor(() => expect(record.session?.messages.at(-1)).toMatchObject({ stopReason: "error" }), { timeout: 10_000 });
}

it("stopping an agent during backoff sends no further prompt", { timeout: 30_000 }, async () => {
  const { hold, record } = await startHeldChild([answer("NEVER SENT")]);
  routeBroken.on = true;
  hold.release();
  await untilBackoff(record);
  const users = record.session?.messages.filter(m => m.role === "user").length;
  const started = Date.now();
  record.abortController?.abort();
  await record.promise;
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(record.session?.messages.filter(m => m.role === "user")).toHaveLength(users ?? -1);
});

it("quit while recovery waits aborts the agent and sends no further prompt", { timeout: 30_000 }, async () => {
  const { h, hold, record } = await startHeldChild([answer("NEVER SENT")]);
  routeBroken.on = true;
  hold.release();
  await untilBackoff(record);
  const users = record.session?.messages.filter(m => m.role === "user").length;
  const started = Date.now();
  await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  await record.promise;
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(record.session?.messages.filter(m => m.role === "user")).toHaveLength(users ?? -1);
});

describe("backoff timing and timers", () => {
  afterEach(() => vi.useRealTimers());

  it("waits 1s, 3s, then 9s between re-prompts by default", async () => {
    vi.useFakeTimers();
    const prompts = vi.fn(async () => {});
    const done = retryStaleCtx(deadSession(prompts), 0, undefined);
    await vi.advanceTimersByTimeAsync(999);
    expect(prompts).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(prompts).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(prompts).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(prompts).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(8_999);
    expect(prompts).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(prompts).toHaveBeenCalledTimes(3);
    await done;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times the backoff on the injected clock, not native timers", async () => {
    const clock = new FakeClock();
    const reprompted: (() => void)[] = [];
    const prompts = vi.fn(async () => { reprompted.shift()?.(); });
    const controller = new AbortController();
    const firstPrompt = new Promise<void>(resolve => reprompted.push(resolve));
    const done = retryStaleCtx(deadSession(prompts), 0, controller.signal, [1_000, 3_000], clock);
    clock.advance(999);
    expect(prompts).not.toHaveBeenCalled();
    clock.advance(1);
    // The re-prompt lands within microtasks of the advance; a native timer would lose to the next macrotask.
    await Promise.race([firstPrompt, new Promise(resolve => setImmediate(resolve))]);
    expect(prompts).toHaveBeenCalledTimes(1);
    // Whether or not the second wait is armed yet, an abort leaves nothing pending on the clock.
    controller.abort();
    await done;
    expect(clock.pending).toBe(0);
    expect(prompts).toHaveBeenCalledTimes(1);
  });

  it("leaves no shutdown deadline when a real child's teardown overlaps the final re-prompt", async () => {
    const { h, hold, record } = await startHeldChild([answer("CHILD DONE")]);
    hold.release();
    await record.promise;

    // Git pruning is intentionally detached on quit. Its live child-process
    // timeout is unrelated to the shutdown race this test measures.
    const prune = vi.spyOn(worktrees, "pruneWorktrees").mockResolvedValue();
    try {
      vi.useFakeTimers();
      const prompts = vi.fn(async () => {
        // Deliberately pin teardown to the final re-prompt: an earlier 3s
        // shutdown deadline would expire during the 13s backoff and hide the leak.
        if (prompts.mock.calls.length === 3) await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      });
      const done = retryStaleCtx(deadSession(prompts), 0, undefined);
      await vi.advanceTimersByTimeAsync(13_000);
      await done;

      expect(prompts).toHaveBeenCalledTimes(3);
      expect(record.session?.messages.at(-1)).toMatchObject({ stopReason: "stop" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      prune.mockRestore();
    }
  });

  it("an abort mid-backoff ends the wait, sends nothing and leaks no timer", async () => {
    vi.useFakeTimers();
    const prompts = vi.fn(async () => {});
    const controller = new AbortController();
    const done = retryStaleCtx(deadSession(prompts), 0, controller.signal);
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await done;
    expect(prompts).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an already-aborted signal never waits or prompts", async () => {
    vi.useFakeTimers();
    const prompts = vi.fn(async () => {});
    const controller = new AbortController();
    controller.abort();
    await retryStaleCtx(deadSession(prompts), 0, controller.signal);
    expect(prompts).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("re-prompts with a continue message, never an earlier user prompt", async () => {
  const prompts = vi.fn(async (_text: string) => {});
  const session = deadSession(prompts);
  await retryStaleCtx(session, 0, undefined, [0]);
  const sent = prompts.mock.calls[0]?.[0] ?? "";
  expect(sent).toMatch(/Continue the task/);
  for (const m of session.messages) {
    if (m.role === "user") expect(sent).not.toBe((m.content as { text: string }[])[0].text);
  }
});

describe("resumeAgent", () => {
  afterEach(() => vi.useRealTimers());

  /** A resumed session whose first step dies stale, then (optionally) recovers on the retry. */
  function resumed(recovers: boolean) {
    const messages: unknown[] = [{ role: "user", content: [{ type: "text", text: "earlier" }] }];
    const stale = "This extension ctx is stale after session replacement or reload. Do not use a captured pi.";
    let calls = 0;
    const prompt = vi.fn(async () => {
      calls++;
      messages.push({ role: "user", content: [{ type: "text", text: "p" }] });
      if (calls === 1 || !recovers) messages.push({ role: "assistant", stopReason: "error", errorMessage: stale, content: [] });
      else messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "RESUMED OK" }] });
    });
    const session = { messages, prompt, subscribe: () => () => {}, abort: async () => {} } as unknown as AgentSession;
    return { session, prompt };
  }

  it("keeps streamed partial text when it is absent from the final messages", async () => {
    const listeners: ((event: unknown) => void)[] = [];
    const messages: unknown[] = [];
    const session = {
      messages,
      subscribe: (listener: (event: unknown) => void) => { listeners.push(listener); return () => {}; },
      prompt: async () => {
        messages.push({ role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "older saved prose" }] });
        for (const listener of listeners) listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial stream" } });
        for (const listener of listeners) listener({ type: "message_start", message: { role: "assistant" } });
        messages.push({ role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: "secret output" }] });
        for (const listener of listeners) listener({ type: "tool_execution_end" });
        for (const listener of listeners) listener({ type: "message_start", message: { role: "assistant" } });
        messages.push({ role: "assistant", stopReason: "error", errorMessage: "This extension ctx is stale after session replacement or reload", content: [] });
      },
      abort: async () => {},
    } as unknown as AgentSession;
    const result = await resumeAgent(session, "go", { type: "general-purpose", staleRetryDelaysMs: [] });
    expect(result.text).toBe("Earlier progress:\npartial stream\n\nLatest activity: bash (completed).");
    expect(result.failure).toContain("This extension ctx is stale");
  });

  it("does not confuse identical streamed prose with earlier saved prose", async () => {
    const listeners: ((event: unknown) => void)[] = [];
    const messages: unknown[] = [];
    const session = {
      messages,
      subscribe: (listener: (event: unknown) => void) => { listeners.push(listener); return () => {}; },
      prompt: async () => {
        messages.push({ role: "assistant", content: [{ type: "text", text: "Checking" }] });
        messages.push({ role: "toolResult", toolName: "bash", isError: false, content: [] });
        for (const listener of listeners) listener({ type: "message_start", message: { role: "assistant" } });
        for (const listener of listeners) listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Checking" } });
        messages.push({ role: "assistant", stopReason: "error", errorMessage: "This extension ctx is stale after session replacement or reload", content: [] });
      },
      abort: async () => {},
    } as unknown as AgentSession;
    const result = await resumeAgent(session, "go", { type: "general-purpose", staleRetryDelaysMs: [] });
    expect(result.text).toBe("Checking");
  });

  it("recovers a resumed run that died on a stale ctx", async () => {
    vi.useFakeTimers();
    const { session, prompt } = resumed(true);
    const run = resumeAgent(session, "go on", { type: "general-purpose" });
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await run;
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("RESUMED OK");
    expect(result.failure).toBeUndefined();
  });

  it("times a resumed run's backoff on the clock it is given", async () => {
    const { session, prompt } = resumed(true);
    const clock = new FakeClock();
    const run = resumeAgent(session, "go on", { type: "general-purpose", clock });
    // The first prompt returns within microtasks; the retry only follows the 1s sleep on that clock.
    await new Promise(resolve => setImmediate(resolve));
    expect(prompt).toHaveBeenCalledTimes(1);
    clock.advance(1_000);
    // Microtasks finish the retry; a native timer would lose to the next macrotask and leave one prompt.
    await new Promise(resolve => setImmediate(resolve));
    expect(prompt).toHaveBeenCalledTimes(2);
    expect((await run).text).toBe("RESUMED OK");
  });

  it("reports an interruption when a resumed run never recovers", async () => {
    vi.useFakeTimers();
    const { session, prompt } = resumed(false);
    const run = resumeAgent(session, "go on", { type: "general-purpose" });
    await vi.advanceTimersByTimeAsync(13_000);
    const result = await run;
    expect(prompt).toHaveBeenCalledTimes(4);
    expect(result.failure).toMatch(/interrupted by a session reload/);
  });
});

it("does not report a non-stale failure as an interruption", async () => {
  const session = deadSession(async () => {});
  (session.messages.at(-1) as { errorMessage: string }).errorMessage = "overloaded";
  expect(staleCtxOutcome(session, 0)).toBeUndefined();
});
