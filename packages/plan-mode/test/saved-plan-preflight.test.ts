import assert from "node:assert/strict";
import { test } from "vitest";
import { preflightSavedPlanImplementation, savedPlanBlocksNewWorkflow } from "../src/saved-plan-preflight.js";
import { createPlanContext } from "./support.js";

const MODEL = { provider: "test-provider", id: "test-model" };

test("saved plans block new workflows with an interactive explanation", () => {
  const context = createPlanContext({ hasUI: true });
  assert.equal(savedPlanBlocksNewWorkflow(context.ctx, false), false);
  assert.equal(savedPlanBlocksNewWorkflow(context.ctx, true), true);
  assert.match(context.notifications.at(-1)?.message ?? "", /saved for later/u);
});

test("saved plans fail closed without interactive UI", () => {
  const context = createPlanContext({ hasUI: false });
  assert.throws(() => savedPlanBlocksNewWorkflow(context.ctx, true), /Implement or clear/u);
});

test("saved plan implementation preflight handles mode, model, and authentication failures", async () => {
  for (const mode of ["print", "json"] as const) {
    const context = createPlanContext({ mode });
    await assert.rejects(
      preflightSavedPlanImplementation(context.ctx, () => true),
      /unavailable in print\/JSON/u,
    );
  }

  const noModel = createPlanContext({ model: undefined });
  assert.equal(await preflightSavedPlanImplementation(noModel.ctx, () => true), false);
  assert.match(noModel.notifications.at(-1)?.message ?? "", /no model/u);

  const rejected = createPlanContext({
    model: MODEL,
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false as const, error: "denied" }) },
  });
  assert.equal(await preflightSavedPlanImplementation(rejected.ctx, () => true), false);
  assert.match(rejected.notifications.at(-1)?.message ?? "", /denied/u);

  const accepted = createPlanContext({
    model: MODEL,
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const }) },
  });
  assert.equal(await preflightSavedPlanImplementation(accepted.ctx, () => true), true);
});

test("saved plan implementation ignores stale authentication results and reports current failures", async () => {
  const stale = createPlanContext({
    model: MODEL,
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false as const, error: "denied" }) },
  });
  assert.equal(await preflightSavedPlanImplementation(stale.ctx, () => false), false);
  assert.deepEqual(stale.notifications, []);

  const failure = createPlanContext({
    model: MODEL,
    modelRegistry: {
      getApiKeyAndHeaders: async () => {
        throw new Error("authentication service unavailable");
      },
    },
  });
  assert.equal(await preflightSavedPlanImplementation(failure.ctx, () => true), false);
  assert.match(failure.notifications.at(-1)?.message ?? "", /authentication service unavailable/u);

  const staleFailure = createPlanContext({
    model: MODEL,
    modelRegistry: {
      getApiKeyAndHeaders: async () => {
        throw new Error("ignored stale failure");
      },
    },
  });
  assert.equal(await preflightSavedPlanImplementation(staleFailure.ctx, () => false), false);
  assert.deepEqual(staleFailure.notifications, []);
});

test("saved plan implementation reports the detail of a non-Error authentication failure", async () => {
  const failure = createPlanContext({
    model: MODEL,
    modelRegistry: {
      getApiKeyAndHeaders: async () => {
        throw "authentication service offline";
      },
    },
  });
  assert.equal(await preflightSavedPlanImplementation(failure.ctx, () => true), false);
  assert.equal(failure.notifications.at(-1)?.message, "Unable to implement saved plan: authentication service offline");
});
