/** Fleet lifecycle and in-flight activity through InteractiveMode and its actual terminal renderer. */
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { afterEach, expect, it } from "vitest";
import { FLEET_COLLAPSE_KEY, FLEET_DISCLOSURE_SETTLE_MS } from "../src/ui/fleet-list.js";
import { FLEET_STATE_ENTRY } from "../src/ui/fleet-state.js";
import { answer, calls, ScenarioSession, spawn } from "./helpers/scenario-session.js";

const TOGGLE = "\x1b[97;6u"; // Kitty ctrl+shift+a press, distinct from ctrl+a

let fixture: ScenarioSession;
afterEach(async () => fixture?.dispose());

/** Boot one held real child; a provider start barrier precedes every screen assertion. */
async function start(description: string) {
  fixture = new ScenarioSession();
  const p = fixture.physical("fauxchild", "child", [answer("CHILD DONE")]);
  const stream = fixture.holdStream(p);
  const h = await fixture.start({ terminal: true, harness: { sessionManager: SessionManager.create(fixture.cwd, join(fixture.root, "sessions")) } });
  h.setResponses([calls(spawn(description, { model: "fauxchild/child" })), answer("SPAWNED")]);
  await h.session.prompt("go");
  await stream.entered;
  const host = fixture.host;
  if (!host) throw new Error("No terminal host");
  await host.settle();
  fixture.clock.advance(200);
  await host.settle();
  const row = () => host.viewport().find(line => /^\s+[●○] Agent\s+/.test(line)) ?? "";
  expect(host.viewport().join("\n")).toContain("SPAWNED");
  expect(host.viewport().join("\n")).toContain("agents: 1 running");
  expect(row()).toBe("");
  host.input(TOGGLE);
  await host.settle();
  expect(host.viewport().join("\n")).toMatch(/^\s+[●○] main\s*$/m);
  expect(row()).toContain(description);
  fixture.clock.advance(FLEET_DISCLOSURE_SETTLE_MS);
  return { h, host, stream, row };
}

it("running fleet re-registers after core reload", async () => {
  const { h, host, stream, row } = await start("probe child");
  const id = h.session.messages.filter(m => m.role === "toolResult" && m.toolName === "Agent").flatMap(m => m.content).find(p => p.type === "text")?.text.match(/Agent ID: (\S+)/)?.[1];
  if (!id) throw new Error("Missing spawn id");
  const record = fixture.record(id);
  const oldRunner = h.session.extensionRunner;
  host.input("/reload");
  host.input("\r");
  await host.settle();
  expect(h.session.extensionRunner).not.toBe(oldRunner);
  expect(host.viewport().join("\n")).toContain("Reloaded ");
  expect(record.status).toBe("running");
  expect(row()).toContain("probe child"); // explicit expansion is replayed from the session branch
  // Raw fleet navigation still owns the keys after the real widget reset/rebind.
  host.input("\x1b[B");
  await host.settle();
  expect(host.viewport().join("\n")).toContain("enter view");
  stream.release();
  await record.promise;
});

it.each([false, true])("restores explicit collapsed=%s from disk when a fresh host resumes the same session", async collapsed => {
  const { h, host, stream } = await start("before resume");
  if (collapsed) { host.input(TOGGLE); await host.settle(); fixture.clock.advance(FLEET_DISCLOSURE_SETTLE_MS); }
  const path = h.sessionManager.getSessionFile();
  if (!path) throw new Error("Missing persisted session");
  const snapshots = h.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === FLEET_STATE_ENTRY);
  expect(snapshots.at(-1)).toMatchObject({ data: { version: 1, collapsed } });
  const completed = fixture.completion();
  stream.release();
  await completed;
  await host.dispose(); // destroys the activation, not just the widget instance

  const resumed = await fixture.start({ terminal: true, harness: { sessionManager: SessionManager.open(path) } });
  const resumedStream = fixture.holdStream(fixture.providers[0]);
  resumed.setResponses([calls(spawn("after resume", { model: "fauxchild/child" })), answer("RESUMED")]);
  await resumed.session.prompt("continue");
  await resumedStream.entered;
  const terminal = fixture.host;
  if (!terminal) throw new Error("Missing resumed host");
  fixture.clock.advance(200);
  await terminal.settle();
  const row = terminal.viewport().find(line => /^\s+[●○] Agent\s+after resume/.test(line));
  if (collapsed) {
    expect(row).toBeUndefined();
    expect(terminal.viewport().join("\n")).toContain("agents: 1 running");
  } else expect(row).toContain("after resume");
  // Replay did not append a second state entry or leak state into model messages.
  expect(resumed.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === FLEET_STATE_ENTRY)).toHaveLength(snapshots.length);
  expect(resumed.session.messages.some(message => JSON.stringify(message).includes(FLEET_STATE_ENTRY))).toBe(false);
  resumedStream.release();
});

it("disclosure key round-trips through the real editor without colliding with registered shortcuts", async () => {
  const { h, host, stream, row } = await start("toggle child");
  const keymap = getKeybindings().getResolvedBindings();
  expect(Object.keys(keymap)).toContain("app.interrupt");
  const registered = h.session.extensionRunner?.getShortcuts(keymap);
  expect(registered).toBeDefined();
  const nativeKeys = Object.values(keymap).flatMap(keys => typeof keys === "string" ? [keys] : keys);
  expect([...nativeKeys, ...registered!.keys(), "ctrl+shift+t", "ctrl+shift+m", "shift+tab", "ctrl+b", "left", "down"])
    .not.toContain(FLEET_COLLAPSE_KEY);
  host.input(TOGGLE); // start() explicitly expanded
  await host.settle();
  expect(row()).toBe("");
  expect(host.viewport().filter(line => line.includes("agents: 1 running"))).toHaveLength(1);
  host.input("\x1b[97;6:3u"); // release must not re-expand
  await host.settle();
  expect(row()).toBe("");
  host.input(TOGGLE);
  await host.settle();
  expect(row()).toContain("toggle child");
  stream.release();
});

it("quota parking refreshes the one-line fleet without creating a child session", async () => {
  fixture = new ScenarioSession();
  fixture.physical("fauxchild", "child", [answer("MUST NOT RUN")]);
  const h = await fixture.start({ terminal: true, noRouter: true, factories: [pi => {
    pi.events.on("router:rpc:admit", raw => {
      const { requestId } = raw as { requestId: string };
      pi.events.emit(`router:rpc:admit:reply:${requestId}`, { success: true, data: { ok: false, resetAt: fixture.clock.now() + 60_000, wait: true } });
    });
  }] });
  h.setResponses([calls(spawn("parked child", { model: "fauxchild/child" })), answer("PARKED")]);
  await h.session.prompt("go");
  const host = fixture.host;
  if (!host) throw new Error("No terminal host");
  await host.settle();
  expect(host.viewport().filter(line => line.trimStart().startsWith("[1 parked] agents:"))).toHaveLength(1);
  expect(host.viewport().join("\n")).not.toMatch(/^\s+[●○] main/m);
  expect(fixture.providers[0].state.callCount).toBe(0);
});

it("keeps a failed child flagged after linger and clears it only when its result is consumed", async () => {
  fixture = new ScenarioSession();
  fixture.physical("fauxchild", "child", [answer("", { stopReason: "error", errorMessage: "CHILD FAILURE" })]);
  let failed!: () => void;
  const failure = new Promise<void>(resolve => { failed = resolve; });
  const h = await fixture.start({ terminal: true, factories: [pi => {
    pi.events.on("subagents:failed", () => failed());
  }] });
  h.setResponses([calls(spawn("broken child", { model: "fauxchild/child" })), answer("SPAWNED")]);
  await h.session.prompt("go");
  await failure;
  const result = h.session.messages.find(message => message.role === "toolResult" && message.toolName === "Agent");
  const id = result?.content.find(part => part.type === "text")?.text.match(/Agent ID: (\S+)/)?.[1];
  if (!id) throw new Error("Missing failed child id");
  const host = fixture.host;
  if (!host) throw new Error("No terminal host");
  h.setResponses([answer("NOTICED")]); // delivery of a notice alone is not acknowledgement
  fixture.clock.advance(5_000);
  await host.settle();
  await h.session.waitForIdle();
  await host.settle();
  expect(host.viewport().filter(line => line.trimStart().startsWith("[1 failed] agents:"))).toHaveLength(1);
  expect(fixture.record(id).resultConsumed).not.toBe(true);
  h.setResponses([calls({ name: "get_subagent_result", args: { agent_id: id } }), answer("ACKNOWLEDGED")]);
  await h.session.prompt("read the failure");
  fixture.clock.advance(200);
  await host.settle();
  expect(fixture.record(id).resultConsumed).toBe(true);
  expect(host.viewport().some(line => line.trimStart().startsWith("[1 failed] agents:"))).toBe(false);
});

it("reloads unread failures, then honors their acknowledgement on fresh-host disk resume", async () => {
  const { h, host, stream } = await start("durable failure");
  const tool = h.session.messages.find(message => message.role === "toolResult" && message.toolName === "Agent");
  const id = tool?.content.find(part => part.type === "text")?.text.match(/Agent ID: (\S+)/)?.[1];
  if (!id) throw new Error("Missing child id");
  const record = fixture.record(id);
  fixture.providers[0].setResponses([answer("", { stopReason: "error", errorMessage: "DURABLE FAILURE" })]);
  stream.release();
  await record.promise;
  host.input(TOGGLE); // collapsed summary after completion
  fixture.clock.advance(FLEET_DISCLOSURE_SETTLE_MS);
  await host.settle();
  const path = h.sessionManager.getSessionFile();
  if (!path) throw new Error("Missing persisted session");
  host.input("/reload"); host.input("\r");
  await host.settle();
  expect(host.viewport().some(line => line.trimStart().startsWith("[1 failed] agents:"))).toBe(true);
  await host.dispose();
  const resumed = await fixture.start({ terminal: true, harness: { sessionManager: SessionManager.open(path) } });
  const fresh = fixture.host;
  if (!fresh) throw new Error("Missing fresh host");
  await fresh.settle();
  expect(fresh.viewport().some(line => line.trimStart().startsWith("[1 failed] agents:"))).toBe(true);
  // Minimal restored rows have no live session; inspecting their toast acknowledges the identity.
  fresh.input("\x1b[B"); fresh.input("\x1b[B"); fresh.input("\r");
  await fresh.settle();
  const states = resumed.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === FLEET_STATE_ENTRY);
  expect(states.at(-1)).toMatchObject({ data: { transition: { alert: { id }, acknowledged: true } } });
  await fresh.dispose();
  await fixture.start({ terminal: true, harness: { sessionManager: SessionManager.open(path) } });
  const acknowledged = fixture.host;
  if (!acknowledged) throw new Error("Missing acknowledged host");
  fixture.clock.advance(5000);
  await acknowledged.settle();
  expect(acknowledged.viewport().some(line => line.trimStart().startsWith("[1 failed] agents:"))).toBe(false);
});

it("ingests a running detached failure between ticks after reload unregisters its record", async () => {
  const { h, host, stream } = await start("detached failure");
  const tool = h.session.messages.find(message => message.role === "toolResult" && message.toolName === "Agent");
  const id = tool?.content.find(part => part.type === "text")?.text.match(/Agent ID: (\S+)/)?.[1];
  if (!id) throw new Error("Missing child id");
  const record = fixture.record(id);
  host.input(TOGGLE);
  fixture.clock.advance(FLEET_DISCLOSURE_SETTLE_MS);
  host.input("/reload"); host.input("\r");
  await host.settle();
  expect(record.status).toBe("running");
  fixture.providers[0].setResponses([answer("", { stopReason: "error", errorMessage: "BETWEEN TICKS" })]);
  stream.release();
  await record.promise; // NO clock tick: terminal unregister -> spool -> active sink must ingest directly
  await host.settle();
  expect(record.status).toBe("error");
  expect(host.viewport().some(line => line.trimStart().startsWith("[1 failed] agents:"))).toBe(true);
  const states = h.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === FLEET_STATE_ENTRY);
  expect(states.at(-1)).toMatchObject({ data: { transition: { alert: { id, state: "error" }, acknowledged: false } } });
});

it("journals terminal failure before its public lifecycle event and result consumption in a headless session", async () => {
  fixture = new ScenarioSession();
  fixture.physical("fauxchild", "child", [answer("", { stopReason: "error", errorMessage: "HEADLESS FAILURE" })]);
  let signalFailure!: () => void;
  const failure = new Promise<void>(resolve => { signalFailure = resolve; });
  let atTerminalEvent: unknown;
  const h = await fixture.start({ factories: [pi => { pi.events.on("subagents:failed", () => {
    atTerminalEvent = h.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === FLEET_STATE_ENTRY).at(-1);
    signalFailure();
  }); }],
    harness: { sessionManager: SessionManager.create(fixture.cwd, join(fixture.root, "sessions")) } });
  h.setResponses([calls(spawn("headless failure", { model: "fauxchild/child" })), answer("SPAWNED")]);
  await h.session.prompt("go");
  await failure;
  const tool = h.session.messages.find(message => message.role === "toolResult" && message.toolName === "Agent");
  const id = tool?.content.find(part => part.type === "text")?.text.match(/Agent ID: (\S+)/)?.[1];
  if (!id) throw new Error("Missing headless child id");
  const states = () => h.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === FLEET_STATE_ENTRY);
  expect(atTerminalEvent).toMatchObject({ data: { transition: { alert: { id, state: "error" }, acknowledged: false } } });
  expect(states().at(-1)).toMatchObject({ data: { transition: { alert: { id, state: "error" }, acknowledged: false } } });
  h.setResponses([calls({ name: "get_subagent_result", args: { agent_id: id } }), answer("READ")]);
  await h.session.prompt("read");
  expect(states().at(-1)).toMatchObject({ data: { transition: { alert: { id }, acknowledged: true } } });
  expect(h.session.messages.some(message => JSON.stringify(message).includes(FLEET_STATE_ENTRY))).toBe(false);
});

it("never journals an inline-consumed failure, even before polling or after disk resume", async () => {
  fixture = new ScenarioSession();
  fixture.physical("fauxchild", "child", [answer("", { stopReason: "error", errorMessage: "INLINE FAILURE" })]);
  let atTerminalEvent: unknown[] = [];
  const h = await fixture.start({ factories: [pi => { pi.events.on("subagents:failed", () => {
    atTerminalEvent = h.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === FLEET_STATE_ENTRY);
  }); }], harness: { sessionManager: SessionManager.create(fixture.cwd, join(fixture.root, "sessions")) } });
  h.setResponses([calls(spawn("inline failure", { model: "fauxchild/child", run_in_background: false })), answer("READ INLINE")]);
  await h.session.prompt("go");
  expect(atTerminalEvent).toEqual([]); // settleRun consumes foreground results BEFORE its terminal callback
  expect(h.session.messages.some(message => message.role === "toolResult" && message.toolName === "Agent" && JSON.stringify(message).includes("INLINE FAILURE"))).toBe(true);
  const path = h.sessionManager.getSessionFile();
  if (!path) throw new Error("Missing persisted session");
  await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  h.cleanup(); // no manager/record survives into the fresh host
  const resumed = await fixture.start({ harness: { sessionManager: SessionManager.open(path) } });
  expect(resumed.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === FLEET_STATE_ENTRY)).toEqual([]);
});

it("fleet paints model and live thinking activity", async () => {
  const { host, row } = await start("probe child");
  expect(row()).toMatch(/\bchild\b/);
  fixture.clock.advance(2800);
  await host.settle();
  expect(row()).toContain("thinking · 3s");
});

it("silent stream repaints at the stall threshold without input", async () => {
  const { host, row } = await start("silent child");
  fixture.clock.advance(119_600 - FLEET_DISCLOSURE_SETTLE_MS);
  await host.settle();
  expect(row()).toContain("thinking · 1m59s");
  expect(row()).not.toContain("stalled?");
  fixture.clock.advance(199);
  await host.settle();
  expect(row()).not.toContain("stalled?");
  fixture.clock.advance(1);
  await host.settle();
  expect(row()).toContain("stalled? · 2m00s");
});

it("virtual child row repaints physical model after first response", async () => {
  fixture = new ScenarioSession();
  const hold = fixture.heldTool();
  const physical = fixture.physical("fauxphys", "physical", [calls({ name: "hold", args: {} }), answer("CHILD DONE")]);
  const stream = fixture.holdStream(physical);
  const h = await fixture.start({ terminal: true });
  const model = physical.getModel();
  h.session.modelRuntime.registerVirtualModel({ provider: "vroute", id: "default", name: "vroute default", route: async () => ({ model }) });
  h.setResponses([calls(spawn("probe child", { model: "vroute/default" })), answer("SPAWNED")]);
  await h.session.prompt("go");
  await stream.entered;
  const host = fixture.host;
  if (!host) throw new Error("No terminal host");
  fixture.clock.advance(200);
  await host.settle();
  host.input(TOGGLE);
  await host.settle();
  const row = () => host.viewport().find(line => /^\s+[●○] Agent\s+probe child/.test(line)) ?? "";
  expect(row()).toMatch(/vroute default \(routing\) · think:/);
  stream.release();
  await hold.entered;
  fixture.clock.advance(200);
  await host.settle();
  expect(row()).toMatch(/physical · think:/);
  expect(row()).not.toContain("(routing)");
});
