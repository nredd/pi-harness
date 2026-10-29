# Subagents index coverage

PR #198 includes four new `test/index-coverage*.test.ts` files: 39 agent-menu,
46 settings, 13 generation/viewer and 3 retained-lifecycle cases, **101 total**.
The combined scope includes the original `afd32e60` checkpoint, lifecycle commit
`c49b6429` and assertion corrections through `a04a6cd1`. The lifecycle tests are
already part of #198, not isolated work pending integration from #201.
Production, shared harness, configuration, dependencies and policy are unchanged
against base `b51e1774`. Independent #193 coverage is not included.

## Reproduce

From a checkout with its pinned Node and committed dependencies installed:

```sh
npm ci --ignore-scripts
cd packages/subagents
../../node_modules/.bin/vitest run test/index-coverage-agents.test.ts \
  test/index-coverage-settings.test.ts test/index-coverage-generate.test.ts \
  test/index-coverage-final-lifecycle.test.ts --maxWorkers=1
npm exec --yes --package=bun@1.3.14 -- node ../../scripts/run-vitest.ts bun \
  test/index-coverage-agents.test.ts test/index-coverage-settings.test.ts \
  test/index-coverage-generate.test.ts test/index-coverage-final-lifecycle.test.ts --maxWorkers=1
npm run lint
npm run typecheck
../../node_modules/.bin/vitest run --maxWorkers=1
npm exec --yes --package=bun@1.3.14 -- node ../../scripts/run-vitest.ts bun --maxWorkers=1
# Coverage requires the Istanbul provider resolvable from the Vitest installation:
../../node_modules/.bin/vitest run --maxWorkers=1 --coverage \
  --coverage.provider=istanbul --coverage.reporter=lcov --coverage.reporter=text \
  --coverage.reportOnFailure
```

Inspect resources before full suites; use one worker under concurrent load.
The unchanged Istanbul inventory is `src/**/*.ts`, with no exclusions or
counter/denominator edits. `reportOnFailure` retains failed-suite measurements.

## Measured scope

| Existing Node/Istanbul checkpoint | Index covered lines | Index covered functions | Missing lines/functions |
| --- | ---: | ---: | ---: |
| Main baseline | 1085/1437 | 218/251 | 352/33 |
| Original 98 cases at `afd32e60` | 1399/1437 | 243/251 | 38/8 |
| `c49b6429` adds 3 lifecycle cases, combined 101 | 1402/1437 | 246/251 | 35/5 |

These are existing measurements, not a fresh Istanbul result at the documentation
correction. The combined remaining checkpoint is **35 lines and 5 functions**, not
38/8. See [the lifecycle note](subagents-index-final-coverage.md) for its behaviors
and named mutation failures.

Agent cases drive registered `/agents`, actual SettingsList callbacks and private
Markdown files: edit/reload, confirmation, disable/enable, read-only package menus,
ejection races, manual tool/model/thinking choices, overwrite and cancellation.
Reset creates an override while the picker is open, the real external-editor race
that retains the default entry and offers Reset to default.

Settings persist every row, round-trip booleans, retry/cancel numeric input,
replace package allowlists, reject unknown fallbacks and encounter a real write
failure. Fallback navigation uses named rows and asserts the selected description.

Generation uses scripted child providers with the real write tool, manager,
runner and disk. Viewer assertions cover stop, foreground handoff, Markdown
persistence/failure, the steered transcript and actual redirected result. Required
viewer input/disposal methods are asserted present and called directly. Fleet
rebinding checks duplicate listeners; shutdown empties listeners and injected
clock timers. **Both generation/viewer and final-lifecycle emitters auto-ack
`router:rpc:admit`.** These are stubbed admission boundaries, not production
router admission validation. UI, parent context and clock are controlled fixtures.

## Gate and mutation limits

At combined code HEAD `a04a6cd1`, Node 26.12.0 and Bun 1.3.14 / Vitest 5.0.3 each
pass all four files and 101 cases. Biome checks 254 files clean; `tsc --noEmit`
exits 0. Full Node: 160 files pass, 3550 cases pass, 8 skipped. Full Bun: 159
files pass/1 fails, 3550 cases pass/1 fails/7 skipped. Its failure is the existing
`workflow-runtime.test.ts` authored-stack-line assertion,
[#174](https://github.com/nredd/pi-harness/issues/174).

Earlier full receipts reported two additional `process-budget.test.ts` failures
from a TypeScript mock missing `ModuleKind`. Those did not reproduce with this
fresh committed-lockfile installation; they are historical evidence, not current
failures. The skip difference is the runtime-selected `bunIt` ambient-home probe
in `resource-loader-home.test.ts`. The coverage attempt at `a04a6cd1` stopped
before tests: root Vitest could not resolve `@vitest/coverage-istanbul`. No new
coverage measurement or full green gate is claimed. No root-wide `make check`,
release or live activation was run; the existing Vite loader warning stays visible.

Durable mutation receipts:

- [Original 14 and additional 17 assertion-red mutants, plus 1 survivor](https://github.com/nredd/pi-harness/pull/198#issuecomment-6473821322).
  These cover file writes/ejection/reset, manual tools, model/numeric settings,
  generation warnings, viewer routing/persistence, cancellation, fallback and
  listener/method assertions. Each receipt identifies the owning selector and
  failure, not just a nonzero command exit.
- [Four lifecycle mutant outcomes and combined-head gates](https://github.com/nredd/pi-harness/pull/198#issuecomment-6474084561).

This is limited evidence, **not complete assertion/mutation proof of 101 tests**.
Removing `widget.dispose()` survives the completed-child fleet case because no
live widget timer remains then. Not individually proven: each distinct settings
setter/broadcast, all manual options and cancellation continuations, package byte
preservation, the second steered-answer assertion and every normal-close timer
path. False-success cancellation mutants do not prove every prompt-sequence
assertion. Assertions improve localization without closing these limits.

## Remaining named themes

The combined measured 35L/5F remain in unchanged `src/index.ts`:

- Completion delivery: max-turn abort summary, grouped notification catch,
  held-notice spool failure and rejected `manager.waitForAll().then` callback.
- Session lifecycle: scheduler startup warning, canonical agent loading's
  non-startup-error rethrow and `session_tree` fleet/disclosure restoration.
- Dispatch/retrieval: empty/unreadable custom descriptions, inactive/error
  scheduling returns, missing/failed resume and legacy `record.startGate` polling.
- Workflows: script persistence failure, headless collision/CLI warnings,
  metadata-extraction failure, `workflowMenuDeps.getCtx` and fleet workflow opener.
- Menus/settings: resolved-model label suffix, schedules navigation, empty-agent
  guards, absent viewer session/config and already-enabled/disabled settings.

The five uncovered functions are the rejected-wait no-op, `session_tree` handler,
legacy queued polling executor, `workflowMenuDeps.getCtx` and fleet workflow opener.
Some are retained safety paths: current queued records have start gates and normal
SettingsList callbacks carry the next value. Status remains partial, not 100%;
no provider inconsistency or manufactured closure is claimed.
