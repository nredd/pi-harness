/**
 * #145: a child shares its parent's model runtime, and a virtual model routes
 * through a closure over the PARENT's extension runner. Invalidating that runner
 * (what core does on reload and session replacement) used to kill a running
 * background child with a stale-ctx error and "No output".
 */
import { join } from "node:path";
import { type AgentSession, type ExtensionFactory, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resumeAgent, retryStaleCtx, staleCtxOutcome } from "../src/agent-runner.js";
import * as worktrees from "../src/worktree.js";
import { answer, barrier, calls, ScenarioSession, spawn } from "./helpers/scenario-session.js";

let fixture: ScenarioSession;
afterEach(async () => {
  routeBroken.on = false;
  await fixture?.dispose();
  Reflect.deleteProperty(globalThis, Symbol.for("pi-subagents:manager"));
});

/** Flip to make routing die with the stale-ctx error without touching the real runner. */
const routeBroken = { on: false };

/** A real virtual model whose route reads the host ctx, which any extension may do; `subscription-router` no longer does (#294). */
function routedModel(getModel: () => unknown): ExtensionFactory {
  return pi => {
    pi.registerVirtualModel({
      provider: "vroute",
      id: "default",
      name: "vroute default",
      route: async (_request, ctx) => {
        void ctx.cwd;
        if (routeBroken.on) throw new Error("This extension ctx is stale after session replacement or reload. Do not use a captured pi.");
        return { model: getModel() as never };
      },
    });
  };
}

/** Spawn a background child that runs one held tool, so its next model step happens after we act. */
async function startHeldChild(responses: ReturnType<typeof answer>[], virtual = true) {
  fixture = new ScenarioSession();
  const hold = fixture.heldTool();
  // Count real executions of the side-effecting tool in the disk-loaded child.
  const original = Reflect.get(globalThis, "__subagentScenarioHold") as () => Promise<unknown>;
  let executions = 0;
  Reflect.set(globalThis, "__subagentScenarioHold", async () => { executions++; return original(); });
  const physical = fixture.physical("fauxphys", "physical", [calls({ name: "hold", args: {} }), ...responses]);
  // A persisted session: only then does a reload detach (not abort) running children.
  const sessionManager = SessionManager.create(fixture.cwd, join(fixture.root, "sessions"));
  const h = await fixture.start({ factories: [routedModel(() => physical.getModel())], harness: { sessionManager } });
  h.setResponses([calls(spawn("probe child", { model: virtual ? "vroute/default" : "fauxphys/physical" })), answer("SPAWNED")]);
  await h.session.prompt("go");
  await hold.entered;
  const id = h.session.messages.filter(m => m.role === "toolResult" && m.toolName === "Agent").flatMap(m => m.content).find(p => p.type === "text")?.text.match(/Agent ID: (\S+)/)?.[1];
  if (!id) throw new Error("Missing spawn id");
  return { h, hold, physical, record: fixture.record(id), executions: () => executions };
}

it("retries the step once a real reload has re-registered the parent's routes", { timeout: 30_000 }, async () => {
  const { h, hold, record, executions } = await startHeldChild([answer("CHILD DONE")]);
  // Hold core's reload between `oldRunner.invalidate()` and the rebuild, the
  // window in which the parent's routes are dead and the new ones not yet bound.
  const gate = barrier();
  const settings = h.session.settingsManager;
  const reloadSettings = settings.reload.bind(settings);
  settings.reload = async () => { await gate.promise; return reloadSettings(); };
  const reloading = h.session.reload();
  hold.release();
  await vi.waitFor(() => expect(record.session?.messages.at(-1)).toMatchObject({ stopReason: "error" }), { timeout: 10_000 });
  gate.resolve();
  await reloading;
  // Core's reload resets global transports; restore the faux provider before the retry fires.
  fixture.restoreProviders(h);
  await record.promise;
  expect(record.error).toBeUndefined();
  expect(record.status).toBe("completed");
  expect(record.result).toBe("CHILD DONE");
  // Recovery re-prompts the model; it must never replay the tool batch.
  expect(executions()).toBe(1);
  expect(record.session?.messages.filter(m => m.role === "toolResult")).toHaveLength(1);
  // One original task prompt plus one continue prompt: the task is not re-sent.
  expect(record.session?.messages.filter(m => m.role === "user")).toHaveLength(2);
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
      { role: "toolResult", content: [{ type: "text", text: "pushed branch redd/x" }] },
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
  expect(outcome?.partial).toContain("Last tool calls: bash");
  expect(outcome?.partial).toContain("pushed branch redd/x");
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
