# Runtime tooling and workflow example producers

Historical local development receipt on native Darwin, 2026-10-29. It describes the
then-partial policy state only and does not establish hosted floors or complete #229.
At that timestamp, `enforce_target` remained false, the Linux native-Darwin
resource-sampler floor was 47 lines / 8 functions, and both eligible inventories were
pending. Full Bun producer promotion was not included. The final local integration
receipt is [here](issue-229-final-local.md).

Execution:

- `npm ci --ignore-scripts`: installed the locked workspace dependencies.
- `npm run check --workspace @nredd/pi-plan-mode`: passed Biome, TypeScript, runtime
  build, 8 runtime-builder tests, 629 primary tests and 8 Bun tests. Primary source
  lines/functions remain 2996/2996 and 699/699.
- `npm run check --workspace @nredd/pi-subagents` with a fresh process-start `HOME`
  and `PI_CODING_AGENT_DIR`: passed Biome, TypeScript, 3727 primary tests / 8 skips,
  26 dedicated example tests, 31 native Bun tests and 10 Bun real-loader tests.
  Primary source remains 7175/7175 lines and 1422/1422 functions.
- `uv run --locked --project integration pytest scripts/tests/test_coverage_producers.py
  scripts/tests/test_coverage_accounting.py scripts/tests/test_coverage_facades.py
  -c scripts/pyproject.toml -p no:cacheprovider`: 56 passed.
- Actual `Policy` parsing, repository-wide `audit_inventory`, `check_ratchet`,
  `check_inventory_ratchet` against `origin/main` (`1723653`) and `scoped_records`
  validation of both new reports and subagents primary: passed. The report records
  exactly match the expanded inventories, with no missing or unexpected source.

Independent reports, not merged with primary source:

| Producer | Files | Lines hit / total | Functions hit / total | LCOV SHA-256 |
| --- | --- | --- | --- | --- |
| `test:dist` | 2 | 110 / 119 | 17 / 17 | `a0f222269b3279bb8003a4d69a88a71a534f0780b0e7844a280aeac99d23d741` |
| `test:workflow-examples` | 6 | 64 / 68 | 14 / 14 | `cd47bf4dea58398b653a315d16a940621ef74a89fe21b423b0c2953a393b7ef4` |

Failure-path evidence:

- Before repair, 26 example tests passed without coverage, but the dedicated producer
  failed parsing `compose.js` during uncovered-file instrumentation: its VM counters
  had been merged into `__coverage__`, not Vitest 5's `__VITEST_COVERAGE__` store.
- Merging examples unconditionally into that store polluted the ordinary primary
  report. The dedicated producer now opts into the merge; the primary suite keeps
  an independent local map for assertions and emits only its declared source.
- The initial throwing-getter regression stayed green under an unconditional-read
  mutation: Node's contextified global swallowed the getter exception. Replaced it
  with an uncloneable getter result. Forcing `if (true)` in place of
  `if (workerData.collectCoverage)` then failed the default-path regression
  (`status: failed` instead of `completed`). Restored the guard; the full suite passed.
- Instrumenting only `body.slice(extractMeta(script).metaEnd)` failed the metadata
  coverage assertion with 25 passed / 1 failed. Restored full validated-body
  instrumentation; all 26 passed.
- The first non-isolated subagents run read local model-tier settings and failed 27
  tests with `Model tier @default is unavailable`. A fresh process-start home fixed
  that setup problem; no live configuration was edited.

Not run: a competing root `make check`, local stack scenarios, hosted producers,
protection changes, pins, activation or auto-merge. The parent serializes the combined
release-fix root gate. The additional lockfile audit reports the existing moderate
`@hono/node-server` advisory `GHSA-rmxm-3fg6-px4f`; this change does not repair or waive it.
