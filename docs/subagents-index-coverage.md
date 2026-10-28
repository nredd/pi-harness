# Subagents index coverage

Audience: maintainers reproducing PR #198's partial `src/index.ts` coverage.
Scope: three new `test/index-coverage*.test.ts` files and this note. Production,
shared harness, configuration, dependencies and policy are unchanged.
Base: `b51e1774` (main including #182). #193's inspector/viewer/meta coverage
is independent and not included here.

## Reproduce

From a fresh repository checkout with its pinned Node and dependencies:

```sh
npm ci
cd packages/subagents
../../node_modules/.bin/vitest run test/index-coverage-agents.test.ts \
  test/index-coverage-settings.test.ts test/index-coverage-generate.test.ts --maxWorkers=1
npm run lint
npm run typecheck
npm exec --yes --package=bun@1.3.14 -- node ../../scripts/run-vitest.ts bun \
  test/index-coverage-agents.test.ts test/index-coverage-settings.test.ts \
  test/index-coverage-generate.test.ts --maxWorkers=1
# Full measurement, including baseline failures:
../../node_modules/.bin/vitest run --maxWorkers=1 --coverage \
  --coverage.provider=istanbul --coverage.reporter=lcov --coverage.reporter=text \
  --coverage.reportOnFailure
```

Use a resource snapshot before the full suite and keep one worker when other
agents are running. The unchanged `vitest.config.ts` instruments all
`src/**/*.ts`, without source exclusions or denominator edits. `reportOnFailure`
preserves the measurement when baseline tests fail; it does not change selection.
No workstation scratch state or previous report directory is needed.

## Measured checkpoints

These are the original full Node/Istanbul runs, not a new measurement after the
review-only assertion changes:

| Checkpoint | Index covered lines | Index covered functions | Missing lines/functions |
| --- | ---: | ---: | ---: |
| Main baseline | 1085/1437 | 218/251 | 352/33 |
| Initial agent file operations + manual wizard | 1230/1437 | 230/251 | 207/21 |
| Final, 98 new tests | 1399/1437 | 243/251 | 38/8 |

The final agent-operations file has **39** tests; 34 was the earlier checkpoint.
The other files contain 46 settings tests and 13 generation/viewer tests.

Agent operations drive the registered `/agents` command, actual SettingsList
keyboard callbacks and private Markdown files. Assertions cover edited content,
registry reloads, delete/reset confirmations, disable/enable stubs, package
read-only menus and installed bytes, ejection races, manual tool/model/thinking
choices, personal overwrite and cancellation at every wizard stage. The reset
case creates an override while the picker is open: ordinary reloaded overrides
lose `isDefault`, so only this real external-editor race offers Reset to default.

Settings tests persist every row, round-trip boolean branches, type/re-prompt/
cancel numeric input, replace a package allowlist, reject unknown fallback agents
and exercise real write failure with a directory occupying the settings filename.
Fallback navigation derives its movement from named rows and verifies the selected
row's visible description before committing.

Generation uses provider-scripted child sessions and the real write tool, manager,
runner and disk. **The test `pi.events` emitter auto-acknowledges
`router:rpc:admit`.** This is a stubbed admission boundary, not production router
admission integration. UI dialogs, clock and parent context are controlled fixtures;
manager, runner, file helpers, SettingsList and conversation viewer are real.
Generation covers overwrite, cancellation, provider error and missing output.
Viewer assertions cover stop status/notification, foreground handoff, persisted
Markdown, warning on persistence failure, the steered text and the child's actual
`Redirected answer.` in result retrieval. Required viewer input/disposal methods
are asserted present and called directly, not optionally skipped.

The fleet case intentionally rebinds the same session after attaching UI, then
rebinds again to assert no duplicate terminal listeners. Its unsubscribe callbacks
actually remove listeners. Explicit `session_shutdown` must empty the listener set
and injected clock. The normal viewer close calls the real disposer. This does
not prove every possible viewer timer or disposal path; see mutation limits below.

## Gates and durable receipts

Original full gates at `afd32e60`, Node 26.12.0 / Vitest 5.0.3 / Istanbul:

```text
Node: Test Files 1 failed | 158 passed (159)
      Tests      2 failed | 3545 passed | 8 skipped (3555)
Bun 1.3.14: Test Files 2 failed | 157 passed (159)
            Tests      3 failed | 3545 passed | 7 skipped (3555)
Native pinned Bun: 31 passed; home-loader compatibility: 10 passed
```

Both runtimes fail two baseline `process-budget.test.ts` cases whose TypeScript
mock lacks `ModuleKind`. Bun additionally fails the authored-stack-location
assertion in `workflow-runtime.test.ts`, tracked in
[#174](https://github.com/nredd/pi-harness/issues/174). Neither file was modified.
The skip difference is `resource-loader-home.test.ts`'s
`records the Bun.file ambient-home bypass probe`: `bunIt` selects `it.skip` on
Node and `it` on Bun. It is not a changed test selection or an extra Bun skip.

After review corrections, all 98 new tests pass on Node and pinned Bun, package
lint checks 254 files clean, and `tsc --noEmit` exits 0. The full suites were not
rerun after these assertion-only corrections. No root-wide `make check`, release,
activation or live install check was run. Vite emits its existing native-loader
compatibility warning; no config was changed to hide it.

Exact commands, counts, mutation outcomes and finding dispositions are recorded
in PR #198 comments, not transient logs. The original 14 independent mutations
were assertion-red: edited/disabled file writes, ejection serialization, manual
`tools: none`, reset unlink, model toggle, numeric assignment, missing generation
output, generation-error severity, viewer Markdown, stop, steer, background
handoff and failed-persistence warning. Production was restored after each run.

Additional review mutations target a stuck round-trip toggle, untrimmed numeric
re-prompt, numeric cancellation changing state, fleet/handoff listener disposal,
fallback strictness, premature wizard entry on location/method cancellation, and
false-success notifications at the remaining seven manual cancellation stages.
Renaming each real viewer method (`handleInput`, `dispose`) also fails the new
presence assertions in both persistence cases. Each mutation is checked against
its owning named test, not merely a nonzero exit.

This is **limited mutation evidence, not proof of every new assertion**. Removing
`widget.dispose()` survives the completed-child fleet test: the widget has no
live timer then. Not individually mutation-proven: every settings row's distinct
setter/broadcast, every manual option combination and cancellation continuation,
package byte preservation, the second steered answer assertion, and all
normal-close timer cleanup. The new
cancellation prompt-sequence assertions improve failure localization but are not
claimed fully mutation-proven by false-success-notification mutants.

## Remaining coverage themes

The original measurement still has **38 uncovered lines and 8 uncovered
functions** in unchanged `src/index.ts`. Stable navigation anchors, grouped by
behavior rather than per-run LCOV positions:

- Completion delivery and detachment: the `"Aborted (max turns exceeded)"`
  summary, grouped notification catch (`"as in sendIndividualNudge"`),
  `details.others?.map(other => other.id)` in the outbox builder, held-notice
  spool failure (`"Could not spool held completion notices"`), detached survivor
  `abort`/`steer` callbacks and the rejected `manager.waitForAll().then` callback.
- Session lifecycle: scheduler startup warning (`"Failed to start scheduler"`),
  canonical agent loading's non-startup-error rethrow, and the `session_tree`
  callback calling `restoreFleetDisclosure` and `fleet.update`.
- Agent dispatch and retrieval: empty/unreadable custom description warnings
  (`"is empty"`, `"failed to read"`), inactive scheduler and scheduling-error
  returns, missing resume session and failed-resume returns, and the legacy
  `record.startGate ?? new Promise<void>` polling executor.
- Workflows: script persistence failure (`"could not persist workflow script"`),
  headless collision/CLI warning callbacks, CLI metadata-extraction failure,
  `workflowMenuDeps.getCtx` and the `openWorkflowFromFleet` source callback.
- Menus and settings: `getModelLabel`'s resolved-model suffix,
  `showSchedulesMenu` navigation, empty-agent menu guards (`"No agents."`),
  `viewAgentConversation`'s absent-session guard, the missing-config warning
  (`"Agent config not found"`), and the `"Scheduling already"` /
  `"Workflows already"` settings branches.

The eight uncovered functions are the `other => other.id` mapper, detached
survivor `abort` and `steer`, rejected-wait no-op, `session_tree` handler, queued
polling executor, `workflowMenuDeps.getCtx` and fleet workflow opener callback.
Some are deliberately retained safety paths without useful normal assertions:
current queued records expose a start gate, and normal SettingsList callbacks
carry the next value rather than an already-enabled/disabled value.

Status: partial, not 100%. No provider inconsistency was demonstrated. No
exclusions, counter manipulation or private-state injection manufactured closure.
The outstanding coverage target and full-gate failures remain open.
