/**
 * config-model-fallback-real-runner.test.ts -- the REAL `runAgent` (real pi
 * session construction, faux provider, real `selectConfiguredModel`, real
 * manager) for spawns that name no model: cross-extension RPC, a direct
 * @mention, and a scheduled job without a stored model. An UNAVAILABLE
 * `agentModels` override must be honored and disclosed on each, even over a
 * definition `model:` that resolves. Nothing here replaces model selection, so
 * reverting `runAgent` to definition-only selection fails every test.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import subagentsExtension from "../src/index.js";
import { modelFallbackNote, setAgentModels } from "../src/model-resolver.js";
import { SubagentScheduler } from "../src/schedule.js";
import { ScheduleStore } from "../src/schedule-store.js";
import { flush, makePi, startSession, textOf } from "./helpers/boot-extension.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

vi.setConfig({ testTimeout: 30_000 });

let cwd: string;
let faux: ReturnType<typeof registerFauxProvider>;
let saved: { cwd: string; agentDir?: string; home?: string };

/** A registry like the e2e one: only the faux model exists, so any other input is unavailable. */
function ctxFor(model: any, extra: Record<string, unknown> = {}) {
  return {
    hasUI: false,
    mode: "tui",
    cwd,
    model,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(), addAutocompleteProvider: vi.fn() },
    isProjectTrusted: () => true,
    getSystemPrompt: () => "PARENT",
    sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
    modelRegistry: {
      find: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
      getAll: () => [model],
      getAvailable: () => [model],
      hasConfiguredAuth: () => true,
      isUsingOAuth: () => false,
      getApiKeyAndHeaders: async () => ({ apiKey: "faux", headers: {} }),
      registerProvider: () => {},
      unregisterProvider: () => {},
    },
    ...extra,
  } as any;
}

const parentRef = () => `${faux.getModel().provider}/${faux.getModel().id}`;
const note = (inputs: string) =>
  `Note: configured ${inputs} not resolve; running on parent model ${parentRef()}.`;
const NOTE = () => note('model "claude-haiku-4-5" did');

function writeScout(model: string): void {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "scout.md"), `---\ndescription: scout\ntools: read\nmodel: ${model}\n---\nscout.\n`);
}

beforeEach(() => {
  saved = { cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, home: process.env.HOME };
  cwd = mkdtempSync(join(tmpdir(), "config-model-real-"));
  process.chdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
  process.env.HOME = cwd;
  faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
});

afterEach(() => {
  setAgentModels(undefined);
  faux.unregister();
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  process.chdir(saved.cwd);
  if (saved.agentDir == null) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
  if (saved.home == null) delete process.env.HOME;
  else process.env.HOME = saved.home;
  registerAgents(new Map());
  rmSync(cwd, { recursive: true, force: true });
});

async function bootWithBus() {
  const handlers = new Map<string, Array<(data: any) => void>>();
  const bus = {
    on: (event: string, handler: (data: any) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    emit: (event: string, data: unknown) => { for (const h of handlers.get(event) ?? []) h(data); },
  };
  const booted = makePi();
  booted.pi.events = bus;
  subagentsExtension(booted.pi);
  const c = ctxFor(faux.getModel());
  await startSession(booted.lifecycle, true, { model: c.model, modelRegistry: c.modelRegistry });
  return { ...booted, bus };
}

const manager = () => (globalThis as any)[Symbol.for("pi-subagents:manager")];

describe("real runAgent honors and discloses an unavailable agentModels override", () => {
  it("cross-extension RPC", async () => {
    writeScout(parentRef());
    const { bus, lifecycle } = await bootWithBus();
    setAgentModels({ scout: "claude-haiku-4-5" });

    const reply = new Promise<any>((resolve) => bus.on("subagents:rpc:spawn:reply:r1", resolve));
    bus.emit("subagents:rpc:spawn", { requestId: "r1", type: "scout", prompt: "go", options: { description: "rpc" } });
    const id = (await reply).data.id;

    await vi.waitFor(() => expect(manager().getRecord(id).modelFallback).toBeDefined());
    expect(modelFallbackNote(manager().getRecord(id).modelFallback)).toBe(NOTE());
    await lifecycle.get("session_shutdown")?.({} as any, ctxFor(faux.getModel()));
  });

  it("cross-extension RPC with `model: null` (inherit) still selects the configured model and discloses", async () => {
    writeScout(parentRef());
    const { bus, lifecycle } = await bootWithBus();
    setAgentModels({ scout: "claude-haiku-4-5" });

    const reply = new Promise<any>((resolve) => bus.on("subagents:rpc:spawn:reply:r1", resolve));
    bus.emit("subagents:rpc:spawn", { requestId: "r1", type: "scout", prompt: "go", options: { description: "rpc", model: null } });
    const id = (await reply).data.id;

    await vi.waitFor(() => expect(manager().getRecord(id).modelFallback).toBeDefined());
    expect(modelFallbackNote(manager().getRecord(id).modelFallback)).toBe(NOTE());
    await lifecycle.get("session_shutdown")?.({} as any, ctxFor(faux.getModel()));
  });

  it("direct @mention", async () => {
    writeScout(parentRef());
    mkdirSync(join(cwd, "agent-dir"), { recursive: true });
    writeFileSync(join(cwd, "agent-dir", "subagents.json"), JSON.stringify({ agentMentions: "direct" }));
    const { tools, lifecycle } = await bootWithBus();
    setAgentModels({ scout: "claude-haiku-4-5" });

    await lifecycle.get("input")?.({ type: "input", text: "@scout look around", source: "interactive" } as any, ctxFor(faux.getModel()));
    await flush();

    await vi.waitFor(async () => {
      const fetched = await tools.get("get_subagent_result").execute("tc", { agent_id: "scout" }, undefined, undefined, ctxFor(faux.getModel()));
      expect(textOf(fetched)).toContain(NOTE());
    });
    await lifecycle.get("session_shutdown")?.({} as any, ctxFor(faux.getModel()));
  });

  describe("scheduler job without a stored model", () => {
    let tmp: string;
    let scheduler: SubagentScheduler;
    let mgr: AgentManager;

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), "config-model-real-sched-"));
      scheduler = new SubagentScheduler();
      mgr = new AgentManager();
    });

    afterEach(() => {
      scheduler.stop();
      rmSync(tmp, { recursive: true, force: true });
    });

    async function fire(model?: string) {
      registerAgents(loadCustomAgents(cwd, false, { projectTrusted: true }));
      const pi = { events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) }, exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any;
      scheduler.start(pi, ctxFor(faux.getModel()), mgr, new ScheduleStore(join(tmp, "s.json")));
      scheduler.addJob({
        name: "job", description: "job", schedule: new Date(Date.now() + 50).toISOString(),
        subagent_type: "scout", prompt: "go", ...(model ? { model } : {}),
      });
      await vi.waitFor(() => expect(mgr.listAgents()).toHaveLength(1), { timeout: 3000 });
      const record = mgr.listAgents()[0]!;
      await vi.waitFor(() => expect(record.modelFallback).toBeDefined(), { timeout: 5000 });
      return record;
    }

    it("honors the override over a resolving definition model", async () => {
      writeScout(parentRef());
      setAgentModels({ scout: "claude-haiku-4-5" });

      const record = await fire();

      expect(modelFallbackNote(record.modelFallback)).toBe(NOTE());
    });

    it("discloses BOTH failures when the stored model and the override are unavailable", async () => {
      writeScout(parentRef());
      setAgentModels({ scout: "claude-haiku-4-5" });

      const record = await fire("claude-opus-4-6");

      expect(modelFallbackNote(record.modelFallback)).toBe(note('models "claude-opus-4-6", "claude-haiku-4-5" did'));
      expect(record.modelFallback?.also).toEqual(["claude-haiku-4-5"]);
    });
  });
});
