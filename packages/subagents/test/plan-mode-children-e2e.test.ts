/**
 * plan-mode-children-e2e.test.ts — #437: a child started while the parent plans
 * must plan too. Real pi loader + the real pi-plan-mode extension next to this
 * one in the parent + real child sessions on a faux model, so the child's tool
 * calls go through the same hooks a production child's do.
 *
 * No child loads pi-plan-mode itself (the hermetic agent dir has no
 * extensions), which is the case that must fail closed rather than open.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Context, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import type { PlanGate } from "../src/plan-mode-children.js";
import type { AgentConfig } from "../src/types.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";
import { agentCall, type FauxReply, type PrintModeRun, runPrintMode, toolResultsNamed } from "./helpers/print-mode-runner.js";
import { runAgent } from "./helpers/run-selected-agent.js";

vi.setConfig({ testTimeout: 30_000 });

/** Registers `alpha_read` / `alpha_write`. */
const ALPHA = fileURLToPath(new URL("./fixtures/ext-alpha.mjs", import.meta.url));
const PLAN_MODE_EXTENSION = fileURLToPath(new URL("../../plan-mode/src/index.ts", import.meta.url));
const TURN = "Plan the change.";

type Result = { name: string; text: string };

function firstUserText(context: Context): string {
  const first = context.messages.find((m) => m.role === "user");
  const content = first?.content;
  if (typeof content === "string") return content;
  return ((content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
}

function toolResults(context: Context): Result[] {
  return context.messages
    .filter((m) => m.role === "toolResult")
    .map((m) => ({
      name: (m as { toolName?: string }).toolName ?? "",
      text: ((m.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join(""),
    }));
}

/** Plan mode admits `Agent` only when selected, as the installed `pi-plan-mode.json` does. */
function selectAgentInPlanPolicy(): void {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) throw new Error("runPrintMode did not isolate PI_CODING_AGENT_DIR");
  writeFileSync(join(agentDir, "pi-plan-mode.json"), JSON.stringify({ defaultPlanTools: ["read", "bash", "Agent"] }));
}

interface Scenario {
  /** The parent's one `Agent` call. */
  agent: Record<string, unknown>;
  /** Scripted tool calls per child, keyed by a marker in its task prompt. */
  children: Record<string, FauxReply[]>;
  /** Load pi-plan-mode and enter Plan before the parent's turn. Default true. */
  plan?: boolean;
  cwd?: string;
  beforeRun?: () => void;
}

/** Each child's tool results and offered tool names, keyed by its marker. */
interface Seen {
  results: Map<string, Result[]>;
  tools: Map<string, string[]>;
}

describe("children spawned during Plan mode (#437)", () => {
  let run: PrintModeRun | undefined;
  const tmpDirs: string[] = [];
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function play(scenario: Scenario): Promise<Seen> {
    const seen: Seen = { results: new Map(), tools: new Map() };
    const plan = scenario.plan ?? true;
    run = await runPrintMode({
      // `/plan start` enters Plan without a model turn; the planning turn is driven below.
      prompt: plan ? "/plan start" : TURN,
      cwd: scenario.cwd,
      beforeRun: () => {
        selectAgentInPlanPolicy();
        scenario.beforeRun?.();
      },
      extensionPaths: plan ? [PLAN_MODE_EXTENSION] : [],
      respond: (context) => {
        const task = firstUserText(context);
        const marker = Object.keys(scenario.children).find((key) => task.includes(key));
        if (marker) {
          const results = toolResults(context);
          seen.tools.set(marker, getCurrentTools(context.messages).map((tool) => tool.name));
          const next = scenario.children[marker]?.[results.length];
          if (next) return next;
          seen.results.set(marker, results);
          return `${marker} done`;
        }
        const spawned = toolResults(context).some((r) => r.name === "Agent");
        return spawned ? "parent done" : agentCall({ run_in_background: false, ...scenario.agent } as never);
      },
      live: false,
    });
    if (plan) await run.parentSession.prompt(TURN);
    return seen;
  }

  it("a general-purpose child cannot write, edit or run unsafe bash, and still inspects", async () => {
    const seen = await play({
      agent: { subagent_type: "general-purpose", description: "inspect", prompt: "GP: inspect the repo." },
      children: {
        GP: [
          fauxToolCall("write", { path: "planned.txt", content: "x" }),
          fauxToolCall("edit", { path: "planned.txt", edits: [{ oldText: "x", newText: "y" }] }),
          fauxToolCall("bash", { command: "git status" }),
          fauxToolCall("bash", { command: "rm -rf x" }),
        ],
      },
    });

    const results = seen.results.get("GP") ?? [];
    expect(results.map((r) => r.name)).toEqual(["write", "edit", "bash", "bash"]);
    expect(results[0]?.text).toContain("Plan mode blocks mutating tool 'write'");
    expect(results[1]?.text).toContain("Plan mode blocks mutating tool 'edit'");
    expect(results[2]?.text).not.toContain("Plan mode blocks");
    expect(results[3]?.text).toContain("Blocked command: rm -rf x");
    expect(existsSync(join(process.cwd(), "planned.txt"))).toBe(false);
  });

  it("an Explore child keeps its surface", async () => {
    const seen = await play({
      agent: { subagent_type: "Explore", description: "find", prompt: "EXPLORE: find the entry point." },
      children: { EXPLORE: [fauxToolCall("ls", {}), fauxToolCall("find", { pattern: "*" })] },
    });

    expect(seen.tools.get("EXPLORE")).toEqual(["read", "grep", "find", "ls"]);
    const results = seen.results.get("EXPLORE") ?? [];
    expect(results.map((r) => r.name)).toEqual(["ls", "find"]);
    for (const result of results) expect(result.text).not.toContain("Plan mode blocks");
  });

  it("a nested allowed_subagents child inherits the restriction", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "plan-nested-"));
    tmpDirs.push(cwd);
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "agents", "orchestrator.md"),
      "---\ndescription: Delegating orchestrator\ntools: read, write\nextensions: false\nallowed_subagents: worker\n---\nDelegate.\n",
    );
    writeFileSync(
      join(cwd, ".pi", "agents", "worker.md"),
      "---\ndescription: Leaf worker\ntools: read, write\nextensions: false\n---\nWork.\n",
    );
    const seen = await play({
      cwd,
      beforeRun: () => registerAgents(loadCustomAgents(cwd)),
      agent: { subagent_type: "orchestrator", description: "delegate", prompt: "ORCH: delegate downward." },
      children: {
        ORCH: [agentCall({ subagent_type: "worker", description: "leaf", prompt: "LEAF: write it.", run_in_background: false })],
        LEAF: [fauxToolCall("write", { path: "leaf.txt", content: "x" })],
      },
    });

    expect(seen.results.get("LEAF")?.[0]?.text).toContain("Plan mode blocks mutating tool 'write'");
    expect(seen.results.get("ORCH")?.[0]?.text).toContain("LEAF done");
    expect(existsSync(join(cwd, "leaf.txt"))).toBe(false);
  });

  it("refuses worktree isolation", async () => {
    await play({
      agent: { subagent_type: "general-purpose", description: "copy", prompt: "WT: edit a copy.", isolation: "worktree" },
      children: {},
    });
    const [result] = toolResultsNamed(run!.parentSession, "Agent");
    expect(result).toContain('Cannot run with isolation: "worktree" while Plan mode is active');
  });

  it("changes nothing without pi-plan-mode", async () => {
    const seen = await play({
      plan: false,
      agent: { subagent_type: "general-purpose", description: "write", prompt: "GP: write it." },
      children: { GP: [fauxToolCall("write", { path: "normal.txt", content: "x" })] },
    });

    expect(seen.results.get("GP")?.[0]?.text).toContain("Successfully wrote");
    expect(existsSync(join(process.cwd(), "normal.txt"))).toBe(true);
  });
});

describe("the child's Plan gate (#437)", () => {
  let cwd: string | undefined;
  let faux: ReturnType<typeof registerFauxProvider> | undefined;
  afterEach(() => {
    faux?.unregister();
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it("vetoes model calls and nested executeTool calls, reads the gate per call, and briefs the child", async () => {
    cwd = mkdtempSync(join(tmpdir(), "plan-gate-"));
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    registerAgents(
      new Map([
        [
          "planner-child",
          {
            name: "planner-child",
            description: "plan gate",
            builtinToolNames: ["read", "write"],
            extensions: [ALPHA],
            skills: false,
            systemPrompt: "You are a child.",
            promptMode: "replace",
            isolated: false,
          } as AgentConfig,
        ],
      ]),
    );
    const model = faux.getModel();
    const modelRegistry: any = {
      find: () => model,
      getAll: () => [model],
      getAvailable: () => [model],
      hasConfiguredAuth: () => true,
      isUsingOAuth: () => false,
      getApiKeyAndHeaders: async () => ({ apiKey: "faux", headers: {} }),
      registerProvider: () => {},
      unregisterProvider: () => {},
    };
    const ctx: any = { cwd, getSystemPrompt: () => "PARENT", isProjectTrusted: () => true, model, modelRegistry };
    const seen: Array<{ toolName: string; cwd: string; source: string | undefined }> = [];
    const gate: PlanGate = {
      policy: ({ toolName, cwd: callCwd, tool }) => {
        seen.push({ toolName, cwd: callCwd, source: tool?.sourceInfo?.source });
        return toolName === "alpha_write" || toolName === "write" ? `Plan blocks ${toolName}` : undefined;
      },
    };
    let session: any;
    try {
      await runAgent(ctx, "planner-child", "go", {
        pi: { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any,
        model,
        planGate: gate,
        onSessionCreated: (s: any) => {
          session = s;
        },
      });
    } catch {
      // The faux model has no scripted turn; the gate is installed before the prompt.
    }

    expect(session.systemPrompt).toContain("<plan_mode>");
    await expect(session.agent.beforeToolCall({ toolCall: { name: "write" }, args: {} })).resolves.toEqual({
      block: true,
      reason: "Plan blocks write",
    });
    expect(seen[0]).toEqual({ toolName: "write", cwd, source: "builtin" });
    await expect(session.agent.beforeToolCall({ toolCall: { name: "alpha_read" }, args: {} })).resolves.toSatisfy(
      (r: any) => !r?.block,
    );
    // Nested calls (codemode scripts) reach extensions' tool_call handlers only.
    await expect(
      session._beforeToolCall({ toolCall: { name: "alpha_write", id: "n1" }, args: {} }, "parent-call"),
    ).resolves.toMatchObject({ block: true, reason: "Plan blocks alpha_write" });

    // A resume after the parent left Plan: same hooks, no policy.
    gate.policy = undefined;
    await expect(
      session._beforeToolCall({ toolCall: { name: "alpha_write", id: "n2" }, args: {} }, "parent-call"),
    ).resolves.toSatisfy((r: any) => !r?.block);
    await expect(session.agent.beforeToolCall({ toolCall: { name: "write" }, args: {} })).resolves.toSatisfy(
      (r: any) => !r?.block,
    );
  });
});
