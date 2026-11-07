/** Owned (nested) agents stay off top-level channels; detached and RPC edges of the same wiring. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunnerModule from "../src/agent-runner.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunnerModule>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import { drainDetached, listRunningDetached } from "../src/detached-results.js";
import { createSubagentsExtension } from "../src/index.js";
import { resolveModel } from "../src/model-resolver.js";
import { resetBudgetForTests, setBudgetPolicy } from "../src/process-budget.js";
import type { AgentRecord } from "../src/types.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const managerKey = Symbol.for("pi-subagents:manager");
type Registry = { getRecord(id: string): AgentRecord | undefined };
const registry = () => (globalThis as any)[managerKey] as Registry;

let env: Hermetic;
let release: () => void;
let gate: Promise<void>;
let sessionFile: string;

function bootWithBus(settings: Record<string, unknown> = {}) {
  env = hermeticDir({ settings: { outputTranscript: false, fallbackSubagent: "none", ...settings } });
  sessionFile = join(env.dir, "parent.jsonl");
  writeFileSync(sessionFile, "");
  const b = makePi();
  const handlers = new Map<string, ((data: unknown) => void)[]>();
  b.pi.events.emit = vi.fn((event: string, data: unknown) => { for (const h of [...(handlers.get(event) ?? [])]) h(data); });
  b.pi.events.on = vi.fn((event: string, handler: (data: unknown) => void) => {
    handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    return () => handlers.set(event, (handlers.get(event) ?? []).filter(h => h !== handler));
  });
  createSubagentsExtension()(b.pi);
  const parent = ctx({ sessionManager: { getSessionId: () => "owned", getSessionFile: () => sessionFile, getBranch: () => [] } });
  return { ...b, parent, bus: b.pi.events as { emit: (e: string, d: unknown) => void; on: (e: string, h: (d: any) => void) => () => void } };
}

type Booted = ReturnType<typeof bootWithBus>;
const emitted = (b: Booted, channel: string) =>
  b.pi.events.emit.mock.calls.filter((call: unknown[]) => call[0] === channel).map((call: unknown[]) => call[1]);

async function start(b: Booted) {
  await b.lifecycle.get("session_start")?.({ type: "session_start", reason: "startup" }, b.parent);
}
async function quit(b: Booted, reason = "quit") {
  await b.lifecycle.get("session_shutdown")?.({ type: "session_shutdown", reason } as any, b.parent);
}

/** Spawn over the bus the way another extension would; resolves with the new id. */
async function rpcSpawn(b: Booted, request: string, options?: Record<string, unknown>): Promise<string> {
  let id = "";
  b.bus.on(`subagents:rpc:spawn:reply:${request}`, (reply: any) => { id = reply.data.id; });
  b.bus.emit("subagents:rpc:spawn", { requestId: request, type: "general-purpose", prompt: "go", ...(options ? { options } : {}) });
  await vi.waitFor(() => expect(id).toBeTruthy());
  return id;
}

/** The manager behind the extension, read off the first `spawn` it receives. */
function managerOf(spawn: { mock: { contexts: unknown[] } }): AgentManager {
  return spawn.mock.contexts[0] as AgentManager;
}

beforeEach(() => {
  Reflect.deleteProperty(globalThis, managerKey);
  gate = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(runAgent).mockImplementation(async () => {
    await gate;
    return { responseText: "done", session: { dispose: vi.fn() }, aborted: false, steered: false } as Awaited<ReturnType<typeof runAgent>>;
  });
});
afterEach(() => {
  release();
  resetBudgetForTests();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, managerKey);
  env.restore();
});

describe("model scope without a caller-supplied config root", () => {
  it("reads enabledModels from the process cwd", async () => {
    const b = bootWithBus();
    mkdirProjectSettings(env.dir, { enabledModels: ["anthropic/claude-haiku-4-5"] });
    const models = [
      { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" },
    ];
    const modelRegistry = { find: (provider: string, id: string) => models.find(m => m.provider === provider && m.id === id), getAll: () => models, getAvailable: () => models };
    expect(resolveModel("claude", modelRegistry)).toMatchObject({ id: "claude-haiku-4-5" });
    await quit(b);
  });
});

function mkdirProjectSettings(dir: string, settings: Record<string, unknown>) {
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify(settings));
}

describe("owned agents on top-level lifecycle channels", () => {
  it("does not announce a steer of an owned agent, but does for a top-level one", async () => {
    const spawn = vi.spyOn(AgentManager.prototype, "spawn");
    const b = bootWithBus();
    await start(b);
    const topId = await rpcSpawn(b, "top", { description: "top", isBackground: true });
    const manager = managerOf(spawn);
    const nested = manager.getRecord(manager.spawn(b.pi, b.parent, "general-purpose", "n", {
      description: "nested", isBackground: true, parentAgentId: topId,
    }))!;

    expect(manager.steer(nested.id, "owned nudge")).toBe(true);
    expect(emitted(b, "subagents:steered")).toEqual([]);
    expect(manager.steer(topId, "top nudge")).toBe(true);
    expect(emitted(b, "subagents:steered")).toEqual([{ id: topId, message: "top nudge" }]);
    await quit(b);
  });

  it("does not report an owned agent stopped before it started", async () => {
    const spawn = vi.spyOn(AgentManager.prototype, "spawn");
    // Two slots, one reserved per nesting level: the top-level run and one owned child fit, a second child waits.
    const b = bootWithBus();
    await start(b);
    setBudgetPolicy({ maxActive: 2, nestedReserve: 1, maxDepth: 2 });
    const topId = await rpcSpawn(b, "top", { description: "top", isBackground: true });
    const manager = managerOf(spawn);
    const spawnOwned = (description: string) => manager.getRecord(manager.spawn(b.pi, b.parent, "general-purpose", "n", {
      description, isBackground: true, parentAgentId: topId, depth: 2,
    }))!;
    expect(spawnOwned("running nested").status).toBe("running");
    const queued = spawnOwned("queued nested");
    expect(queued.status).toBe("queued");

    expect(manager.abort(queued.id)).toBe(true);
    expect(queued.status).toBe("stopped");
    expect(emitted(b, "subagents:failed")).toEqual([]);
    await quit(b);
  });
});

describe("agents orphaned by a session switch", () => {
  it("publishes only running top-level agents to the reloaded instance", async () => {
    const spawn = vi.spyOn(AgentManager.prototype, "spawn");
    const b = bootWithBus();
    await start(b);
    const topId = await rpcSpawn(b, "top", { description: "top", isBackground: true });
    const manager = managerOf(spawn);
    const nestedId = manager.spawn(b.pi, b.parent, "general-purpose", "n", {
      description: "nested", isBackground: true, parentAgentId: topId,
    });

    await quit(b, "reload");

    const survivors = listRunningDetached(sessionFile).map(agent => agent.record.id);
    expect(survivors).toEqual([topId]);
    expect(survivors).not.toContain(nestedId);
    release();
    await manager.waitForAll();
  });

  it("spools a result that finished while detached, unless it was already consumed", async () => {
    const spawn = vi.spyOn(AgentManager.prototype, "spawn");
    const b = bootWithBus();
    await start(b);
    const unread = await rpcSpawn(b, "unread", { description: "unread", isBackground: true });
    const consumed = await rpcSpawn(b, "consumed", { description: "consumed", isBackground: true });
    // Consumed by a reader that outlived the switch (e.g. a bus consumer holding the record).
    registry().getRecord(consumed)!.resultConsumed = true;
    const manager = managerOf(spawn);

    await quit(b, "reload");
    release();
    await manager.waitForAll();

    expect(drainDetached(sessionFile).map(result => result.id)).toEqual([unread]);
  });
});

describe("a detached result in preview mode", () => {
  it("spools the rendered notice without full-result parts", async () => {
    const spawn = vi.spyOn(AgentManager.prototype, "spawn");
    const b = bootWithBus({ notificationResultChars: 0 });
    await start(b);
    const id = await rpcSpawn(b, "preview", { description: "preview", isBackground: true });
    const manager = managerOf(spawn);

    await quit(b, "reload");
    release();
    await manager.waitForAll();

    const [spooled] = drainDetached(sessionFile);
    expect(spooled.id).toBe(id);
    expect(spooled.content).toContain("done");
    expect(spooled.notice).toBeUndefined();
  });
});

describe("manager registry spawn without options", () => {
  it("still starts the agent", async () => {
    const b = bootWithBus();
    await start(b);
    const id = (globalThis as any)[managerKey].spawn(b.pi, b.parent, "general-purpose", "go");
    expect(registry().getRecord(id)).toMatchObject({ id, type: "general-purpose" });
    await quit(b);
  });
});
