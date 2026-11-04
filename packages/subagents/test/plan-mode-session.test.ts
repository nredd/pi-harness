/**
 * plan-mode-session.test.ts -- #437 on the real core host: the real pi-plan-mode
 * extension in the parent, real children that discover real extension files, and
 * every child call through the production hooks. Runs under `bun test` too.
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Harness } from "@earendil-works/pi-coding-agent/testing";
import { afterEach, expect, it } from "vitest";
import planMode from "../../plan-mode/src/plan-mode.js";
import { NOTIFICATION_HOLD_MS } from "../src/completion-outbox.js";
import type { AgentRecord } from "../src/types.js";
import { answer, calls, nextEvent, outcomes, ScenarioSession, spawn, text } from "./helpers/scenario-session.js";

let fixture: ScenarioSession;
afterEach(async () => fixture?.dispose());

const RAN = "__planModeSessionRan";

/** One extension file's tools; each reports `<name> RAN` and records that it ran. */
function toolsSource(tools: { name: string; readOnly?: boolean }[]): string {
  const registrations = tools.map(({ name, readOnly }) =>
    `pi.registerTool({ name: ${JSON.stringify(name)}, label: ${JSON.stringify(name)}, description: "fixture", ` +
    `parameters: Type.Object({}), ${readOnly ? "annotations: { readOnlyHint: true }, " : ""}` +
    `execute: async () => { globalThis.${RAN}.push(${JSON.stringify(name)}); return { content: [{ type: "text", text: "${name} RAN" }] }; } });`);
  // Imports like `heldTool`'s fixture, so jiti transpiles it and no temp file lands in Bun's coverage report.
  return `import { Type } from "typebox";\nexport default pi => {\n${registrations.join("\n")}\n};\n`;
}

/** The same tools registered in the parent, as an extension that reports `path` as its source. */
function parentTools(path: string, names: string[]) {
  const factory: ExtensionFactory = (pi: ExtensionAPI) => {
    for (const name of names) {
      pi.registerTool({ name, label: name, description: "fixture", parameters: { type: "object", properties: {} } as never, execute: async () => ({ content: [{ type: "text" as const, text: name }], details: undefined }) });
    }
  };
  return { factory, path };
}

/** A child's own tool results, from its real session. */
function childResults(record: AgentRecord) {
  return (record.session?.messages ?? []).filter(m => m.role === "toolResult").map(m => ({ name: (m as { toolName: string }).toolName, text: text(m) }));
}

/** The child the parent's first `Agent` call ran, read from that call's real result details. */
function firstChild(h: Harness): AgentRecord {
  const ended = h.eventsOfType("tool_execution_end").find(event => event.toolName === "Agent");
  const id = (ended?.result as { details?: { agentId?: string } } | undefined)?.details?.agentId;
  if (!id) throw new Error(JSON.stringify(ended?.result));
  return fixture.record(id);
}

/** Start the parent with pi-plan-mode installed, admitting `Agent`, `steer_subagent` and the opt-in tools named. */
async function startHost(extra: { factory: ExtensionFactory; path: string }[], planTools: string[]): Promise<Harness> {
  const settingsPath = join(fixture.root, "pi-plan-mode.json");
  writeFileSync(settingsPath, JSON.stringify({ defaultPlanTools: ["read", "bash", "Agent", "steer_subagent", ...planTools] }));
  return fixture.start({ factories: [pi => planMode(pi, { settingsPath, homeDir: fixture.root }), ...extra] });
}

/** The same, already in Plan. */
async function startPlanning(extra: { factory: ExtensionFactory; path: string }[], planTools: string[]): Promise<Harness> {
  const h = await startHost(extra, planTools);
  await h.session.prompt("/plan start");
  return h;
}

/**
 * One parent turn steering a finished child, which resumes it in the background; resolves once
 * that run's completion notice has woken the parent and its turn settled.
 */
async function steerFinished(h: Harness, agent_id: string) {
  const completed = fixture.completion();
  let notified = false;
  const settled = nextEvent(h, e => {
    if (e.type === "message_end" && e.message.role === "custom" && e.message.customType === "subagent-notification") notified = true;
    return notified && e.type === "agent_settled";
  });
  h.setResponses([calls({ name: "steer_subagent", args: { agent_id, message: "continue" } }), answer("STEERED"), answer("NOTICED")]);
  await h.session.prompt("Steer it.");
  expect(outcomes(h, "steer_subagent").at(-1)?.text).toContain("Agent resumed in background");
  await completed;
  fixture.clock.advance(NOTIFICATION_HOLD_MS);
  await settled;
}

it("a child started while planning classifies its own extension tools under the parent's Plan policy", async () => {
  fixture = new ScenarioSession();
  Reflect.set(globalThis, RAN, []);
  // User scope: trusted, so an annotated tool is admitted by default.
  mkdirSync(join(fixture.agentDir, "extensions"), { recursive: true });
  const userTools = join(fixture.agentDir, "extensions", "user-tools.ts");
  writeFileSync(userTools, toolsSource([{ name: "alpha_write" }, { name: "gamma_read", readOnly: true }, { name: "sel_tool" }]));
  // Project scope: an untrusted repository's hint never admits, and its copy of a tool is not the user's.
  mkdirSync(join(fixture.cwd, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(fixture.cwd, ".pi", "extensions", "proj.ts"), toolsSource([{ name: "proj_read", readOnly: true }, { name: "proj_sel" }]));
  fixture.physical("kid", "child", [
    calls(...["alpha_write", "gamma_read", "sel_tool", "proj_read", "proj_sel"].map(name => ({ name, args: {} }))),
    answer("CHILD DONE"),
  ]);
  // The parent selected `sel_tool` from the user's file, and `proj_sel` from another install.
  const h = await startPlanning(
    [parentTools(realpathSync(userTools), ["sel_tool"]), parentTools(join(fixture.root, "elsewhere", "proj_sel.ts"), ["proj_sel"])],
    ["sel_tool", "proj_sel"],
  );
  h.setResponses([calls(spawn("tools", { run_in_background: false })), answer("PARENT DONE")]);
  await h.session.prompt("Plan the change.");

  const results = new Map(childResults(firstChild(h)).map(r => [r.name, r.text]));
  expect(results.get("alpha_write")).toBe("Plan mode blocks tool 'alpha_write' in a subagent started while planning because the Plan policy does not admit it.");
  expect(results.get("gamma_read")).toBe("gamma_read RAN");
  expect(results.get("sel_tool")).toBe("sel_tool RAN");
  expect(results.get("proj_read")).toBe("Plan mode blocks tool 'proj_read' in a subagent started while planning because the Plan policy does not admit it.");
  expect(results.get("proj_sel")).toBe("Plan mode blocks tool 'proj_sel' in a subagent started while planning because the Plan policy does not admit it.");
  expect(Reflect.get(globalThis, RAN)).toEqual(["gamma_read", "sel_tool"]);
  Reflect.deleteProperty(globalThis, RAN);
});

it("a resume follows Plan: normal after exit, restricted again after re-entry", async () => {
  fixture = new ScenarioSession();
  const write = (path: string) => calls({ name: "write", args: { path, content: "x" } });
  fixture.physical("kid", "child", [write("spawned.txt"), answer("C1"), write("after-exit.txt"), answer("C2"), write("replanned.txt"), answer("C3")]);
  const h = await startPlanning([], []);
  const resume = () => calls(spawn("again", { resume: firstChild(h).id, run_in_background: false }));

  h.setResponses([calls(spawn("first", { run_in_background: false })), answer("P1")]);
  await h.session.prompt("Plan the change.");
  expect(childResults(firstChild(h)).at(-1)?.text).toBe("Plan mode blocks mutating tool 'write' in a subagent started while planning.");
  expect(existsSync(join(fixture.cwd, "spawned.txt"))).toBe(false);

  await h.session.prompt("/plan exit");
  h.setResponses([resume, answer("P2")]);
  await h.session.prompt("Carry on.");
  expect(childResults(firstChild(h)).at(-1)?.text).not.toContain("Plan mode blocks");
  expect(existsSync(join(fixture.cwd, "after-exit.txt"))).toBe(true);

  await h.session.prompt("/plan start");
  h.setResponses([resume, answer("P3")]);
  await h.session.prompt("Plan more.");
  expect(childResults(firstChild(h)).at(-1)?.text).toBe("Plan mode blocks mutating tool 'write' in a subagent started while planning.");
  expect(existsSync(join(fixture.cwd, "replanned.txt"))).toBe(false);
  expect(outcomes(h, "Agent").map(o => o.isError)).toEqual([false, false, false]);
});

it("steer_subagent resumes a finished pre-Plan child under Plan once Plan is on", async () => {
  fixture = new ScenarioSession();
  const write = (path: string) => calls({ name: "write", args: { path, content: "x" } });
  fixture.physical("kid", "child", [write("before-plan.txt"), answer("C1"), write("steered.txt"), answer("C2")]);
  const h = await startHost([], []);

  // Plan is installed but off: the normal spawn and its write are untouched.
  h.setResponses([calls(spawn("first", { run_in_background: false })), answer("P1")]);
  await h.session.prompt("Do the change.");
  const child = firstChild(h);
  expect(existsSync(join(fixture.cwd, "before-plan.txt"))).toBe(true);

  await h.session.prompt("/plan start");
  await steerFinished(h, child.id);
  expect(childResults(child).at(-1)?.text).toBe("Plan mode blocks mutating tool 'write' in a subagent started while planning.");
  expect(existsSync(join(fixture.cwd, "steered.txt"))).toBe(false);
});

it("steer_subagent resumes a child started during Plan with its normal surface after Plan exit", async () => {
  fixture = new ScenarioSession();
  const write = (path: string) => calls({ name: "write", args: { path, content: "x" } });
  fixture.physical("kid", "child", [write("planned.txt"), answer("C1"), write("steered.txt"), answer("C2")]);
  const h = await startPlanning([], []);

  h.setResponses([calls(spawn("first", { run_in_background: false })), answer("P1")]);
  await h.session.prompt("Plan the change.");
  const child = firstChild(h);
  expect(existsSync(join(fixture.cwd, "planned.txt"))).toBe(false);

  await h.session.prompt("/plan exit");
  await steerFinished(h, child.id);
  expect(childResults(child).at(-1)?.text).not.toContain("Plan mode blocks");
  expect(existsSync(join(fixture.cwd, "steered.txt"))).toBe(true);
});

it("a worktree child is refused while planning", async () => {
  fixture = new ScenarioSession();
  fixture.physical("kid", "child", []);
  const h = await startPlanning([], []);
  h.setResponses([calls(spawn("wt", { isolation: "worktree", run_in_background: false })), answer("P1")]);
  await h.session.prompt("Plan the change.");
  expect(outcomes(h, "Agent")[0]?.text).toContain('Cannot run with isolation: "worktree" while Plan mode is active');
});
