/**
 * runner-resolution.ts -- a `runAgent` stand-in that performs the REAL model
 * resolution the runner does before it builds a session (`selectConfiguredModel`
 * over `agentModels` and the agent's config) and reports through the same `onModelFallback` hook,
 * then settles like a finished run. Entry-path tests use it so a spawn that names
 * no model reaches the real resolver, without spinning up a pi session.
 * This stand-in is NOT evidence that production `runAgent` selects correctly:
 * `config-model-fallback-real-runner.test.ts` covers that with the real runner.
 */
import { vi } from "vitest";
import { getAgentConfig } from "../../src/agent-types.js";
import { selectConfiguredModel } from "../../src/model-resolver.js";

export function runnerResolution(opts: { hold?: boolean } = {}) {
  return async (ctx: any, type: string, _prompt: string, options: any) => {
    let selected = options.model ?? ctx.model;
    if (options.model === undefined) {
      const selection = selectConfiguredModel(type, getAgentConfig(type)?.model, ctx.model, ctx.modelRegistry);
      selected = selection.model;
      if (selection.fallback) options.onModelFallback?.(selection.fallback);
    }
    const session = { dispose: vi.fn(), messages: [], model: selected } as any;
    options.onSessionCreated?.(session);
    if (opts.hold) return new Promise(() => {}) as never;
    return { responseText: "done", session, aborted: false, steered: false };
  };
}
