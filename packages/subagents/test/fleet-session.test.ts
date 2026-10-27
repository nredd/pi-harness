/** Fleet lifecycle and in-flight activity through InteractiveMode and its actual terminal renderer. */
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { afterEach, expect, it } from "vitest";
import { FLEET_COLLAPSE_KEY, FLEET_STATE_ENTRY } from "../src/ui/fleet-list.js";
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
  if (collapsed) { host.input(TOGGLE); await host.settle(); }
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

it("fleet paints model and live thinking activity", async () => {
  const { host, row } = await start("probe child");
  expect(row()).toMatch(/\bchild\b/);
  fixture.clock.advance(2800);
  await host.settle();
  expect(row()).toContain("thinking · 3s");
});

it("silent stream repaints at the stall threshold without input", async () => {
  const { host, row } = await start("silent child");
  fixture.clock.advance(119_600);
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
