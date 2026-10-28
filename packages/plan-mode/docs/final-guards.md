# Final Plan-mode guards

Scope: the 12 uncovered lines / 2 functions at PR #199 HEAD
`396bbb963f32c927d0a37f6456bf28079724aefe`. All source locations in this ledger refer
to that immutable revision, not shifted line numbers after the removals below.
The provider is truthful. This is a caller/dataflow investigation, not a provider,
source-inventory, exclusion, enforcement, or artifact-architecture change.

## Per-line ledger

| Original lines | Classification | Disposition |
| --- | --- | --- |
| `plan-mode.ts:1210-1211` | Reachable: open current-plan menu survives plan clearing | Retain; public RPC menu regression and killed mutation |
| `1396-1397` | Dead: no-UI fallback behind synchronous UI-only command gate | Remove fallback only; retain lifecycle checks after UI load |
| `1483`, `1609` | Dead: disabled-policy fallback and its sole calculation | Remove fallback/calculation; retain enabled admission and all validators |
| `1511-1512` | Unresolved defensive stale-policy rejection | Retain; no supported positive reproduction established |
| `1517-1518` | Unresolved defensive inconsistent-policy rejection | Retain; no supported positive reproduction established |
| `1650` | Reachable: blocked persistence leaves queued followers without admission marker | Retain; public input/tree/shutdown regression and killed mutation |
| `1659` | Unresolved defensive cross-session queue partition | Retain; no supported positive reproduction established |

## Missing plan: `1210-1211`

Every source caller of `startImplementation`:

- Direct command `runPlanCommand`, `355-361`, rejects a missing plan synchronously.
- `createPlanActionController` receives it as `implementHere` at `221`.
  `plan-action-controller.ts` exposes that callback in `showSaved` (`95`), `showReady`
  (`117`), and `showCurrent` (`144`). None exports the private closure itself.
- Real consumers are `saved-plan-menu.ts`, `plan-action-menus.ts` (current/ready menus).
  Their selector waits are genuine asynchronous boundaries. A direct private-function
  invocation is neither necessary nor used.

Reproduction (`final-guards.test.ts`, open-menu test): start Plan mode, complete a plan,
open the real RPC `/plan` menu, and deliver `before_agent_start` while `ctx.ui.select`
is waiting for the user's choice. That hook (`plan-mode.ts:834-852`) clears `latestPlan`
and `awaitingAction` but does not advance `workflowGeneration` or abort `menuController`.
The current-menu lifecycle therefore remains current. Selecting the already displayed
`Implement here` action reaches the missing-plan guard. It warns, keeps Plan mode active,
and sends no implementation handoff. This is not an external mutation of private state.

The ready-menu path is different: its additional ready-intent predicate notices clearing;
this regression deliberately uses the current-plan menu via `/plan`, not a fake ready
callback. Session/tree/exit transitions advance or abort its lifecycle and are not needed.
Bypassing `if (!initialPlan)` kills the test on the missing warning assertion.

## No-UI active menu: `1396-1397`

Exhaustive references to `showActivePlanMenu` in source are its declaration (`1394`) and
one direct invocation (`414`). It is not returned, exported, registered, assigned to a
callback, or passed to another module. `runPlanCommand` has already thrown at `406-409`
when `!ctx.hasUI`, and invokes it only under `state.activeImplementation && ctx.hasUI`
at `413`. There is **no await, event emission, user callback, getter mutation, or context
replacement between that condition and the callee's redundant check**.

The host context capability is a side-effect-free getter: installed Pi
`dist/core/extensions/runner.js:627-629` checks active runner identity and calls
`hasUI()` (`405-406`), which compares the current UI object against the no-op UI object.
Although this getter can differ across turns, this call chain does not yield a turn.
If the context is stale, its getter throws before the call; it does not turn false
between the two consecutive synchronous reads.

The public parity test restores an active implementation and runs the same `/plan`
command with UI absent/present. Absent UI rejects before lazy loading, with no plan
message; present UI opens the real RPC selector and displays the stored active plan.
A temporary throw in the dead fallback was never reached by all 571 tests after a fresh
dist build. The exhaustive single-caller/no-yield proof, not that green run alone,
justifies removing the fallback. Lifecycle/current checks on both sides of the later
`await loadInteractiveUi()` remain unchanged.

## Disabled policy: `1483`, `1609`

Exhaustive references to `planModePolicyToolNames`:

1. `tool_call` (`701`). This async handler has **no await at all**. Its first enabled
   test (`655-661`) returns for every disabled call, whether an ordinary tool or a
   required helper. Ownership, mutating-tool, registration, metadata and classification
   checks occur before the policy lookup. Pi tool registry access is synchronous.
2. `formatToolSummary` (`2042`). This private callback is passed only to
   `updatePlanModeUi` (`2026`) and `formatPlanModeStatusText` (`2034`). The former
   explicitly does not invoke it (`presentation.ts:38`, `void toolSummary`); the latter
   invokes it only inside its `if (state.enabled)` arm (`presentation.ts:152-156`).
   There is no await or external callback between that enabled check and invocation.

`computePlanModePolicyToolNames` (`1608-1610`) has exactly one source caller: the
unreachable disabled fallback at `1483`. `desiredPlanModeToolNames` and
`resolvePlanModePolicyToolNames` have other live callers and are retained. The change
replaces the two-arm helper with its only reachable return, `workflowAllowedToolNames ?? []`,
and removes that orphan calculation. It does not remove a validator or change tool
classification, selection, availability, ownership, shell or SSH admission.

Parity test: disabled public tool calls bypass registry reads both before activation and
after exit; enabled `read` admission still works. Other existing Node/Bun policy tests
exercise the actual shell and typed-tool validators. A temporary throw at the disabled
fallback also survived the full rebuilt 571-test suite. Again, the caller proof is the
reason for deletion, not inability to hit the line.

## Pending policy: `1511-1512`, `1517-1518`

Only `context` (`779`) invokes `resolvePendingWorkflowToolPolicy`. Its pending capture,
generation/enabled/owner guard, policy/resolved guard, lookup, state commit and clear are
synchronous; there is no await in the resolver. The surrounding async context handler
also contains no await. A session event cannot interleave *within* those checks merely
because the function or handler is declared async.

All writes to `pendingWorkflowToolPolicy`:

- Initial declaration `177`; `session_start:524`, `session_shutdown:627` clear it before
  their first await. `session_tree:569` calls `advanceWorkflowGeneration:1454-1455`,
  synchronously clearing pending before restoration and the later runtime await.
- `advanceWorkflowGeneration` is the only increment of `workflowGeneration`. Calls:
  new activation `940`, exit `986`, save `1168`, implementation `1234`, active-plan clear
  `1292`, and tree navigation `569`. Each clears pending with the increment.
- `beginWorkflowToolPolicy:1493-1504` installs an unresolved policy with mode `resolve`
  and the current generation. Called only by new activation (`954`) after owner acquire.
- `restoreWorkflowToolPolicy:1565-1592` installs a matching policy/mode pair (`resolved`
  -> `revalidate`, otherwise `resolve`) with current generation. Callers:
  `installRestoredState:1928`, failed implementation-handoff rollback `1279`.
- Resolver itself clears pending on either rejection or successful resolution (`1528`).
- Restoration's owner/helper/disabled failures clear (`1900`, `1914`, `1931`);
  its outer synchronous rollback restores the captured prior pending pair (`1943`).
  New-activation rollback clears (`1968`).

State policy replacement sites are new-workflow construction, policy begin/restore/resolve,
restored-state installation/rollback, and transitions that clear pending first. Other
state updates spread the existing state and modify plan/review/thinking/runtime fields,
not `workflowToolPolicy`. Mutable policy records are not returned through public tools:
restoration normalizes serialized values (`state.ts`), while persisted entries are passed
to the host append API, not treated as an extension-owned external mutation seam.

Owner mutations also matter: acquire/release in activation and rollback, session bind at
`515-516` and `bindWorkflowSessionIfNeeded:1981-1985`, shutdown unbind/release, and restored
owner acquisition/rollback. `WorkflowMutex` can invalidate owner identity on bind/unbind.
The bind helper executes before the already-enabled early return in `enterPlanMode`
(`923-924`); a noncanonical cross-context call could therefore break the simple invariant.
No supported host schedule producing that call with a surviving prior pending policy
has been demonstrated. Likewise, host synchronous reentrancy or an unusual persistence
implementation has not been exhaustively ruled out for the rollback snapshot.

Therefore neither defensive rejection is deleted. Ordinary awaited session replacement
alone is not a reproduction: start clears pending before settings I/O; tree clears it
before runtime I/O; shutdown clears before drain/settings-write awaits. A future test
must provide an actual supported cross-context/reentrant schedule, not inject a private
pending record or remove a security/staleness guard just because normal schedules avoid it.
These four lines remain explicitly open.

## Queued admission: `1650`, `1659`

All queue mutations and consumers:

- Initialized empty at `192`; cleared synchronously in `session_start:519`,
  `session_tree:575`, and `session_shutdown:625` (before their later awaits).
- The only push is `input:811`. It stamps the current `ctx.sessionManager`, and only
  happens when that manager matches the active runtime application or pending admission
  (`800-802`). The handler then awaits runtime application (`812`).
- A stale result removes that exact queued object (`814`, helper `1665-1667`);
  a blocked result deliberately does **not** remove it.
- `takeQueuedRuntimeAdmissionInputs` (`1654-1663`) is called only by `agent_start:826`
  (after checking `currentSession === ctx.sessionManager` at `822`) and
  `session_shutdown:602` (before drain/write awaits). It partitions by session identity
  and retains nonmatching objects.
- The only queue predicate is `runtimeAdmissionIsPending:1650`, called solely by
  `session_before_tree:546`.

Reachable failure schedule: new destination has a persisted runtime intent; leading input
starts a model application; follower input queues while `setModel` is pending; durable
intent consumption throws. `applyPendingImplementationRuntime:1798-1818` restores pending
state, warns and returns `blocked`, never reaching the pending-admission assignment at
`1820`. Its `finally` (`1823-1826`) clears the active application. Both input promises
settle as handled. Now only the queued follower remains: neither earlier operand of
`runtimeAdmissionIsPending` is true, so `.some` executes and prevents tree navigation.
Shutdown subsequently recovers the follower exactly once with no implementation handoff.
Removing `.some` kills this regression because tree navigation would no longer cancel.
This also covers the anonymous predicate function, not merely its parent statement.

For `1659`, same-session blocked inputs do not suffice: both consumers partition using
their own session identity. New/tree replacement clears old queues before awaiting.
A stale input continuation only removes its exact prior object. Successful runtime
application with admission holding sets the marker before clearing the active slot;
`agent_start` clears the marker and drains its same-session queue synchronously. Thus
these ordinary paths cannot produce a nonmatching partition member.

However, shutdown partitions *before* its current-session mismatch checks (`630`, `635`).
A delayed shutdown event with a prior context could theoretically encounter a newer
session's queue. No actual host event-delivery schedule reproducing this has been
established. The defensive `else remaining.push(queued)` must remain until that contract
is proven; deleting it could lose a different session's prompts. This line remains open.

## Validation

Baseline with only the four new behavioral tests and unchanged source: 53 files / 571
Node tests pass. Source-complete Istanbul: 943/952 lines, 154/155 functions,
1036/1077 statements, 728/803 branches. The comparison base (#199) recorded 940/952 lines,
153/155 functions. The new tests cover three real lines and the queued predicate function
before any deletion.

Temporary mutations, all restored:

- Bypass missing-plan guard: open-menu regression fails.
- Remove queued predicate operand: blocked-persistence tree regression fails.
- Replace both proven-dead fallbacks with throwing sentinels: 571 tests pass after
  rebuilding dist. The first attempt correctly failed the generated-artifact parity
  contract because the temporary source was newer than dist; it was rebuilt and rerun.

Final sequential gate (one Vitest worker throughout):

- `VITEST_MAX_WORKERS=1 npm run check`: passed; dist parity 8 tests, regenerated build,
  Biome, strict typecheck, Node Vitest 53 files / 571 tests, native Bun 8 tests /
  255 assertions.
- `node ../../scripts/run-vitest.ts bun --maxWorkers=1`: passed, 53 files / 571 tests.
- Full Node Istanbul run with unchanged `include=src/plan-mode.ts`, JSON + LCOV:
  53 files / 571 tests passed. Exactly one source identity, no executing-fragment scope.

| Measurement | #199 receipt | New tests, original source | After proven-dead removal |
| --- | ---: | ---: | ---: |
| Lines | 940/952 | 943/952 | 942/947 |
| Functions | 153/155 | 154/155 | 154/154 |
| Statements | 1033/1077 | 1036/1077 | 1034/1071 |
| Branches | 727/803 | 728/803 | 726/799 |

The denominator decrease is explicit, not a measurement change: remove the no-UI
conditional (1 covered line and 2 uncovered lines), the disabled-policy return (1
uncovered line), and the orphan calculation body (1 uncovered line / 1 uncovered
function). Simplifying the enabled policy helper also removes redundant statement/
branch counters without removing its covered return line. No reachable validator,
stale-policy rejection or cross-session prompt-retention branch was deleted.

Five lines remain uncovered, zero functions: final source lines
`1506,1507,1512,1513,1650`, corresponding to original `1511,1512,1517,1518,1659`.
The function percentage is now 100%, but **source lines are not 100%**. These five
security/lifecycle-defense lines remain open, not excluded or rewritten for counters.

Local before/after reports: `/tmp/pm-finalguards-{before,after}-removal/` contain
`coverage-final.json` and `lcov.info`. These are local receipts, not durable hosted
artifacts. Logs: `/tmp/pm-finalguards-{check,bun,after-removal}.log`.
Before large runs the host observer reported 10 CPUs, 67.4% sampled utilization,
0.3 GiB immediately free, `memory_pressure` 62% free; work remained sequential with one
worker. The owner supplied concurrent reviews/coverage/policy/Bun/crash-diagnostic
activity. This worker did not infer agent identity from OS processes or edit #199's
worktree. Full monorepo `make check`, hosted CI, merge, release and live activation
have not been performed by this worker. Review evidence is posted on the final PR HEAD.
