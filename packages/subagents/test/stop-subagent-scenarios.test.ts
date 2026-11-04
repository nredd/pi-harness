/**
 * `stop_subagent` on the real core host (#443, #454).
 *
 * #454's repro: the parent could only `steer_subagent` "STOP NOW", which the
 * child reads after its current tool call and is free to ignore, so it ran more
 * tool calls. Here the child is parked inside a held tool, the parent acts, the
 * tool is released, and the child's next model turn would `write` a file. A
 * steer lets that write happen; a stop must not.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { NOTIFICATION_HOLD_MS } from "../src/completion-outbox.js";
import { answer, barrier, calls, nextEvent, notices, outcomes, ScenarioSession, spawn, text } from "./helpers/scenario-session.js";

let fixture: ScenarioSession;
afterEach(async () => fixture?.dispose());

type Harness = Awaited<ReturnType<ScenarioSession["start"]>>;

/** Read the actual spawn receipt, not a predicted UUID. */
function agentId(h: Harness): string {
  const id = outcomes(h, "Agent")[0]?.text.match(/Agent ID: (\S+)/)?.[1];
  if (!id) throw new Error(JSON.stringify(outcomes(h, "Agent")));
  return id;
}

/** A child parked in `hold`, whose next turn writes `marker` and whose last answers. */
async function heldChild(marker: string) {
  fixture = new ScenarioSession({ agentModels: { "*": "kid/child" } });
  const hold = fixture.heldTool();
  fixture.physical("kid", "child", [
    calls({ name: "hold", args: {} }),
    calls({ name: "write", args: { path: marker, content: "the child kept going" } }),
    answer("CHILD DONE 454"),
  ]);
  const h = await fixture.start();
  h.setResponses([calls(spawn("runaway")), answer("SPAWNED")]);
  await h.session.prompt("spawn");
  await hold.entered;
  return { h, hold, id: agentId(h) };
}

/** One parent turn calling `tool`; returns its settled result. */
async function callOnce(h: Harness, name: string, args: Record<string, unknown>) {
  h.setResponses([calls({ name, args }), answer("DONE")]);
  await h.session.prompt(name);
  const outcome = outcomes(h, name).at(-1);
  if (!outcome) throw new Error(`${name} never settled`);
  return outcome;
}

it("a steer of STOP NOW still lets the child run its next tool call (the #454 repro)", async () => {
  const { h, hold, id } = await heldChild("after-steer.txt");
  const steered = await callOnce(h, "steer_subagent", { agent_id: id, message: "STOP NOW" });
  expect(steered.text).toContain("Steering message sent");
  hold.release();
  await fixture.record(id).promise;
  expect(existsSync(join(fixture.cwd, "after-steer.txt"))).toBe(true);
  expect(fixture.record(id).status).toBe("completed");
});

it("stop_subagent stops the child before its next tool call, and one notice says the parent stopped it", async () => {
  const { h, hold, id } = await heldChild("after-stop.txt");
  const stopped = await callOnce(h, "stop_subagent", { agent_id: id });
  expect(stopped.isError).toBe(false);
  expect(stopped.text).toContain(`Agent ${id} stopped.`);
  expect(stopped.text).toContain("Status: stopped");
  expect(fixture.record(id).status).toBe("stopped");

  // The notice wakes the parent; listen before the run settles.
  let notice = "";
  const isNotice = (e: AgentSessionEvent) => e.type === "message_end" && e.message.role === "custom" && e.message.customType === "subagent-notification";
  const settled = nextEvent(h, e => {
    if (isNotice(e) && e.type === "message_end") notice = text(e.message);
    return notice !== "" && e.type === "agent_settled";
  });
  hold.release();
  await fixture.record(id).promise;
  // The held tool returned into an aborted run: no further model turn, so no write.
  expect(existsSync(join(fixture.cwd, "after-stop.txt"))).toBe(false);
  expect(fixture.record(id).toolUses).toBe(1);
  expect(fixture.record(id).status).toBe("stopped");

  fixture.clock.advance(NOTIFICATION_HOLD_MS);
  await settled;
  expect(notices(h)).toHaveLength(1);
  expect(notice).toContain("stopped by the parent");
  expect(notice).not.toContain("STOPPED BY THE USER");
  // Not a failure: a delivered stop counts as read, unlike error/aborted (#447).
  expect(fixture.record(id).resultConsumed).toBe(true);
});

it("stop_subagent cancels a SubagentWorkflow run by its Task ID, with its agents", async () => {
  fixture = new ScenarioSession({ agentModels: { "*": "kid/child" }, workflowsEnabled: true });
  const child = fixture.physical("kid", "child", [answer("NEVER 454")]);
  const stream = fixture.holdStream(child);
  const h = await fixture.start();
  h.setResponses([
    calls({ name: "SubagentWorkflow", args: { script: 'export const meta = { name: "wf454", description: "x" }; return await agent("work", { agentType: "general-purpose" });' } }),
    answer("STARTED"),
  ]);
  await h.session.prompt("workflow");
  const runId = outcomes(h, "SubagentWorkflow")[0]?.text.match(/Task ID: (\S+)/)?.[1];
  if (!runId) throw new Error(JSON.stringify(outcomes(h, "SubagentWorkflow")));
  await stream.entered;
  // A miss lists the live run by its id and name.
  const missed = await callOnce(h, "stop_subagent", { agent_id: "nope" });
  expect(missed.text).toBe(`No agent or workflow "nope", so there is nothing to stop.\nRunning or queued:\n- ${runId} workflow "wf454" (running)`);

  let notice = "";
  const settled = nextEvent(h, e => {
    if (e.type === "message_end" && e.message.role === "custom" && e.message.customType === "subagent-notification") notice = text(e.message);
    return notice !== "" && e.type === "agent_settled";
  });
  // The run settles in its worker thread; its notice is armed on the injected clock.
  const armed = barrier();
  const setTimeout = fixture.clock.setTimeout.bind(fixture.clock);
  fixture.clock.setTimeout = (callback, ms) => {
    if (ms === NOTIFICATION_HOLD_MS) armed.resolve();
    return setTimeout(callback, ms);
  };
  const registry = Reflect.get(globalThis, Symbol.for("pi-subagents:manager")) as { hasRunning(): boolean };
  expect(registry.hasRunning()).toBe(true);
  const stopped = await callOnce(h, "stop_subagent", { agent_id: runId });
  expect(stopped.text).toBe(`Workflow "wf454" (${runId}) stopped, with its agents. A completion notice follows.`);
  // Checked while the child's stream is still held, so a settle cannot hide a survivor:
  // every record, the workflow's child included, is already stopped.
  expect(registry.hasRunning()).toBe(false);
  // Aborted but not yet settled: a second stop says so instead of "not running (status: running)".
  const again = await callOnce(h, "stop_subagent", { agent_id: runId });
  expect(again.isError).toBe(false);
  expect(again.text).toBe(`Workflow "wf454" (${runId}) is already stopping. A completion notice follows.`);
  stream.release();
  await armed.promise;
  fixture.clock.advance(NOTIFICATION_HOLD_MS);
  await settled;
  expect(notice).toContain("<status>Stopped by the parent with stop_subagent</status>");
  expect(notice).not.toContain("NEVER 454");

  // Settled: a later stop finds nothing left to stop, and says what it was.
  const late = await callOnce(h, "stop_subagent", { agent_id: runId });
  expect(late.isError).toBe(true);
  expect(late.text).toBe(`"${runId}" is not running (status: killed), so there is nothing to stop.\nNothing is running or queued.`);
});
