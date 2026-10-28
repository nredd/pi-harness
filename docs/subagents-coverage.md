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
inventory. Full expanded executed command and LCOV are retained in
`/tmp/subagents-theme1-command.txt` and `/tmp/subagents-theme1/lcov.info`.
The root Vitest resolves Istanbul 5.0.3 from an ignored tooling link to
`/tmp/preset-diag-tools/node_modules/@vitest/coverage-istanbul`; no dependency files
changed. Istanbul is required because Pi/Jiti reloads corrupt V8 source attribution.
Native-loader assertions remain functional tests, not credited as instrumented execution.

| Checkpoint | Covered lines | Covered functions |
| --- | ---: | ---: |
| Main baseline | 6654/7161 | 1351/1423 |
| Workflow inspector outcomes | 6665/7161 | 1355/1423 |

| File | Baseline missing L/F | Inspector missing L/F |
| --- | ---: | ---: |
| `src/ui/workflow-menu.ts` | 11/4 | 0/0 |

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

Priority independent work: conversation viewer (15 lines/8 functions), manager
lifecycle (21/7), workflow runtime (12/1), metadata validation/scanner (11/1).
`index.ts` (352/33) and PR #182's model-selection/home/default/process-budget files
are deliberately untouched. Widget work is separate from the viewer.
