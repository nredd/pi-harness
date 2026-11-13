/** Saved history must never shadow a live survivor of a same-process reload. */
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { answer, calls, outcomes, ScenarioSession, spawn } from "./helpers/scenario-session.js";

let fixture: ScenarioSession;
afterEach(async () => {
  await fixture?.dispose();
  Reflect.deleteProperty(globalThis, Symbol.for("pi-subagents:manager"));
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
