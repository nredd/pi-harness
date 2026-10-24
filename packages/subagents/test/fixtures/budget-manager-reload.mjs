/** Static entry beside compiled copies of the actual source tree, not manager stand-ins. */
import assert from "node:assert/strict";
import { AgentManager as FreshManager } from "./fresh/agent-manager.js";
import { runs as freshRuns } from "./fresh/agent-runner.js";
import { budgetUsage as freshUsage } from "./fresh/process-budget.js";
import { AgentManager as OldManager } from "./old/agent-manager.js";
import { runs } from "./old/agent-runner.js";
import { budgetUsage, setBudgetPolicy } from "./old/process-budget.js";

assert.notEqual(OldManager, FreshManager);
assert.notEqual(budgetUsage, freshUsage);
setBudgetPolicy({ maxActive: 12, nestedReserve: 2, maxDepth: 2 });
const old = new OldManager(undefined, 20);
const fresh = new FreshManager(undefined, 20);
const spawn = (manager, depth = 1) => manager.spawn({}, { cwd: process.cwd() }, "general-purpose", "work", {
  description: "reload probe", isBackground: true, depth, maxSubagentDepth: 2,
});
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
};
try {
  const roots = Array.from({ length: 10 }, () => spawn(old));
  spawn(fresh, 2);
  spawn(fresh, 2);
  const waiting = spawn(fresh);
  await flush();
  assert.equal(fresh.getRecord(waiting).status, "queued");
  assert.deepEqual(budgetUsage(), { active: 12, pending: 1, maxActive: 12 });
  assert.deepEqual(freshUsage(), budgetUsage());

  // ONLY the old manager settles here. Its real release/drain path must wake
  // the fresh manager's waiter without the test manually pumping the budget.
  runs.get(roots[0])();
  await flush();
  assert.equal(old.getRecord(roots[0]).status, "completed");
  assert.equal(fresh.getRecord(waiting).status, "running");
  assert.deepEqual(freshUsage(), { active: 12, pending: 0, maxActive: 12 });
} finally {
  for (const finish of [...runs.values(), ...freshRuns.values()]) finish();
  await flush();
  await old.dispose();
  await fresh.dispose();
}
assert.deepEqual(budgetUsage(), { active: 0, pending: 0, maxActive: 12 });
