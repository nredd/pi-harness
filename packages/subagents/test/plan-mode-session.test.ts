/**
 * plan-mode-session.test.ts -- #437 on the real core host: the real pi-plan-mode
 * extension in the parent, real children that discover real extension files, and
 * every child call through the production hooks. Runs under `bun test` too.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Harness } from "@earendil-works/pi-coding-agent/testing";
import { nextEvent, outcomes, text, toolCalls } from "@nredd/pi-test-lib/faux";
import { afterEach, expect, it } from "vitest";
import planMode from "../../plan-mode/src/plan-mode.js";
import { NOTIFICATION_HOLD_MS } from "../src/completion-outbox.js";
import { PLAN_MODE_GATE_QUERY, PLAN_PARK_REFUSAL, PLAN_SCHEDULE_REFUSAL, planSteerRefusal } from "../src/plan-mode-children.js";
import type { AgentRecord } from "../src/types.js";
import { answer, ScenarioSession, spawn } from "./helpers/scenario-session.js";

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
async function startHost(extra: { factory: ExtensionFactory; path: string }[], planTools: string[], options: { noRouter?: boolean; factories?: ExtensionFactory[] } = {}): Promise<Harness> {
  const settingsPath = join(fixture.root, "pi-plan-mode.json");
  writeFileSync(settingsPath, JSON.stringify({ defaultPlanTools: ["read", "bash", "Agent", "steer_subagent", ...planTools] }));
  return fixture.start({ noRouter: options.noRouter, factories: [pi => planMode(pi, { settingsPath, homeDir: fixture.root }), ...extra, ...(options.factories ?? [])] });
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
  h.setResponses([toolCalls({ name: "steer_subagent", args: { agent_id, message: "continue" } }), answer("STEERED"), answer("NOTICED")]);
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
    toolCalls(...["alpha_write", "gamma_read", "sel_tool", "proj_read", "proj_sel"].map(name => ({ name, args: {} }))),
    answer("CHILD DONE"),
  ]);
  // The parent selected `sel_tool` from the user's file, and `proj_sel` from another install. The path is
  // the one discovery reports, unresolved: under a symlinked tmpdir (macOS `/var`) a realpath would not match.
  const h = await startPlanning(
    [parentTools(userTools, ["sel_tool"]), parentTools(join(fixture.root, "elsewhere", "proj_sel.ts"), ["proj_sel"])],
    ["sel_tool", "proj_sel"],
  );
  h.setResponses([toolCalls(spawn("tools", { run_in_background: false })), answer("PARENT DONE")]);
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
  const write = (path: string) => toolCalls({ name: "write", args: { path, content: "x" } });
  fixture.physical("kid", "child", [write("spawned.txt"), answer("C1"), write("after-exit.txt"), answer("C2"), write("replanned.txt"), answer("C3")]);
  const h = await startPlanning([], []);
  const resume = () => toolCalls(spawn("again", { resume: firstChild(h).id, run_in_background: false }));

  h.setResponses([toolCalls(spawn("first", { run_in_background: false })), answer("P1")]);
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
  const write = (path: string) => toolCalls({ name: "write", args: { path, content: "x" } });
  fixture.physical("kid", "child", [write("before-plan.txt"), answer("C1"), write("steered.txt"), answer("C2")]);
  const h = await startHost([], []);

  // Plan is installed but off: the normal spawn and its write are untouched.
  h.setResponses([toolCalls(spawn("first", { run_in_background: false })), answer("P1")]);
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
  const write = (path: string) => toolCalls({ name: "write", args: { path, content: "x" } });
  fixture.physical("kid", "child", [write("planned.txt"), answer("C1"), write("steered.txt"), answer("C2")]);
  const h = await startPlanning([], []);

  h.setResponses([toolCalls(spawn("first", { run_in_background: false })), answer("P1")]);
  await h.session.prompt("Plan the change.");
  const child = firstChild(h);
  expect(existsSync(join(fixture.cwd, "planned.txt"))).toBe(false);

  await h.session.prompt("/plan exit");
  await steerFinished(h, child.id);
  expect(childResults(child).at(-1)?.text).not.toContain("Plan mode blocks");
  expect(existsSync(join(fixture.cwd, "steered.txt"))).toBe(true);
});

it("a running pre-Plan child cannot be steered while planning, and can be after Plan exit", async () => {
  fixture = new ScenarioSession();
  const hold = fixture.heldTool();
  fixture.physical("kid", "child", [toolCalls({ name: "hold", args: {} }), context => answer(`USERS ${context.messages.filter(m => m.role === "user").map(text).join(" | ")}`)]);
  const h = await startHost([], []);
  h.setResponses([toolCalls(spawn("busy")), answer("SPAWNED")]);
  await h.session.prompt("Start it.");
  await hold.entered;
  const receipt = outcomes(h, "Agent")[0]?.text ?? "";
  const id = receipt.match(/Agent ID: (\S+)/)?.[1];
  if (!id) throw new Error(receipt);
  const steer = async (message: string) => {
    h.setResponses([toolCalls({ name: "steer_subagent", args: { agent_id: id, message } }), answer("STEERED")]);
    await h.session.prompt("Steer it.");
    return outcomes(h, "steer_subagent").at(-1)?.text;
  };

  await h.session.prompt("/plan start");
  expect(await steer("EDIT EVERYTHING")).toBe(planSteerRefusal(id));
  expect(fixture.record(id).pendingSteers ?? []).toEqual([]);

  await h.session.prompt("/plan exit");
  expect(await steer("PIVOT")).toContain("Steering message sent to agent");
  const completed = fixture.completion();
  hold.release();
  await completed;
  h.setResponses([toolCalls({ name: "get_subagent_result", args: { agent_id: id, wait: true } }), answer("DONE")]);
  await h.session.prompt("Fetch it.");
  const result = outcomes(h, "get_subagent_result").at(-1)?.text ?? "";
  expect(result).toContain("USERS work | PIVOT");
  expect(result).not.toContain("EDIT EVERYTHING");
});

it("another extension cannot steer a running pre-Plan child over RPC while planning", async () => {
  fixture = new ScenarioSession();
  const hold = fixture.heldTool();
  fixture.physical("kid", "child", [toolCalls({ name: "hold", args: {} }), context => answer(`USERS ${context.messages.filter(m => m.role === "user").map(text).join(" | ")}`)]);
  let bus: ExtensionAPI["events"] | undefined;
  const h = await startHost([], [], { factories: [pi => { bus = pi.events; }] });
  h.setResponses([toolCalls(spawn("busy")), answer("SPAWNED")]);
  await h.session.prompt("Start it.");
  await hold.entered;
  const id = outcomes(h, "Agent")[0]?.text.match(/Agent ID: (\S+)/)?.[1];
  if (!id || !bus) throw new Error(JSON.stringify(outcomes(h, "Agent")));
  const events = bus;
  let n = 0;
  const steer = (message: string) => new Promise<unknown>(resolve => {
    const requestId = `rpc-${++n}`;
    events.on(`subagents:rpc:steer:reply:${requestId}`, resolve);
    events.emit("subagents:rpc:steer", { requestId, agentId: id, message });
  });

  await h.session.prompt("/plan start");
  expect(await steer("EDIT EVERYTHING")).toEqual({ success: false, error: planSteerRefusal(id) });
  expect(fixture.record(id).pendingSteers ?? []).toEqual([]);

  await h.session.prompt("/plan exit");
  expect(await steer("PIVOT")).toEqual({ success: true });
  const completed = fixture.completion();
  hold.release();
  await completed;
  h.setResponses([toolCalls({ name: "get_subagent_result", args: { agent_id: id, wait: true } }), answer("DONE")]);
  await h.session.prompt("Fetch it.");
  const result = outcomes(h, "get_subagent_result").at(-1)?.text ?? "";
  expect(result).toContain("USERS work | PIVOT");
  expect(result).not.toContain("EDIT EVERYTHING");
});

it("stop_subagent stays available while planning and never asks for the subagent gate", async () => {
  fixture = new ScenarioSession();
  const hold = fixture.heldTool();
  fixture.physical("kid", "child", [toolCalls({ name: "hold", args: {} }), answer("NEVER")]);
  let gateQueries = 0;
  const h = await startHost([], [], { factories: [pi => { pi.events.on(PLAN_MODE_GATE_QUERY, () => { gateQueries++; }); }] });
  h.setResponses([toolCalls(spawn("busy")), answer("SPAWNED")]);
  await h.session.prompt("Start it.");
  await hold.entered;
  const id = outcomes(h, "Agent")[0]?.text.match(/Agent ID: (\S+)/)?.[1];
  if (!id) throw new Error(JSON.stringify(outcomes(h, "Agent")));

  // The steer refusal names stopping as a way out; it has to work under Plan, ungated.
  await h.session.prompt("/plan start");
  const before = gateQueries;
  expect(before).toBeGreaterThan(0); // the listener sees Plan's own announce
  h.setResponses([toolCalls({ name: "stop_subagent", args: { agent_id: id } }), answer("STOPPED")]);
  await h.session.prompt("Stand it down.");
  const [stopped] = outcomes(h, "stop_subagent");
  expect(stopped?.isError).toBe(false);
  expect(stopped?.text).not.toContain("Plan mode blocks");
  expect(gateQueries).toBe(before);
  expect(fixture.record(id).status).toBe("stopped");
  hold.release();
});

it("a schedule is refused while planning", async () => {
  fixture = new ScenarioSession();
  fixture.physical("kid", "child", []);
  const h = await startPlanning([], []);
  h.setResponses([toolCalls(spawn("later", { schedule: "+1h" })), answer("P1")]);
  await h.session.prompt("Plan the change.");
  expect(outcomes(h, "Agent")[0]?.text).toBe(PLAN_SCHEDULE_REFUSAL);
});

it("a quota-blocked dispatch is not parked while planning", async () => {
  fixture = new ScenarioSession();
  const child = fixture.physical("kid", "child", [answer("MUST NOT RUN")]);
  const blocked: ExtensionFactory = pi => {
    pi.events.on("router:rpc:admit", raw => {
      const { requestId } = raw as { requestId: string };
      pi.events.emit(`router:rpc:admit:reply:${requestId}`, { success: true, data: { ok: false, resetAt: fixture.clock.now() + 60_000, wait: true } });
    });
  };
  const h = await startHost([], [], { noRouter: true, factories: [blocked] });
  await h.session.prompt("/plan start");
  h.setResponses([toolCalls(spawn("parked")), answer("P1")]);
  await h.session.prompt("Plan the change.");
  const [outcome] = outcomes(h, "Agent");
  expect(outcome?.isError).toBe(true);
  expect(outcome?.text).toContain(PLAN_PARK_REFUSAL);
  expect(child.state.callCount).toBe(0);
});

it("a worktree child is refused while planning", async () => {
  fixture = new ScenarioSession();
  fixture.physical("kid", "child", []);
  const h = await startPlanning([], []);
  h.setResponses([toolCalls(spawn("wt", { isolation: "worktree", run_in_background: false })), answer("P1")]);
  await h.session.prompt("Plan the change.");
  expect(outcomes(h, "Agent")[0]?.text).toContain('Cannot run with isolation: "worktree" while Plan mode is active');
});
