/** Saved history must never shadow a live survivor of a same-process reload. */
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { AgentManager, type EvictedNote } from "../src/agent-manager.js";
import { spoolDetached } from "../src/detached-results.js";
import { answer, calls, outcomes, ScenarioSession, spawn } from "./helpers/scenario-session.js";

let fixture: ScenarioSession;
afterEach(async () => {
  await fixture?.dispose();
  Reflect.deleteProperty(globalThis, Symbol.for("pi-subagents:manager"));
});

it("preserves a delivered detached note and name conflict when saved history fills the index", { timeout: 30_000 }, async () => {
  fixture = new ScenarioSession();
  const sessions = SessionManager.create(fixture.cwd, join(fixture.root, "parents"));
  const h = await fixture.start({ harness: { sessionManager: sessions } });
  h.setResponses([answer("CREATE PARENT")]);
  await h.session.prompt("create parent");
  for (let i = 0; i < 500; i++) sessions.appendCustomEntry("subagents:record", { id: `old-${i}`, type: "general-purpose", description: "older history", status: "completed" });
  sessions.appendCustomEntry("subagents:record", { id: "delivered", type: "general-purpose", description: "stale historical attempt", status: "stopped" });
  const parentFile = sessions.getSessionFile();
  if (!parentFile) throw new Error("No saved parent file");
  await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  h.cleanup();
  const result = (id: string) => ({
    id, content: "synthetic detached result", details: { id },
    evicted: [{ id, type: "general-purpose", description: "detached result", status: "completed" as const, evictedAfterMin: 0 }],
    tombstones: [{ id, handle: "shared", type: "general-purpose", description: "detached result", sessionFile: join(fixture.root, `${id}.jsonl`), completedAt: 1 }],
    record: { id, type: "general-purpose", description: "detached result", status: "completed" },
  });
  spoolDetached(parentFile, result("a-holder"));
  spoolDetached(parentFile, result("delivered"));
  const reopened = await fixture.start({ harness: { sessionManager: SessionManager.open(parentFile) } });
  reopened.setResponses([calls({ name: "steer_subagent", args: { agent_id: "delivered", message: "continue" } }), answer("CHECKED")]);
  await reopened.session.prompt("inspect delivered");
  const text = outcomes(reopened, "steer_subagent")[0]?.text ?? "";
  expect(text).toContain('its name "shared" now belongs to another agent');
  expect(text).not.toContain("recovered from saved parent session");
});

it("bounds both classes and lets actual notes supersede historical duplicates", () => {
  const manager = new AgentManager(() => {});
  const note = (id: string, historical: boolean): EvictedNote => ({ id, type: "general-purpose", description: historical ? "historical" : "actual", status: "completed", evictedAfterMin: 0, ...(historical ? { fromSavedSession: true } : {}) });
  for (let i = 0; i < 500; i++) manager.rememberEvicted(note(`actual-${i}`, false));
  manager.rememberEvicted(note("historical-overflow", true));
  expect(manager.getEvictedNote("historical-overflow")).toBeUndefined();
  expect(manager.getEvictedNote("actual-0")?.description).toBe("actual");
  manager.rememberEvicted(note("actual-0", true));
  expect(manager.getEvictedNote("actual-0")?.description).toBe("actual");
  manager.rememberEvicted(note("actual-new", false));
  expect(manager.getEvictedNote("actual-0")).toBeUndefined();
  expect(manager.getEvictedNote("actual-new")?.description).toBe("actual");
  const another = new AgentManager(() => {});
  another.rememberEvicted(note("duplicate", true));
  another.rememberEvicted(note("duplicate", false));
  expect(another.getEvictedNote("duplicate")?.description).toBe("actual");
  for (let i = 0; i < 500; i++) another.rememberEvicted(note(`history-${i}`, true));
  expect(another.getEvictedNote("duplicate")?.description).toBe("actual");
  expect(another.getEvictedNote("history-0")).toBeUndefined();
  expect(another.getEvictedNote("history-499")?.description).toBe("historical");
  another.rememberEvicted(note("history-499", true));
  another.rememberEvicted(note("new-actual", false));
  expect(another.getEvictedNote("history-1")).toBeUndefined();
  expect(another.getEvictedNote("history-499")?.description).toBe("historical");
});

it("keeps a live survivor ahead of saved terminal history for that id", { timeout: 30_000 }, async () => {
  fixture = new ScenarioSession();
  const hold = fixture.heldTool();
  const child = fixture.physical("kid", "child", [calls({ name: "hold", args: {} }), answer("LIVE CHILD DONE")]);
  const sessionManager = SessionManager.create(fixture.cwd, join(fixture.root, "parents"));
  const h = await fixture.start({ harness: { sessionManager } });
  h.setResponses([calls(spawn("live priority")), answer("SPAWNED")]);
  await h.session.prompt("spawn");
  await hold.entered;
  const id = outcomes(h, "Agent")[0]?.text.match(/Agent ID: (\S+)/)?.[1];
  if (!id) throw new Error("No actual Agent receipt");
  const record = fixture.record(id);
  // A previous attempt of a resumed id can have terminal history while the new run is live.
  sessionManager.appendCustomEntry("subagents:record", { id, type: record.type, description: record.description, status: "completed" });
  await h.session.reload();
  fixture.restoreProviders(h);
  h.setResponses([calls({ name: "get_subagent_result", args: { agent_id: id } }), answer("LOOKED UP")]);
  await h.session.prompt("lookup");
  expect(outcomes(h, "get_subagent_result")[0]?.text).toContain("Status: running");
  expect(outcomes(h, "get_subagent_result")[0]?.text).not.toContain("recovered from saved");
  expect(child.state.callCount).toBe(1);
  hold.release();
  await record.promise;
  expect(record.status).toBe("completed");
});
