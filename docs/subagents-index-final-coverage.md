# Remaining index callback coverage

Stack base: `afd32e60` (#198). This branch does not edit #198's worktree, its tests
or its coverage document. Independent #193 inspector/viewer/meta coverage is not
included; a combined report must be measured after integration, never summed.
No production/config/provider/dependency changes, exclusions or source deletions.

The baseline source is unchanged and its existing Istanbul inventory remains
`src/**/*.ts`, 1437 lines and 251 functions for `src/index.ts`.

| Checkpoint | Index lines | Index functions | Missing lines/functions |
| --- | ---: | ---: | ---: |
| Stack base #198 | 1399/1437 | 243/251 | 38/8 |
| Grouped reload + orphan viewer lifecycle | 1402/1437 | 246/251 | 35/5 |

The first three tests use the registered lifecycle, actual manager/runner/child
sessions, a scripted provider boundary, private parent session file, and actual
fleet/viewer input. No closure invocation, manager mock or counter hook:

- Complete two members of a real parent turn's group, hold the notice, reload,
  and deliver both original results and identities exactly once at the next
  boundary. The old activation never sends into a stale parent context.
- Detach a still-running child on reload; open it from a fresh activation's
  fleet; steer through the actual viewer composer. Assert the new instruction
  in the original child's transcript and its redirected result.
- Stop the detached survivor from that viewer, assert stopped state and toast,
  then verify the running-detached roster and settled manager records are
  released. Neither old nor replacement context receives that old run's notice.

Independent mutation receipts (all restored before the next run):

- Suppress detached notice delivery: exit 1, grouped restoration assertion fails.
- Target the survivor abort at an unknown id: exit 1, stop notification fails.
- Target survivor steering at an unknown id: exit 1, redirected result fails.
- Suppress settled detached-manager disposal: exit 1, retained-record assertion
  fails for both survivor cases.

Each runs `vitest run test/index-coverage-final-lifecycle.test.ts --maxWorkers=1`.
Raw mutation output: `/tmp/index-final-lifecycle-mutations.log`. Restored focused
run: 3 pass. Source diff versus stack base is empty.

First-theme commands from `packages/subagents`:

```sh
../../node_modules/.bin/vitest run --maxWorkers=1 --coverage \
  --coverage.provider=istanbul --coverage.reporter=lcov --coverage.reporter=text \
  --coverage.reportOnFailure --coverage.reportsDirectory=/tmp/subagents-index-final-lifecycle
npm run lint
npm run typecheck
```

Actual full-suite receipt:

```text
Test Files  1 failed | 159 passed (160)
Tests       2 failed | 3548 passed | 8 skipped (3558)
```

Both failures are the unchanged baseline `process-budget.test.ts` TypeScript
mock's missing `ModuleKind`, separately owned by the lifecycle agent. This branch
does not incorporate their `5e8a741b` repair. Package lint and typecheck pass.
Logs: `/tmp/subagents-index-final-lifecycle{,-lint,-types}.log`; LCOV:
`/tmp/subagents-index-final-lifecycle/lcov.info`. Resources were sampled before
the full run; multiple independent agents and #198's exact-HEAD reviews remain
active. All local full runs use one worker, not nested test fanout.

Work remains open. No completed gate, 100% claim or provider inconsistency claim.
