/** Public index menu, workflow and lifecycle callbacks with real child sessions and private files. */
import { execFileSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { initTheme, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detachedDir, listRunningDetached } from "../src/detached-results.js";
import { createSubagentsExtension, WORKFLOW_FILE_FLAG } from "../src/index.js";
import { sessionTaskDir } from "../src/output-file.js";
import { resolveStorePath, ScheduleStore } from "../src/schedule-store.js";
import type { AgentRecord } from "../src/types.js";
import { WorkflowDialog } from "../src/ui/workflow-dialog.js";
import { type BootedPi, ctx, flush, type Hermetic, hermeticDir, makePi, startSession } from "./helpers/boot-extension.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { answer, barrier, calls } from "./helpers/scenario-session.js";

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
  Reflect.deleteProperty(globalThis, managerKey);
  initTheme("dark");
  env = hermeticDir({ settings: { outputTranscript: false, rememberAgents: false, defaultJoinMode: "group",
    schedulingEnabled: false, workflowsEnabled: false, fleetView: true, disableDefaultAgents: false,
    scopeModels: false, widgetMode: "off", agentMentions: "off", maxConcurrent: 10,
    fallbackSubagent: "general-purpose", toolDescriptionMode: "full" } });
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
  } finally { provider.unregister(); Reflect.deleteProperty(globalThis, managerKey); env.restore(); }
});

async function bind(ui: Record<string, unknown> = {}, flags: Record<string, boolean | string> = {}, competingWorkflow = false): Promise<Bound> {
  const boot = makePi(flags); const bus = new EventEmitter();
  boot.pi.getAllTools = vi.fn(() => [...boot.tools.values()]);
  if (competingWorkflow) boot.pi.registerTool({ name: "Workflow", description: "Fixture competing orchestrator" });
  boot.pi.events = {
    emit: vi.fn((event: string, value: unknown) => bus.emit(event, value)),
    on: (event: string, handler: (value: unknown) => void) => { bus.on(event, handler); return () => bus.off(event, handler); },
  };
  bus.on("router:rpc:admit", ({ requestId }: { requestId: string }) => bus.emit(`router:rpc:admit:reply:${requestId}`, { success: true, data: { ok: true } }));
  createSubagentsExtension({ clock, homeDir: env.dir })(boot.pi);
  const context = ctx({ cwd: env.dir, model: registry.find(provider.getModel().provider, "child"), modelRegistry: registry,
    signal: new AbortController().signal, hasUI: Object.keys(ui).length > 0, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "index-final-parent", getBranch: () => [], getSessionFile: () => sessionFile },
    ui: { ...ctx().ui, onTerminalInput: vi.fn(() => () => {}), getEditorText: () => "", ...ui },
  });
  const bound = { boot, context, registry: Reflect.get(globalThis, managerKey) as Registry, stopped: false };
  bindings.push(bound);
  await startSession(boot.lifecycle, true, context);
  return bound;
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

function configure(settings: Record<string, unknown>) {
  const path = join(env.dir, ".pi", "subagents.json");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...settings }));
}

describe("index queued resume waiting", () => {
  it("waits for a pool-queued background resume through the clock fallback, then returns only its new result", async () => {
    configure({ maxConcurrent: 1 });
    const hold = heldResponse("blocking sibling result");
    provider.setResponses([answer("old private result"), hold.response, answer("new resumed private result")]);
    const bound = await bind();
    const id = await spawn(bound, "resumable private child"); await bound.registry.waitForAll();
    await spawn(bound, "pool blocker"); await hold.entered;
    const resumed = await bound.boot.tools.get("Agent").execute("queue-resume", {
      resume: id, prompt: "Resume privately", description: "queued resume", subagent_type: "general-purpose", run_in_background: true,
    }, undefined, undefined, bound.context);
    expect(resumed.content[0].text).toContain("Agent queued in background");
    expect(bound.registry.getRecord(id)?.status).toBe("queued");
    let returned = false;
    const waiting = bound.boot.tools.get("get_subagent_result").execute("wait-resume", { agent_id: id, wait: true }, undefined, undefined, bound.context)
      .then((result: { content: { text: string }[] }) => { returned = true; return result; });
    await flush(); expect(returned).toBe(false);
    hold.release(); await bound.registry.waitForAll();
    clock.advance(1000);
    const result = await waiting;
    expect(result.content[0].text).toContain("new resumed private result");
    expect(result.content[0].text).not.toContain("old private result");
    expect(provider.state.callCount).toBe(3);
  });

  it("reports a hard turn-cap failure as aborted when the final report still tries a tool", async () => {
    configure({ graceTurns: 1 });
    const path = join(env.dir, "private.txt"); writeFileSync(path, "private input");
    provider.setResponses([calls({ name: "read", args: { path } }), calls({ name: "read", args: { path } }), calls({ name: "read", args: { path } })]);
    const bound = await bind();
    const result = await bound.boot.tools.get("Agent").execute("capped-child", {
      subagent_type: "general-purpose", prompt: "Read privately", description: "hard capped child", max_turns: 1, run_in_background: true,
    }, undefined, undefined, bound.context);
    await bound.registry.waitForAll();
    expect(bound.registry.getRecord(result.details.agentId)?.status).toBe("aborted");
    await turnEnd(bound);
    expect(bound.boot.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("Aborted (max turns exceeded)") }), expect.anything());
  });
});

describe("index menu and branch races", () => {
  it("rejects a removed type at the picker boundary before opening its detail menu", async () => {
    configure({ disableDefaultAgents: true, fallbackSubagent: "none" });
    const dir = join(env.dir, ".pi", "agents"); mkdirSync(dir);
    const path = join(dir, "private.md"); writeFileSync(path, "---\ndescription: Private fixture\n---\nPrivate prompt.");
    const notify = vi.fn(); let step = 0; let bound: Bound;
    const select = vi.fn(async (_title: string, choices: string[]) => step++ === 0
      ? choices.find(choice => choice.startsWith("Agent types (")) : undefined);
    const custom = vi.fn(async (factory: (tui: unknown, theme: unknown, keys: undefined, done: (name: string | undefined) => void) => { handleInput(key: string): void }) => {
      const selected = barrier<string | undefined>();
      const component = factory({}, {}, undefined, name => selected.resolve(name));
      rmSync(path);
      const result = await bound.boot.tools.get("Agent").execute("reload-selected-type", {
        subagent_type: "private", prompt: "Never run", description: "Removed type", run_in_background: true,
      }, undefined, undefined, bound.context);
      expect(result.content[0].text).toContain("Unknown or disabled agent type");
      component.handleInput("\r");
      return selected.promise;
    });
    bound = await bind({ notify, select, custom });
    await bound.boot.commands.get("agents").handler("", bound.context);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(select.mock.calls.map(([title]) => title)).toEqual(["Agents", "Agents"]);
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("Agent config not found"), "warning");
    expect(provider.state.callCount).toBe(0);
  });

  it("shows the resolved provider for an aliased agent model in the actual type picker", async () => {
    const dir = join(env.dir, ".pi", "agents"); mkdirSync(dir);
    writeFileSync(join(dir, "private.md"), "---\ndescription: Private fixture\nmodel: portable\n---\nPrivate prompt.");
    writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "subagents.json"), JSON.stringify({ modelAliases: { portable: ["index-final-lifecycle/child"] } }));
    const rendered: string[] = []; let selected = false;
    const bound = await bind({
      select: vi.fn(async (_title: string, choices: string[]) => {
        if (selected) return undefined; selected = true;
        return choices.find(choice => choice.startsWith("Agent types ("));
      }),
      custom: vi.fn(async (factory: (tui: unknown, theme: unknown, keys: undefined, done: () => void) => { render(w: number): string[]; handleInput(key: string): void }) => {
        const component = factory({}, {}, undefined, () => {});
        rendered.push(...component.render(160)); component.handleInput("\u001b"); return undefined;
      }),
    });
    await bound.boot.commands.get("agents").handler("", bound.context);
    expect(stripTerminalSequences(rendered.join("\n"))).toContain("portable (→ index-final-lifecycle/child)");
    expect(provider.state.callCount).toBe(0);
  });

  it("handles the last agent file disappearing while its type-list choice is open", async () => {
    configure({ disableDefaultAgents: true, fallbackSubagent: "none" });
    const dir = join(env.dir, ".pi", "agents"); mkdirSync(dir);
    const path = join(dir, "private.md"); writeFileSync(path, "---\ndescription: Private fixture\n---\nPrivate prompt.");
    const notify = vi.fn(); let first = true; let bound: Bound;
    const select = vi.fn(async (_title: string, choices: string[]) => {
      if (!first) return undefined;
      first = false;
      const choice = choices.find(value => value.startsWith("Agent types ("));
      rmSync(path);
      const result = await bound.boot.tools.get("Agent").execute("reload-removed-types", {
        subagent_type: "private", prompt: "Never run", description: "Private fixture", run_in_background: true,
      }, undefined, undefined, bound.context);
      expect(result.content[0].text).toContain("Unknown or disabled agent type");
      return choice;
    });
    bound = await bind({ notify, select });
    await bound.boot.commands.get("agents").handler("", bound.context);
    expect(notify).toHaveBeenCalledWith("No agents.", "info");
    expect(provider.state.callCount).toBe(0);
  });

  it("handles a completed record being consumed and cleared while the running-list choice is open", async () => {
    provider.setResponses([answer("Private consumed result")]);
    const notify = vi.fn(); let first = true; let bound: Bound; let id: string;
    const select = vi.fn(async (_title: string, choices: string[]) => {
      if (!first) return undefined;
      first = false;
      const choice = choices.find(value => value.startsWith("Running agents ("));
      const result = await bound.boot.tools.get("get_subagent_result").execute("consume-menu-race", { agent_id: id }, undefined, undefined, bound.context);
      expect(result.content[0].text).toContain("Private consumed result");
      await bound.boot.lifecycle.get("session_before_switch")?.({ type: "session_before_switch" } as never, bound.context);
      return choice;
    });
    bound = await bind({ notify, select }); id = await spawn(bound, "completed menu race"); await bound.registry.waitForAll();
    await bound.boot.commands.get("agents").handler("", bound.context);
    expect(bound.registry.getRecord(id)).toBeUndefined();
    expect(notify).toHaveBeenCalledWith("No agents.", "info");
  });

  it("reports the selected queued child without opening a viewer or borrowing its sibling's session", async () => {
    configure({ maxConcurrent: 1 });
    const hold = heldResponse("First private result"); provider.setResponses([hold.response, answer("Queued private result")]);
    const notify = vi.fn(); const custom = vi.fn(); let step = 0;
    const select = vi.fn(async (_title: string, choices: string[]) => {
      if (step++ === 0) return choices.find(value => value.startsWith("Running agents ("));
      return step === 2 ? choices[1] : undefined;
    });
    const bound = await bind({ notify, select, custom });
    await spawn(bound, "running sibling"); await hold.entered;
    const queued = await spawn(bound, "queued private child");
    expect(bound.registry.getRecord(queued)?.status).toBe("queued");
    await bound.boot.commands.get("agents").handler("", bound.context);
    expect(notify).toHaveBeenCalledWith("Agent is queued — no session available.", "info");
    expect(custom).not.toHaveBeenCalled(); expect(provider.state.callCount).toBe(1);
    hold.release(); await bound.registry.waitForAll();
    expect(bound.registry.getRecord(queued)?.result).toBe("Queued private result");
  });

  it("restores disclosure from the new branch on session_tree before accepting another key", async () => {
    const listeners: ((data: string) => unknown)[] = [];
    const bound = await bind({ onTerminalInput: (handler: (data: string) => unknown) => { listeners.push(handler); return () => {}; } });
    bound.context.sessionManager.getBranch = () => [{ type: "custom", customType: "subagents:fleet-state", data: { version: 1, collapsed: true } }] as never;
    const toggle = () => { for (const listener of listeners) listener("\u001b[97;6u"); clock.advance(1000); };
    await bound.boot.lifecycle.get("session_tree")?.({ type: "session_tree" } as never, bound.context);
    toggle();
    await bound.boot.lifecycle.get("session_tree")?.({ type: "session_tree" } as never, bound.context);
    toggle();
    const snapshots = bound.boot.pi.appendEntry.mock.calls.filter(([type]: [string]) => type === "subagents:fleet-state");
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map(([, state]: [string, { collapsed: boolean }]) => state.collapsed)).toEqual([false, false]);
  });
});

describe("index scheduler and file errors", () => {
  it("rethrows a non-strict canonical load error instead of binding a partially loaded registry", async () => {
    const dir = join(env.dir, ".pi", "agents"); mkdirSync(dir);
    // Valid YAML, invalid tools shape: String(fm.tools) cannot invoke a string
    // as toString. This fails after parsing, outside readAgentFile's warning catch.
    writeFileSync(join(dir, "broken-tools.md"), "---\ndescription: Broken tools\ntools:\n  toString: not-callable\n---\nPrivate prompt.");
    await expect(bind().then(() => "bound")).rejects.toThrow(TypeError);
    expect(provider.state.callCount).toBe(0);
    const bound = bindings[0];
    expect(bound.boot.pi.events.emit).not.toHaveBeenCalledWith("subagents:ready", expect.anything());
    rmSync(join(dir, "broken-tools.md"));
    await startSession(bound.boot.lifecycle, true, bound.context);
    expect(bound.boot.pi.events.emit).toHaveBeenCalledWith("subagents:ready", {});
  });

  it("fails the canonical strict bind on malformed project frontmatter without starting a child", async () => {
    configure({ strictAgentFiles: true });
    const dir = join(env.dir, ".pi", "agents"); mkdirSync(dir);
    writeFileSync(join(dir, "broken.md"), "---\ndescription: [unterminated\n---\nPrivate prompt.");
    await expect(bind()).rejects.toMatchObject({ name: "ExtensionStartupError" });
    expect(provider.state.callCount).toBe(0);
  });

  it("refuses resuming a real startup failure that never acquired a session", async () => {
    configure({ maxConcurrent: 1, worktreeIsolation: true });
    const hold = heldResponse("blocking private child"); provider.setResponses([hold.response]);
    const bound = await bind();
    const gitConfig = join(env.dir, "gitconfig"); writeFileSync(gitConfig, "");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    expect(isAbsolute(realGit)).toBe(true);
    bound.boot.pi.exec = vi.fn(async (command: string, args: string[], options: { cwd?: string; timeout?: number } = {}) => {
      expect(command).toBe("git");
      const child = spawnSync(realGit, args, { cwd: options.cwd, timeout: options.timeout, encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: env.dir, USERPROFILE: env.dir,
          GIT_CEILING_DIRECTORIES: realpathSync(env.dir),
          GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      });
      return { stdout: child.stdout ?? "", stderr: child.stderr ?? "", code: child.status ?? 1, killed: child.signal !== null };
    });
    await spawn(bound, "pool blocker"); await hold.entered;
    const queued = await bound.boot.tools.get("Agent").execute("failed-worktree", {
      subagent_type: "general-purpose", prompt: "Never run", description: "failed private startup", isolation: "worktree", run_in_background: true,
    }, undefined, undefined, bound.context);
    expect(queued.content[0].text).toContain("Agent queued");
    hold.release(); await bound.registry.waitForAll();
    const id = queued.details.agentId;
    expect(bound.registry.getRecord(id)?.status).toBe("error");
    expect(bound.registry.getRecord(id)?.error).toContain("fatal: not a git repository");
    expect(bound.registry.getRecord(id)?.session).toBeUndefined();
    const resumed = await bound.boot.tools.get("Agent").execute("resume-no-session", {
      resume: id, prompt: "No session", description: "resume failed startup", subagent_type: "general-purpose", run_in_background: true,
    }, undefined, undefined, bound.context);
    expect(resumed.content[0].text).toContain("has no active session to resume");
    expect(provider.state.callCount).toBe(1);
  });

  it("warns about an empty custom description and keeps the fallback agent contract", async () => {
    configure({ toolDescriptionMode: "custom" });
    writeFileSync(join(env.dir, ".pi", "agent-tool-description.md"), "  \n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const bound = await bind();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("is empty — ignoring"));
      expect(bound.boot.tools.get("Agent").description).toContain("general-purpose");
    } finally { warn.mockRestore(); }
  });

  it("reports a real schedule-write failure without claiming success or spawning", async () => {
    configure({ schedulingEnabled: true });
    const blocker = join(env.dir, ".pi", "subagent-schedules");
    writeFileSync(blocker, "private blocker");
    const bound = await bind();
    const result = await bound.boot.tools.get("Agent").execute("blocked-schedule", {
      subagent_type: "general-purpose", prompt: "later", description: "private schedule", schedule: "+1h", run_in_background: true,
    }, undefined, undefined, bound.context);
    expect(result.content[0].text).toMatch(/ENOTDIR|EEXIST/);
    expect(result.content[0].text).not.toContain('Scheduled "');
    expect(readFileSync(blocker, "utf8")).toBe("private blocker");
    expect(provider.state.callCount).toBe(0);
  });

  it("refuses scheduling after the supported before-switch hook has stopped its timers", async () => {
    configure({ schedulingEnabled: true });
    const bound = await bind();
    await bound.boot.lifecycle.get("session_before_switch")?.({ type: "session_before_switch" } as never, bound.context);
    const result = await bound.boot.tools.get("Agent").execute("inactive-schedule", {
      subagent_type: "general-purpose", prompt: "later", description: "private schedule", schedule: "+1h", run_in_background: true,
    }, undefined, undefined, bound.context);
    expect(result.content[0].text).toContain("Scheduler is not active in this session yet");
    expect(provider.state.callCount).toBe(0);
  });

  it("rejects an invalid schedule and cancels a real persisted job from the registered menu", async () => {
    configure({ schedulingEnabled: true });
    let step = 0;
    const select = vi.fn(async (title: string, choices: string[]) => {
      if (title === "Agents") return step++ === 0 ? choices.find(choice => choice.startsWith("Scheduled jobs (")) : undefined;
      return title.startsWith("Scheduled jobs (") ? choices[0] : undefined;
    });
    const confirm = vi.fn(async () => true);
    const bound = await bind({ select, confirm });
    const schedule = (expression: string) => bound.boot.tools.get("Agent").execute("schedule", {
      subagent_type: "general-purpose", prompt: "later", description: "private schedule", schedule: expression, run_in_background: true,
    }, undefined, undefined, bound.context);
    const invalid = await schedule("not a schedule");
    expect(invalid.content[0].text).not.toContain('Scheduled "');
    expect(invalid.content[0].text).toContain('Invalid schedule "not a schedule". Use 6-field cron');
    const result = await schedule("+1h");
    expect(result.content[0].text).toContain('Scheduled "private schedule"');
    const path = resolveStorePath(env.dir, "index-final-parent");
    expect(new ScheduleStore(path).list()).toMatchObject([{ name: "private schedule" }]);
    await bound.boot.commands.get("agents").handler("", bound.context);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("private schedule"), expect.any(String));
    expect(new ScheduleStore(path).list()).toEqual([]);
    expect(provider.state.callCount).toBe(0);
  });

  it("warns about an unreadable custom tool-description file and preserves the fallback tool contract", async () => {
    configure({ toolDescriptionMode: "custom" });
    mkdirSync(join(env.dir, ".pi", "agent-tool-description.md"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const bound = await bind();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("failed to read"));
      expect(bound.boot.tools.get("Agent").description).toContain("general-purpose");
      expect(provider.state.callCount).toBe(0);
    } finally { warn.mockRestore(); }
  });
});

describe("index workflow entry callbacks", () => {
  it("reports a headless workflow collision and refuses its CLI flag without launching work", async () => {
    configure({ workflowsEnabled: undefined }); // An unpinned default must yield to the other orchestrator.
    const path = join(env.dir, "unused-workflow.js");
    writeFileSync(path, 'export const meta = { name: "unused", description: "Never executed" }; return "never";');
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const bound = await bind({}, { [WORKFLOW_FILE_FLAG]: path }, true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('already provides a "Workflow" tool'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("ignored: workflows are off"));
      expect(bound.boot.pi.getActiveTools()).not.toContain("SubagentWorkflow");
      expect(bound.boot.pi.getActiveTools()).toContain("Workflow");
      expect(provider.state.callCount).toBe(0);
      expect(bound.boot.pi.appendEntry).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it("opens the live workflow child through the fleet inspector's session and record callbacks", async () => {
    configure({ workflowsEnabled: true });
    const hold = heldResponse("private workflow result"); provider.setResponses([hold.response]);
    const listeners: ((data: string) => unknown)[] = []; const viewed = barrier<string>();
    const bound = await bind({
      onTerminalInput: (handler: (data: string) => unknown) => { listeners.push(handler); return () => {}; },
      custom: vi.fn(async (factory: (tui: unknown, theme: unknown, keys: undefined, done: () => void) => { render(w: number): string[]; handleInput(key: string): void; dispose(): void }, options?: { onHandle?: (handle: { setHidden(value: boolean): void }) => void }) => {
        options?.onHandle?.({ setHidden: vi.fn() });
        const component = factory({ terminal: { rows: 30, columns: 120 }, requestRender: vi.fn() },
          { fg: (_color: string, text: string) => text, bold: (text: string) => text }, undefined, () => {});
        const content = component.render(120).join("\n");
        if (component instanceof WorkflowDialog) { expect(content).toContain("private-inspector"); component.handleInput("c"); }
        else viewed.resolve(content);
        component.handleInput("q"); component.dispose(); return undefined;
      }),
    });
    const result = await bound.boot.tools.get("SubagentWorkflow").execute("workflow-inspector", {
      script: 'export const meta = { name: "private-inspector", description: "Private fixture" }; return await agent("Inspect private workflow inputs", { label: "private-child", agentType: "general-purpose" });',
    }, undefined, undefined, bound.context);
    expect(result.content[0].text).toContain('Workflow "private-inspector" started');
    await hold.entered;
    for (const key of ["\u001b[B", "\u001b[B", "\r"]) for (const listener of listeners) listener(key);
    expect(await viewed.promise).toContain("Inspect private workflow inputs");
    hold.release(); await bound.registry.waitForAll();
  });

  it("reports invalid CLI workflow metadata through the bound UI without launching children", async () => {
    configure({ workflowsEnabled: true });
    const path = join(env.dir, "invalid-workflow.js");
    writeFileSync(path, 'export const meta = { name: "missing-description" }; return "never";');
    const notify = vi.fn(); const bound = await bind({ notify }, { [WORKFLOW_FILE_FLAG]: path });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("meta.description"), "warning");
    expect(bound.boot.pi.appendEntry).not.toHaveBeenCalledWith("subagents:record", expect.anything());
    expect(provider.state.callCount).toBe(0);
  });

  it("keeps a workflow runnable when its private script persistence directory is blocked", async () => {
    configure({ workflowsEnabled: true });
    const dir = sessionTaskDir(env.dir, "index-final-parent");
    rmSync(dir, { recursive: true }); writeFileSync(dir, "private blocker");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hold = heldResponse("private unpersisted workflow result"); provider.setResponses([hold.response]);
    try {
      const bound = await bind();
      const result = await bound.boot.tools.get("SubagentWorkflow").execute("blocked-persistence", {
        script: 'export const meta = { name: "unpersisted", description: "Private fixture" }; return await agent("Run without persistence", { agentType: "general-purpose" });',
      }, undefined, undefined, bound.context);
      expect(result.content[0].text).toContain('Workflow "unpersisted" started');
      expect(result.content[0].text).not.toContain("Script:");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not persist workflow script:"));
      await hold.entered; hold.release(); await bound.registry.waitForAll();
      expect(readFileSync(dir, "utf8")).toBe("private blocker");
    } finally { warn.mockRestore(); rmSync(dir, { force: true }); mkdirSync(dir, { recursive: true }); }
  });
});

describe("index retained lifecycle callbacks", () => {
  it("warns on a real held-notice spool failure and preserves the child's output transcript", async () => {
    configure({ outputTranscript: true }); provider.setResponses([answer("private recoverable transcript")]);
    const bound = await bind(); const id = await spawn(bound, "recoverable private child");
    await bound.registry.waitForAll();
    const output = bound.registry.getRecord(id)?.outputFile;
    expect(output).toBeDefined(); if (!output) throw new Error("Missing real child output transcript");
    expect(readFileSync(output, "utf8")).toContain("private recoverable transcript");
    const dir = detachedDir(sessionFile); rmSync(dir, { recursive: true }); writeFileSync(dir, "private spool blocker");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await shutdown(bound, "reload");
      expect(error).toHaveBeenCalledWith("[pi-subagents] Could not spool held completion notices; results remain in their transcripts.");
      expect(readFileSync(output, "utf8")).toContain("private recoverable transcript");
      expect(readFileSync(dir, "utf8")).toBe("private spool blocker");
      expect(bound.boot.pi.sendMessage).not.toHaveBeenCalled();
    } finally { error.mockRestore(); rmSync(dir, { force: true }); mkdirSync(dir, { recursive: true }); }
  });

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
    const restoredIds = [message.details.id, ...message.details.others.map((other: { id: string }) => other.id)];
    expect(restoredIds).toHaveLength(ids.length);
    expect(new Set(restoredIds)).toEqual(new Set(ids));
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
    const record = first.registry.getRecord(id);
    expect(record).toBeDefined();
    expect(record?.session).toBeDefined();
    if (!record?.session) throw new Error("Detached survivor lost its session before settlement");
    const session = record.session;
    hold.release(); await first.registry.waitForAll(); await flush();
    if (action === "stop") expect(record.status).toBe("stopped");
    else {
      expect(record.result).toBe("survivor redirected result");
      expect(JSON.stringify(session.messages)).toContain("Prioritize survivor privacy");
      expect(provider.state.callCount).toBe(2);
      expect(provider.getPendingResponseCount()).toBe(0);
      expect(notify).not.toHaveBeenCalledWith(expect.stringMatching(/^Stopped /), expect.anything());
    }
    expect(listRunningDetached(sessionFile)).toHaveLength(0);
    expect(first.registry.getRecord(id)).toBeUndefined(); // The settled detached manager releases retained sessions/records.
    expect(first.boot.pi.sendMessage).not.toHaveBeenCalled();
    expect(next.boot.pi.sendMessage).not.toHaveBeenCalled(); // Never deliver the old run into the replacement context.
  });
});
