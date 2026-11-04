/** `steer_subagent` on a finished agent resumes it, like Claude Code's `SendMessage` (#442), on the real core host. */
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { NOTIFICATION_HOLD_MS } from "../src/completion-outbox.js";
import { answer, calls, nextEvent, notices, outcomes, ScenarioSession, spawn, text } from "./helpers/scenario-session.js";

let fixture: ScenarioSession;
afterEach(async () => fixture?.dispose());

type Harness = Awaited<ReturnType<ScenarioSession["start"]>>;

/** The child's reply to a resumed prompt: every user message its conversation holds. */
const echoUsers = (tag: string) => (context: { messages: { role: string }[] }) =>
  answer(`${tag} ${context.messages.filter(m => m.role === "user").map(text).join(" | ")}`);

/** Read the actual spawn receipt, not a predicted UUID. */
function agentId(h: Harness): string {
  const id = outcomes(h, "Agent")[0]?.text.match(/Agent ID: (\S+)/)?.[1];
  if (!id) throw new Error(JSON.stringify(outcomes(h, "Agent")));
  return id;
}

/** One parent turn calling the real steer_subagent tool; returns its settled result. */
async function steerOnce(h: Harness, agent_id: string, message: string, ...after: ReturnType<typeof answer>[]) {
  h.setResponses([calls({ name: "steer_subagent", args: { agent_id, message } }), answer("STEERED"), ...after]);
  await h.session.prompt("steer");
  const outcome = outcomes(h, "steer_subagent").at(-1);
  if (!outcome) throw new Error("steer_subagent never settled");
  return outcome;
}

/**
 * The completion notice of the run a steer started, as delivered to the parent
 * transcript: listen before the steer, then let the run settle and the outbox's
 * hold window pass on the injected clock.
 */
function nextNotice(h: Harness) {
  const completed = fixture.completion();
  let notice = "";
  const isNotice = (e: AgentSessionEvent) => e.type === "message_end" && e.message.role === "custom" && e.message.customType === "subagent-notification";
  // The notice wakes the parent; its turn must settle before the next prompt.
  const settled = nextEvent(h, e => {
    if (isNotice(e) && e.type === "message_end") notice = text(e.message);
    return notice !== "" && e.type === "agent_settled";
  });
  return async () => {
    await completed;
    fixture.clock.advance(NOTIFICATION_HOLD_MS);
    await settled;
    return notice;
  };
}

/** Spawn a child and read its first answer, so the record is proven completed before the steer. */
async function completedChild(settings: Record<string, unknown>, childSteps: Parameters<ScenarioSession["physical"]>[2]) {
  fixture = new ScenarioSession({ agentModels: { "*": "kid/child" }, ...settings });
  fixture.physical("kid", "child", childSteps);
  const h = await fixture.start();
  h.setResponses([calls(spawn("finished")), () => calls({ name: "get_subagent_result", args: { agent_id: agentId(h), wait: true } }), answer("FETCHED")]);
  await h.session.prompt("go");
  const id = agentId(h);
  expect(outcomes(h, "get_subagent_result")[0]?.text).toContain("FIRST 442");
  expect(fixture.record(id).status).toBe("completed");
  return { h, id };
}

/** Run with a zero consumed TTL, read when the manager starts, so one clock tick evicts a read record. */
async function withZeroConsumedTtl(body: () => Promise<void>) {
  const before = process.env.PI_SUBAGENTS_CONSUMED_TTL_MIN;
  process.env.PI_SUBAGENTS_CONSUMED_TTL_MIN = "0";
  try {
    await body();
  } finally {
    if (before === undefined) delete process.env.PI_SUBAGENTS_CONSUMED_TTL_MIN; else process.env.PI_SUBAGENTS_CONSUMED_TTL_MIN = before;
  }
}

/** Evict the read record, proving it existed first. */
function evict(id: string) {
  const { sessionFile } = fixture.record(id);
  fixture.clock.advance(1_000);
  expect(() => fixture.record(id)).toThrow(`No record ${id}`);
  return sessionFile;
}

it("resumes a completed agent with its history, and its completion notice arrives", async () => {
  const { h, id } = await completedChild({}, [answer("FIRST 442"), echoUsers("AGAIN")]);
  const noticed = nextNotice(h);
  const steered = await steerOnce(h, id, "MORE 442", answer("NOTED"));
  expect(steered.isError).toBe(false);
  expect(steered.text).toContain("Agent resumed in background.");
  expect(steered.text).toContain(`Agent ID: ${id}`);
  expect(steered.text).toContain("You will be notified when this agent completes.");
  // The second turn saw the first prompt: the same conversation continued, not a fresh agent.
  expect(await noticed()).toContain("AGAIN work | MORE 442");
  expect(notices(h)).toHaveLength(1);
  expect(fixture.record(id).status).toBe("completed");
});

it("refuses an agent the user stopped, naming why", async () => {
  fixture = new ScenarioSession({ agentModels: { "*": "kid/child" } });
  const child = fixture.physical("kid", "child", [answer("NEVER 442")]);
  const stream = fixture.holdStream(child);
  const h = await fixture.start();
  h.setResponses([calls(spawn("doomed")), answer("SPAWNED")]);
  await h.session.prompt("go");
  await stream.entered;
  const id = agentId(h);
  const pi = fixture.pi;
  if (!pi) throw new Error("Host not started");
  const stopped = new Promise<unknown>(resolve => { const off = pi.events.on("subagents:rpc:stop:reply:stop-442", reply => { off(); resolve(reply); }); });
  pi.events.emit("subagents:rpc:stop", { requestId: "stop-442", agentId: id });
  expect(await stopped).toMatchObject({ success: true });
  expect(fixture.record(id).status).toBe("stopped");

  const steered = await steerOnce(h, id, "carry on");
  expect(steered.text).toBe(`Agent "${id}" was stopped (status: stopped). steer_subagent does not resume a stopped agent.`);
  expect(fixture.record(id).status).toBe("stopped");
});

it("reopens an evicted agent's persisted conversation under a new id the old id resolves to", () => withZeroConsumedTtl(async () => {
  const { h, id } = await completedChild({ rememberAgents: true, outputTranscript: false }, [answer("FIRST 442"), echoUsers("REOPENED"), echoUsers("THIRD")]);
  expect(evict(id)).toBeTruthy();

  let noticed = nextNotice(h);
  const first = await steerOnce(h, id, "MORE 442", answer("NOTED"));
  expect(first.text).toContain(`Agent resumed in background, reopening evicted agent ${id}.`);
  const next = first.text.match(/Agent ID: (\S+)/)?.[1];
  expect(next).toBeTruthy();
  expect(next).not.toBe(id);
  expect(await noticed()).toContain("REOPENED work | MORE 442");

  // The old id now addresses the reopened record, which resumes in place.
  noticed = nextNotice(h);
  const second = await steerOnce(h, id, "LAST 442", answer("NOTED"));
  expect(second.text).toContain(`Agent ${id} continues as ${next}; use that id from now on.`);
  expect(second.text).toContain(`Agent ID: ${next}`);
  expect(await noticed()).toContain("THIRD work | MORE 442 | LAST 442");
}));

it("says an evicted in-memory agent cannot be resumed, naming its transcript", () => withZeroConsumedTtl(async () => {
  const { h, id } = await completedChild({ rememberAgents: false, outputTranscript: true }, [answer("FIRST 442")]);
  const transcript = fixture.record(id).outputFile;
  expect(transcript).toBeTruthy();
  expect(evict(id)).toBeUndefined();

  const steered = await steerOnce(h, id, "MORE 442");
  expect(steered.text).toContain(`Cannot resume agent "${id}": no saved session is left to reopen.`);
  expect(steered.text).toContain(`transcript: ${transcript}`);
}));
