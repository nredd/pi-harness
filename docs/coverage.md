# Coverage

The target is **100% of owned executable source lines AND functions**, measured by each
package's primary runner. Branches are reported, not gated. This is source coverage, not
proof that every behavior is asserted. Every subsequently closed gap needs a test that fails
without the change. Phase 0 adds accounting only, not tests for existing production gaps.

`coverage/policy.json` is the reviewed inventory and the only threshold policy. Its target is
zero uncovered lines/functions. Transitional `max_uncovered` budgets are integer counts, not
rounded percentages. `enforce_target: false` is intentional; the final PR flips that field to
`true`, without changing the accounting implementation. That flip applies to primary signals;
independent runtime signals keep their own ratchets. Pending packages then fail, too.

## Independent signals

Clean local counts, report hashes and the measured +23-second (7.7%) serial runtime sample are
recorded [here](../coverage/receipts/phase0-macos.md). This is not a hosted-CI timing claim.

The accounting script consumes LCOV, not runner APIs. Primary reports currently come from
Vitest/V8, except `subagents` uses Istanbul: real Pi reloads produce demonstrably wrong V8
merges there. The `node --test` import-audit and probe helpers use c8. Those verification
utilities and the in-process host are tracked alongside the production packages.

Every declared `test:bun` command also emits an independent `bun` LCOV signal. These are
compatibility-suite measurements, NOT the owned-source denominator: Bun 1.3.14 omits
never-imported files. The policy explicitly lists the files currently measured by each signal;
missing expected files fail. Files outside that Bun subset remain mandatory in primary
coverage. Imported sibling production source and dedicated test/helper directories are outside
that package's signal. Unknown production report paths fail. Never merge JSC, V8 and Istanbul
counters or average platforms. Replacing producers with a single Bun runner later only changes
the producer wiring and reviewed signal inventory, not the accounting algorithm (issue #160).

Bun's `coverageThreshold` is bypassed by **lcov-only** reporting on pinned 1.3.14: a 50%-function
fixture exits 0 with `lcov`, and nonzero with `text` plus `lcov`. Both reporters are mandatory
in signal declarations and actual `test:bun` commands. `scripts/tests/test_coverage_producers.py`
executes that reproduction with the pinned Bun and checks producer commands. Do not remove
`text` as a cosmetic CI cleanup. Generic LCOV accounting independently enforces integer budgets.
LCOV producers may emit aggregate-only function totals; those must be internally consistent.
Signed branch hit counts are retained as reported-only diagnostics, never used to gate lines or
functions. Missing/empty reports, inconsistent counters, zero total owned lines, unknown files
and absent expected source all fail closed.

## Inventory and exclusions

Each package lists owned source files or source globs. A signal without a `files` subset expects the entire expanded inventory after justified
exclusions. Primary instrumentation includes must cover that inventory, including never-imported
modules. New source matched by a glob fails until instrumentation includes are updated.
Tests and dedicated test-helper directories are outside production scope by definition, not
coverage exclusions. Non-directory helper paths are explicitly named in `test_helpers`; they
cannot overlap that package's owned inventory. Do not place production code in those directories.

Only generated artifacts and genuine type-only declarations may be excluded. Every exclusion
has a path (a glob is permitted for generated hashed artifacts), a `generated` or `type-only`
kind and a substantive reason. No UI, platform,
error-path, CLI or "hard to test" exemptions. Runtime enums/constants are executable source.
Review exclusions as carefully as code; the script cannot prove a human's justification.

`computer-use` is explicitly **not measured, tracked**. Its custom platform/native scripts
continue running, but no invented instrumentation or 100% claim is made. Its TS entries and
native sources stay in inventory. A separate runner/instrumentation change is required before
the global flip. `dev-tools` is pending a clean cargo-suite baseline after #155; failed-run
reports are diagnostic artifacts only and never establish budgets.

## Run and ratchet

Run `make install`, then the existing tests (`make check-ts check-import-audit check-probes`).
Coverage is part of those invocations, not a second test pass. From the repository root:

```sh
make check-coverage BASE=origin/main
```

This consumes reports without executing tests, writes `coverage/summary.json`, and compares
each independent budget with `git show <base>:coverage/policy.json`. Raising either uncovered
budget, removing a measured package/signal or disabling an enabled global target fails. Only
the initial addition of a policy has no base counterpart; invalid Git bases still fail.
Reduce budgets only to clean-run measured values; do not regenerate them from a failed run.
Keep measurement receipts with the policy update. A new package needs an owned inventory,
justified declaration exclusions, complete primary includes, text+LCOV producer wiring,
independent runtime signal if declared, and clean-run receipts before its budgets are accepted.
The command also rejects npm workspaces missing from policy.

Existing `owned` CI jobs run accounting after tests even on failure, then upload independent
LCOV and JSON summary artifacts even if accounting fails. No required job names or protection
settings change. A failed earlier test may prevent later packages from running; their missing
reports correctly fail rather than pretending full coverage. Do not reuse stale local reports
to claim a clean gate.

The Python benchmark's existing combined line/branch 90% gate is unchanged. Instrumented runs
must not refresh performance baselines. Quiet-runner benches, WSL2 workspace coverage and live
platform/TCC checks are NOT RUN by this coverage gate. See [CI](ci.md) for platform boundaries.
