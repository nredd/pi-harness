# Plan-mode coverage attribution

This page records the #199 diagnosis before the subsequent
[final-guard closure](plan-mode-final-guards.md). Its counts and caller inventory are historical;
the ledger documents the dead-code removals and five defensive lines still open.

## Root cause and scope

The old `restoring Plan mode without helpers` test enters the inner missing-helper
catch and returns. It never reaches the outer restoration rollback catch at
`src/plan-mode.ts:1938-1949`. Its mutation failure proved the inner catch, not the
outer catch. Normal Istanbul source measurement was truthful, not a loader,
identity, or remapping failure.

Behavior-only tests now exercise the outer rollback and additional lifecycle failures.
Runtime source, distributed output, dependencies, configuration, measurement inventory,
exclusions and thresholds are unchanged. The temporary custom instrumentation probe
was removed: shared provider policy belongs to #162, not a second instrumenter here.

## Reproduce with the normal provider

From `packages/plan-mode`, with the matching Vitest/Istanbul provider installed:

```sh
../../node_modules/.bin/vitest run test/plan-mode-coverage.test.ts \
  -t 'restoring Plan mode without helpers' --maxWorkers=1 \
  --coverage --coverage.provider=istanbul --coverage.reporter=json \
  --coverage.include=src/plan-mode.ts
../../node_modules/.bin/vitest run test/plan-mode-attribution.test.ts \
  --maxWorkers=1 --coverage --coverage.provider=istanbul \
  --coverage.reporter=json --coverage.include=src/plan-mode.ts
```

Inspect `coverage/coverage-final.json`: locate the sole entry ending in
`/src/plan-mode.ts`, then compare `statementMap` locations and their `s` counts.
The old test has zero hits for the outer rollback; the attribution tests hit its
state restoration, thinking restoration, owner release and rethrow statements.
No instrumenter wrapper or private closure invocation is needed.

Full single-source report and package gates:

```sh
VITEST_MAX_WORKERS=1 npm run check
node ../../scripts/run-vitest.ts bun --maxWorkers=1
../../node_modules/.bin/vitest run --maxWorkers=1 \
  --coverage --coverage.provider=istanbul --coverage.reporter=json \
  --coverage.reporter=lcov --coverage.include=src/plan-mode.ts
```

Measured #199 base (`83a10bc`): **940/952 lines, 153/155 functions**, only for
`src/plan-mode.ts`. This is NOT whole-package 100% or coverage completion.
Gate execution and temporary-mutant command receipts belong in the PR comment,
not in a tracked workstation process log.

## Logical mutation proofs

Each row describes a temporary runtime mutation, the public entry exercised and
the assertion that must turn red. Source is restored byte-exact after each run.
The PR receipt records commands and observed failures, separately from coverage.

| Temporary mutation | Public test path | Required red meaning |
| --- | --- | --- |
| Omit outer restoration owner release | Session resume with thinking failure | Contender stays busy instead of becoming free |
| Replace outer rethrow with a new error | Same resume | Exact original error identity fails |
| Omit outer thinking restoration | Same resume; first setter applies then throws | Thinking remains high instead of prior low |
| Omit manual thinking setter | Resume with persisted manual override | Medium is not reapplied |
| Admit helpers after active registry throws | Start with throwing active registry | Expected activation rejection is missing |
| Retain enabled state on new activation rollback | Start with thinking failure | Helper gate is not inactive |
| Omit new activation owner release | Same start | Contender stays busy |
| Rethrow stale presentation error | Complete, then agent settled | Stale context escapes instead of being contained |
| Swallow every presentation error | Same handler with non-stale error | Exact rejection is missing |
| Ignore failed Normal publication | Start, then off with throwing publication | Active status/ownership is lost |
| Invent a safe read tool after registry failure | Start, then read tool call | Read is admitted instead of blocked |
| Admit unknown tool | Same tool-call handler | Unknown tool is not blocked |
| Omit surviving debounce reload | Ready watcher burst, real settings file | Surviving deadline starts no read |
| Replace loaded high with low | Same real-read path | Surviving reload fails to apply high |
| Pass the wrong model to throwing setter | Restored implementation application | Recorded attempted model differs from target |
| Retain completed presentation intent | Complete, settle twice | Menu presents twice instead of once |

The runtime application failure matrix checks lookup, missing model, negative/throwing
authentication, throwing model application and throwing thinking application. Model
application records the attempted model before throwing and asserts exactly one call
with that model, including after subsequent input. Persisted consumption and warnings
are checked independently. The watcher uses an independent expected 75ms window and a
real-read positive control; it does not enlarge native watcher timeouts.

## Remaining caller inventory

At that #199 base, twelve lines and two functions were uncovered. The subsequent
[final-guard ledger](plan-mode-final-guards.md) records their dispositions and current counts:

```text
Lines: 1210,1211,1396,1397,1483,1511,1512,1517,1518,1609,1650,1659
Functions: computePlanModePolicyToolNames @1608; anonymous_121 @1650
```

| Lines | Supported caller investigation still needed |
| --- | --- |
| `1210-1211` | Direct implement rejects missing plans before `startImplementation`; investigate menu callback callers |
| `1396-1397` | Caller enters `showActivePlanMenu` under `hasUI`; internal no-UI fallback cannot run with stable capability |
| `1483/1609` | Disabled tool admission returns before policy; status summary only calls policy while enabled |
| `1511-1512/1517-1518` | Generation transitions synchronously reset pending policy; demonstrate a real stale-policy lifecycle |
| `1650/1659` | Active application/admission short-circuits same-session queue predicate; session replacement clears queues; investigate supported cross-session partition |

These are not exclusion recommendations. No synthetic private entry, source deletion,
measurement change, or sub-100 enforcement approval follows from this diagnosis.
