# Coverage

The target is **100% of owned executable source lines AND functions**, measured by each
package's primary runner. Branches are reported, not gated. This is source coverage, not
proof that every behavior is asserted. Every subsequently closed gap needs a test that fails
without the change. Phase 0 adds accounting only, not tests for existing production gaps.

`coverage/policy.json` is the reviewed inventory and the only threshold policy. Its target is
zero uncovered lines/functions. Schema version 2 keys each signal's transitional `max_uncovered`
integer budgets by runner OS: `darwin` (`macos-14`) and `linux` (`ubuntu-24.04`), never rounded
percentages or platform averages. Windows and WSL coverage are **not measured**; the WSL scenario
job is not an owned-source coverage measurement. Unsupported OSes and missing selected-OS floors
fail closed, including when the global target is enabled. `enforce_target: false` is intentional; the final PR flips that field to
`true`, without changing the accounting implementation. That flip applies to primary signals;
independent runtime signals keep their own ratchets. Pending packages then fail, too.

## Independent signals

Clean local counts, report hashes and the measured +26-second (8.5%) serial runtime sample are
recorded [here](../coverage/receipts/phase0-macos.md). These local receipts are advisory evidence,
not hosted floors or a hosted-CI timing claim. Hosted artifact measurements and their independent
run comparison are recorded [here](../coverage/receipts/hosted-platforms.md).

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

Each package lists owned source files or source globs. A signal without a `files` subset expects
the entire expanded inventory after justified exclusions. Primary instrumentation includes must cover that inventory, including never-imported
modules. New source matched by a glob fails until instrumentation includes are updated.
Tests and dedicated test-helper directories are outside production scope by definition, not
coverage exclusions. Non-directory test fixture/assertion helpers use explicit `test-helper`
exclusions with reasons. The legacy `test_helpers` field remains readable for old base policies,
but the current policy uses reasoned exclusions. Do not place production code in test directories.

Production exclusions are limited to generated artifacts and genuine type-only declarations.
Every exclusion has a path (a glob is permitted for generated hashed artifacts), a `generated`,
`type-only` or genuine `test-helper` kind and a substantive reason. No UI, platform, error-path,
CLI or "hard to test" exemptions. Runtime enums/constants are executable source.
Review exclusions as carefully as code; the script cannot prove a human's justification.

Verification-only harnesses outside conventional test directories are classified under
`verification_helpers`, with an exact repository-relative `path` and a separate `reason` for
each file. Blanket globs, missing files, duplicate entries and overlap with owned production
source fail. Classification also applies to imported LCOV records. A verification label does
not waive the base-tree ratchet: moving previously owned production into this classification
still requires a reasoned `reclassifications` entry.

Shipped runtime code is NEVER a verification helper. In particular, computer-use's published
`setup-helper.mjs`, `build-native.mjs` and `src/platform/macos/helper-path.mjs` remain owned,
measurement-pending production source because computer-use has no standard coverage runner.
Its non-shipped `check-*.mjs` assertion scripts and `pi-cubench-agent.mjs` benchmark harness have
individual verification reasons, as does `scripts/router_contract.mjs`. Runtime builder scripts
and runnable workflow examples are explicitly pending source, not verification exemptions.
The generated stats CLI bundle has a reasoned generated-artifact exclusion; its original
`src/stats/cli.ts` remains owned and measured.

`computer-use` is explicitly **not measured, tracked**. Its custom platform/native scripts
continue running, but no invented instrumentation or 100% claim is made. Its TS entries and
native sources stay in inventory. A separate runner/instrumentation change is required before
the global flip. `dev-tools` is pending a clean cargo-suite baseline after #155; failed-run
reports are diagnostic artifacts only and never establish budgets.

Python `scripts/*.py` and `integration/harness/*.py`, boundary probes, executable providers and
producer configurations are named **measurement-pending** inventories, not silently omitted.
Existing Python gates are not coverage accounting: pytest-cov for `scripts/` and
`integration/harness/` is follow-up work. `benchmarks/comparison` already has pytest-cov at 90%
combined coverage and retains it; independent LCOV line/function accounting is still pending.
The declaration-only `integration/harness/__init__.py` has an explicit reasoned exclusion.
A repository-wide regression scan and the CLI audit tracked plus untracked nonignored TypeScript,
Python and executable JavaScript (`.mjs`, `.cjs`, `.js`) source using the same Git-listed traversal. Each executable file must be included in a measured/pending inventory or have an explicit
reasoned exclusion. Conventional test files are out of scope; arbitrary new implementation files
are not. There is no implicit `*.config.*` exemption: executable tool configurations need an
explicit owned/pending declaration or reasoned verification classification. Existing producer
configurations remain pending in the policy. All pending inventories are expanded and validated,
and block the final target flip.

## Add a source file

- Check that the new file matches its package's `owned` inventory; otherwise add it explicitly.
  Do not mark shipped runtime code as verification just because it lives under `scripts/`.
- For a measured package, update the primary producer's explicit includes so never-imported source
  still counts. For #161's `packages/subagents/src/model-selection.ts`, `src/**/*.ts` already owns
  the file, but the explicit list in `packages/subagents/vitest.config.ts` must include it too.
- Update an independent compatibility `files` list only when that declared suite actually reports
  the new file. Do not fabricate a report or merge compatibility counters with primary counters.
- Run `make check-scripts` to check source classification and producer inventory consistency;
  run the affected package's existing primary/declared compatibility invocations, then
  `make check-coverage BASE=origin/main`. Missing expected source fails closed. Keep fresh clean
  receipts and never raise uncovered budgets to accommodate new untested behavior.
- For a genuine non-shipped verification harness, add one exact `verification_helpers` entry with
  its own reason. For source removal, rename or role changes, follow the reclassification ledger
  below, including affected compatibility scopes.

## Run and ratchet

Run `make install`, then the existing tests (`make check-ts check-import-audit check-probes`).
Coverage is part of those invocations, not a second test pass. From the repository root:

```sh
make check-coverage BASE=origin/main
```

This consumes reports without executing tests, writes `coverage/summary.json`, and compares
each independent per-OS budget with `git show <base>:coverage/policy.json`. The default OS is
`sys.platform`; `--os darwin` or `--os linux` is explicit for artifact replay and tests. Raising
either uncovered counter on **any** OS, removing any previously declared OS floor or measured
package/signal, or disabling an enabled global target fails. The base ratchet checks both OSes,
not just the host running accounting. A missing selected-OS floor never falls back to the other OS. Only
the initial addition of a policy has no base counterpart; invalid Git bases still fail.

The second ratchet compares **expanded source membership**, not just budgets. The base policy
comes from `git show` and its globs expand against that base commit's `git ls-tree` paths, never
the current checkout. Current globs expand against the working tree. Shrinking `owned`, changing
a root, introducing an exclusion, moving source into fixture scope or shrinking a compatibility
`files` subset cannot hide an old file. Deletions and renames also count as membership losses.

A legitimate change needs a new entry in the policy's `reclassifications` ledger for each lost
repository-relative base path and scope, with a substantive reviewed reason:

```json
{
  "package": "example",
  "signal": "owned",
  "path": "packages/example/src/old.ts",
  "replacement": "packages/example/src/new.ts",
  "reason": "Rename the implementation while retaining measurement on its replacement."
}
```

Use `signal: "owned"` for production membership; compatibility subsets require their own named
signal entry when they lose membership too. For a deletion or genuine role change, omit
`replacement` (or use null). A replacement must exist in the current inventory for that scope.
Entries name exact files, not waiver globs. Old historical entries cannot authorize a new loss;
duplicate, unrelated or invalid new entries fail. Reclassification never permits budget increases
or an unsupported exclusion category. Review it as an explicit source-accounting change, not as a
way to exempt uncovered production behavior.

Reduce budgets only to clean-producer measured values. Missing reports or failed test producers
cannot establish floors. The initial hosted accounting failure exposed wrong local floors; its
complete reports came from successful test producers, so they establish the initial per-OS policy
before this PR introduces that policy to main. This is not permission to raise an existing main
floor. Keep measurement receipts with the policy update. A new package needs an owned inventory,
justified declaration exclusions, complete primary includes, text+LCOV producer wiring,
independent runtime signal if declared, and clean-run receipts before its budgets are accepted.
The command also rejects npm workspaces missing from policy.

## Refresh floors from hosted artifacts

Download each OS artifact from the same CI run, then print its measured counts and reviewable policy
diff (no policy files are modified, and measurement mode is explicitly **not a gate**):

```sh
gh run download <run-id> -R nredd/pi-harness -n coverage-ubuntu-24.04 -D /tmp/cov-linux
gh run download <run-id> -R nredd/pi-harness -n coverage-macos-14 -D /tmp/cov-darwin
uv run --locked --project integration python scripts/coverage_accounting.py --measure --os linux --reports-root /tmp/cov-linux --summary /tmp/measured-linux.json
uv run --locked --project integration python scripts/coverage_accounting.py --measure --os darwin --reports-root /tmp/cov-darwin --summary /tmp/measured-darwin.json
```

Use a checkout matching the artifact's production source and inventory. `--reports-root` reads the
artifact's repository-relative report paths while ownership validation uses that checkout. JSON
`measured_floors` contains each `package/signal -> OS -> {lines, functions}`; the logged unified diff
proposes only that OS's measured counters. Review it and edit the policy manually; it is never
written or auto-committed. `--measure` rejects `--base` so it cannot be confused with ratchet evidence.
Replay the artifact as a gate by dropping `--measure` and adding `--base origin/main`; the summary's
`measurement_only` is then false. Missing/inconsistent artifacts fail in either mode.

Compare **two independent hosted runs on different commits**, per package/signal/OS. Do not retry
until green or widen beyond observed counts. Investigate changed counters; fix nondeterminism or
retain the maximum actually observed per counter with a documented cause and follow-up issue.
Never average platforms or combine their maxima. Once the policy is on main, the base ratchet still
forbids raising it; measurement mode is diagnostic, not a bypass.

Linux in-process primary coverage in run `40441614924` is 25 uncovered lines / 8 functions versus
Darwin's 15 / 4. The entire delta is `integration/inprocess/support.ts` (21 / 5 versus 11 / 1);
`goal-support.ts` and `native-timers.ts` have identical counters. `isolateStackHome()` only spawns
`/usr/bin/caffeinate` on Darwin. Linux never invokes `stopWake()` or `exitedWithin()` and its timeout,
exit and Promise callbacks (lines 51-77), while macOS executes normal wake-helper teardown.
The `support.test.ts` sleep-assertion test explicitly skips outside Darwin: primary logs show
63 passed / 1 skipped on Linux versus 64 passed on macOS. Bun likewise skips that test and reports
37 / 5 versus 22 / 4. This is an intentional platform branch, not missing tmux or a Pi binary:
these real in-process sessions use the installed core harness and the remaining suites run on
both OSes. No wake path, source file or test assertion is excluded to hide the difference.

Existing `owned` CI jobs run accounting after tests even on failure, then upload independent
LCOV and JSON summary artifacts even if accounting fails. No required job names or protection
settings change. A failed earlier test may prevent later packages from running; their missing
reports correctly fail rather than pretending full coverage. Do not reuse stale local reports
to claim a clean gate.

The Python benchmark's existing combined line/branch 90% gate is unchanged. Instrumented runs
must not refresh performance baselines. Quiet-runner benches, WSL2 workspace coverage and live
platform/TCC checks are NOT RUN by this coverage gate. See [CI](ci.md) for platform boundaries.
