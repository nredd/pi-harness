import assert from "node:assert/strict";
import { test } from "vitest";
import planMode from "../src/plan-mode.js";
import { createMockContext, createMockPi } from "./support.js";

for (const failure of ["lookup", "missing", "auth-result", "auth-throw", "apply-throw", "thinking"] as const) {
  test(`restored implementation contains ${failure} failure and consumes its one-shot intent`, async () => {
    const mock = createMockPi({ activeTools: ["read"], thinkingLevel: "low" });
    const model = { provider: "fixture", id: "target" };
    const entry = {
      type: "custom",
      customType: "plan-mode-state",
      data: {
        enabled: false,
        awaitingAction: false,
        pendingImplementationRuntime: {
          version: 1,
          model: { provider: model.provider, modelId: model.id },
          thinkingLevel: "high",
        },
      },
    };
    const branch = [entry];
    if (failure === "apply-throw")
      mock.rawPi.setModel = async () => {
        throw new Error("apply denied");
      };
    if (failure === "thinking")
      mock.rawPi.setThinkingLevel = () => {
        throw new Error("thinking denied");
      };
    const context = createMockContext({
      sessionManager: { getBranch: () => branch, getEntries: () => branch },
      modelRegistry: {
        find: () => {
          if (failure === "lookup") throw new Error("lookup denied");
          return failure === "missing" ? undefined : model;
        },
        getApiKeyAndHeaders: async () => {
          if (failure === "auth-throw") throw new Error("auth denied");
          return failure === "auth-result"
            ? { ok: false as const, error: "credentials expired" }
            : { ok: true as const };
        },
      },
    });
    planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
    await mock.events.get("session_start")?.[0]?.({ reason: "resume" }, context.ctx);
    const expected = {
      lookup: /could not be resolved: lookup denied/u,
      missing: /is no longer available/u,
      "auth-result": /could not be authenticated: credentials expired/u,
      "auth-throw": /could not be authenticated: auth denied/u,
      "apply-throw": /could not be applied: apply denied/u,
      thinking: /thinking high could not be applied: thinking denied/u,
    }[failure];
    assert.match(context.notifications.at(-1)?.message ?? "", expected);
    const persisted = mock.entries.at(-1);
    assert.ok(persisted);
    assert.equal(
      (persisted.data as { pendingImplementationRuntime?: unknown }).pendingImplementationRuntime,
      undefined,
    );
    assert.equal(mock.thinkingLevel, failure === "thinking" ? "low" : "high");
    assert.equal(mock.setModels.length, failure === "thinking" ? 1 : 0);
    const warnings = context.notifications.length;
    await mock.events.get("input")?.[0]?.({ text: "implement", source: "user" }, context.ctx);
    assert.equal(context.notifications.length, warnings, "consumed intent must not retry on input");
  });
}

test("a throwing tool registry falls back safely instead of admitting unknown tools", async () => {
  const mock = createMockPi({ activeTools: ["read"] });
  mock.rawPi.getAllTools = () => {
    throw new Error("registry unavailable");
  };
  planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
  const context = createMockContext();
  await mock.commands.get("plan")?.handler("start", context.ctx);
  const blocked = (await mock.events.get("tool_call")?.[0]?.({ toolName: "read", input: {} }, context.ctx)) as {
    block?: boolean;
  };
  assert.equal(blocked.block, true);
  const unknown = (await mock.events.get("tool_call")?.[0]?.(
    { toolName: "unregistered_mutation", input: {} },
    context.ctx,
  )) as { block?: boolean };
  assert.equal(unknown.block, true);
  assert.equal(context.statuses.get("plan-mode"), "plan active");
});
