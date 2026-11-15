/**
 * #145: a child shares its parent's model runtime, and a virtual model used to route
 * through a closure over the PARENT's extension runner. Invalidating that runner
 * (what core does on reload and session replacement) killed a running background
 * child with a stale-ctx error and "No output". Refs #581: core now routes with the
 * requesting session's context, so a parent reload no longer interrupts a child.
 * Other stale-ctx route failures terminate without re-prompting the same runtime (#779).
 */
import { join } from "node:path";
import { type AgentSession, type ExtensionFactory, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-coding-agent/testing";
import { deferred } from "@nredd/pi-test-lib/deferred";
import { toolCalls } from "@nredd/pi-test-lib/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resumeAgent, staleCtxOutcome } from "../src/agent-runner.js";
import { answer, ScenarioSession, spawn } from "./helpers/scenario-session.js";

let fixture: ScenarioSession;
afterEach(async () => {
  routeBroken.on = false;
  await fixture?.dispose();
  Reflect.deleteProperty(globalThis, Symbol.for("pi-subagents:manager"));
});

/** Flip to make routing die with the stale-ctx error without touching the real runner. */
const routeBroken = { on: false };

/** A real virtual model whose route reads the requesting session's ctx; injected stale failures exercise terminal reporting. */
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
    : toolCalls({ name: "hold", args: {} });
  const physical = fixture.physical("fauxphys", "physical", [first, ...responses]);
  // A persisted session: only then does a reload detach (not abort) running children.
  const sessionManager = SessionManager.create(fixture.cwd, join(fixture.root, "sessions"));
  const h = await fixture.start({ factories: [routedModel(() => physical.getModel())], harness: { sessionManager } });
  h.setResponses([toolCalls(spawn("probe child", { model: virtual ? "vroute/default" : "fauxphys/physical" })), answer("SPAWNED")]);
  await h.session.prompt("go");
  await hold.entered;
  const id = h.session.messages.filter(m => m.role === "toolResult" && m.toolName === "Agent").flatMap(m => m.content).find(p => p.type === "text")?.text.match(/Agent ID: (\S+)/)?.[1];
  if (!id) throw new Error("Missing spawn id");
  return { h, hold, record: fixture.record(id), executions: () => executions };
}

it("#581: routes during the parent's invalidated reload gap without retrying", { timeout: 30_000 }, async () => {
  const { h, hold, record, executions } = await startHeldChild([answer("CHILD DONE")]);
  // Stop core's reload after `oldRunner.invalidate()` but before the new runner binds.
  const entered = deferred();
  const gate = deferred();
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

it("reports later tool activity after earlier prose when a real child fails", { timeout: 30_000 }, async () => {
  const { hold, record } = await startHeldChild([], true, true);
  routeBroken.on = true;
  hold.release();
  await record.promise;
  expect(record.session?.messages.filter(m => m.role === "user")).toHaveLength(1);
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

describe("resumeAgent", () => {
  /** A resumed session whose first step dies stale. */
  function resumed() {
    const messages: unknown[] = [{ role: "user", content: [{ type: "text", text: "earlier" }] }];
    const stale = "This extension ctx is stale after session replacement or reload. Do not use a captured pi.";
    const prompt = vi.fn(async () => {
      messages.push({ role: "user", content: [{ type: "text", text: "p" }] });
      messages.push({ role: "assistant", stopReason: "error", errorMessage: stale, content: [] });
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
    const result = await resumeAgent(session, "go", { type: "general-purpose" });
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
    const result = await resumeAgent(session, "go", { type: "general-purpose" });
    expect(result.text).toBe("Checking");
  });

  it("reports an interruption when a resumed run never recovers", async () => {
    const { session, prompt } = resumed();
    const run = resumeAgent(session, "go on", { type: "general-purpose" });
    const result = await run;
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(result.failure).toContain("extension context became stale");
  });
});

it("does not report a non-stale failure as an interruption", async () => {
  const session = deadSession(async () => {});
  (session.messages.at(-1) as { errorMessage: string }).errorMessage = "overloaded";
  expect(staleCtxOutcome(session, 0)).toBeUndefined();
});
