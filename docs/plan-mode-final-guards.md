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

At #200, `takeQueuedRuntimeAdmissionInputs` retained `else remaining.push(queued)` (one line).
The following historical analysis is superseded by the closure proof below.
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

## Pinned-host queue partition proof (superseded)

The proof below describes stock CLI lifecycle dispatch only. It does not justify deleting
an SDK-host defensive guard from a package with unrestricted Pi peers. The audit correction
and restored guard are documented below.

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
- [`reload`](https://github.com/nredd/pi/blob/2bfb8e7c61d35167b09f8ce70693df39660fc197/packages/coding-agent/src/core/agent-session.ts#L4199-L4238)
  keeps the `AgentSession` and its core queues, but awaits outgoing shutdown, invalidates
  the old runner, reloads resources/factories, rebuilds the runner and only then emits
  `session_start`. Surviving core queues still cannot become mixed-manager entries in
  the extension-local queue; outgoing recovery and reset finish first.
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

The original change removed the session partition from `takeQueuedRuntimeAdmissionInputs`; retained
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

## Package-range audit correction

Option (b): restore the partition. Keep `peerDependencies: "*"` and the README's Pi
`0.80.6` floor unchanged. Stock CLI inspection is not a proof for every SDK embedding.
In published `@earendil-works/pi-coding-agent@0.80.6`, `dist/core/sdk.js:63-78`
accepts a caller-provided `resourceLoader` without reloading it. Moreover,
`dist/core/resource-loader.js:279` installs the result of `extensionsOverride`, which
can return previously initialized extension objects. Neither API requires a new extension
factory invocation per runtime. Thus shared-instance SDK hosts remain unproven; no old
stock release was demonstrated broken, and narrowing the peer range is not justified.

Read-only audit: `npm view @earendil-works/pi-coding-agent versions --json`, then
`npm pack @earendil-works/pi-coding-agent@VERSION --ignore-scripts` and extract under
`/tmp/planmode-pi-audit`, without installing or running upstream code. The registry listed
`0.80.6` through `0.87.x`, `0.99.x`, and `1.0.x` through `1.4.0` (no `0.88`-`0.98`).
The following release-boundary samples all use ordered stock teardown and fresh factories.
Patch releases were not exhaustively inspected; this is NOT a supported-range closure proof.

All citations below are published-package `dist/` JavaScript, not fork source offsets.
`R` = `core/agent-session-runtime.js` (await shutdown; then new/resume/fork/import),
`S` = `core/agent-session-services.js` (new loader then reload),
`F` = `core/extensions/loader.js` (factory invocation),
`L` = `core/agent-session.js` (reload: await shutdown before resource reload/build).
Exact bytes are retrievable at `https://unpkg.com/@earendil-works/pi-coding-agent@VERSION/dist/FILE`.

| Version | R | S | F | L |
| --- | --- | --- | --- | --- |
| 0.80.6 | 102-109; 133-158, 203-242, 272-279 | 60-66 | 356, 372 | 2023-2034 |
| 0.81.0 | 102-109; 133-158, 203-245, 275-282 | 62-68 | 373, 389 | 2056-2067 |
| 0.82.0 | 102-109; 133-158, 203-245, 275-282 | 62-68 | 373, 389 | 2056-2067 |
| 0.83.0 | 102-112; 136-161, 206-248, 278-285 | 62-68 | 373, 389 | 2052-2063 |
| 0.84.0 | 102-112; 136-161, 206-248, 278-285 | 63-69 | 409, 425 | 2052-2065 |
| 0.85.0 | 102-112; 136-161, 206-249, 286-293 | 63-69 | 462 | 2217-2230 |
| 0.86.0 | 102-112; 136-161, 206-249, 286-293 | 63-69 | 449 | 2319-2332 |
| 0.87.0 | 102-112; 136-161, 206-249, 286-293 | 63-69 | 449 | 2603-2616 |
| 0.99.0 | 102-112; 136-161, 206-249, 286-293 | 63-69 | 497 | 2867-2880 |
| 1.0.0 | 102-112; 136-161, 206-249, 286-293 | 63-69 | 509 | 2899-2921 |
| 1.1.0 | 102-112; 136-161, 206-249, 286-293 | 63-69 | 514 | 2936-2959 |
| 1.2.0 | 102-112; 136-161, 206-249, 286-293 | 63-69 | 514 | 2968-2991 |
| 1.3.0 | 102-112; 136-161, 206-249, 286-293 | 63-69 | 514 | 2969-2992 |
| 1.4.0 | 102-112; 136-161, 206-249, 286-293 | 63-69 | 517 | 2998-3021 |

The retained stock replacement fixture remains a stock-host contract test. A separate
explicitly fault-injected shared-instance fixture sends shutdown with a different manager
while the owner has a queued text/image/RPC input. The partition retains that input, and
an early manager check prevents unrelated shutdown from resetting workflow state. Shutdown
also no longer clears the retained queue after partitioning it, including when no current
manager is bound. Owner admission
then delivers it exactly once. Mutating `else remaining.push(queued)` to
`else matching.push(queued)` fails the assertion that unrelated shutdown emits no recovery.
This covers the formerly missing retention line without pretending a stock schedule reaches it.

Input during awaited shutdown is possible for an embedding that dispatches concurrently;
we do not assume the CLI serializes every input source. Mark the shutting-down manager
before awaiting model/settings writes. Later input from that manager is immediately
persisted as a visible `plan-mode-recovered-input` message with text/images/source and
`triggerTurn: false`, rather than joining a queue whose stale continuation would remove it.
Session start clears the marker. The replacement fixture injects late extension input
while `setModel` is blocked and verifies exact recovery and no duplicate follow-up.
A second fault-injection fixture replaces the manager during the await and covers the
post-await identity recheck. Disabling the late-input check kills the exact recovery assertion.

The combined measurement above is historical, before this correction. Restoring the guard
and adding late-input recovery raises the denominator to **2996/2996 lines and 699/699
functions** on both Node and Bun (629 tests, 65 files). This combined run temporarily overlays
only the sibling tests/support from scratch merge `cfe214a` (#185/#188/#189); those overlays
are removed afterward and are not part of this PR. The standalone #209 stack passes 604
tests in 61 files, with 97.69% lines and 96.99% functions; its remaining gaps belong to those
siblings, not this guard. `src/plan-mode.ts` itself has complete lines/functions. No coverage
exclusion, provider change or threshold relaxation is used. Commands belong in the PR receipt.

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
