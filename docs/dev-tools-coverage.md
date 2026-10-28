# Dev-tools wrapper coverage

This change is stacked on `origin/redd/cargo-diag` (`4322d5fb`, PR #155). That PR owns
nextest's absolute per-call JUnit path and `CARGO_TARGET_DIR` handling. Do not merge this
stack before #155. No cargo product fix is duplicated here.

## Scope and measurement

Cover the TypeScript wrappers, not cargo, git, ssh, scp, uv, Python, Rust, or the published
resource sampler implementation. Both Node runs use Vitest 5.0.3, one fork worker, an explicit
`src/**/*.ts` coverage include, and separate report directories. The JSON inventories contain
all 22 executable source modules; `src/core/index.ts` is a re-export-only barrel. Neither the
Vitest configuration nor imports introduce a Pi/Jiti source alias. Zero-statement modules
(e.g. the default entrypoint) remain in the JSON even when omitted from the text table.

Initial providers agree exactly on lines/functions:

| Provider | Lines | Functions | Statements | Branches |
| --- | --- | --- | --- | --- |
| V8 | 1410/1503 (93.81%) | 247/261 (94.63%) | 1650/1860 (88.70%) | 1210/1557 (77.71%) |
| Istanbul (primary) | 1410/1503 (93.81%) | 247/261 (94.63%) | 1650/1860 (88.70%) | 1198/1557 (76.94%) |

Final primary Node result: **1502/1502 lines (100%), 260/260 functions (100%)**,
1771/1859 statements (95.26%), 1319/1557 branches (84.71%). All 22 executable modules
have zero missing lines/functions. Node and Bun Vitest each pass 408 tests in 29 files;
Bun's native scenario gate passes four tests. Biome and TypeScript checks pass.

The line/function denominator decreases by one only because the unreachable mutex initializer
is removed (explained below), not because any executable source file is excluded.

Choose Istanbul as primary: no alias inflation, source-complete inventory, and the same
line/function denominator as V8. Branch coverage is reported, not treated as line coverage.
No coverage policy, threshold, exclusion, or provider configuration was changed.

Initial per-file missing lines/functions:

| Source (`src/`) | Lines | Functions |
| --- | --- | --- |
| `cargo/index.ts` | 62 | 9 |
| `cargo/parse.ts` | 1 | 0 |
| `core/filelock.ts` | 4 | 0 |
| `core/lock.ts` | 0 | 1 |
| `core/process.ts` | 0 | 1 |
| `git/index.ts` | 2 | 0 |
| `git/worktree.ts` | 2 | 0 |
| `py/index.ts` | 18 | 0 |
| `py/parse.ts` | 1 | 0 |
| `resource/index.ts` | 1 | 1 |
| `ssh/hosts.ts` | 2 | 1 |
| `ssh/index.ts` | 0 | 1 |

The other ten modules already had zero line/function gaps: `index.ts`, `core/output.ts`,
`core/result.ts`, `core/tool.ts`, `git/commit-message.ts`, `git/guard.ts`, `git/push-remote.ts`,
`git/run.ts`, `git/status.ts`, `ssh/exec.ts`.

## Outcome checks

- Preserve existing real disposable repositories, installed cargo/uv fixtures, output bounds,
  exit states, status parsing, guard assertions, and SSH local stand-ins.
- Add real disposable executable children for cargo/uv argv, signal exits, noncompiler errors,
  diagnostic limits, mixed/unparsed diagnostics, progress, format-summary drift, missing JUnit,
  doctest outcomes, dependency groups, and fresh/stale nested Criterion reports.
- Assert queued cargo/uv cancellation never starts the executable, and emits waiting feedback.
- Inject filesystem failures at lock acquisition/reclaim boundaries. Assert no critical section
  runs and foreign/stale directories survive. Drive a missing child `close` event with fake
  timers and assert group-only SIGKILL plus bounded settlement.
- Exercise default SSH configuration discovery using an injected home under a disposable root,
  tilde includes and glob failure fallback; never connect to a real host.
- Exercise the resource wrapper's default optional Linux read and disposal, with an injected
  sampler rather than asserting internals of the external sampler.
- Check invalid commit bodies, unreadable HEAD after a real commit, worktree lock error mapping,
  and propagation of unexpected lock defects.

The only production edit removes an unused no-op initializer for `release`: a Promise executor
synchronously assigns it before any use. The no-op was not reachable; definite assignment makes
that invariant explicit. No reachable code was removed to raise coverage.

Full Bun execution exposed two existing fixture portability assumptions: Bun's `ChildProcess`
stdio accessors are read-only, and its missing-executable message differs from Node's ENOENT.
Define synthetic child properties explicitly and assert the precise runtime-specific error while
also requiring null exit and no timeout. No installed-tool gate was skipped or timeout raised.

## Isolation and reproduction

All new files, executable mutations, synthetic configs, repositories and worktree operations are
under private temporary roots, removed in teardown. Tests do not write the user's home or SSH
config. The Git test commands below ignore system/global configuration and use empty templates;
Git's fixture hook test now creates its hooks directory explicitly. The installed cargo/uv tools
still run their existing real project gates; their implementation is outside coverage scope.

`CARGO_TARGET_DIR` was inherited as `/Volumes/Scratch/build/cargo`. Unset it for ordinary fixture
runs; retain the existing explicit absolute/relative target-directory tests from #155. All real
cargo assertions pass, including the strict two-test/one-failure JUnit assertion. The `@{u}` stderr
is an intentional negative assertion in `commit-remote.test.ts`; that same fixture subsequently
asserts `fork/feat` after push. It is not an unexplained suite failure.

Commands from `packages/dev-tools` (providers 5.0.3 supplied in untracked `node_modules` from an
isolated npm exec cache, without lockfile/dependency changes):

```sh
npm run lint
npm run typecheck
env -u CARGO_TARGET_DIR GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TEMPLATE_DIR= \
  ../../node_modules/.bin/vitest run --maxWorkers=1 --coverage.enabled \
  --coverage.provider=v8 '--coverage.include=src/**/*.ts' \
  --coverage.reporter=json --coverage.reporter=text --coverage.reportsDirectory=coverage-v8
env -u CARGO_TARGET_DIR GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TEMPLATE_DIR= \
  ../../node_modules/.bin/vitest run --maxWorkers=1 --coverage.enabled \
  --coverage.provider=istanbul '--coverage.include=src/**/*.ts' \
  --coverage.reporter=json --coverage.reporter=text --coverage.reportsDirectory=coverage-istanbul
env -u CARGO_TARGET_DIR GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TEMPLATE_DIR= \
  bun --bun ../../node_modules/vitest/vitest.mjs run --maxWorkers=1
env -u CARGO_TARGET_DIR GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TEMPLATE_DIR= \
  npm run test:bun
```

Use `coverage-istanbul-after` for the final primary run, preserving both original provider
reports. Reports are local generated artifacts, not committed. No network host mutations,
merge/rebase/force, release, install activation, or other worktree changes are part of this work.
