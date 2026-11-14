# Workflow verification boundaries

For contributors investigating workflow dispatch and reporting, not evidence that every
installed runtime path works. Related: [#811](https://github.com/nredd/pi-harness/issues/811).

## Proven reporting defect

`workflowProgress` is an append-only event log. `stats()` previously counted its events,
while the card's phase groups and task counters collapsed by agent index. Fifteen queued
entries plus three startup/configuration updates for eight children therefore reported
`0/39 agents`, although only fifteen calls were scheduled. A completed fifteen-child
synthetic run reported `15/75 agents`. `stats()` now uses the same `collapse()` as the
other consumers, including when a retry replaces a terminal state.

This is a reporting fix, not a dispatch retry or provider workaround. Successful child
completions are the numerator. The workflow host only returns token/tool totals at child
settlement. A stopped run can therefore report zero usage despite child activity. A missing
journal also says only that no call has been journaled yet. Neither signal proves a hang.
The workflow inspector owns its children; ordinary fleet lists intentionally omit them.

## Automated surfaces

| Surface | Entry and assertions | Boundary not established |
| --- | --- | --- |
| Primary Node suite | `packages/subagents/vitest.config.ts`, included by package `check`: runtime, task, journal, host, tool and real-manager faux E2E suites; Istanbul source counters | Installed CLI, actual providers, arbitrary runtime schedules |
| Full Bun suite | `scripts/run-vitest.ts bun`, called by package `check`, uses the same test discovery and separate `coverage/bun` Istanbul reports | Compiled standalone Bun executable is not the Bun Vitest interpreter |
| Nested background E2E | `test/e2e/workflow.e2e.test.ts`, `retains background ownership`: real SDK parent -> real codemode QuickJS bridge (or direct tool) -> workflow worker/VM -> real manager -> faux child -> actual `read` result | Paid providers, restart/reload, saturated process-wide budget and unrelated manager pools are not this fixture |
| Nested completion | Fifteen object-valued inputs, explicit synthetic model resolution, parent turn returns before held children finish; all fifteen prompts/results and unique journal indices, exact terminal denominator | Launch acknowledgement alone is not accepted as execution evidence |
| Nested cancellation | Seventeen inputs exceed every possible workflow semaphore cap; started children first complete real reads; parent stops the workflow, queued children never execute, exactly one matching terminal notification is consumed | Cancellation after process restart and real transport cancellation latency |
| Runtime bundle freshness | `dist/` is not committed (#866); `runtime-scripts.test.ts` proves two builds of one tree are byte-identical | Byte freshness is not execution of the nested scenario through packed bytes |
| Packed stock contract | `scripts/package_contracts.py`, `scenario_subagents`: installs the package, checks tool exposure and executes a faux foreground `Agent` | Does not execute `SubagentWorkflow` through codemode |
| Assembled stack | `integration/inprocess/reviewer.test.ts` and `annotated-tools.test.ts` include workflow exposure/annotation checks | Those checks do not execute a workflow |
| Live smoke | Opt-in cases in `workflow.e2e.test.ts`, gated by `PI_E2E_LIVE` | Not part of credential-free acceptance; do not run merely to diagnose reporting |

CI's owned TypeScript shards invoke workspace `check`, including Node and Bun producers.
Package contracts and assembled stack checks are separate jobs; a green required check can
be a documented changed-path skip. Inspect `scripts/ci_paths.py`'s exact plan and retained
job output before claiming execution. Coverage accounting consumes independent producer
reports and fails closed on missing required signals; counters are not a runtime-path proof.

## Reproduction and mutation control

From `packages/subagents`, with a disposable home and credential-free environment:

```sh
env -i PATH="$PATH" HOME="$sandbox" PI_OFFLINE=1 PI_NO_LOCAL_LLM=1 JITI_FS_CACHE=false \
  ../../node_modules/.bin/vitest run test/e2e/workflow.e2e.test.ts \
  -t 'retains background ownership' --coverage.enabled=false
```

Set `sandbox` to a newly created empty directory, then remove it after the command. This
focused command does not replace package `check` or overwrite the primary coverage report.
The regression also has a pure fifteen-index/thirty-nine-event assertion in
`test/workflow-progress.test.ts`. Restoring the raw-event iteration in `stats()` makes that
assertion fail with `total: 39, started: 24` instead of `total: 15, started: 8`, and makes
all four real direct/nested completion/cancellation cases fail their terminal denominator.

Remaining runtime-path gaps are explicit, not inferred passes: the same nested scenario
through packed/installed and standalone bytes; independent pool and global-budget
saturation; restart/reload/cancellation ownership across activations; routed model admission
rather than explicit faux model selection. Lifecycle unit or faux E2E tests elsewhere can
cover components of those paths without proving their composition. These are verification
boundaries, not evidence of a dispatch failure or part of the scoped #811 counter fix.
