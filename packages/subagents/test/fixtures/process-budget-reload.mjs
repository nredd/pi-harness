/** Run beside two temporary compiled copies of the actual process-budget source. */
import assert from "node:assert/strict";
import * as fresh from "./fresh.mjs";
import * as incompatible from "./incompatible.mjs";
import * as old from "./old.mjs";

// Identity matters: re-exporting the same cached module would not test /reload.
assert.notEqual(old.tryAcquireBudget, fresh.tryAcquireBudget);
old.setBudgetPolicy({ maxActive: 12, nestedReserve: 2, maxDepth: 2 });
const roots = Array.from({ length: 10 }, () => old.tryAcquireBudget(1));
assert.ok(roots.every(Boolean));
assert.equal(fresh.tryAcquireBudget(1), undefined);
const children = Array.from({ length: 2 }, () => fresh.tryAcquireBudget(2));
assert.ok(children.every(Boolean));
assert.equal(old.tryAcquireBudget(2), undefined);
assert.deepEqual(fresh.budgetUsage(), { active: 12, pending: 0, maxActive: 12 });
assert.deepEqual(old.budgetUsage(), fresh.budgetUsage());

let granted;
fresh.enqueueBudget({ depth: 1, ready: () => true, grant: lease => { granted = lease; } });
fresh.pumpBudget();
assert.equal(granted, undefined);
assert.deepEqual(old.budgetUsage(), { active: 12, pending: 1, maxActive: 12 });

// Releasing a root in the OLD module wakes the NEW module's waiter.
old.releaseBudget(roots.shift());
old.pumpBudget();
assert.ok(granted);
assert.deepEqual(old.budgetUsage(), { active: 12, pending: 0, maxActive: 12 });
assert.deepEqual(fresh.budgetUsage(), old.budgetUsage());

// Each module can return leases made by the other; neither keeps a private count.
for (const lease of roots) fresh.releaseBudget(lease);
for (const lease of children) old.releaseBudget(lease);
old.releaseBudget(granted);
assert.deepEqual(fresh.budgetUsage(), { active: 0, pending: 0, maxActive: 12 });
assert.deepEqual(old.budgetUsage(), fresh.budgetUsage());

// An actual third module copy uses the next incompatible state version. It
// must refuse admission, even if asked to disable the cap, not fork the count.
const survivor = old.tryAcquireBudget(1);
assert.ok(survivor);
assert.notEqual(incompatible.tryAcquireBudget, old.tryAcquireBudget);
assert.throws(() => incompatible.tryAcquireBudget(1), /Incompatible process budget.*Restart pi/);
assert.throws(() => incompatible.setBudgetPolicy({ maxActive: 0, nestedReserve: 2, maxDepth: 2 }), /Restart pi/);
assert.deepEqual(old.budgetUsage(), { active: 1, pending: 0, maxActive: 12 });
// The predecessor can still settle its survivor under its unchanged state.
old.releaseBudget(survivor);
assert.deepEqual(old.budgetUsage(), { active: 0, pending: 0, maxActive: 12 });
