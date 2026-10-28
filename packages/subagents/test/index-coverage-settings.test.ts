/** Persist settings by keyboard-driving the real registered settings component. */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSubagentsExtension } from "../src/index.js";
import { type BootedPi, ctx, type Hermetic, hermeticDir, makePi, startSession } from "./helpers/boot-extension.js";
import { FakeClock } from "./helpers/fake-clock.js";

type Component = { render(width: number): string[]; invalidate(): void; handleInput(data: string): void };
type Factory = (tui: unknown, theme: unknown, keys: unknown, done: (value: string | undefined) => void) => Component;
const rows = ["maxConcurrent", "maxConcurrentForeground", "defaultMaxTurns", "graceTurns", "maxSubagentDepth", "defaultJoinMode", "backgroundByDefault", "schedulingEnabled", "workflowsEnabled", "packageAgents", "packageWorkflows", "scopeModels", "strictAgentFiles", "disableDefaultAgents", "fallbackSubagent", "outputTranscript", "worktreeIsolation", "reportUsage", "showCost", "showModel", "viewerMarkdown", "fleetView", "agentMentions", "rememberAgents", "widgetMode", "toolDescriptionMode"];
let env: Hermetic;
let boot: BootedPi;
let context: ExtensionCommandContext;
let scripts: string[][];
let inputs: (string | undefined)[];
const notify = vi.fn();

function settingsPath() { return join(env.dir, ".pi", "subagents.json"); }
function saved(): Record<string, unknown> { return JSON.parse(readFileSync(settingsPath(), "utf8")); }
function selectRow(key: string, presses = 1) {
  const index = rows.indexOf(key);
  if (index < 0) throw new Error(`Unknown row: ${key}`);
  scripts.push([...Array<string>(index).fill("\u001b[B"), ...Array<string>(presses).fill("\r"), "\u001b"]);
}
async function command() { await boot.commands.get("agents").handler("", context); }

beforeEach(async () => {
  initTheme("dark");
  env = hermeticDir({ settings: {
    maxConcurrent: 10, maxConcurrentForeground: 0, defaultMaxTurns: 0, graceTurns: 3, maxSubagentDepth: 2,
    defaultJoinMode: "smart", backgroundByDefault: true, schedulingEnabled: true, workflowsEnabled: true,
    scopeModels: false, strictAgentFiles: false, disableDefaultAgents: false, outputTranscript: true,
    worktreeIsolation: true, reportUsage: false, showCost: false, showModel: false,
    viewerMarkdown: "assistant", fleetView: false, agentMentions: "model", rememberAgents: true,
    widgetMode: "background", fallbackSubagent: "general-purpose", toolDescriptionMode: "full", packageAgents: ["only-package"], packageWorkflows: [],
  } });
  scripts = []; inputs = []; notify.mockReset();
  boot = makePi();
  createSubagentsExtension({ clock: new FakeClock() })(boot.pi);
  let firstMenu = true;
  context = ctx({ cwd: env.dir, isProjectTrusted: () => true, ui: {
    ...ctx().ui, notify,
    select: vi.fn(async () => { if (firstMenu) { firstMenu = false; return "Settings"; } return undefined; }),
    input: vi.fn(async () => inputs.shift()),
    custom: vi.fn(async (factory: Factory) => {
      let value: string | undefined;
      let settled = false;
      const component = factory({}, {}, {}, result => { value = result; settled = true; });
      expect(component.render(140).join("\n")).toContain("Subagent Settings");
      component.invalidate();
      for (const key of scripts.shift() ?? ["\u001b"]) {
        component.handleInput(key);
        if (settled) break;
      }
      return value;
    }),
  } });
  await startSession(boot.lifecycle, true, context);
});
afterEach(async () => {
  await boot.lifecycle.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, context);
  env.restore();
});

describe("settings callbacks", () => {
  it.each([
    ["defaultJoinMode", "group"], ["backgroundByDefault", false], ["schedulingEnabled", false],
    ["workflowsEnabled", false], ["packageAgents", false], ["packageWorkflows", true],
    ["scopeModels", true], ["strictAgentFiles", true], ["disableDefaultAgents", true],
    ["fallbackSubagent", "Explore"], ["outputTranscript", false], ["worktreeIsolation", false],
    ["reportUsage", true], ["showCost", true], ["showModel", true], ["viewerMarkdown", "all"],
    ["fleetView", true], ["agentMentions", "direct"], ["rememberAgents", false],
    ["widgetMode", "off"], ["toolDescriptionMode", "compact"],
  ])("persists %s and broadcasts its real snapshot", async (key, expected) => {
    selectRow(String(key));
    await command();
    expect(saved()[String(key)]).toEqual(expected);
    expect(saved().maxConcurrent).toBe(10);
    expect(boot.pi.events.emit).toHaveBeenCalledWith("subagents:settings_changed", {
      settings: expect.objectContaining({ [String(key)]: expected }), persisted: true,
    });
    expect(notify).toHaveBeenLastCalledWith(expect.any(String), "info");
    if (key === "packageAgents") expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("Replaced the allowlist (only-package)"), "info");
  });
  it.each([
    ["maxConcurrent", "7", 7], ["maxConcurrentForeground", "4", 4], ["maxConcurrentForeground", "0", 0],
    ["defaultMaxTurns", "12", 12], ["defaultMaxTurns", "0", 0], ["graceTurns", "6", 6],
    ["maxSubagentDepth", "0", 0], ["maxSubagentDepth", "3", 3],
  ] as const)("types %s=%s and reopens settings", async (key, input, expected) => {
    selectRow(key); inputs.push(input);
    await command();
    expect(saved()[key]).toBe(expected);
    expect(context.ui.custom).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith(expect.any(String), "info");
  });
  it("re-prompts invalid numbers with their trimmed text, then persists a valid integer", async () => {
    selectRow("maxConcurrent"); inputs.push("  nope  ", "", "1.5", "  8  ");
    await command();
    expect(context.ui.input).toHaveBeenNthCalledWith(2, "Max concurrency (1+)", "nope");
    expect(context.ui.input).toHaveBeenNthCalledWith(3, "Max concurrency (1+)", "");
    expect(context.ui.input).toHaveBeenNthCalledWith(4, "Max concurrency (1+)", "1.5");
    expect(saved().maxConcurrent).toBe(8);
  });
  it("cancels typed input without changing the snapshot or broadcasting", async () => {
    const before = readFileSync(settingsPath(), "utf8");
    selectRow("graceTurns"); inputs.push(undefined);
    await command();
    expect(readFileSync(settingsPath(), "utf8")).toBe(before);
    expect(boot.pi.events.emit).not.toHaveBeenCalledWith("subagents:settings_changed", expect.anything());
    expect(notify).not.toHaveBeenCalled();
  });
  it.each(["schedulingEnabled", "workflowsEnabled", "backgroundByDefault", "outputTranscript", "worktreeIsolation", "reportUsage", "showCost", "showModel", "fleetView", "scopeModels", "strictAgentFiles", "disableDefaultAgents", "rememberAgents"])("round-trips %s through both toggle branches", async key => {
    const initial = saved()[key];
    selectRow(key, 2);
    await command();
    expect(saved()[key]).toBe(initial);
    expect(boot.pi.events.emit.mock.calls.filter(([event]: [string]) => event === "subagents:settings_changed")).toHaveLength(2);
  });
  it("cycles mentions through disabled/model and fallback through strict refusal", async () => {
    selectRow("agentMentions", 3);
    // All rows share one real settings component; navigate back to fallback.
    const keys = scripts[0];
    keys.splice(keys.length - 1, 0, ...Array<string>(8).fill("\u001b[A"), "\r", "\r", "\r");
    await command();
    expect(saved().agentMentions).toBe("model");
    expect(saved().fallbackSubagent).toBe("none");
    expect(notify).toHaveBeenCalledWith("Agent mentions disabled", "info");
    expect(notify).toHaveBeenCalledWith("Unknown or disabled agent types will now be rejected", "info");
  });
  it("reports a real persistence failure while retaining and broadcasting the in-memory value", async () => {
    rmSync(settingsPath()); mkdirSync(settingsPath());
    selectRow("showModel");
    await command();
    expect(notify).toHaveBeenLastCalledWith("Model display enabled (session only; failed to persist)", "warning");
    expect(boot.pi.events.emit).toHaveBeenCalledWith("subagents:settings_changed", {
      settings: expect.objectContaining({ showModel: true }), persisted: false,
    });
  });
});
