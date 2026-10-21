/** Rebase boundary: resumes share the spawn's bounded, tool-free report observer. */
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGraceTurns, resumeAgent, setGraceTurns } from "../src/agent-runner.js";

/** A controllable session boundary; the observer and report implementation are real. */
function controlledSession() {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  let tools = ["read"];
  const fake = {
    messages: [] as AgentSession["messages"],
    agent: { beforeToolCall: undefined as AgentSession["agent"]["beforeToolCall"] },
    subscribe: vi.fn((listener: (event: AgentSessionEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    prompt: vi.fn(async (_prompt: string) => {}),
    steer: vi.fn(async (_message: string) => {}),
    abort: vi.fn(async () => {}),
    waitForIdle: vi.fn(async () => {}),
    getActiveToolNames: () => tools,
    setActiveToolsByName: (names: string[]) => { tools = [...names]; },
  };
  return {
    fake,
    session: fake as unknown as AgentSession,
    listeners,
    emit(event: unknown) {
      for (const listener of [...listeners]) listener(event as AgentSessionEvent);
    },
    message(text: string, stopReason = "stop") {
      fake.messages.push({ role: "assistant", content: [{ type: "text", text }], stopReason } as never);
    },
  };
}

describe("resumed final report after the ca93a52 rebase", () => {
  let previousGrace: number;
  beforeEach(() => { previousGrace = getGraceTurns(); setGraceTurns(1); });
  afterEach(() => setGraceTurns(previousGrace));

  it("pins tools empty despite deferred promotion, restores scope and emits physical usage/activity", async () => {
    const run = controlledSession();
    const priorHook = vi.fn();
    run.fake.agent.beforeToolCall = priorHook;
    const onTurnEnd = vi.fn();
    const onModelCall = vi.fn();
    const onTextDelta = vi.fn();
    const onAssistantUsage = vi.fn();
    const usage = { input: 2, output: 3, cacheWrite: 0, cacheRead: 4, cost: { total: 0.01 } };
    run.fake.prompt.mockImplementation(async (prompt) => {
      if (prompt === "continue") {
        run.message("teaser", "toolUse");
        run.emit({ type: "turn_end" });
        run.emit({ type: "turn_end" });
        return;
      }
      run.fake.setActiveToolsByName(["read", "search_tools"]);
      expect(run.fake.getActiveToolNames()).toEqual([]);
      expect(await run.fake.agent.beforeToolCall?.({ toolCall: { name: "read" } } as never, undefined as never))
        .toMatchObject({ block: true, terminate: true });
      run.emit({ type: "message_start", message: { role: "assistant" } });
      run.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "report" } });
      run.emit({ type: "message_end", message: { role: "assistant", provider: "physical", model: "model-b", usage } });
      run.message("report");
      run.emit({ type: "turn_end", toolResults: [] });
    });

    const result = await resumeAgent(run.session, "continue", {
      type: "general-purpose", maxTurns: 1, onTurnEnd, onModelCall, onTextDelta, onAssistantUsage,
    });

    expect(result).toMatchObject({ text: "report", steered: true, aborted: false });
    expect(onTurnEnd.mock.calls.map(([count]) => count)).toEqual([1, 2, 3]);
    expect(onModelCall.mock.calls.map(([event]) => event.type)).toEqual(["start", "delta", "end"]);
    expect(onTextDelta).toHaveBeenCalledWith("report", "report");
    expect(onAssistantUsage).toHaveBeenCalledExactlyOnceWith(
      { input: 2, output: 3, cacheWrite: 0, cacheRead: 4, cost: 0.01 },
      expect.objectContaining({ provider: "physical", model: "model-b" }),
    );
    expect(run.fake.abort).toHaveBeenCalledTimes(1);
    expect(run.fake.agent.beforeToolCall).toBe(priorHook);
    expect(run.fake.getActiveToolNames()).toEqual(["read"]);
    expect(run.listeners.size).toBe(0);
  });

  it.each(["tool", "second turn"])("hard-bounds a resumed report that attempts a %s", async (attempt) => {
    const run = controlledSession();
    run.fake.prompt.mockImplementation(async (prompt) => {
      if (prompt === "continue") {
        run.message("teaser", "toolUse");
        run.emit({ type: "turn_end" });
        run.emit({ type: "turn_end" });
        return;
      }
      if (attempt === "tool") run.emit({ type: "turn_end", toolResults: [{}] });
      else {
        run.emit({ type: "turn_end", toolResults: [] });
        expect(run.fake.abort).toHaveBeenCalledTimes(1);
        run.emit({ type: "turn_end", toolResults: [] });
      }
    });
    const result = await resumeAgent(run.session, "continue", { type: "general-purpose", maxTurns: 1 });
    expect(result.aborted).toBe(true);
    expect(run.fake.abort).toHaveBeenCalledTimes(2);
    expect(run.fake.prompt).toHaveBeenCalledTimes(2);
    expect(run.listeners.size).toBe(0);
  });

  it("never mistakes a previous invocation's answer for a successful report", async () => {
    const run = controlledSession();
    run.message("OLD ANSWER");
    run.fake.prompt.mockImplementation(async (prompt) => {
      if (prompt !== "continue") return;
      run.emit({ type: "turn_end" });
      run.emit({ type: "turn_end" });
    });
    expect(await resumeAgent(run.session, "continue", { type: "general-purpose", maxTurns: 1 }))
      .toMatchObject({ text: "", steered: true, aborted: true });
    expect(run.fake.prompt).toHaveBeenCalledTimes(2);
  });

  it("forwards abort during the report and restores hooks even when that prompt rejects", async () => {
    const run = controlledSession();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const priorHook = vi.fn();
    run.fake.agent.beforeToolCall = priorHook;
    run.fake.prompt.mockImplementation(async (prompt) => {
      if (prompt === "continue") {
        run.message("teaser", "toolUse");
        run.emit({ type: "turn_end" });
        run.emit({ type: "turn_end" });
        return;
      }
      controller.abort();
      throw new Error("cancelled report");
    });
    expect(await resumeAgent(run.session, "continue", { type: "general-purpose", maxTurns: 1, signal: controller.signal }))
      .toMatchObject({ text: "teaser", aborted: true });
    expect(run.fake.abort).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(run.listeners.size).toBe(0);
    expect(run.fake.agent.beforeToolCall).toBe(priorHook);
    run.fake.setActiveToolsByName(["bash"]);
    expect(run.fake.getActiveToolNames()).toEqual(["bash"]);
  });

  it("does not launch the report if stopped while the aborted batch drains", async () => {
    const run = controlledSession();
    const controller = new AbortController();
    run.fake.waitForIdle.mockImplementation(async () => { controller.abort(); });
    run.fake.prompt.mockImplementation(async () => {
      run.message("teaser", "toolUse");
      run.emit({ type: "turn_end" });
      run.emit({ type: "turn_end" });
    });
    expect(await resumeAgent(run.session, "continue", { type: "general-purpose", maxTurns: 1, signal: controller.signal }))
      .toMatchObject({ aborted: true, text: "teaser" });
    expect(run.fake.prompt).toHaveBeenCalledTimes(1);
    expect(run.listeners.size).toBe(0);
    expect(run.fake.getActiveToolNames()).toEqual(["read"]);
  });

  it("starts each continuation with a fresh counter and a fresh soft-limit latch", async () => {
    const run = controlledSession();
    run.fake.prompt.mockImplementation(async () => {
      run.message("finished report");
      run.emit({ type: "turn_end" });
    });
    const onTurnEnd = vi.fn();
    for (let i = 0; i < 2; i++) {
      expect(await resumeAgent(run.session, "continue", { type: "general-purpose", maxTurns: 1, onTurnEnd }))
        .toMatchObject({ aborted: false, steered: true });
    }
    expect(onTurnEnd.mock.calls.map(([count]) => count)).toEqual([1, 1]);
    expect(run.fake.steer).toHaveBeenCalledTimes(2);
    expect(run.fake.abort).not.toHaveBeenCalled();
    expect(run.listeners.size).toBe(0);
  });
});
