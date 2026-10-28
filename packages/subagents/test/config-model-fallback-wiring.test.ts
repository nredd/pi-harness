/**
 * config-model-fallback-wiring.test.ts -- a CONFIG model (`agentModels`, an agent
 * definition's `model:`) that does not resolve still runs on the parent model, but
 * every entry path must say so, from ONE place: `AgentRecord.modelFallback`, set by
 * the shared spawn path. An explicit tool-call `model` keeps its hard error, and a
 * resume reports the record's own disclosure, never one recomputed from the
 * resuming call's config.
 *
 * Entry paths covered here: Agent tool (foreground, background), the completion
 * notice and `get_subagent_result`, nested Agent, resume (both directions),
 * cross-extension RPC and a direct @mention. Scheduler fire and the workflow host
 * are in config-model-fallback-spawn.test.ts. All run the real `resolveModel` and
 * the real `selectModel`; only the session itself is stubbed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunner from "../src/agent-runner.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunner>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { setAgentModels } from "../src/model-resolver.js";
import { createNestedSubagentTools } from "../src/nested-tools.js";
import { flush, makePi, startSession, textOf } from "./helpers/boot-extension.js";
import subagentsExtension from "./helpers/home-extension.js";
import { runnerResolution } from "./helpers/runner-resolution.js";

const PARENT = { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" };
const HAIKU = { provider: "anthropic", id: "claude-haiku-5-5", name: "Claude Haiku 5.5" };
const NOTE = 'Note: configured model "claude-haiku-4-5" did not resolve; running on parent model anthropic/claude-sonnet-5-5.';

let cwd: string;
let originalCwd: string;
let originalAgentDir: string | undefined;

function writeAgent(name: string, model?: string): void {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  const modelLine = model ? `model: ${model}\n` : "";
  writeFileSync(join(dir, `${name}.md`), `---\ndescription: ${name}\ntools: read\n${modelLine}---\n${name}.\n`);
}

function ctx(models: unknown[] = [PARENT, HAIKU]) {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd,
    model: PARENT,
    modelRegistry: {
      find: (provider: string, id: string) => (models as any[]).find(m => m.provider === provider && m.id === id),
      getAll: () => models,
      getAvailable: () => models,
    },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}


describe("config model that does not resolve", () => {
  let tools: Map<string, any>;
  let pi: any;
  let lifecycle: Map<string, any>;

  beforeEach(() => {
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "config-model-fallback-"));
    process.chdir(cwd);
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
    vi.mocked(runAgent).mockReset();
    vi.mocked(resumeAgent).mockReset();
    vi.mocked(runAgent).mockImplementation(runnerResolution() as any);
    vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed", aborted: false, steered: false } as any);
  });

  afterEach(() => {
    setAgentModels(undefined);
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    process.chdir(originalCwd);
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    registerAgents(new Map());
    rmSync(cwd, { recursive: true, force: true });
  });

  async function boot() {
    const booted = makePi();
    ({ tools, pi, lifecycle } = booted);
    subagentsExtension(pi);
    await startSession(lifecycle, true);
  }

  const callAgent = (params: Record<string, unknown>, c = ctx([PARENT])) =>
    tools.get("Agent").execute("tc", { prompt: "go", description: "d", subagent_type: "scout", ...params }, undefined, undefined, c);

  it("Agent tool, foreground: agentModels entry is noted in text and details", async () => {
    writeAgent("scout");
    await boot();
    // After boot: session_start reloads agentModels from (absent) settings.
    setAgentModels({ scout: "claude-haiku-4-5" });

    const result = await callAgent({ run_in_background: false });

    expect(textOf(result)).toContain(NOTE);
    expect(result.details.modelNote).toBe(NOTE);
    // No behavior change: it still ran, on the parent model.
    expect(vi.mocked(runAgent).mock.calls[0]?.[3]).toMatchObject({ model: PARENT });
  });

  it("Agent tool, background: definition `model:` is noted at start and on get_subagent_result", async () => {
    writeAgent("scout", "claude-haiku-4-5");
    await boot();

    const started = await callAgent({ run_in_background: true });
    expect(textOf(started)).toContain(NOTE);
    expect(textOf(started)).toContain("started in background");
    expect(started.details.modelNote).toBe(NOTE);

    await flush();
    const fetched = await tools.get("get_subagent_result").execute(
      "tc2", { agent_id: started.details.agentId, wait: true }, undefined, undefined, ctx([PARENT]),
    );
    expect(textOf(fetched)).toContain(NOTE);
  });

  it("completion notice: carries the note in its details and its text", async () => {
    writeAgent("scout", "claude-haiku-4-5");
    await boot();

    const started = await callAgent({ run_in_background: true });
    await vi.waitFor(() => {
      const sent = pi.sendMessage.mock.calls.map((c: any[]) => c[0]);
      expect(sent.some((m: any) => m.details?.id === started.details.agentId)).toBe(true);
    });

    const notice = pi.sendMessage.mock.calls.map((c: any[]) => c[0]).find((m: any) => m.details?.id === started.details.agentId);
    expect(notice.details.modelNote).toBe(NOTE);
    expect(notice.content).toContain(NOTE);
  });

  it("adds no note when the config model resolves", async () => {
    writeAgent("scout", "anthropic/claude-haiku-5-5");
    await boot();

    const result = await callAgent({ run_in_background: false }, ctx());

    expect(textOf(result)).not.toContain("did not resolve");
    expect(result.details.modelNote).toBeUndefined();
  });

  it("keeps the hard error for an explicit tool-call model", async () => {
    writeAgent("scout");
    await boot();

    const result = await callAgent({ model: "claude-haiku-4-5" });

    expect(textOf(result)).not.toContain("running on parent model");
    expect(runAgent).not.toHaveBeenCalled();
  });

  describe("resume reports the record's disclosure, never a recomputed one", () => {
    const OTHER_PARENT = { provider: "openai", id: "gpt-6", name: "GPT 6" };

    it("a run that resolved is not reported as a fallback because the resuming call's config would not resolve", async () => {
      writeAgent("scout");
      await boot();
      setAgentModels({ scout: "anthropic/claude-haiku-5-5" });
      const first = await callAgent({ run_in_background: false }, ctx());
      expect(first.details.modelNote).toBeUndefined();

      // Resuming call: different parent, and the configured model is now unavailable.
      const resumed = await callAgent(
        { resume: first.details.agentId, run_in_background: false },
        { ...ctx([OTHER_PARENT]), model: OTHER_PARENT },
      );

      expect(textOf(resumed)).not.toContain("did not resolve");
      expect(resumed.details.modelNote).toBeUndefined();
    });

    it("a run that fell back keeps saying so, naming the model it really ran on", async () => {
      writeAgent("scout");
      await boot();
      setAgentModels({ scout: "claude-haiku-4-5" });
      const first = await callAgent({ run_in_background: false });
      expect(first.details.modelNote).toBe(NOTE);

      // Resuming call: a different parent, and the config would now resolve.
      setAgentModels({ scout: "openai/gpt-6" });
      const resumed = await callAgent(
        { resume: first.details.agentId, run_in_background: false },
        { ...ctx([OTHER_PARENT]), model: OTHER_PARENT },
      );

      expect(resumed.details.modelNote).toBe(NOTE);
      expect(resumed.details.modelNote).not.toContain("openai/gpt-6");
      // The text the model reads says it too, and still names the model that ran.
      expect(textOf(resumed).startsWith(NOTE)).toBe(true);
      expect(textOf(resumed)).not.toContain("openai/gpt-6");
    });

    it("the background and failed resume texts carry the record's note too", async () => {
      writeAgent("scout");
      await boot();
      setAgentModels({ scout: "claude-haiku-4-5" });
      const first = await callAgent({ run_in_background: false });
      const id = first.details.agentId;

      const background = await callAgent({ resume: id, run_in_background: true });
      expect(textOf(background).startsWith(NOTE)).toBe(true);
      expect(background.details.modelNote).toBe(NOTE);
      await flush();

      vi.mocked(resumeAgent).mockRejectedValue(new Error("boom"));
      const failed = await callAgent({ resume: id, run_in_background: false });
      expect(textOf(failed)).toContain("Agent failed");
      expect(textOf(failed).startsWith(NOTE)).toBe(true);
    });
  });

  /** Boot with a real in-process event bus, so RPC goes through the extension's own handler. */
  async function bootWithBus(models: unknown[] = [PARENT]) {
    const handlers = new Map<string, Array<(data: unknown) => void>>();
    const bus = {
      on: (event: string, handler: (data: unknown) => void) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        return () => {};
      },
      emit: (event: string, data: unknown) => { for (const h of handlers.get(event) ?? []) h(data); },
    };
    const booted = makePi();
    ({ tools, pi, lifecycle } = booted);
    pi.events = bus;
    subagentsExtension(pi);
    const sessionCtx = ctx(models);
    await startSession(lifecycle, true, { model: sessionCtx.model, modelRegistry: sessionCtx.modelRegistry });
    return bus;
  }

  /** Spawn over `subagents:rpc:spawn` and resolve with the reply id and the completion event. */
  async function rpcSpawn(bus: { on: (e: string, h: (d: any) => void) => unknown; emit: (e: string, d: unknown) => void }, options: Record<string, unknown> = {}) {
    const completed = new Promise<any>((resolve) => bus.on("subagents:completed", resolve));
    const reply = new Promise<any>((resolve) => bus.on("subagents:rpc:spawn:reply:r1", resolve));
    bus.emit("subagents:rpc:spawn", { requestId: "r1", type: "scout", prompt: "go", options: { description: "rpc", ...options } });
    const id = (await reply).data.id;
    return { id, event: await completed };
  }

  const recordOf = (id: string) => (globalThis as any)[Symbol.for("pi-subagents:manager")].getRecord(id);

  it("cross-extension RPC: the real event-bus spawn handler's agent reports the fallback on the completion event, record and get_subagent_result", async () => {
    writeAgent("scout", "claude-haiku-4-5");
    const bus = await bootWithBus();

    const { id, event } = await rpcSpawn(bus, { modelFallback: { input: "forged", used: "nowhere/none" } });

    expect(event.id).toBe(id);
    expect(event.modelNote).toBe(NOTE);
    expect(event.modelFallback).toEqual({ input: "claude-haiku-4-5", used: "anthropic/claude-sonnet-5-5" });
    const fetched = await tools.get("get_subagent_result").execute("tc", { agent_id: id }, undefined, undefined, ctx([PARENT]));
    expect(textOf(fetched)).toContain(NOTE);
    expect(textOf(fetched)).not.toContain("forged");
  });

  it("cross-extension RPC: a caller-supplied modelFallback is stripped, so it cannot forge provenance", async () => {
    writeAgent("scout", "anthropic/claude-sonnet-5-5");
    const bus = await bootWithBus();

    const { id, event } = await rpcSpawn(bus, { modelFallback: { input: "forged", used: "nowhere/none" } });

    expect(recordOf(id).modelFallback).toBeUndefined();
    expect(event.modelFallback).toBeUndefined();
    expect(event.modelNote).toBeUndefined();
  });

  it("cross-extension RPC: an available agentModels override is the model that runs", async () => {
    writeAgent("scout");
    const bus = await bootWithBus([PARENT, HAIKU]);
    setAgentModels({ scout: "anthropic/claude-haiku-5-5" });

    const { id, event } = await rpcSpawn(bus);

    expect(event.modelNote).toBeUndefined();
    expect(recordOf(id).invocation.modelId).toBe("anthropic/claude-haiku-5-5");
  });

  it("persists the fallback on the subagents:record entry history readers use", async () => {
    writeAgent("scout", "claude-haiku-4-5");
    const bus = await bootWithBus();

    const { id } = await rpcSpawn(bus);

    const entry = pi.appendEntry.mock.calls.find((c: any[]) => c[0] === "subagents:record" && c[1].id === id);
    expect(entry?.[1].modelFallback).toEqual({ input: "claude-haiku-4-5", used: "anthropic/claude-sonnet-5-5" });
  });

  it("@mention: an agent started by mention reports the definition model's fallback", async () => {
    writeAgent("scout", "claude-haiku-4-5");
    mkdirSync(join(cwd, "agent-dir"), { recursive: true });
    writeFileSync(join(cwd, "agent-dir", "subagents.json"), JSON.stringify({ agentMentions: "direct" }));
    await boot();
    // Direct mentions start the agent here, through the same spawn path.
    vi.mocked(runAgent).mockImplementation(runnerResolution({ hold: true }) as any);
    const uiCtx = { ...ctx([PARENT]), mode: "tui" };

    const handled = await lifecycle.get("input")({ type: "input", text: "@scout look around", source: "interactive" }, uiCtx);
    await flush();

    expect(handled).toEqual({ action: "handled" });
    const fetched = await tools.get("get_subagent_result").execute("tc", { agent_id: "scout" }, undefined, undefined, ctx([PARENT]));
    expect(textOf(fetched)).toContain(NOTE);
  });

  describe("nested Agent tool (real manager)", () => {
    function nestedAgentTool(manager: AgentManager) {
      return createNestedSubagentTools({
        manager: manager as any, pi: {} as any, parentAgentId: "p", depth: 1, maxSubagentDepth: 2,
        allowedSubagents: "all", configCwd: cwd, projectTrusted: true,
      })[0] as any;
    }
    const run = (tool: any, c: any) =>
      tool.execute("c", { subagent_type: "scout", description: "d", prompt: "p" }, undefined, undefined, c);

    it("prefixes the note, read from the child's record", async () => {
      writeAgent("scout", "claude-haiku-4-5");
      registerAgents(loadCustomAgents(cwd, false, { projectTrusted: true }));
      const manager = new AgentManager();

      const result = await run(nestedAgentTool(manager), ctx([PARENT]));

      expect(result.isError).toBe(false);
      expect(result.content[0].text.startsWith(NOTE)).toBe(true);
      expect(result.content[0].text).toContain("done");
    });

    it("adds nothing when the config model resolves", async () => {
      writeAgent("scout", "anthropic/claude-haiku-5-5");
      registerAgents(loadCustomAgents(cwd, false, { projectTrusted: true }));
      const manager = new AgentManager();

      const result = await run(nestedAgentTool(manager), ctx());

      expect(result.content[0].text).not.toContain("did not resolve");
    });
  });
});
