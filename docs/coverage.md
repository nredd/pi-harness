# Coverage

Owner scope: the 100% line/function goal covers `subagents`, `plan-mode`, `todo`,
`session-kit`, `resource-sampler`, `subscription-router`, `preset` and `dev-tools`, plus the
`runtime-build-tooling`, `workflow-examples`, `import-audit` (`scripts/import_audit.ts`, 0/0 since #321) and
`probes` (every executable `integration/probes` source, 0/0 since #377) signals.
`goal: "100-percent"` is the default and cannot be downgraded relative to an established
base policy. Eligible package tooling/examples remain pending goal blockers, not hidden source.
`goal: "report-only"` identifies verification infrastructure (helpers, inprocess and
producer configurations). `goal: "excluded"` records the owner's computer-use
coverage-maintenance exclusion. Both require a nonblank
`goal_reason`; neither removes any source from the inventory audit. Measured signals outside the
goal must be report-only and still require complete, valid reports and per-OS references.
`goal: "ratchet"` (owner decision on #314, reusable by #321) is the one mode outside the zero target
that is enforced: a measured package whose enforced signals hold their per-OS `max_uncovered` as a
floor. The target is not applied, and floors only go down (the existing enforced-to-enforced ratchet).
A package cannot leave `ratchet` except to graduate to `100-percent`, an enforced signal cannot go report-only without a reasoned
`enforcement_changes` entry, and a `ratchet` package must be measured with at least one enforced
signal. The rule keeping `excluded`/`report-only` signals report-only is unchanged. A floor is a new
enforced signal, not an allowance or waiver: it is the measured count on a named commit and OS.

The initial integration checkpoint is recorded [here](../coverage/receipts/main-integration.md).
Facade validation and the actual hosted producer failure diagnosis are recorded
[here](../coverage/receipts/facade-followup.md). Git fixture isolation, both hosted artifacts and the
#155 -> #195 dev-tools dependency decision are recorded [here](../coverage/receipts/git-isolation.md).
Final hosted closure and per-OS receipts are recorded [here](../coverage/receipts/final-closure.md).
All eight primary packages have zero uncovered lines/functions on macOS and Linux. Until #375,
Linux missed 47 lines / 8 functions in resource-sampler's native `darwin.ts` paths under a
`target_allowances` entry. `nativeCalls` now takes an injectable host (`platform`, `arch`,
`versions.bun`, `getBuiltinModule`, defaulting to `process`), so recording fakes of `bun:ffi` and
`node:ffi` drive both adapters, and a fake `NativeCalls` drives the per-PID loop, on every OS. The
real libproc path still runs on macOS. Accounting no longer supports `target_allowances`: the
current policy rejects the key, and only the base-policy read drops it so a ratchet against an
older commit still parses.
`enforce_target` is enabled now that eligible runtime tooling/examples are measured with complete
primary reports. Their source-complete
producers now emit `packages/plan-mode/coverage/runtime-build-tooling/lcov.info` from `test:dist`
and `packages/subagents/coverage/workflow-examples/lcov.info` from `test:workflow-examples`.
Workflow examples are instrumented only after metadata validation, including their literal metadata
initializers, then executed by the real worker/VM with nested scripts sharing counters. Collection is
opt-in: ordinary workflows never inspect or transport `globalThis.__coverage__`. The dedicated producer
merges VM counters into Vitest 5's `__VITEST_COVERAGE__` store; the ordinary primary suite keeps its
`src`-only report separate. These source-complete reports can still contain uncovered paths, not an
invented 100% result. Their local zero-floor measurement enables enforcement; clean hosted macOS and
Linux final-HEAD receipts remain required acceptance evidence. The measured per-OS primary floors are enforced now; branches stay
report-only, and Bun signals follow their own declared enforcement (see below). The conflict-resolution decisions and exact
base-relative facade ledger regression for the `b51e177` main merge are recorded
[here](../coverage/receipts/tier-main-merge.md).

The target is **100% of owned executable source lines AND functions**, measured by each
package's primary runner. Branches are reported, not gated. This is source coverage, not
proof that every behavior is asserted. Every subsequently closed gap needs a test that fails
without the change. Phase 0 adds accounting; the final integration also tests worker-error settlement and remaining
cross-platform collector paths without removing guards.

`coverage/policy.json` is the reviewed inventory and the only threshold policy. Its target is
zero uncovered lines/functions. Schema version 2 keys each signal's transitional `max_uncovered`
integer budgets (or report-only reference numbers) by runner OS: `darwin` (`macos-14`) and
`linux` (`ubuntu-24.04`), never rounded
percentages or platform averages. The `owned (wsl2)` cell's shards run the same producers inside Ubuntu
on WSL2 and the cell is explicitly **Linux-like, enforced**: its Ubuntu fan-in accounts the reports
against the existing Linux floors, as the macOS fan-in passes `COVERAGE_OS=darwin` for the darwin ones (each from the plan's `coverage_os`). Native Windows coverage is not measured. WSL contract scenarios
remain separate acceptance evidence, not owned-source coverage. WSL reports are preserved as
`coverage-wsl2`, never merged with or averaged into `coverage-ubuntu-24.04`. Unsupported OSes and missing selected-OS floors
fail closed, including when the global target is enabled. `enforce_target: true` applies after every
eligible pending inventory is measured, and holds every eligible primary signal to zero on every
OS with no per-file or per-OS exception. That flip applies to primary signals;
independent runtime signals retain their declared enforcement modes. Primary signals of eligible packages always remain
`enforced`; the 100% goal is measured by PRIMARY signals, not the Bun compatibility subset.
Eligible pending packages then fail, too; owner-excluded/report-only domains do not.

## Independent signals

Clean local counts, report hashes and the measured +26-second (8.5%) serial runtime sample are
recorded [here](../coverage/receipts/phase0-macos.md). These local receipts are advisory evidence,
not hosted floors or a hosted-CI timing claim. Hosted artifact measurements and their independent
run comparison are recorded [here](../coverage/receipts/hosted-platforms.md).

The accounting script consumes LCOV, not runner APIs. Primary reports use Istanbul for `subagents`, `plan-mode`, `todo` and `preset`.
Real Pi/Jiti reloads collide with Vitest-generated scripts at identical source URLs and corrupt
V8 attribution. The preset and todo diagnoses demonstrate false misses and false hits; preserve
real-loader tests rather than deleting assertions to repair counters. Istanbul credits instrumented
Vitest transforms, not independent Jiti-only execution. Dev-tools also uses Istanbul, following #195, with all 23 executable modules explicitly included.
Its static `src/core/index.ts` facade is validated by real source/emitted-ESM instrumentation.
Other primary producers retain V8. Since #347 that includes the import-audit and probe helpers:
`scripts/vitest.config.ts` and `integration/probes/vitest.config.ts` replace c8 + `node --test`, run
through `scripts/run-vitest.ts node --coverage` with the shared home guard. Vitest transforms and
runs the measured source itself, so Node's compile cache no longer reaches it: the
`NODE_DISABLE_COMPILE_CACHE=1` that c8 needed (#321) is gone, and the measured counters are unchanged with
`NODE_COMPILE_CACHE` exported. Vitest coverage does not follow child processes, which c8 did, so the
import-audit CLI runs in process through `main()` as well as through the real subprocess; the
one-line `import.meta.main` dispatch is asserted only by the subprocess tests.
`import-audit` and `probes` are in the goal and enforced at 0/0. Since #377 `probes` measures every
executable probe in process under `check-probes`: `transcript-types.ts`, `render.ts` (its
`/harness-probe` command against a recording TUI), the `pi -e` extensions `latency.ts`,
`session-kit-child-scope.ts` and `stack-resources.ts` registered against recording `ExtensionAPI`
fakes (`stack-resources.ts` drives the real package manager over a disposable preset), and the
`anthropic-block-types.mjs` CLI, re-imported per test with its own argv against the installed pi-ai
build, a misclassifying fake build and no argument. `latency.test.ts` fakes only the probe's `/proc`
reads, and runs every clock it reads (timers, `Date`, `performance.now()`) on fake timers, with its
`Atomics.wait` self-test stall advancing the fake clock instead of blocking. The Linux mount/WSL path
and the non-Linux fallback both run on every OS, and no reading depends on real time or load. With those five files in `coverage.include` and no new tests, darwin on `f2d607eb`
left 182 of 291 lines and 46 of 63 functions uncovered; with the tests it is 0/0. The
`probe-boundaries` pending package and the `anthropic-block-types.mjs` `verification_helpers` row
are gone. The counters changed with the producer, the floors did not: c8 counted every
physical line and only the functions V8 reported (`transcript-types.ts` 207 lines / 8 functions,
`import_audit.ts` 161 / 7), Vitest's AST-based V8 remap counts statement lines and every function
including anonymous callbacks (`transcript-types.ts` 103 / 15, `import_audit.ts` 63 / 8 with the new
`main`). Both are 0 uncovered on darwin and linux before and after.

Every declared `test:bun` command also emits an independent `bun` LCOV signal. Nine Bun signals
are measured. `plan-mode`, `preset`, `subscription-router` and `todo` are `enforced` at 0/0 on darwin
and linux since [#320](https://github.com/nredd/pi-harness/issues/320): full suite, full primary
inventory, 0/0 in their own PRs' hosted macos-14 and ubuntu-24.04 artifacts (receipts
[here](../coverage/receipts/bun-enforced.md)). `resource-sampler` is `enforced` at 0/0 on
darwin and linux since [#375](https://github.com/nredd/pi-harness/issues/375), which closed its
darwin 8/4 and linux 47/8 Bun misses with the same fake-host FFI tests as primary. The other four
explicitly declare `enforcement: "report-only"`, with a
mandatory nonblank `reason` and a link to [#160](https://github.com/nredd/pi-harness/issues/160).
Their stored `max_uncovered` values are advisory references, not enforced budgets. An omitted `enforcement` defaults to
`enforced` for backwards-compatible primary/base-policy reading; current Bun declarations never
rely on that default. Native `bun test` subset measurements are NOT the owned-source denominator:
Bun 1.3.14 native coverage omits never-imported files. Full Vitest-on-Bun producers now use
Istanbul for router, preset, sampler, todo, plan-mode and inprocess through `scripts/run-vitest.ts bun`.
They inherit the full explicit primary instrumentation inventory (no `files` subset). The launcher's
`bun` engine appends the provider, the `text` and `lcov` reporters (Vitest's dotted options) and
`coverage/bun`, so each `test:bun` passes only package arguments. The sampler retains one
worker. Inprocess stays report-only until a later #320 slice.
Subagents retains its native subset plus main's guarded real-loader gate; coverage is
disabled for that extra canary so it cannot overwrite Node's primary report. The policy explicitly lists the files currently measured by each signal;
missing expected files fail. Files outside that Bun subset remain mandatory in primary
coverage. Imported sibling production source and dedicated test/helper directories are outside
that package's signal. Unknown production report paths fail. Never merge JSC, V8 and Istanbul
counters or average platforms. Replacing producers with a single Bun runner later only changes
the producer wiring and reviewed signal inventory, not the accounting algorithm (issue #160).

The policy decision's roughly **1-7%** small-subset characterization must not be mistaken for a
measured source-coverage percentage or a universal suite ratio. Historically, hosted run `40455349710`
measured 8 Bun tests versus 539 primary tests for plan-mode (1.5%), 22 versus 3078 for subagents (0.7%)
and 2 versus 387 for todo (0.5%), before #320 moved plan-mode and todo onto their full suites under
Bun. There are exceptions: preset runs its whole suite under Bun (173
tests on both engines, `npm run check -w @nredd/pi-preset` at `dcc7903b`), and the in-process host
runs the same 64 cases (one intentionally skipped on Linux). Other package ratios also differ.
LCOV imported-file denominators and JSC/V8/Istanbul executable counters differ, so these
test-count ratios cannot be presented as percentages of production source covered.

A strict uncovered-count Bun ratchet penalized primary-tested source additions that the small Bun
suite never exercises: after main #153, subagents Bun rose from 7728/512 to 7763/515 uncovered
lines/functions on both OSes while primary stayed 500/68. Report-only avoids that ergonomics trap
without calling absent source covered. Every report is still required, parsed and validated;
missing/empty/malformed reports, missing expected files and inventory losses still fail closed.
Counts and signed deltas from the stored per-OS references appear in logs and the JSON `signals`
map. Report-only excess never fails accounting; its reference-number changes are not a budget
ratchet. Per-OS reference membership is still required, and branches remain report-only everywhere.

Flip a package's Bun signal to `enforced` **only when its full suite runs under Bun on both owned
OSes and its Bun inventory covers every owned executable source file**, including never-imported
modules through explicit import-all/instrumentation. A green compatibility subset alone is not
that evidence, even when its test count matches primary. Follow #160's reviewed migration spec;
record complete-source receipts before establishing enforced Bun floors. Accounting rejects an
enforced Bun signal whose file subset omits owned source. Enforced-to-enforced budgets ratchet;
a report-only-to-enforced promotion establishes the new complete-source floor.

Bun 1.3.14 bypassed `coverageThreshold` with **lcov-only** reporting. Pinned 1.4.4 repairs this:
a 50%-function fixture exits nonzero with either `lcov` or `text` plus `lcov`. Both reporters remain mandatory
in signal declarations, the launcher's Bun arguments and native `bun test` commands.
`scripts/tests/test_coverage_producers.py` executes that reproduction with the pinned Bun, runs the
real launcher against a recording `bun` to pin its appended arguments, and checks that Vitest-on-Bun
manifests pass only package arguments. Do not remove
`text` as a cosmetic CI cleanup, even for report-only signals. Generic LCOV accounting independently
enforces integer budgets for `enforced` signals only; producer declarations and the real pinned-Bun
threshold-enforcement reproduction remain mandatory in either mode.
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

Production exclusions are limited to generated artifacts, genuine type-only declarations and
validated non-executable ESM facades. Every exclusion has a path (a glob is permitted for generated
hashed artifacts), a `generated`, `type-only`, `non-executable-facade` or genuine `test-helper` kind
and a substantive reason. No UI, platform, error-path,
CLI or "hard to test" exemptions. Platform-specific code is covered on every OS through injected
seams: resource-sampler's Darwin FFI source is in both its inventory and LCOV report on Linux, at 0/0.
Runtime enums/constants are executable source.
Review exclusions as carefully as code; the script cannot prove every human justification.

`non-executable-facade` requires an exact package-relative `.ts` path already matched by `owned`.
Accounting reads the file on every inventory expansion and accepts only a deliberately narrow
whole-file grammar: one or more static named `export { bindings } from "./local.js";`
declarations (including `default`/aliases, inline type bindings and trailing commas), plus whitespace.
Local `.ts` specifiers are also accepted for dev-tools' existing barrel. Comments, imports, export assignments,
initializers, functions, attributes and all other syntax fail closed. Adding executable code requires
removing the classification and restoring instrumentation, not widening the facade grammar.
Plan-mode's `src/index.ts` and `src/interactive-ui.ts` qualify: esbuild's emitted ESM and the actual
Vitest Istanbul instrumenter both have zero statement/function/branch maps for these files. They
link bindings; their target modules remain fully owned and instrumented. No LF/FNF records are
invented, no imported dependency execution is attributed to a facade, and membership reclassification
still requires the base-relative ledger once a base policy exists. The current ledger explicitly
accounts for both owned plan-mode facade paths and the Bun subset that existed at integration
base `71b0aea` (the Bun signal now measures the full owned inventory, #320); an attributed policy/path snapshot in
`scripts/tests/fixtures/coverage/plan-mode-integration-base.json` reconstructs that package's base
membership in disposable Git and rejects deleting any one receipt. That pre-squash PR object is
not reachable from main, so tests do not require it in fresh hosted clones. The fixture copies
current source bytes only to exercise real tree expansion, not to assert historical runtime behavior
or establish budgets. CLI accounting still ratchets the entire repository against the actual PR base.
Real compilation/instrumentation
and executable-addition rejection are pinned by `scripts/tests/test_coverage_facades.py`.

Verification-only harnesses outside conventional test directories are classified under
`verification_helpers`, with an exact repository-relative `path` and a separate `reason` for
each file. Blanket globs, missing files, duplicate entries and overlap with owned production
source fail. Classification also applies to imported LCOV records. A verification label does
not waive the base-tree ratchet: moving previously owned production into this classification
still requires a reasoned `reclassifications` entry. Root-level `.test.mjs` files such as
`scripts/check-biome-paths.test.mjs` need their own verification-helper entry; classifying the
implementation helper does not implicitly classify its regression test.

Shipped runtime code is NEVER a verification helper. In particular, computer-use's published
`setup-helper.mjs`, `build-native.mjs` and `src/platform/macos/helper-path.mjs` remain owned,
measurement-pending production source because computer-use has no standard coverage runner.
Its non-shipped `check-*.mjs` assertion scripts and `pi-cubench-agent.mjs` benchmark harness have
individual verification reasons, as does `scripts/router_contract.mjs`. Runtime builder scripts
and runnable workflow examples are explicitly pending source, not verification exemptions.
The generated stats CLI bundle has a reasoned generated-artifact exclusion; its original
`src/stats/cli.ts` remains owned and measured.

`computer-use` is explicitly **not measured, tracked** for its native Swift/Rust sources and the
documentation site. Since #347 its suites run under Vitest, and the separate `computer-use-vitest`
policy entry (same root) measures the 33 executable JS/TS runtime modules with Istanbul: `src`,
`extensions`, `setup-helper.mjs`, `build-native.mjs`, `rust-coverage.mjs` and the documentation
generators, with the declaration-only `src/platform/types.ts` excluded as type-only. The Vitest
`include` globs `src/**` and `extensions/**` and `exclude`s only `types.ts`, so a new module joins
the report instead of dropping out; `scripts/tests/test_coverage_producers.py` binds both to the policy. It stays
`goal: "excluded"` and report-only, with no 100% claim; subprocess-run scripts count only what the
suites import. First references: macOS **2061 lines / 539 functions** uncovered (local
`npm test` on `9aad6172`, unchanged when re-measured with the glob `include` on the #353 follow-up), Linux **2088 / 548** (hosted `coverage-ubuntu-24.04` artifact, run
`41748291074`, same commit). The remaining
`check-linux-native`, `check-macos-helper-live` and `check-linux-live` scripts are outside this
signal until their #347 follow-up. Its TS entries and
native sources stay in inventory. The owner explicitly excludes this package from coverage maintenance, so it does not block
the global flip. Imported documentation-site TS/TSX/configuration is likewise inventory-only under
that exclusion; the documentation generators and optional `scripts/rust-coverage.mjs` tooling are
measured only by the report-only signal above, never gated. The opt-in Rust report is never collected by normal checks; its
mocked argument/path/error tests still run. Existing native/platform checks remain unchanged.
`dev-tools` now emits primary Istanbul and independent native Bun reports after #155/#195.
Failed-run reports are diagnostic artifacts only and never establish budgets.

Executable providers and producer configurations are named **measurement-pending**
inventories, not silently omitted. Python `scripts/*.py` (`python-scripts`) and
`integration/harness/*.py` (`python-harness`) are measured by the one Python gate recipe `PY_GATE` in
the `Makefile`: ruff, ty, then `pytest -n auto --dist loadfile --cov=<project root>` writing LCOV to
`scripts/coverage/python/lcov.info` and `integration/coverage/python/lcov.info`. The path is
deliberately not `coverage/primary`, which is import-audit's report. The `--cov` source is the project
root (`.` and `harness`), so the policy `owned` globs stay the only copy of the inventory.
`scripts/pyproject.toml` sets coverage's `patch = ["subprocess"]` so the CLI tests that spawn
`coverage_accounting.py` count. `pytest-cov` is locked in `integration/pyproject.toml`.
`parse_lcov` accepts coverage.py's `FN:<line>,<end>,<name>` rows. Only a signal declaring
`producer: "coverage.py"` may contain the bare `SF`/`end_of_record` record coverage.py writes for a
file with no executable lines; for any other producer a bare record is a truncated report and fails. Both Python signals declare `skip_hosts: ["wsl2"]`: the WSL cell runs no
pytest (`docs/ci.md`), so the WSL fan-in's `check-coverage` (`COVERAGE_HOST=wsl2`) reports them NOT RUN. A test pins
`skip_hosts` to exactly the owned cells whose planned gates omit the producer, and the ratchet rejects adding
a skipped host. `benchmarks/comparison` keeps its own pytest-cov 90% combined gate unchanged (in CI path-gated to PRs that change its inputs, plus every `main` push, see [CI](ci.md)); it is not
fed to accounting because a path-gated skip would otherwise fail as a missing report. The declaration-only `integration/harness/__init__.py` has an explicit
reasoned exclusion.

Both Python packages are `goal: "ratchet"` with an enforced `primary` signal (#314). First floors
are the measured uncovered counts, never allowances; they only go down. Every Python line the PR
added or changed is 0/0:

| Signal | darwin lines/functions | linux lines/functions |
| --- | --- | --- |
| `python-scripts/primary` | 284/11 | 285/11 |
| `python-harness/primary` | 628/69 | 628/69 |

`python-scripts` was measured on the final tree of PR #323 from its own hosted artifacts, `--measure` on each:
darwin from `coverage-macos-14`, linux from `coverage-ubuntu-24.04`, both run `41718792020` on commit `6912a7b5`.
After rebasing onto `2862cd80` (#332), main's `harness/tmux.py`/`harness/rpc.py` changes and their tests
lowered `python-harness` by 8 lines and 1 function. Re-measured on commit `3be0ba22`: linux from
`coverage-ubuntu-24.04` of run `41749183215`, darwin from a local macOS 27.2 arm64 `make check-integration`
(Python 3.14.9), which also reproduced `python-scripts` 284/11 and earlier matched the hosted darwin counts.
Both OSes gave 628/69. `python-scripts` is one line higher on linux than on darwin, so its floors differ per OS.
An earlier run (`41702044725`, before the first rebase) is not a source: it predates `harness/install_paths.py`
and `harness/release_gate.py`.
Hosted wall time of the pytest halves with `-n auto --dist loadfile`, `macos-14`: `scripts` 116s and
`integration` 143s, against 199s and 281s serial.

A repository-wide regression scan and the CLI audit tracked plus untracked nonignored TypeScript,
Python and executable JavaScript (`.mjs`, `.cjs`, `.js`) source using the same Git-listed traversal. Each executable file must be included in a measured/pending inventory or have an explicit
reasoned exclusion. Conventional test files are out of scope; arbitrary new implementation files
are not. There is no implicit `*.config.*` exemption: executable tool configurations need an
explicit owned/pending declaration or reasoned verification classification. Existing producer
configurations remain pending/report-only in the policy. All inventories are expanded and
validated; only eligible pending inventories block the final target flip. Python is outside this
eight-package zero target; its two measured signals are the enforced `ratchet` floors above.

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

All Git base/inventory reads honor the explicit repository root: inherited `GIT_*` routing,
alternate index/object paths and injected config entries are removed, and global/system config
reads are disabled. Repository-local configuration/worktree topology remains intact. Disposable
Git fixtures use this same boundary with empty templates and disabled hooks; a real private decoy
regression verifies inherited routing/config cannot redirect writes or execute injected hooks.

This consumes reports without executing tests, writes `coverage/summary.json`, and compares
each independent per-OS budget with `git show <base>:coverage/policy.json`. The default OS is
`sys.platform`; `--os darwin` or `--os linux` is explicit for artifact replay and tests. Raising
either uncovered counter of an enforced-to-enforced signal on **any** OS, removing any previously
declared OS reference/floor or measured package/signal, or disabling an enabled global target fails. The base ratchet checks both OSes,
not just the host running accounting. A missing selected-OS floor never falls back to the other OS. Only
the initial addition of a policy has no base counterpart; invalid Git bases still fail.

Changing an already-enforced independent signal to `report-only` requires a new, exact,
base-relative `enforcement_changes` entry, separate from its standing signal reason:

```json
{
  "package": "example",
  "signal": "bun",
  "reason": "Reviewed migration rollback with issue URL and concrete justification."
}
```

Missing, blank, duplicate, unrelated or recycled historical entries fail. The initial addition of
this policy on main has no base policy and requires no fictitious downgrade history. New signals
also have no previous enforcement to downgrade. Eligible package primary signals cannot become report-only even
with an entry. Owner-approved verification domains are explicitly report-only from initial
policy establishment; this does not authorize later removal of an eligible domain. A declaration is review evidence, not permission to hide missing reports or source.

The second ratchet compares **expanded source membership**, not just budgets. It applies equally
to enforced and report-only signals. The base policy
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
signal entry when they lose membership too. A measured package can never be removed; a pending one
(no signals, so no budget) can, once every file it owned has an entry here, e.g. `probe-boundaries`
in #377. For a deletion or genuine role change, omit
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

Download each runner artifact from the same CI run, then print its measured counts and reviewable policy
diff (no policy files are modified, and measurement mode is explicitly **not a gate**):

```sh
gh run download <run-id> -R nredd/pi-harness -n coverage-ubuntu-24.04 -D /tmp/cov-linux
gh run download <run-id> -R nredd/pi-harness -n coverage-macos-14 -D /tmp/cov-darwin
gh run download <run-id> -R nredd/pi-harness -n coverage-wsl2 -D /tmp/cov-wsl2
uv run --locked --project integration python scripts/coverage_accounting.py --measure --os linux --reports-root /tmp/cov-linux --summary /tmp/measured-linux.json
uv run --locked --project integration python scripts/coverage_accounting.py --measure --os darwin --reports-root /tmp/cov-darwin --summary /tmp/measured-darwin.json
uv run --locked --project integration python scripts/coverage_accounting.py --measure --os linux --reports-root /tmp/cov-wsl2 --summary /tmp/measured-wsl2.json
```

Use a checkout matching the artifact's production source and inventory. `--reports-root` reads the
artifact's repository-relative report paths while ownership validation uses that checkout. JSON
`measured_floors` contains each `package/signal -> OS -> {lines, functions}`; the logged unified diff
proposes only that OS's measured counters. Review it and edit the policy manually; it is never
written or auto-committed. `--measure` rejects `--base` so it cannot be confused with ratchet evidence.
Replay the artifact as a gate by dropping `--measure` and adding `--base origin/main`; the summary's
`measurement_only` is then false. Missing/inconsistent artifacts fail in either mode.

Compare **two independent hosted runs on different commits**, per package/signal/runner.
Validate WSL2 independently with `--os linux` and the same enforced floors as native Ubuntu;
a complete WSL artifact cannot substitute for a missing native Linux or macOS artifact. Any
WSL excess fails the owned gate: investigate/test the path, never widen a zero floor or call
the WSL cell report-only. Guest-to-host export mirrors only declared LCOV paths and the summary,
clears stale host reports, and precedes the Windows-hosted artifact action. Do not retry
until green or widen beyond observed counts. Investigate changed counters; fix nondeterminism or
retain the maximum actually observed per counter with a documented cause and follow-up issue.
Never average platforms or combine their maxima. Once the policy is on main, the base ratchet still
forbids raising it; measurement mode is diagnostic, not a bypass.

The initial Linux `session-kit/primary` floor is the **TRANSITIONAL observed maximum** of 110
uncovered lines / 32 functions across hosted runs `40441614924` (110/31) and `40452767971`
(110/32), not an allowance beyond measured results. `src/monitor/messages.ts:38` sorts matched
lines; its comparator is incidentally covered when the two-match manager fixture's coalescer
flushes before teardown, and uncovered when teardown cancels it. The floor can only go down
under the per-OS base ratchet after policy establishment. A deterministic multi-match formatter
test is the real fix, tracked [here](https://github.com/nredd/pi-harness/issues/163).

Darwin `resource-sampler/primary` diagnostic uncovered branches changed 53 -> 54 between those
runs, while its gated uncovered lines/functions stayed 58/2. That branch was the late-stdout
guard (`if (!complete) return` in the stdout `data` handler of `src/collect.ts`), which only ran
when stream delivery raced cancellation. The controlled cancellation/data-event fixture in
`packages/resource-sampler/test/sampler.test.ts` now forces that branch by emitting late stdout
after cancellation. Whether hosted Darwin counts stay stable is not yet measured (issue
[here](https://github.com/nredd/pi-harness/issues/164)). **No branch floor is added or changed.**
`Counts` contains only `lines` and `functions`; both `account()`'s budget predicate and
`check_ratchet()` compare only those two counters. Branch totals/misses remain JSON diagnostics,
never enforced thresholds; the existing branch-only LCOV regression explicitly passes.

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

The in-process `@nredd/pi-stack-tests` reviewer suite executes real Pi `grep`/`find` tools
under both Node and Bun. Each launcher gets a fresh disposable home, so a managed binary
fetched during the Node pass is not available to Bun. Ubuntu owned CI explicitly installs
`ripgrep` and `fd-find` via apt before tests. macOS uses SHA-pinned `taiki-e/install-action`
with exact `ripgrep@14.1.1` and `fd-find@10.5.0` versions (its cargo-binstall fallback for these
crates). `BINSTALL_DISABLE_STRATEGIES=compile` makes a missing prebuilt fail the step instead of
compiling from source; `fd-find` before 10.4.2 has no binstall metadata matching its release
assets and compiled for ~60s. Neither OS assumes runner-image tool availability; both verify their PATH binaries. The reviewer
suite sets `PI_OFFLINE=1` and restores it after each test: missing prerequisites fail the actual
read assertions instead of silently depending on GitHub's live latest-release downloads.
Run `40715505433` passed Node reviewer reads but failed Bun's grep on Ubuntu; its swallowed
fetch error does not establish a particular HTTP/TLS cause. macOS passed both read suites.
This is a latent test dependency exposed by the fresh-home Bun path, not proof of a
coverage-instrumentation defect. Later import-audit/probe reports cannot exist if the preceding
owned workspace command fails; only successful full producers establish floors.

Existing `owned` CI jobs run accounting after tests even on failure, then upload independent
LCOV and JSON summary artifacts even if accounting fails. No required job names or protection
settings change. A failed earlier test may prevent later packages from running; their missing
reports correctly fail rather than pretending full coverage. Do not reuse stale local reports
to claim a clean gate.

The Python benchmark's existing combined line/branch 90% gate is unchanged: still in `make check`, and in CI on `main` pushes and on PRs that touch `benchmark_inputs` (NOT RUN otherwise). Instrumented runs
must not refresh performance baselines. Quiet-runner benches and live platform/TCC checks are NOT RUN by this coverage gate.
The WSL2 owned cell runs the workspace producers and enforces Linux floors as documented above. See [CI](ci.md) for platform boundaries.
