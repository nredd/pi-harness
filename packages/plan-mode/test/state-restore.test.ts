import assert from "node:assert/strict";
import { test } from "vitest";
import { restorePlanModeState } from "../src/state.js";

const TYPE = "plan-mode-state";
const restore = (data: Record<string, unknown>) =>
  restorePlanModeState([{ type: "custom", customType: TYPE, data }], TYPE);

test("an interrupted workflow with decline history must reconfirm before re-proposing", () => {
  assert.equal(restore({ enabled: true, declinedPlans: 2 }).reproposalReview, "required");
  assert.equal(restore({ enabled: true, declinedPlans: 2, latestPlan: "# Ready" }).reproposalReview, undefined);
  assert.equal(restore({ enabled: true, declinedPlans: 0 }).reproposalReview, undefined);
});

test("a corrupt workflow tool policy restores as an automatic policy that allows nothing", () => {
  const denied = { kind: "automatic", allowedNames: [], resolved: true };
  for (const workflowToolPolicy of [
    "automatic",
    { kind: "manual", allowedNames: ["read"], resolved: true },
    { kind: "explicit", allowedNames: ["read"], resolved: true },
  ]) {
    assert.deepEqual(
      restore({ enabled: true, workflowToolPolicy }).workflowToolPolicy,
      denied,
      String(workflowToolPolicy),
    );
  }
  assert.deepEqual(
    restore({
      enabled: true,
      workflowToolPolicy: { kind: "explicit", desiredNames: ["read"], allowedNames: ["read"], resolved: false },
    }).workflowToolPolicy,
    { kind: "explicit", desiredNames: ["read"], allowedNames: ["read"], resolved: false },
  );
});

test("a pending implementation runtime with neither model nor thinking is dropped", () => {
  assert.equal(
    restore({ enabled: false, pendingImplementationRuntime: { version: 1 } }).pendingImplementationRuntime,
    undefined,
  );
  assert.deepEqual(
    restore({ enabled: false, pendingImplementationRuntime: { version: 1, thinkingLevel: "high" } })
      .pendingImplementationRuntime,
    { version: 1, thinkingLevel: "high" },
  );
});
