# Facade classification and hosted failure diagnosis

Follow-up to integration checkpoint `71b0aea29173d56b181551b7579ff7557c500a24`.
No global-target or Bun-enforcement flip, no failed/partial-run baseline accepted.

## Plan-mode source and emitted behavior

`src/index.ts` contains only:

```ts
export { default } from "./plan-mode.js";
```

`src/interactive-ui.ts` contains five static named re-export declarations for six menu bindings.
There are no expressions, initializers, functions, calls or executable declarations in either file.
ESM linking still resolves/evaluates the target graph; its implementation belongs to the target
modules, all of which remain owned and instrumented. The runtime builder emits ESM (`format: "esm"`,
`target: "es2022"`), not CommonJS binding wrappers.

The regression uses the real locked esbuild `transformSync` (`loader: "ts"`, `format: "esm"`,
`target: "es2022"`) and Vitest's actual `@vitest/istanbul-lib-instrument` `createInstrumenter`.
Both original TypeScript facades and emitted ESM have empty statement, function and branch maps:
zero executable Istanbul lines/functions, not uncovered executable logic. This explains absent LCOV
records; no LF/FNF record is synthesized.

Policy classifications are exact `non-executable-facade` entries with individual reasons, not globs.
Every current inventory expansion validates the entire file against a narrow static named
re-export grammar. Only whitespace plus local named `export { ... } from "./...js";` declarations
are accepted. A call, import, initializer, function, export assignment, attribute, comment or other
syntax invalidates the classification. Unsupported syntax is not assumed safe. Targets remain in
primary instrumentation. Base-relative inventory-loss declarations remain mandatory when a base
policy exists.

`test_coverage_facades.py`: 16 regressions, including real source/emitted-code instrumentation,
valid named/aliased re-exports, eight executable/unsupported additions and four invalid paths.
Two additional base-tree ratchet regressions require exact reclassification receipts for facade
membership changes; an explanatory facade exclusion cannot silently shrink an established scope.
The post-change plan-mode `check` passes: dist tests 8, primary 539, native Bun scenarios 8;
Biome/typecheck/build pass. Coverage accounting no longer reports either barrel missing.

## Hosted run 40706379839

Linux owned job [here](https://github.com/nredd/pi-harness/actions/runs/40706379839/job/122879604065).
All TypeScript workspace producer suites completed successfully, including the Linux dev-tools
suite (this does NOT replace the pending macOS/dev-tools #155 baseline).

The actual owned-gate failure is NOT missing facade coverage or a cargo failure: the subsequent
scripts gate failed `test_current_bun_policy_is_explicit_and_links_migration`, which requires the
standing Bun explanation to mention `enforced`. Four full-suite reasons had been clarified without
that word. Result: `1 failed, 860 passed`; `make check-scripts` stopped before its import-audit
producer, and integration/probe gates were not reached. This follow-up restores explicit promotion
wording without changing enforcement, assertions or the test's requirement.

Downloaded `coverage-ubuntu-24.04`, artifact `12823319931`, 295665 bytes, source HEAD `71b0aea2`.
GitHub artifact digest:
`sha256:8a7a72a01b9cd5d8b4e8e9901346baa5c5c0ed507542116b021d02ef1d8ee4d8`.
Artifact replay uses identical product source with only the validated facade classification corrected:

```sh
uv run --locked --project integration python scripts/coverage_accounting.py \
  --measure --os linux --reports-root /tmp/cov-phase0-hosted-linux \
  --summary /tmp/cov-phase0-hosted-linux-measure.json
```

Measurement exits 1 because `scripts/coverage/primary/lcov.info` and
`integration/probes/coverage/primary/lcov.info` are absent. Accounting correctly refuses a complete
receipt. This partial artifact is diagnostic only: **no policy counters changed**. macOS owned
remained queued with no coverage artifact at inspection; do not substitute local Darwin receipts.

Diagnostic uncovered lines/functions, NOT accepted floors:

| Signal | Old Linux floor/reference | Hosted diagnostic | Cause to review on complete rerun |
| --- | ---: | ---: | --- |
| plan-mode/primary | 555/138 | 191/45 | V8 -> Istanbul, validated zero-statement facades |
| plan-mode/bun | 3479/245 | 3479/245 | Native subset unchanged |
| preset/primary | 19/12 | 8/10 | V8/Jiti corruption -> Istanbul |
| preset/bun | 244/15 | 8/10 | Native -> full Vitest/Istanbul |
| resource-sampler/primary | 31/2 | 83/11 | Main adds Darwin/native counter paths and source inventory |
| resource-sampler/bun | 46/8 | 83/11 | Full suite/Istanbul plus main source/inventory |
| session-kit/primary | 110/32 | 110/32 | Same transitional primary floor |
| session-kit/bun | 859/114 | 860/114 | Main monitor model/source changes; still native subset |
| subagents/primary | 500/68 | 513/75 | Main home injection, tiers and fleet implementation/inventory |
| subagents/bun | 7728/512 | 7743/522 | Main source/inventory; still native subset |
| subscription-router/primary | 20/4 | 0/0 | Main #181 closes existing gaps |
| subscription-router/bun | 226/31 | 0/0 | Full suite/Istanbul plus main gap-closing tests |
| todo/primary | 120/20 | 15/5 | V8/Jiti corruption -> Istanbul, main home injection |
| todo/bun | 936/71 | 15/5 | Native subset -> full Vitest/Istanbul |
| inprocess/primary | 25/8 | 25/8 | Same Linux platform behavior |
| inprocess/bun | 37/5 | 27/8 | Native -> full Vitest/Istanbul |

Required next evidence: a complete successful producer artifact for each OS after the scripts fix,
measure + replay, and independent-run comparison before changing the historical per-OS counters.
Dev-tools stays pending #155. Primary budgets remain enforced; local macOS observations are advisory.

## Local follow-up gates

- `make check-scripts`: Ruff formatter/linter and ty clean, 879 pytest tests passed, import-audit
  Biome/strict TypeScript checks and 8 real Node tests passed. Includes schema/source inventory,
  producer configuration checks and all facade regressions.
- Plan-mode full `check`: passed as listed above, using official pinned Bun 1.3.14 and Node 26.12.0.
- `make check-coverage BASE=origin/main`: only historical primary-floor excess remains locally:
  sampler 72/6, session-kit 111/31, subagents 507/72. No missing facade or invalid-report errors.
- No local counter is promoted to a hosted floor. No publication, promotion, activation, rebase
  or force push performed.
