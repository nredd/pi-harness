/** Agent-tool and agent-control-tool result text for states the happy paths never reach. */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ADMIT_CHANNEL } from "../src/quota-admission.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const managerKey = Symbol.for("pi-subagents:manager");
const registry = () => (globalThis as any)[managerKey];

let hermetic: Hermetic | undefined;
let lifecycle: Map<string, any> | undefined;

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
});
afterEach(async () => {
  await lifecycle?.get("session_shutdown")?.();
  Reflect.deleteProperty(globalThis, managerKey);
  lifecycle = undefined;
  hermetic?.restore();
  hermetic = undefined;
});

function boot(settings: Record<string, unknown> = {}, bus?: EventEmitter) {
  hermetic = hermeticDir({ settings: { outputTranscript: false, schedulingEnabled: false, ...settings } });
  const b = makePi();
  if (bus) {
    b.pi.events = {
      emit: (channel: string, data: unknown) => bus.emit(channel, data),
      on: (channel: string, handler: (data: unknown) => void) => { bus.on(channel, handler); return () => bus.off(channel, handler); },
    };
  }
  subagentsExtension(b.pi);
  lifecycle = b.lifecycle;
  return b;
}

const fakeSession = (messages: unknown[] = []) => ({
  steer: vi.fn().mockResolvedValue(undefined), dispose: vi.fn(), subscribe: vi.fn(() => () => {}), messages, getActiveToolNames: vi.fn(() => []),
}) as any;

const run = (tools: Map<string, any>, params: Record<string, unknown>, onUpdate?: (u: any) => void) =>
  tools.get("Agent").execute(`tc-${String(params.prompt)}`, { description: String(params.prompt), subagent_type: "general-purpose", ...params }, undefined, onUpdate, ctx());

/** A run that stays live with a session until released. */
function heldRun(session = fakeSession()) {
  vi.mocked(runAgent).mockImplementation((_c: any, _t: any, _p: any, opts: any) => new Promise(() => { opts.onSessionCreated?.(session); }) as any);
  return session;
}

describe("a blocking call parked behind two others", () => {
  it("counts only the agents queued ahead of it", async () => {
    const { tools } = boot({ maxConcurrentForeground: 1 });
    const resolvers = new Map<string, () => void>();
    vi.mocked(runAgent).mockImplementation((_c: any, _t: any, prompt: any, opts: any) => new Promise<any>(resolve => {
      opts.onSessionCreated?.(fakeSession());
      resolvers.set(prompt, () => resolve({ responseText: `${prompt}-RESULT`, session: fakeSession(), aborted: false, steered: false }));
    }) as any);

    const updates = new Map<string, any[]>();
    const call = (prompt: string) => run(tools, { prompt, run_in_background: false }, u => updates.set(prompt, [...(updates.get(prompt) ?? []), u]));
    const calls = [call("alpha"), call("beta"), call("gamma")];
    await flush();

    const activity = (prompt: string) => updates.get(prompt)?.at(-1)?.details?.activity;
    expect(activity("beta")).toBe("queued — waiting for a foreground slot");
    expect(activity("gamma")).toBe("queued — waiting for a foreground slot (1 ahead)");

    for (const prompt of ["alpha", "beta", "gamma"]) { resolvers.get(prompt)?.(); await flush(); }
    await Promise.all(calls);
  });
});

describe("resuming an agent whose record never described its invocation", () => {
  it("reports the record's own tier, not the resume call's", async () => {
    const { tools } = boot();
    vi.mocked(runAgent).mockResolvedValue({ responseText: "first", session: fakeSession(), aborted: false, steered: false } as any);
    vi.mocked(resumeAgent).mockResolvedValue({ text: "second", failure: undefined } as any);
    // Spawned over the registry, as another extension would: no Agent-tool invocation snapshot.
    const id = registry().spawn({ ...ctx(), events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) } }, ctx(), "general-purpose", "go", { description: "first", isBackground: true });
    await flush();
    const record = registry().getRecord(id);
    expect(record.invocation).toBeUndefined();
    record.modelTier = { kind: "unmapped", tier: "fast" };

    const result = await run(tools, { resume: id, prompt: "again", run_in_background: true });

    expect(result.details).toMatchObject({ agentId: id, status: "background", modelTier: { kind: "unmapped", tier: "fast" } });
  });
});

describe("get_subagent_result", () => {
  it("lists compactions, and omits an empty conversation when verbose", async () => {
    const { tools } = boot();
    vi.mocked(runAgent).mockResolvedValue({ responseText: "answer", session: fakeSession(), aborted: false, steered: false } as any);
    const id = registry().spawn(ctx(), ctx(), "general-purpose", "go", { description: "done", isBackground: true });
    await flush();
    registry().getRecord(id).compactionCount = 3;

    const text = textOf(await tools.get("get_subagent_result").execute("read", { agent_id: id, verbose: true }, undefined, undefined, ctx()));

    expect(text).toContain("Compactions: 3");
    expect(text).not.toContain("--- Agent Conversation ---");
  });
});

describe("steer_subagent state line", () => {
  it("singularises one tool use and one compaction, and shows spend when costs are on", async () => {
    const { tools } = boot({ showCost: true });
    heldRun();
    const id = registry().spawn(ctx(), ctx(), "general-purpose", "go", { description: "busy", isBackground: true });
    await flush();
    const record = registry().getRecord(id);
    record.toolUses = 1;
    record.compactionCount = 1;
    record.lifetimeUsage.cost = 0.25;

    const text = textOf(await tools.get("steer_subagent").execute("steer", { agent_id: id, message: "hurry" }, undefined, undefined, ctx()));

    expect(text).toContain("Current state: ");
    expect(text).toContain("$0.25");
    expect(text).toContain("1 tool use ·");
    expect(text).toContain("1 compaction");
    expect(text).not.toContain("compactions");

    record.compactionCount = 2;
    const again = textOf(await tools.get("steer_subagent").execute("steer", { agent_id: id, message: "again" }, undefined, undefined, ctx()));
    expect(again).toContain("2 compactions");
  });
});

describe("steer_subagent state line, spend and context", () => {
  it("leaves out a zero cost and reports the context window when the session knows it", async () => {
    const { tools } = boot({ showCost: true });
    const session = fakeSession();
    session.getSessionStats = () => ({ contextUsage: { percent: 41.6 } });
    heldRun(session);
    const id = registry().spawn(ctx(), ctx(), "general-purpose", "go", { description: "free", isBackground: true });
    await flush();

    const text = textOf(await tools.get("steer_subagent").execute("steer", { agent_id: id, message: "hurry" }, undefined, undefined, ctx()));

    expect(text).toContain("context 42% full");
    expect(text).not.toContain("$");
  });
});

describe("get_subagent_result waiting on an agent with no run promise yet", () => {
  it("returns its running status instead of waiting on nothing", async () => {
    const { tools } = boot();
    heldRun();
    const id = registry().spawn(ctx(), ctx(), "general-purpose", "go", { description: "starting", isBackground: true });
    await flush();
    // A worktree-isolated start has no promise until its repo copy exists.
    registry().getRecord(id).promise = undefined;

    const text = textOf(await tools.get("get_subagent_result").execute("read", { agent_id: id, wait: true }, new AbortController().signal, undefined, ctx()));

    expect(text).toContain("Status: running");
  });
});

describe("a quota-blocked dispatch that resolved through a tier", () => {
  it("leads the refusal with the tier note", async () => {
    const bus = new EventEmitter();
    bus.on(ADMIT_CHANNEL, (raw: { requestId: string }) => {
      queueMicrotask(() => bus.emit(`${ADMIT_CHANNEL}:reply:${raw.requestId}`, { success: true, data: { ok: false, resetAt: Date.now() + 3_600_000, wait: false } }));
    });
    const { tools } = boot({}, bus);
    const model = { provider: "fixture", id: "parent", name: "Parent", api: "openai-completions" };
    const parent = ctx({ model, modelRegistry: { find: () => model, getAll: () => [model], getAvailable: () => [model] } });

    await expect(tools.get("Agent").execute("tc", {
      prompt: "go", description: "tiered", subagent_type: "general-purpose", model: "@fast", run_in_background: false,
    }, undefined, undefined, parent)).rejects.toThrow(/model tier @fast is unmapped[\s\S]*The agent was not started\./);
  });
});

describe("scheduling a cron job that can never fire", () => {
  it("says the next run is unknown", async () => {
    const { tools } = boot({ schedulingEnabled: true });
    const parent = ctx({ sessionManager: { getSessionId: () => "never", getBranch: () => [] } });
    await lifecycle!.get("session_start")?.({ type: "session_start", reason: "startup" }, parent);

    const text = textOf(await tools.get("Agent").execute("tc", {
      prompt: "go", description: "leap", subagent_type: "general-purpose", schedule: "0 0 0 30 2 *",
    }, undefined, undefined, parent));

    expect(text).toContain("Next run: (unknown).");
  });
});
