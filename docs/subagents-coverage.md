# Subagents coverage closure

Baseline: `6d7b13cb` (current main on 2026-10-28), Istanbul, Node 26.12.0,
Vitest 5.0.3. Branches remain report-only. No production, policy, configuration,
dependency or exclusion changes.

The read-only #162 inventory in `~/code/cov-phase0/packages/subagents/vitest.config.ts`
is exactly the 75 `src/**/*.ts` files at this revision (set comparison: no extra or
missing files). Each run passes that inventory through repeated
`--coverage.include=<path>` CLI arguments, not by changing the package config:

```sh
cd packages/subagents
../../node_modules/.bin/vitest run --maxWorkers=1 --coverage \
  --coverage.provider=istanbul --coverage.reporter=lcov --coverage.reporter=text \
  --coverage.reportsDirectory=/tmp/subagents-theme1 \
  --coverage.include='src/**/*.ts'
```

The wildcard above is the equivalent compact invocation for the verified identical
inventory. The final full expanded executed command is committed beside this note
in `subagents-coverage-command.txt`; the baseline and final differ only in their
report directory (`/tmp/subagents-before` and `/tmp/subagents-final`). LCOV is
retained in those directories. First-theme command and LCOV remain in
`/tmp/subagents-theme1-command.txt` and `/tmp/subagents-theme1/lcov.info`.
The root Vitest resolves Istanbul 5.0.3 from an ignored tooling link to
`/tmp/preset-diag-tools/node_modules/@vitest/coverage-istanbul`; no dependency files
changed. Istanbul is required because Pi/Jiti reloads corrupt V8 source attribution.
Native-loader assertions remain functional tests, not credited as instrumented execution.

| Checkpoint | Covered lines | Covered functions |
| --- | ---: | ---: |
| Main baseline | 6654/7161 | 1351/1423 |
| Workflow inspector outcomes | 6665/7161 | 1355/1423 |
| Inspector + initial viewer outcomes | 6675/7161 | 1360/1423 |
| Final three themes | 6690/7161 | 1363/1423 |

Final per-file missing lines/functions:

| File | Baseline | Final |
| --- | ---: | ---: |
| `src/ui/workflow-menu.ts` | 11/4 | 0/0 |
| `src/ui/conversation-viewer.ts` | 15/8 | 0/1 |
| `src/workflow/meta.ts` | 11/1 | 1/0 |

Full baseline/remaining file inventories, exact uncovered line numbers and
Istanbul function labels are in `subagents-coverage-before.txt` and
`subagents-coverage-remaining.txt` beside this note. All other file counters are
unchanged. The 7161-line/1423-function denominator is unchanged.

Inspector tests use the real dialog, stable runtime index 7 (not row index 0),
and externally visible outcomes: stale-child notification, viewer identity,
restored overlay after both Error and string rejection, skip/retry routing, and
no overlay for a swept task or missing session. Successful skip/retry must remain
silent. No sleeps, HOME changes, private-state access or test-only exports.

Mutation receipt: simultaneously changed `skip(index)` to `skip(index + 1)`,
restore `setHidden(false)` to `setHidden(true)`, and swept-child notification
severity `info` to `warning`. `vitest run test/workflow-menu.test.ts --maxWorkers=1`
exited 1: four tests failed (both rejection cases, stale child, skip/retry).
Restored production exactly; full Istanbul suite passed (see PR receipt for counts).

Gate: package lint and typecheck pass. Bun 1.4.4 runs the 31 native session tests
but fails the existing home-loader assertion requiring 1.3.14. With the pinned
runtime, `npm exec --yes --package=bun@1.3.14 -- npm run test:bun` passes both
native session tests and home-loader Vitest compatibility tests. No assertion or
pin was changed.

Viewer theme: `src/ui/conversation-viewer.ts` moves from 15 missing lines / 8
functions to 0 / 1 in the full suite. Real Markdown pins fallback link/URL/code,
quote, separator and bullet styling. An injected `FakeClock` proves periodic
repaint, cancellation on settlement, and disposal/unsubscribe idempotence.
Visible row numbers independently pin regular-overlay and fullscreen page sizes.
An uncommitted streaming reply appears exactly once, remains literal while live,
and switches to Markdown after commit without leaking thinking blocks.

Mutation batch 1: changed URL color to accent, disabled settlement timer
cancellation, reduced fullscreen page-down to one row, and inverted the streaming
membership guard. All four viewer tests failed. Batch 2: changed inline-code color
to accent and reduced regular page-down to one row. The styling and regular-page
tests failed (two failures, three passes). Each batch exited 1. Source restored exactly. The remaining function is the
empty ScrollView content invalidator passed by the constructor; no behavior or
source was deleted to reduce the denominator.

Metadata theme: field-specific errors for null/array/scalar phases and invalid
phase detail/model, regex braces and escaped slashes versus division, cached
valid/invalid names, and path-only/named call labels (POSIX and Windows).
The regex fixture's trailing description and exact export replacement are
independent scanner boundaries, and its throwing body must not execute.

Mutation receipts: wrong phase diagnostics, disabled regex recognition and a
wrong cached name made all seven initial metadata tests fail; wrong path/name
fallbacks made all five label cases fail. Restored source exactly. The remaining
line is the post-evaluation object-shape safety guard: scanning/evaluating a
balanced object fragment already yields an object. Kept it intact, no exclusion
or test-only VM mock to manufacture execution.

Final gate on the exact final test contents: package lint and typecheck pass;
159 Vitest files pass, 3470 tests pass and 8 skip, one worker, Istanbul;
Bun 1.3.14 native session tests 31 pass, home-loader compatibility tests 10 pass.
No production or inprocess harness files changed; no extra inprocess or root-wide
suite was run. All suites were serialized, no nested test fanout. Resource
snapshots preceded full runs; other coverage/policy/TUI work was active.

Durable raw final stdout is committed in `subagents-coverage-gate-{vitest,bun,lint,types}.txt`.
Mutation failure excerpts for all six runs are in `subagents-coverage-mutations.txt`.
The last run rechecks only the overlay-restore mutation after replacing polling
with an explicit await of the actual rejected viewer promise: both rejection
cases failed, other three cases passed. Restoration then passed the full gate.
These are historical execution artifacts, not commands to read the owner's HOME.
The inventory text files are similarly pinned to the baseline/final source
revision, and need regeneration when source changes; their line numbers are
Istanbul counter locations, not stable source citations.

PR #193 review correction, executed on parent `510270cf8412c0fce4d8159aeaee19ce1942d4b1`:

- Test blob `10a3e8dc8c88868b3d183e617787583b18ca5d04` now matches the complete
  `<dim>`-wrapped 80-character Markdown HR, not the shared three-character
  separator or viewport-width chrome. The real Markdown renderer caps HRs at 80.
- Match both complete `<dim>```js</dim>` / `<dim>```</dim>` fence borders and
  the indented `<muted>const answer = 42;</muted>` source. Plain source text
  alone no longer passes. No private theme access or renderer mocks.
- Assert unsubscribe immediately after each of two disposals, then invoke the
  retained subscription callback to model a delivery already in flight. Assert
  no repaint immediately after that stale event, separately from advancing time.
  Keep settlement cancellation, zero pending timers and elapsed-time assertions.
- Six isolated mutations each exit 1, with exactly one intended test failing
  and four passing; precise changes and assertion outputs are appended to
  `subagents-coverage-mutations.txt`. All production bytes restored: source diff
  empty; viewer source blob remains `fce1c903f09fdf9d63f17f745c970b2b40c991ed`.
- Node 26.12.0: focused restored test 5/5; full Vitest 159 files, 3470 pass,
  8 skip (`--maxWorkers=1`, 180.72s). Biome checks 253 files, no fixes;
  `npm run typecheck` exits 0. Logs: `/tmp/pr193-{focused-restored,node,lint,types}.log`.
- Declared pinned Bun 1.3.14 package gate passes: native session tests 31/31,
  home-loader compatibility 10/10 (`npm exec --yes --package=bun@1.3.14 -- npm run test:bun`).
  Log: `/tmp/pr193-bun.log`.
- Additional full Bun Vitest, beyond the declared package gate:
  `npm exec --yes --package=bun@1.3.14 -- node ../../scripts/run-vitest.ts bun --maxWorkers=1`
  exits 1: 158 files pass, 1 fails; 3470 tests pass, 7 skip, 1 fails (131.56s).
  Unchanged `workflow-runtime.test.ts` expects `workflow.js:3:` but Bun reports
  `workflow.js:4:23`. Reproduces alone with the same runner and
  `test/workflow-runtime.test.ts --maxWorkers=1`; neither that test nor production
  changed. Logs: `/tmp/pr193-bun-{full,runtime-isolated}.log`. Not claimed green;
  no out-of-scope stack-line or runtime fix.
- Runs serialized with one Vitest worker for full suites. Resource snapshots
  preceded heavy gates (10 logical CPUs, 42-59% interval CPU); orchestrator confirms
  no competing worktree writer, original author moved lifecycle work elsewhere.
  No child agents launched. OS process names were not used as agent identities.
- No new instrumentation run: production, coverage inventory and denominators are
  unchanged. Earlier coverage counters/raw gate files above remain historical
  receipts, not newly generated coverage evidence for this correction.

Next independent work, ranked by missing lines/functions:

- Manager lifecycle callbacks: `src/agent-manager.ts` (21/7), then runner (8/2).
- Workflow runtime failure/cleanup: `src/workflow/runtime.ts` (12/1).
- Fleet interaction lifecycle: `src/ui/fleet-list.ts` (7/3).
- Scheduling persistence/admission failures: `src/schedule.ts` (6/3), store (5/0).
- Widget rendering (15/0) is independent of #182 but follows the recent widget PR.

`index.ts` (352/33) and PR #182's model-selection/home/default/process-budget files
are deliberately untouched. Widget work is separate from the viewer.
