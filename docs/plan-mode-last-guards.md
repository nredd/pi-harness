# Remaining Plan-mode guards

Follow-up to PR #200. No runtime source, exclusions, provider, inventory, threshold or
configuration changes. All five defensive lines stay in place.

## Public runtime rollback reproductions

`packages/plan-mode/test/pending-policy-interleaving.test.ts` uses registered `/plan`
commands and `session_start`, `input`, `context`, `tool_call`, `session_shutdown` handlers.
The only substitutions are host services: a gated asynchronous `setModel`, model auth,
a disposable branch and failing `appendEntry`. No private closure is called.

The input has not started an agent run while runtime application awaits authentication
and model selection. Commands are therefore allowed by `ctx.isIdle()`. A command can
change the workflow generation during those awaits without changing `menuGeneration`.
`applyPendingImplementationRuntime.isCurrent()` checks session/menu generation, not
workflow generation. Its captured `pendingState` can outlive an intervening workflow.
When consuming the runtime intent fails, its catch restores that captured state, but
does not restore or clear the intervening `pendingWorkflowToolPolicy`.

Two supported schedules:

1. **Disabled snapshot:** start a new session with pending implementation runtime. Its
   first public input starts runtime application; allow its microtask to capture disabled
   state, then stop inside `setModel`. `/plan start` installs an enabled workflow and a
   pending resolve record. Release the model with persistence failing. Rollback restores
   the disabled snapshot while the pending record remains. `context` reaches the stale
   rejection through `!state.enabled`. It must not persist a freeze; normal tool admission
   remains unrestricted. Both rejection lines are reached.
2. **Resolved snapshot:** start the same input, but before its first microtask invoke
   `/plan start` and `context` synchronously. They install and freeze a read-only workflow
   before runtime application captures `pendingState`. Stop inside `setModel`, then
   `/plan off` and `/plan start` to create a new generation with pending `mode: resolve`.
   Make `find` active only after that new workflow's provisional allowlist was captured.
   Release the model with persistence failing. Rollback restores the old resolved policy,
   leaving the new pending resolve record. `context` reaches the consistency rejection
   because `policy.resolved === true` but `expectedResolved === false`. Both rejection
   lines are reached. It must not broaden the frozen allowlist or persist a new freeze;
   `read` remains admitted and `find` remains blocked. A second `context` remains inert.

This disproves the earlier tentative invariant that state-spreading updates always keep
pending policy consistent. The async rollback is a whole-state assignment across awaits.
Neither rejection is dead code and neither is removed.

## Mutation evidence and limits

Run the new test file with `vitest run test/pending-policy-interleaving.test.ts
--maxWorkers=1` after each temporary mutation, then restore the source:

- Delete only the consistency rejection's conditional and body: the enabled-snapshot
  test fails `rollback must not broaden frozen tools` (`find` is no longer blocked).
  This kills the targeted guard-deletion mutant.
- Delete only the stale rejection's conditional and body: both new tests pass. In the
  demonstrated disabled snapshot the following consistency guard also rejects the
  absent policy. This is a **surviving, masked mutant**, not an independent security proof
  for generation or ownership loss. The stale body's lines are covered, but independent
  stale-guard mutation adequacy remains unresolved. Keep the entire guard, including
  generation and ownership checks; do not infer removability from this one schedule.

## Queue retention remains unresolved

`takeQueuedRuntimeAdmissionInputs`, `else remaining.push(queued)` (source line 1651),
remains uncovered and retained. The public input producer stamps its context's session
before awaiting runtime completion. Session start/tree/shutdown clear queues; stale input
continuations remove their exact objects. `agent_start` checks the current session before
partitioning; shutdown partitions before its later mismatch checks and clears the whole
queue before awaiting. A synthetic old-context shutdown can reach retention but does not
establish a supported host schedule or protect it with a meaningful behavioral mutation.

The host's replacement path awaits shutdown before creating the replacement runtime.
That ordinary order is insufficient to prove exhaustive unreachability: input event
handlers are awaited sequentially, and delayed upstream handlers can retain old contexts.
No complete proof of every concurrent event/replacement ordering, or supported retention
reproduction with observable prompt preservation, is claimed here. Deleting retention on
that basis could lose prompts. Leave it open rather than manufacturing a cross-context
mock event or weakening a security guard.

## Source measurements

Both full suites: **574 tests, 54 files passed**, one Vitest worker, Istanbul. Node and
Bun produced identical counts. Explicit instrumentation input: `src/**/*.ts`; all 36 source
files were inventoried. Istanbul emitted 34 executable entries. `src/index.ts` and
`src/interactive-ui.ts` contain only re-exports and have no executable counters; they are
not excluded by configuration.

| Scope | Lines | Functions | Statements | Branches |
| --- | ---: | ---: | ---: | ---: |
| `src/plan-mode.ts`, #200 | 942/947 | 154/154 | 1035/1071 | 727/799 |
| `src/plan-mode.ts`, this change | 946/947 | 154/154 | 1039/1071 | 729/799 |
| All `src/**/*.ts`, this change | 2857/2989 | 661/698 | 3265/3504 | 2797/3151 |
| Other source files only | 1911/2042 | 507/544 | 2226/2433 | 2068/2352 |

Package-wide coverage is **95.58% lines, 94.69% functions**, not 100%. Beyond
`plan-mode.ts`, **131 lines and 37 functions** remain uncovered:

| Source | Lines | Functions |
| --- | ---: | ---: |
| `completion-tool.ts` | 34/35 | 14/17 |
| `fresh-implementation.ts` | 106/113 | 20/20 |
| `message-transform.ts` | 129/132 | 33/33 |
| `plan-action-controller.ts` | 54/63 | 26/33 |
| `plan-action-menus.ts` | 91/113 | 37/46 |
| `plan-export.ts` | 43/48 | 9/10 |
| `plan-launch-menu.ts` | 27/32 | 12/12 |
| `presentation.ts` | 82/83 | 19/21 |
| `question-tool.ts` | 114/130 | 30/34 |
| `ready-plan-chooser.ts` | 56/65 | 10/13 |
| `saved-plan-menu.ts` | 15/19 | 9/10 |
| `saved-plan-preflight.ts` | 16/22 | 2/2 |
| `settings-menu.ts` | 103/109 | 46/46 |
| `settings.ts` | 230/235 | 43/44 |
| `state.ts` | 71/72 | 16/16 |
| `tool-policy.ts` | 449/480 | 73/79 |

The other 17 executable files have complete lines and functions. Branch coverage is
report-only; no thresholds or exclusions changed. Commands, final gate output, exact SHA
and independent review reports belong in the PR receipt.
