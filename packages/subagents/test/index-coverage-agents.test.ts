/** Drive /agents' registered command and real SettingsList callbacks against private files. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentConfig, getAllTypes } from "../src/agent-types.js";
import { createSubagentsExtension } from "../src/index.js";
import { type BootedPi, ctx, type Hermetic, hermeticDir, makePi, startSession } from "./helpers/boot-extension.js";
import { FakeClock } from "./helpers/fake-clock.js";

type Dialog = { render(width: number): string[]; invalidate(): void; handleInput(data: string): void };
type Factory = (tui: unknown, theme: unknown, keys: unknown, done: (value: string | undefined) => void) => Dialog;
let env: Hermetic;
let boot: BootedPi;
let context: ExtensionCommandContext;
let selections: (string | undefined)[];
let inputs: (string | undefined)[];
let edits: (string | undefined)[];
let confirmations: boolean[];
let agentSelections: (string | undefined)[];
let menuRows: string[][];
let beforePick: (() => void) | undefined;
const notify = vi.fn();
const original = "---\nname: auditor\ndescription: Original audit\ntools: read\n---\nAudit privately.\n";

function path(name = "auditor") { return join(env.dir, ".pi", "agents", `${name}.md`); }
async function command() { await boot.commands.get("agents").handler("", context); }
async function detail(name: string, action?: string, ...following: (string | undefined)[]) {
  agentSelections.push(name, undefined);
  selections.push("Agent types", action, ...following, undefined);
  await command();
}

beforeEach(async () => {
  initTheme("dark");
  env = hermeticDir({ agentFiles: { auditor: original }, settings: {
    disableDefaultAgents: false, schedulingEnabled: false, fleetView: false, workflowsEnabled: false,
  } });
  selections = []; inputs = []; edits = []; confirmations = []; agentSelections = []; menuRows = [];
  notify.mockReset(); beforePick = undefined;
  boot = makePi();
  createSubagentsExtension({ clock: new FakeClock() })(boot.pi);
  const ui = {
    ...ctx().ui, notify,
    select: vi.fn(async (_title: string, choices: string[]) => {
      menuRows.push(choices);
      const next = selections.shift();
      return next === "Agent types" ? choices.find(c => c.startsWith("Agent types (")) : next;
    }),
    input: vi.fn(async () => inputs.shift()),
    editor: vi.fn(async () => edits.shift()),
    confirm: vi.fn(async () => confirmations.shift() ?? false),
    custom: vi.fn(async (factory: Factory) => {
      let result: string | undefined;
      const component = factory({}, {}, {}, value => { result = value; });
      // Render/invalidate the actual registered component, then send actual keyboard input.
      expect(component.render(120).join("\n")).toContain("Agent types");
      component.invalidate();
      const selected = agentSelections.shift();
      if (selected) {
        const index = getAllTypes().indexOf(selected);
        expect(index).toBeGreaterThanOrEqual(0);
        for (let n = 0; n < index; n++) component.handleInput("\u001b[B");
        beforePick?.(); beforePick = undefined;
        component.handleInput("\r");
      } else component.handleInput("\u001b");
      return result;
    }),
  };
  context = ctx({ ui, cwd: env.dir, isProjectTrusted: () => true });
  await startSession(boot.lifecycle, true, context);
});
afterEach(async () => {
  await boot.lifecycle.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, context);
  env.restore();
  vi.restoreAllMocks();
});

describe("agent file operations from /agents", () => {
  it.each([undefined, "Back"])("cancels detail with %s without changing its file", async action => {
    await detail("auditor", action);
    expect(readFileSync(path(), "utf8")).toBe(original);
    expect(menuRows[1]).toEqual(["Edit", "Disable", "Delete", "Back"]);
    expect(notify).not.toHaveBeenCalled();
  });
  it.each([undefined, original])("does not rewrite a cancelled or unchanged editor", async edited => {
    edits.push(edited);
    await detail("auditor", "Edit");
    expect(readFileSync(path(), "utf8")).toBe(original);
    expect(notify).not.toHaveBeenCalled();
  });
  it("edits the loaded file and reloads its definition", async () => {
    const edited = original.replace("Original audit", "Revised audit");
    edits.push(edited);
    await detail("auditor", "Edit");
    expect(readFileSync(path(), "utf8")).toBe(edited);
    expect(getAgentConfig("auditor")?.description).toBe("Revised audit");
    expect(notify).toHaveBeenCalledWith(`Updated ${path()}`, "info");
  });
  it.each([false, true])("deletes only after confirmation %s", async confirmed => {
    confirmations.push(confirmed);
    await detail("auditor", "Delete");
    expect(existsSync(path())).toBe(!confirmed);
    expect(getAgentConfig("auditor") !== undefined).toBe(!confirmed);
    expect(context.ui.confirm).toHaveBeenCalledWith("Delete agent", expect.stringContaining(path()));
    if (confirmed) expect(notify).toHaveBeenCalledWith(`Deleted ${path()}`, "info");
    else expect(notify).not.toHaveBeenCalled();
  });
  it("disables and enables an existing definition without losing its body", async () => {
    await detail("auditor", "Disable");
    expect(readFileSync(path(), "utf8")).toBe(original.replace("---\n", "---\nenabled: false\n"));
    expect(getAgentConfig("auditor")?.enabled).toBe(false);
    await detail("auditor", "Enable");
    expect(menuRows).toContainEqual(["Enable", "Edit", "Delete", "Back"]);
    expect(readFileSync(path(), "utf8")).toBe(original);
    expect(getAgentConfig("auditor")?.enabled).not.toBe(false);
    expect(notify).toHaveBeenLastCalledWith(`Enabled auditor (${path()})`, "info");
  });
  it("reports a definition without frontmatter rather than claiming a disable", async () => {
    writeFileSync(path(), "Private body only.\n");
    await detail("auditor", "Disable");
    expect(readFileSync(path(), "utf8")).toBe("Private body only.\n");
    expect(notify).toHaveBeenCalledWith(`Cannot disable auditor: ${path()} has no frontmatter block.`, "error");
  });
  it("does not claim to enable a noncanonical disabled flag it cannot remove", async () => {
    const content = original.replace("---\n", "---\nenabled: FALSE\n");
    writeFileSync(path(), content);
    await detail("auditor", "Enable");
    expect(readFileSync(path(), "utf8")).toBe(content);
    expect(notify).toHaveBeenCalledWith(`auditor is not disabled in ${path()}.`, "info");
  });
  it.each(["Project", "Personal"])("shadows a built-in in %s and removes only its stub on enable", async scope => {
    const target = scope === "Project" ? path("Plan") : join(process.env.PI_CODING_AGENT_DIR!, "agents", "Plan.md");
    await detail("Plan", "Disable", scope);
    expect(readFileSync(target, "utf8")).toBe("---\nenabled: false\n---\n");
    expect(getAgentConfig("Plan")?.enabled).toBe(false);
    await detail("Plan", "Enable");
    expect(existsSync(target)).toBe(false);
    expect(getAgentConfig("Plan")?.isDefault).toBe(true);
    expect(getAgentConfig("Plan")?.enabled).not.toBe(false);
    expect(notify).toHaveBeenLastCalledWith(`Enabled Plan (removed ${target})`, "info");
  });
  it("cancels a built-in disable before creating its stub", async () => {
    await detail("Plan", "Disable", undefined);
    expect(existsSync(path("Plan"))).toBe(false);
    expect(getAgentConfig("Plan")?.enabled).not.toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });
  it.each(["Project", "Personal"])("ejects the built-in into %s and reloads an editable override", async scope => {
    const before = getAgentConfig("Plan")!;
    const target = scope === "Project" ? path("Plan") : join(process.env.PI_CODING_AGENT_DIR!, "agents", "Plan.md");
    await detail("Plan", "Eject (export as .md)", scope);
    expect(readFileSync(target, "utf8")).toContain(before.systemPrompt);
    expect(getAgentConfig("Plan")?.sourcePath).toBe(target);
    expect(getAgentConfig("Plan")?.description).toBe(before.description);
    expect(notify).toHaveBeenLastCalledWith(`Ejected Plan to ${target}`, "info");
  });
  it("cancels ejection before choosing a destination", async () => {
    await detail("Plan", "Eject (export as .md)", undefined);
    expect(existsSync(path("Plan"))).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });
  it.each([false, true])("resets an ejected built-in only after confirmation %s", async confirmed => {
    // An external editor may create the override while the type picker is open.
    // The selected registry entry is still the built-in until the command reloads.
    const ejected = original.replace("name: auditor", "name: Plan");
    beforePick = () => writeFileSync(path("Plan"), ejected);
    confirmations.push(confirmed);
    notify.mockClear();
    await detail("Plan", "Reset to default");
    expect(menuRows).toContainEqual(["Edit", "Disable", "Reset to default", "Delete", "Back"]);
    expect(existsSync(path("Plan"))).toBe(!confirmed);
    if (confirmed) {
      expect(getAgentConfig("Plan")?.sourcePath).toBeUndefined();
      expect(notify).toHaveBeenCalledWith("Restored default Plan", "info");
    } else {
      expect(readFileSync(path("Plan"), "utf8")).toBe(ejected);
      expect(notify).not.toHaveBeenCalled();
    }
  });
});

describe("manual creation through /agents", () => {
  it.each([
    ["all", "inherit (parent model)", "inherit", undefined, undefined],
    ["none", "haiku", "high", [], "anthropic/claude-haiku-4-5"],
    ["read-only (read, bash, grep, find, ls)", "sonnet", "low", ["read", "bash", "grep", "find", "ls"], "anthropic/claude-sonnet-4-6"],
    ["custom...", "opus", "medium", ["read", "grep"], "anthropic/claude-opus-4-6"],
    ["none", "custom...", "off", [], "fixture/model"],
  ] as const)("creates %s tools with %s model and %s thinking", async (tools, model, thinking, builtins, expectedModel) => {
    selections.push("Create new agent", "Project", "Manual configuration", tools, model, thinking);
    inputs.push("created", "Review: secrets #carefully");
    if (tools === "custom...") inputs.push("read, grep");
    if (model === "custom...") inputs.push("fixture/model");
    edits.push("Keep the private audit local.");
    await command();
    expect(readFileSync(path("created"), "utf8")).toContain("Keep the private audit local.");
    const config = getAgentConfig("created");
    expect(config?.description).toBe("Review: secrets #carefully");
    expect(config?.model).toBe(expectedModel);
    expect(config?.thinking).toBe(thinking === "inherit" ? undefined : thinking);
    if (tools === "all") expect(config?.builtinToolNames).toEqual(expect.arrayContaining(["read", "write", "bash"]));
    else expect(config?.builtinToolNames).toEqual(builtins);
    expect(notify).toHaveBeenLastCalledWith(`Created ${path("created")}`, "info");
  });
  it.each([false, true])("overwrites a personal definition only on confirmation %s", async confirmed => {
    const target = join(process.env.PI_CODING_AGENT_DIR!, "agents", "created.md");
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, original);
    selections.push("Create new agent", "Personal", "Manual configuration", "none", "inherit (parent model)", "inherit");
    inputs.push("created", "New personal agent"); edits.push("New body."); confirmations.push(confirmed);
    await command();
    expect(readFileSync(target, "utf8")).toBe(confirmed ? '---\ndescription: "New personal agent"\ntools: none\nprompt_mode: replace\n---\n\nNew body.\n' : original);
    if (!confirmed) expect(notify).not.toHaveBeenCalled();
  });
  it.each(["location", "method", "name", "description", "tools", "custom tools", "model", "thinking", "editor"])("cancels at %s without writing an agent", async stage => {
    selections.push("Create new agent");
    if (stage !== "location") selections.push("Project");
    if (!["location", "method"].includes(stage)) selections.push("Manual configuration");
    if (!["location", "method", "name"].includes(stage)) inputs.push("created");
    if (!["location", "method", "name", "description"].includes(stage)) inputs.push("Description");
    if (["custom tools", "model", "thinking", "editor"].includes(stage)) selections.push(stage === "custom tools" ? "custom..." : "none");
    if (["thinking", "editor"].includes(stage)) selections.push("inherit (parent model)");
    if (stage === "editor") selections.push("inherit");
    await command();
    expect(existsSync(path("created"))).toBe(false);
    expect(getAgentConfig("created")).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });
});
