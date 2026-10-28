# Plan-mode coverage attribution

This page preserves the #199 diagnosis and its historical counts. The subsequent
[final-guard ledger](final-guards.md) traces all 12 remaining lines at #199 HEAD,
covers three reachable lines and the queued predicate function, and documents the
removal of four proven-dead uncovered lines. Its final count is **942/947 lines,
154/154 functions**, with five defensive lines still open. No provider or inventory
change is involved; the reduced denominator is itemized in that ledger.

Diagnosis against PR #187, base `e564bd5961f27f6d27e76dcefeb163f91a99e002`.
Worktree: `~/code/cov-pm-attribution`, branch `redd/cov-pm-attribution`.

## Finding

The alleged Istanbul failure at `src/plan-mode.ts:1938-1949` is a genuine test gap.
The existing `restoring Plan mode without helpers` test executes the **inner**
missing-helper catch at `1912-1920` and returns. It does not execute the **outer**
rollback catch at `1938-1949`. The old mutation failure proves the former, not the latter.

No exclusion, threshold, inventory, source, or generated artifact change is proposed.
Candidate A (source coverage plus artifact parity) is not justified by this reproduction.
The existing tests already import `../src/plan-mode.js`, resolved by Vitest to the TS
source. This is not a Jiti-loaded copy of the generated entry.

## Exact reproduction

The provider was already available through the package-local diagnostic symlink in
the original worktree. This branch uses that same `@vitest/coverage-istanbul` install
(`5.0.3`) with Vitest `5.0.3`, Node `v26.12.0`. In an independently installed checkout,
make the matching provider available using the coverage-platform dependency setup;
this change deliberately does not alter any dependency or lockfile.

From `packages/plan-mode`:

```sh
../../node_modules/.bin/vitest run test/plan-mode-coverage.test.ts \
  -t 'restoring Plan mode without helpers' --maxWorkers=1 \
  --coverage --coverage.provider=istanbul --coverage.reporter=json \
  --coverage.reporter=lcov --coverage.reportsDirectory=/tmp/pm-attribution-single \
  --coverage.include=src/plan-mode.ts
```

Observed: one test passed in 807ms; inner statements `988-995` hit once, outer
statements `1011-1020` hit zero times. An assertion that any outer statement hit
failed. This assertion's premise was wrong, not the provider's counters.

For inspectable instrumentation and raw pre-report counters, use the opt-in probe.
It extends the unchanged config with the same scope/provider and wraps the provider's
exact default instrumenter options to save its inputs and outputs. It does not replace
the normal config or affect enforcement. Use a fresh output directory for each run:

```sh
PLAN_MODE_ATTRIBUTION_DIR=/tmp/pm-attribution-before \
  ../../node_modules/.bin/vitest run test/plan-mode-coverage.test.ts \
  -t 'restoring Plan mode without helpers' --maxWorkers=1 \
  --config test/harness/coverage-attribution.config.ts
PLAN_MODE_ATTRIBUTION_DIR=/tmp/pm-attribution-after \
  ../../node_modules/.bin/vitest run test/plan-mode-attribution.test.ts \
  --maxWorkers=1 --config test/harness/coverage-attribution.config.ts
```

Each directory contains:

- `identity.json`: real package/provider paths, Node version, source/artifact/config SHA-256.
- `instrument-1.input.js`: actual TS-transformed JS entering Istanbul, not the distributed entry.
- `instrument-1.js`: executed instrumentation, with inline source coverage hash and counter increments.
- `instrument-1.json`: input/output maps and Istanbul function/statement maps.
- `instrument-2.*`: the provider's second, identity-map pass, not another evaluated module.
- `runtime-<pid>.json`: actual `globalThis.__VITEST_COVERAGE__` before report remapping.
- `coverage-final.json`, `lcov.info`: remapped report counters.

The provider intentionally calls `instrumentSync` twice in `onFileTransform`:
first to obtain the executable code, then to produce its identity transform map.
Counting those capture files as duplicate module evaluations would be incorrect.

## Identity and counter receipts

Before and after behavioral tests, byte identities are unchanged:

| Input | SHA-256 |
| --- | --- |
| `src/plan-mode.ts` | `cdf0df98dcf4d8eb1200fa94659c8d5a3d95665996cb4f0285c86c67b871dc4a` |
| `dist/index.ts` | `c299e254caba8735bfd0671293f2f5fcf9ba6c867a37f2f740c79508a0667923` |
| `vitest.config.ts` | `fb8c360bd16051a6f715d624aee8e1ba49bd9e6702e6df53ba0acaf7070967af` |

The input map's sole `sourcesContent` hashes to the exact source SHA above.
Raw coverage, remapped coverage, and the map each contain exactly one target identity:
`/Volumes/Scratch/code/cov-pm-attribution/packages/plan-mode/src/plan-mode.ts`.
`~/code` resolves through the Scratch volume; there is no second `/Users` coverage entry.
The emitted code and live runtime coverage both carry coverage hash
`46d2c88234c8672a47a42ff58cffb0228cf884ec`.
The generated `dist/index.ts` is not loaded by this focused reproduction.
Its independent generated-entry smoke test remains in the full suite.

Raw generated function `136` is `installRestoredState`, generated line `1521`,
remapped to source line `1889`. The source-map remapping changes its location,
not its identity or hit count: `1` before, `3` after the four final focused tests.
The lazy-import rejection callback (`2`, source `168`) and ready-menu exit callback
(`13`, source `230`) each hit once in the final focused run.

| Statement IDs | Source lines | Existing helper test | New rollback tests |
| --- | --- | ---: | ---: |
| `988`, `994` | `1912`, `1919` | `1`, `1` | `0`, `0` |
| `1011`, `1012` | `1938`, `1939` | `0`, `0` | `2`, `2` |
| `1013` | `1939` thinking restoration | `0` | `1` |
| `1014-1017` | `1941-1944` | all `0` | all `2` |
| `1018-1019` | `1945-1946` owner release/reset | all `0` | all `1` |
| `1020` | `1949` rethrow | `0` | `2` |

For every row, raw counters equal report counters. No executing/uncovered pseudo entry
is needed to explain the result. New behavior-only tests reach this same instrumentation
without changing its source, map, path, or loader.

## Behavioral and mutation receipts

The new file covers:

- A thinking-level failure during session restoration: preserve the exact error,
  restore inactive state, release new ownership, allow a subsequent clean activation.
- A policy-persistence failure during tree restoration: preserve prior active state,
  read policy, and existing ownership rather than retaining the failed candidate's
  explicit empty selection.
- A rejected lazy UI import: retry loading in the same extension instead of caching
  the rejection forever. Only the import boundary is mocked; the real source catch runs.
- Exiting a ready plan via its review-menu callback: clear the plan and permit a new workflow.

Temporary mutations were applied only in the new worktree and restored:

| Mutation | Test result |
| --- | --- |
| Throw immediately on entering outer rollback catch | Old missing-helper test still passes |
| Change inner missing-helper disabled state to enabled | Old test fails: ownership unavailable instead of inactive |
| Change outer rollback state restoration to enabled | New restoration test fails with the same gate distinction |
| Replace restored prior allowlist with an empty list | New tree test fails because `read` is blocked |
| Remove cached lazy-import rejection reset | New UI retry test fails on its second call |
| Bypass `exitPlanMode` in the ready-menu exit callback | New ready-plan test fails: persisted `enabled` remains `true` |

No source mutation is part of the proposed diff.

## Initial validation and remaining gaps

Resource snapshots preceded package validation and full coverage runs. The last snapshot
before the package gate showed 10 CPUs, 42.6% interval utilization, 2.3 GiB free and 56%
`memory_pressure` free. Actual agent enumeration is unavailable inside this child; the
orchestrator supplied that no other author was active in the original worktree. No agents
were spawned. All Vitest commands used `--maxWorkers=1` or `VITEST_MAX_WORKERS=1`.

Executed on 2026-10-28:

- `VITEST_MAX_WORKERS=1 npm run check`: passed. Dist build contract 8 tests; build;
  Biome 106 files; strict `tsc --noEmit`; Node Vitest 49 files / 553 tests;
  native Bun session suite 4 files / 8 tests / 255 assertions.
- `node ../../scripts/run-vitest.ts bun --maxWorkers=1`: passed, 49 files / 553 tests,
  11.67 seconds, Bun `1.4.4`. This is Vitest on Bun, separately from the native suite.
- Exact original Istanbul command plus JSON reporter: baseline 48 files / 549 tests,
  final 49 files / 553 tests, both passed. This scope measures only `src/plan-mode.ts`;
  it makes no claim about other files or the entire platform inventory.
- Rebuilding did not change tracked files, including `dist`. No runtime source diff remains.
- Full monorepo `make check`, hosted CI, and two-axis PR review: not run in this child.

| File | Baseline lines | Final lines | Baseline functions | Final functions |
| --- | ---: | ---: | ---: | ---: |
| `src/plan-mode.ts` | 908/952 | 919/952 | 150/155 | 152/155 |

The exact final report leaves 33 lines and 3 functions uncovered:

```text
Lines: 471,472,502,875,876,877,878,911,961,984,1137,1210,1211,1396,1397,
       1483,1511,1512,1517,1518,1609,1642,1650,1659,1728,1740,1743,1744,
       1747,1758,1763,1841,1885
Functions: 30 (anonymous_30) @501
           110 computePlanModePolicyToolNames @1608
           121 (anonymous_121) @1650
```

Baseline lines `471-472` were covered but are zero in the final run; these clear a pending
filesystem-watch debounce timer. Do not interpret net line gain as a deterministic count
of every newly exercised line. The focused outer-catch counter proof is deterministic and
unaffected by that full-suite watcher timing variation. Raw final statement/function and
line/branch totals are respectively `1012/1077`, `152/155`, `919/952`, `712/803`.

The remaining zero-hit entries are real source instrumentation, not duplicate artifact
pseudo entries. This investigation does not establish that all of them are reachable.
For example, the disabled-mode fallback at `1483 -> 1608` has only two callers:
`tool_call` returns before it when disabled, and `planModeStatusText` only invokes its
summary callback when enabled. Its reachability needs an explicit owner decision rather
than an exclusion, source deletion, or an artificial direct call to a private closure.
The filesystem error callback and queued-input predicate need separate behavioral work.
Other remaining lines are not claimed closed by this scoped diagnosis.

This is not a 100% result or approval for sub-100 enforcement. The causal premise for
A/B/C was false: existing source measurement is truthful for this block. The owner
subsequently authorized continuing behavioral coverage work without a measurement choice.

The diagnosis and four tests were published in signed commit `3038808`, stacked PR
[#199](https://github.com/nredd/pi-harness/pull/199) against `redd/cov-close-plan-mode-main`
(PR #187). No merge, rebase, force operation, release, or live activation was performed.

## Behavioral follow-up

The follow-up adds 14 tests across three files, without changing runtime source:

- `settings-watch-lifecycle.test.ts` installs an explicit watcher boundary before delivering
  events, then advances fake timers over the real debounce callbacks. A burst must cancel
  the old deadline, a watcher error must close the watch and cancel its pending timer, and
  shutdown must not close it twice. A positive control awaits the real filesystem read
  from the surviving deadline and verifies the new thinking setting. No native readiness
  timeout was enlarged. Existing
  native filesystem watcher tests remain unchanged and run in the full suite.
- `runtime-failure-attribution.test.ts` verifies six restored-runtime failure classes:
  lookup throws, missing model, negative authentication result, authentication throws,
  model application throws, and thinking application throws. Each checks its warning,
  effective thinking/model outcome, persisted consumption, and absence of a retry. It also
  verifies a failed tool registry does not admit unrecognized tools.
- `plan-mode-lifecycle-gaps.test.ts` verifies renewed decline permission, legacy completion
  rejection, manual thinking restoration, active-tool registry failure, new-activation
  rollback/ownership release, stale ready-menu containment, and failed Normal-contract
  publication preserving the active Plan state and ownership.

Three temporary mutations were killed and restored before the final gate:

| Mutation | Result |
| --- | --- |
| Remove watcher error cleanup | Watch lifecycle test fails: watch not closed |
| Bypass legacy completion decline gate | Legacy test fails: unauthorized plan replaces existing plan |
| Preserve the consumed runtime intent | All six runtime failure tests fail: pending intent remains |

Resource awareness before the final sequential gate: 10 CPUs, 47.5% sampled utilization,
1.6 GiB free, `memory_pressure` 64% free. The owner reported other coverage, policy, Bun,
and crash-diagnostic agents active; no process-to-agent inference was used. This worker
used one Vitest worker and did not edit any sibling worktree.

Executed locally on 2026-10-28:

- `VITEST_MAX_WORKERS=1 npm run check`: passed, dist contract 8 tests, build, Biome,
  strict types, Node Vitest 52 files / 567 tests, native Bun 8 tests / 255 assertions.
- `node ../../scripts/run-vitest.ts bun --maxWorkers=1`: passed, 52 files / 567 tests.
- Full Node Istanbul run, unchanged `src/plan-mode.ts` include: 52 files / 567 tests passed.
  JSON and LCOV are at `/tmp/pm-takeover-final2/{coverage-final.json,lcov.info}`.
  Logs: `/tmp/pm-final2-{check,bun,coverage}.log`. These local files are not durable PR assets.

| File | Initial diagnosis | Follow-up | Denominator |
| --- | ---: | ---: | ---: |
| `src/plan-mode.ts` lines | 919 | 940 | 952 |
| Functions | 152 | 153 | 155 |
| Statements | 1012 | 1033 | 1077 |
| Branches | 712 | 727 | 803 |

The exact follow-up report still has 12 uncovered lines and 2 functions:

```text
Lines: 1210,1211,1396,1397,1483,1511,1512,1517,1518,1609,1650,1659
Functions: computePlanModePolicyToolNames @1608; anonymous_121 @1650
```

This is still NOT 100%, and no denominator, provider, source inventory, exclusion,
threshold, or artifact architecture changed. The report includes every statement in the
measured source file, not selected executing fragments. No package-wide coverage claim
is made. Runtime source and distributed output remain unchanged.

Remaining investigation is explicit, not an exclusion recommendation:

- `1396-1397`: the only caller enters `showActivePlanMenu` under `ctx.hasUI`; its own
  no-UI fallback cannot run with a stable context capability.
- `1483/1609`: tool admission returns before consulting policy while disabled; status
  formatting invokes its policy summary only while enabled. The disabled fallback
  remains unexercised. Do not force a private closure call to raise its count.
- `1511-1512/1517-1518`: stale or inconsistent pending-policy guards remain unexercised.
  Workflow generation transitions synchronously reset the pending policy; further work
  must demonstrate a real lifecycle that leaves one of these guards reachable.
- `1650/1659`: queued-input predicate and cross-session queue partition need a supported
  lifecycle reproduction. Same-session queues normally coexist with the active application
  or pending admission, which short-circuit the predicate; session replacement clears queues.
- `1210-1211`: direct implement commands reject missing plans before entering
  `startImplementation`; menu callbacks are another caller and need further behavioral
  investigation. No synthetic private entry point or runtime-source change was added.

The full monorepo gate and hosted CI have not been run by this worker. Review evidence
belongs in a PR comment on the exact final HEAD, not in a committed self-approval.
