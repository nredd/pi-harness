# Coverage

Owner scope: the 100% line/function goal covers `subagents`, `plan-mode`, `todo`,
`session-kit`, `resource-sampler`, `subscription-router`, `preset` and `dev-tools`.
`goal: "100-percent"` is the default and cannot be downgraded relative to an established
base policy. Eligible package tooling/examples remain pending goal blockers, not hidden source.
`goal: "report-only"` identifies verification infrastructure (helpers, probes, import-audit,
inprocess and producer configurations). `goal: "excluded"` records the owner's computer-use
coverage-maintenance exclusion and Python's existing-test-only scope. Both require a nonblank
`goal_reason`; neither removes any source from the inventory audit. Measured signals outside the
goal must be report-only and still require complete, valid reports and per-OS references.

The initial integration checkpoint is recorded [here](../coverage/receipts/main-integration.md).
Facade validation and the actual hosted producer failure diagnosis are recorded
[here](../coverage/receipts/facade-followup.md). Git fixture isolation, both hosted artifacts and the
#155 -> #195 dev-tools dependency decision are recorded [here](../coverage/receipts/git-isolation.md).
Final hosted closure and per-OS receipts are recorded [here](../coverage/receipts/final-closure.md).
All eight primary packages have zero uncovered lines/functions on macOS. Linux has zero misses
except resource-sampler's native `darwin.ts` paths: **47 lines / 8 functions**. `collect.ts` is
fully covered on both OSes. Those Darwin-only paths remain owned and measured, not excluded.
`enforce_target` is enabled now that eligible runtime tooling/examples are measured with complete
primary reports. `resource-sampler` declares its existing Linux-only Darwin FFI slice as a reviewed
`target_allowances` entry: exact owned primary paths, package owner, OS, ceiling and reason.
Accounting requires every uncovered line/function outside that slice to remain zero, and clamps the
slice to the current declared primary floor; it stays in the complete report and cannot become a
package waiver. Their source-complete
producers now emit `packages/plan-mode/coverage/runtime-build-tooling/lcov.info` from `test:dist`
and `packages/subagents/coverage/workflow-examples/lcov.info` from `test:workflow-examples`.
Workflow examples are instrumented only after metadata validation, including their literal metadata
initializers, then executed by the real worker/VM with nested scripts sharing counters. Collection is
opt-in: ordinary workflows never inspect or transport `globalThis.__coverage__`. The dedicated producer
merges VM counters into Vitest 5's `__VITEST_COVERAGE__` store; the ordinary primary suite keeps its
`src`-only report separate. These source-complete reports can still contain uncovered paths, not an
invented 100% result. Their local zero-floor measurement enables enforcement; clean hosted macOS and
Linux final-HEAD receipts remain required acceptance evidence. The measured per-OS primary floors are enforced now; branches and
all independent Bun signals stay report-only. The conflict-resolution decisions and exact
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
percentages or platform averages. The `owned (wsl2)` cell runs the same producers inside Ubuntu
on WSL2 and is explicitly **Linux-like, enforced**: guest `sys.platform == "linux"` selects the
existing Linux floors. Native Windows coverage is not measured. WSL contract scenarios
remain separate acceptance evidence, not owned-source coverage. WSL reports are preserved as
`coverage-wsl2`, never merged with or averaged into `coverage-ubuntu-24.04`. Unsupported OSes and missing selected-OS floors
fail closed, including when the global target is enabled. `enforce_target: true` applies after every
eligible pending inventory is measured, together with the reviewed source-scoped `target_allowances`
declaration for the existing foreign native slice. An allowance is valid only for a measured eligible
enforced primary signal, has one exact scope per OS, must fit both the pre-target and current primary
floors, and may never cover uncovered portable source. Once enabled, the ratchet rejects a new OS,
path expansion or budget expansion. That flip applies to primary signals;
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
Vitest transforms, not independent Jiti-only execution. Dev-tools also uses Istanbul, following #195, with all 22 executable modules explicitly included.
Its static `src/core/index.ts` facade is validated by real source/emitted-ESM instrumentation.
Other primary producers retain V8. The `node --test` import-audit and probe helpers retain c8 as
report-only verification signals.

Every declared `test:bun` command also emits an independent `bun` LCOV signal. All nine currently measured
Bun signals explicitly declare `enforcement: "report-only"`, with a mandatory nonblank `reason`
and a link to [#160](https://github.com/nredd/pi-harness/issues/160). Their stored `max_uncovered`
values are advisory references, not enforced budgets. An omitted `enforcement` defaults to
`enforced` for backwards-compatible primary/base-policy reading; current Bun declarations never
rely on that default. Native `bun test` subset measurements are NOT the owned-source denominator:
Bun 1.3.14 native coverage omits never-imported files. Full Vitest-on-Bun producers now use
Istanbul for router, preset, sampler, todo and inprocess through `scripts/run-vitest.ts bun`.
They inherit the full explicit primary instrumentation inventory (no `files` subset); `text` and
`lcov` use Vitest's dotted options and write `coverage/bun/lcov.info`. The sampler retains one
worker. These signals remain report-only until clean full/inventory receipts exist on both OSes.
Subagents retains its native subset plus main's guarded real-loader gate (#174); coverage is
disabled for that extra canary so it cannot overwrite Node's primary report. The policy explicitly lists the files currently measured by each signal;
missing expected files fail. Files outside that Bun subset remain mandatory in primary
coverage. Imported sibling production source and dedicated test/helper directories are outside
that package's signal. Unknown production report paths fail. Never merge JSC, V8 and Istanbul
counters or average platforms. Replacing producers with a single Bun runner later only changes
the producer wiring and reviewed signal inventory, not the accounting algorithm (issue #160).

The policy decision's roughly **1-7%** small-subset characterization must not be mistaken for a
measured source-coverage percentage or a universal suite ratio. Hosted run `40455349710` measured
8 Bun tests versus 539 primary tests for plan-mode (1.5%), 22 versus 3078 for subagents (0.7%) and
2 versus 387 for todo (0.5%). There are exceptions: preset runs all 127 tests under Bun, and the
in-process host runs the same 64 cases (one intentionally skipped on Linux). Other package ratios
also differ. LCOV imported-file denominators and JSC/V8/Istanbul executable counters differ, so
these test-count ratios cannot be presented as percentages of production source covered.

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
in signal declarations and actual `test:bun` commands. `scripts/tests/test_coverage_producers.py`
executes that reproduction with the pinned Bun and checks producer commands. Do not remove
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
CLI or "hard to test" exemptions. A measured per-OS budget is not a source exemption: Linux
resource-sampler retains Darwin-native code in both its inventory and LCOV report. Runtime enums/constants are executable source.
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
accounts for both owned plan-mode facade paths and the affected Bun subset relative to integration
base `71b0aea`; an attributed policy/path snapshot in
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

`computer-use` is explicitly **not measured, tracked**. Its custom platform/native scripts
continue running, but no invented instrumentation or 100% claim is made. Its TS entries and
native sources stay in inventory. The owner explicitly excludes this package from coverage maintenance, so it does not block
the global flip. Imported documentation-site TS/TSX/configuration, documentation generators and
optional `scripts/rust-coverage.mjs` tooling are likewise inventory-only under that exclusion, not
new measured or gated domains. The opt-in Rust report is never collected by normal checks; its
mocked argument/path/error tests still run. Existing native/platform checks remain unchanged.
`dev-tools` now emits primary Istanbul and independent native Bun reports after #155/#195.
Failed-run reports are diagnostic artifacts only and never establish budgets.

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
configurations remain pending/report-only in the policy. All inventories are expanded and
validated; only eligible pending inventories block the final target flip. Python keeps its
existing tests and benchmark gate, outside this eight-package goal.

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
with exact `ripgrep@14.1.1` and `fd-find@10.2.0` versions (its cargo-binstall fallback for these
crates). Neither OS assumes runner-image tool availability; both verify their PATH binaries. The reviewer
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

The Python benchmark's existing combined line/branch 90% gate is unchanged. Instrumented runs
must not refresh performance baselines. Quiet-runner benches and live platform/TCC checks are NOT RUN by this coverage gate.
The WSL2 owned cell runs the workspace producers and enforces Linux floors as documented above. See [CI](ci.md) for platform boundaries.
