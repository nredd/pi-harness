# Scheduler fixture clocks

For contributors testing scheduled model selection.

`test/config-model-fallback-spawn.test.ts` uses the existing `FakeClock` through
`SubagentScheduler({ clock })`. Construct ISO deadlines from `clock.now()` and
advance that same clock to invoke the public timer path. Drain the mocked
runner's promise chain with `setImmediate`, not a wall-time polling deadline.
The scheduler still calls the real model selector before passing its resolved
selection to the runner stand-in; this does not replace real-runner coverage in
`config-model-fallback-real-runner.test.ts`.

The fixture injects the clock, so its 50ms deadline advances solely under test
control and reaches the public model-not-found path regardless of host load.

The controlled-time regressions in that file are "rejects a deadline that the
injected clock has already passed, before model selection" and "stamps createdAt
from the injected clock, not the wall clock". The first builds a 50ms ISO deadline,
advances the `FakeClock` 51ms, and asserts `addJob` throws
`Scheduled time ... is in the past`, leaves `list()` empty and `clock.pending` at
0, and never calls `runAgent`. The second advances the clock, then asserts the
job's `createdAt` equals the `FakeClock` time. Pointing `addJob` back at
`Date.now()` fails the second and every fire-path test (the fake epoch is 2020,
so the deadline is long past on the wall clock); dropping the past-timestamp
check fails the first.

The fire-path fixture additionally checks no execution before its deadline, the
public model-not-found `error` event for an unresolved explicit model, one-shot
completion, a valid explicit model, and cancellation through public `removeJob`
and `stop`. Production scheduling, model-admission policy and timeout values are
unchanged.

From `packages/subagents`, run both engines through the hermetic launcher:

```sh
node ../../scripts/run-vitest.ts node test/config-model-fallback-spawn.test.ts test/injected-clock.test.ts test/schedule.test.ts --coverage.enabled=false --maxWorkers=1
node ../../scripts/run-vitest.ts bun test/config-model-fallback-spawn.test.ts test/injected-clock.test.ts test/schedule.test.ts --coverage.enabled=false --maxWorkers=1
```

The eviction/reopen cases in `test/config-model-fallback-provenance.test.ts`
also inject `FakeClock` through the real extension. A held runner establishes
completion readiness before either ordering is exercised: result read before
notice delivery, or notice delivery before result read. A fixture event bus
answers admission synchronously so clock advancement controls completion delivery
and GC, not a missing router's timeout. As in `evicted-agent-wiring.test.ts`
(#481), consume through `get_subagent_result` to stamp `consumedAt` and cancel the
held notice, then advance the existing TTL and sweep. Never hand-set consumption
or backdate `completedAt`: a delivered notice correctly starts retention from
`consumedAt` (#569). `afterEach` shuts down the extension even on assertion failure.

Run the related extension fixtures with one worker:

```sh
node ../../scripts/run-vitest.ts node test/config-model-fallback-provenance.test.ts test/evicted-agent-wiring.test.ts --coverage.enabled=false --maxWorkers=1
node ../../scripts/run-vitest.ts bun test/config-model-fallback-provenance.test.ts test/evicted-agent-wiring.test.ts --coverage.enabled=false --maxWorkers=1
```

`test/branch-coverage-schedule.test.ts` holds admission replies while it disables a
job or stops and restarts the scheduler. A stale reply must neither dispatch nor
re-arm the job, and cancellation removes both the reply listener and the injected
admission timeout. Repeated starts must cancel the old owned timer. The registered
session-switch fixture exercises the same cleanup through the extension, while
already dispatched agents may still finish and record their outcome. These tests
do not prove the cause of a guest-wide WSL2 stall.

The package gate is `npm run check --workspace @nredd/pi-subagents` from the
repository root. Focused tests are not a substitute for that gate or root CI.

The stale-context regressions in `test/stale-ctx-captured.test.ts` (#779) dispose
a real core session whose context a virtual route captured. They cover failure
before the first response, after a completed tool, and a second fresh launch
against the same shared route. They assert a single terminal error and no retry
prompt, with the error and completed activity retained in the persisted transcript.
There is no stale-context backoff timer: without a successor-context contract,
re-prompting the same runtime cannot repair the captured context.
