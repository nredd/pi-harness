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
to main. This is partial coverage, not a completed gate or a 100% claim.
