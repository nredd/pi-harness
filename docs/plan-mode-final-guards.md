# Final Plan-mode guards

Follow-up to the [attribution diagnosis](plan-mode-coverage-attribution.md). Istanbul measures the
real source. No provider, inventory, exclusion, threshold or artifact-architecture change
is needed. The ledger names symbols and predicates so source offsets cannot confuse a
covered queue predicate with the still-open partition branch.

## Reachable guards retained

- `startImplementation`, `if (!initialPlan)`: direct `/plan implement` checks for a plan
  first, but `createPlanActionController` also passes `implementHere` to `showSaved`,
  `showReady` and `showCurrent`. Their real menus await selection. While the current-plan
  menu is open, `before_agent_start` clears `latestPlan` and `awaitingAction` without
  advancing `workflowGeneration` or aborting `menuController`. The current-menu lifecycle
  stays current; selecting the displayed `Implement here` reaches the missing-plan guard.
  It warns, leaves planning active and sends no handoff. The ready menu has an additional
  intent predicate and is not interchangeable with this reproduction.
- `runtimeAdmissionIsPending`, `queuedRuntimeAdmissionInputs.some(...)`: follower input
  queues during an awaited `setModel`. If durable runtime-intent consumption throws,
  `applyPendingImplementationRuntime` restores pending state and returns `blocked` before
  assigning `pendingRuntimeAdmissionSession`; its `finally` clears the active application.
  Both input promises settle, but the follower remains queued. The queue predicate alone
  now cancels `session_before_tree`. Shutdown recovers the follower exactly once.

`test/final-guards.test.ts` reaches both guards through commands, real RPC selection and
public input/tree/shutdown events. It does not invoke a private closure.

## Removed fallthroughs: exhaustive caller proof

`showActivePlanMenu` had one source caller: `runPlanCommand`. It is not exported, returned,
registered or passed as a callback. The command first rejects `!ctx.hasUI`, then calls it
only under `state.activeImplementation && ctx.hasUI`. There is no await, event emission,
user callback or context replacement between that condition and the callee's redundant
no-UI check. The host capability getter only checks runner activity and UI presence; it
cannot change across these consecutive synchronous reads. Remove only that fallback.
Keep the lifecycle checks surrounding the later `await loadInteractiveUi()` and the
redundant caller conjunct, avoiding unrelated churn. Public parity covers no-UI rejection
without lazy loading and UI-present display of the active plan.

`planModePolicyToolNames` has exactly two caller chains:

1. `tool_call` returns on `!state.enabled` before consulting policy. The handler has no
   await, including through registry, metadata and classification checks.
2. `formatToolSummary` is passed only to `updatePlanModeUi` and `planModeStatusText`.
   The former discards it (`void toolSummary`); the latter invokes it only inside
   `if (state.enabled)`. Neither yields or invokes an external callback between the
   enabled check and the summary.

`computePlanModePolicyToolNames` had only the disabled fallback as a caller. Remove that
fallback and orphan calculation; retain `desiredPlanModeToolNames` and
`resolvePlanModePolicyToolNames`, which have live callers. No availability, ownership,
selection, classification, shell or SSH validator changes.

Disabled-state paths clear `workflowAllowedToolNames`: session start, exit, save,
implementation start, restored-state installation (including busy/helper failure), and
new-activation rollback. Shutdown also clears it. Restoration's synchronous outer catch
restores the captured state/allowlist pair together. Other state updates preserve policy.
The public parity test proves disabled admission bypasses registry reads before activation
and after exit, enabled `read` still works, and exit clears status. It does **not** claim
to call this private helper while disabled or directly observe its unreachable `[]` return.

## Five defensive lines remain open

`resolvePendingWorkflowToolPolicy` retains both rejection bodies:

- `pending.generation !== workflowGeneration || !state.enabled || !isOwner(...)`:
  clear pending and return (two lines).
- `!policy || policy.resolved !== expectedResolved`: clear pending and return (two lines).

Only the `context` handler invokes the resolver, synchronously and without an await.
Every generation increment goes through `advanceWorkflowGeneration`, which clears pending:
activation, exit, save, implementation start, active-plan clear and tree navigation.
Session start/shutdown also clear pending before settings/drain/write awaits. Policy
begin/restore install a matching generation and resolve/revalidate mode; resolution clears
pending. Restoration failures and new-activation rollback clear it; restoration's outer
catch restores the captured pending/state/allowlist/owner snapshot synchronously.
Other state updates spread existing policy rather than replacing it.

Owner acquire/release, restored-owner rollback, session bind/unbind and
`bindWorkflowSessionIfNeeded` must also be considered. The last can bind before the
already-enabled early return in `enterPlanMode`. No supported cross-context/reentrant
schedule leaving an inconsistent pending record has been demonstrated. Normal async
session replacement alone cannot interleave inside the synchronous resolver. Neither
stale/security rejection is deleted merely because the ordinary paths avoid it.

`takeQueuedRuntimeAdmissionInputs` retains `else remaining.push(queued)` (one line).
The only queue push is `input`, stamped with its context's session identity while runtime
application/admission is pending, before awaiting completion. Stale continuation removes
its exact object; blocked continuation keeps it. Session start/tree/shutdown clear queues
before later awaits. Consumers are `agent_start` (after a current-session check) and
`session_shutdown`, each partitioning by its context's session. Successful admission sets
the marker before clearing the active slot; agent start clears the marker and drains
synchronously. These paths normally partition same-session members. However, shutdown
partitions before its later current-session mismatch checks: a delayed old-context event
might encounter a newer session's queue. Without a supported reproduction or complete host
ordering proof, deleting retention could lose prompts. This branch stays open.

## Counts

| Source measurement | Lines | Functions | Statements | Branches |
| --- | ---: | ---: | ---: | ---: |
| Current #199 base `83a10bc` | 940/952 | 153/155 | 1034/1077 | 728/803 |
| Final #200 | 942/947 | 154/154 | 1035/1071 | 727/799 |

The source denominator reduction removes five line entries: the no-UI conditional
(one covered, two uncovered), disabled-policy return (one uncovered), and orphan calculation
(one uncovered, one function). The enabled helper keeps its covered return. Simplifying
these branches also removes six statement and four branch entries. This is explicit dead
code removal, not a fixed-denominator coverage gain. Five defensive lines remain uncovered;
functions are complete but source lines are **not 100%**.

Execution commands, killed-mutant assertions, gate output and complete Istanbul reports
belong in the PR receipt, not this source-level proof.
