/**
 * config-model-fallback-provenance.test.ts -- the model-fallback provenance must
 * survive every place an AgentRecord is copied, evicted, reopened, serialized or
 * announced: tombstone + @handle reopen, evicted-id lookup, the transcript, and
 * the per-message usage event. (The detached spool is in detached-results.test.ts,
 * the persisted history entry and completion event in
 * config-model-fallback-wiring.test.ts.)
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunner from "../src/agent-runner.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunner>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { setAgentModels } from "../src/model-resolver.js";
import { flush, makePi, startSession, textOf } from "./helpers/boot-extension.js";
import subagentsExtension from "./helpers/home-extension.js";
import { runnerResolution } from "./helpers/runner-resolution.js";

const PARENT = { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" };
const NOTE = 'Note: configured model "claude-haiku-4-5" did not resolve; running on parent model anthropic/claude-sonnet-5-5.';
const FALLBACK = { input: "claude-haiku-4-5", used: "anthropic/claude-sonnet-5-5" };

let cwd: string;
let saved: { cwd: string; agentDir?: string };
let sessionFile: string;

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
  cwd = mkdtempSync(join(tmpdir(), "config-model-prov-"));
  process.chdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "agents", "scout.md"), "---\ndescription: scout\ntools: read\nmodel: claude-haiku-4-5\n---\nscout.\n");
  mkdirSync(join(cwd, "agent-dir"), { recursive: true });
  writeFileSync(join(cwd, "agent-dir", "subagents.json"), JSON.stringify({ agentMentions: "direct" }));
  sessionFile = join(cwd, "session.jsonl");
  writeFileSync(sessionFile, "");
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  setAgentModels(undefined);
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

describe("eviction, tombstone and @handle reopen", () => {
  it("an evicted id discloses its failure while a reopened @handle uses current selection", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
    const { tools, lifecycle } = await boot();
    vi.mocked(runAgent).mockImplementation(runnerResolution() as any);
    const started = await tools.get("Agent").execute(
      "tc", { prompt: "go", description: "d", subagent_type: "scout", run_in_background: true }, undefined, undefined, ctx(),
    );
    const id = started.details.agentId;
    await flush();
    const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    expect(manager.getRecord(id).modelFallback).toEqual(FALLBACK);
    // Age it past the cutoff and let the real GC evict it (as agent-mention-wiring does).
    const record = manager.getRecord(id);
    record.sessionFile = sessionFile;
    record.resultConsumed = true;
    record.completedAt = Date.now() - 11 * 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.getRecord(id)).toBeUndefined();

    // 1. the evicted id's lookup text
    const gone = await tools.get("get_subagent_result").execute("tc2", { agent_id: id }, undefined, undefined, ctx());
    expect(textOf(gone)).toContain(NOTE);

    // 2. reopen: the CURRENT config now inherits the parent (the definition's
    // model is gone), so its disclosure must not repeat the old failure.
    writeFileSync(join(cwd, ".pi", "agents", "scout.md"), "---\ndescription: scout\ntools: read\n---\nscout.\n");
    vi.mocked(runAgent).mockImplementation((async (_c: any, _t: string, _p: string, o: any) => {
      o.onSessionCreated?.({ dispose: vi.fn(), messages: [], model: PARENT });
      return new Promise(() => {});
    }) as any);
    const handled = await lifecycle.get("input")?.({ type: "input", text: "@scout again", source: "interactive" } as any, ctx());
    await flush();

    expect(handled).toEqual({ action: "handled" });
    const reopened = await tools.get("get_subagent_result").execute("tc3", { agent_id: "scout" }, undefined, undefined, ctx());
    expect(textOf(reopened)).not.toContain(NOTE);
    vi.useRealTimers();
  });
});

describe("transcript", () => {
  it("records a model-fallback line in the .output transcript", async () => {
    const { tools } = await boot();
    // Session creation is async in real pi, after the transcript file is attached.
    vi.mocked(runAgent).mockImplementation((async (c: any, t: string, p: string, o: any) => {
      await new Promise((r) => setImmediate(r));
      return runnerResolution({ hold: true })(c, t, p, o);
    }) as any);

    const started = await tools.get("Agent").execute(
      "tc", { prompt: "go", description: "d", subagent_type: "scout", run_in_background: true }, undefined, undefined, ctx(),
    );
    await flush();

    const file = /Output file: (\S+)/.exec(textOf(started))![1];
    const lines = readFileSync(file, "utf-8").trim().split("\n").map(l => JSON.parse(l));
    const entry = lines.find(l => l.type === "model-fallback");
    expect(entry?.modelFallback).toEqual(FALLBACK);
    expect(entry?.note).toBe(NOTE);
  });
});

describe("subagents:usage event", () => {
  it("carries the fallback on every usage message", async () => {
    const { pi, tools } = await boot();
    vi.mocked(runAgent).mockImplementation((async (c: any, t: string, p: string, o: any) => {
      const out = await runnerResolution()(c, t, p, o);
      o.onAssistantUsage?.({ input: 10, output: 5, cacheWrite: 0, cost: 0.001 });
      return out;
    }) as any);

    await tools.get("Agent").execute(
      "tc", { prompt: "go", description: "d", subagent_type: "scout", run_in_background: false }, undefined, undefined, ctx(),
    );

    const usage = pi.events.emit.mock.calls.filter((c: any[]) => c[0] === "subagents:usage").map((c: any[]) => c[1]);
    expect(usage.length).toBeGreaterThan(0);
    expect(usage[0].modelFallback).toEqual(FALLBACK);
    expect(usage[0].modelNote).toBe(NOTE);
  });
});

describe("lifecycle events", () => {
  const eventsNamed = (pi: any, name: string) => pi.events.emit.mock.calls.filter((c: any[]) => c[0] === name).map((c: any[]) => c[1]);

  it("created, started and compacted carry a fallback the spawn path already resolved", async () => {
    const { pi, tools } = await boot();
    vi.mocked(runAgent).mockImplementation((async (c: any, t: string, p: string, o: any) => {
      o.onCompaction?.({ reason: "manual", tokensBefore: 10 });
      return runnerResolution()(c, t, p, o);
    }) as any);

    await tools.get("Agent").execute(
      "tc", { prompt: "go", description: "d", subagent_type: "scout", run_in_background: true }, undefined, undefined, ctx(),
    );
    await flush();

    for (const name of ["subagents:created", "subagents:started", "subagents:compacted"]) {
      const [event] = eventsNamed(pi, name);
      expect(event?.modelFallback, name).toEqual(FALLBACK);
      expect(event?.modelNote, name).toBe(NOTE);
    }
  });

  it("shared spawn records RPC defaults before started, usage and completion", async () => {
    const { pi } = await boot();
    vi.mocked(runAgent).mockImplementation((async (c: any, t: string, p: string, o: any) => {
      const out = await runnerResolution()(c, t, p, o);
      o.onAssistantUsage?.({ input: 1, output: 1, cacheWrite: 0, cost: 0.001 });
      return out;
    }) as any);
    // RPC/registry spawn: shared spawn selects even without tool-side preflight.
    const id = (globalThis as any)[Symbol.for("pi-subagents:manager")].spawn(pi, ctx(), "scout", "go", { description: "rpc" });
    await flush();

    expect(eventsNamed(pi, "subagents:started").find((e: any) => e.id === id)?.modelFallback).toEqual(FALLBACK);
    expect(eventsNamed(pi, "subagents:usage").find((e: any) => e.id === id)?.modelFallback).toEqual(FALLBACK);
    expect(eventsNamed(pi, "subagents:completed").find((e: any) => e.id === id)?.modelFallback).toEqual(FALLBACK);
  });
});

describe("background resume transcript", () => {
  it("a transcript created for a later resume still records the original fallback", async () => {
    const { tools } = await boot();
    vi.mocked(runAgent).mockImplementation(runnerResolution() as any);
    vi.mocked(resumeAgent).mockResolvedValue({ text: "again", aborted: false, steered: false } as any);

    const first = await tools.get("Agent").execute(
      "tc", { prompt: "go", description: "d", subagent_type: "scout", run_in_background: true }, undefined, undefined, ctx(),
    );
    await flush();
    const file = /Output file: (\S+)/.exec(textOf(first))![1];
    // Transcripts were off for the first run in the scenario: the resume creates a fresh file.
    rmSync(file);
    expect(existsSync(file)).toBe(false);

    const resumed = await tools.get("Agent").execute(
      "tc2", { prompt: "more", description: "d", subagent_type: "scout", resume: first.details.agentId, run_in_background: true }, undefined, undefined, ctx(),
    );
    await flush();

    expect(textOf(resumed)).toContain("resumed in background");
    const lines = readFileSync(file, "utf-8").trim().split("\n").map(l => JSON.parse(l));
    expect(lines.find(l => l.type === "model-fallback")?.modelFallback).toEqual(FALLBACK);
  });
});
