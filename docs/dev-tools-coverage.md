# Dev-tools wrapper coverage

Measurement baseline: `4322d5fb` (PR #155), which supplies nextest's absolute per-call
JUnit path and `CARGO_TARGET_DIR` handling. No cargo product fix is duplicated here.
The PR records stack ordering and execution/review receipts [here](https://github.com/nredd/pi-harness/pull/195).

## Scope and measurement

Cover the TypeScript wrappers, not cargo, git, ssh, scp, uv, Python, Rust, or the published
resource sampler implementation. Both Node runs use Vitest 5.0.3, one fork worker, an explicit
`src/**/*.ts` coverage include, and separate report directories. The JSON inventories contain
all 22 executable source modules; `src/core/index.ts` is a re-export-only barrel. Neither the
Vitest configuration nor imports introduce a Pi/Jiti source alias. Fully covered modules
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
  sampler rather than asserting internals of the external sampler. This one smoke assertion is
  host-conditional intentionally: it covers the default reader, whereas the existing injected-reader
  tests cover available/missing memory outcomes deterministically on every platform.
- Check invalid commit bodies, unreadable HEAD after a real commit, worktree lock error mapping,
  and propagation of unexpected lock defects.

The only production edit removes an unused no-op initializer for `release`: a Promise executor
synchronously assigns it before any use. The no-op was not reachable; definite assignment makes
that invariant explicit. No reachable code was removed to raise coverage.

Mutation checks (both restored before the final gates): changing the doctest failure transition
from `failed` to `passed` makes the cargo test fail its `isError` assertion; substituting
`wrong-group` for uv's requested group makes the Python wrapper test fail its exact argv summary.
Running `vitest run --maxWorkers=1 test/cargo/wrapper.test.ts test/py/wrapper.test.ts` against
both mutations produced exactly two failed and ten passed tests. These checks test outcomes,
not incidental execution of lines.

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

Unset ambient `CARGO_TARGET_DIR` for ordinary fixture runs; retain the existing explicit
absolute/relative target-directory tests from #155. The historical expected-two-tests/got-zero
failure was not reproduced on this stacked baseline: `test/cargo/tools.test.ts` strictly asserts
two tests and one failure, and its relocated-target tests assert those same counts. #155 places
JUnit outside Cargo's target directory; unsetting the ambient variable is fixture hygiene, not
a substitute for that product fix. No assertion was relaxed.

The `@{u}` stderr comes from the explicit `expect(() => sh(repo, ["rev-parse", "--abbrev-ref",
"@{u}"])).toThrow()` in `test/git/commit-remote.test.ts`, in the test named "pushes a new branch
to branch.<n>.remote when its tracking ref does not exist yet". That test subsequently asserts
`fork/feat` after the push. The initial absent-upstream diagnostic is expected, not a suite failure.

Commands from `packages/dev-tools` (providers 5.0.3 supplied without tracked
lockfile/dependency changes):

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
