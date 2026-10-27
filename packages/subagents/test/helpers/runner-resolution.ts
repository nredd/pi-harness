/**
 * runner-resolution.ts -- a `runAgent` stand-in that performs the REAL model
 * selection the runner does before it builds a session (`selectModel`), and
 * reports through the same `onModelFallback` hook,
 * then settles like a finished run. Entry-path tests use it so a spawn that names
 * no model reaches the real resolver, without spinning up a pi session.
 * This stand-in is NOT evidence that production `runAgent` selects correctly:
 * `config-model-fallback-real-runner.test.ts` covers that with the real runner.
 */
import { vi } from "vitest";
import { getAgentConfig } from "../../src/agent-types.js";
import { selectModel } from "../../src/model-selection.js";

export function runnerResolution(opts: { hold?: boolean } = {}) {
  return async (ctx: any, type: string, _prompt: string, options: any) => {
    const outcome = options.modelSelection ?? selectModel({
      agentType: type, definitionModel: getAgentConfig(type)?.model, paramModel: options.model,
      parentModel: ctx.model, registry: ctx.modelRegistry, cwd: ctx.cwd,
    });
    if (typeof outcome === "string") throw new Error(outcome);
    if (outcome.fallback) options.onModelFallback?.(outcome.fallback);
    const session = { dispose: vi.fn(), messages: [], model: outcome.model } as any;
    options.onSessionCreated?.(session);
    if (opts.hold) return new Promise(() => {}) as never;
    return { responseText: "done", session, aborted: false, steered: false };
  };
}
