# Goal stack ports

- 12 ledger rows moved to six `integration/inprocess/*.test.ts` files, 14 cases under Vitest and Bun.
  Real kit/router/Plan/todo/subagents factories and `AgentSession`; only physical provider replies,
  cached quota snapshots, UI notifications and a held parent tool are doubles
- `goal-support.ts` reuses the kit scenario clock/helpers. Kit timers, router usage and exhaustion
  use one clock. Core retry uses `baseDelayMs: 0`, not a sleep/preload
- `startStack` forwards `useModelRuntimeStream` so virtual dispatch traverses the real runtime.
  The goal fixture explicitly sets `withConfiguredAuth: true` (parent `faux-key`); physical faux
  providers register `apiKey: "faux"`, and quota/admission/child tests assert `getAuth(model)` resolves.
  No missing-auth, compaction or summary assertion depends on nredd.5's custom-stream regression;
  these tests remain on nredd.5 until the orchestrator rebases them onto nredd.6
  No production seams added. Children load the real kit through the real resource loader; persisted
  child markers, schema isolation, parent accounting and busy-parent outbox order are asserted
- Removed only ported Python functions and `run.sh`'s `fail`/`capped` branches. The wrapper still
  calls `run.sh all`, covering `wait` and `no-router`. Nothing here runs that shell suite locally

Stopped rows, retained unchanged in the ledger and runnable source:

- `test_scheduled_subagent_notice_is_delivered_before_any_nudge`: `forks/pi-subagents/src/index.ts`
  constructs `new SubagentScheduler()` without options. `src/schedule.ts` uses `Date.now()`,
  `new Date()`, native `setTimeout`/`setInterval` and Cron directly. No extension option/env hook
  threads an injected clock into relative schedule parsing or dispatch. Needs a fork PR
- `test_no_tick_while_a_goal_waits_on_a_subagent`: `CompletionOutbox` has only send/running callbacks;
  `src/completion-outbox.ts` arms the idle 200ms hold with native `setTimeout`. The extension entry
  offers no timer hook. Advancing only kit time would NOT execute that production callback.
  Needs injectable idle outbox timers threaded through the fork entry
- `test_goal_and_loop_do_not_duplicate_router_dispatch_wait` (both policy cases retained) and
  router `wait`: parking calls the same hardcoded scheduler. Using fake quota time with real
  scheduler time either rejects a past ISO schedule or tests a different clock. Needs the scheduler
  seam above. `fail`/`capped` alone require no scheduled dispatch, so those shell rows did move
- Busy-parent background delivery does not need the idle hold: a controlled child finishes while a
  real parent tool is held; `subagents:completed` releases it, then production `turn_end` flushes the
  real outbox before any goal nudge. No private outbox call or fake notification

Mutation evidence (all changes reverted; logs in `~/code/pi-harness-builds/ports/`):

- `stack-goal-mutation-plan.log`: remove idle Plan excursion detection -> `idle Plan excursion pauses goal` red
- `stack-goal-mutation-loop.log`: ignore Plan mode on loop ticks -> `Plan suspension skips loop ticks until exit` red
- `stack-goal-mutation-todos.log`: ignore an earlier handler's continuation -> `todo reminder and goal share one continuation` red
- `stack-goal-mutation-accounting.log`: charge two turns instead of one -> `foreground child is isolated from parent goal accounting` red
- `stack-goal-mutation-quota.log`: disable goal stop watcher -> both exhausted-chain hook orders and bound loop/goal pause red
- `stack-goal-mutation-admission.log`: ignore max-wait cap -> `max wait cap refuses distant reset` red
- `stack-goal-mutation-subagents.log`: removing only the child's hidden exposure survived: without an
  active goal `defaultActive: false` also suppresses its schema. This port does not claim to replace
  the kit's direct child capability/rename/execute-guard scenarios

Gate receipts are recorded in `stack-goal-check.log` (22 cases on each runtime),
`stack-goal-integration.log` (84 Python unit cases and 15 Node probes) and `stack-goal-ts.log`
(full workspace check) under that evidence directory. The explicit-auth follow-up reruns the
stack workspace in `stack-goal-auth.log` after the full `check-ts` run. No pi binary, scenario pytest, tmux, benchmark,
package contract, `e2e/run.sh` or `make verify` run.
