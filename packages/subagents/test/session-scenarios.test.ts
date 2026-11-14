/** Ports of integration/test_subagents.py and router run.sh/no-router on the real core host. */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AssistantMessageEventStream, type FauxResponseStep, getApiProvider, registerApiProvider } from "@earendil-works/pi-ai/compat";
import { nextEvent, outcomes, text, toolCalls } from "@nredd/pi-test-lib/faux";
import { afterEach, expect, it } from "vitest";
import { answer, notices, ScenarioSession, spawn } from "./helpers/scenario-session.js";

let fixture: ScenarioSession;
afterEach(async () => fixture?.dispose());

/** Read the actual spawn receipt, not a predicted UUID. */
function agentId(h: Awaited<ReturnType<ScenarioSession["start"]>>, index = 0): string {
  const id = outcomes(h, "Agent")[index]?.text.match(/Agent ID: (\S+)/)?.[1];
  if (!id) throw new Error(JSON.stringify(outcomes(h, "Agent")));
  return id;
}

it("background child result is fetched through the session", async () => {
  fixture = new ScenarioSession();
  const child = fixture.physical("kid", "child", [answer("CHILD RESULT 2a")]);
  const stream = fixture.holdStream(child);
  const hold = fixture.heldTool();
  const h = await fixture.start({ factories: [hold.factory] });
  h.setResponses([toolCalls(spawn("fetched")), toolCalls({ name: "hold", args: {} }), () => toolCalls({ name: "get_subagent_result", args: { agent_id: agentId(h) } }), answer("PARENT DONE")]);
  const turn = h.session.prompt("go");
  await hold.entered;
  await stream.entered;
  const completed = fixture.completion();
  stream.release();
  await completed;
  hold.release();
  await turn;
  expect(outcomes(h, "Agent")).toHaveLength(1);
  expect(outcomes(h, "Agent")[0]?.text).toContain("Agent started in background.");
  expect(outcomes(h, "get_subagent_result")).toHaveLength(1);
  expect(outcomes(h, "get_subagent_result")[0]?.text).toContain("Status: completed");
  expect(outcomes(h, "get_subagent_result")[0]?.text).toContain("CHILD RESULT 2a");
});

it("running child receives steer after held tool", async () => {
  fixture = new ScenarioSession();
  const hold = fixture.heldTool();
  fixture.physical("kid", "child", [toolCalls({ name: "hold", args: {} }), context => answer(`USERS ${context.messages.filter(m => m.role === "user").map(text).join(" | ")}`)]);
  const h = await fixture.start();
  h.setResponses([toolCalls(spawn("steered")), answer("SPAWNED")]);
  await h.session.prompt("spawn");
  await hold.entered;
  h.setResponses([toolCalls({ name: "steer_subagent", args: { agent_id: agentId(h), message: "PIVOT 3x" } }), answer("STEERED")]);
  await h.session.prompt("steer");
  expect(outcomes(h, "steer_subagent")[0]?.text).toContain("Steering message sent to agent");
  const completed = fixture.completion();
  hold.release();
  await completed;
  h.setResponses([toolCalls({ name: "get_subagent_result", args: { agent_id: agentId(h), wait: true } }), answer("PARENT DONE")]);
  await h.session.prompt("fetch");
  expect(outcomes(h, "get_subagent_result")[0]?.text).toContain("USERS work | PIVOT 3x");
});

it("queued child receives steer when slot opens", async () => {
  fixture = new ScenarioSession({ maxConcurrent: 1 });
  const first = fixture.physical("kida", "child", [answer("BLOCKER DONE")]);
  const stream = fixture.holdStream(first);
  fixture.physical("kidb", "child", [context => answer(`USERS ${context.messages.filter(m => m.role === "user").map(text).join(" | ")}`)]);
  const h = await fixture.start();
  h.setResponses([toolCalls(spawn("blocker", { model: "kida/child" }), spawn("queued", { model: "kidb/child" })), answer("SPAWNED")]);
  await h.session.prompt("spawn");
  await stream.entered;
  expect(outcomes(h, "Agent")[1]?.text.toLowerCase()).toContain("queued");
  const id = agentId(h, 1);
  h.setResponses([toolCalls({ name: "steer_subagent", args: { agent_id: id, message: "PIVOT 4q" } }), answer("STEERED")]);
  await h.session.prompt("steer");
  const [steered] = outcomes(h, "steer_subagent");
  expect(steered?.isError).toBe(false);
  expect(steered?.text).not.toContain("not running");
  // A waiting fetch crosses the real queued startGate; no queue polling is needed.
  const fetching = nextEvent(h, e => e.type === "tool_execution_start" && e.toolName === "get_subagent_result");
  h.setResponses([toolCalls({ name: "get_subagent_result", args: { agent_id: id, wait: true } }), answer("PARENT DONE")]);
  const turn = h.session.prompt("fetch");
  await fetching;
  stream.release();
  await turn;
  expect(outcomes(h, "get_subagent_result")[0]?.text).toContain("PIVOT 4q");
});

it("zero consumed TTL from env is wired through session sweep", async () => {
  const before = process.env.PI_SUBAGENTS_CONSUMED_TTL_MIN;
  process.env.PI_SUBAGENTS_CONSUMED_TTL_MIN = "0";
  try {
    fixture = new ScenarioSession();
    fixture.physical("kid", "child", [answer("CHILD RESULT 5")]);
    const h = await fixture.start();
    h.setResponses([toolCalls(spawn("evicted")), () => toolCalls({ name: "get_subagent_result", args: { agent_id: agentId(h), wait: true } }), answer("FETCHED")]);
    await h.session.prompt("go");
    const id = agentId(h);
    expect(outcomes(h, "get_subagent_result")[0]?.text).toContain("CHILD RESULT 5");
    fixture.clock.advance(999);
    expect(fixture.record(id).status).toBe("completed");
    fixture.clock.advance(1);
    h.setResponses([toolCalls({ name: "get_subagent_result", args: { agent_id: id } }, { name: "steer_subagent", args: { agent_id: id, message: "hello" } }), answer("PARENT DONE")]);
    await h.session.prompt("late");
    for (const name of ["get_subagent_result", "steer_subagent"]) {
      const late = outcomes(h, name).at(-1)?.text;
      expect(late).toContain("completed, evicted after");
      expect(late).toContain("transcript: ");
      expect(late).not.toContain("Agent not found");
    }
  } finally {
    if (before === undefined) delete process.env.PI_SUBAGENTS_CONSUMED_TTL_MIN; else process.env.PI_SUBAGENTS_CONSUMED_TTL_MIN = before;
  }
});

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

/** Spawn, read and evict one child, proving the record existed first (#330). */
async function evictedChild(rememberAgents: boolean, childSteps: FauxResponseStep[]) {
  fixture = new ScenarioSession({ rememberAgents, outputTranscript: false, agentModels: { "*": "kid/child" } });
  fixture.physical("kid", "child", childSteps);
  const h = await fixture.start();
  h.setResponses([toolCalls(spawn("evicted")), () => toolCalls({ name: "get_subagent_result", args: { agent_id: agentId(h), wait: true } }), answer("FETCHED")]);
  await h.session.prompt("go");
  const id = agentId(h);
  expect(outcomes(h, "get_subagent_result")[0]?.text).toContain("FIRST 330");
  const { status, sessionFile } = fixture.record(id);
  expect(status).toBe("completed");
  fixture.clock.advance(1_000);
  expect(() => fixture.record(id)).toThrow(`No record ${id}`);
  return { h, id, sessionFile };
}

/** One parent turn that resumes `id` through the real Agent tool; returns its result text. */
async function resumeOnce(h: Awaited<ReturnType<ScenarioSession["start"]>>, id: string) {
  h.setResponses([toolCalls({ name: "Agent", args: { subagent_type: "general-purpose", description: "again", prompt: "MORE 330", resume: id } }), answer("RESUMED")]);
  await h.session.prompt("resume");
  return outcomes(h, "Agent").at(-1)?.text ?? "";
}

it("resume reopens an evicted agent's conversation (#330)", () => withZeroConsumedTtl(async () => {
  const { h, id } = await evictedChild(true, [answer("FIRST 330"), context => answer(`USERS ${context.messages.filter(m => m.role === "user").map(text).join(" | ")}`)]);
  const completed = fixture.completion();
  const resumed = await resumeOnce(h, id);
  expect(resumed).toContain(`Agent resumed in background, reopening evicted agent ${id}.`);
  const next = resumed.match(/Agent ID: (\S+)/)?.[1];
  expect(next).toBeTruthy();
  await completed;
  h.setResponses([toolCalls({ name: "get_subagent_result", args: { agent_id: next, wait: true } }), answer("PARENT DONE")]);
  await h.session.prompt("fetch");
  // The child's second turn saw its first prompt, so this is the same conversation, not a fresh agent.
  expect(outcomes(h, "get_subagent_result").at(-1)?.text).toContain("USERS work | MORE 330");
}));

it("resume of an evicted in-memory agent says it was evicted (#330)", () => withZeroConsumedTtl(async () => {
  const { h, id, sessionFile } = await evictedChild(false, [answer("FIRST 330")]);
  expect(sessionFile).toBeUndefined();
  const resumed = await resumeOnce(h, id);
  expect(resumed).toContain(`Agent "${id}" (evicted) completed, evicted after 0 min`);
  expect(resumed).not.toContain("Agent not found");
}));

it("resume of an evicted agent whose session file is gone says so (#330)", () => withZeroConsumedTtl(async () => {
  const { h, id, sessionFile } = await evictedChild(true, [answer("FIRST 330")]);
  expect(sessionFile && existsSync(sessionFile)).toBe(true);
  rmSync(sessionFile as string);
  expect(await resumeOnce(h, id)).toBe(`Could not resume agent "${id}" — its session is gone.`);
}));

it("coalesced notice reaches next provider request after turn_end", async () => {
  fixture = new ScenarioSession();
  const a = fixture.physical("kida", "child", [answer("ALPHA RESULT 6")]);
  const b = fixture.physical("kidb", "child", [answer("BETA RESULT 6")]);
  const sa = fixture.holdStream(a);
  const sb = fixture.holdStream(b);
  const hold = fixture.heldTool();
  const h = await fixture.start({ factories: [hold.factory] });
  let echoed = "";
  h.setResponses([toolCalls(spawn("alpha", { model: "kida/child" }), spawn("beta", { model: "kidb/child" })), toolCalls({ name: "hold", args: {} }), context => {
    echoed = `ECHO ${text(context.messages.findLast(m => m.role !== "assistant"))}`;
    return answer(echoed);
  }]);
  const turn = h.session.prompt("go");
  await hold.entered;
  await Promise.all([sa.entered, sb.entered]);
  let completed = fixture.completion();
  sa.release();
  await completed;
  completed = fixture.completion();
  sb.release();
  await completed;
  fixture.clock.advance(60_000);
  expect(notices(h)).toEqual([]);
  hold.release();
  await turn;
  expect(notices(h)).toHaveLength(1);
  for (const part of ["2 background tasks finished.", "ALPHA RESULT 6", "BETA RESULT 6"]) {
    expect(notices(h)[0]).toContain(part);
    expect(echoed).toContain(part);
  }
  const toolEnd = h.events.findIndex(e => e.type === "tool_execution_end" && e.toolName === "hold");
  const turnEnd = h.events.findIndex((e, i) => i > toolEnd && e.type === "turn_end");
  const noticeAt = h.events.findIndex(e => e.type === "message_end" && e.message.role === "custom" && e.message.customType === "subagent-notification");
  expect(toolEnd).toBeGreaterThanOrEqual(0);
  expect(turnEnd).toBeGreaterThan(toolEnd);
  expect(noticeAt).toBeGreaterThan(turnEnd);
  expect(h.session.messages.filter(m => m.role === "assistant").map(text).at(-1)).toBe(echoed);
  expect(h.faux.getPendingResponseCount()).toBe(0);
});

it("waiting fetch suppresses completion notice", async () => {
  fixture = new ScenarioSession();
  const child = fixture.physical("kid", "child", [answer("CHILD RESULT 7")]);
  const stream = fixture.holdStream(child);
  const h = await fixture.start();
  h.setResponses([toolCalls(spawn("waited")), () => toolCalls({ name: "get_subagent_result", args: { agent_id: agentId(h), wait: true } }), answer("PARENT DONE")]);
  const fetching = nextEvent(h, e => e.type === "tool_execution_start" && e.toolName === "get_subagent_result");
  const turn = h.session.prompt("go");
  await fetching;
  await stream.entered;
  expect(outcomes(h, "get_subagent_result")).toEqual([]);
  stream.release();
  await turn;
  fixture.clock.advance(1000);
  expect(outcomes(h, "get_subagent_result")[0]?.text).toContain("CHILD RESULT 7");
  expect(notices(h)).toEqual([]);
  expect(h.session.messages.filter(m => m.role === "assistant").map(text).at(-1)).toBe("PARENT DONE");
  expect(h.eventsOfType("agent_start")).toHaveLength(1);
});

it("dispatch ranks only enabled fuzzy candidates", async () => {
  fixture = new ScenarioSession();
  const enabled = { fopus46: "claude-opus-4-6", fopus5: "claude-opus-5", fopus55: "claude-opus-5-5", fsonnet5: "claude-sonnet-5", fsonnet55: "claude-sonnet-5-5", fgpt6: "gpt-6-sol", fgpt61: "gpt-6.1-sol" };
  const disabled = { fopus6: "claude-opus-6", fsonnet6: "claude-sonnet-6", fgpt62: "gpt-6.2-sol" };
  for (const [provider, id] of Object.entries({ ...enabled, ...disabled })) fixture.physical(provider, id, [answer(`ANSWERED BY ${provider}/${id}`)]);
  const h = await fixture.start();
  writeFileSync(join(fixture.agentDir, "settings.json"), JSON.stringify({ enabledModels: [`${h.getModel().provider}/${h.getModel().id}`, ...Object.entries(enabled).map(([p, id]) => `${p}/${id}`)] }));
  h.setResponses([toolCalls(spawn("opus", { model: "opus", run_in_background: false })), toolCalls(spawn("sonnet", { model: "sonnet", run_in_background: false })), toolCalls(spawn("gpt", { model: "gpt-6", run_in_background: false })), answer("PARENT DONE")]);
  await h.session.prompt("go");
  expect(outcomes(h, "Agent")).toHaveLength(3);
  for (const [i, expected] of ["fopus55/claude-opus-5-5", "fsonnet55/claude-sonnet-5-5", "fgpt61/gpt-6.1-sol"].entries()) expect(outcomes(h, "Agent")[i]?.text).toContain(`ANSWERED BY ${expected}`);
  for (const p of fixture.providers.filter(p => Object.hasOwn(disabled, p.getModel().provider))) expect(p.state.callCount).toBe(0);
});

it("dispatch applies all five model precedence levels", async () => {
  fixture = new ScenarioSession({ agentModels: { pinned: "ptype/child", "*": "pstar/child" } });
  mkdirSync(join(fixture.agentDir, "agents"));
  for (const name of ["pinned", "pinned-star"]) writeFileSync(join(fixture.agentDir, "agents", `${name}.md`), `---\nname: ${name}\ndescription: Harness agent pinned to a model\nmodel: pfile/child\ntools: read\n---\nAnswer.\n`);
  for (const p of ["pparam", "ptype", "pstar", "pfile"]) fixture.physical(p, "child", [answer(`ANSWERED BY ${p}`)]);
  const h = await fixture.start();
  const mapped: FauxResponseStep[] = [toolCalls(spawn("param", { model: "pparam/child", subagent_type: "pinned", run_in_background: false })), toolCalls(spawn("type", { model: undefined, subagent_type: "pinned", run_in_background: false })), toolCalls(spawn("star", { model: undefined, subagent_type: "pinned-star", run_in_background: false })), answer("PARENT DONE")];
  h.setResponses(mapped);
  await h.session.prompt("mapped");
  expect(outcomes(h, "Agent")).toHaveLength(3);
  for (const [i, p] of ["pparam", "ptype", "pstar"].entries()) expect(outcomes(h, "Agent")[i]?.text).toContain(`ANSWERED BY ${p}`);
  // Rebinding reloads the global-only mapping from disk, as a fresh activation does.
  fixture.settings({});
  await h.session.reload();
  fixture.restoreProviders(h);
  h.setResponses([toolCalls(spawn("file", { model: undefined, subagent_type: "pinned", run_in_background: false })), toolCalls(spawn("parent", { model: undefined, run_in_background: false })), answer("ANSWERED BY faux"), answer("PARENT DONE")]);
  await h.session.prompt("unmapped");
  expect(outcomes(h, "Agent")).toHaveLength(5);
  expect(outcomes(h, "Agent")[3]?.text).toContain("ANSWERED BY pfile");
  expect(outcomes(h, "Agent")[4]?.text).toContain("ANSWERED BY faux");
});

it("child workflow stand-in refuses with reason", async () => {
  fixture = new ScenarioSession({ maxSubagentDepth: 2 });
  fixture.physical("kid", "child", [toolCalls({ name: "SubagentWorkflow", args: { script: "export const meta = { name: 'x', description: 'x' }" } }), context => answer(`REPORT ${context.messages.filter(m => m.role === "toolResult").map(text).join("\n")}`)]);
  const h = await fixture.start();
  h.setResponses([toolCalls(spawn("nester", { run_in_background: false })), answer("PARENT DONE")]);
  await h.session.prompt("go");
  expect(outcomes(h, "Agent")).toHaveLength(1);
  const report = outcomes(h, "Agent")[0]?.text;
  expect(report).toContain("REPORT");
  expect(report).toContain("Workflows are not available inside a subagent");
  expect(report).not.toContain("Tool SubagentWorkflow not found");
});

it.each(["throw", "reject"] as const)("held stream terminates a %s response with its error", async failure => {
  fixture = new ScenarioSession();
  const child = fixture.physical();
  const transport = getApiProvider(child.api);
  if (!transport) throw new Error("Missing child transport");
  registerApiProvider({
    ...transport,
    streamSimple: () => {
      if (failure === "throw") throw new Error("REJECTED CHILD RESPONSE");
      const inner = new class extends AssistantMessageEventStream {
        override async result(): Promise<ReturnType<typeof answer>> {
          throw new Error("REJECTED CHILD RESPONSE");
        }
      }();
      inner.end(answer(""));
      return inner;
    },
  }, fixture.root);
  const stream = fixture.holdStream(child);
  const h = await fixture.start();
  h.setResponses([toolCalls(spawn("rejected", { run_in_background: false })), answer("PARENT DONE")]);
  const turn = h.session.prompt("go");
  await stream.entered;
  stream.release();
  await turn;
  expect(outcomes(h, "Agent")).toHaveLength(1);
  expect(outcomes(h, "Agent")[0]?.text).toContain("Agent failed: REJECTED CHILD RESPONSE");
  expect(h.session.messages.filter(m => m.role === "assistant").map(text).at(-1)).toBe("PARENT DONE");
});

it("absent admission RPC admits physical child", async () => {
  fixture = new ScenarioSession();
  const child = fixture.physical("spike-b", "terra-b", [answer("ANSWERED on spike-b")]);
  const h = await fixture.start({ noRouter: true });
  h.setResponses([toolCalls(spawn("physical", { model: "spike-b/terra-b", run_in_background: false })), answer("DRIVER DONE")]);
  const turn = h.session.prompt("go");
  await fixture.admission.promise;
  fixture.clock.advance(99);
  expect(child.state.callCount).toBe(0);
  fixture.clock.advance(1);
  await turn;
  const transcript = h.session.messages.map(text).join("\n");
  expect(transcript).toContain("ANSWERED on spike-b");
  expect(transcript).toContain("DRIVER DONE");
  expect(transcript).not.toContain("was not started");
  expect(transcript).not.toContain("Queued");
  expect(child.state.callCount).toBe(1);
});

it("tells the parent when an unread agent is reaped, not only on a later lookup (#330)", async () => {
  const before = process.env.PI_SUBAGENTS_UNREAD_TTL_MIN;
  process.env.PI_SUBAGENTS_UNREAD_TTL_MIN = "1";
  try {
    // `0` keeps the notice to a preview, so the result stays unread.
    fixture = new ScenarioSession({ notificationResultChars: 0 });
    fixture.physical("kid", "child", [answer("CHILD RESULT 330")]);
    const h = await fixture.start();
    h.setResponses([toolCalls(spawn("forgotten")), answer("SPAWNED"), answer("NOTICE SEEN")]);
    const completed = fixture.completion();
    await h.session.prompt("go");
    const id = agentId(h);
    await completed;
    const noticeTurn = nextEvent(h, e => e.type === "agent_end");
    fixture.clock.advance(200); // the notice hold
    await noticeTurn;
    while (h.session.isStreaming) await new Promise(resolve => setTimeout(resolve, 1)); // agent_end fires before the turn closes
    expect(notices(h)).toHaveLength(1);
    expect(fixture.record(id).resultConsumed).toBeFalsy();
    fixture.clock.advance(60_000);
    expect(() => fixture.record(id)).toThrow(`No record ${id}`);

    h.setResponses([answer("NOTED")]);
    await h.session.prompt("next");
    const reaped = h.session.messages.filter(m => m.role === "custom" && m.customType === "subagent-reaped").map(text);
    expect(reaped).toHaveLength(1);
    expect(reaped[0]).toContain(id);
    expect(reaped[0]).toContain("never read");
    expect(reaped[0]).toContain("transcript: ");
  } finally {
    if (before === undefined) delete process.env.PI_SUBAGENTS_UNREAD_TTL_MIN; else process.env.PI_SUBAGENTS_UNREAD_TTL_MIN = before;
  }
});

it("does not promise a readable result when the reaped agent kept only blank text (#372)", async () => {
  const before = process.env.PI_SUBAGENTS_UNREAD_TTL_MIN;
  process.env.PI_SUBAGENTS_UNREAD_TTL_MIN = "1";
  try {
    fixture = new ScenarioSession({ notificationResultChars: 0 });
    fixture.physical("kid", "child", [answer("   ")]);
    const h = await fixture.start();
    h.setResponses([toolCalls(spawn("blank")), answer("SPAWNED"), answer("NOTICE SEEN")]);
    const completed = fixture.completion();
    await h.session.prompt("go");
    const id = agentId(h);
    await completed;
    const noticeTurn = nextEvent(h, e => e.type === "agent_end");
    fixture.clock.advance(200);
    await noticeTurn;
    while (h.session.isStreaming) await new Promise(resolve => setTimeout(resolve, 1));
    fixture.clock.advance(60_000);
    expect(() => fixture.record(id)).toThrow(`No record ${id}`);
    h.setResponses([answer("NOTED")]);
    await h.session.prompt("next");
    const reaped = h.session.messages.filter(m => m.role === "custom" && m.customType === "subagent-reaped").map(text);
    expect(reaped).toHaveLength(1);
    expect(reaped[0]).toContain("left no result text");
    expect(reaped[0]).not.toContain("still returns its result");
  } finally {
    if (before === undefined) delete process.env.PI_SUBAGENTS_UNREAD_TTL_MIN; else process.env.PI_SUBAGENTS_UNREAD_TTL_MIN = before;
  }
});

it("does not call a failure the parent was already told about never read (#330)", async () => {
  const before = process.env.PI_SUBAGENTS_UNREAD_TTL_MIN;
  process.env.PI_SUBAGENTS_UNREAD_TTL_MIN = "1";
  try {
    fixture = new ScenarioSession();
    const child = fixture.physical("kid", "child", [answer("unused")]);
    const transport = getApiProvider(child.api);
    if (!transport) throw new Error("Missing child transport");
    registerApiProvider({ ...transport, streamSimple: () => { throw new Error("BROKEN CHILD 330"); } }, fixture.root);
    const h = await fixture.start();
    h.setResponses([toolCalls(spawn("failing")), answer("SPAWNED"), answer("NOTICE SEEN")]);
    const completed = new Promise<void>(resolve => {
      const off = fixture.pi!.events.on("subagents:failed", () => { off(); resolve(); });
    });
    await h.session.prompt("go");
    const id = agentId(h);
    await completed;
    const noticeTurn = nextEvent(h, e => e.type === "agent_end");
    fixture.clock.advance(200); // the notice hold
    await noticeTurn;
    while (h.session.isStreaming) await new Promise(resolve => setTimeout(resolve, 1));
    expect(notices(h).join("\n")).toContain("BROKEN CHILD 330");
    expect(fixture.record(id).resultConsumed).toBeFalsy();
    fixture.clock.advance(60_000);
    expect(() => fixture.record(id)).toThrow(`No record ${id}`);

    h.setResponses([answer("NOTED")]);
    await h.session.prompt("next");
    expect(h.session.messages.filter(m => m.role === "custom" && m.customType === "subagent-reaped")).toHaveLength(0);
  } finally {
    if (before === undefined) delete process.env.PI_SUBAGENTS_UNREAD_TTL_MIN; else process.env.PI_SUBAGENTS_UNREAD_TTL_MIN = before;
  }
});
