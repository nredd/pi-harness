/** Retained notices and orphan viewer actions through registered session lifecycle callbacks. */
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { initTheme, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listRunningDetached } from "../src/detached-results.js";
import { createSubagentsExtension } from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { type BootedPi, ctx, flush, type Hermetic, hermeticDir, makePi, startSession } from "./helpers/boot-extension.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { answer, barrier } from "./helpers/scenario-session.js";

interface Registry { waitForAll(): Promise<void>; getRecord(id: string): AgentRecord | undefined }
interface Bound { boot: BootedPi; context: ExtensionCommandContext; registry: Registry; stopped: boolean }
let env: Hermetic;
let provider: FauxProviderRegistration;
let registry: ModelRegistry;
let sessionFile: string;
let clock: FakeClock;
let bindings: Bound[];
let releases: (() => void)[];
const managerKey = Symbol.for("pi-subagents:manager");

beforeEach(async () => {
  initTheme("dark");
  env = hermeticDir({ settings: { outputTranscript: false, rememberAgents: false, defaultJoinMode: "group",
    schedulingEnabled: false, workflowsEnabled: false, fleetView: true, disableDefaultAgents: false,
    scopeModels: false, widgetMode: "off", agentMentions: "off" } });
  bindings = []; releases = []; clock = new FakeClock();
  sessionFile = join(env.dir, "parent.jsonl"); writeFileSync(sessionFile, "");
  provider = registerFauxProvider({ provider: "index-final-lifecycle", models: [{ id: "child" }] });
  const model = provider.getModel();
  const runtime = await ModelRuntime.create({ authPath: join(env.dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  registry = new ModelRegistry(runtime);
  registry.registerProvider(model.provider, { baseUrl: model.baseUrl, api: provider.api, apiKey: "faux", models: provider.models });
});
afterEach(async () => {
  try {
    for (const release of releases) release();
    for (const bound of bindings) await bound.registry.waitForAll();
    await flush();
    for (const bound of [...bindings].reverse()) if (!bound.stopped) await shutdown(bound, "quit");
  } finally { provider.unregister(); env.restore(); }
});

async function bind(ui: Record<string, unknown> = {}): Promise<Bound> {
  const boot = makePi(); const bus = new EventEmitter();
  boot.pi.events = {
    emit: vi.fn((event: string, value: unknown) => bus.emit(event, value)),
    on: (event: string, handler: (value: unknown) => void) => { bus.on(event, handler); return () => bus.off(event, handler); },
  };
  bus.on("router:rpc:admit", ({ requestId }: { requestId: string }) => bus.emit(`router:rpc:admit:reply:${requestId}`, { success: true, data: { ok: true } }));
  createSubagentsExtension({ clock })(boot.pi);
  const context = ctx({ cwd: env.dir, model: registry.find(provider.getModel().provider, "child"), modelRegistry: registry,
    signal: new AbortController().signal, hasUI: Object.keys(ui).length > 0, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "index-final-parent", getBranch: () => [], getSessionFile: () => sessionFile },
    ui: { ...ctx().ui, ...ui },
  });
  await startSession(boot.lifecycle, true, context);
  const bound = { boot, context, registry: Reflect.get(globalThis, managerKey) as Registry, stopped: false };
  bindings.push(bound); return bound;
}
async function shutdown(bound: Bound, reason: "reload" | "quit") {
  await bound.boot.lifecycle.get("session_shutdown")?.({ type: "session_shutdown", reason }, bound.context);
  bound.stopped = true;
}
async function spawn(bound: Bound, prompt: string) {
  const result = await bound.boot.tools.get("Agent").execute(`call-${prompt}`, {
    subagent_type: "general-purpose", prompt, description: prompt, run_in_background: true,
  }, undefined, undefined, bound.context);
  return result.details.agentId as string;
}
function heldResponse(text: string) {
  const entered = barrier(); const release = barrier(); releases.push(() => release.resolve());
  return { entered: entered.promise, release: () => release.resolve(),
    response: async () => { entered.resolve(); await release.promise; return answer(text); } };
}
async function turnEnd(bound: Bound) {
  await bound.boot.lifecycle.get("turn_end")?.({ type: "turn_end", message: { role: "assistant", stopReason: "toolUse" } } as never, bound.context);
}

describe("index retained lifecycle callbacks", () => {
  it("restores both members of a held grouped completion once after reload", async () => {
    const a = heldResponse("alpha private result"); const b = heldResponse("beta private result");
    provider.setResponses([a.response, b.response]);
    const first = await bind();
    const ids = await Promise.all([spawn(first, "alpha"), spawn(first, "beta")]);
    await Promise.all([a.entered, b.entered]);
    await turnEnd(first); // Register the real turn batch while both members run.
    a.release(); b.release(); await first.registry.waitForAll();
    expect(first.boot.pi.sendMessage).not.toHaveBeenCalled();
    await shutdown(first, "reload");
    const next = await bind();
    await turnEnd(next);
    expect(next.boot.pi.sendMessage).toHaveBeenCalledTimes(1);
    const [message] = next.boot.pi.sendMessage.mock.calls[0];
    expect(message.content).toContain("alpha private result");
    expect(message.content).toContain("beta private result");
    expect([message.details.id, ...message.details.others.map((other: { id: string }) => other.id)]).toEqual(expect.arrayContaining(ids));
    await turnEnd(next);
    expect(next.boot.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(first.boot.pi.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["steer", "stop"] as const)("routes %s from a fresh fleet viewer to its detached survivor", async action => {
    const hold = heldResponse("survivor original result");
    provider.setResponses([hold.response, answer("survivor redirected result")]);
    const first = await bind(); const id = await spawn(first, "private survivor"); await hold.entered;
    await shutdown(first, "reload");
    expect(listRunningDetached(sessionFile).map(entry => entry.record.id)).toContain(id);
    const listeners: ((data: string) => unknown)[] = [];
    const viewed = barrier(); const rendered: string[] = [];
    const notify = vi.fn();
    const next = await bind({ notify, getEditorText: () => "",
      onTerminalInput: (handler: (data: string) => unknown) => { listeners.push(handler); return () => {}; },
      custom: vi.fn(async (factory: (tui: unknown, theme: unknown, keys: undefined, done: () => void) => { render(w: number): string[]; handleInput(key: string): void; dispose(): void }) => {
        const component = factory({ terminal: { rows: 30, columns: 120 }, requestRender: vi.fn() },
          { fg: (_color: string, text: string) => text, bold: (text: string) => text }, undefined, () => {});
        rendered.push(...component.render(120));
        if (action === "steer") { component.handleInput("\r"); component.handleInput("Prioritize survivor privacy"); component.handleInput("\r"); }
        else { component.handleInput("x"); component.handleInput("x"); }
        component.handleInput("q"); component.dispose(); viewed.resolve(); return undefined;
      }),
    });
    for (const key of ["\u001b[B", "\u001b[B", "\r"]) for (const listener of listeners) listener(key);
    await viewed.promise;
    expect(rendered.join("\n")).toContain("private survivor");
    if (action === "stop") expect(notify).toHaveBeenCalledWith('Stopped "private survivor".', "info");
    const record = first.registry.getRecord(id)!;
    const session = record.session!;
    hold.release(); await first.registry.waitForAll(); await flush();
    if (action === "stop") expect(record.status).toBe("stopped");
    else {
      expect(record.result).toBe("survivor redirected result");
      expect(JSON.stringify(session.messages)).toContain("Prioritize survivor privacy");
    }
    expect(listRunningDetached(sessionFile)).toHaveLength(0);
    expect(first.registry.getRecord(id)).toBeUndefined(); // The settled detached manager releases retained sessions/records.
    expect(first.boot.pi.sendMessage).not.toHaveBeenCalled();
    expect(next.boot.pi.sendMessage).not.toHaveBeenCalled(); // Never deliver the old run into the replacement context.
  });
});
