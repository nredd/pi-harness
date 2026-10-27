/**
 * #145: once stale-ctx recovery is exhausted the runtime is dead, so follow-up
 * prompts (structured-output retry, forced final report) must not be sent: each
 * would fail the same way and mask the real outcome.
 */
import { afterEach, expect, it } from "vitest";
import { runAgent } from "../src/agent-runner.js";
import { compileJsonSchema } from "../src/workflow/json-schema.js";
import { answer, ScenarioSession } from "./helpers/scenario-session.js";

const STALE = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.reload().";

let fixture: ScenarioSession;
afterEach(async () => fixture?.dispose());

/** A `vroute/default` model whose route always dies stale, counting every attempt. */
async function deadRoute() {
  fixture = new ScenarioSession();
  const physical = fixture.physical("fauxphys", "physical", [answer("never reached")]);
  let routes = 0;
  const h = await fixture.start({
    factories: [pi => {
      pi.registerVirtualModel({
        provider: "vroute",
        id: "default",
        name: "vroute default",
        route: async () => { routes++; void physical; throw new Error(STALE); },
      });
    }],
  });
  const model = h.session.modelRuntime.getModel("vroute", "default");
  if (!model || !fixture.pi) throw new Error("virtual model or pi missing");
  const ctx = h.session.extensionRunner.createContext();
  return { ctx, pi: fixture.pi, model, routes: () => routes };
}

/** Record every prompt text a run sends, via the session the runner reports. */
function recordPrompts() {
  const sent: string[] = [];
  const onSessionCreated = (session: { prompt: (text: string, ...rest: unknown[]) => Promise<void> }) => {
    const prompt = session.prompt.bind(session);
    session.prompt = (text, ...rest) => { sent.push(text); return prompt(text, ...rest); };
  };
  return { sent, onSessionCreated };
}

/** Task prompt first, then exactly the three continue prompts: nothing doomed after them. */
function expectOnlyRecovery(sent: string[]) {
  expect(sent).toHaveLength(4);
  for (const text of sent.slice(1)) expect(text).toMatch(/Continue the task/);
}

it("a structured child with a dead runtime reports the interruption, not a masked schema failure", { timeout: 30_000 }, async () => {
  const { ctx, pi, model } = await deadRoute();
  const compiled = compileJsonSchema({ type: "object", properties: { a: { type: "string" } }, required: ["a"] });
  if (!compiled.ok) throw new Error(compiled.message);
  const { sent, onSessionCreated } = recordPrompts();
  const result = await runAgent(ctx, "general-purpose", "work", { pi, model, structuredOutput: compiled.compiled, staleRetryDelaysMs: [0, 0, 0], onSessionCreated });
  expectOnlyRecovery(sent);
  expect(result.structuredRetried).toBeUndefined();
  expect(result.failure).toMatch(/interrupted by a session reload/);
});

it("a capped child with a dead runtime does not force a final report", { timeout: 30_000 }, async () => {
  const { ctx, pi, model } = await deadRoute();
  const { sent, onSessionCreated } = recordPrompts();
  const result = await runAgent(ctx, "general-purpose", "work", { pi, model, maxTurns: 1, staleRetryDelaysMs: [0, 0, 0], onSessionCreated });
  expectOnlyRecovery(sent);
  expect(result.failure).toMatch(/interrupted by a session reload/);
});
