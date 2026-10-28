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

## Five defensive lines remained open at #200

The [runtime rollback follow-up](plan-mode-last-guards.md) reaches all four policy rejection
lines and retains the unresolved queue line. The analysis below records the #200 snapshot;
its tentative state/pending consistency assumption does not cover that async rollback.

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

## Cross-session queue partition closure

The tentative delayed-old-context schedule above is not a core-host schedule. Verified
against the checked-in `forks/pi` Gitlink `2bfb8e7c61d35167b09f8ce70693df39660fc197`,
not the workstation install:

- [`AgentSessionRuntime.teardownCurrent`](https://github.com/nredd/pi/blob/2bfb8e7c61d35167b09f8ce70693df39660fc197/packages/coding-agent/src/core/agent-session-runtime.ts#L167-L177)
  awaits abort and outgoing `session_shutdown`, then disposes the outgoing session.
  [`switchSession` and `newSession`](https://github.com/nredd/pi/blob/2bfb8e7c61d35167b09f8ce70693df39660fc197/packages/coding-agent/src/core/agent-session-runtime.ts#L196-L260)
  create/apply the destination runtime only AFTER that teardown. Fork uses the same order
  (lines 299-347). No newer runner can enqueue into the outgoing extension's closure.
- [`createAgentSessionServices`](https://github.com/nredd/pi/blob/2bfb8e7c61d35167b09f8ce70693df39660fc197/packages/coding-agent/src/core/agent-session-services.ts#L135-L154)
  creates and reloads a fresh resource loader for each runtime. The extension
  [loader invokes its factory](https://github.com/nredd/pi/blob/2bfb8e7c61d35167b09f8ce70693df39660fc197/packages/coding-agent/src/core/extensions/loader.ts#L617-L625)
  again, so `planMode` has a new empty extension-local queue. This is not a transfer of
  a queue from the previous closure. The CLI runtime factory calls these services in
  [`main.ts:764`](https://github.com/nredd/pi/blob/2bfb8e7c61d35167b09f8ce70693df39660fc197/packages/coding-agent/src/main.ts#L764-L779).
- Core user steering/follow-up queues are instance fields, initialized empty in
  [`agent-session.ts:429-435`](https://github.com/nredd/pi/blob/2bfb8e7c61d35167b09f8ce70693df39660fc197/packages/coding-agent/src/core/agent-session.ts#L429-L435).
  [`createAgentSession`](https://github.com/nredd/pi/blob/2bfb8e7c61d35167b09f8ce70693df39660fc197/packages/coding-agent/src/core/sdk.ts#L411-L478)
  creates a fresh `Agent` and `AgentSession`, without copying those queues. Persisted
  transcript entries (including recovered input) are distinct from pending input.
- [`ExtensionRunner.createContext`](https://github.com/nredd/pi/blob/2bfb8e7c61d35167b09f8ce70693df39660fc197/packages/coding-agent/src/core/extensions/runner.ts#L883-L909)
  resolves `sessionManager` from its runner, with an active-runner guard. Disposal
  [invalidates that runner](https://github.com/nredd/pi/blob/2bfb8e7c61d35167b09f8ce70693df39660fc197/packages/coding-agent/src/core/agent-session.ts#L1513-L1520).
  Holding an old context cannot turn it into the new session's context.
- [`navigateTree`](https://github.com/nredd/pi/blob/2bfb8e7c61d35167b09f8ce70693df39660fc197/packages/coding-agent/src/core/agent-session.ts#L4653-L4700)
  branches the existing manager and emits `session_tree` through the same runner. It
  does not change manager identity. Core queues can survive tree navigation, but they
  cannot acquire a different manager identity that way. Plan mode also vetoes navigation
  while runtime input is pending, and resets its own queue on `session_tree`.

Local exhaustive caller proof: `input` is the only push, synchronously stamping its
runner's manager before awaiting runtime application. `agent_start` checks the current
manager before draining. `session_shutdown` drains synchronously before its first await;
core cannot start the replacement runtime until that shutdown finishes. Session start,
tree and shutdown reset the queue before their later awaits. A promise barrier in model
application can suspend settlement, but cannot transplant a queued object across these
resets or across fresh closures. Injecting a stale shutdown into a newer extension
instance would violate core dispatch rather than model it.

Remove only the dead session partition from `takeQueuedRuntimeAdmissionInputs`; retain
all live lifecycle/admission checks and the per-input manager used by pending detection.
The helper now takes the whole extension-local queue and replaces it with an empty one.
This removes four executable line entries, including the last uncovered line, rather
than claiming a fixed-denominator coverage gain. Functions remain unchanged.

`test/final-guards.test.ts` adds a deterministic barrier fixture matching core's
`shutdown -> fresh factory -> session_start` order. It proves outgoing text/image/source
recovery exactly once while model application is suspended, no outgoing follow-up,
independent incoming admission, and no duplicate delivery on a second `agent_start` or
shutdown. Existing blocked-persistence/tree protection remains covered. No fake queue
survival, private closure entry, measurement exclusion or default-behavior change.

Combined measurement (plain-merged #209 + #185/#188/#189, plus this change): Node and
Bun each pass 627 tests in 65 files, with **2985/2985 lines and 698/698 functions**.
The original 2989-line denominator falls by four proven-dead partition lines; it is not
reported as 2989/2989. Statements are 3410/3499 and branches 2921/3149 (report-only).
All 34 executable source entries have complete lines/functions. Standalone #209 stack
without those sibling tests passes 602 tests in 61 files, with 2916/2985 lines and
677/698 functions on each engine; its remaining gaps belong to the sibling PRs.

A temporary mutation omitting the helper's queue reset fails the new fixture's exact
incoming delivery assertion: the second `agent_start` sends the follower twice. The
restored source passes. Package build, Biome, types and native Bun session checks also
pass; exact commands and logs belong in the PR receipt.

## Historical counts

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
