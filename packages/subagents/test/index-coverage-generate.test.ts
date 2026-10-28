/** Generation wizard drives the real manager/runner; only provider responses are scripted. */
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { initTheme, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentConfig } from "../src/agent-types.js";
import { createSubagentsExtension } from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { type BootedPi, ctx, type Hermetic, hermeticDir, makePi, startSession } from "./helpers/boot-extension.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { answer, barrier, calls } from "./helpers/scenario-session.js";

let env: Hermetic;
let boot: BootedPi;
let context: ExtensionCommandContext;
let provider: FauxProviderRegistration;
let clock: FakeClock;
let selections: (string | undefined)[];
let inputs: (string | undefined)[];
const notify = vi.fn();
const confirm = vi.fn();
const definition = "---\ndescription: Generated audit\ntools: read\n---\nKeep inputs private.\n";
function target() { return join(env.dir, ".pi", "agents", "generated.md"); }
async function command() { await boot.commands.get("agents").handler("", context); }

beforeEach(async () => {
  env = hermeticDir({ settings: { outputTranscript: false, rememberAgents: false, disableDefaultAgents: false,
    schedulingEnabled: false, workflowsEnabled: false, fleetView: true, worktreeIsolation: true } });
  provider = registerFauxProvider({ provider: "index-generation", models: [{ id: "writer" }] });
  const model = provider.getModel();
  const runtime = await ModelRuntime.create({ authPath: join(env.dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const registry = new ModelRegistry(runtime);
  registry.registerProvider(model.provider, { baseUrl: model.baseUrl, api: provider.api, apiKey: "faux", models: provider.models });
  selections = ["Create new agent", "Project", "Generate with Claude (recommended)"];
  inputs = ["Audit private configuration", "generated"];
  notify.mockReset(); confirm.mockReset(); confirm.mockResolvedValue(false);
  boot = makePi();
  const events = new EventEmitter();
  boot.pi.events = {
    emit: vi.fn((event: string, value: unknown) => events.emit(event, value)),
    on: (event: string, handler: (value: unknown) => void) => { events.on(event, handler); return () => events.off(event, handler); },
  };
  events.on("router:rpc:admit", ({ requestId }: { requestId: string }) => {
    events.emit(`router:rpc:admit:reply:${requestId}`, { success: true, data: { ok: true } });
  });
  clock = new FakeClock();
  createSubagentsExtension({ clock })(boot.pi);
  context = ctx({ cwd: env.dir, model: registry.find(model.provider, model.id), modelRegistry: registry,
    isProjectTrusted: () => true, ui: { ...ctx().ui, notify, confirm,
      select: vi.fn(async (_title: string, choices: string[]) => {
        const next = selections.shift();
        if (next === "Running agents") return choices.find(choice => choice.startsWith("Running agents ("));
        return next === "first" ? choices[0] : next;
      }), input: vi.fn(async () => inputs.shift()),
    } });
  await startSession(boot.lifecycle, true, context);
});
afterEach(async () => {
  await boot.lifecycle.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, context);
  provider.unregister(); env.restore();
});

describe("menu conversation viewer", () => {
  it("persists markdown from the fleet entry point and records disclosure changes", async () => {
    initTheme("dark");
    const listeners: ((data: string) => unknown)[] = [];
    context.hasUI = true;
    context.ui.onTerminalInput = vi.fn(handler => { listeners.push(handler); return () => {}; });
    context.ui.getEditorText = vi.fn(() => "");
    await startSession(boot.lifecycle, true, context);
    provider.setResponses([answer("Private fleet answer.")]);
    const result = await boot.tools.get("Agent").execute("fleet-viewer", {
      subagent_type: "general-purpose", description: "Private fleet child", prompt: "Work", run_in_background: false,
    }, undefined, undefined, context);
    const rendered = barrier<string>();
    context.ui.custom = vi.fn(async factory => {
      const component = await factory({ terminal: { rows: 30, columns: 120 }, requestRender: vi.fn() } as never,
        { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
        undefined as never, () => {});
      const content = component.render(120).join("\n");
      component.handleInput?.("m"); component.handleInput?.("q"); component.dispose?.();
      rendered.resolve(content);
      return undefined;
    });
    const input = (key: string) => { for (const listener of listeners) listener(key); };
    input("\u001b[97;6u"); // Ctrl+Shift+A toggles the actual fleet disclosure.
    clock.advance(1000);
    input("\u001b[B"); input("\u001b[B"); input("\r");
    expect(await rendered.promise).toContain("Private fleet answer.");
    expect(JSON.parse(readFileSync(join(env.dir, ".pi", "subagents.json"), "utf8")).viewerMarkdown).toBe("all");
    expect(boot.pi.appendEntry).toHaveBeenCalledWith("subagents:fleet-state", expect.objectContaining({ version: 1 }));
    const output = await boot.tools.get("get_subagent_result").execute("fleet-read", { agent_id: result.details.agentId, verbose: true }, undefined, undefined, context);
    expect(output.content[0].text).toContain("Private fleet answer.");
  });

  it.each(["steer", "stop", "background"] as const)("routes the running viewer's %s action to its actual child", async action => {
    const entered = barrier();
    const release = barrier();
    provider.setResponses([async () => { entered.resolve(); await release.promise; return answer("Original answer."); }, answer("Redirected answer.")]);
    const registry = Reflect.get(globalThis, Symbol.for("pi-subagents:manager")) as {
      hasRunning(): boolean; waitForAll(): Promise<void>; getRecord(id: string): AgentRecord | undefined;
    };
    const pending = boot.tools.get("Agent").execute("running-viewer", {
      subagent_type: "general-purpose", description: "Interactive private child", prompt: "Begin private work", run_in_background: action !== "background",
    }, undefined, undefined, context);
    // Background spawns settle immediately; foreground handoff remains pending until b.
    const initial = action === "background" ? undefined : await pending;
    await entered.promise;
    try {
      expect(registry.hasRunning()).toBe(true);
      context.ui.custom = vi.fn(async (factory, options) => {
        const component = await factory({ terminal: { rows: 30, columns: 120 }, requestRender: vi.fn() } as never,
          { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
          undefined as never, () => {});
        expect(options?.overlayOptions?.()).toBeDefined();
        expect(component.render(120).join("\n")).toContain("Interactive private child");
        if (action === "steer") {
          component.handleInput?.("\r"); component.handleInput?.("Prioritize privacy"); component.handleInput?.("\r");
        } else if (action === "stop") {
          component.handleInput?.("x"); component.handleInput?.("x");
        } else component.handleInput?.("b");
        component.handleInput?.("q"); component.dispose?.();
        return undefined;
      });
      selections = ["Running agents", "first", undefined, undefined];
      await command();
      if (action === "stop") expect(notify).toHaveBeenCalledWith('Stopped "Interactive private child".', "info");
      if (action === "background") expect(notify).toHaveBeenCalledWith(expect.stringContaining("background"), "info");
      release.resolve();
      const result = initial ?? await pending;
      const id = result.details.agentId as string;
      await registry.waitForAll();
      expect(registry.hasRunning()).toBe(false);
      const output = await boot.tools.get("get_subagent_result").execute("read-viewer", { agent_id: id, verbose: true }, undefined, undefined, context);
      if (action === "steer") expect(output.content[0].text).toContain("Prioritize privacy");
      if (action === "stop") expect(registry.getRecord(id)?.status).toBe("stopped");
      else expect(output.content[0].text).toContain("Original answer.");
    } finally { release.resolve(); await pending; await registry.waitForAll(); }
  });

  it.each([false, true])("cycles and persists markdown with real write failure=%s", async fail => {
    provider.setResponses([answer("**Private completed answer**")]);
    await boot.tools.get("Agent").execute("viewer-call", {
      subagent_type: "general-purpose", description: "Private viewer", prompt: "Return a private answer", run_in_background: false,
    }, undefined, undefined, context);
    const settings = join(env.dir, ".pi", "subagents.json");
    if (fail) { rmSync(settings); mkdirSync(settings); }
    notify.mockClear();
    const rendered: string[] = [];
    context.ui.custom = vi.fn(async factory => {
      const viewer = factory({ terminal: { rows: 30, columns: 120 }, requestRender: vi.fn() } as never,
        { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
        undefined as never, () => {});
      const component = await viewer;
      rendered.push(...component.render(120));
      component.handleInput?.("m");
      rendered.push(...component.render(120));
      component.handleInput?.("q");
      component.dispose?.();
      return undefined;
    });
    selections = ["Running agents", "first", undefined, undefined];
    await command();
    expect(rendered.join("\n")).toContain("Private completed answer");
    expect(boot.pi.events.emit).toHaveBeenCalledWith("subagents:settings_changed", {
      settings: expect.objectContaining({ viewerMarkdown: "all" }), persisted: !fail,
    });
    if (fail) expect(notify).toHaveBeenLastCalledWith("Viewer markdown set to all (session only; failed to persist)", "warning");
    else {
      expect(JSON.parse(readFileSync(settings, "utf8")).viewerMarkdown).toBe("all");
      expect(notify).not.toHaveBeenCalled();
    }
  });
});

describe("generation wizard", () => {
  it("creates and reloads a real Markdown file through the child write tool", async () => {
    provider.setResponses([calls({ name: "write", args: { path: target(), content: definition } }), answer("Written.")]);
    await command();
    expect(readFileSync(target(), "utf8")).toBe(definition);
    expect(getAgentConfig("generated")?.description).toBe("Generated audit");
    expect(notify).toHaveBeenLastCalledWith(`Created ${target()}`, "info");
  });
  it("reports a completed child that did not write its requested file", async () => {
    provider.setResponses([answer("No file written.")]);
    await command();
    expect(existsSync(target())).toBe(false);
    expect(getAgentConfig("generated")).toBeUndefined();
    expect(notify).toHaveBeenLastCalledWith("Agent generation completed but file was not created. Check the agent output.", "warning");
  });
  it("reports the child provider failure without claiming creation", async () => {
    provider.setResponses([answer([], { stopReason: "error", errorMessage: "fixture generation denied" })]);
    await command();
    expect(existsSync(target())).toBe(false);
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("Generation failed:"), "warning");
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("fixture generation denied"), "warning");
  });
  it.each(["description", "name"])("cancels at %s before provider work", async stage => {
    inputs = stage === "description" ? [undefined] : ["Audit private configuration", undefined];
    await command();
    expect(existsSync(target())).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    expect(boot.pi.events.emit).not.toHaveBeenCalledWith("subagents:created", expect.anything());
  });
  it.each([false, true])("honors overwrite confirmation %s", async overwrite => {
    mkdirSync(join(target(), ".."), { recursive: true });
    const old = definition.replace("Generated audit", "Original audit");
    writeFileSync(target(), old);
    confirm.mockResolvedValue(overwrite);
    provider.setResponses([calls({ name: "write", args: { path: target(), content: definition } }), answer("Written.")]);
    await command();
    expect(confirm).toHaveBeenCalledWith("Overwrite", `${target()} already exists. Overwrite?`);
    expect(readFileSync(target(), "utf8")).toBe(overwrite ? definition : old);
    if (!overwrite) expect(notify).not.toHaveBeenCalled();
  });
});
