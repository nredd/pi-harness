/** The settings dialog opened over the opposite of `index-coverage-settings`' defaults: every toggle reads its other value. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { FakeClock } from "@nredd/pi-test-lib/clock";
import { deferred } from "@nredd/pi-test-lib/deferred";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSubagentsExtension } from "../src/index.js";
import { type BootedPi, ctx, type Hermetic, hermeticDir, makePi, startSession } from "./helpers/boot-extension.js";

type Component = { render(width: number): string[]; handleInput(data: string): void };
type Factory = (tui: unknown, theme: unknown, keys: unknown, done: (value: string | undefined) => void) => Component;
let env: Hermetic;
let boot: BootedPi;
let context: ExtensionCommandContext;
const notify = vi.fn();

beforeEach(async () => {
  initTheme("dark");
  env = hermeticDir({ settings: {
    defaultJoinMode: "group", backgroundByDefault: false, schedulingEnabled: false, workflowsEnabled: false,
    packageAgents: false, scopeModels: true, strictAgentFiles: true, disableDefaultAgents: true,
    outputTranscript: false, worktreeIsolation: false, reportUsage: true, showCost: true, showModel: true,
    rememberAgents: false,
  } });
  notify.mockReset();
  boot = makePi();
  createSubagentsExtension({ clock: new FakeClock() })(boot.pi);
  context = ctx({ cwd: env.dir, isProjectTrusted: () => true, ui: { ...ctx().ui, notify } });
  await startSession(boot.lifecycle, true, context);
});
afterEach(async () => {
  await boot.lifecycle.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, context);
  env.restore();
});

/** The value column of each settings row, keyed by its label. */
function rowValues(lines: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of lines.map(stripTerminalSequences)) {
    const match = /^\W*(\S.*?\S)\s{2,}(\S+)\s*$/.exec(line);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

describe("settings dialog current values", () => {
  it("shows each toggle's saved off/on and group join mode", async () => {
    let lines: string[] = [];
    context.ui.select = vi.fn().mockResolvedValueOnce("Settings").mockResolvedValue(undefined);
    context.ui.custom = vi.fn(async (factory: Factory) => {
      const component = factory({}, {}, {}, () => {});
      lines = component.render(200);
      component.handleInput("\u001b");
      return undefined;
    });
    await boot.commands.get("agents").handler("", context);
    const values = rowValues(lines);
    expect(Object.fromEntries([
      "Join mode", "Background by default", "Scheduling", "Package agents", "Scope models",
      "Strict agent files", "Disable defaults", "Output transcript", "Worktree isolation",
      "Report usage to session", "Show cost", "Show model", "Remember agents",
    ].map(label => [label, values.get(label)]))).toEqual({
      "Join mode": "group", "Background by default": "off", Scheduling: "off", "Package agents": "off",
      "Scope models": "on", "Strict agent files": "on", "Disable defaults": "on", "Output transcript": "off",
      "Worktree isolation": "off", "Report usage to session": "on", "Show cost": "on", "Show model": "on", "Remember agents": "off",
    });
  });

  it.each([["Scheduling", 8], ["Workflows", 9]] as const)("keeps %s on when overlapping dialogs both enable it", async (label, row) => {
    const ready = deferred();
    const dialogs: Component[] = [];
    let menus = 0;
    context.ui.select = vi.fn(async () => menus++ < 2 ? "Settings" : undefined);
    context.ui.custom = vi.fn((factory: Factory) => new Promise<string | undefined>(resolve => {
      dialogs.push(factory({}, {}, {}, resolve));
      if (dialogs.length === 2) ready.resolve();
    }));
    const first = boot.commands.get("agents").handler("", context);
    const second = boot.commands.get("agents").handler("", context);
    await ready.promise;
    for (const dialog of dialogs) {
      for (let i = 0; i < row; i++) dialog.handleInput("\u001b[B");
      dialog.handleInput("\r");
    }
    expect(notify).toHaveBeenLastCalledWith(`${label} already enabled.`, "info");
    const key = label === "Scheduling" ? "schedulingEnabled" : "workflowsEnabled";
    expect(JSON.parse(readFileSync(join(env.dir, ".pi", "subagents.json"), "utf8"))[key]).toBe(true);
    for (const dialog of dialogs) dialog.handleInput("\u001b");
    await Promise.all([first, second]);
  });
});
