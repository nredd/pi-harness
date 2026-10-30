# Scheduler fixture clocks

For contributors testing scheduled model selection.

`test/config-model-fallback-spawn.test.ts` uses the existing `FakeClock` through
`SubagentScheduler({ clock })`. Construct ISO deadlines from `clock.now()` and
advance that same clock to invoke the public timer path. Drain the mocked
runner's promise chain with `setImmediate`, not a wall-time polling deadline.
The scheduler still calls the real model selector before passing its resolved
selection to the runner stand-in; this does not replace real-runner coverage in
`config-model-fallback-real-runner.test.ts`.

The former fixture computed `Date.now() + 50`, then called `addJob`. If wall time
advanced 50ms first, `detectSchedule` rejected the schedule as past before model
selection ran. The scheduler now reads only the injected `FakeClock`, so the 50ms
deadline advances solely under test control and the fixture reaches the public
model-not-found path regardless of host load.

The controlled-time regression is the first pair of tests in that file. One builds
a 50ms ISO deadline, advances the `FakeClock` 51ms, and asserts `addJob` throws
`Scheduled time ... is in the past` before any model selection or timer is
created. The other advances the clock, then asserts the job's `createdAt` equals
the `FakeClock` time. Pointing `addJob` back at `Date.now()` fails `createdAt`
and every fire-path test (the fake epoch is 2020, so the deadline is long past on
the wall clock); dropping the past-timestamp check fails the first test.

The fire-path fixture additionally checks no execution before its deadline,
one-shot completion, a valid explicit model, and cancellation through public
`removeJob` and `stop`. Production scheduling, model-admission policy and timeout
values are unchanged.

From `packages/subagents`, run both engines through the hermetic launcher:

```sh
node ../../scripts/run-vitest.ts node test/config-model-fallback-spawn.test.ts test/injected-clock.test.ts test/schedule.test.ts --coverage.enabled=false --maxWorkers=1
node ../../scripts/run-vitest.ts bun test/config-model-fallback-spawn.test.ts test/injected-clock.test.ts test/schedule.test.ts --coverage.enabled=false --maxWorkers=1
```

The package gate is `npm run check --workspace @nredd/pi-subagents` from the
repository root. Focused tests are not a substitute for that gate or root CI.
