/**
 * lifecycle-identity.test.ts -- top-level lifecycle events carry the agent's
 * `handle` and spawner-`name` handle, so a listener (pi-todo's owner column)
 * can match an agent by what the parent typed instead of only its id (#444).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatInProgressNotice } from "../../todo/plan-hooks.ts";
import { agentLookup, agentStateFor, applyAgentEvent, forgetAgents } from "../../todo/state/agents.ts";
import type * as AgentRunner from "../src/agent-runner.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunner>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { flush, makePi, startSession } from "./helpers/boot-extension.js";
import subagentsExtension from "./helpers/home-extension.js";
import { runnerResolution } from "./helpers/runner-resolution.js";

const PARENT = { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" };
const LIFECYCLE = ["subagents:created", "subagents:started", "subagents:compacted", "subagents:completed"];

let cwd: string;
let saved: { cwd: string; agentDir?: string };

function ctx() {
  return {
    hasUI: false, mode: "tui", cwd, model: PARENT,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(), addAutocompleteProvider: vi.fn() },
    modelRegistry: { find: (p: string, i: string) => (p === PARENT.provider && i === PARENT.id ? PARENT : undefined), getAll: () => [PARENT], getAvailable: () => [PARENT] },
    sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
    getSystemPrompt: () => "parent",
  } as any;
}

beforeEach(() => {
  saved = { cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR };
  cwd = mkdtempSync(join(tmpdir(), "lifecycle-identity-"));
  process.chdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "agents", "scout.md"), "---\ndescription: scout\ntools: read\n---\nscout.\n");
  mkdirSync(join(cwd, "agent-dir"), { recursive: true });
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
});

afterEach(() => {
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  process.chdir(saved.cwd);
  if (saved.agentDir == null) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
  registerAgents(new Map());
  rmSync(cwd, { recursive: true, force: true });
});

async function boot() {
  const b = makePi();
  subagentsExtension(b.pi);
  await startSession(b.lifecycle, true);
  return b;
}

const eventsNamed = (pi: any, name: string) =>
  pi.events.emit.mock.calls.filter((c: any[]) => c[0] === name).map((c: any[]) => c[1]);

describe("lifecycle event identity", () => {
  it("created, started, compacted and completed carry handle and the spawner's name", async () => {
    const { pi, tools } = await boot();
    vi.mocked(runAgent).mockImplementation((async (c: any, t: string, p: string, o: any) => {
      o.onCompaction?.({ reason: "manual", tokensBefore: 10 });
      return runnerResolution()(c, t, p, o);
    }) as any);

    await tools.get("Agent").execute(
      "tc",
      { prompt: "go", description: "audit", subagent_type: "scout", name: "Auth Audit", run_in_background: true },
      undefined, undefined, ctx(),
    );
    await flush();

    for (const name of LIFECYCLE) {
      const [event] = eventsNamed(pi, name);
      expect(event, name).toMatchObject({ handle: "scout", name: "auth-audit", nameBase: "auth-audit" });
    }
  });

  it("a background resume re-announces the record's own identity on created", async () => {
    const { pi, tools } = await boot();
    vi.mocked(runAgent).mockImplementation(runnerResolution() as any);
    vi.mocked(resumeAgent).mockResolvedValue({ text: "again", aborted: false, steered: false } as any);
    const first = await tools.get("Agent").execute(
      "tc",
      { prompt: "go", description: "audit", subagent_type: "scout", name: "Auth Audit", run_in_background: true },
      undefined, undefined, ctx(),
    );
    await flush();
    const id = /Agent ID: (\S+)/.exec(first.content.map((c: any) => c.text ?? "").join(""))![1];
    pi.events.emit.mockClear();

    await tools.get("Agent").execute(
      "tc2",
      { prompt: "more", description: "more", subagent_type: "scout", resume: id, run_in_background: true },
      undefined, undefined, ctx(),
    );
    await flush();

    expect(eventsNamed(pi, "subagents:created")).toEqual([
      expect.objectContaining({ id, handle: "scout", name: "auth-audit", isBackground: true }),
    ]);
  });

  it.each(["done", "failed"])("tracks a queued background resume after %s without accepting a stale created", async (outcome) => {
    writeFileSync(join(cwd, "agent-dir", "subagents.json"), JSON.stringify({ maxConcurrent: 1 }));
    const { pi, tools } = await boot();
    pi.events.emit.mockImplementation((channel: string, data: unknown) => applyAgentEvent("resume-s1", channel, data));
    const resolve = runnerResolution();
    vi.mocked(runAgent).mockImplementationOnce(async (context, type, prompt, options) => {
      const result = await resolve(context, type, prompt, options);
      if (outcome === "failed") throw new Error("first run failed");
      return result;
    }).mockImplementation(runnerResolution({ hold: true }));
    const spawn = (name: string) => tools.get("Agent").execute(
      "tc", { prompt: "go", description: name, subagent_type: "scout", name, run_in_background: true },
      undefined, undefined, ctx(),
    );
    const first = await spawn("Auth Audit");
    await flush();
    const id = /Agent ID: (\S+)/.exec(first.content.map((c: any) => c.text ?? "").join(""))![1];
    expect(agentStateFor("resume-s1", "auth-audit")).toBe(outcome);
    const stale = eventsNamed(pi, "subagents:created").find((e: any) => e.id === id);
    pi.events.emit("subagents:created", stale);
    expect(agentStateFor("resume-s1", "auth-audit")).toBe(outcome);
    await spawn("Blocker");
    await flush();
    const before = eventsNamed(pi, "subagents:created").length;
    await tools.get("Agent").execute(
      "resume", { prompt: "again", description: "resume", subagent_type: "scout", resume: id, run_in_background: true },
      undefined, undefined, ctx(),
    );
    expect((globalThis as any)[Symbol.for("pi-subagents:manager")].getRecord(id).status).toBe("queued");
    expect(eventsNamed(pi, "subagents:created")).toHaveLength(before + 1);
    expect(agentStateFor("resume-s1", "auth-audit")).toBe("queued");
    expect(agentLookup("resume-s1").wakesParent?.("auth-audit")).toBe(true);
    forgetAgents("resume-s1");
  });

  it.each([false, true])("classifies actual RPC completion wake eligibility: background=%s", async (isBackground) => {
    const b = makePi();
    const handlers = new Map<string, Array<(data: unknown) => void>>();
    b.pi.events.on.mockImplementation((name: string, handler: (data: unknown) => void) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {};
    });
    b.pi.events.emit.mockImplementation((name: string, data: unknown) => {
      applyAgentEvent("rpc-wake", name, data);
      for (const handler of handlers.get(name) ?? []) handler(data);
    });
    subagentsExtension(b.pi);
    await startSession(b.lifecycle, true, { model: PARENT, modelRegistry: ctx().modelRegistry });
    let finish!: (result: Awaited<ReturnType<typeof runAgent>>) => void;
    vi.mocked(runAgent).mockImplementation((_context, _type, _prompt, options) => {
      const session = { dispose: vi.fn(), messages: [], model: PARENT };
      options?.onSessionCreated?.(session as never);
      return new Promise((resolve) => { finish = resolve; });
    });
    let id = "";
    b.pi.events.on("subagents:rpc:spawn:reply:wake", (reply: { data: { id: string } }) => { id = reply.data.id; });
    b.pi.events.emit("subagents:rpc:spawn", { requestId: "wake", type: "scout", prompt: "go", options: { description: "rpc", isBackground } });
    await flush();
    expect(id).not.toBe("");
    const state = { tasks: [{ id: 1, subject: "Audit", status: "in_progress", owner: id }], nextId: 2 } as never;
    const notice = formatInProgressNotice(state, agentLookup("rpc-wake"));
    finish({ responseText: "done", session: { dispose: vi.fn(), messages: [], model: PARENT }, aborted: false, steered: false } as never);
    await flush();
    const manager = Reflect.get(globalThis, Symbol.for("pi-subagents:manager")) as { getRecord(id: string): { resultConsumed?: boolean } };
    expect(Boolean(manager.getRecord(id).resultConsumed)).toBe(!isBackground);
    expect(notice?.level).toBe(isBackground ? "info" : "warning");
    forgetAgents("rpc-wake");
  });

  it("omits name for an unnamed spawn and keeps handle on a failure", async () => {
    const { pi } = await boot();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));
    const id = (globalThis as any)[Symbol.for("pi-subagents:manager")].spawn(pi, ctx(), "scout", "go", { description: "rpc" });
    await flush();

    const started = eventsNamed(pi, "subagents:started").find((e: any) => e.id === id);
    const failed = eventsNamed(pi, "subagents:failed").find((e: any) => e.id === id);
    expect(started).toMatchObject({ handle: "scout" });
    expect(failed).toMatchObject({ handle: "scout", status: "error" });
    expect(started).not.toHaveProperty("name");
    expect(failed).not.toHaveProperty("name");
    expect(started).not.toHaveProperty("nameBase");
  });

  it("a retry under a name still held is numbered, with the unsuffixed nameBase", async () => {
    const { pi } = await boot();
    vi.mocked(runAgent).mockImplementation(runnerResolution({ hold: true }) as any);
    const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    const first = manager.spawn(pi, ctx(), "scout", "go", { description: "try", name: "Auth Audit" });
    const retry = manager.spawn(pi, ctx(), "scout", "go", { description: "retry", name: "Auth Audit" });
    await flush();

    const started = eventsNamed(pi, "subagents:started");
    expect(started.find((e: any) => e.id === first)).toMatchObject({ name: "auth-audit", nameBase: "auth-audit" });
    expect(started.find((e: any) => e.id === retry)).toMatchObject({ name: "auth-audit-2", nameBase: "auth-audit" });
  });

  it("orders a queued spawn before the settle that dequeued it (spawnSeq < settleSeq)", async () => {
    writeFileSync(join(cwd, "agent-dir", "subagents.json"), JSON.stringify({ maxConcurrent: 1 }));
    const { pi } = await boot();
    const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    let failFirst!: (err: Error) => void;
    vi.mocked(runAgent)
      .mockImplementationOnce((() => new Promise((_resolve, reject) => { failFirst = reject; })) as any)
      .mockImplementation(runnerResolution({ hold: true }) as any);
    const first = manager.spawn(pi, ctx(), "scout", "go", { description: "a", name: "Auth Audit", isBackground: true });
    const queued = manager.spawn(pi, ctx(), "scout", "go", { description: "b", name: "Auth Audit", isBackground: true });
    await flush();
    expect(eventsNamed(pi, "subagents:started").map((e: any) => e.id)).toEqual([first]);

    failFirst(new Error("boom"));
    await flush();

    const failed = eventsNamed(pi, "subagents:failed").find((e: any) => e.id === first);
    const started = eventsNamed(pi, "subagents:started").find((e: any) => e.id === queued);
    expect(started).toMatchObject({ name: "auth-audit-2", nameBase: "auth-audit" });
    expect(typeof failed.settleSeq).toBe("number");
    expect(started.spawnSeq).toBeLessThan(failed.settleSeq);
    expect(eventsNamed(pi, "subagents:started").find((e: any) => e.id === first).spawnSeq).toBeLessThan(started.spawnSeq);
    expect(started).not.toHaveProperty("settleSeq");
  });

  it("a queued Agent spawn stopped before it starts emits failed with status stopped", async () => {
    writeFileSync(join(cwd, "agent-dir", "subagents.json"), JSON.stringify({ maxConcurrent: 1 }));
    const { pi, tools } = await boot();
    const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    vi.mocked(runAgent).mockImplementation(runnerResolution({ hold: true }));
    const spawn = (name: string) =>
      tools.get("Agent").execute(
        "tc",
        { prompt: "go", description: name, subagent_type: "scout", name, run_in_background: true },
        undefined, undefined, ctx(),
      );
    await spawn("Blocker");
    const queued = await spawn("Auth Audit");
    await flush();
    const id = /Agent ID: (\S+)/.exec(queued.content.map((c: any) => c.text ?? "").join(""))![1];
    expect(manager.getRecord(id).status).toBe("queued");
    expect(eventsNamed(pi, "subagents:created").map((e: any) => e.id)).toContain(id);

    await tools.get("stop_subagent").execute("tc-stop", { agent_id: id }, undefined, undefined, ctx());
    expect(manager.getRecord(id).status).toBe("stopped");

    const failed = eventsNamed(pi, "subagents:failed").filter((e: any) => e.id === id);
    expect(failed).toEqual([
      expect.objectContaining({ id, status: "stopped", handle: "scout-2", name: "auth-audit", nameBase: "auth-audit" }),
    ]);
    expect(typeof failed[0].settleSeq).toBe("number");
    expect(eventsNamed(pi, "subagents:started").map((e: any) => e.id)).not.toContain(id);
  });
});
