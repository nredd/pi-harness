/**
 * #145: a child shares its parent's model runtime, and a virtual model routes
 * through a closure over the PARENT's extension runner. Invalidating that runner
 * (what core does on reload and session replacement) used to kill a running
 * background child with a stale-ctx error and "No output".
 */
import { join } from "node:path";
import { type AgentSession, type ExtensionFactory, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { retryStaleCtx, staleCtxOutcome } from "../src/agent-runner.js";
import { answer, barrier, calls, ScenarioSession, spawn } from "./helpers/scenario-session.js";

let fixture: ScenarioSession;
afterEach(async () => {
  await fixture?.dispose();
});

/** A real `router/*`-shaped virtual model: its route reads the host ctx, like subscription-router does. */
function routedModel(getModel: () => unknown): ExtensionFactory {
  return pi => {
    pi.registerVirtualModel({
      provider: "vroute",
      id: "default",
      name: "vroute default",
      route: async (_request, ctx) => {
        console.log('ROUTE', Date.now() % 100000);
        void ctx.cwd;
        console.log('ROUTE ok');
        return { model: getModel() as never };
      },
    });
  };
}

/** Spawn a background child that runs one held tool, so its next model step happens after we act. */
async function startHeldChild(responses: ReturnType<typeof answer>[], virtual = true) {
  fixture = new ScenarioSession();
  const hold = fixture.heldTool();
  const physical = fixture.physical("fauxphys", "physical", [calls({ name: "hold", args: {} }), ...responses]);
  // A persisted session: only then does a reload detach (not abort) running children.
  const sessionManager = SessionManager.create(fixture.cwd, join(fixture.root, "sessions"));
  const h = await fixture.start({ factories: [routedModel(() => physical.getModel())], harness: { sessionManager } });
  h.setResponses([calls(spawn("probe child", { model: virtual ? "vroute/default" : "fauxphys/physical" })), answer("SPAWNED")]);
  await h.session.prompt("go");
  await hold.entered;
  const id = h.session.messages.filter(m => m.role === "toolResult" && m.toolName === "Agent").flatMap(m => m.content).find(p => p.type === "text")?.text.match(/Agent ID: (\S+)/)?.[1];
  if (!id) throw new Error("Missing spawn id");
  return { h, hold, physical, record: fixture.record(id) };
}

it("retries the step once a real reload has re-registered the parent's routes", { timeout: 30_000 }, async () => {
  const { h, hold, record } = await startHeldChild([answer("CHILD DONE")]);
  // Hold core's reload between `oldRunner.invalidate()` and the rebuild, the
  // window in which the parent's routes are dead and the new ones not yet bound.
  const gate = barrier();
  const settings = h.session.settingsManager;
  const reloadSettings = settings.reload.bind(settings);
  settings.reload = async () => { await gate.promise; return reloadSettings(); };
  const reloading = h.session.reload();
  hold.release();
  await vi.waitFor(() => expect(record.session?.messages.at(-1)).toMatchObject({ stopReason: "error" }), { timeout: 10_000 });
  gate.resolve();
  await reloading;
  // Core's reload resets global transports; restore the faux provider before the retry fires.
  fixture.restoreProviders(h);
  await record.promise;
  expect(record.error).toBeUndefined();
  expect(record.status).toBe("completed");
  expect(record.result).toBe("CHILD DONE");
});

it("a detached child outlives a reload: usage observers closed over the old pi cannot fail its turn", { timeout: 30_000 }, async () => {
  // No virtual model, so routing cannot be the cause: the stale `pi` in the
  // manager's usage callback (`subagents:usage`) used to kill the child's next turn.
  const { h, hold, record } = await startHeldChild([answer("CHILD DONE")], false);
  await h.session.reload();
  fixture.restoreProviders(h);
  hold.release();
  await record.promise;
  expect(record.error).toBeUndefined();
  expect(record.status).toBe("completed");
  expect(record.result).toBe("CHILD DONE");
});

/** A session whose every step died on the stale-ctx error, with one tool call behind it. */
function deadSession(prompt: () => Promise<void>) {
  const stale = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession().";
  return {
    prompt,
    messages: [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "1", name: "bash", arguments: {} }] },
      { role: "toolResult", content: [{ type: "text", text: "pushed branch redd/x" }] },
      { role: "assistant", stopReason: "error", errorMessage: stale, content: [{ type: "text", text: "" }] },
    ],
  } as unknown as AgentSession;
}

it("retries a bounded number of times, then reports an interruption with the last tool output", async () => {
  const prompts = vi.fn(async () => {});
  const session = deadSession(prompts);
  await retryStaleCtx(session, 0, undefined, [0, 0, 0]);
  expect(prompts).toHaveBeenCalledTimes(3);
  const outcome = staleCtxOutcome(session, 0);
  expect(outcome?.failure).toMatch(/interrupted by a session reload/);
  expect(outcome?.partial).toContain("Last tool calls: bash");
  expect(outcome?.partial).toContain("pushed branch redd/x");
});

it("does not retry when the final step failed for another reason", async () => {
  const prompts = vi.fn(async () => {});
  const session = deadSession(prompts);
  (session.messages.at(-1) as { errorMessage: string }).errorMessage = "overloaded";
  await retryStaleCtx(session, 0, undefined, [0]);
  expect(prompts).not.toHaveBeenCalled();
  expect(staleCtxOutcome(session, 0)).toBeUndefined();
});
