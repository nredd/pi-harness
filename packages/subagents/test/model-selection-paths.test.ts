/** Actual entry paths + manager, real Pi registry/resolver; only child execution is stubbed. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { initTheme, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import * as runner from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { createSubagentsExtension } from "../src/index.js";
import { setAgentModels, setModelAliases } from "../src/model-resolver.js";
import { setScopeModelsEnabled } from "../src/model-scope.js";
import { createNestedSubagentTools } from "../src/nested-tools.js";
import { SubagentScheduler } from "../src/schedule.js";
import { resolveStorePath, ScheduleStore } from "../src/schedule-store.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import { flush, type Hermetic, hermeticDir, ctx as makeCtx, makePi, startSession } from "./helpers/boot-extension.js";
import { FakeClock } from "./helpers/fake-clock.js";

vi.mock("../src/agent-runner.js", async importOriginal => ({
  ...await importOriginal<typeof runner>(), runAgent: vi.fn(), resumeAgent: vi.fn(),
}));

const ref = (id: string) => `selection-path/${id}`;
const paths = ["Agent", "nested", "scheduled", "RPC", "mention", "workflow"] as const;
type Path = typeof paths[number];
let sandbox: Hermetic;
let registry: ModelRegistry;
let parent: ReturnType<ModelRegistry["find"]>;
let boot: ReturnType<typeof makePi>;
let context: ReturnType<typeof makeCtx>;
let manager: AgentManager;
let scheduler: SubagentScheduler;
let clock: FakeClock;
let blockedUntil: number | undefined;

function bus() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(event: string, handler: (data: unknown) => void) {
      const group = handlers.get(event) ?? new Set();
      group.add(handler); handlers.set(event, group);
      return () => { group.delete(handler); };
    },
    emit(event: string, data: unknown) { for (const handler of handlers.get(event) ?? []) handler(data); },
  };
}

beforeEach(async () => {
  sandbox = hermeticDir({ settings: { agentMentions: "direct", backgroundByDefault: false }, agentFiles: {
    scout: `---\ndescription: scout\ndisplay_name: Scout Label\ntools: read\nmodel: ${ref("definition")}\n---\nScout.`,
  } });
  const runtime = await ModelRuntime.create({ authPath: join(sandbox.dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  registry = new ModelRegistry(runtime);
  registry.registerProvider("selection-path", {
    api: "openai-completions", baseUrl: "http://localhost:1", apiKey: "fixture-not-a-secret",
    models: ["parent", "definition", "wildcard", "typed", "explicit"].map(id => ({
      id, name: id, reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  });
  registry.registerVirtualModel({ provider: "router", id: "default", name: "Router default", route: () => { throw new Error("not dispatched"); } });
  parent = registry.find("selection-path", "parent");
  context = makeCtx({ cwd: sandbox.dir, model: parent, modelRegistry: registry, isProjectTrusted: () => true });
  clock = new FakeClock();
  blockedUntil = undefined;
  boot = makePi();
  boot.pi.events = bus();
  // Answer admission synchronously, without any real router or network calls.
  boot.pi.events.on("router:rpc:admit", ({ requestId }: { requestId: string }) => {
    boot.pi.events.emit(`router:rpc:admit:reply:${requestId}`, { success: true,
      data: blockedUntil === undefined ? { ok: true } : { ok: false, resetAt: blockedUntil },
    });
  });
  createSubagentsExtension({ clock })(boot.pi);
  await startSession(boot.lifecycle, true, context);
  manager = new AgentManager(undefined, 10, undefined, undefined, undefined, undefined, clock);
  scheduler = new SubagentScheduler({ clock });
  scheduler.start(boot.pi, context, manager, new ScheduleStore(join(sandbox.dir, "jobs.json")));
  vi.mocked(runner.runAgent).mockReset();
  vi.mocked(runner.resumeAgent).mockReset();
  vi.mocked(runner.runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
    const sessionFile = join(sandbox.dir, `${options.agentId}.jsonl`);
    writeFileSync(sessionFile, "{}");
    const session = { model: options.model, dispose: vi.fn(), sessionManager: { getSessionFile: () => sessionFile } } as unknown as AgentSession;
    options.onSessionCreated?.(session);
    return { responseText: "done", session, aborted: false, steered: false };
  });
  vi.mocked(runner.resumeAgent).mockResolvedValue({ text: "resumed", aborted: false, steered: false });
});
afterEach(async () => {
  scheduler.stop();
  await manager.dispose();
  await boot.lifecycle.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, context);
  setAgentModels(undefined); setModelAliases(undefined); setScopeModelsEnabled(false);
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")];
  sandbox.restore();
});

async function invoke(path: Path, model?: string | null) {
  if (path === "Agent") {
    await boot.tools.get("Agent").execute("call", { subagent_type: "scout", description: "test", prompt: "go", run_in_background: false, model }, undefined, undefined, context);
  } else if (path === "nested") {
    const tool = createNestedSubagentTools({ manager, pi: boot.pi, parentAgentId: "owner", depth: 1, maxSubagentDepth: 2,
      allowedSubagents: "all", configCwd: sandbox.dir, projectTrusted: true })[0];
    await tool.execute("nested", { subagent_type: "scout", description: "test", prompt: "go", model }, undefined, undefined, context);
  } else if (path === "scheduled") {
    scheduler.addJob({ name: "test", description: "test", subagent_type: "scout", prompt: "go", schedule: "+1s", model });
    clock.advance(1000);
  } else if (path === "RPC") {
    await new Promise<void>((resolve, reject) => {
      boot.pi.events.on("subagents:rpc:spawn:reply:parity", (reply: { success: boolean; error?: string }) => reply.success ? resolve() : reject(new Error(reply.error)));
      boot.pi.events.emit("subagents:rpc:spawn", { requestId: "parity", type: "scout", prompt: "go", options: { description: "test", model } });
    });
  } else if (path === "mention") {
    await boot.lifecycle.get("input")?.({ type: "input", text: "@scout go", source: "interactive" } as never, context);
  } else {
    await createWorkflowHost({ pi: boot.pi, ctx: context, manager }).spawnAgent({ agentId: "wf-agent-1", agentType: "scout", label: "test", prompt: "go", model });
  }
  await flush();
  const invocation = vi.mocked(runner.runAgent).mock.calls.at(-1);
  const root = (globalThis as Record<symbol, { getRecord(id: string): ReturnType<AgentManager["getRecord"]> }>)[Symbol.for("pi-subagents:manager")];
  const record = invocation ? manager.getRecord(invocation[3].agentId!) ?? root.getRecord(invocation[3].agentId!) : undefined;
  return { invocation, record };
}

describe.each(paths)("%s model selection parity", path => {
  it("honors a type override over wildcard and frontmatter", async () => {
    setAgentModels({ SCOUT: ref("typed"), "*": ref("wildcard") });
    const { invocation, record } = await invoke(path);
    expect(invocation?.[3].model).toMatchObject({ provider: "selection-path", id: "typed" });
    expect(record?.modelSelection).toMatchObject({ requested: ref("typed"), source: "agentModels:type", outcome: "resolved" });
  });

  it("honors wildcard over frontmatter, including router selections", async () => {
    setAgentModels({ "*": "router/default" });
    const { invocation, record } = await invoke(path);
    expect(invocation?.[3].model).toMatchObject({ api: "pi-virtual", provider: "router", id: "default" });
    expect(record?.modelSelection).toMatchObject({ requested: "router/default", source: "agentModels:*", outcome: "resolved" });
  });

  it("resolves aliases from frontmatter through the same resolver", async () => {
    writeFileSync(join(sandbox.dir, ".pi", "agents", "scout.md"), "---\ndescription: scout\ntools: read\nmodel: portable\n---\nScout.");
    registerAgents(loadCustomAgents(sandbox.dir, false, { projectTrusted: true }));
    setModelAliases({ portable: [ref("typed")] });
    const { invocation, record } = await invoke(path);
    expect(invocation?.[3].model).toMatchObject({ id: "typed" });
    expect(record?.modelSelection).toMatchObject({ requested: "portable", source: "definition" });
  });

  it("inherits the parent when no model input is configured", async () => {
    writeFileSync(join(sandbox.dir, ".pi", "agents", "scout.md"), "---\ndescription: scout\ntools: read\n---\nScout.");
    registerAgents(loadCustomAgents(sandbox.dir, false, { projectTrusted: true }));
    const { invocation, record } = await invoke(path);
    expect(invocation?.[3].model).toBe(parent);
    expect(record?.modelSelection).toMatchObject({ source: "parent", outcome: "inherited", model: parent });
  });

  it("stores the unavailable request and parent fallback once", async () => {
    setAgentModels({ scout: "missing-model", "*": ref("wildcard") });
    const { invocation, record } = await invoke(path);
    expect(invocation?.[3].model).toBe(parent);
    expect(record?.modelSelection).toMatchObject({ requested: "missing-model", source: "agentModels:type", outcome: "fallback", model: parent });
    expect(record?.modelFallback).toBe(record?.modelSelection?.fallback);
    expect(record?.modelFallback).toEqual({ input: "missing-model", used: ref("parent") });
  });

  it("warns and proceeds for an out-of-scope configured model", async () => {
    writeFileSync(join(sandbox.dir, ".pi", "settings.json"), JSON.stringify({ enabledModels: [ref("parent")] }));
    setScopeModelsEnabled(true);
    setAgentModels({ scout: ref("typed") });
    const { invocation, record } = await invoke(path);
    expect(invocation?.[3].model).toMatchObject({ id: "typed" });
    expect(record?.modelSelection?.scopeWarning).toBe(`Agent "Scout Label" using out-of-scope model "${ref("typed")}"`);
  });

  if (path !== "mention") it("refuses an unresolved explicit model instead of inheriting or selecting config", async () => {
    setAgentModels({ scout: ref("typed") });
    await invoke(path, "missing-model").catch(() => {});
    expect(runner.runAgent).not.toHaveBeenCalled();
    if (path === "scheduled") expect(scheduler.list()[0].lastStatus).toBe("error");
  });

  if (path !== "mention") it("refuses an explicit out-of-scope model", async () => {
    writeFileSync(join(sandbox.dir, ".pi", "settings.json"), JSON.stringify({ enabledModels: [ref("parent")] }));
    setScopeModelsEnabled(true);
    await invoke(path, ref("explicit")).catch(() => {});
    expect(runner.runAgent).not.toHaveBeenCalled();
  });

  if (path !== "mention") it("keeps an explicit override ahead of configured routing", async () => {
    setAgentModels({ "*": "router/default", scout: ref("typed") });
    const { invocation, record } = await invoke(path, ref("explicit"));
    expect(invocation?.[3].model).toMatchObject({ id: "explicit" });
    expect(record?.modelSelection).toMatchObject({ requested: ref("explicit"), source: "param" });
  });
});

it("shows the same configured model in the agents menu instead of the definition default", async () => {
  setAgentModels({ scout: "router/default" });
  initTheme("dark", false);
  let rendered = "";
  context.ui.select = vi.fn().mockImplementationOnce((_title: string, options: string[]) => options.find(option => option.startsWith("Agent types (")));
  context.ui.custom = vi.fn((factory: (tui: object, theme: undefined, keys: object, done: () => void) => { render(width: number): string[] }) => {
    rendered = factory({}, undefined, {}, () => {}).render(120).join("\n");
    return undefined;
  });
  await boot.commands.get("agents").handler("", context);
  const scoutRow = rendered.split("\n").find(line => line.includes("scout"));
  expect(scoutRow).toContain("default");
  expect(scoutRow).not.toContain("definition");
});

it("treats RPC null as no explicit override while still applying configured routing", async () => {
  setAgentModels({ "*": "router/default" });
  const { invocation, record } = await invoke("RPC", null);
  expect(invocation?.[3].model).toMatchObject({ provider: "router", id: "default" });
  expect(record?.modelSelection).toMatchObject({ source: "agentModels:*", requested: "router/default" });
});

it("reselects quota-parked defaults at fire time instead of freezing the admitted request", async () => {
  setAgentModels({ scout: "router/default" });
  blockedUntil = clock.now() + 60_000;
  await boot.tools.get("Agent").execute("park", {
    subagent_type: "scout", description: "parked", prompt: "go", run_in_background: true,
  }, undefined, undefined, context);
  const [job] = new ScheduleStore(resolveStorePath(sandbox.dir, "s1")).list();
  expect(job.quotaParked).toBe(true);
  expect(job.model).toBeUndefined();
  expect(runner.runAgent).not.toHaveBeenCalled();
  setAgentModels({ scout: ref("typed") });
  blockedUntil = undefined;
  clock.advance(120_000);
  await flush();
  expect(vi.mocked(runner.runAgent).mock.calls.at(-1)?.[3].model).toMatchObject({ id: "typed" });
});

it("keeps an explicit quota-parked alias request and re-resolves it at fire time", async () => {
  setModelAliases({ portable: ["router/default"] });
  blockedUntil = clock.now() + 60_000;
  await boot.tools.get("Agent").execute("park-explicit", {
    subagent_type: "scout", description: "parked explicit", prompt: "go", model: "portable", run_in_background: true,
  }, undefined, undefined, context);
  const [job] = new ScheduleStore(resolveStorePath(sandbox.dir, "s1")).list();
  expect(job.quotaParked).toBe(true);
  expect(job.model).toBe("portable");
  setModelAliases({ portable: [ref("explicit")] });
  setAgentModels({ scout: ref("typed") });
  blockedUntil = undefined;
  clock.advance(120_000);
  await flush();
  const options = vi.mocked(runner.runAgent).mock.calls.at(-1)?.[3];
  expect(options?.model).toMatchObject({ id: "explicit" });
  expect(options?.modelSelection).toMatchObject({ requested: "portable", source: "param" });
});

it("reopens an evicted mention with current selection and retained original fallback provenance", async () => {
  setAgentModels({ scout: "missing-model" });
  const { record } = await invoke("Agent");
  const root = (globalThis as Record<symbol, { getRecord(id: string): ReturnType<AgentManager["getRecord"]> }>)[Symbol.for("pi-subagents:manager")];
  expect(record?.sessionFile).toBeDefined();
  expect(record?.modelFallback).toEqual({ input: "missing-model", used: ref("parent") });
  clock.advance(11 * 60_000);
  expect(root.getRecord(record!.id)).toBeUndefined();
  setAgentModels({ scout: "router/default" });
  await boot.lifecycle.get("input")?.({ type: "input", text: "@scout again", source: "interactive" } as never, context);
  await flush();
  const options = vi.mocked(runner.runAgent).mock.calls.at(-1)?.[3];
  expect(options?.resumeSessionFile).toBe(record?.sessionFile);
  expect(options?.model).toMatchObject({ provider: "router", id: "default" });
  expect(options?.modelSelection).toMatchObject({ requested: "router/default", source: "agentModels:type" });
  expect(options?.modelSelection?.fallback).toBeUndefined();
  expect(root.getRecord(options!.agentId!)?.modelFallback).toEqual(record?.modelFallback);
});

it("ignores new model inputs on Agent resume and reads the original record disclosure", async () => {
  setAgentModels({ scout: "missing-model" });
  const { record } = await invoke("Agent");
  const selection = record!.modelSelection;
  setAgentModels({ scout: "router/default" });
  const result = await boot.tools.get("Agent").execute("resume", {
    subagent_type: "not-the-original-type", description: "again", prompt: "again",
    resume: record!.id, model: "another-missing-model", run_in_background: false,
  }, undefined, undefined, context);
  expect(runner.resumeAgent).toHaveBeenCalled();
  expect(record!.modelSelection).toBe(selection);
  expect(result.details.modelNote).toContain('configured model "missing-model"');
  expect(result.content[0].text).not.toContain("another-missing-model");
});

it("retains the record's original selection on resume despite changed config", async () => {
  setAgentModels({ scout: "missing-model" });
  const { record } = await invoke("nested");
  expect(record).toBeDefined();
  const selection = record!.modelSelection;
  setAgentModels({ scout: "router/default" });
  await manager.resume(record!.id, "again");
  expect(record!.modelSelection).toBe(selection);
  expect(record!.session?.model).toBe(parent);
  expect(runner.resumeAgent).toHaveBeenCalled();
});
