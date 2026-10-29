# Combined Plan-mode package coverage

## Reproduction and scope

Measured the requested open PR heads in a fresh worktree at `~/code/cov-pm-combined`,
on local-only `redd/cov-pm-combined-scratch`, starting from `origin/main` at
`ed1bce1f`. This scratch branch is not pushed. No rebase, cherry-pick, merge to main,
release, source deletion, configuration change, instrumentation exclusion, or threshold
change is part of this work.

The new branch `redd/cov-pm-package-final` starts directly at #208 (`bcc85751`). Its
only changes are new tests and this document. It does not contain #185/#188/#189.
The new tests target the residual source modules below, not those PRs' modules.

Heads measured:

| PR | Head | Branch |
| --- | --- | --- |
| #185 | `3ea8c2ce` | `redd/cov-close-plan-mode` |
| #187 | `e564bd59` | `redd/cov-close-plan-mode-main` |
| #188 | `a8e52c38` | `redd/cov-close-plan-mode-policy` |
| #189 | `b7e07a9a` | `redd/cov-close-plan-mode-menus` |
| #199 | `de5d4ab1` | `redd/cov-pm-attribution` |
| #200 | `f43dd607` | `redd/cov-pm-finalguards` |
| #208 | `bcc85751` | `redd/cov-pm-last5` |

Actual plain merge order: #208, #185, #188, #189, then #187/#199/#200.
Every merge used `git merge --no-ff --no-edit`. The last three were already ancestors
of #208 and reported `Already up to date.` No textual or semantic conflicts needed
resolution. Pairwise `git merge-tree --write-tree` also independently returned exit 0
for #185 vs #208, #188 vs #208, and #189 vs #208. These three siblings can land in any
order relative to #208 at these exact heads. The dependency chain still is
#187 -> #199 -> #200 -> #208. Recheck if a head changes.

Run from `packages/plan-mode` with the existing `vitest.config.ts`:

```sh
../../node_modules/.bin/vitest run --maxWorkers=1 --coverage \
  --coverage.provider=istanbul '--coverage.include=src/**/*.ts' \
  --coverage.reporter=json --coverage.reporter=text \
  --coverage.reportsDirectory=/tmp/cov-pm-combined-node
bun ../../node_modules/vitest/vitest.mjs run --maxWorkers=1 --coverage \
  --coverage.provider=istanbul '--coverage.include=src/**/*.ts' \
  --coverage.reporter=json --coverage.reporter=text \
  --coverage.reportsDirectory=/tmp/cov-pm-combined-bun
```

Node `v26.12.0`, Bun `1.4.4`, Vitest/Istanbul `5.0.2`. Istanbul was installed locally
with `npm install --no-save --ignore-scripts --package-lock=false
@vitest/coverage-istanbul@5.0.2`; no dependency manifest or lockfile changed.
All 36 `src/**/*.ts` files are input; Istanbul emits 34 executable entries. The two
re-export-only files (`index.ts`, `interactive-ui.ts`) have no executable counters.
Runs are serial, with one worker, after checking host resources.

## Before these new tests: actual combined coverage

Both full Node and Bun runs passed and emitted identical counts:

| Metric | Covered / total | Percent |
| --- | --- | --- |
| Lines | 2926 / 2989 | 97.89% |
| Functions | 682 / 698 | 97.70% |
| Statements | 3345 / 3504 | 95.46% |
| Branches (report only) | 2862 / 3151 | 90.82% |

Per-file gaps below are identical on Node and Bun. Function locations are Istanbul
function-body start lines; anonymous names are local counter names, not exported APIs.
All other executable files have complete lines/functions.

| Source | Lines | Functions | Uncovered lines | Uncovered functions |
| --- | --- | --- | --- | --- |
| `fresh-implementation.ts` | 106/113 | 20/20 | 74,75,103,205,210,241,242 | none |
| `message-transform.ts` | 129/132 | 33/33 | 78,187,266 | none |
| `plan-action-controller.ts` | 54/63 | 26/33 | 98,117,118,120,127,128,142,143,149 | anonymous_11@98, anonymous_17@117, anonymous_18@118, anonymous_20@120, anonymous_25@142, anonymous_26@143, anonymous_32@149 |
| `plan-export.ts` | 43/48 | 9/10 | 40,41,70,84,106 | anonymous_3@70 |
| `plan-launch-menu.ts` | 27/32 | 12/12 | 103,117,118,119,121 | none |
| `plan-mode.ts` | 946/947 | 154/154 | 1651 | none |
| `presentation.ts` | 82/83 | 19/21 | 160 | anonymous_13@148, anonymous_19@180 |
| `question-tool.ts` | 114/130 | 30/34 | 110,123,129,135,141,149,156,163,174,249,256,261,265,429,430,431 | anonymous_17@362, fallbackText@428, anonymous_29@430, anonymous_30@431 |
| `saved-plan-menu.ts` | 15/19 | 9/10 | 21,76,77,78 | anonymous_7@75 |
| `settings-menu.ts` | 103/109 | 46/46 | 241,281,289,317,321,341 | none |
| `settings.ts` | 230/235 | 43/44 | 244,396,399,442,463 | anonymous_32@480 |
| `state.ts` | 71/72 | 16/16 | 232 | none |

In particular, #185 supplies complete lines/functions for `completion-tool.ts`,
`ready-plan-chooser.ts`, and `saved-plan-preflight.ts`; #188 supplies `tool-policy.ts`
480/480 lines and 79/79 functions; #189 supplies `plan-action-menus.ts` 113/113 lines
and 46/46 functions. Adding isolated coverage percentages is not a package measurement.

## New behavioral coverage

Seven new test files, 27 tests:

- Route controller callbacks with their original context, signal, lifecycle, path and
  runtime selection, checking observable dispatch order. Exercise saved Settings stay,
  close, stale, and headless outcomes.
- Reject missing fresh plans and headless session replacement; retain the source on
  idle-time staleness, registry/authentication failure, replacement failure/cancellation;
  recover failed destination persistence into the editor without sending a prompt.
- Exercise actual RPC launch draft deselection and Settings refresh, and preserve edited
  drafts. Reset fresh thinking and reject a pasted invalid shortcut through real RPC UI.
- Validate question shapes and text fallback, recover completion state through unrelated
  messages, respect history user boundaries, preserve wrapped-message shape, and render
  after component invalidation.
- Reject canonical settings arriving invalid during a legacy read, a real file growing
  after its stat, oversized pretty-printed retained settings, and tolerate post-publication
  cleanup failure. Real files are read back and temporary directories cleaned in `finally`.
- Propagate export EIO without creating a file; reject headless missing-plan/export errors,
  cancellation and NUL paths without overwriting targets.

`package-menu-contract.test.ts` and `package-question-contract.test.ts` deliberately inject
malformed **external Kit adapter output/dispatch**, with Kit's module mocked but the
Plan-mode adapter unchanged. They do not claim the current Kit UI emits unknown tool IDs,
invalid thinking levels, incomplete answers, invalid question IDs or inconsistent option
indices. These are defensive dependency-boundary tests, not supported UI reproductions.
Filesystem mocks similarly gate/fail host operations rather than mocking the settings
parser, bounded-read implementation, publication algorithm, or file mutation queue.
No private Plan-mode closure is extracted or invoked.

## Mutation proofs

Each mutation was temporarily applied alone to the real source, the named new test file
ran with one worker, and the source was restored in `finally`. All 22 mutants failed
behavioral assertions or surfaced the deliberately injected host error instead of the
required successful result. There were no import, syntax, timeout or setup-error kills.

| Mutant | Observable failure |
| --- | --- |
| Bypass fresh missing-plan rejection | Rejected result/notification no longer matches |
| Drop presentation history artifact | Artifact lookup returns undefined |
| Route saved clear to stay | Dispatch sequence changes |
| Swallow headless no-plan export error | Expected rejection is missing |
| Swallow non-EEXIST export write error | Expected exact EIO rejection is missing |
| Add instead of deselecting launch tool | Reviewed launch policy wrongly contains read |
| Accept unknown launch tool as stay | Invalid-dispatch rejection changes |
| Report off status as active | Status text changes |
| Replace question-array diagnostic | Validation error changes |
| Accept incomplete questionnaire output | Expected rejection is missing |
| Accept unknown questionnaire question | Expected rejection is missing |
| Accept custom answer with option index | Expected rejection is missing |
| Accept out-of-range selected option | Expected rejection is missing |
| Always close saved Settings | Stay case does not reopen |
| Save high instead of resetting fresh thinking | Persisted JSON retains an override |
| Bypass shortcut validation | Invalid shortcut path saves/reports wrong result |
| Bypass thinking-level dispatch validation | Invalid dispatch reaches forbidden save |
| Ignore raced invalid canonical settings | Canonical rejection is missing |
| Remove post-stat bounded-read size check | Size diagnostic changes to invalid JSON |
| Remove serialized-document size check | Oversized document is published |
| Propagate post-publication rm failure | Successful save instead throws cleanup unavailable |
| Drop recovered completion plan | Restored plan is undefined |

Component `invalidate()` methods are intentional no-ops: calling them and asserting a
stable rerender covers their public contract, not a claim of independently killed no-op
mutants. Branch coverage remains report-only. The earlier #208 stale-guard mutant and
queue-retention limitations remain as documented in `plan-mode-last-guards.md`.

## Validation

The #208-stacked branch alone passed 601 tests in 61 files on both Node and Bun with
one-worker Istanbul: 2919/2989 lines, 677/698 functions. Its remaining gaps belong to
#185/#188/#189 and `plan-mode.ts:1651`; these existing PRs are deliberately not copied
onto the branch. Package build, full Biome check, typecheck, and all four native Bun
session suites passed. The final combined run and exact HEAD/review receipts are recorded
on the PR, separately from this source document.

Queue retention at `plan-mode.ts:1651` remains retained and unresolved. No exhaustive
unreachability proof or supported behavior-preserving reproduction is claimed.
