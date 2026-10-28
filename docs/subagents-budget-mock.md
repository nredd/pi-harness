# Process-budget compiler fixture

For contributors investigating the `process-budget.test.ts` compiler boundary.
The historical index-worktree failure was `No "ModuleKind" export is defined on
the "typescript" mock`. Its original installation/loader cause is UNPROVEN.
Ordinary focused Node and Bun runs in the fresh `b51e1774` installation already
passed 39 tests before the correction.

A controlled default-only namespace, still exposing the actual locked TypeScript
compiler, reproduced the two missing-`ModuleKind` failures (37 other tests pass).
The global partial mock intercepts SDK imports too and assumes named exports;
a namespace spread cannot supply them when the compiler is under `default`.
Replacing that shared mock with a fixture-local `vi.fn(TypeScript.transpileModule)`
passes all 39 in the same controlled namespace. Exact compile-count, reload and
cross-module budget assertions remain. This demonstrates mock fragility, not the
recovered historical cause.

Reproduction: a temporary module exports only the default from the resolved real
package-local `typescript/lib/typescript.js`; a temporary Vitest config imports
the unchanged package config and aliases `typescript` to that module. Run from
`packages/subagents`:

```sh
../../node_modules/.bin/vitest run test/process-budget.test.ts --maxWorkers=1 --config "$TEMP_CONFIG"
# Shared partial mock: exit 1, 2 failed / 37 passed.
# Fixture-local spy: exit 0, 39 passed.
../../node_modules/.bin/vitest run test/process-budget.test.ts --maxWorkers=1
npm exec --yes --package=bun@1.3.14 -- node ../../scripts/run-vitest.ts bun test/process-budget.test.ts --maxWorkers=1
# Ordinary corrected fixture: both exit 0, 39 passed.
```

Recorded environment: Node 26.12.0; package TypeScript 6.0.3, root TypeScript
7.0.2; root Vitest/Istanbul 5.0.3, package Vitest 4.1.12. Lockfile blob
`e5df1538f04042bb160565438c70efc2df044cb4` is unchanged from `b51e1774`.
No guessed mock export, dependency or loader-policy change. Fresh full gates
are in `subagents-lifecycle-gates.txt`; the separate #174 full-Bun stack-location
failure is not a compiler-mock failure and is not claimed fixed here.
