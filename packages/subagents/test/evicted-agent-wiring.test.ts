/**
 * evicted-agent-wiring.test.ts — an evicted record answers with what became of
 * it, through the REAL get_subagent_result and steer_subagent tools.
 *
 * Before, an id whose record the GC had dropped read as "Agent not found. It may
 * have been cleaned up.", which an orchestrator cannot tell from a typo. Now the
 * manager keeps a note and the tools say "completed, evicted after N min" with
 * the transcript path.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import { bootPi } from "./helpers/boot-extension.js";
import subagentsExtension from "./helpers/home-extension.js";


function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;
// Let runAgent's resolved .then() chain settle so the record reaches "completed".
const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

// Spawn a real background agent and drive it to status "completed" with
// resultConsumed=false (only get_subagent_result sets that flag for background).
async function spawnCompletedBackgroundAgent(tools: Map<string, any>): Promise<string> {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "THE-RESULT-PAYLOAD",
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: false,
  });
  const spawn = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "Review monero_en.rs in depth", subagent_type: "general-purpose", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];
  expect(id, "background spawn should surface an agent id").toBeTruthy();
  await flush();
  return id as string;
}


describe("evicted agents", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  // The extension under test, loaded per case. afterEach shuts it down so a failing
  // case cannot leave the global manager slot claimed for the next (#481).
  let lifecycle: ReturnType<typeof bootPi>["lifecycle"] | undefined;

  function load(): ReturnType<typeof bootPi>["tools"] {
    const made = bootPi();
    subagentsExtension(made.pi);
    lifecycle = made.lifecycle;
    return made.tools;
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-evicted-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-evicted-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    process.chdir(tmpDir);
    // Only the clock and the GC interval; real timers keep the flush helper working.
    // The completion outbox's `NOTIFICATION_HOLD_MS` setTimeout stays real too, so a
    // case must consume a result through the tools before advancing the clock, or
    // keep the notice preview-only so delivering it does not consume (#481).
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  });

  afterEach(async () => {
    await lifecycle?.get("session_shutdown")?.({}, ctx());
    lifecycle = undefined;
    vi.useRealTimers();
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("get_subagent_result and steer_subagent say it was evicted, not that it was never there", async () => {
    const tools = load();
    const id = await spawnCompletedBackgroundAgent(tools);

    const read = await tools.get("get_subagent_result").execute("tc-read", { agent_id: id }, undefined, undefined, ctx());
    expect(textOf(read)).toContain("THE-RESULT-PAYLOAD");

    // Read, so the 10-minute window applies; the 60-second tick that follows evicts it.
    await vi.advanceTimersByTimeAsync(11 * 60_000 + 60_000);

    for (const [name, params] of [
      ["get_subagent_result", { agent_id: id }],
      ["steer_subagent", { agent_id: id, message: "hello" }],
    ] as const) {
      const out = textOf(await tools.get(name).execute("tc", params, undefined, undefined, ctx()));
      expect(out).toContain(`Agent "${id}"`);
      expect(out).toMatch(/completed, evicted after \d+ min/);
      expect(out).not.toContain("Agent not found");
    }
  });

  it.each([
    ["nested", { parentAgentId: "someone-else" }],
    ["workflow", { workflowId: "run-1" }],
  ] as const)("keeps an evicted %s child unreachable from get_subagent_result and steer_subagent", async (_kind, owner) => {
    // Live, an owned child answers "Agent not found" to the top-level tools;
    // eviction must not turn its description and transcript into an answer.
    const tools = load();
    const id = await spawnCompletedBackgroundAgent(tools);
    const record = (globalThis as any)[Symbol.for("pi-subagents:manager")].getRecord(id);
    expect(record.status).toBe("completed");
    // Consume it while it is still top-level: that stamps consumedAt on the fake
    // clock AND cancels the held completion notice. Left pending, the notice's
    // real-time 200ms hold can fire mid-advance and re-stamp consumedAt past the
    // sweep this test waits for (#481).
    await tools.get("get_subagent_result").execute("tc-read", { agent_id: id }, undefined, undefined, ctx());
    Object.assign(record, owner);

    expect(record.session).toBeDefined();
    await vi.advanceTimersByTimeAsync(11 * 60_000 + 60_000);
    // Proof the sweep evicted it, not merely that it is owned: eviction detaches the session.
    expect(record.session).toBeUndefined();

    for (const [name, params] of [
      ["get_subagent_result", { agent_id: id }],
      ["steer_subagent", { agent_id: id, message: "hello" }],
    ] as const) {
      const out = textOf(await tools.get(name).execute("tc", params, undefined, undefined, ctx()));
      expect(out).toBe(`Agent not found: "${id}". It may have been cleaned up.`);
    }
  });

  it("keeps an unread result fetchable well past ten minutes", async () => {
    // A preview-only notice, so its delivery leaves the result truly unread.
    writeFileSync(
      join(tmpDir, ".pi", "subagents.json"),
      JSON.stringify({ schedulingEnabled: false, notificationResultChars: 0 }),
    );
    const tools = load();
    const id = await spawnCompletedBackgroundAgent(tools);

    vi.advanceTimersByTime(45 * 60_000);
    await flush();

    const out = textOf(await tools.get("get_subagent_result").execute("tc", { agent_id: id }, undefined, undefined, ctx()));
    expect(out).toContain("THE-RESULT-PAYLOAD");
  });

  it("still says not found for an id it never issued", async () => {
    const tools = load();
    const out = textOf(await tools.get("get_subagent_result").execute("tc", { agent_id: "nope" }, undefined, undefined, ctx()));
    expect(out).toContain('Agent not found: "nope"');
    // Nothing was evicted under that id, so a resume has no note to explain (#442).
    const resumeParams = { prompt: "again", description: "again", subagent_type: "general-purpose", resume: "nope", run_in_background: true };
    for (const [name, params] of [["Agent", resumeParams], ["steer_subagent", { agent_id: "nope", message: "hello" }]] as const) {
      const text = textOf(await tools.get(name).execute("tc", params, undefined, undefined, ctx()));
      expect(text).toBe('Agent not found: "nope". It may have been cleaned up.');
    }
  });
});
