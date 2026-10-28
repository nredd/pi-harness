# Subagents index coverage

Scope: new `test/index-coverage*.test.ts` files only, plus this note. Production,
shared harness, configuration, dependency and policy files are unchanged.
Base: `b51e1774` (main including #182). #193's additional inspector/viewer/meta
coverage is independent and not included in this fresh branch.

Measurement uses the package's unchanged `vitest.config.ts`: Istanbul instruments
all `src/**/*.ts`. No source-path exclusions or denominator edits. Commands run
from `packages/subagents`, one worker, after resource snapshots. Lifecycle,
dev-tools, policy, Bun-upgrade and crash-diagnosis agents are independently active;
these runs do not launch nested builds or tests.

```sh
../../node_modules/.bin/vitest run --maxWorkers=1 --coverage \
  --coverage.provider=istanbul --coverage.reporter=lcov --coverage.reporter=text \
  --coverage.reportOnFailure --coverage.reportsDirectory=/tmp/subagents-index-before
# Same command after theme 1, reportsDirectory=/tmp/subagents-index-theme1.
npm run lint
npm run typecheck
```

`reportOnFailure` preserves evidence despite two pre-existing failures, not a
changed coverage selection. Both full runs fail the same two
`process-budget.test.ts` cases because its TypeScript mock lacks `ModuleKind`.
That lifecycle-owned test is untouched. Baseline: 155 passing files, one failing,
3447 passing tests, two failing, eight skipped. Theme 1: 156 passing files, one
failing, 3481 passing tests, two failing, eight skipped. Lint/typecheck pass.
Raw logs and LCOV remain in `/tmp/subagents-index-{before,theme1}{.log,/lcov.info}`.

| Checkpoint | Index covered lines | Index covered functions | Missing lines/functions |
| --- | ---: | ---: | ---: |
| Current main baseline | 1085/1437 | 218/251 | 352/33 |
| Agent file operations + manual wizard | 1230/1437 | 230/251 | 207/21 |
| Final, 98 new tests | 1399/1437 | 243/251 | 38/8 |

The first 34 tests drive the registered `/agents` command, actual SettingsList
keyboard callbacks and private on-disk Markdown, not exported internals. Assertions
pin file content, registry reloads, offered actions and notifications. Cases:
edit/cancel/unchanged, confirmed/refused delete, disable/enable a real definition,
no-frontmatter and noncanonical flag failures, project/personal built-in stubs,
ejection, external-editor override races, reset confirmations, manual tools/models/
thinking choices, personal overwrite confirmation, and cancellation at each wizard
step. The external-editor race creates a real override while the picker is open;
ordinary reloaded overrides currently lose `isDefault`, so only that race offers
Reset to default. No synthetic config injection is used to reach it.

Independent mutation receipts, each restored before the next run:

- Replace the edited-file write with its original content: exit 1, edited-content
  assertion fails.
- Replace the existing-definition disable write with its original content: exit 1,
  disabled content assertion fails.
- Replace ejection serialization with a wrong description/body: exit 1, both
  destination body assertions fail.
- Change manual `tools: none` to `tools: read`: exit 1, tool restrictions and exact
  overwrite-content assertions fail.
- Suppress reset's unlink: exit 1, confirmed reset leaves the override on disk.

Each mutation ran `vitest run test/index-coverage-agents.test.ts --maxWorkers=1`.
Full failure output is `/tmp/index-mutations.log`. Restored source is byte-identical
to main.

Final themes add actual provider-scripted child sessions, including the real write
tool for generation success/overwrite. Generation covers cancelled name/description,
provider errors and a successful child that produces no requested file. Settings
keyboard tests persist every row, numeric typing/re-prompt/cancel, both sides of
boolean toggles, package allowlist replacement, strict fallback, and real write
failure (a directory occupies the settings filename). Viewer keys exercise live
steer, stop, foreground handoff, menu/fleet markdown persistence, silent success
and warning on failed persistence. Result retrieval proves the steered text reached
the actual child transcript. Fleet disclosure uses the injected clock to settle its
journal write. Package tests pin the read-only author-disabled menu, local shadow
stubs, installed bytes remaining unchanged and confirmed/refused ejection overwrite.
An external-editor race pins the already-disabled warning without writing twice.
No runner, manager, file helper, SettingsList or viewer is mocked.

Independent additional mutations, each with exit 1 from its owning test file:

- Invert `setShowModel(enabled)`: persisted toggle assertions fail.
- Set max concurrency to `n + 1`: numeric and retry assertions fail.
- Claim creation when generation wrote no file: missing-output warning fails.
- Downgrade the generation-error warning to info: error severity assertion fails.
- Force viewer markdown to `off`: both disk and broadcast assertions fail.
- Suppress the menu viewer's abort: stop notification/status assertions fail.
- Replace the steered message: the actual child transcript assertion fails.
- Remove the menu viewer background action: foreground-handoff notification fails.
- Suppress failed-persistence notification: warning assertion fails.

Commands: `vitest run test/index-coverage-{settings,generate}.test.ts --maxWorkers=1`,
one file per mutation. Full output: `/tmp/index-theme2-mutations.log`. Production
was restored after every mutation, including failed mutation setup attempts.

Final executed gates, serialized, with snapshots before heavy runs:

```text
Node 26.12.0 / Vitest 5.0.3 / Istanbul, full suite:
Test Files  1 failed | 158 passed (159)
Tests       2 failed | 3545 passed | 8 skipped (3555)

Bun 1.3.14 / Vitest 5.0.3, full suite:
Test Files  2 failed | 157 passed (159)
Tests       3 failed | 3545 passed | 7 skipped (3555)

Pinned Bun native session scenarios: 31 pass, 0 fail
Pinned Bun home-loader Vitest compatibility: 10 pass
Package lint: 253 files, clean
Package typecheck: tsc --noEmit, exit 0
```

Final coverage command is the baseline command with
`--coverage.reportsDirectory=/tmp/subagents-index-final`. Logs:
`/tmp/subagents-index-{final,bun-full,bun-native,lint,types}.log`.
Full Bun command:
`npm exec --yes --package=bun@1.3.14 -- node ../../scripts/run-vitest.ts bun --maxWorkers=1`.
Native Bun command:
`npm exec --yes --package=bun@1.3.14 -- npm run test:bun`.
Node and Bun both fail the two baseline `process-budget.test.ts` cases. Bun also
fails the existing workflow-runtime stack-location assertion: expected
`workflow.js:3:`, actual Bun stack has a different source location. These files
belong to the independent lifecycle/Bun work and were not modified. All 98 new
tests pass under both runtimes. No root-wide `make check` or live install was run.

Final Istanbul missing offsets in unchanged `src/index.ts`:

```text
Lines (38):
178,525,645,921,948,1316,1347,1348,1478,1479,1944,1946,2267,2291,
2302,2334,2376,2987,2988,2989,3068,3122,3157,3158,3359,3418,3419,
3444,3445,3501,3502,3522,3523,3550,3551,4288,4300,4542

Functions (8):
645  (anonymous_53)
1347 (anonymous_85)
1348 (anonymous_86)
1351 (anonymous_88)
1477 (anonymous_105)
3224 (anonymous_198)
4542 (anonymous_249)
4545 (anonymous_250)
```

Remaining themes include detached grouped notices and survivor abort/steer,
workflow inspector callbacks, CLI workflow and persistence failures, scheduler/
menu races, and defensive resume paths. Some counters are deliberately retained
safety paths with no useful assertion: e.g. the empty rejected-wait callback and
the legacy queued-record polling executor when current records always expose a
start gate. The settings `already enabled/disabled` branches cannot be reached by
a normal SettingsList change because its callback carries the *next* value.

Status: partial, not 100%. No provider inconsistency was demonstrated. No deletes,
exclusions, counter manipulation or private-state injection were used to manufacture
closure. The outstanding coverage target and full-gate failures remain open.
