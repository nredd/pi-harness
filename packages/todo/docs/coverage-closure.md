# Measured todo coverage closure

Scope: tests for the measured line/function gaps after home injection (#171),
base `26144ab4`. No coverage policy, config, dependency, exclusion or HOME changes.
Node v26.12.0, Bun 1.4.4, Vitest 5.0.3 on local macOS arm64. Hosted CI and the
repo-pinned Bun 1.3.14 were not run locally. No merge, publication or activation.

Istanbul measures the real Vitest-imported graph here. V8/Jiti mixed-loader
attribution falsely reported 120 uncovered lines / 20 functions on the earlier
baseline; that is NOT the before measurement for these tests. The real-Pi
codemode replay tests remain in the full suite. Istanbul does not instrument
Jiti's separate execution; no claimed coverage depends on that test.

## Results

Same explicit 18-file inventory, branches report-only. Empty-runtime type files
are retained. Before: 390 tests, 950/965 lines, 217/222 functions. After: 408 tests,
964/964 lines, 221/221 functions. Remaining: **0 lines / 0 functions**.
Branches: 901/986 -> 917/985 (93.09%), not gated. Statements: 1185/1216 (97.45%),
not claimed as 100%. Istanbul text's uncovered column can list branch/statement
gaps despite complete executable lines; the counts below come from LCOV.

| File | Before lines | After lines | Before functions | After functions |
| --- | ---: | ---: | ---: | ---: |
| `config.ts` | 32/32 | 32/32 | 8/8 | 8/8 |
| `index.ts` | 95/100 | 99/99 | 19/20 | 19/19 |
| `plan-hooks.ts` | 72/73 | 73/73 | 17/17 | 17/17 |
| `todo-overlay.ts` | 104/104 | 104/104 | 22/22 | 22/22 |
| `todo.ts` | 59/59 | 59/59 | 10/10 | 10/10 |
| `state/i18n-bridge.ts` | 34/35 | 35/35 | 5/6 | 6/6 |
| `state/invariants.ts` | 3/3 | 3/3 | 1/1 | 1/1 |
| `state/plan.ts` | 155/155 | 155/155 | 41/41 | 41/41 |
| `state/replay.ts` | 45/45 | 45/45 | 11/11 | 11/11 |
| `state/selectors.ts` | 13/13 | 13/13 | 14/14 | 14/14 |
| `state/state-reducer.ts` | 149/150 | 150/150 | 26/26 | 26/26 |
| `state/state.ts` | 1/1 | 1/1 | 0/0 | 0/0 |
| `state/store.ts` | 31/32 | 32/32 | 16/16 | 16/16 |
| `state/task-graph.ts` | 27/27 | 27/27 | 3/3 | 3/3 |
| `tool/response-envelope.ts` | 57/59 | 59/59 | 13/15 | 15/15 |
| `tool/sanitize.ts` | 2/2 | 2/2 | 2/2 | 2/2 |
| `tool/types.ts` | 13/13 | 13/13 | 0/0 | 0/0 |
| `view/format.ts` | 58/62 | 62/62 | 9/10 | 10/10 |

## Production deletion audit

Only the redundant `makeTodoOverlayLoader` parameter default is deleted. The
production caller always passes `importOverlay`; that entry-point parameter
retains its lazy dynamic-import default. All three direct test callers pass an
importer too. Repository searches of packages, integration and docs found no
other call or documented zero-argument API. Making this internal loader seam
required removes a genuinely unused closure (one line/function), not reachable
extension behavior. The 14 other lines and four functions are covered by tests.
The exported deleted-status overlay glyph and defensive i18n fallback are kept.

## Reproduce

Install worktree dependencies with `npm ci --ignore-scripts`. The root lock
resolves Vitest 5.0.3 even though the package manifest says 4.1.12. Install the
matching provider outside the repository; link only into ignored `node_modules`:

```sh
npm install --prefix /tmp/cov-todo-provider --ignore-scripts --no-audit --no-fund \
  @vitest/coverage-istanbul@5.0.3
ln -s /tmp/cov-todo-provider/node_modules/@vitest/coverage-istanbul \
  node_modules/@vitest/coverage-istanbul
cd packages/todo
set --
for f in config.ts index.ts plan-hooks.ts todo-overlay.ts todo.ts \
  state/i18n-bridge.ts state/invariants.ts state/plan.ts state/replay.ts \
  state/selectors.ts state/state-reducer.ts state/state.ts state/store.ts \
  state/task-graph.ts tool/response-envelope.ts tool/sanitize.ts tool/types.ts \
  view/format.ts; do
  set -- "$@" --coverage.include="$f"
done
../../node_modules/.bin/vitest run --config .vitest.config.ts --maxWorkers=1 \
  --coverage --coverage.provider=istanbul --coverage.reporter=lcov \
  --coverage.reporter=text --coverage.reporter=json \
  --coverage.reportsDirectory=/tmp/cov-todo-after "$@"
```

The identical command measured the unmodified base into `/tmp/cov-todo-before`.
Exact-HEAD SHA, LCOV/text hashes and review receipts are recorded in the PR, not
self-referentially embedded in this commit.

Other executed gates (all exit 0):

```sh
# packages/todo
npm run lint
npm run typecheck
npm test -- --maxWorkers=1
npm run test:bun -- --maxWorkers=1
# integration/inprocess, 5 files / 12 tests on each engine
npm test -- --maxWorkers=1 goal-todos.test.ts plan-todos.test.ts \
  todo-history-session.test.ts todo-host-disclosure.test.ts todo-widget-session.test.ts
npm run test:bun -- --maxWorkers=1 goal-todos.test.ts plan-todos.test.ts \
  todo-history-session.test.ts todo-host-disclosure.test.ts todo-widget-session.test.ts
```

Resource snapshots before suites showed 10 CPUs, interval utilization 69.6% then
5.6%/6.8%, load 10.50/5.13/3.79 then 4.16/7.51/5.67 and 2.80/6.27/5.37.
Ran serial suites with one worker. This delegate had no child agents during the
suites; the parent session was active. A fleet-wide agent listing was not exposed
to this delegate. OS process metadata was not treated as agent attribution.

## Mutation receipts

Each temporary one-line production mutation below was run against the named
new tests with `vitest run --config .vitest.config.ts --maxWorkers=1 FILE -t PATTERN`.
Every run exited 1 from the expected assertion/import failure, then the original
source was restored in `finally`. The full green suites and coverage followed
restoration. Patterns below identify the committed tests, not copied scratch
probe assumptions. Raw local logs: `/tmp/cov-todo-mutations/NAME.log`.

| Name | Mutation | File / test pattern | Observed failure |
| --- | --- | --- | --- |
| `replay` | Remove replay's `replaceState` call | `todo.invalidation.test.ts`, `replaces foreground` (compact + tree) | `expected [] to deeply equal [ 'kept' ]` |
| `foreground` | Invert the replay foreground comparison | same, `replays a child` (compact + tree) | update unexpectedly called once |
| `stale-return` | Remove stale session-start catch's `return` | same, `leaves an approval` | expected seeded plan tasks to equal `[]` |
| `unexpected-error` | Replace session-start rethrow guard with `return` | same, `unexpected session_start` | promise resolved instead of rejecting |
| `reason` | Invert resulting-status reason guard to `=== "deferred"` | `state/state-reducer.test.ts`, `reason` | update/batch returned instead of error (both new field-presence cases and rollback fail) |
| `observer-prune` | Replace `renderObservers.delete(ref)` with `void ref` | `state/store.test.ts`, `prunes collected` | dereference called twice, expected once |
| `observer-live` | Replace live callback with `void observer` | same, `retains live` | callback called zero times, expected twice |
| `reminder` | Change prompt-less scan's final `false` to `true` | `plan-hooks.test.ts`, `still drafts` (empty + assistant-only) | expected true to be false |
| `plan-status` | Remove open-status guard around plan detail | `tool/response-envelope.test.ts`, `indents and sanitizes` | completed output unexpectedly includes plan detail |
| `plan-sanitize` | Interpolate raw detail line instead of sanitizing | same | ANSI-bearing output differs from exact clean expected text |
| `batch-plural` | Compare batch length with 2 instead of 1 | `todo.history-render.test.ts`, `correct plural` | `1 ops` / `2 op` instead of `1 op` / `2 ops` |
| `status-echo` | Remove snapshot status fallback | same, `echoes snapshot` | `✓` instead of `⊖ deferred` |
| `reason-expanded` | Gate expanded reason on completed instead of deferred | same | missing `reason: needs review` |
| `deleted-glyph` | Return muted transcript deleted glyph | `view/format.test.ts`, `preserves distinct` | exact error-toned palette differs |
| `fallback` | Rethrow instead of installing fallback closure | `state/i18n-bridge.shim.test.ts`, `real bridge falls back` | import rejects `SDK required` |

Lifecycle tests invoke registered callbacks with injected homes and fake clocks;
no wall-clock waits, GC or HOME mutation. The observer test deterministically
stubs `WeakRef`. Reminder tests assert the registered settle draft, not just the
scan helper. Registered tool render callbacks assert literal output. Plan detail
comes from real approval and completion reducers. The fallback test first proves
the installed SDK returns a German translation, then the real failed-import
bridge must return English for that same known key. No ignore directives or
replay-test exclusions are used.
