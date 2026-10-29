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
| manager reload compilation | `packages/subagents/test/process-budget.test.ts` compiles each source once and writes two ESM identities, with a compiler-call-count assertion (`852ff74d`, retained in `404b3cce` / #196). | The compile-once seam is already merged. Do not duplicate it or infer that unrelated reload timing is fixed. |

The source-home fixture work in #232/#242, fixture ordering in #211/#236 and
model-scope work in #240 are independent. This audit neither duplicates them nor
uses their pending results as evidence.

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
