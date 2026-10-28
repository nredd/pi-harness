# Process-budget compiler mock

The owner reported two `process-budget.test.ts` failures at index PR #198:
`No "ModuleKind" export is defined on the "typescript" mock`.

This fresh `b51e1774` checkout did NOT reproduce those failures with its ordinary
installation: focused Node and Bun each passed all 39 tests before the fix,
and the full Node/Istanbul suite passed. Resolution here is package-local
TypeScript 6, while root TypeScript 7 exposes a different API. The index
worktree no longer has dependencies installed, so its exact original loader
identity cannot be reconstructed from that checkout. Do not conflate the
controlled namespace reproduction below with recovering that original install.

The shared-root defect is the global partial mock: it intercepts SDK/compiler
imports too, spreads whatever namespace importOriginal returns, and assumes
named `ModuleKind`/`transpileModule` exports. A default-only namespace retains
the REAL compiler on `default` but the spread loses the named enum. The
transpiler's invocation-count assertion needs a local spy, not a replacement
of every TypeScript import in the worker.

Change: import the compiler's default API, destructure the real `ModuleKind`,
and wrap only this fixture's calls with `vi.fn(TypeScript.transpileModule)`.
All compilation, distinct-module reload and exact compile-count assertions stay
unchanged. No production, dependency, tracked configuration or loader policy
changes.

Red-capable diagnostic (temporary files, no tracked config change):

```js
// /tmp/lifecycle-typescript-default-only.mjs
import compiler from '/Users/redd/code/cov-subagents-lifecycle/packages/subagents/node_modules/typescript/lib/typescript.js';
export default compiler;
```

A temporary Vitest config imports the unchanged package config and aliases
`typescript` to that wrapper. Only namespace shape changes; the compiler is
still the actual package-local compiler, not a handwritten stub.

```sh
cd packages/subagents
../../node_modules/.bin/vitest run test/process-budget.test.ts --maxWorkers=1 \
  --config /tmp/lifecycle-budget-default-only.config.mts
# Before: exit 1; 2 failed, 37 passed, both exact missing-ModuleKind errors.
# After:  exit 0; 39 passed, including exact compile-count assertion.
../../node_modules/.bin/vitest run test/process-budget.test.ts --maxWorkers=1
# After: exit 0; 39 passed.
npm exec --yes --package=bun@1.3.14 -- node ../../scripts/run-vitest.ts bun \
  test/process-budget.test.ts --maxWorkers=1
# After: exit 0; 39 passed.
```

Other probes: merely moving the manager import earlier or disabling default
interop did not reproduce the failure. Temporary tagged instrumentation showed
2250 enumerable namespace keys, `ModuleKind` present/enumerable, and 2248 default
keys in the normal install. All instrumentation and import-order changes were
removed before the fix.

Genuine full gates after this patch and the current lifecycle tests:

- Node 26.12.0, Vitest 5.0.3, Istanbul, maxWorkers 1: 165 files pass,
  3518 tests pass and 8 skip.
- Bun 1.3.14, Vitest 5.0.3, maxWorkers 1: 164 files pass, one fails;
  3518 tests pass, one fails, 7 skip. Both process-budget cases pass.
- The remaining full-Bun failure is the existing #174 stack-location assertion
  in `workflow-runtime.test.ts`: expects `workflow.js:3:`, receives
  `workflow.js:4:23`. It was not weakened, skipped or changed. Full Bun is NOT green.
- Package lint/typecheck pass. No root-wide gate or inprocess suite claimed.

Raw diagnostic logs: `/tmp/lifecycle-budget-{node-before,bun-before,default-only-before,default-only-after,node-after,bun-after}.log`.
Raw full gate logs: `/tmp/lifecycle-wave3{,-bun-full,-lint,-types}.log`.
