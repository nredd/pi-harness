# Test worker budgets and issue 105

Audit base: `17236539759ccc8858e605ed3f07531cacf2d9e0` (2026-10-29).
Tracking: [#105](https://github.com/nredd/pi-harness/issues/105).

## Remaining configuration defect

At the audit base, `subagents`, `plan-mode`, `subscription-router` and
`resource-sampler` have no `test.maxWorkers`. Vitest therefore chooses its worker
count from the host CPU count. The sampler's npm scripts pass `--maxWorkers=1`,
but direct Vitest invocation does not inherit that CLI argument. The other five
Vitest configs already cap their own workers at two.

All nine configs now carry bounded defaults: one worker for the sampler, two for
the others. `integration/inprocess/verification/worker-bounds.test.ts` imports the
actual configs and rejects missing or changed budgets. Before the fix it fails
four cases (`undefined` instead of the expected cap), with five passing. This is a
deterministic configuration regression, NOT reproduction of every historical
wall-clock timeout. Neither timeouts nor coverage budgets change.

These defaults apply to Node and Bun **Vitest**. Explicit CLI overrides still win.
Native `bun test` subsets do not consume Vitest configs; this change does not
claim to bound their children or concurrency. `npm run check --workspaces` runs
workspace checks sequentially, but separate gates and `make -j` can still overlap.
Two Vitest workers per workspace run is not a host-wide budget. Parent orchestration must bound
concurrent whole gates separately; do not dispatch eight gates and treat a
random timeout as proof of a package defect. There is no adaptive load-based
scheduler, global lock, synthetic CPU load or timeout multiplier here.

The cargo fixture has two tiny crates and two unit tests in its valid crate;
Cargo/nextest retain their native job defaults. Vitest's cap does not cap compiler
subprocesses. Do not change the production cargo tool's scheduling semantics to
solve test orchestration. If compiler overlap recurs with bounded gates, measure
that fixture and inject a fixture-local job budget rather than changing user tool
behavior. Session-kit's stats exporter is already built once before its Vitest
suite (`test` -> `build:stats-export`); its dedicated snapshot build assertion is
intentional artifact verification, not a build-per-render loop.

## Historical reports versus current source

| Report in #105 | Evidence at the audit base | Disposition |
| --- | --- | --- |
| `subagents/test/documented-defaults.test.ts`, 5 seconds | The two heavy `agent-runner` reimports already have `HEAVY_REIMPORT_MS = 60_000` in imported commit `42dbdc96`; other fresh imports remain. | The original two assertions no longer have the reported 5-second budget. This is existing timeout accommodation, not a newly proved race fix. No further inflation. The missing worker cap is fixed here. |
| session-kit `stats/component`, 20 seconds | `test/stats/component.test.ts` still contains a synchronous width/height/tab/input rendering matrix. `vitest.config.ts` already has two fork workers and a 20-second timeout, present in `ace0efae`. | Renderer work still consumes real CPU. A pass in isolation does not prove the full-run symptom fixed. No renderer redesign without a sharper loop. |
| session-kit `monitor/pidfiles`, 20 seconds | `test/monitor/pidfiles.test.ts` still exercises real process groups. Its helpers poll at 25 ms with a 5-second bound. `d8dac7fd` (#217) changes the separate disposal test to observe reaping; `1b073d3a` fixes the pidfile whole-second identity boundary. | Those are specific merged fixes, not evidence that every pidfile wait tolerates arbitrary host starvation. Keep readiness and reaping assertions; do not substitute fixed sleeps. |
| dev-tools cargo, worktree hook, option-shaped rejection | `vitest.config.ts` already has two fork workers and a 20-second timeout since `ace0efae`. Cargo tests still execute real builds; individual compiler cases have explicit longer budgets. `b2568826` (#155) fixes external-target JUnit paths, not scheduling. The option rejection assertion does not compile a crate. | Do not label an interrupted rejection test a compiler defect. No new compiler cache, timeout or runtime change is justified by that report alone. |
| inprocess `process`, `worktree` | Neither named file exists under `integration/inprocess` at this SHA. Real process/worktree coverage exists in `packages/dev-tools/test/core/process.test.ts`, `packages/dev-tools/test/git/worktree.test.ts` and subagent native fixtures. `acf50e93` (#165) synchronizes the separate cancellation probe before signaling. | A missing old path is not proof of semantic replacement or a fixed timeout. Need the original failure name/receipt to map it exactly. #87's probe deadline is a separate scope. |
| manager reload compilation | `packages/subagents/test/process-budget.test.ts` used to transpile all 75 sources and cold-boot the real SDK in a child, synchronously, under the 5-second test deadline. Vitest reported a timeout after every assertion had passed, 6.5 to 14 seconds under a synthetic 30-spinner load on a 10-core Mac, measured on `2f9160af`. It now bundles only the manager's import closure once with Vite, writes two ESM identities and stubs the host SDK the scenario never calls (#303). | Fixed at the cost, not the deadline: 0.5 to 1 second under the same load, same base plus this change. No timeout changed. |

The source-home fixture work in #232/#242, fixture ordering in #211/#236 and
model-scope work in #240 are independent. This audit neither duplicates them nor
uses their pending results as evidence.

## Measured cold budgets (#312)

Three cases are CPU-bound cold loads with no wait to make event-driven: a real
Pi SDK import in a child, or Pi's jiti loader Babel-transforming TypeScript with
no fs cache (`JITI_FS_CACHE=false`, #354). Owner decision on #312, 2026-11-03:
each gets an explicit per-test budget derived from measured cold timings and
cited next to it, as #353 did for its Swift cold-cache cases. No global
`testTimeout`, retry or skipped assertion changes.

Margin rule, one per shape:
- A cold load inside the test (jiti in-process): twice the worst local gate
  figure, the ratio #353 applied to its hosted cold figures
- A test bounded by its own child (`spawnSync` with a timeout): the child's bound
  plus a margin for the measured non-spawn part, so the child's own failure
  reports before Vitest's timer

Hosted figures are the slowest across the `owned` macOS/Ubuntu/WSL2 jobs of the
19 completed `ci.yml` runs from 41735166876 to 41769460797 (2026-11-03). Gate
figures come from local 3-slot gate logs in `pi-harness-builds/resume-20261029`.

| Case | Alone | Hosted max (job) | Gate max | Budget |
| --- | --- | --- | --- | --- |
| `subagents/test/resource-loader-home.test.ts`, each child case | child 0.4-1.4 s, rest at most 11.5 ms | 2.28 s (126298828972) | 7.51 s (`issue173-gate2.log`) | 11 s: the child's 10 s plus 1 s |
| `subagents/test/preloaded-skill-e2e.test.ts`, cold case | 1.3-1.7 s | 4.94 s passing (126376146266) | 9.69 s (`gate-321-r2.log`) | 20 s |
| `subagents/test/preloaded-skill-e2e.test.ts`, warm case | 0.9-1.0 s | 3.25 s (126369170298) | 5.82 s (`gate-321-r2.log`) | 20 s, same load |
| `plan-mode/test/build-runtime.test.ts`, Jiti resource loader | 0.37-0.46 s | 1.36 s (126369170298) | 6.27 s (`issue158-gate7.log`) | 13 s |

The `preloaded-skill-e2e` cold case hit the 5 s default on hosted `owned (wsl2)`
three times: jobs 126342175715 (5064 ms), 126369170298 (5120 ms) and
126389841734 (5007 ms, #362). It was at most 2.44 s hosted before #354 (job
126264703240) and 2.3-5.1 s after: with the fs cache off every load
re-transforms the extension's ~74 sources. A cheaper loader path stays open.

`plan-mode` caps every test at 5 s in `test/harness/test-timeout-policy.ts`.
The Jiti case passes it only through `measuredTestBudgetsMs`, by exact name
(`jitiRuntimeLoadTestName`) and up to its own budget;
`test/test-timeout-policy.test.ts` pins that no other test inherits it.

RED under 50 self-terminating spinners (load ~90-100, Apple M4, 10 cores):
`resource-loader-home` timed out 4 of 13 cases at 5019-5296 ms, the
`preloaded-skill-e2e` cases ran 12823 ms and 9814 ms against 5 s. GREEN under
the same load peaked at 18172 ms, 9560 ms and 4204 ms (Jiti). The budgets do
not claim to bound arbitrary host starvation.

## Measured macOS Swift budget (#457)

`computer-use/test/macos-native-pure.test.mjs` compiles the PURE region of
`native/macos/bridge.swift` with `swiftc -O` and runs it, inside the test. It hit
the 20 s suite default at 21644 ms on hosted `owned shard (macos-14, ts)` job
126769877232 (run 41885722658, #433). The whole runner was slow:
`platform-linux.test.mjs` took 16183 ms there against a 4646 ms green p50.

Hosted figures are this test's Vitest durations across the 72 completed
`owned shard (macos-14, ts)` jobs on `GitHub Actions` runners (every attempt) of
the `ci.yml` runs from 41781117332 to 41960624589 (2026-11-04 to 2026-11-05).
Self-hosted `pi-macos` jobs are excluded.

| Case | Alone | Hosted green (n=67) | Hosted max (job) | Budget |
| --- | --- | --- | --- | --- |
| `macOS native pure ref store and input helpers` | 2.1 s (Apple M4) | p50 6472 ms, p95 8995 ms, p99 9844 ms, green max 9844 ms | 21644 ms, timed out (126769877232) | 45 s |

Same margin rule as the cold loads above: twice the worst hosted figure. Green
p99 times the observed ~3.5x runner slowdown is ~34 s, inside it. The compile
stays in the test; no retry, skip or `testTimeout` change.

Under 50 self-terminating local spinners (load 90-174 on a shared Apple M4) five
runs took 13.7-27.0 s, two of them past 20 s. That is not a deterministic RED;
the hosted job is the failing receipt.

## Settings watch tests (#636)

No plan-mode unit test depends on real `fs.watch` delivery. Settings-watch tests
inject `watchSettingsDirectory` or mock `node:fs` `watch`
(`settings-watch-lifecycle.test.ts`) and publish the change themselves, so none
races FSEvents. Native stream start measured 0.1-12.1 s on a degraded macOS host
(diagnosis on #636), far past the 5 s cap. A real-watch smoke test needs a
measured budget entry, an owner decision under #312, so it is not included.

## Measured real-git submodule budget (#651)

`packages/subagents/test/worktree.test.ts`, describe "cleanupWorktree -- nested
repositories git refuses to remove", hit the 5 s default on the self-hosted macOS
runners `pi-macos-ci-7e30c3` and `pi-macos-ci2-ad5a35` (run 42756218410, jobs
129631524032 and 129643652803): 8315 ms ("fetched by sha"), 5765-8571 ms
("lacks the object", across the two jobs) and 6372 ms ("pinned to a sha-fetched
commit").

Alone on an Apple M4 the 21 cases take 0.25-1.2 s each (worst: "does not count
another submodule's sha...", 1.1-1.2 s). The time is dozens of synchronous `git`
child spawns per case (init, clone, `submodule add`/`update`/`deinit`, fetch,
worktree remove), about 7x slower on those self-hosted runners. Little is
avoidable: each case mutates its own repos, so a shared `beforeAll` fixture would
couple them, and `protocol.file.allow` is needed for the local submodule URLs.
Only the unused `subDir` in one case (about 5 spawns) could go, which is not worth
touching the shared hooks.

The describe takes `NESTED_REPO_TEST_TIMEOUT_MS` (20 s): about twice the worst
self-hosted figure (8571 ms, 2x is 17.1 s) rounded up, the margin rule of the cold
loads above. No global `testTimeout`, retry
or skip.

## Remaining external acceptance criterion

Keep #105 open after the worker-cap PR. The historical report does not retain
per-run failing assertions/stages, runner receipts or an original CI job URL.
To close its wall-clock component, retain an exact-HEAD full owned-gate receipt
from the existing hosted Node/Bun checks on macOS and Linux with the configured
worker budgets. Record parent concurrency separately for any local reproduction. For any recurring failure,
record the assertion, engine, test file, timeout stage (import, hook, body or
teardown), child readiness/exit evidence and parent dispatch overlap. Then build
a deterministic delay/clock/readiness loop at that actual seam before changing it.

Green hosted receipts validate the bounded gate, not an unlimited host-starvation
promise. If no historical receipt can map the deleted inprocess file names to
current assertions, explicitly scope those old reports as unverified instead of
claiming source migration proved a fix. Two isolated passes are not closure proof.
Local whole gates and scenarios were deliberately not run for this audit while
the parent had a full gate running; focused configuration tests are not a full
gate receipt.

## macOS `check-ts` shard split (#660)

`owned shard (macos-14, ts)` ran every workspace's `check-ts` in one 30 min job. Hosted
runs took 15-28 min (`Owned gate check-ts` 877-1607 s) and c0dae1b6 (#649) was cancelled at the
budget. Per-workspace wall time is the gap between consecutive `> <pkg> check` lines in the job log
(each includes lint, typecheck, Vitest on Node and Bun, docs and build checks):

| Workspace | Run 42799667706 (`a9b89d81`) | Run 42777395371 (`5e15aac6`) |
| --- | --- | --- |
| `packages/subagents` | 603 s | 666 s |
| `packages/computer-use` | 286 s | 356 s |
| `packages/dev-tools` | 116 s | 150 s |
| `packages/plan-mode` | 61 s | 92 s |
| `packages/session-kit` | 58 s | 76 s |
| `packages/todo` + `integration/inprocess` | about 126 s | not split out |
| `packages/subscription-router` | 17 s | 23 s |
| `packages/preset` | 14 s | 20 s |
| `packages/resource-sampler` | 10 s | 12 s |

Hosted job totals were 1373 s and 1666 s. `packages/subagents` and
`packages/computer-use` are 61-65% of the `check-ts` step, so macOS takes the same `subagents`, `computer-use`,
`ts` split as Ubuntu; the remainder is about 400 s of gate time. Self-hosted `pi-macos` runners are
slower still, which is the headroom the split buys. Re-measure from `Duration` and `> <pkg> check`
lines after a split lands and update `CELL_SECONDS` in `scripts/runner_pools.py`.
