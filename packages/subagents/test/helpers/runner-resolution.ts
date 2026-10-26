/**
 * runner-resolution.ts -- a `runAgent` stand-in that performs the REAL model
 * resolution the runner does before it builds a session (`resolveDefaultModelOutcome`
 * over the agent's config) and reports through the same `onModelFallback` hook,
 * then settles like a finished run. Entry-path tests use it so a spawn that names
 * no model reaches the real resolver, without spinning up a pi session.
 * `agent-runner-e2e.test.ts` pins the hook on the real `runAgent`.
 */
import { vi } from "vitest";
import { resolveDefaultModelOutcome } from "../../src/agent-runner.js";
import { getAgentConfig } from "../../src/agent-types.js";

export function runnerResolution(opts: { hold?: boolean } = {}) {
  return async (ctx: any, type: string, _prompt: string, options: any) => {
    if (options.model === undefined) {
      const outcome = resolveDefaultModelOutcome(ctx.model, ctx.modelRegistry, getAgentConfig(type)?.model);
      if (outcome.fallback) options.onModelFallback?.(outcome.fallback);
    }
    const session = { dispose: vi.fn(), messages: [], model: options.model ?? ctx.model } as any;
    options.onSessionCreated?.(session);
    if (opts.hold) return new Promise(() => {}) as never;
    return { responseText: "done", session, aborted: false, steered: false };
  };
}
