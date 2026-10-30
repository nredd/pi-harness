# Scheduler fixture clocks

For contributors testing scheduled model selection.

`test/config-model-fallback-spawn.test.ts` uses the existing `FakeClock` through
`SubagentScheduler({ clock })`. Construct ISO deadlines from `clock.now()` and
advance that same clock to invoke the public timer path. Drain the mocked
runner's promise chain with `setImmediate`, not a wall-time polling deadline.
The runner stand-in still calls the real model selector; this does not replace
real-runner coverage in `config-model-fallback-real-runner.test.ts`.

The former fixture computed `Date.now() + 50`, then called `addJob`. If wall time
advanced 50ms before `buildJob` validated the schedule, `detectSchedule` correctly
rejected it as past before model selection ran. The regression advances wall
time by 51ms at the public `addJob` boundary, without sleeping or adding load.
It must still reach the public model-not-found error event, not merely any error
status. The 50ms fixture deadline is unchanged and advances only under test control.

The same fixture checks no execution before its deadline, one-shot completion,
a valid explicit model, and cancellation through public `removeJob` and `stop`.
Production scheduling, model-admission policy and timeout values are unchanged.

From `packages/subagents`, run both engines through the hermetic launcher:

```sh
node ../../scripts/run-vitest.ts node test/config-model-fallback-spawn.test.ts test/injected-clock.test.ts test/schedule.test.ts --coverage.enabled=false --maxWorkers=1
node ../../scripts/run-vitest.ts bun test/config-model-fallback-spawn.test.ts test/injected-clock.test.ts test/schedule.test.ts --coverage.enabled=false --maxWorkers=1
```

The package gate is `npm run check --workspace @nredd/pi-subagents` from the
repository root. Focused tests are not a substitute for that gate or root CI.
