/**
 * #294: children share the parent's model runtime and each child's extension load
 * re-registers `router/*` into it, so the slot belongs to whichever child loaded
 * last. These run the real `@nredd/pi-subscription-router` in the parent and, from
 * disk, in every child; nothing about the mechanism is stubbed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { createHarness } from "@earendil-works/pi-coding-agent/testing";
import { afterEach, expect, it, vi } from "vitest";
import subscriptionRouter from "../../subscription-router/src/index.js";
import { AgentManager } from "../src/agent-manager.js";
import { answer, barrier, calls, ScenarioSession, spawn } from "./helpers/scenario-session.js";

const ROUTER_SOURCE = fileURLToPath(new URL("../../subscription-router/src/index.ts", import.meta.url));
/** Past the longest record retention, so the sweep disposes a finished child no matter who read it. */
const PAST_RETENTION_MS = 61 * 60_000;

let fixture: ScenarioSession;
afterEach(async () => {
  vi.restoreAllMocks();
  await fixture?.dispose();
  Reflect.deleteProperty(globalThis, Symbol.for("pi-subagents:manager"));
});

/** Parent on the harness model, real router in parent and children, one physical model behind `router/default`. */
async function startFleet(script: ReturnType<typeof answer>[]) {
  fixture = new ScenarioSession();
  writeFileSync(join(fixture.agentDir, "subscription-router.json"), JSON.stringify({
    profiles: { default: { name: "Router default", chain: [{ model: "fauxphys/physical" }] } },
  }));
  const hold = fixture.heldTool();
  const extensions = join(fixture.cwd, ".pi", "extensions");
  mkdirSync(extensions, { recursive: true });
  writeFileSync(join(extensions, "router.ts"), `export { default } from ${JSON.stringify(ROUTER_SOURCE)};\n`);
  const physical = fixture.physical("fauxphys", "physical", script);
  // A persisted session: only then does a reload detach (not abort) running children.
  const sessionManager = SessionManager.create(fixture.cwd, join(fixture.root, "sessions"));
  const h = await fixture.start({
    factories: [subscriptionRouter],
    harness: { sessionManager, useModelRuntimeStream: true },
  });
  return { h, hold, physical };
}

type Fleet = Awaited<ReturnType<typeof startFleet>>;

/** Spawn one `router/default` child through the real Agent tool and return its live record. */
async function startChild({ h }: Fleet, description: string) {
  h.setResponses([calls(spawn(description, { model: "router/default" })), answer("SPAWNED"), answer("NOTED"), answer("NOTED")]);
  const before = h.session.messages.length;
  await h.session.prompt(`start ${description}`);
  const id = h.session.messages.slice(before)
    .filter(m => m.role === "toolResult" && m.toolName === "Agent")
    .flatMap(m => m.content)
    .find(p => p.type === "text")?.text.match(/Agent ID: (\S+)/)?.[1];
  if (!id) throw new Error(`Missing spawn id for ${description}`);
  return fixture.record(id);
}

/** Let the manager's real sweep dispose finished children, and wait until it has. */
async function sweep(...records: ReturnType<ScenarioSession["record"]>[]) {
  await Promise.all(records.map(record => record.promise));
  const disposals = records.map(record => {
    expect(["completed", "stopped"]).toContain(record.status);
    const session = record.session;
    if (!session) throw new Error("Finished child has no session");
    const disposed = barrier();
    const dispose = session.dispose.bind(session);
    session.dispose = () => { dispose(); disposed.resolve(); };
    return disposed.promise;
  });
  fixture.clock.advance(PAST_RETENTION_MS);
  await Promise.all(disposals);
}

/** The parent's next turn on `router/default`, resolved through the real runtime. */
async function routeParent({ h }: Fleet) {
  const model = h.session.modelRuntime.getModel("router", "default");
  if (!model) throw new Error("router/default is not registered");
  await h.session.agent.waitForIdle();
  await h.session.setModel(model);
  await h.session.prompt("parent routes");
  return h.session.messages.at(-1) as Record<string, unknown>;
}

/** A real answer from the physical model, not a failed routing attempt on the virtual one. */
function expectRouted(message: Record<string, unknown>) {
  expect(message.errorMessage).toBeUndefined();
  expect(message).toMatchObject({ stopReason: "stop", provider: "fauxphys" });
}

it("control: with the last-registered child alive a sibling routes on unmodified main too", { timeout: 30_000 }, async () => {
  const fleet = await startFleet([calls({ name: "hold", args: {} }), answer("B DONE"), answer("A DONE")]);
  const a = await startChild(fleet, "child a");
  await fleet.hold.entered;
  await (await startChild(fleet, "child b")).promise;
  fleet.hold.release();
  await a.promise;
  expect(a.error).toBeUndefined();
  expect(a.result).toBe("A DONE");
});

it("a sibling and parent route after an unstarted disk-loaded child is disposed", { timeout: 30_000 }, async () => {
  const fleet = await startFleet([calls({ name: "hold", args: {} }), answer("PARENT ROUTED"), answer("A DONE")]);
  const a = await startChild(fleet, "child a");
  await fleet.hold.entered;
  const loader = new DefaultResourceLoader({ cwd: fixture.cwd, agentDir: fixture.agentDir, additionalExtensionPaths: [ROUTER_SOURCE] });
  await loader.reload();
  const unstarted = await createHarness({ cwd: fixture.cwd, resourceLoader: loader, modelRuntime: fleet.h.session.modelRuntime, useModelRuntimeStream: true });
  unstarted.cleanup();
  const parent = await routeParent(fleet);
  fleet.hold.release();
  await a.promise;
  expectRouted(parent);
  expect(fleet.h.session.sessionManager.getBranch()).toContainEqual(expect.objectContaining({ type: "custom", customType: "router:decision", data: expect.objectContaining({ chosen: "fauxphys/physical" }) }));
  expect(a.error).toBeUndefined();
  expect(a.result).toBe("A DONE");
});

/** #581: cancel the real manager run after SDK construction but before session_start. */
async function cancelBeforeStart(fleet: Fleet) {
  const entered = barrier();
  const release = barrier();
  const bind = AgentSession.prototype.bindExtensions;
  const spy = vi.spyOn(AgentSession.prototype, "bindExtensions").mockImplementationOnce(async function (this: AgentSession, ...args) {
    entered.resolve();
    await release.promise;
    return bind.apply(this, args);
  });
  const owner: { manager?: AgentManager; id?: string } = {};
  const spawn = AgentManager.prototype.spawn;
  const spawning = vi.spyOn(AgentManager.prototype, "spawn").mockImplementationOnce(function (this: AgentManager, ...args) {
    owner.manager = this;
    owner.id = spawn.apply(this, args);
    return owner.id;
  });
  const starting = startChild(fleet, "cancel before session_start");
  try {
    await entered.promise;
    const manager = owner.manager;
    const record = owner.id && manager?.getRecord(owner.id);
    if (!manager || !record) throw new Error("Manager did not own the constructing child");
    expect(record.session).toBeUndefined(); // ownership callback follows bindExtensions in runAgent
    expect(manager.abort(record.id)).toBe(true);
    release.resolve();
    await starting;
    await record.promise;
    expect(record.status).toBe("stopped");
    expect(record.session).toBeDefined();
    return { manager, record };
  } finally {
    release.resolve();
    spy.mockRestore();
    spawning.mockRestore();
    await starting;
  }
}

it("#581: manager cancellation before session_start, disposal, and all-child cleanup preserve parent routing", async () => {
  const fleet = await startFleet([answer("PARENT ROUTED")]);
  const { record } = await cancelBeforeStart(fleet);
  await sweep(record);
  expectRouted(await routeParent(fleet));
});

it("#581: a manager-owned cancelled child resumes and routes after the newest registrant is disposed", async () => {
  const fleet = await startFleet([answer("RESUMED"), answer("PARENT ROUTED")]);
  const { manager, record } = await cancelBeforeStart(fleet);
  const loader = new DefaultResourceLoader({ cwd: fixture.cwd, agentDir: fixture.agentDir, additionalExtensionPaths: [ROUTER_SOURCE] });
  await loader.reload();
  const unstarted = await createHarness({ cwd: fixture.cwd, resourceLoader: loader, modelRuntime: fleet.h.session.modelRuntime, useModelRuntimeStream: true });
  unstarted.cleanup();
  const resumed = await manager.resume(record.id, "resume work");
  expect(resumed?.status).toBe("completed");
  expect(resumed?.error).toBeUndefined();
  expect(resumed?.result).toBe("RESUMED");
  await sweep(record);
  expectRouted(await routeParent(fleet));
});

it("a sibling routes after the last-registered child is disposed", { timeout: 30_000 }, async () => {
  const fleet = await startFleet([calls({ name: "hold", args: {} }), answer("B DONE"), answer("A DONE")]);
  const a = await startChild(fleet, "child a");
  await fleet.hold.entered;
  const b = await startChild(fleet, "child b");
  await sweep(b);
  fleet.hold.release();
  await a.promise;
  expect(a.error).toBeUndefined();
  expect(a.status).toBe("completed");
  expect(a.result).toBe("A DONE");
});

it("the parent routes after the last-registered child is disposed while a sibling runs", { timeout: 30_000 }, async () => {
  const fleet = await startFleet([calls({ name: "hold", args: {} }), answer("B DONE"), answer("PARENT ROUTED"), answer("A DONE")]);
  const a = await startChild(fleet, "child a");
  await fleet.hold.entered;
  await sweep(await startChild(fleet, "child b"));
  const routed = await routeParent(fleet);
  fleet.hold.release();
  await a.promise;
  expectRouted(routed);
  expect(a.result).toBe("A DONE");
});

it("the parent routes after every child is disposed", { timeout: 30_000 }, async () => {
  const fleet = await startFleet([answer("A DONE"), answer("B DONE"), answer("PARENT ROUTED")]);
  const a = await startChild(fleet, "child a");
  await a.promise;
  const b = await startChild(fleet, "child b");
  await sweep(a, b);
  expectRouted(await routeParent(fleet));
});

it("a parent reload still leaves a running child and the parent routing", { timeout: 30_000 }, async () => {
  const fleet = await startFleet([calls({ name: "hold", args: {} }), answer("CHILD DONE"), answer("NOTED"), answer("PARENT ROUTED")]);
  const child = await startChild(fleet, "child a");
  await fleet.hold.entered;
  await fleet.h.session.reload();
  fixture.restoreProviders(fleet.h);
  fleet.hold.release();
  await child.promise;
  expect(child.error).toBeUndefined();
  expect(child.result).toBe("CHILD DONE");
  expectRouted(await routeParent(fleet));
});
