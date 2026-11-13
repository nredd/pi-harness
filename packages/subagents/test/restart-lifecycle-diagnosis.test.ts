/** Synthetic #330 diagnosis: distinguish activation reload, terminal stop and process-state loss. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-coding-agent/testing";
import { afterEach, expect, it } from "vitest";
import { answer, calls, outcomes, ScenarioSession, spawn } from "./helpers/scenario-session.js";

let fixture: ScenarioSession;
afterEach(async () => {
  await fixture?.dispose();
  Reflect.deleteProperty(globalThis, Symbol.for("pi-subagents:manager"));
});

it("#330: a fresh stopped child retains its output across a fresh parent activation", { timeout: 30_000 }, async () => {
  fixture = new ScenarioSession({ rememberAgents: true });
  const hold = fixture.heldTool();
  const child = fixture.physical("kid", "child", [
    fauxAssistantMessage([{ type: "text", text: "SYNTHETIC PROGRESS 330" }, fauxToolCall("hold", {})], { stopReason: "toolUse" }),
    answer("SHOULD NOT EXECUTE"),
  ]);
  const manager = SessionManager.create(fixture.cwd, join(fixture.root, "parents"));
  const h = await fixture.start({ harness: { sessionManager: manager } });
  h.setResponses([calls(spawn("restart probe")), answer("SPAWNED")]);
  await h.session.prompt("spawn");
  await hold.entered;
  const id = outcomes(h, "Agent")[0]?.text.match(/Agent ID: (\S+)/)?.[1];
  if (!id) throw new Error("No actual Agent receipt");
  const record = fixture.record(id);
  const output = record.outputFile;
  if (!output) throw new Error("No actual output path");
  expect(record.status).toBe("running");
  expect(existsSync(output)).toBe(true);

  // The real stop tool aborts the run, then the outstanding tool is allowed to settle.
  h.setResponses([calls({ name: "stop_subagent", args: { agent_id: id } }), answer("STOP REQUESTED")]);
  await h.session.prompt("stop");
  hold.release();
  await record.promise;
  expect(record.status).toBe("stopped");
  expect(record.result).toContain("SYNTHETIC PROGRESS 330");
  const persisted = readFileSync(output, "utf8");
  expect(persisted).toContain("SYNTHETIC PROGRESS 330");
  expect(persisted).not.toContain("SHOULD NOT EXECUTE");
  expect(child.state.callCount).toBe(1);

  // Malformed custom history must not turn session startup into a failure.
  manager.appendCustomEntry("subagents:record", null);
  const parentFile = manager.getSessionFile();
  if (!parentFile) throw new Error("Parent was not persisted");
  expect(manager.getBranch().some(entry => entry.type === "custom" && entry.customType === "subagents:record")).toBe(true);
  await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  h.cleanup();
  expect(Reflect.has(globalThis, Symbol.for("pi-subagents:manager"))).toBe(false);
  expect(readFileSync(output, "utf8")).toBe(persisted);

  // Fresh extension + manager, same saved parent: no old registry or detached survivor is retained.
  const reopened = await fixture.start({ harness: { sessionManager: SessionManager.open(parentFile) } });
  reopened.setResponses([calls({ name: "get_subagent_result", args: { agent_id: id } }), answer("LOOKED UP")]);
  await reopened.session.prompt("lookup");
  const recovered = outcomes(reopened, "get_subagent_result")[0]?.text ?? "";
  expect(recovered).not.toContain("Agent not found");
  expect(recovered).toContain("last recorded status: stopped, recovered from saved parent session");
  expect(recovered).toContain(`transcript: ${output}`);
  expect(readFileSync(output, "utf8")).toBe(persisted);
  expect(child.state.callCount).toBe(1);
  reopened.setResponses([
    calls({ name: "stop_subagent", args: { agent_id: id } }),
    calls({ name: "Agent", args: { resume: id, subagent_type: "general-purpose", description: "manual recovery", prompt: "continue", run_in_background: true } }),
    calls({ name: "steer_subagent", args: { agent_id: id, message: "continue manually" } }),
    answer("CHECKED HISTORICAL CONTROLS"),
  ]);
  await reopened.session.prompt("historical controls");
  const stop = outcomes(reopened, "stop_subagent")[0];
  expect(stop?.isError).toBe(true);
  expect(stop?.text).toContain("last recorded status: stopped");
  expect(stop?.text).toContain("this historical entry cannot stop work");
  expect(stop?.text).not.toContain("is not running (status:");
  const resume = outcomes(reopened, "Agent")[0]?.text;
  expect(resume).toContain("only historical metadata is available");
  expect(resume).not.toContain("no saved session is left");
  const steer = outcomes(reopened, "steer_subagent")[0]?.text;
  expect(steer).toContain("only historical metadata is available");
  expect(steer).toContain("last recorded status: stopped");
  expect(steer).not.toContain("does not resume a stopped agent");
  expect(child.state.callCount).toBe(1);
});
