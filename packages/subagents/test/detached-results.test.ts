/**
 * detached-results.test.ts -- background agents survive a session switch.
 *
 * `session_shutdown` fires for /new, /resume, /fork and /reload with the process
 * alive. Aborting there threw away every running background agent's findings.
 * Now only `quit` aborts; otherwise survivors finish in the orphaned manager and
 * their results are spooled for the session they belong to.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import {
  drainDetached,
  listRunningDetached,
  registerRunningDetached,
  spoolDetached,
  unregisterRunningDetached,
  watchDetached,
} from "../src/detached-results.js";
import { setAgentModels } from "../src/model-resolver.js";
import subagentsExtension from "./helpers/home-extension.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function ctx(sessionFile: string | undefined) {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: {
      getSessionId: vi.fn(() => "s1"),
      getBranch: vi.fn(() => []),
      getSessionFile: vi.fn(() => sessionFile),
    },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

describe("detached result spool", () => {
  const file = `/sessions/spool-${process.pid}-${Date.now()}.jsonl`;

  it("round-trips in order, deletes what it drains, and isolates sessions", () => {
    const mk = (id: string) => ({ id, content: `c-${id}`, details: { id }, record: { id } });
    spoolDetached(file, mk("a"));
    spoolDetached(file, mk("b"));
    spoolDetached(`${file}.other`, mk("z"));
    expect(drainDetached(file).map((r) => r.id)).toEqual(["a", "b"]);
    expect(drainDetached(file)).toEqual([]);
    expect(drainDetached(`${file}.other`).map((r) => r.id)).toEqual(["z"]);
  });

  it("wakes the watcher for its own session only, until unsubscribed", () => {
    const wake = vi.fn();
    const stop = watchDetached(file, wake);
    spoolDetached(`${file}.elsewhere`, { id: "x", content: "", details: {}, record: {} });
    expect(wake).not.toHaveBeenCalled();
    spoolDetached(file, { id: "y", content: "", details: {}, record: {} });
    expect(wake).toHaveBeenCalledTimes(1);
    stop();
    spoolDetached(file, { id: "w", content: "", details: {}, record: {} });
    expect(wake).toHaveBeenCalledTimes(1);
    drainDetached(file);
    drainDetached(`${file}.elsewhere`);
  });

  it("keeps a newer watcher when a replaced one unsubscribes late", () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = watchDetached(file, first);
    const stopSecond = watchDetached(file, second);
    stopFirst();
    spoolDetached(file, { id: "n", content: "", details: {}, record: {} });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    stopSecond();
    drainDetached(file);
  });

  it("names the spool directory for uid 0 where the platform has no getuid", async () => {
    const { detachedDir } = await import("../src/detached-results.js");
    const original = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
    try {
      expect(detachedDir(file)).toContain("pi-subagents-0");
    } finally {
      if (original) Object.defineProperty(process, "getuid", original);
      else delete (process as { getuid?: unknown }).getuid;
    }
  });

  it("drops a corrupt entry instead of failing the drain", async () => {
    const { detachedDir } = await import("../src/detached-results.js");
    writeFileSync(join(detachedDir(file), "0-bad.json"), "{nope");
    spoolDetached(file, { id: "ok", content: "", details: {}, record: {} });
    expect(drainDetached(file).map((r) => r.id)).toEqual(["ok"]);
  });
});

describe("running detached registry", () => {
  const file = `/sessions/running-${process.pid}-${Date.now()}.jsonl`;
  const mk = (id: string) => ({ record: { id } as any, abort: () => true, steer: () => true });

  it("lists per session in registration order and forgets settled agents", () => {
    registerRunningDetached(file, mk("a"));
    registerRunningDetached(file, mk("b"));
    registerRunningDetached(`${file}.other`, mk("z"));
    expect(listRunningDetached(file).map((d) => d.record.id)).toEqual(["a", "b"]);
    unregisterRunningDetached(file, "a");
    expect(listRunningDetached(file).map((d) => d.record.id)).toEqual(["b"]);
    unregisterRunningDetached(file, "b");
    expect(listRunningDetached(file)).toEqual([]);
    unregisterRunningDetached(`${file}.other`, "z");
  });

  it("returns nothing for an unknown or missing session", () => {
    expect(listRunningDetached(undefined)).toEqual([]);
    expect(listRunningDetached("/sessions/none.jsonl")).toEqual([]);
  });
});

describe("AgentManager.detach", () => {
  it("keeps running background agents and aborts foreground, queued and workflow ones", () => {
    const manager = new AgentManager(() => {});
    const mk = (id: string, status: string, extra: object) => {
      const abortController = { abort: vi.fn() };
      (manager as any).agents.set(id, { id, status, abortController, ...extra });
      return abortController;
    };
    const bg = mk("bg", "running", { isBackground: true });
    const nested = mk("nested", "running", { isBackground: false, parentAgentId: "bg" });
    const fg = mk("fg", "running", { isBackground: false });
    const wf = mk("wf", "running", { isBackground: true, workflowId: "w1" });

    expect(manager.detach()).toBe(2);
    expect(bg.abort).not.toHaveBeenCalled();
    expect(nested.abort).not.toHaveBeenCalled();
    expect(fg.abort).toHaveBeenCalled();
    expect(wf.abort).toHaveBeenCalled();
    expect((manager as any).agents.get("fg").status).toBe("stopped");
    expect((manager as any).agents.get("bg").status).toBe("running");
  });

  it("stops a queued top-level agent through onQueuedStop and keeps a queued nested child", () => {
    const onQueuedStop = vi.fn();
    const manager = new AgentManager(() => {}, undefined, undefined, undefined, undefined, undefined, undefined, undefined, onQueuedStop);
    const agents = Reflect.get(manager, "agents") as Map<string, { id: string; status: string; isBackground?: boolean; parentAgentId?: string }>;
    const entry = (id: string) => ({ id, record: agents.get(id), pool: "background", cancel: vi.fn(), release: vi.fn() });
    const queue = Reflect.get(manager, "queue") as Array<ReturnType<typeof entry>>;
    agents.set("q", { id: "q", status: "queued", isBackground: true });
    agents.set("child", { id: "child", status: "queued", parentAgentId: "bg" });
    queue.push(entry("q"), entry("child"));

    expect(manager.detach()).toBe(0);
    expect(onQueuedStop.mock.calls.map(([record]) => [record.id, record.status])).toEqual([["q", "stopped"]]);
    expect(agents.get("child")?.status).toBe("queued");
    expect((Reflect.get(manager, "queue") as Array<ReturnType<typeof entry>>).map((e) => e.id)).toEqual(["child"]);
  });
});

describe("AgentManager.rememberTombstone", () => {
  const entry = (id: string, handle: string, alias?: string) =>
    ({ id, handle, alias, type: "general-purpose", description: "d", sessionFile: `/s/${id}.jsonl`, completedAt: 1 }) as any;

  it("keeps a handed-over entry reopenable by id", () => {
    const manager = new AgentManager(() => {});
    manager.rememberTombstone(entry("a", "gp"));
    expect(manager.listTombstones().map(t => t.id)).toEqual(["a"]);
  });

  it("leaves a name held by a live agent, another tombstone or a reserved handle with its holder", () => {
    const manager = new AgentManager(() => {});
    const agents = Reflect.get(manager, "agents") as Map<string, object>;
    agents.set("live", { id: "live", handle: "gp", alias: "named" });
    manager.rememberTombstone(entry("a", "gp"));
    manager.rememberTombstone(entry("b", "other", "named"));
    expect(manager.listTombstones()).toEqual([]);

    agents.clear();
    manager.rememberTombstone(entry("c", "kept", "kept-alias"));
    manager.rememberTombstone(entry("d", "fresh", "kept-alias"));
    manager.rememberTombstone(entry("c", "kept", "kept-alias"));
    expect(manager.listTombstones().map(t => t.id)).toEqual(["c"]);

    manager.reservedHandles = () => ["busy"];
    manager.rememberTombstone(entry("e", "busy"));
    manager.rememberTombstone(entry("f", "x", "busy"));
    expect(manager.listTombstones().map(t => t.id)).toEqual(["c"]);
  });

  it("marks the note of an entry it could not keep, and keeps the rest for the session", () => {
    const manager = new AgentManager(() => {});
    manager.rememberEvicted({ id: "n", type: "general-purpose", description: "d", status: "completed", evictedAfterMin: 0 });
    manager.rememberTombstone(entry("k", "gp"));
    manager.rememberTombstone(entry("n", "gp"));
    expect(manager.getEvictedNote("n")?.nameTaken).toBe("gp");
    for (let i = 0; i < 101; i++) manager.rememberTombstone({ ...entry(`t${i}`, `h${i}`), completedAt: i + 1 });
    expect(manager.listTombstones()).toHaveLength(102);
  });

  it("names the held name in the note, alias or handle", () => {
    const manager = new AgentManager(() => {});
    const agents = Reflect.get(manager, "agents") as Map<string, object>;
    agents.set("live", { id: "live", handle: "gp", alias: "named" });
    const note = (id: string) => ({ id, type: "general-purpose", description: "d", status: "completed" as const, evictedAfterMin: 0 });
    manager.rememberEvicted(note("b"));
    manager.rememberTombstone(entry("b", "other", "named"));
    expect(manager.getEvictedNote("b")?.nameTaken).toBe("named");
    manager.rememberEvicted(note("c"));
    manager.rememberTombstone(entry("c", "gp", "free"));
    expect(manager.getEvictedNote("c")?.nameTaken).toBe("gp");
  });

  it("hands over only settled, reopenable records", () => {
    const manager = new AgentManager(() => {});
    const agents = Reflect.get(manager, "agents") as Map<string, object>;
    const done = { status: "completed", completedAt: 1, type: "general-purpose", description: "d" };
    agents.set("a", { id: "a", handle: "gp", sessionFile: "/s/a.jsonl", ...done });
    agents.set("b", { id: "b", handle: "gp-2", ...done });
    agents.set("c", { id: "c", handle: "gp-3", sessionFile: "/s/c.jsonl", status: "running" });
    agents.set("d", { id: "d", handle: "gp-4", sessionFile: "/s/d.jsonl", parentAgentId: "a", ...done });
    expect(manager.evictionTombstones(["a", "b", "c", "d"]).map(t => t.id)).toEqual(["a"]);
    expect(manager.evictionNotes(["a", "d"]).map(n => n.id)).toEqual(["a"]);
  });
});

describe("session switch with a running background agent", () => {
  let tmpDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let agentDir: string;
  const sessionFile = `/sessions/switch-${process.pid}-${Date.now()}.jsonl`;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-detach-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-detach-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    vi.useRealTimers();
    drainDetached(sessionFile);
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function spawnRunning(tools: Map<string, any>, parent = ctx(sessionFile), name?: string, agentSessionFile?: string) {
    let finish!: (v: any) => void;
    let signal: AbortSignal | undefined;
    vi.mocked(runAgent).mockImplementation(((_c: any, _t: any, _p: any, opts: any) => {
      signal = opts?.signal;
      if (agentSessionFile) opts?.onSessionCreated?.({ sessionManager: { getSessionFile: () => agentSessionFile }, dispose: vi.fn() });
      return new Promise((res) => {
        finish = res;
      });
    }) as any);
    const r = await tools.get("Agent").execute(
      "tc",
      { prompt: "go", description: "long reviewer", subagent_type: "general-purpose", run_in_background: true, ...(name ? { name } : {}) },
      undefined,
      undefined,
      parent,
    );
    const id = /Agent ID: (\S+)/.exec(r.content[0].text)![1];
    return { id, finish: () => finish({ responseText: "FINDINGS", session: { dispose: vi.fn() }, aborted: false, steered: false }), signal: () => signal };
  }

  it("does not abort on /new, and a later return to the session receives the result", async () => {
    const first = makePi();
    subagentsExtension(first.pi);
    await first.lifecycle.get("session_start")({ type: "session_start" }, ctx(sessionFile));
    const agent = await spawnRunning(first.tools);

    await first.lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "new" }, ctx(sessionFile));
    expect(agent.signal()?.aborted ?? false).toBe(false);

    agent.finish();
    await flush();
    // The orphaned instance must not talk to pi: its handle is stale.
    expect(first.pi.sendMessage).not.toHaveBeenCalled();

    const back = makePi();
    subagentsExtension(back.pi);
    await back.lifecycle.get("session_start")({ type: "session_start", reason: "resume" }, ctx(sessionFile));
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(back.pi.sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = back.pi.sendMessage.mock.calls[0];
    expect(msg.customType).toBe("subagent-notification");
    expect(msg.content).toContain("FINDINGS");
    expect(msg.content).toContain(agent.id);
    expect(opts).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(back.pi.appendEntry).toHaveBeenCalledWith("subagents:record", expect.objectContaining({ id: agent.id, status: "completed" }));
    await back.lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx(sessionFile));
  });

  it("keeps the model fallback on the spooled history record and the notice details", async () => {
    const first = makePi();
    subagentsExtension(first.pi);
    await first.lifecycle.get("session_start")({ type: "session_start" }, ctx(sessionFile));
    setAgentModels({ "general-purpose": "ghost-model" });
    const agent = await spawnRunning(first.tools);

    await first.lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "new" }, ctx(sessionFile));
    agent.finish();
    await flush();

    const back = makePi();
    subagentsExtension(back.pi);
    await back.lifecycle.get("session_start")({ type: "session_start", reason: "resume" }, ctx(sessionFile));
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(back.pi.appendEntry).toHaveBeenCalledWith(
      "subagents:record",
      expect.objectContaining({ id: agent.id, modelFallback: { input: "ghost-model" } }),
    );
    const [msg] = back.pi.sendMessage.mock.calls[0];
    expect(msg.details.modelNote).toContain('"ghost-model" did not resolve');
    await back.lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx(sessionFile));
    setAgentModels(undefined);
  });

  it("publishes the running agent for the next instance until it settles", async () => {
    const first = makePi();
    subagentsExtension(first.pi);
    await first.lifecycle.get("session_start")({ type: "session_start" }, ctx(sessionFile));
    const agent = await spawnRunning(first.tools);
    expect(listRunningDetached(sessionFile)).toEqual([]);

    await first.lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, ctx(sessionFile));
    expect(listRunningDetached(sessionFile).map((d) => d.record.id)).toEqual([agent.id]);

    agent.finish();
    await flush();
    expect(listRunningDetached(sessionFile)).toEqual([]);
  });

  it("lets the reopened session read and steer a survivor by id, handle and name (#330)", async () => {
    const first = makePi();
    subagentsExtension(first.pi);
    await first.lifecycle.get("session_start")({ type: "session_start" }, ctx(sessionFile));
    const agent = await spawnRunning(first.tools, ctx(sessionFile), "auth-audit");
    await first.lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, ctx(sessionFile));
    // Proves the survivor existed, with a handle, before the lookups below assert on it.
    const [survivor] = listRunningDetached(sessionFile);
    expect(survivor.record.id).toBe(agent.id);
    const { handle, alias } = survivor.record;
    expect(handle).toBeTruthy();
    expect(alias).toBe("auth-audit");

    const back = makePi();
    subagentsExtension(back.pi);
    await back.lifecycle.get("session_start")({ type: "session_start", reason: "resume" }, ctx(sessionFile));
    for (const ref of [agent.id, handle!, alias!]) {
      const got = await back.tools.get("get_subagent_result").execute("g", { agent_id: ref }, undefined, undefined, ctx(sessionFile));
      expect(got.content[0].text).not.toContain("Agent not found");
      expect(got.content[0].text).toContain("Status: running");
      const steered = await back.tools.get("steer_subagent").execute("s", { agent_id: ref, message: "hi" }, undefined, undefined, ctx(sessionFile));
      expect(steered.content[0].text).not.toContain("Agent not found");
    }
    const unknown = await back.tools.get("get_subagent_result").execute("g", { agent_id: "nope" }, undefined, undefined, ctx(sessionFile));
    expect(unknown.content[0].text).toContain("Agent not found");

    agent.finish();
    await flush();
    await back.lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx(sessionFile));
  });

  it("keeps a survivor that settled while detached answerable by id after its result is delivered (#330)", async () => {
    const first = makePi();
    subagentsExtension(first.pi);
    await first.lifecycle.get("session_start")({ type: "session_start" }, ctx(sessionFile));
    const agent = await spawnRunning(first.tools);
    await first.lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, ctx(sessionFile));
    agent.finish();
    await flush();

    const back = makePi();
    subagentsExtension(back.pi);
    await back.lifecycle.get("session_start")({ type: "session_start", reason: "resume" }, ctx(sessionFile));
    await new Promise(resolve => setTimeout(resolve, 250));
    // The notice names this id; its orphaned record is gone, so the fresh manager has never heard of it.
    expect(back.pi.sendMessage.mock.calls[0][0].content).toContain(agent.id);

    for (const tool of ["get_subagent_result", "steer_subagent"]) {
      const got = await back.tools.get(tool).execute("g", { agent_id: agent.id, message: "hi" }, undefined, undefined, ctx(sessionFile));
      expect(got.content[0].text).not.toContain("Agent not found");
      expect(got.content[0].text).toContain(agent.id);
      expect(got.content[0].text).toContain("completed");
    }
    await back.lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx(sessionFile));
  });

  it("steer after a detached finish reopens the survivor's saved session (#330)", async () => {
    const saved = join(tmpDir, "survivor-session.jsonl");
    writeFileSync(saved, "");
    const first = makePi();
    subagentsExtension(first.pi);
    await first.lifecycle.get("session_start")({ type: "session_start" }, ctx(sessionFile));
    const agent = await spawnRunning(first.tools, ctx(sessionFile), "auth-audit", saved);
    await first.lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, ctx(sessionFile));
    agent.finish();
    await flush();

    const back = makePi();
    subagentsExtension(back.pi);
    await back.lifecycle.get("session_start")({ type: "session_start", reason: "resume" }, ctx(sessionFile));
    await new Promise(resolve => setTimeout(resolve, 250));
    vi.mocked(runAgent).mockClear();
    vi.mocked(runAgent).mockImplementation((() => new Promise(() => {})) as any);

    const got = await back.tools.get("steer_subagent").execute("s", { agent_id: agent.id, message: "more" }, undefined, undefined, ctx(sessionFile));
    expect(got.content[0].text).not.toContain("Cannot resume");
    expect(got.content[0].text).toContain("Agent resumed in background");
    expect(got.content[0].text).toContain(`Session file: ${saved}`);
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAgent).mock.calls[0][3]).toEqual(expect.objectContaining({ resumeSessionFile: saved }));
    await back.lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx(sessionFile));
  });

  it("a survivor with no saved session says so plainly after a detached finish (#330)", async () => {
    const first = makePi();
    subagentsExtension(first.pi);
    await first.lifecycle.get("session_start")({ type: "session_start" }, ctx(sessionFile));
    const agent = await spawnRunning(first.tools);
    await first.lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "reload" }, ctx(sessionFile));
    agent.finish();
    await flush();
    const back = makePi();
    subagentsExtension(back.pi);
    await back.lifecycle.get("session_start")({ type: "session_start", reason: "resume" }, ctx(sessionFile));
    await new Promise(resolve => setTimeout(resolve, 250));
    const got = await back.tools.get("steer_subagent").execute("s", { agent_id: agent.id, message: "more" }, undefined, undefined, ctx(sessionFile));
    expect(got.content[0].text).toContain(`Cannot resume agent "${agent.id}": no saved session is left to reopen.`);
    expect(got.content[0].text).not.toContain("Agent not found");
    await back.lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx(sessionFile));
  });

  it("says why when a delivered survivor's name already belongs to another conversation (#330)", async () => {
    const saved = join(tmpDir, "named-session.jsonl");
    writeFileSync(saved, "");
    const result = (id: string) => ({
      id,
      content: `<task-notification>${id}</task-notification>`,
      details: { id },
      evicted: [{ id, type: "general-purpose", description: "d", status: "completed", evictedAfterMin: 0 }],
      tombstones: [{ id, handle: "gp", type: "general-purpose", description: "d", sessionFile: saved, completedAt: 1 }],
    });
    spoolDetached(sessionFile, result("first-1"));
    spoolDetached(sessionFile, result("second-1"));
    const back = makePi();
    subagentsExtension(back.pi);
    await back.lifecycle.get("session_start")({ type: "session_start", reason: "resume" }, ctx(sessionFile));
    await new Promise(resolve => setTimeout(resolve, 250));
    const got = await back.tools.get("steer_subagent").execute("s", { agent_id: "second-1", message: "more" }, undefined, undefined, ctx(sessionFile));
    expect(got.content[0].text).toContain('Cannot resume agent "second-1": its name "gp" now belongs to another agent');
    expect(got.content[0].text).not.toContain("no saved session is left");
    await back.lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx(sessionFile));
  });

  it("still delivers a spooled result written without an eviction note", async () => {
    const back = makePi();
    subagentsExtension(back.pi);
    spoolDetached(sessionFile, {
      id: "legacy-1",
      content: "<task-notification>legacy</task-notification>",
      details: { id: "legacy-1" },
    });
    await back.lifecycle.get("session_start")({ type: "session_start", reason: "resume" }, ctx(sessionFile));
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(back.pi.sendMessage).toHaveBeenCalledTimes(1);
    const got = await back.tools.get("get_subagent_result").execute("g", { agent_id: "legacy-1" }, undefined, undefined, ctx(sessionFile));
    expect(got.content[0].text).toContain("Agent not found");
    await back.lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx(sessionFile));
  });

  it("delivers immediately when the agent finishes while its session is open again", async () => {
    const first = makePi();
    subagentsExtension(first.pi);
    await first.lifecycle.get("session_start")({ type: "session_start" }, ctx(sessionFile));
    const agent = await spawnRunning(first.tools);
    await first.lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "resume" }, ctx(sessionFile));

    const back = makePi();
    subagentsExtension(back.pi);
    await back.lifecycle.get("session_start")({ type: "session_start", reason: "resume" }, ctx(sessionFile));
    expect(back.pi.sendMessage).not.toHaveBeenCalled();

    agent.finish();
    await flush();
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(back.pi.sendMessage).toHaveBeenCalledTimes(1);
    await back.lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx(sessionFile));
  });

  it.each(["smart", "group"])("transfers held %s completions once, without repeating their history", async (joinMode) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, defaultJoinMode: joinMode }));
    const first = makePi();
    subagentsExtension(first.pi);
    const parent = ctx(sessionFile);
    parent.signal = new AbortController().signal;
    await first.lifecycle.get("session_start")({ type: "session_start" }, parent);
    // Every spawn in this turn is still waiting for the parent's boundary.
    const agent = await spawnRunning(first.tools, parent);
    agent.finish();
    await flush();
    expect(first.pi.sendMessage).not.toHaveBeenCalled();

    await first.lifecycle.get("session_before_switch")?.();
    await first.lifecycle.get("session_shutdown")({ reason: "reload" });
    const back = makePi();
    subagentsExtension(back.pi);
    await back.lifecycle.get("session_start")({ type: "session_start" }, ctx(sessionFile));
    await vi.advanceTimersByTimeAsync(200);
    expect(back.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(back.pi.sendMessage.mock.calls[0][0].content).toContain("FINDINGS");
    expect(back.pi.appendEntry).not.toHaveBeenCalledWith("subagents:record", expect.anything());
    await vi.advanceTimersByTimeAsync(1000);
    expect(back.pi.sendMessage).toHaveBeenCalledTimes(1);
    await back.lifecycle.get("session_shutdown")({ reason: "quit" });
  });

  it("keeps every agent in a held notice answerable after the switch (#330)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = makePi();
    subagentsExtension(first.pi);
    const parent = ctx(sessionFile);
    parent.signal = new AbortController().signal;
    await first.lifecycle.get("session_start")({ type: "session_start" }, parent);
    const one = await spawnRunning(first.tools, parent);
    const two = await spawnRunning(first.tools, parent);
    one.finish();
    two.finish();
    await flush();
    expect(first.pi.sendMessage).not.toHaveBeenCalled();

    await first.lifecycle.get("session_before_switch")?.();
    await first.lifecycle.get("session_shutdown")({ reason: "reload" });
    const back = makePi();
    subagentsExtension(back.pi);
    await back.lifecycle.get("session_start")({ type: "session_start" }, ctx(sessionFile));
    for (const { id } of [one, two]) {
      const got = await back.tools.get("get_subagent_result").execute("g", { agent_id: id }, undefined, undefined, ctx(sessionFile));
      expect(got.content[0].text).not.toContain("Agent not found");
      expect(got.content[0].text).toContain(id);
    }
    await back.lifecycle.get("session_shutdown")({ reason: "quit" });
  });

  it("a held notice's agent with a saved session reopens on steer after the switch (#330)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const saved = join(tmpDir, "held-session.jsonl");
    writeFileSync(saved, "");
    const first = makePi();
    subagentsExtension(first.pi);
    const parent = ctx(sessionFile);
    parent.signal = new AbortController().signal;
    await first.lifecycle.get("session_start")({ type: "session_start" }, parent);
    const one = await spawnRunning(first.tools, parent, undefined, saved);
    one.finish();
    await flush();
    await first.lifecycle.get("session_before_switch")?.();
    await first.lifecycle.get("session_shutdown")({ reason: "reload" });
    const back = makePi();
    subagentsExtension(back.pi);
    await back.lifecycle.get("session_start")({ type: "session_start" }, ctx(sessionFile));
    vi.mocked(runAgent).mockClear();
    vi.mocked(runAgent).mockImplementation((() => new Promise(() => {})) as any);
    const got = await back.tools.get("steer_subagent").execute("s", { agent_id: one.id, message: "more" }, undefined, undefined, ctx(sessionFile));
    expect(got.content[0].text).not.toContain("Cannot resume");
    expect(got.content[0].text).toContain(`Session file: ${saved}`);
    expect(vi.mocked(runAgent).mock.calls[0][3]).toEqual(expect.objectContaining({ resumeSessionFile: saved }));
    await back.lifecycle.get("session_shutdown")({ reason: "quit" });
  });

  it.each(["consumed", "delivered"])("does not replay a result already %s before a switch", async (handled) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = makePi();
    subagentsExtension(first.pi);
    await first.lifecycle.get("session_start")({ type: "session_start" }, ctx(sessionFile));
    const agent = await spawnRunning(first.tools);
    agent.finish();
    await flush();
    if (handled === "consumed") {
      await first.tools.get("get_subagent_result").execute("read", { agent_id: agent.id }, undefined, undefined, ctx(sessionFile));
    } else {
      await vi.advanceTimersByTimeAsync(200);
      expect(first.pi.sendMessage).toHaveBeenCalledOnce();
    }
    await first.lifecycle.get("session_shutdown")({ reason: "new" });
    const back = makePi();
    subagentsExtension(back.pi);
    await back.lifecycle.get("session_start")({ type: "session_start" }, ctx(sessionFile));
    await vi.advanceTimersByTimeAsync(1000);
    expect(back.pi.sendMessage).not.toHaveBeenCalled();
    await back.lifecycle.get("session_shutdown")({ reason: "quit" });
  });

  it("holds a detached result for the reopened parent's boundary and coalesces completions", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = makePi();
    subagentsExtension(first.pi);
    await first.lifecycle.get("session_start")({ type: "session_start" }, ctx(sessionFile));
    const one = await spawnRunning(first.tools);
    const two = await spawnRunning(first.tools);
    await first.lifecycle.get("session_shutdown")({ reason: "reload" });
    const back = makePi();
    subagentsExtension(back.pi);
    const parent = ctx(sessionFile);
    parent.signal = new AbortController().signal;
    await back.lifecycle.get("session_start")({ type: "session_start" }, parent);
    one.finish();
    two.finish();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(back.pi.sendMessage).not.toHaveBeenCalled();
    back.lifecycle.get("turn_end")({ type: "turn_end", message: { role: "assistant", stopReason: "toolUse" } });
    expect(back.pi.sendMessage).toHaveBeenCalledOnce();
    const details = back.pi.sendMessage.mock.calls[0][0].details;
    expect([details.id, ...details.others.map((other: any) => other.id)].sort()).toEqual([one.id, two.id].sort());
    await back.lifecycle.get("session_shutdown")({ reason: "quit" });
  });

  it("still aborts on quit", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    await lifecycle.get("session_start")({ type: "session_start" }, ctx(sessionFile));
    const agent = await spawnRunning(tools);
    await lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx(sessionFile));
    expect(agent.signal()?.aborted).toBe(true);
  });

  it("still aborts when the session has no file to hand results back to", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    await lifecycle.get("session_start")({ type: "session_start" }, ctx(undefined));
    const agent = await spawnRunning(tools);
    await lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "new" }, ctx(undefined));
    expect(agent.signal()?.aborted).toBe(true);
  });
});
