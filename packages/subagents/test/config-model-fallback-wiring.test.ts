/**
 * config-model-fallback-wiring.test.ts -- a CONFIG model (`agentModels` or an
 * agent definition's `model:`) that does not resolve still runs on the parent
 * model, but must say so in the tool result text and the row details. An
 * explicit tool-call `model` keeps its hard error. Drives the real Agent tool
 * and the real nested Agent tool against the real `resolveModel`.
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
import { registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import subagentsExtension from "../src/index.js";
import { setAgentModels } from "../src/model-resolver.js";
import { createNestedSubagentTools } from "../src/nested-tools.js";
import { startSession } from "./helpers/boot-extension.js";

const PARENT = { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" };
const HAIKU = { provider: "anthropic", id: "claude-haiku-5-5", name: "Claude Haiku 5.5" };
const NOTE = 'Note: configured model "claude-haiku-4-5" did not resolve; running on parent model anthropic/claude-sonnet-5-5.';

let cwd: string;
let originalCwd: string;
let originalAgentDir: string | undefined;
let originalHome: string | undefined;

function writeAgent(name: string, model?: string): void {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  const modelLine = model ? `model: ${model}\n` : "";
  writeFileSync(join(dir, `${name}.md`), `---\ndescription: ${name}\ntools: read\n${modelLine}---\n${name}.\n`);
}

function ctx(models: unknown[] = [PARENT, HAIKU]) {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd,
    model: PARENT,
    modelRegistry: {
      find: (provider: string, id: string) => (models as any[]).find(m => m.provider === provider && m.id === id),
      getAll: () => models,
      getAvailable: () => models,
    },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;

describe("config model that does not resolve", () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "config-model-fallback-"));
    process.chdir(cwd);
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    originalHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
    process.env.HOME = cwd;
    vi.mocked(runAgent).mockReset();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false,
    });
  });

  afterEach(() => {
    setAgentModels(undefined);
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    process.chdir(originalCwd);
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    registerAgents(new Map());
    rmSync(cwd, { recursive: true, force: true });
  });

  async function boot() {
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
    subagentsExtension(pi);
    await startSession(lifecycle, true);
    return tools;
  }

  it("notes an unresolved agentModels entry in text and details, foreground", async () => {
    writeAgent("scout");
    const tools = await boot();
    // After boot: session_start reloads agentModels from (absent) settings.
    setAgentModels({ scout: "claude-haiku-4-5" });

    const result = await tools.get("Agent").execute(
      "tc-1", { prompt: "go", description: "d", subagent_type: "scout", run_in_background: false },
      undefined, undefined, ctx([PARENT]),
    );

    expect(textOf(result)).toContain(NOTE);
    expect(result.details.modelNote).toBe(NOTE);
    // No behavior change: it still ran, on the parent model.
    expect(vi.mocked(runAgent).mock.calls[0]?.[3]).toMatchObject({ model: PARENT });
  });

  it("notes an unresolved definition `model:` on the background branch", async () => {
    writeAgent("scout", "claude-haiku-4-5");
    vi.mocked(runAgent).mockReturnValue(new Promise(() => {}) as any);
    const tools = await boot();

    const result = await tools.get("Agent").execute(
      "tc-2", { prompt: "go", description: "d", subagent_type: "scout", run_in_background: true },
      undefined, undefined, ctx([PARENT]),
    );

    expect(textOf(result)).toContain(NOTE);
    expect(textOf(result)).toContain("started in background");
    expect(result.details.modelNote).toBe(NOTE);
  });

  it("adds no note when the config model resolves", async () => {
    writeAgent("scout", "claude-haiku-5-5");
    const tools = await boot();

    const result = await tools.get("Agent").execute(
      "tc-3", { prompt: "go", description: "d", subagent_type: "scout", run_in_background: false },
      undefined, undefined, ctx(),
    );

    expect(textOf(result)).not.toContain("did not resolve");
    expect(result.details.modelNote).toBeUndefined();
  });

  it("keeps the hard error for an explicit tool-call model", async () => {
    writeAgent("scout");
    const tools = await boot();

    const result = await tools.get("Agent").execute(
      "tc-4", { prompt: "go", description: "d", subagent_type: "scout", model: "claude-haiku-4-5" },
      undefined, undefined, ctx([PARENT]),
    );

    expect(textOf(result)).not.toContain("running on parent model");
    expect(runAgent).not.toHaveBeenCalled();
  });

  describe("nested Agent tool", () => {
    function nestedAgentTool(spawnAndWait: ReturnType<typeof vi.fn>) {
      const manager = {
        spawn: vi.fn(),
        spawnAndWait,
        awaitStartup: vi.fn(),
        getRecord: vi.fn(),
        resume: vi.fn(),
      } as any;
      return createNestedSubagentTools({
        manager, pi: {} as any, parentAgentId: "p", depth: 1, maxSubagentDepth: 2,
        allowedSubagents: "all", configCwd: cwd, projectTrusted: true,
      })[0] as any;
    }
    const done = () => vi.fn(async () => ({ id: "c1", record: { id: "c1", type: "scout", status: "completed", result: "done" } }));

    it("prefixes the note on the child result", async () => {
      writeAgent("scout", "claude-haiku-4-5");
      registerAgents(loadCustomAgents(cwd, false, { projectTrusted: true }));
      const tool = nestedAgentTool(done());

      const result = await tool.execute("c", { subagent_type: "scout", description: "d", prompt: "p" }, undefined, undefined, ctx([PARENT]));

      expect(result.isError).toBe(false);
      expect(result.content[0].text.startsWith(NOTE)).toBe(true);
      expect(result.content[0].text).toContain("done");
    });

    it("adds nothing when the config model resolves", async () => {
      writeAgent("scout", "claude-haiku-5-5");
      registerAgents(loadCustomAgents(cwd, false, { projectTrusted: true }));
      const tool = nestedAgentTool(done());

      const result = await tool.execute("c", { subagent_type: "scout", description: "d", prompt: "p" }, undefined, undefined, ctx());

      expect(result.content[0].text).not.toContain("did not resolve");
    });
  });
});
