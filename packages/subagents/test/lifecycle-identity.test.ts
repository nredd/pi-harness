/**
 * lifecycle-identity.test.ts -- top-level lifecycle events carry the agent's
 * `handle` and spawner-`name` handle, so a listener (pi-todo's owner column)
 * can match an agent by what the parent typed instead of only its id (#444).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunner from "../src/agent-runner.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunner>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
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
      expect(event, name).toMatchObject({ handle: "scout", name: "auth-audit" });
    }
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
  });
});
