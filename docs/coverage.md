# Coverage

Owner scope: the 100% line/function goal covers `subagents`, `plan-mode`, `todo`,
`session-kit`, `resource-sampler`, `subscription-router`, `preset` and `dev-tools`, plus the
`runtime-build-tooling`, `workflow-examples`, `import-audit` (`scripts/import_audit.ts`, 0/0 since #321, plus the root
`run-vitest.ts`, `check-biome-paths.mjs` and `router_contract.mjs` helpers since #379),
`probes` (every executable `integration/probes` source, 0/0 since #377) and
`inprocess` (every in-process stack fixture module, 0/0 on both engines since #376) signals,
and `python-benchmarks` (`benchmarks/comparison`, darwin only, 0/0 since #387).
`goal: "100-percent"` is the default and cannot be downgraded relative to an established
base policy. Eligible package tooling/examples remain pending goal blockers, not hidden source.
`goal: "report-only"` identifies verification infrastructure (helpers and
producer configurations). `goal: "excluded"` records the owner's computer-use
coverage-maintenance exclusion. Both require a nonblank
`goal_reason`; neither removes any source from the inventory audit. Measured signals on a
`report-only` goal must be report-only; an `excluded` package may enforce measured caps (#645,
`computer-use-vitest`). Both still require complete, valid reports and per-OS references.
`goal: ratchet` (#314) was deleted (#386) and the schema rejects it, in the current policy and in a
base read alike; an enforced `excluded` signal is the only nonzero floor and can only tighten.

The initial integration checkpoint is recorded [here](https://github.com/nredd/pi-harness/blob/8b87a89a7c39447ad658f07bf507ab144eb5b330/coverage/receipts/main-integration.md).
Facade validation and the actual hosted producer failure diagnosis are recorded
[here](https://github.com/nredd/pi-harness/blob/8b87a89a7c39447ad658f07bf507ab144eb5b330/coverage/receipts/facade-followup.md). Git fixture isolation, both hosted artifacts and the
#155 -> #195 dev-tools dependency decision are recorded [here](https://github.com/nredd/pi-harness/blob/8b87a89a7c39447ad658f07bf507ab144eb5b330/coverage/receipts/git-isolation.md).
Final hosted closure and per-OS receipts are recorded [here](https://github.com/nredd/pi-harness/blob/8b87a89a7c39447ad658f07bf507ab144eb5b330/coverage/receipts/final-closure.md).
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
invented 100% result. Their local zero-floor measurement enables enforcement; required CI enforces it at 0/0 on
macOS and Linux. The measured per-OS primary floors are enforced now; uncovered
branches are capped per signal ([branch caps](#branch-caps)), and Bun signals follow their own declared enforcement (see below). The conflict-resolution decisions and exact
base-relative facade ledger regression for the `b51e177` main merge are recorded
[here](https://github.com/nredd/pi-harness/blob/8b87a89a7c39447ad658f07bf507ab144eb5b330/coverage/receipts/tier-main-merge.md).

The target is **100% of owned executable source lines, functions, branches AND statements**, measured by each
package's primary runner (`target` in `coverage/policy.json` is 0/0/0/0). This is source coverage, not
proof that every behavior is asserted. Every subsequently closed gap needs a test that fails
without the change. Phase 0 adds accounting; the final integration also tests worker-error settlement and remaining
cross-platform collector paths without removing guards.

### Statement caps

LCOV has no statement records, so Istanbul and V8 Vitest producers also write `json-summary`
(`coverage-summary.json` next to `lcov.info`; `reporters` in the policy, `test.coverage.reporter` in each config
and `scripts/run-vitest.ts bun` move together). `coverage_accounting.py` reads each file's `statements`
total and covered count from it, keyed by resolved path against the same scoped LCOV record set, and adds
`statements`/`uncovered_statements` to the file records and signal totals in `coverage/summary.json`
for signals that read a summary. Signals that don't (coverage.py, native `bun test`) report `null` per file
and omit the total, so an unmeasured counter never reads as fully covered.
`max_uncovered.<os>.statements` follows `branches`: the base ratchet only lets it go down, dropping a key the
base had is a weakening, and `target.statements` is 0, so every 100-percent primary is held to 0 uncovered
statements. Every enforced primary and Bun Vitest signal caps 0. `computer-use-vitest` caps its measured
per-OS uncovered statements (see [computer-use-coverage.md](computer-use-coverage.md)).

It fails closed. With `target.statements` set, an enforced Istanbul/V8 signal needs the `json-summary`
reporter and a cap (`Missing statement cap`); a cap without a readable, non-empty summary, or a summary
with no statements, fails (`Statement producer missing`); an LCOV source with no summary entry fails
(`Statements missing for source`). The CI shard and fan-in artifacts and the WSL capture carry
`coverage-summary.json` beside `lcov.info`.
Carve-outs: coverage.py signals (statements are its lines, so no counter), the native `bun test` subset
(session-kit `/bun`, report-only) and report-only `goal: excluded` signals carry no statement cap.
Statement units differ (Istanbul AST statements, V8 AST remap), so caps compare within one signal only.

### Branch caps

`max_uncovered.<os>.branches` is each signal's uncovered-branch cap, with the same semantics as
`lines`/`functions`: an enforced signal fails on excess (`Budget exceeded: <measured> uncovered, budget
<cap>` names all three counters), a report-only signal logs the reference and the signed delta, and the
JSON `signals` map carries the branch delta. The base ratchet treats it like lines: a cap can only go
down, and dropping a `branches` key the base had is a weakening. `target.branches` is 0, so every
100-percent primary signal is held to 0 uncovered branches regardless of its own cap. Every enforced primary and
Bun signal's cap is 0 as well; `session-kit`'s native Bun subset stays report-only and uncapped (see below).

It fails closed both ways. A signal whose report has branch records (`BRDA`) needs a cap on that OS
(`Missing branch cap`), and a capped signal whose report has executable lines but no branch records
fails (`Branch producer missing`), so a producer that silently stops emitting `BRDA` can't read as 0.
Carve-outs: the native `bun test` subset signal (session-kit `/bun`) writes no branch records
and declares no cap until #320 moves it to Vitest-on-Bun Istanbul (blocked on Bun `worker.terminate()` latency);
`computer-use-vitest` is owner-excluded (`goal: excluded`); its signal declares a branch cap since #645, so no
remaining signal carries branch records uncapped.

Branch units differ by producer: Istanbul and Bun count AST arms (including an implicit `else` and each
logical operand), coverage.py counts jump arcs, so caps are only comparable within one signal. Both
fail-closed checks are aggregate per signal, not per file: `Branch producer missing` needs the whole
report to have zero `BRDA` rows.

Python measures branches: `PY_GATE` in the `Makefile` passes `--cov-branch`, so both coverage.py
producers emit `BRDA` rows like the benchmark's `branch = true` producer already did (`-` for a branch whose line never ran, named targets such as `jump to line 9`).
`test_real_coveragepy_branch_report_parses` runs real coverage.py to pin that shape.

Caps are per OS, from hosted artifacts (WSL folded into `linux` as the max). A cap is never a max over runs: a branch
whose coverage changed between runs on an unchanged tree gets a deterministic test first. #429 found three,
each reached only by the real host: `formatMetric`'s non-`available` arm and `rankProcesses`'s pid
tiebreak in `packages/dev-tools/src/resource/index.ts`, and `stop_hostile_child()`'s already-exited arm in
`scripts/package_contracts.py` (whether the marker's exit status was collected before cleanup). Fixture
tests now pin all three. Caps are references, not waivers: they never rise, and `target.branches` is 0.

`coverage/policy.json` is the reviewed inventory and the only threshold policy. Its target is
zero uncovered lines, functions, branches and statements. Schema version 2 keys each signal's transitional `max_uncovered`
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
recorded [here](https://github.com/nredd/pi-harness/blob/8b87a89a7c39447ad658f07bf507ab144eb5b330/coverage/receipts/phase0-macos.md). These local receipts are advisory evidence,
not hosted floors or a hosted-CI timing claim. Hosted artifact measurements and their independent
run comparison are recorded [here](https://github.com/nredd/pi-harness/blob/8b87a89a7c39447ad658f07bf507ab144eb5b330/coverage/receipts/hosted-platforms.md).

The accounting script consumes LCOV, not runner APIs. Primary reports use Istanbul for `subagents`, `plan-mode`, `todo` and `preset`.
Real Pi/Jiti reloads collide with Vitest-generated scripts at identical source URLs and corrupt
V8 attribution. The preset and todo diagnoses demonstrate false misses and false hits; preserve
real-loader tests rather than deleting assertions to repair counters. Istanbul credits instrumented
Vitest transforms, not independent Jiti-only execution. Dev-tools also uses Istanbul, following #195, over all 23 executable modules.
Its static `src/core/index.ts` facade is validated by real source/emitted-ESM instrumentation.
Other primary producers retain V8. Since #347 that includes the import-audit and probe helpers:
`scripts/vitest.config.ts` and `integration/probes/vitest.config.ts` replace c8 + `node --test`, run
through `scripts/run-vitest.ts node --coverage` with the shared home guard. Vitest transforms and
runs the measured source itself, so Node's compile cache no longer reaches it: the
`NODE_DISABLE_COMPILE_CACHE=1` that c8 needed (#321) is gone, and the measured counters are unchanged with
`NODE_COMPILE_CACHE` exported. Vitest coverage does not follow child processes, which c8 did, so the
import-audit CLI runs in process through `main()` as well as through the real subprocess. The
entry dispatch in both `import_audit.ts` and `run-vitest.ts` is exercised in process for both
entry and import cases, with real subprocess tests retaining the CLI boundary. Since #379 the same
signal owns the other three root Node scripts, formerly `verification_helpers` rows, measured the
same way. `run-vitest.ts` exports `main(argv, env)`; `run-vitest.test.ts` fakes only `spawnSync` and
asserts engine selection, the appended Bun coverage arguments and the exact opt-out, real home
creation and removal, toolchain homes, the step summary, and rejection of a bad engine. Its
`dispatch(isMain)` is asserted in process for both arms, and the real entry stays with the subprocess
tests in `launcher.test.ts` and `test_coverage_producers.py`. `check-biome-paths.mjs` stays a top-level CLI that its test re-imports
per case with its own argv, like `anthropic-block-types.mjs`, against real Biome, faking `spawnSync`
only for a spawn error and a signal-killed child. `router_contract.mjs` exports the per-scenario
synthetic utilization so every scenario runs in process; its two placeholder imports are virtual
mocks. Vite's module runner pins `import.meta.main` false, so the dispatches of `run-vitest.ts` and
`import_audit.ts` were the signal's last two uncovered branches (#418, #539): each is now an exported
`dispatch(isMain)` whose arms are called directly. A test of ordinary, member and look-alike `require`
calls covers the non-import call, and the syntax-error location no longer branches on the diagnostic's
optional `fileName`, since diagnostics are requested per file. The import-audit signal enforces zero uncovered lines, functions, and branches on darwin
and linux. Since #380 it also owns all 15 Vitest producer configurations (`packages/*/vitest*.config.ts`,
`packages/todo/.vitest.config.ts`, `integration/{inprocess,probes,providers}/vitest.config.ts` and
`scripts/vitest.config.ts`), and the pending `coverage-configurations` package is deleted (reclassified
file by file). Vitest loads a config outside its own instrumentation, so `scripts/coverage-configs.test.ts`
imports each one as a module and asserts the resolved `test.coverage`: provider, the `text`, `lcov` + `json-summary`
reporters, `reportsDirectory`, `reportOnFailure`, and `include`/`exclude` equal to the config's own policy
entry. A second pass serves a synthetic policy giving every package a distinct inventory, so a config
reading another package's key fails, and a third serves a policy without the package, which must make the
load throw. These replace the source-parsing `test_primary_configs_report_owned_source_on_failure` in
`scripts/tests/test_coverage_producers.py`, so each is asserted once. A new Vitest config must be added to
the suite's producer table (its first test fails otherwise), and reaches the report through the policy
glob. The signal's Vitest root is now the repository (`scripts/vitest.config.ts` sets `root` and
`scripts/`-prefixed paths), so the policy entry has root `.` and the report is
`scripts/coverage/primary/lcov.info`: LCOV paths are relative to the Vitest root and must reach
configurations outside `scripts/`. The CI artifact path is unchanged. `import-audit` and `probes` are in the goal and enforced at 0/0. Since #377 `probes` measures every
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
`main`). Both are 0 uncovered on darwin and linux before and after. Since #418 `probes` branches are
0 as well: tests cover foreign-API and non-assistant traffic, unindexed and malformed deltas, a close
failure at the size limit and the default agent dir under a set and an unset `HOME`, and the dead
`?? "unknown"` and empty-window guards are folded into `blockType()` and `percentile()`.
`providers` is in the goal and enforced at 0/0 since #378: `check-providers` runs `integration/providers/vitest.config.ts`
(forks, the shared home guard) over all seven sources. `faux.ts` and `usage_fixture.ts` stream every
scripted step shape against a recording registry with a fake clock, `extension_inventory.ts` reads a
fake registry, and `preloads.test.ts` imports the auth preloads in its own forked worker against a
loopback mock: the redirect, refused egress, recorded `claude`/`security` spawns, readiness failures
and every `auth_runtime_fixture.mjs` negative flag. A stand-in `globalThis.Bun` covers the Bun spawn
wrappers; a second install without `HARNESS_BLOCKED_LOG`, with and without Bun, covers the unlogged
block paths, and the dead `?? ""` after `split()` in `forbiddenName` is deleted (#425). 194 lines / 51 functions,
163 branches, 0 uncovered on darwin. The `test-helper` exclusion and the five
`verification_helpers` rows are gone; `fast_timers.mjs` was dead (no scenario passed `fixture_env`
timers) and is deleted.

Every declared `test:bun` command also emits an independent `bun` LCOV signal. Nine Bun signals
are measured. `dev-tools`, `plan-mode`, `preset`, `subscription-router` and `todo` are `enforced` at
0/0 on darwin and linux since [#320](https://github.com/nredd/pi-harness/issues/320): full suite, full primary
inventory, 0/0 in their own PRs' hosted macos-14 and ubuntu-24.04 artifacts (receipts
[here](https://github.com/nredd/pi-harness/blob/8b87a89a7c39447ad658f07bf507ab144eb5b330/coverage/receipts/bun-enforced.md)). `resource-sampler` is `enforced` at 0/0 on
darwin and linux since [#375](https://github.com/nredd/pi-harness/issues/375), which closed its
darwin 8/4 and linux 47/8 Bun misses with the same fake-host FFI tests as primary. `inprocess` joins them since
[#376](https://github.com/nredd/pi-harness/issues/376), see below. `subagents` runs its full suite on Bun 1.4.4 and is `enforced`
at 0/0/0 on darwin and linux since #320, measured on darwin only so far (macOS: Node 4361 passed / 8 skipped,
Bun 4362 passed / 7 skipped, both Istanbul 7731 lines, 1606 functions, 7193 branches fully covered); hosted CI must confirm linux. The other one (session-kit)
explicitly declares `enforcement: "report-only"`, with a
mandatory nonblank `reason` and a link to [#160](https://github.com/nredd/pi-harness/issues/160).
Its stored `max_uncovered` values are advisory references, not enforced budgets. An omitted `enforcement` defaults to
`enforced` for backwards-compatible primary/base-policy reading; current Bun declarations never
rely on that default. Native `bun test` subset measurements are NOT the owned-source denominator:
Bun 1.3.14 native coverage omits never-imported files. Full Vitest-on-Bun producers now use
Istanbul for router, preset, sampler, todo, plan-mode, dev-tools, subagents and inprocess through `scripts/run-vitest.ts bun`.
They inherit the full primary instrumentation inventory (no `files` subset). The launcher's
`bun` engine appends the provider, the `text`, `lcov` and `json-summary` reporters (Vitest's dotted options) and
`coverage/bun`, so each `test:bun` passes only package arguments. The sampler retains one
worker. The launcher also sets `PI_EXPECT_BUN_RUNTIME=1`, which subagents' real-loader test reads to prove it ran on
the pinned Bun. session-kit alone keeps a native subset, and its policy explicitly lists the files currently measured by each signal;
missing expected files fail. Files outside that Bun subset remain mandatory in primary
coverage. Imported sibling production source and dedicated test/helper directories are outside
that package's signal. Unknown production report paths fail. Never merge JSC, V8 and Istanbul
counters or average platforms. Replacing producers with a single Bun runner later only changes
the producer wiring and reviewed signal inventory, not the accounting algorithm (issue #160).

The policy decision's roughly **1-7%** small-subset characterization must not be mistaken for a
measured source-coverage percentage or a universal suite ratio. Historically, hosted run `40455349710`
measured 8 Bun tests versus 539 primary tests for plan-mode (1.5%), 22 versus 3078 for subagents (0.7%)
and 2 versus 387 for todo (0.5%), before #320 moved plan-mode, subagents and todo onto their full suites under
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
ratchet. Per-OS reference membership is still required. Branch caps follow the signal's enforcement
like its lines/functions ([branch caps](#branch-caps)).

Flip a package's Bun signal to `enforced` **only when its full suite runs under Bun on both owned
OSes and its Bun inventory covers every owned executable source file**, including never-imported
modules through explicit import-all/instrumentation. A green compatibility subset alone is not
that evidence, even when its test count matches primary. Follow #160's reviewed migration spec;
cite complete-source hosted run ids before establishing enforced Bun floors. Accounting rejects an
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
Branch records are validated like every other counter and gated by the signal's branch cap
([branch caps](#branch-caps)). Missing/empty reports, inconsistent counters, zero total owned lines, unknown files
and absent expected source all fail closed.

## Inventory and exclusions

Each package lists owned source files or source globs. A signal without a `files` subset expects
the entire expanded inventory after justified exclusions. `coverage/policy.json` is the only copy of
that inventory: every Vitest coverage producer reads it with `readFileSync` and passes its package's
`owned` as `coverage.include` and `exclusions[].path` as `coverage.exclude`. A never-imported module
matched by a glob lands in the report uncovered and fails accounting; a report missing an expected
file fails accounting too. `test_coverage_producers.py` asserts each config reads its own policy entry.
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
`scripts/check-biome-paths.test.mjs` and `scripts/router_contract.test.mjs` need their own verification-helper entry; classifying the
implementation helper does not implicitly classify its regression test.

Shipped runtime code is NEVER a verification helper. In particular, computer-use's published
`setup-helper.mjs`, `build-native.mjs` and `src/platform/macos/helper-path.mjs` remain owned,
measurement-pending production source because computer-use has no standard coverage runner.
Its non-shipped `check-*.mjs` assertion scripts and `pi-cubench-agent.mjs` benchmark harness have
individual verification reasons. Runtime builder scripts
and runnable workflow examples are explicitly pending source, not verification exemptions.
The generated stats CLI bundle has a reasoned generated-artifact exclusion; its original
`src/stats/cli.ts` remains owned and measured.

`computer-use` is explicitly **not measured, tracked** for its native Swift/Rust sources and the
documentation site. Since #347 its suites run under Vitest, and the separate `computer-use-vitest`
policy entry (same root) measures the 35 executable JS/TS runtime modules with Istanbul: `src`,
`extensions`, `setup-helper.mjs`, `build-native.mjs`, `rust-coverage.mjs` and the documentation
generators, with the declaration-only `src/platform/types.ts` excluded as type-only. Its Vitest
config reads both from the policy like every other producer, so a new module joins the report
instead of dropping out. It stays
`goal: "excluded"` with no 100% claim, but since #645 T0 the signal is **enforced**: its per-OS caps are the
measured uncovered counts for lines, functions and branches (darwin **215 / 43 / 464**, hosted `owned (macos-14)` on main `1e93038c`; linux **234 / 48 / 488**, the max of hosted `owned (ubuntu-24.04)`
and `owned (wsl2)`, identical). Since #700 it also caps statements (darwin **329**, linux **354**). Subprocess-run scripts count
only what the suites import. Files already at 0/0/0 on every OS are also pinned per file by
`coverage.thresholds` in `packages/computer-use/vitest.config.ts` (the policy schema has no per-file pins).
Per-file history and numbers are in [computer-use-coverage.md](computer-use-coverage.md). The native and
live suites (`linux-native`, `macos-helper-live`, `linux-live`) also run under Vitest now; skipped off
their platform or opt-in, and `linux-native` counts only the `src/platform/linux/helper.ts` client it imports. Its TS entries and
native sources stay in inventory. The owner explicitly excludes this package from coverage maintenance, so it does not block
the global flip. Imported documentation-site TS/TSX/configuration is likewise inventory-only under
that exclusion; the documentation generators and optional `scripts/rust-coverage.mjs` tooling are
measured by the enforced ratchet signal above. The plan for lifting the exclusion (TS and Swift, seams, phases) is [here](computer-use-coverage.md). The opt-in Rust report is never collected by normal checks; its
mocked argument/path/error tests still run. Existing native/platform checks remain unchanged.
`dev-tools` emits primary Istanbul after #155/#195. Since #320 its Bun report comes from the same
full Vitest suite on Bun through `scripts/run-vitest.ts bun`, not a native `bun test` subset.
Failed-run reports are diagnostic artifacts only and never establish budgets.

Every Vitest producer configuration is measured since #380 (see the `import-audit` paragraph above). Python `scripts/*.py` (`python-scripts`) and
`integration/harness/*.py` (`python-harness`) are measured by the one Python gate recipe `PY_GATE` in
the `Makefile`: ruff, ty, then `pytest -n auto --dist loadfile --cov=<project root> --cov-fail-under=100` writing LCOV to
`scripts/coverage/python/lcov.info` and `integration/coverage/python/lcov.info`. The path is
deliberately not `coverage/primary`, which is import-audit's report. The `--cov` source is the project
root (`.` and `harness`), so the policy `owned` globs stay the only copy of the inventory. For `scripts` that root includes `scripts/tests/`, so the test files themselves must reach 100%; `--cov-fail-under=100` applies to both `check-scripts` and `check-integration` (`harness`).
`scripts/pyproject.toml` sets coverage's `patch = ["subprocess"]` so the CLI tests that spawn
`coverage_accounting.py` count. `pytest-cov` is locked in `integration/pyproject.toml`.
Measurement can report an OS with no reference floor; enforcement still requires one. Summary totals
consume the integer counters emitted by `account`, not the package, signal, OS or file labels.
`parse_lcov` accepts coverage.py's `FN:<line>,<end>,<name>` rows. Only a signal declaring
`producer: "coverage.py"` may contain the bare `SF`/`end_of_record` record coverage.py writes for a
file with no executable lines; for any other producer a bare record is a truncated report and fails. The same
`coverage.py` dialect covers what `branch = true` writes (#387): a module without functions carries no `FNF`/`FNH`,
read as zero functions, and `BRDA` names each branch by its destination (`jump to line 12`) instead of a number. Both Python signals declare `skip_hosts: ["wsl2"]`: the WSL cell runs no
pytest (`docs/ci.md`), so the WSL fan-in's `check-coverage` (`COVERAGE_HOST=wsl2`) reports them NOT RUN. A test pins
`skip_hosts` to exactly the owned cells whose planned gates omit the producer, and the ratchet rejects adding
a skipped host.

`benchmarks/comparison` (`python-benchmarks`, #387) is measured by its own `make check-benchmark`: pytest-cov with
`branch = true` and `fail_under = 100` in its `pyproject.toml` (coverage.py 7.17.1, as `integration/`), writing LCOV to
`benchmarks/comparison/coverage/python/lcov.info`.
Its enforced `primary` signal is 0/0 on darwin only and declares `skip_hosts: ["linux", "wsl2"]`: the `native_runtime`
test needs Seatbelt, so only the macOS cell runs the producer. The CI step is path-gated (#315), so the signal also
declares `gate: "check-benchmark"`. `scripts/ci_paths.py` lists a skipped gate in the cell's `skipped_gates`, the fan-in
passes it as `COVERAGE_SKIPPED_GATES` (`--skipped-gates`), and the signal reports NOT RUN on that run only; a run
that executes the gate requires the report. Accounting fails closed on a `--skipped-gates` token no policy signal
declares, so a typo cannot skip nothing silently, and a test keeps every `PATH_GATED_GATES` key declared. The ratchet rejects changing a signal's `gate`, as it rejects adding a
skipped host. Before #387 the gate was 90% with 85 statements and 58 partial branches missed (run `41755991256`).

Both Python packages are `100-percent` with an enforced `primary` signal at 0 uncovered lines, functions and
branches on each OS (#386; #420 removed the last `python-scripts` partial arc). `integration/harness/__init__.py` is a
docstring-only module that coverage.py reports as fully covered on import, and `integration/conftest.py` is a
conventional pytest test file (outside `owned` and the inventory audit), so `python-harness` declares no exclusions.

Hosted wall time of the pytest halves with `-n auto --dist loadfile`, `macos-14`: `scripts` 116s and
`integration` 143s, against 199s and 281s serial.

The audit (`audit_inventory`) fails closed over every nonignored tracked and untracked file, from
the same Git-listed traversal. Executable suffixes (`SOURCE_SUFFIXES`: TS/TSX/`.mts`/`.cts`, JS/JSX/`.mjs`/`.cjs`,
Python, Swift, Rust, `.sh`/`.bash`/`.ps1`) and extensionless files with a `#!` shebang must be inventoried.
A suffix in neither `SOURCE_SUFFIXES` nor the known-inert `NON_SOURCE_SUFFIXES` (docs, data, images, ...)
also fails, so a new language is classified deliberately (#694). Declaration files (`.d.ts`, `.d.mts`) pass
only through a reasoned exclusion that matches an existing file under its package root: `type-only` for hand-written
declarations, `generated` for tool output such as `docs/next-env.d.ts`. A dead glob fails the audit. Whole directories stay out only via `unmeasured_trees` in
`coverage/policy.json`, each with a tracking issue and reason (today: `forks/`, #693). An entry must be a normalised, existing directory or gitlink, unique, and may not equal, sit inside or contain a package root or any owned file. Every gitlink (submodule, e.g. `forks/pi`) must be covered by an entry or the audit fails, so dropping the `forks` entry is caught. The audit does not check that the tracking issue is still open (the gate has no network). Shell and
PowerShell under `scripts/` are the `shell-scripts` package, `pending` with no coverage claim (#695);
`computer-use` owns `native/macos/*.swift`, so new Swift files join its inventory.
Makefiles (extensionless, no shebang) and YAML, including workflow and action inline `run:` steps, are inert by decision and not inventoried: measuring them is the open #695 owner decision. `test_makefiles_and_yaml_are_inert_by_decision_until_695` pins the exact tracked set (3 Makefiles, every `.github/**/*.yml` at the root and under `packages/computer-use` and `packages/subagents`), so a new one is a deliberate choice. Each file must be in a measured/pending inventory or have an explicit
reasoned exclusion. Conventional test files (including pytest `conftest.py` and Swift `*_tests.swift`) are out of scope; arbitrary new implementation files
are not. There is no implicit `*.config.*` exemption: executable tool configurations need an
explicit owned/pending declaration or reasoned verification classification. The producer
configurations are owned by `import-audit` (#380). All inventories are expanded and
validated; only eligible pending inventories block the final target flip. Python is held to the same 0 line/function target (see above).

## Add a source file

- Check that the new file matches its package's `owned` inventory; otherwise add it explicitly.
  Do not mark shipped runtime code as verification just because it lives under `scripts/`.
- Do not edit a measured package's Vitest config: it reads `owned` and `exclusions` from the policy,
  so a never-imported file is reported uncovered and fails accounting until a test covers it.
- Update an independent compatibility `files` list only when that declared suite actually reports
  the new file. Do not fabricate a report or merge compatibility counters with primary counters.
- Run `make check-scripts` to check source classification and producer wiring;
  run the affected package's existing primary/declared compatibility invocations, then
  `make check-coverage`. Missing expected source fails closed. Cite the clean
  hosted run ids in the PR and never raise uncovered budgets to accommodate new untested behavior.
- For a genuine non-shipped verification harness, add one exact `verification_helpers` entry with
  its own reason. For source removal, rename or role changes, follow the reclassification ledger
  below, including affected compatibility scopes.

## Run and ratchet

Run `make install`, then the existing tests (`make check-ts check-import-audit check-probes check-providers`).
Coverage is part of those invocations, not a second test pass. From the repository root:

```sh
make check-coverage
```

With `BASE` unset this compares against `git merge-base HEAD origin/main`, where the topic diverged,
and logs that SHA (`--compare-ref origin/main`). Comparing an older topic with the moving
`origin/main` tree instead reads every file added only on newer main as a topic deletion. A missing or
empty ref, no common ancestor (e.g. a `--depth 1` clone) or several merge bases (criss-cross history)
fail closed, there is no fallback. Fetch `origin/main`, or pass the base yourself.

This local default is advisory. It reads your local `origin/main`, so a stale one yields an older and
possibly looser base. Run `git fetch origin` first. CI's explicit event `BASE` is authoritative.

An explicit `BASE` is used unchanged. That includes one exported from the environment, not only
`make check-coverage BASE=<sha>`, and an empty one fails closed. Hosted CI passes the event's base SHA
for its synthetic merge checkout, and frozen acceptance and artifact replay pass the base of the exact
tree they verify.

All Git base/inventory reads honor the explicit repository root: inherited `GIT_*` routing,
alternate index/object paths and injected config entries are removed, and global/system config
reads are disabled. Repository-local configuration/worktree topology remains intact. Disposable
Git fixtures use this same boundary with empty templates and disabled hooks; a real private decoy
regression verifies inherited routing/config cannot redirect writes or execute injected hooks.

Its tests are `scripts/tests/test_coverage_*.py`, one file per behavior (`lcov`, `inventory`,
`floors`, `policy_pins`, plus base, platforms, enforcement, goals, facades, producers and the Git
boundary), sharing `scripts/tests/coverage_fixtures.py`. A test imports fixtures from there, never
from another test file.

This consumes reports without executing tests, writes `coverage/summary.json`, and compares
each independent per-OS budget with `git show <base>:coverage/policy.json`. The default OS is
`sys.platform`; `--os darwin` or `--os linux` is explicit for artifact replay and tests. Raising
any uncovered counter (lines, functions, branches) of an enforced-to-enforced signal on **any** OS,
removing a `branches` cap or any previously declared OS reference/floor or measured package/signal, or disabling an enabled global target fails. The base ratchet checks both OSes,
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
floor. Cite the measuring hosted run ids in the package `note`; receipts live in git history and
the PR, not in the tree. A new package needs an owned inventory,
justified declaration exclusions, a primary producer reading that inventory, text+LCOV wiring,
independent runtime signal if declared, and clean hosted runs before its budgets are accepted.
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
`measured_floors` contains each `package/signal -> OS -> {lines, functions, branches, statements}` (`branches` and
`statements` only when the report has branch records or a statement summary); the logged unified diff
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
[here](https://github.com/nredd/pi-harness/issues/164)). That race-dependent branch is why the
sampler's starting branch caps came from hosted counts rather than a single local run; #417 drove them
to 0 on darwin and linux, primary and Bun ([branch caps](#branch-caps)).

`todo` branch caps are 0 on primary and Bun since #414: tests for every reachable branch, and
deletion of defaults and fallbacks no caller could reach (`planTitle`'s heading fallback, the bullet
content-indent default, `withTrailingSpacer`'s empty guard, the `settledAt` default in agent retry
matching, `isValidCollapseKeySpec`'s `?? ""`). Measured on darwin; hosted CI confirms linux and WSL2.

`plan-mode` branch caps are 0 on primary and Bun since #407: tests for every reachable branch in the
menus, settings, export, question and launch code, and deletion of the guards and defaults no caller
could reach (the `codePointAt(0) ?? 0` fallbacks, `safeModelReference`'s `"unknown"` and
`"configured model"` arms, `itemId ? ... : undefined` lookups on Kit's always-present item id, the
`settings.ts` `document ?? {}` defaults, the `plan_mode_question` single-question and answer-set
re-checks). The handler-level pre-checks and the `value ?? ""` export default stay: they guard the
Kit contract, so `package-menu-contract.test.ts` drives them by adapter fault injection. The
post-await `isCurrent` guard in the active-implementation Settings handler duplicates Kit's own
check, and `planFromCompletionDetails`' `normalized.ok` ternary yields `undefined` either way; their
tests cover the branch but cannot fail without it. Measured on darwin; hosted CI confirms linux and WSL2.

`inprocess` is `enforced` at 0/0 lines/functions on darwin and linux for both `primary` and `bun`
since #376, with nothing excluded. Its inventory is every fixture module the suites run:
`support.ts`, `goal-support.ts`, `native-timers.ts`, `agents-support.ts`, `todo-support.ts` and
`verification/home-guard.ts`. The first two `test-helper` exclusions and the `home-guard.ts`
verification-helper entry are gone. `verification/home-setup.ts` stays a verification helper:
Vitest hard-excludes a config's own `setupFiles` from coverage, so it is now a one-call entry and the
guard it installs (`installHomeGuard`) is measured in `home-guard.ts`. Before #376, main `f2d607eb`
measured primary 15 / 4 darwin, 25 / 8 linux and Bun 17 / 4, 27 / 8 (run `41781117332`); the Linux
delta was the macOS-only `caffeinate` teardown in `support.ts`. `stopWake()` and
`isolateStackHome()` now take an injected `Deadline` and wake spawner, so `support.test.ts` drives
SIGTERM-exits, SIGKILL-exits, survives-SIGKILL and the spawn failure with a fake helper on every OS
(no real signals, no real waits). Negative tests cover the host-identity mismatch, an entry without
a default factory, a memory entry without its reset seams, a fatal `session_start` in `startStack`,
the offline usage transport and a physical transport core cannot authenticate. Bun's missing
`resolveHost` Node branch is exercised by checking both engines' resolvers agree on a dual-format
host. The real `caffeinate` sleep-assertion test still runs on macOS only. Since #418 `holdWake()`
takes its platform, so every OS asserts no helper off macOS, and a host without
`/usr/bin/caffeinate` asserts the macOS spawn failure fails the fixture; a spawner returning no
helper, unset Pi/XDG/PATH variables, a real interval cleared through the frozen `clearInterval`, a
stackless timer origin, `StackUsage` reads and a refused `rowOf` cover the remaining branches. Primary
and Bun are 0 uncovered branches on darwin and on linux (ubuntu-24.04 and wsl2, hosted run `42047972267`).

The in-process `@nredd/pi-stack-tests` reviewer suite executes real Pi `grep`/`find` tools
under both Node and Bun. Each launcher gets a fresh disposable home, so a managed binary
fetched during the Node pass is not available to Bun. Ubuntu and macOS owned CI
install them before tests with SHA-pinned `taiki-e/install-action` (no apt mirror on the path, see `docs/ci.md`)
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

The Python benchmark's combined statement/branch gate is 100% (#387): still in `make check`, and in CI on `main` pushes and on PRs that touch `benchmark_inputs` (NOT RUN otherwise). Instrumented runs
must not refresh performance baselines. Quiet-runner benches and live platform/TCC checks are NOT RUN by this coverage gate.
The WSL2 owned cell runs the workspace producers and enforces Linux floors as documented above. See [CI](ci.md) for platform boundaries.
