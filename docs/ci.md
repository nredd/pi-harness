# CI

WSL bootstrap explicitly sets `core.autocrlf=false` and `core.eol=lf`, then rebuilds the
**disposable host checkout's** index before resetting to HEAD. Disabling autocrlf or resetting
alone can retain clean CRLF stat entries. The real-Git regression verifies exact tracked text
and unchanged binary bytes; no source assertion or generated-runtime comparison is weakened.

CI is the gate. Local runs are for development. Hosted runners by default, plus the heaviest cells, which move to self-hosted pools while those have room (see [Self-hosted pools](#self-hosted-pools)). No stored credentials or secrets.
The publish job alone requests a short-lived npm OIDC identity.

The `stack` job's `Report coverage exclusions` summary writes only `GITHUB_STEP_SUMMARY` text.
The workflow contract executes that step's actual body with the test runner's `/bin/bash` in
an isolated directory, checks production output-failure propagation, and checks scoped exclusions
separately from shell selection. `stack` has no WSL guest any more, so this is an ordinary step.
Default standalone D/E still skips seven auth cases (#14); candidate compiled-core auth adapter
results require their own outcome and JUnit evidence, not the summary notice. Friendly-prose
changes must preserve those disclosures and the remaining explicit `NOT RUN` scopes.
All guest dispatch remains through the adapter, which labels a failing `pwsh`, `wslpath`, guest
command, or generated guest step while preserving its original exit status and stderr.

`.github/workflows/ci.yml`, every PR and `main`:

| Job | Normal PR | `main` push | Docs-only PR or push | Proves |
| --- | --- | --- | --- | --- |
| `owned (ubuntu-24.04, macos-14, wsl2)` | A fan-in over parallel `owned shard (<os>, <shard>)` jobs (see the shards section below). Each shard runs `make install-owned`, then one step per gate it owns: `make check-ts WORKSPACES=...` (its workspaces only), `make check-scripts`, `make check-integration` (the Python halves of the last two run through `PY_GATE`: ruff, ty, then pytest across cores, see below); `make install-benchmark` and `make check-benchmark` in the macOS `python` shard only, unless the plan lists it in `skipped_gates` (a PR without `benchmark_inputs`; the step then reports NOT RUN). The WSL guest shards run `make check-ts`, `make check-probes`, `make check-providers`, `make check-import-audit`, and on a PR only with WSL inputs. The fan-in requires every shard, then runs `make check-coverage` over their merged reports. `cargo-nextest` is installed so dev-tools' real cargo suite runs instead of skipping | Same | Native cells report the bypass; WSL runs on `main`, reports NOT RUN on a PR | Biome, tsc and each package's Vitest suite and declared `test:bun` suite (router, preset, resource-sampler, todo, plan-mode, dev-tools and inprocess run FULL Vitest suites on both engines with the shared homedir guard; subagents retains native scenarios plus a guarded real-loader gate until a later #320 slice, with its full Node suite guarded; the other packages retain native Bun subsets; a notice names every package without `test:bun`, as NOT RUN), `scripts/` and `integration/` unit gates. `check-benchmark`'s `native_runtime` test needs Seatbelt, so Linux/WSL reports it NOT RUN. See the computer-use note below. |
| `contracts (ubuntu-24.04, macos-14, wsl2)` | `make install-owned`, `make check-package-contracts` (includes the packed preset audit + install), `make check-plan-mode-package-contract`, `make check-subagents-package-contract`, `make check-todo-package-contract`, `make check-computer-use-package-contract`. WSL runs these on a PR only with WSL inputs | Same | Native cells report the bypass; WSL runs on `main`, reports NOT RUN on a PR | Packed tarballs alone on exact stock Pi 1.3.0 (dev-tools with its exact `@nredd/pi-resource-sampler` from the registry, integrity checked against `npm view`, real parent-child discovery by that installed sampler's full scan, and a bounded `resource_snapshot`), the packed preset audited and installed alone, and the packed `@nredd/pi-subagents` with `croner`/`nanoid` from the registry plus one faux `Agent` call (the same gate the release `verify` runs, so a PR proves it before a tag does). The packed `@nredd/pi-todo` with `@juicesharp/rpiv-config`/`rpiv-i18n` from the registry plus one faux `todo` create. The packed `@nredd/pi-computer-use` through the platform-aware tool set (13 tools on macOS, 11 on Linux) plus Mach-O arch/mode checks of both prebuilt helpers; its `postinstall` and every desktop tool are NOT RUN. JSON reports uploaded as artifacts |
| `stack (ubuntu-24.04, macos-14, wsl2; personal, local)` | `stack (ubuntu-24.04, personal)`, `stack (ubuntu-24.04, local)` and `stack (macos-14, local)` run Node release-bundle D/E and build the core Gitlink with Bun for standalone D/E of their own stack. A PR with no stack inputs skips the personal steps. The other three cells report NOT RUN | `stack (ubuntu-24.04, personal)` only; the other two running cells log the selective smoke and the three bypass cells report NOT RUN | Every cell reports a bypass or NOT RUN | Node release bundle plus source-built linux-x64/darwin-arm64 standalone, independent stack installations, startup/transport/lifetime/output/tool surfaces and tmux resize; seven Node-preload auth cases per standalone stack explicitly skip, missing-preload refusal runs. Separate Node/Bun JUnit and failure artifacts, stack identities and binary/archive SHA-256 retained. Computer-use helper explicitly excluded |

`check-scripts` and `check-integration` share one Makefile recipe, `PY_GATE`: ruff format and check, ty, then `pytest -n auto --dist loadfile` (pytest-xdist is already locked) with `--cov=<project root>` writing LCOV to `<project>/coverage/python/lcov.info`. `--dist loadfile` keeps every test file on one worker, as the scenario runs already do (`integration/Makefile`). The reports are uploaded in the `coverage-<os>` artifact and `check-coverage` accounts for them as `python-scripts` and `python-harness`. The fan-in's accounting step sets `COVERAGE_HOST` to the plan's `guest` for the cell (`RUNNERS` in `scripts/ci_paths.py`) so the WSL cell, which has no pytest, reports those two signals NOT RUN instead of failing on a missing report (`skip_hosts` in `coverage/policy.json`, pinned to each cell's planned gates by a test). Serial and parallel runs were compared test by test: identical pass sets, no order-dependent test. `check-benchmark` is its own recipe: pytest-cov at `fail_under = 100` with branch coverage, writing `benchmarks/comparison/coverage/python/lcov.info`, accounted as `python-benchmarks` (#387). The macOS `python` shard uploads that report after the benchmark steps, and the fan-in's `COVERAGE_SKIPPED_GATES` (the plan's `skipped_gates`) reports it NOT RUN on a PR that skipped the gate.

The macOS `Benchmark unit gate` exports `UV_PYTHON` from `.python-version` before `make install-benchmark`. The runner image's Homebrew Python moved to 3.15.1, `benchmarks/comparison/uv.lock` has no cp315 `pydantic-core` wheel, and uv compiled it from source: ~84s in the sync, then again in each cold-cache gate sync that `test_prepare_finalize.py` runs (the gates inherit `sys.executable`). That step went from 58s (3.14.7) to 464-500s (3.15.1) and pushed `owned (macos-14)` to the 30 min limit (#304). The pin keeps the same tests and the same timeout.

There is no `bench` job. `classify`'s step summary and a notice say bench is NOT RUN: no quiet self-hosted runner exists yet (migration plan section 7).

Which cell does what. Every required check name reports, per the ruleset below. A *bypass cell* takes the job name on a cheap `ubuntu-24.04` runner, holds no macOS or Windows slot, runs only the `plan` step and emits a `::notice` plus a step summary saying NOT RUN, why, and that this is not a pass. A green bypass cell is a reported name, not evidence.

| Check | PR | `main` push |
| --- | --- | --- |
| `owned` / `contracts (ubuntu-24.04, macos-14)` | Runs, except the macOS `check-benchmark` step, which runs only with `benchmark_inputs` | Runs |
| `owned` / `contracts (wsl2)` | Runs on `windows-2025` only with `wsl_inputs`, otherwise bypass cell | Runs on `windows-2025` |

For `owned`, "runs" means its shard jobs run on that runner; the `owned (<os>)` fan-in itself always reports from `ubuntu-24.04`.
| `stack (ubuntu-24.04, personal)` | Runs; without `stack_inputs` only setup runs and the personal steps report NOT RUN | Runs, ignoring `stack_inputs` |
| `stack (ubuntu-24.04, local)` | Runs | Selective smoke, not run |
| `stack (macos-14, local)` | Runs | Selective smoke, not run |
| `stack (macos-14, personal)` | Bypass cell | Bypass cell |
| `stack (wsl2, personal)` | Bypass cell | Bypass cell |
| `stack (wsl2, local)` | Bypass cell | Bypass cell |

`scripts/ci_paths.py` is the CI plan module. `classify` reads the diff and `plan_cells` turns it into one decision per required check name, published as a single `plan` JSON output next to `docs_only`, `wsl_inputs`, `stack_inputs`, `benchmark_inputs` and `changed_files`. Each cell's entry carries `run`, `scenarios`, `gates` (the Make targets an `owned` cell runs across its shards), `reason` (the NOT RUN text, from one `NOT_RUN` table), `blocked`, `shards` (a running `owned` cell's shard jobs, else empty), `guest` and `coverage_os` (a running `owned` cell's `--host` and `--os` for the fan-in's accounting, from `RUNNERS` and `COVERAGE_OS`, else empty), and `skipped_gates` (the cell's planned gates this run skips, `--skipped-gates`; each shard entry carries its own share). The three jobs hold no decisions. Their `plan` step is the shared composite `.github/actions/report-plan`, which reads `fromJSON(needs.classify.outputs.plan)[<check name>]`, reports `::notice` and the step summary, and fails closed when a cell has no entry. A local action needs a checkout, so each job first does a sparse checkout of `.github/actions`; the full checkout still runs only when the plan says the cell does. Every other step is gated with a step-level `if` on `steps.plan.outputs.*`; there are no workflow-level path filters. `runs-on` also reads the plan: a cell that does not run (NOT RUN, blocked, or no plan) reports from `ubuntu-24.04` and holds no macOS or Windows slot, docs-only native cells included. The plan's tests run over real Git diffs (`scripts/tests/test_ci_paths.py`), and `scripts/tests/test_ci_guest_matrix.py` walks the real step conditions over that real plan.

A failed `classify` must turn the 12 required checks red, because a skipped job satisfies a required check. So `owned`, `contracts` and `stack` run under `if: ${{ !cancelled() }}` and `report-plan` fails every cell when `needs.classify.result` is not `success`, or when the plan has no entry for the cell. `plan` falls back to `{}` when classify published nothing, so those cells also land on Ubuntu. Hosted proof: with `classify` forced to fail, all 12 required names ran and failed, none skipped ([run 41702304169](https://github.com/nredd/pi-harness/actions/runs/41702304169)).

The plan fails closed: an unreadable comparison, an empty diff or a Gitlink change sets every input true. A `workflow_dispatch` full verification has no diff, so `classify` runs `ci_paths.py --full` after its ref and ancestry guard: every input true, every cell planned to run. `benchmark_inputs` is one `INPUT_CLASSES` entry. `PATH_GATED_GATES` maps `check-benchmark` to it: on a non-push run without those inputs the plan lists the gate in `skipped_gates`, and both the shard's run/skip steps and the fan-in's accounting read that one decision.

Adding an input class (for example the benchmark gate's inputs) is one `is_*_input` predicate, one entry in `INPUT_CLASSES` and the rule in `plan_cells`; the output, the `ChangeClassification.inputs` mapping and the tests' fixtures follow the registry.

`owned` is sharded (#350). Each OS has an `owned-shards-<os>` job, whose `if` reads the cell's `run` and whose matrix `include` *is* the cell's `shards` list from the plan, and an `owned-<os>` fan-in job that reports the required `owned (<os>)` name. `scripts/ci_paths.py` `OWNED_SHARDS` owns the split; no step names a shard. Each shard runs one step per gate it lists (`Owned gate check-ts`, `check-scripts`, `check-integration`, and on WSL `check-probes`, `check-providers`, `check-import-audit`), each under `!cancelled()` after a successful `Install`, so a failing gate never hides another gate's evidence. A `check-ts` shard runs `make check-ts WORKSPACES="<paths>"`, which is `npm run check --workspace=<path>...`: each package's own `npm run check`, unchanged, in npm workspace order, one package at a time; no `-j`. A `check-ts` shard that names no workspaces takes every workspace no other shard of its cell names, computed from the root `package.json` when the plan is built, so a new workspace lands in a shard without a table edit, and the plan refuses a split that names an unknown workspace or leaves a `check-ts` shard empty. `make check-ts` with no `WORKSPACES` still runs every workspace locally. `harness.release_gate` requires each shard's gate steps and each fan-in's steps (see [release-verification.md](release-verification.md)); renaming a step means updating `OWNED_GATE_STEPS` there, and a test pins its `OWNED_SHARDS` to the plan's. The `Benchmark unit gate` step keeps its implicit `success()` (no `!cancelled()`) and runs when the shard's `gates` list `check-benchmark` and its `skipped_gates` do not. It runs before the shard's coverage upload, which carries its LCOV.

A shard whose gates include `check-integration` (the Ubuntu and macOS `python` shards) installs tmux first with the `stack` job's own steps, `Install tmux (Linux)` (`apt-get install tmux`) and `Install tmux (macOS)` (`brew install tmux`) (#383). The integration units drive `harness.tmux`, `rpc`, `headless`, `interactive`, `probe` and `fleet_load` against `integration/tests/stub_pi.py` on private tmux servers, so those modules are measured in `python-harness` instead of only running in the uncovered `stack` scenarios. No shard runs a real Pi for this. The WSL guest never runs `check-integration` and needs no step.

Shards (from the per-package timings in #350, run `41749405074`):

| Cell | Shards | Why |
| --- | --- | --- |
| `owned (ubuntu-24.04)` | `subagents`; `computer-use`; `ts` (every other workspace); `python` (`check-scripts`, `check-integration`) | The issue's four units: about 196s, 157s, 254s and 271s of gate time, against 883s in one job |
| `owned (macos-14)` | `ts` (every workspace); `python` (`check-scripts`, `check-integration`, `check-benchmark`) | At most two: a public repo gets 5 concurrent macOS runners for every PR together, and queues already ran about 2h. All TypeScript is about 653s, the Python gates plus the benchmark about 617s, the most even two-way split of the units |
| `owned (wsl2)` | `subagents-computer-use`; `ts` (every other workspace, `check-probes`, `check-providers`, `check-import-audit`) | About 461s and 324s of gate time. Each Windows job pays about 3.5 min of WSL guest setup before its first gate, so a third shard would buy about 2.5 min on a cell that already finishes inside the macOS critical path |

The fan-in (`owned-<os>`) runs on `ubuntu-24.04` for every cell, with `if: !cancelled()` and `needs: [classify, owned-shards-<os>]`; `needs` is per job, so one fan-in matrix would hold Ubuntu's check until the macOS shards finish, which is why each OS has its own pair of jobs. The three shard jobs and the three fan-ins share their definitions through YAML anchors, and each fan-in is a one-cell matrix so a never-started fan-in keeps the `owned (${{ matrix.os }})` placeholder name. The fan-in reports the plan like every other cell, then `Require every planned shard to succeed` fails a running cell unless `needs.owned-shards-<os>.result` is `success`: that value folds the whole shard matrix, so any failed or cancelled shard, or a shard job skipped although the plan runs the cell, turns the required check red. It then downloads the cell's `coverage-<os>-<shard>` artifacts (each into its own directory), fails if two shards produced the same report path, copies them back to their repository paths and runs `make check-coverage` on them, under `always()` like before. The plan's `coverage_os` and `guest` become `COVERAGE_OS` and `COVERAGE_HOST`, so `darwin` accounts the macOS cell's reports against the darwin floors with no OS switch in the workflow; the accounting reads only reports, the policy and Git, as in the `--reports-root` replay. The fan-in uploads the merged reports plus `coverage/summary.json` as `coverage-<os>`, the artifact `harness.release_gate` binds to `owned (<os>)`. A NOT RUN, docs-only or blocked cell plans no shards and its fan-in reports exactly as a bypass cell did.

PR title length: on `pull_request`, `classify` checks that `<title> (#N)` passes the same rule `packages/computer-use/scripts/check-commit-messages.mjs` lints on `main`: at most 72 UTF-16 units (JavaScript `String.length`, so an emoji counts twice), a capital first letter after an optional `area: ` prefix, no trailing period. `ci_paths.is_valid_subject` mirrors it, and a test runs the real lint over the same subjects, including the whitespace characters where JavaScript's `\s` and Python's differ, so a drift in the cases it covers fails. A failing title makes the plan blocked for *every* cell: each `plan` step fails with the reason, before any macOS or Windows slot does work. `classify` itself stays green for that case, and a missing title on a `pull_request` also blocks rather than skips. `pull_request` does not re-run on a title edit, so after retitling push a commit or close and reopen the PR.

Not moved yet: the commit-subject lint itself (`test:commits`) still runs inside `packages/computer-use` `check` on each OS cell. Removing it means editing that package's `package.json` and `scripts/check-commit-messages.mjs`, both tracked in `packages/computer-use/sync-patches.json`, so it needs its own upstream-sync change. The PR title check removes the post-merge failure, which was the actual harm.

- `wsl_inputs`: `.github/`, `scripts/wsl2_*`, `scripts/ci*`, `integration/probes/`, `integration/providers/`, the lockfiles and `integration/pyproject.toml`, the guest bootstrap's `scripts/install_gh_linux.sh` and `scripts/install_wsl_owned_tools.sh`, the guest gates' `scripts/import_audit.ts`, `scripts/check-biome-paths.mjs`, `scripts/router_contract.mjs`, `scripts/run-vitest.ts`, their four tests and `scripts/vitest.config.ts`, `coverage/policy.json` (the inventory that config and the probes and providers configs read), `Makefile`, root `package.json` (`packageManager`), `.npmrc` (npm fetch retries), `.gitattributes` (the LF checkout), `.gitmodules`, `.node-version`, `.bun-version`, `.python-version`
- `stack_inputs`: `integration/{stacks,harness,scenarios,providers,golden,probes}`, `integration/conftest.py`, `integration/pyproject.toml`, `integration/uv.lock`, `Makefile`, `.github/`, `forks/`, root `package.json`, `package-lock.json` and `.npmrc`, `.gitmodules`, the same version pins, `scripts/wsl2_*`. `packages/` is not one: `harness.stack` maps those paths into `local`, the personal stack installs published bytes
- `benchmark_inputs`: `benchmarks/comparison/` (code, tests, `pyproject.toml`, `uv.lock`, results), `Makefile` (`install-benchmark`, `check-benchmark`, `PY_CHECK`), `.python-version` (the step's `UV_PYTHON`), `.node-version` (the Node that installs the pinned Codex), `.github/workflows/ci.yml` (the Codex pin and the step), `.github/actions/setup-ci-tools/`, `scripts/ci_paths.py` (a broken predicate cannot switch the gate off on the PR that breaks it). Nothing else reads it: no product package imports it, and `coverage/policy.json` only inventories it

The macOS `Benchmark unit gate` (issue #315) is path-gated at step level, not by a workflow path filter, so `owned (macos-14)` still reports. It runs when `benchmark_inputs` is true or on every `push` to `main`, which still catches runner and image drift (#304). A PR without them prints `check-benchmark NOT RUN` with the reason in the log and step summary, and the macOS fan-in reports `python-benchmarks/primary` NOT RUN instead of failing on its missing report. That is not a pass. When the step runs, the report is required: `fail_under = 100` blocks the step and `check-coverage` enforces 0/0 on darwin (#387). `make check` still runs `check-benchmark` locally. A `benchmarks/comparison` break from a change outside the list above, e.g. a root `package.json` `packageManager` bump, fails on the `main` push, after merge. The NOT RUN reason points at `BENCHMARK_INPUT_FILES` and `BENCHMARK_INPUT_PREFIXES` in `scripts/ci_paths.py` instead of copying the list.

Evidence given up to cut queue time (issue #297):

- No WSL stack acceptance at all, on any event. Node D/E, standalone D/E and the auth adapter no longer run in WSL
- No macOS `personal` or published-stack run. macOS proves only `local`, on Node and standalone
- WSL `owned` and `contracts` on PRs only with `wsl_inputs`. A `packages/` change that breaks only in WSL fails on the `main` push, after merge
- The WSL guest no longer runs `pytest scripts`, `pytest tests`, or the ruff and ty steps of `check-scripts` / `check-integration`. Ubuntu runs them. `check-probes`, `check-providers` and `check-import-audit` stay because `coverage-wsl2` needs their LCOV
- `main` no longer runs standalone `local`: it moved into the `local` cells, which the selective smoke skips on a push. The non-strict ruleset means a merged tree can differ from the PR head that proved it
- WSL distribution packages are no longer upgraded (`update: 'false'`); `additional-packages` still refreshes apt and installs the current packages

Computer-use's macOS Swift invariants explicitly prepare SDK-only imports in their private per-run
module cache before checking repository sources (#551). Cold preparation is visible and bounded:
240s compilation, 10s per identity probe and a 300s setup-hook cap, with bounded child-group cleanup.
Failure fails the suite; it never authorizes source validation. `INV-8` retains its 90s test deadline,
`INV-17` its 50s deadline. Compiler-file/SDK-settings identity, real invalid/corrected Swift and
concurrent caller controls verify reuse of SDK modules, not reuse of source verdicts. No persistent
cross-run cache, shared gate lock or retry is introduced; #506's private caches and unwritable
retired-name controls remain. Details: [develop and validate](../packages/computer-use/docs/content/docs/how-to-guides/develop-and-validate.mdx).

In the `owned` cells, `@nredd/pi-computer-use`'s macOS-only checks are not passes on Linux: Vitest reports `test:invariants` INV-8/INV-17, `test:macos-native` and `test:desktop`'s helper wire mapping and gating as skipped, and so are `macos-helper-live.test.mjs` (also opt-in) and `linux-live.test.mjs` (opt-in, Linux). Conversely, `linux-native.test.mjs` (`test:linux-native`) runs headless on the Ubuntu and WSL cells (`NOT RUN` on macOS): the crate's `cargo test --locked`, a source build from the *packed* tarball into a user-cache target dir, the built x64 helper's real `diagnostics` (protocol 4, shared architecture invariants), the cargo-missing hint and compiler cleanup on `SIGTERM`. The aarch64 target (`rustup target add`) is `cargo check --locked` compile-only; ARM64 runtime, desktop/display and live UI are NOT RUN. This is coverage inside the `owned` cells' computer-use shards' `npm test`, not a new required check (Vitest reports it passed on Ubuntu and skipped on macOS; the ARM64 case is skipped unless `PI_CU_LINUX_ARM64_CHECK=1`). `windows-build-scripts.test.mjs` stays opt-in like the script it replaced: it is skipped unless `PI_CU_WINDOWS_SCRIPTS=1`, which `npm run test:windows-scripts` sets. Its two macOS helper builds took 10-56 s each locally and passed the scripts' 120 s deadline under fleet load.

Phase 0 coverage runs inside the existing primary and declared Bun test invocations, never a
second CI test pass. Each Vitest config reads its owned source from `coverage/policy.json`, uses text + LCOV and
`reportOnFailure`; `subagents` retains Istanbul because V8 reload merging is incorrect. The
`check-probes` and `check-import-audit` helper gates run Vitest with V8 coverage too, since #347
(c8 + `node --test` before), and `check-providers` since #378 (native cells run it inside `check-integration`). Each `owned` fan-in's `always()` step consumes its shards' independent
reports with `scripts/coverage_accounting.py`, selects `darwin` / `linux` integer uncovered-line/function
floors with `COVERAGE_OS` (`--os`, the plan's `coverage_os`; the default is `sys.platform`), compares **every OS's enforced floors** with the PR base's `coverage/policy.json`,
and fails closed on missing/invalid input or a missing OS floor. Hosted artifacts, not a local Mac,
establish per-runner floors. `owned (wsl2)`'s shards run inside Ubuntu on WSL2, and its fan-in
explicitly enforces the same Linux floors as native Ubuntu. Each WSL shard exports its LCOV reports
from the Linux filesystem before Windows uploads them; the fan-in accounts and uploads `coverage-wsl2`.
No counters are combined across runners. Native Windows coverage is not measured. WSL contract
scenarios remain separate acceptance evidence, not owned-source coverage. To regenerate a review-only policy diff from an
artifact, run `uv run --locked --project integration python scripts/coverage_accounting.py --measure
--os linux --reports-root /tmp/cov-linux --summary /tmp/measured-linux.json` (use `darwin` and its
artifact for macOS). The full download/replay and independent-two-run comparison procedure is
[here](coverage.md#refresh-floors-from-hosted-artifacts); this command never edits or commits policy. Uncovered
branches are capped per signal like lines/functions ([here](coverage.md#branch-caps)). Final hosted run
`40857829296` established zero primary misses for all eight packages on macOS and all except
resource-sampler on Linux, whose 47 lines / 8 functions in native `darwin.ts` paths went to 0/0
with #375's fake-host FFI tests; no package has a per-OS allowance. Session-kit now has zero primary misses on both
OSes after the deterministic formatter test removes the incidental comparator hit (#163).
The earlier 110/32 transitional floor is historical only. Another `always()` step retains LCOV and the per-package/per-file JSON summary
on either outcome. Bun signals for `dev-tools`, `plan-mode`, `preset`, `subscription-router` and
`todo` are enforced at 0/0 on both OSes (#320), `resource-sampler` since #375 and `inprocess` since #376. The rest explicitly use `enforcement: "report-only"` with
mandatory reasons linked to #160. Report-only signals retain fail-closed LCOV parsing, expected-file checks,
per-OS references, inventory ratcheting, and text+LCOV reporter checks. Counts and signed deltas
from references are logged and included under JSON `signals`; budget excess alone cannot fail
these advisory signals. Primary budgets stay enforced and define the 100% goal. Never merge
Bun counters into primary coverage.

The owner's roughly 1-7% small-subset description is not a measured source-coverage percentage:
historical hosted run `40455349710` had plan-mode 8/539 Bun/primary tests (1.5%), subagents 22/3078
(0.7%) and todo 2/387 (0.5%); preset and in-process ran their full test sets. plan-mode and todo
now run their full suites under Bun too (#320). The precise limitation is
incomplete verified source scope. A strict Bun budget blocked main #153's primary-tested additions
(subagents Bun 7728/512 -> 7763/515, primary unchanged at 500/68 on both OSes).

A package flips to `enforced` only after its full suite runs under Bun on both OSes AND Bun's
inventory covers every owned executable source file, including never-imported files, as specified
by #160. Accounting rejects enforced partial Bun inventories. Any later enforced-to-report-only
flip requires a new reasoned `enforcement_changes` entry relative to base; standing reasons or
historical approvals cannot silently waive enforcement. Initial policy introduction is allowed.
Enforced-to-enforced floors ratchet per OS; advisory references do not become hidden budgets.
`computer-use` stays not measured, tracked for its native Swift/Rust and documentation site. Its 33 JS/TS runtime modules are measured by the report-only `computer-use-vitest` signal (#347). `dev-tools` uses #195's primary Istanbul decision with
all 23 executable modules and zero uncovered lines/functions on both hosted OSes after #155.
Its Bun signal runs the same full Vitest suite on Bun and is enforced at 0/0 since #320. Python `scripts/` and `integration/harness/` are measured by `PY_GATE`, `benchmarks/comparison` by `check-benchmark` on macOS (see `docs/coverage.md`). The Vitest
producer configurations are measured by `import-audit` (#380, see `docs/coverage.md`).
The repository-wide TS/Python/JavaScript audit and the base-tree/current-tree inventory ratchet
prevent silent source omission; reasoned reclassifications are required for membership losses.
Verification-only scripts have exact per-file `verification_helpers` reasons; shipped runtime
scripts remain owned production source, never blanket helper exclusions. The policy's eventual
global-zero flip refuses pending packages.
No job or required-check name changes. Definition, exclusions, receipts and ratcheting:
[here](coverage.md).

The resource sampler's package gate runs real host sampling and bounded helper cleanup in each
`owned` OS cell. `check-package-contracts` also builds/audits/installs its exact ESM tarball and
runs an isolated Node consumer in each `contracts` OS cell. This library has no Pi entrypoint;
Darwin process CPU is native interval CPU on Node >=26.1 and Bun, authenticated with libproc
start identity rather than `ps` whole-second precision. Older Node remains explicitly unavailable.
No consumer migration, publication, extra CI job or runner is added.

## Standalone startup failure evidence

The Linux personal cell runs one extra **strict** text startup before D/E: the same explicit
personal stack, faux provider, `STACK-OK` output, zero exit and empty stderr as
`test_extensions_load_without_warnings[text]`. No retry can turn a failure green. On failure only,
`standalone-startup-linux-x64` retains the exact executable and `SHA256SUMS` for seven days.
The normal standalone suites still run and retain their original assertions.

`harness.standalone_diagnostics` stages an explicit allowlist and scans *every input*, binary
included, through the shared `harness.credentials.require_safe_diagnostic` policy before atomically
publishing the upload directory. This preserves #178's npm (at least 36 alphanumerics), short GitHub,
sk/pk, Slack and general private-key signatures alongside main's nonempty JSON/Bearer and release
URL/proxy policy. There is one shared scanner, not a collector-local duplicate. Signatures are
conservative heuristics, not a guarantee against every secret format. A scan or capture failure
leaves no partial upload and cannot mask the original failing exit status.
The upload also requires the probe's `artifact_ready=true` output, emitted only after a new
scanned publication; stale directories and early failures cannot authorize an upload.
It never copies installed homes, `auth.json`, `.storage`, sessions, environment dumps or token stores.
All subprocesses use a new harness fixture HOME, empty synthetic auth and the existing command shims.
This is diagnostic hygiene, not isolation from malicious same-UID package code.

Artifact files:

- `pi`, `SHA256SUMS`, `build.json`: exact executable, per-file SHA-256, schema-validated
  Gitlink/harness SHAs, tool versions, build/startup commands and separate primary/replay verdicts.
- `compile-command.json`, `module-graph.json`, `build.log`: the actual compile argv, Bun's
  module graph and the frozen-data build log. A transparent build-only Bun wrapper adds
  `--metafile`; it changes neither core sources nor production pins. Missing optional metadata
  is explicit; a graph cannot establish the undefined symbol's cause by itself.
- `packages/pi-memory/{index.ts,package.json,npm-lock.json}` (the lock's memory entry only),
  `core/*.js`, `core/*-package.json`,
  `core/package-lock.json`, `harness-package-lock.json`, `stack.json`: named public package/build
  inputs only, with original bytes. No recursive package or home upload.
- `startup.{stdout,stderr}` and `jiti/primary/*`: byte-exact original failed startup streams (including
  CRLF and invalid UTF-8) and *only*
  Jiti 2.7 transform filenames keyed to this fixture's exact `pi-memory/index.ts` path (MD5 and
  FIPS SHA-256 naming variants). Cache absence is recorded, not replaced with another run's code.
- `replay.{stdout,stderr}`, `replay-wrapper.ts`, `jiti/replay/*`: supplemental failure-only replay.
  In the disposable fixture, memory's resource declaration/filter selects a wrapper at the same
  package-order slot. It imports the untouched original entry, prints `error.stack` before Pi
  reduces it to a message, then **rethrows**. Original package manifest/source/cache bytes are
  captured *before* this instrumentation; the executable is never rebuilt or patched. A replay
  passing or failing differently does not replace the primary failure or prove a root cause.
  Replay streams are also raw bytes. Primary-stream decoding is separate, only for strict startup matching,
  never for artifact contents. Timeouts retain untouched partial streams (absent data becomes empty
  bytes), use synthetic exit status 124 and record `startup_timed_out`/`replay_timed_out` in `build.json`;
  no annotation is appended to stderr. A normal child exit 124 remains distinguishable from a timeout.

To diagnose an already-built binary without running the whole suite:

```sh
cd integration
uv run --locked python -m harness.standalone_diagnostics startup \
  --binary /absolute/path/to/linux-x64/pi --core ../forks/pi \
  --build-evidence /absolute/path/to/pi-build-evidence \
  --output /absolute/path/to/new-failure-evidence
```

For PR #178's exact graph, cherry-pick the diagnostic harness commit onto that branch and run its
normal CI. The workflow observes that branch's existing frozen-core build; do not copy a binary
from this diagnostic PR or change package/core/Bun pins. Do not reuse an installed live HOME.
Local successful startup creates no artifact. A deliberate synthetic throwing memory factory can
verify the raw-stack/capture path, but is not a reproduction of the unexplained CI `Type3` failure.

## Startup exit failure evidence

The existing per-scenario artifacts now retain `*.pane.json` captured **before** tmux teardown,
`*.exit` wrapper status files when present, and raw startup/RPC `*.stderr`. The pane report keeps
the native PID/dead/status/signal response (empty fields can mean unsupported tmux formats), the
wrapper status path and its contents or absence; a vanished server is recorded as an error rather
than replacing the original failure. Only these named artifact patterns are added to the existing
allowlist, never arbitrary JSON, environment dumps or a recursive sandbox HOME. Every candidate's
complete raw bytes, including existing sessions/screens, are scanned **before publication**.
`harness.credentials.require_safe_diagnostic` is the shared publication policy: it reuses
`release.redact_diagnostic` for URL/known proxy credentials and centralizes the signature rules
extracted from the #191 collector. Scenario publication, the standalone collector and the WSL
guest-state capture (through `python -m harness.credentials`) consume this same helper, with no
collector-local credential regex or dependency from the shared helper back onto a collector. Long
token/key signatures remain checked. Explicit canonical JSON string
fields `access_token`, `refresh_token` and `api_key` are refused for **any nonempty string value**;
case-insensitive `Bearer` followed by any nonempty whitespace-delimited value is refused regardless
of length. Empty/null credential slots and metadata keys such as `api_key_available`,
`access_token_count`, `auth_type: "Bearer"` and `token_count` are not auth dumps by themselves.
The Bearer rule deliberately may reject prose describing a token. Signatures are heuristics, not
proof against arbitrary secrets, unknown/escaped credential keys or encoded values.

Candidates are staged outside the uploaded artifacts root, scanned and written from the same byte
snapshot, then renamed into place only when the complete set is safe. Any unsafe/unreadable candidate
or staging error refuses the whole set, removes stale publication and leaves the primary verdict
unchanged; raw bytes are never redacted into a misleading "exact" capture. Every ancestor from the
sandbox root itself through the candidate's parent must be an actual directory, including internal
parent links that happen to resolve inside the sandbox. Candidate reads reuse the `harness.files`
regular-file pattern: reject known nonregular entries before opening, then use `O_NOFOLLOW`,
`O_NONBLOCK`, `O_NOCTTY` and descriptor `fstat` before reading. Final symlink/FIFO replacements cannot
turn cleanup into a blocking FIFO read. Ancestry checks are observations, not a descriptor-anchored
sandbox against concurrent malicious same-UID parent replacement. No broader filesystem-security
claim is made. Pane reports use a strict `PaneExitEvidence` Pydantic model, including a read-only `ps` subtree of the pane PID (`process_tree`; empty when the wrapper is gone, never a signal). Missing tmux, invalid UTF-8
markers and capture/write failures cannot prevent server teardown. RPC evidence open/write/flush
failures disable only the disk sink: bounded pipe drainage and in-memory diagnostics continue.
This supplements, not duplicates, the separate standalone build/startup collector from #191.

Observed on 2026-10-28, both in `Standalone D and E (local)`:

- PR #155, run `40666549747`, job `122742471639`: `ordinary-session_start-tui` fails with
  `TUI never reported its exit status`. Its saved screen contains `STARTUP-OK` and the resume hint.
  Original `pi.stderr` reports `Bun v1.3.14 (0d9b296a) macOS Silicon`, macOS `14.8.9`,
  `Elapsed: 8573ms`, feature `exited`, and `Segmentation fault at address 0xC`.
  The decoded trace [here](https://bun.report/1.3.14/M_10d9b296mggQugggC______mk04Yuw4uhBu7l7H_2lkjlDurh5kD27p5tC+xt2yC+1+3H_2lkjlDurh5kDunr21Cusw11CA2AY)
  resolves through `jsc.VirtualMachine.globalExit`, `Bun__Process__exit` and
  `Bun::Process_functionReallyExit` / `Process_functionExit`.
- PR #178, run `40667021371`, job `122744482131`: the failure is instead
  `ordinary-session_start-rpc`, `subprocess.TimeoutExpired` after 60 seconds. Its TUI case passes.
  The traceback's truncated `stderr_seq` contains the Bun `1.3.14` crash banner; the original full
  timeout stderr was not archived. The `-9` return code is observed after Python's timeout kill,
  not a successful runtime shutdown.

Both include a curl-shim `Bad file descriptor` error. Bun's macOS crash reporter invokes curl
([here](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/crash_handler/crash_handler.zig));
that downstream error is not evidence that an extension's curl caused the crash. The historical
artifacts lack pre-cleanup pane state and `*.exit`; they cannot distinguish a live crashed process
from a dead wrapper or missing status file. RPC does not use that wrapper at all.

A local rebuild of Gitlink `2bfb8e7c61d35167b09f8ce70693df39660fc197` with Bun `1.3.14` and frozen
release model data passed 29 original TUI and 29 RPC startup calls, including two concurrent drivers.
The initial two-case command was `PI_BIN=<rebuilt-pi> uv run --locked pytest
'scenarios/test_startup.py::test_fatal_startup_modes[ordinary-session_start-tui]'
'scenarios/test_startup.py::test_fatal_startup_modes[ordinary-session_start-rpc]'
--stack stacks/local.json --runtime bun-standalone -q`: 2 passed. A diagnostic driver then invoked
that unchanged scenario function on copied explicit fixtures: 12 serial pairs, then two concurrent
drivers of 8 pairs each (qmd failure shim for the concurrent run), all passed. Recorded local logs:
`/tmp/fix-tui-repro.log`, `/tmp/fix-tui-repeat.log`, `/tmp/fix-tui-stress-a.log` and
`/tmp/fix-tui-stress-b.log`; these workstation logs are not durable CI artifacts.
This is not a native-crash reproduction or a fix. Synthetic abort and timeout tests prove the
original nonzero/timeout failure and raw evidence survive cleanup; no assertions, deadlines, Bun
pins or runtime behavior are relaxed. The exact native trigger and a failing-CI pane-state capture
remain unresolved. No capacity cancellation is classified as this failure.

RPC EOF exit (#100): the 15s `RPC did not exit on EOF` timeout is a Bun `1.3.14` native exit crash, not a
live-monitor shutdown bug, so EOF keeps its graceful contract and no test stops its monitor early. The
captured failures hit session D (no monitors) and `test_children_die_when_pi_quits_mid_monitor[stop]`
(monitor already stopped), while `[rpc]` EOF with a live monitor exits 0 and reaps its group on every
passing run. Since Bun `1.4.4` (#197, 2026-10-29) the 73 PR runs among the latest 100 CI runs hold 61 passing macOS personal
stack jobs and no EOF timeout or `Segmentation fault` in any failed run (measured on `ad747f42`). That is
absence of recurrence, not a proven fix. `RpcProcess.__exit__` now puts the child's drained stderr in the
`TimeoutError`, so a recurrence names the crash banner in the failure itself.

Final privacy/cleanup proofs additionally reject internal parent/root links and a root `pi.stderr`
FIFO without ever opening it for reading. Stale regular-file prechecks with a FIFO or final symlink
replacement are refused through the descriptor checks; removing `O_NONBLOCK` fails a pre-open test
assertion, so the mutant cannot hang the test. Short synthetic fields/Bearer values are injected
across all seven artifact categories while the primary exception remains unchanged and no artifact
set is published. Public metadata negative controls still pass. Removing ancestor checks, restoring
plain `Path.read_bytes`, reverting the short-credential rule, or removing `O_NONBLOCK` each fails a
focused mutant (workstation logs `/tmp/tui-finalprivacy-mutant-{ancestry,regular,short,nonblock}.log`).

Blocker regression receipts:

- Unsafe-byte injections cover markers, pane reports, raw stderr, screens, scripts, event logs and
  session history for token signatures, URL credentials and known proxy passwords. No partial/stale
  artifact tree is published; injected staging write failure preserves the primary assertion.
- Missing-executable/server/I/O pane queries still attempt teardown. Invalid UTF-8 marker bytes
  remain unchanged, produce an explicit model error field and retain the original decode failure.
  Real fixture-generator and direct-startup-owner tests inject missing tmux, screen decode and
  screenshot write errors: every owned pane is killed and the primary failure is retained.
  An unavailable final screenshot cannot replace `wait_dead`'s exit-status assertion.
- RPC evidence open/write/flush failures still drain 262144 stderr bytes plus a tail diagnostic;
  the real child exits 17 without pipe blockage and bounded in-memory diagnostics retain the tail.
- The startup proof prints the required startup message and observes exit 17 specifically. Its
  exit-0 control succeeds. Mutating the observed exit 17 to 0 makes that regression fail with
  `DID NOT RAISE AssertionError`, rather than accidentally testing the missing-message assertion.
- Mutation checks disable scanning, restore the prior pane capture, restore the prior RPC writer,
  and change the nonzero result to zero. All four are killed by the focused regressions. Local
  logs are `/tmp/tui-mutant-{scan,pane,writer,zero}.log`, not durable CI artifacts. Restoring the
  old fixture teardown or final timeout screenshot separately also fails the caller regressions
  (`/tmp/tui-mutant-teardown.log`, `/tmp/tui-mutant-wait-capture.log`).

## Self-hosted pools

Heavy Linux and macOS cells run on an owned machine while one has room, and on the hosted runner otherwise: `pi-linux` (NAS VMs, 2 slots) takes Linux cells and `pi-macos` (MacBook, 2 slots, macOS only) takes macOS cells. Job names, steps and check names are unchanged; only a cell's runner differs in the `classify` plan. WSL and every cell not in `CELL_SECONDS` are always hosted.

- Each pool's host writes the repo variable `PI_LINUX_HEARTBEAT` / `PI_MACOS_HEARTBEAT` every ~45 s as `<epoch>:<free>` (`0` on a clean stop), where free = slots minus running minus queued jobs for that pool's label. It is negative while more jobs wait than the pool can start, which is how a run sees that the queue is already deep. A host that has been told to stop writes `<epoch>:drain` instead: it finishes the job in flight, starts nothing new, and exits. The host only beats while its scheduler loop is alive, so a hung supervisor goes stale like a dead one. `scripts/runner_pools.py` treats a beat as up only if the epoch is a positive integer at most 120 s old (30 s of skew tolerated); a plain epoch (no count) means one free slot. Missing, `0`, stale, `drain` or garbled means hosted. A mistyped `--pool-heartbeat POOL=VALUE` fails `classify` instead of quietly going hosted
- Queue depth: a pool takes `free + queue_depth` cells from a run, floored at 0. `pi-macos` has depth 1, because hosted macOS queued a median 10 minutes while a slot on the Mac frees in about that time, so one waiting cell still wins; `pi-linux` has depth 0 because hosted Linux queues for seconds. The negative backlog in the beat stops concurrent runs from each adding another cell, but a run only reads it once, at `classify`, and the writer publishes a changed count within one poll (~20 s). Runs that classify inside that window all see the same count. Each run routes at most one macOS cell today (`CELL_SECONDS`), so five PRs opened within a few seconds can put five cells on two slots: the third and fourth wait about one cell (~10 minutes), the fifth about two, which is worse than hosted's median queue
- Nothing bounds a cell queued on a LIVE pool that is merely busy: the rescue moves a cell only when its pool is down, `drain` or stale. If that starts to hurt, the fix is a rescue rule for a cell queued past ~10 minutes on a busy pool (it cancels the whole run, so it trades finished shards for a re-plan), or one more entry in `CELL_SECONDS` turned off. The `PI_POOLS_DISABLED` kill switch is the manual lever
- Draining: a pool that is draining, or whose runners keep failing to start (three in a row, e.g. a 403 or rate limit on the JIT mint), writes `<epoch>:drain`, and is treated as down by both `classify` (no new cells) and the rescue (it moves a cell queued on it after the usual 5 minutes, without waiting for the beat to go stale), because a queued job on a pool that starts nothing would otherwise wait for the whole drain. The writer announces `drain` the moment it is told to stop, retries a failed write after 5 s, writes nothing before its first successful poll, and stops beating when it cannot read the queue. A draining host never kills a runner younger than 90 s, since the API may not list its job yet. Residual: a run already at its third attempt is not rescued, so a cell queued on a pool that then drains waits out the drain (up to the 50 minute job cap)
- `classify` ranks the cells this run executes in full by their measured hosted duration (`CELL_SECONDS`, from the clean `main` run 41914882314) and gives the longest to each pool while it has free slots; the rest stay hosted. A cell is eligible only if it is listed, at least `MIN_HEAVY_S` (240 s) long, and not a bypass or setup-only cell. A self-hosted job pays ~25 s to clone and boot a VM plus a few seconds to register, so shorter cells lose. The table is the single place to widen or narrow routing. Only `owned shard (macos-14, ts)` and `owned shard (ubuntu-24.04, ts)` had passed on a pool before they were listed; the other macOS cells (`python`, `stack local`, `contracts`) were enabled together on request, so watch their first pool runs and drop any that fail. Unset or dead beats reproduce the all-hosted plan byte for byte
- The plan carries the choice: an `owned` shard's `runner` in its matrix entry, and a `contracts` or `stack` cell's top-level `runner`, which `runs-on` reads (`plan[cell].runner || matrix.runner`; a bypass cell stays on `ubuntu-24.04`)
- Kill switch: any non-empty repo variable `PI_POOLS_DISABLED` plans every cell hosted and makes the rescue treat every pool as down. Use it when a pool beats but cannot run jobs
- A fork PR never gets a pool: `classify` passes `--no-pools`. This is not the security boundary (a fork edits its own workflow; fork-PR approval for every outside contributor and the ephemeral, network-isolated runners are), it just keeps honest runs honest. The beat variables are readable by fork workflows, which only shows liveness
- `.github/workflows/runner-rescue.yml` runs every 5 minutes on a hosted runner. A same-repo run with a job queued on a pool label for over 5 minutes while that pool's heartbeat is stale is cancelled and rerun (at most 3 runs per tick, at most 3 attempts per run, rerun retried 3 times, run id logged before the cancel); the rerun's `classify` then plans those cells hosted. Fork runs are never touched. It needs `actions: write` only
- Window: a pool that dies right after `classify` read a live heartbeat strands its job for up to ~10 minutes (the 5 minute queue threshold, in which the 2 minute heartbeat TTL has already elapsed, plus up to one 5 minute cron interval) plus the cancel wait. A pool that beats but never runs jobs is covered only by the kill switch. Concurrent runs read the same free count, so a pool can briefly be oversubscribed; the extra job queues behind the running one
- Not routed, on purpose: `installer.yml` (its own path-gated matrix), `native-helper.yml` (needs a full Xcode toolchain the Mac lacks), `publish.yml` and anything with secrets or OIDC (npm trusted publishing and the attestation checks require hosted runners)
- GitHub disables scheduled workflows in a public repo after 60 days without repository activity; any push re-enables it, but check Actions if this repo goes quiet

## Capacity controls

`classify changed paths` compares the pull request base and head, or the pre-push and pushed `main` revisions, with real Git. It never path-filters a required job: all twelve required jobs start and report a terminal status (an `owned` cell through its fan-in; its shard jobs skip when the plan does not run the cell). A docs-only change skips the native Linux/macOS expensive steps; a WSL cell on a PR is a bypass cell then anyway, and a real WSL cell on `main` still runs. Every skipped job writes a notice plus a step summary. Each job's `plan` step reads its cell from the `classify` plan, emits `run=true` or `run=false`, logs the planned reason when bypassing, and gates every checkout-dependent step on `steps.plan.outputs.run`. `stack` also emits `scenarios`, which is false only for a personal cell on a PR with no stack inputs: setup still runs there, the `Replay`, Node D/E, build, startup, standalone and auth steps do not. `always()` cleanup and artifact steps, plus failure and cancellation conditions, remain in those step predicates. Windows-only steps gate on `runner.os == 'Windows'`, not `matrix.os`, because a WSL bypass cell keeps its matrix values on Ubuntu.

The allowed docs-only paths are Markdown under `docs/`, root Markdown, `PLAN.md`, and a package-root `README.md` or `CHANGELOG.md`. The classifier is deliberately narrower than "all Markdown": workflow files, manifests, lockfiles, Gitlinks, `integration/**`, `scripts/**`, and `releases/*.json` are code because they do not match an allowed path. It also treats root `README.md` and `packages/preset/README.md` as code because repository tests read their text. A mixed change is code.

The 2026-10-20 capacity measurement found median final-head PR latency of 11m45s, p95 queue waits of 22m37s on macOS and 19m56s on Ubuntu, and four macOS jobs in each full run against five hosted macOS slots. A docs-only `PLAN.md` PR alone consumed 100.25 runner-minutes across 18 stack executions. Bypassing that work reduces real contention without leaving a protected check pending.

`main` still validates the merged result: all `owned` and `contracts` OS cells including real WSL, and `stack (ubuntu-24.04, personal)`, which `harness.promotion` needs for its `stack-ubuntu-24.04-personal` artifact. `stack (ubuntu-24.04, local)` and `stack (macos-14, local)` report the selective smoke. The same measurement found six explicit update-branch CI runs plus one Forks run used 180.07 assigned runner-minutes; full main-push workflows used 599.13 assigned runner-minutes, including 334.02 macOS minutes. Those are upper bounds, not promised savings.

PR runs cancel each other per ref. `main` runs do not: `cancel-in-progress` is PR-only and the concurrency group is per SHA on push, because GitHub drops an older pending run in a shared group even without cancellation. A push cannot kill the run proving the previous merge.

Selective main-push smoke is not release evidence. Combined-result release safety comes from the explicit full frozen-candidate dispatch, not repeated update-branch matrices, and unrelated main advancement does not invalidate an unchanged reviewed PR HEAD ([release verification](release-verification.md)).

The required checks live in ruleset `main required checks` (id `25524267`, not classic branch protection), with `strict_required_status_checks_policy: false`. It is not strict: advancing `main` does not invalidate a PR's previous green result, so the merged tree can differ from the tree CI saw. The `main` push run is what validates it.

WSL2 is `matrix.os: wsl2` in the `contracts` job and the `owned-shards-wsl2` and `owned-wsl2` jobs in `.github/workflows/ci.yml`; `stack` keeps the name only for its bypass cells. `matrix.runner: windows-2025` selects the host; `matrix.guest: wsl2` selects the explicit PowerShell -> WSL shell boundary, with Ubuntu-24.04 verified as version 2 and a non-`drvfs` guest checkout. Never a fictitious GitHub runner label or native Windows execution. There is no separate WSL workflow or duplicated WSL test job.

WSL runs the owned gates that produce LCOV and all packed contracts through the ordinary shared steps. Mac-only Seatbelt, desktop/TCC, live credentials and ARM64 runtime remain NOT RUN. Linux helper checks and ARM64 compile-only checks now run inside the owned WSL guest, not on its Windows host.

Shared setup lives in `.github/actions/setup-ci-tools`, with WSL-specific host setup in `setup-ci-wsl` and tool bootstrap in `scripts/wsl2_setup.sh`. Node, npm, Bun and Python read `.node-version`, `packageManager`, `.bun-version` and `.python-version`; uv stays at the existing CI pin. The pinned, checksum-verified `scripts/install_gh_linux.sh` supplies attestation-capable gh. Only owned cells need Rust/nextest. The contract graph is `Makefile` -> `stock_package_contract.py` / `npm_release.run_stock_contract` -> `package_contracts.run_gate`: npm pack/install use `--ignore-scripts`, computer-use audits its Rust source and Mach-O assets without running `postinstall`, and the resource-sampler build is `tsc`. No contract builds Rust; helper compilation remains owned coverage, not a skipped contract. Native cells restore an explicit `actions/cache` of `npm config get cache`, key `npm-ci-<os>-<arch>-<hashFiles('package-lock.json')>`, restore-keys `npm-ci-<os>-<arch>-`, saved only when the job succeeds. A lockfile-changing run restores the previous entry, so only the tarballs it changed are fetched live (a core pin bump fetches its new core tarballs once per cell until an entry under the new key exists); each new entry carries forward every tarball of the one it restored, so it grows with each lockfile change; renaming the `npm-ci-` prefix resets it. Setup-node's own npm cache is off (`package-manager-cache: false`) in every job that runs no `npm ci`, because `installer.yml` and `promote-stack.yml` saved an empty cache under setup-node's shared `node-cache-*` key and every hosted macOS cell restored it (#531). The `owned` fan-in passes `npm-cache: 'false'` for the same reason; `test_every_npm_ci_job_restores_the_npm_cache_and_no_other_job_saves_one` pins both. `forks.yml` `core` keys setup-node's cache on `forks/pi/package-lock.json`, the lockfile its `npm ci` installs, and `test_setup_node_caches_only_the_lockfile_its_job_installs` fails any setup-node cache keyed on a lockfile its job does not install. Self-hosted pool VMs use the same Actions cache service. WSL uses its guest HOME tool cache, never Windows Node/Bun/cache paths, so its `npm ci` still fetches live with only the `.npmrc` retries (155s). Frozen model-data tarballs, strict locks and release verification remain in the shared gate steps. Bun follows the repository's pinned `1.4.4` from merged #197 through `.bun-version`; #162 must preserve its future coverage producer/upload steps through this guest boundary when integrated.

A WSL-only pre-plan step selects `$ProgramFiles/Git/bin/bash.exe`, asserts the first ordered `Get-Command bash.exe -All` application resolves there, prepends that directory through `GITHUB_PATH`, and records the executable and `--version` in hosted logs/summary. The custom shell starts `bash scripts/wsl2_host.sh`, rechecks the resolved Windows source against that receipt (also accepting Git's own `usr/bin` binary), and delegates to `scripts/wsl2_shell.ps1`. Native defaults explicitly retain the prior implicit `bash -e {0}` behavior, without adding `pipefail`. GitHub must see a Bash shell so it does not inject PowerShell pre/postamble into the guest script; the initial direct `pwsh` shell failed with `=: command not found` before the first shared command. The Git-Bash launcher sets `MSYS2_ENV_CONV_EXCL=PI_BIN` before starting native PowerShell: the 45689e3 stack jobs otherwise rewrote `/root/.../pi` into `C:/Program Files/Git/root/.../pi`. Ordinary Windows PATH conversion remains enabled. The PowerShell adapter forwards an explicit `WSLENV` allowlist. Every host-to-guest call uses `wsl --exec` with a translated script-file argument, never a nested `-c` command string. This avoids the initial hosted attempt's lost variable expansion (`/scripts/wsl2_setup.sh` instead of the checkout path). GitHub control-file paths translate to mounted paths, while `RUNNER_TEMP`, builds and execution stay in the Linux filesystem. `GITHUB_ENV` carries Linux `PI_BIN` values unchanged between steps. Only the existing verification/fetch steps receive `GH_TOKEN`; guest bootstrap and scenarios do not. `make install-owned` scrubs the token from npm/uv children. The separate stack install step retains its native commands and receives no token in the first place; only the adjacent verify/fetch steps declare one. The token is never dumped or written by these scripts. The existing same-repo workflow trust assumption applies; this is not a sandbox against arbitrary PR code.

Run `40824209455` exposed a root-user error, not DrvFs: owned tests ran from `/root/pi-harness-ci`, so uid 0 bypassed chmod-based EACCES checks. Setup now creates `pi-ci`; bootstrap, ordinary gates and capture explicitly select that unprivileged user, keeping the checkout under its Linux home. Setup and execution reject uid 0 before copying or running gates; identities record uid and filesystem. Permission tests remain unchanged. The first unprivileged bootstrap attempt (`40852212874`) failed before creating the user because WSL's direct-exec PATH omitted `/usr/sbin`; user creation now invokes `/usr/sbin/useradd` explicitly. Run `40854016032` then reached passing WSL Node scenarios but exposed DrvFs export metadata failures (`cp: preserving times ... Operation not permitted`). Guest-to-host artifact and cleanup copies now use recursive no-dereference copying without archive-mode metadata preservation; guest builds/tests remain on Linux and retain their permission semantics. The same run's owned setup stopped inside install-action's system-prerequisite installation group (missing `jq`); `setup-wsl` now installs `jq` with the root-owned apt prerequisites before dropping privileges. Rust/nextest installation remains unprivileged, without granting sudo access. The native owned failures were a stale contract requiring `always()` on the scanned startup failure-only upload. That upload retains its `!cancelled()`, failure and `artifact_ready` predicates; ordinary reports still require `always()`.

The guest boundary forwards `GITHUB_EVENT_PATH/p` alongside `GITHUB_EVENT_NAME`, so computer-use's
commit gate reads the translated original PR/push payload rather than falling back to local history.
A host-allowlist/real-guest-adapter regression runs the actual commit gate over a disposable PR range;
removing the payload entry fails closed with the same missing-event error as hosted WSL.

WSL guest setup is bounded ([#626](https://github.com/nredd/pi-harness/issues/626)). Two `contracts (wsl2)` runs (`42334800707`, `42340060626`) sat in `setup-ci-tools` until the 45 minute job timeout; Both jobs' logs return `BlobNotFound` (jobs `128289225171`, `128305567830`), so the stuck command was never recorded and the cause is NOT established. Hosted passes (jobs `128303900064`, `128303935178`, `128317800908`, `128303901059`, `128317836113`) took 73-80s in `Vampire/setup-wsl`, under 1s per host `wsl` command (12s covers the first four plus the checkout copy and Node start), and 22s to 67s in `scripts/wsl2_setup.sh` (owned shards add Rust and nextest, about 15s). Every command now has a deadline a few times that, so a hang fails in minutes with a log:

- `scripts/wsl2_bounded.ps1` `Invoke-Bounded` wraps each host `wsl` call in `setup-ci-wsl` (30s each, 300s for the `wsl2_setup.sh` run). On a trip it kills the process tree, prints `::error` with the label and command, the output so far, and host and guest process snapshots, and exits 124
- `scripts/wsl2_setup.sh` `bounded` wraps each guest command in coreutils `timeout` (60s each, 120s for the owned tools, 180s per download with curl `--connect-timeout 15 --max-time 45`) and prints the label, command and `ps` on a trip. `curl | sh` installers are now download-then-run so each half is bounded
- The `Vampire/setup-wsl` step is third-party and composite steps take no `timeout-minutes`, so `scripts/wsl2_watchdog.ps1` is started detached before it (300s). At the deadline it prints the same snapshots, runs `wsl --shutdown` and kills `wsl.exe`, `wslhost.exe` and the action's `node.exe`; `Stop WSL setup watchdog and report` (`if: always()`) then prints its log and fails the step. Its files land in `wsl2-diagnostics`

The PowerShell helpers are pinned by text tests only (no `pwsh` in the script gate); the hosted `contracts (wsl2)` and `owned (wsl2)` cells are their real check. Add the hang's signature to the flake list only once a bounded failure names it; reruns are not a policy.

A real WSL cell retains no docs-only or main-push bypass. Unavailable WSL, wrong distribution version/filesystem, bootstrap or gate failure fails the cell. Before ordinary artifact uploads, `capture-ci-wsl` exports only explicit synthetic artifact directories and contract JSON reports to the host. `scripts/wsl2_capture.sh` still handles the former stack artifact directories; no CI job feeds them now. Native standalone artifacts are `standalone-<platform>-<stack>`, one per running stack cell, each holding only its own stack's reports. Native Node reports have the preceding `stack-*` upload. The startup diagnostic upload stays `standalone-startup-linux-x64`, personal cell only. The promotion consumer still reads `stack-ubuntu-24.04-personal` (`harness.promotion.PERSONAL_STACK_ARTIFACT`), unchanged; it does not consume standalone uploads. Final cleanup preserves the first guest-step failure status and bounded diagnostics. After a failed guest step, or when the caller's `job.status` (input `job-status`, forwarded as `WSL_JOB_STATUS`) is not `success`, final cleanup also writes `wsl2-diagnostics/guest-state.txt` for whole-guest stalls ([#445](https://github.com/nredd/pi-harness/issues/445)): `/proc` uptime, load, `meminfo`, swaps, PSI pressure, selected `/proc/vmstat` swap/reclaim/OOM counters, and the last 400 lines of unprivileged `dmesg`, else an explicit UNAVAILABLE line. No sudo: `pi-ci` gets no extra privilege for this, so `kernel.dmesg_restrict`, recorded in the report, decides whether the kernel log is readable. `python -m harness.credentials` scans the report first; a refusal or a scanner that cannot run exports only a withheld notice. Collection never changes the capture status, and green runs collect nothing. The job status covers a job timeout or cancel, which kills the guest step before `wsl2_run.sh` records `first-failure`. The `always()` capture steps do run after a cancel (e.g. run 41891045788, `owned shard (wsl2, ts)`: gate `cancelled`, both captures `success`). A `timeout-minutes` expiry is the same cancellation; it was observed on `contracts (wsl2)` in #626, where it also dropped the job log, and a guest that is still stalled can stall the capture too. Early host diagnostics survive setup failures. No arbitrary worktree files, command logs, environment or HOME are uploaded.

Owned guest tools reuse the exact native `taiki-e/install-action` SHA from `setup-ci-tools/action.yml`: `install_wsl_owned_tools.sh` runs its documented `main.sh`/`INPUT_*` interface with Linux/X64 metadata, checksum verification and `fallback: none`. Its manifest pins nextest to the same action-selected version as Ubuntu; no unversioned source compilation remains. Guest Rust follows the action's documented floating stable policy with rustfmt/clippy components; native Rust comes from the runner image, so each logs actual `rustc`, `cargo`, and `cargo nextest` identities rather than claiming identical compiler versions. References: [here](https://github.com/taiki-e/install-action/tree/8cca0918f8471c33515202b73f56ab27f2bed283#security-on-installation-from-github-releases).

Run `40747213391` at `0d2bfb0` rejected every WSL cell in the pre-plan assertion: PowerShell returns an application collection, so comparing all `.Source` values to one expected path also compared later legacy candidates. A local real PowerShell 7.6.9 duplicate-application repro confirms that false rejection. Selection now takes only the first ordered application, logs actual/expected paths, and still rejects a legacy first candidate. This is not hosted acceptance; the previous run did not reach guest setup.

Run `40742019252` at `45689e3` reached release installation in both WSL stack jobs, but their `PI_BIN` conversion caused failures before D/E could pass. Contracts failed earlier with HTTP403 in `setup-wsl`'s `wsl --update`. The action runs that only for `ImageOS == win22`, so `windows-2025` takes it out of the path entirely. `update` is independent: it only controls the apt `upgrade`, and `update: 'false'` drops that cost, while `additional-packages` still runs `apt-get update` first.

Reproduce guest execution on a Windows machine with WSL2 Ubuntu-24.04 using the same setup action and `scripts/wsl2_shell.ps1 <step-script>`; run the ordinary Make targets and pytest entrypoints above. A local macOS shell test proves adapter behavior, not WSL execution. Acceptance of a WSL change requires the exact-HEAD hosted `owned (wsl2)` and `contracts (wsl2)` cells and their normal artifacts, plus the native cells; local tests are not a hosted receipt. CI triggers on every pull request and main push, plus explicit full-verification manual dispatch, without path filters. Permissions stay contents-read; the concurrency group is per ref on PRs and per SHA otherwise, so unrelated main pushes cannot cancel a full dispatch. The dispatch skips every docs, WSL-input and stack-input shortcut and calls the reusable fork workflow.
REA is retired, not pending WSL acceptance.

`.github/workflows/installer.yml`, PRs and `main` pushes that change the installer or the harness modules it reuses, plus manual dispatch with a `stack_sha`:

| Job | Runs | Proves |
| --- | --- | --- |
| `installer (ubuntu-24.04, xcode-27)` | `make -C integration installer` with `INSTALLER_SPEC` set to this exact commit (`git+https://...@<sha>#subdirectory=integration`) and `STACK_SHA` the published promotion. The installer reads no token. On `main` pushes/dispatches and owner-reviewed same-repo pull requests (`head.repo.full_name == github.repository`), `GH_TOKEN` is set for the fallback when hosted runner IPs hit GitHub's anonymous 60 requests/hour limit. Job permissions are only `contents: read` and `attestations: read` (needed to fetch attestations); no write permissions are granted. Only the separate `Authenticate gh attestation fallback` step sees `GH_TOKEN`: it pipes the token to `gh auth login --with-token --insecure-storage` with `GH_TOKEN` unset in that child and a temporary `GH_CONFIG_DIR`. `--insecure-storage` deliberately confines the ephemeral login to that private plaintext config rather than an OS keychain, so removing the directory removes the login. `make` and pytest receive only the nonsecret directory path (`INSTALLER_GH_CONFIG_DIR`), not a token. Acceptance wraps `gh` alone to set `GH_CONFIG_DIR` to that path; `uvx`, Git, package builds and other installer children receive neither variable nor token. An always-running cleanup removes the login directory. Fork PRs and non-main dispatches stay anonymous and fail if the limit refuses them (`test_installer_workflow_token_policy` pins and evaluates the expression; `test_installer_workflow_token_permissions_are_read_only` pins permissions and checkout credential stripping). Triggers cover the installer's `harness` import closure, `conftest.py`, `.node-version`, `Makefile`, `pyproject.toml` and `uv.lock` (checked by `test_installer_workflow_covers_its_inputs`). | The documented one-shot `uvx` command in throwaway HOMEs: missing prerequisites, an unpromoted SHA, real `gh` rejecting tampered bytes and a foreign signer/ref, a fresh install equal to the snapshot (order, filters, disabled computer-use, owned npm integrity), a no-op rerun, consent and preservation with an existing setup, and a SIGKILL during staging then a clean rerun. See [install](install.md). |

TRUST assumption: same-repo PR branches are owner-reviewed code. Same-repo `pull_request` workflows are not fork-sandboxed: a branch author can edit the PR's workflow to request write permissions or reference secrets. The read-only block constrains this submitted workflow only; it is not a security boundary against arbitrary same-repo PR code. KNOWN RESIDUAL: same-UID package code inherits the PATH-prepended `gh` shim through `uvx`, the installer, `pi install`, npm/package scripts and Git children that preserve PATH. `make`/pytest also receive `INSTALLER_GH_CONFIG_DIR`; stripping it and the token variables from other child environments does not remove the capability. A child can invoke the shim to authenticate or read its embedded config path and plaintext `hosts.yml`. This is known credential-capability leakage, not merely a theoretical filesystem permission concern. It remains within the same-repo trust assumption: the submitted job token is read-only, but branch authors already control their workflow. No claim of package-script credential isolation is made. The sentinel subprocess test `test_acceptance_token_environment_is_clean_but_gh_capability_remains` demonstrates both clean environments and successful same-UID credential retrieval using the real CLI and a real-format `hosts.yml`.

It is not a required check and has no docs-only bypass; it only starts when its paths change.

`.github/workflows/forks.yml`, when the remaining `forks/pi` Gitlink, `.gitmodules` or the workflow changes, plus manual dispatch:

| Job | Runs |
| --- | --- |
| `core (forks/pi)` | `npm ci`, the release's model data restored from npm `@earendil-works/pi-ai@<version>` (never the live fetch), `npm run build:offline`, the steps of the fork's `check` with Biome check-only (the step fails if the fork's `check` list changes), the env daemon, `./test.sh` |

`ci.yml` full dispatches call it as `release-core` with no inputs, inheriting CI's context. Dispatches group per SHA and never cancel, so a second dispatch on `main` cannot kill an earlier frozen candidate's core gate; PR and push runs still cancel per ref (`test_dispatched_core_gates_never_cancel_each_other`, `test_forks_callee_contract`).

`integration/inprocess/`, the private `A-stack` workspace, runs in `check-ts` on Vitest and Bun:

- `make install-owned` first runs `make verify-root-overrides` (see [releases](releases.md)); `owned`, `contracts`, `stack` (a dedicated step before `npm ci`, plus the core fetch) and `publish.yml` verify pass the read-only job token as `GH_TOKEN` to those steps only, for non-legacy core tags. Hosted Linux and macOS runners ship a `gh` with `attestation`. A transient release-asset download failure (HTTP 502/503/504/429, connection reset, socket timeout) is retried up to 8 attempts with logged backoff (5s, 10s, 20s, then 30s, at most 155s per request); a 404/401/403, other status or checksum/size/redirect refusal fails the job on the first attempt. A `gh attestation verify` that fails with exactly `public good verifier is not available (initialization may have failed)` (the Sigstore public-good trust-root fetch) is retried up to 3 attempts with logged backoff; every other provenance failure, including other Sigstore init errors, fails the job on the first attempt. The `npm ci` that follows reads the root `.npmrc` (`fetch-retries=7`, the same 155s window) for the same CDN 5xx, and on native cells installs the core tarballs from the restored npm cache when it is warm (see [releases](releases.md)).
- `owned` initializes only `forks/pi` (core) before `make install-owned`. The extensions load from
  `packages/{subagents,plan-mode,todo}`; no package-local `npm ci`, no package-local host copies
- `support.ts`: `startStack({ cwd?, factories, settings?, sessionManager?, useModelRuntimeStream?, withConfiguredAuth?, mode?, ui? })` creates and
  binds core's real harness. `loadFork(name)` imports the imported package's declared entry from `packages/<dir>`; `loadOwned(name)`
  imports the owned plugin's `src/index.ts`. Direct `createXxx()` factories work too
- Before importing a package workspace, resolve `pi-coding-agent`, `pi-tui`, `pi-ai`, `typebox` from both directories
  and compare real paths. A mismatch or unresolvable entry fails with the package's `node_modules/`
  deletion path. Node uses import conditions on `createRequire().resolve`; Bun uses
  `import.meta.resolve` with an explicit parent. No aliases or copied extension code
- Root workspace dependencies supply `croner` `10.0.1`, `nanoid` `5.1.16`, `pi-tui-kit` `0.65.5`
  from the imported packages' historical lockfiles. Root also anchors `nanoid` `5.1.16`: otherwise npm hoists PostCSS's
  `3.x` and leaves the imported subagents package's `5.x` unreachable inside the stack workspace. The `rpiv-todo`
  source lockfile was retired with its Gitlink; the stack workspace pins `rpiv-config` and optional peer
  `rpiv-i18n` to the imported package's `2.13.9` provenance, with the same integrity as that historical lockfile
- The test launcher isolates `HOME` at process spawn on both engines. `isolateStackHome()` keeps
  that home fixed (Bun caches `os.homedir()`), isolating `PI_CODING_AGENT_DIR` and XDG config
  independently per fixture before loading entries.
  `plan-todos.test.ts` drives the real Plan/todo pair, canonical RPC chooser selections, core
  compaction with scripted summaries, file-backed dispose/reopen and legacy mode entries.
  `/todos` heading counts share the evidenced-batch test; no second process
- `goal-support.ts` shares one injected clock across the real kit, router and subagents factories,
  with credential-free usage snapshots and explicitly configured faux auth. Goal/Plan/todo,
  loop/Plan, child accounting, scheduled/busy/idle notices and quota park/refuse/resume tests
  run on the same host. The child runner loads the real kit itself. All assertion destinations
  and native timer boundaries live in the ledger: [here](verification-rebuild.md)

- `stats-plan.test.ts` checks the explicit `viewer last import` label and cycles through
  Overview, Models and Machines while Plan mode remains enabled; the Machines view retains
  viewer-import and local-scan evidence across terminal resizes.
- `memory-deferred-kit.test.ts` loads real npm memory/context-engine factories with session-kit:
  memory write/read and system-message refresh coexist with hidden monitor registration,
  session-lifetime search promotion and successful controlled monitor execution. qmd is a
  failing fixture shim; no network is allowed. The D `test_extension_coverage.py` canaries
  separately prove installed registry/commands, memory persistence/path rejection, workflow
  list/missing-run behavior, a clean refused-loopback raw web fetch error and computer-use's
  installed-but-not-loaded headless exclusion. No version pins are copied into scenarios.
  The per-extension matrix is [here](verification-rebuild.md#shipped-extension-coverage-audit),
  with each layer's actual assertions and GUI/live limitations. The shared third-party loader
  resets pi-memory's own path/snapshot/qmd caches before a new fixture: Bun caches npm modules
  across test files, so import-time state must not retain a deleted prior private home.

The unit gates must not read the machine: the first CI run found three `integration/tests` that only
passed on the owner's laptop (`pi` on `PATH`, the chezmoi source tree). They are gone or isolated.

Verification engines: Vitest stays the owned TypeScript runner, with Node primary (the shipped
runtime) and Bun the standalone target. Full Vitest runs on both engines for
`subscription-router`, `preset`, `resource-sampler`, `todo`, `plan-mode`, `dev-tools` and
`integration/inprocess`.
`test:bun` launches `bun --bun vitest run` through `scripts/run-vitest.ts` in a disposable
spawn-time home (the keys come from its exported `isolatedHomeEnv`, which nested runners such as
session-kit's worker-death test reuse); `make check-ts` and the native `owned` cells' TypeScript shards run it.
The launcher also sets `JITI_FS_CACHE=false`, and pins `CARGO_HOME`/`RUSTUP_HOME` to the account's
(`toolchainHomeEnv`, explicit values win): rustup's proxies otherwise look under the disposable home,
so dev-tools' real cargo suite silently skipped on Bun on the hosted runners. The `test:bun` scripts that start with native
`bun test` (session-kit, subagents) set it for that half through an inline
prefix, not the launcher, as do the direct `vitest` scripts; see `docs/verification-engines.md`. Each
invocation prints engine/OS/package duration and exit status and appends it to the CI step summary.
The launcher's `bun` engine also appends the Bun signal's Istanbul coverage arguments.
The shared guard checks `os.homedir() === HOME` at setup, before each test and after each test,
failing with the offending file and an instruction to inject home directories. These are
boundary checks, not interception of transient mutations between boundaries.

Phase 2 #171 resolves the todo/subagents guard deferral from
[spec PR #170](https://github.com/nredd/pi-harness/pull/170), tracking
[#160](https://github.com/nredd/pi-harness/issues/160). Both Vitest configs now install the
shared guard and fixtures inject their homes instead of mutating `HOME`. Todo runs its full
390-test suite on Bun. Subagents keeps its native-scenario subset plus the guarded real-loader
gate; full Bun activation is a later slice of [#320](https://github.com/nredd/pi-harness/issues/320).
Its full Node suite is guarded.
No guard-related skip list or informational-only guard is used. See the current matrix,
boundary negative controls and package-addition procedure [here](verification-engines.md).
Python stays on pytest/uv/ruff/ty; dotfiles stays on dependency-free `node --test` as the
bootstrap exception. Istanbul consolidation is phase 3, not part of this producer change.

Toolchain: Node from `.node-version`, npm from `packageManager`, Bun from `.bun-version`, uv `0.13.1`
(Python from `.python-version` via uv). Every action is pinned to a commit SHA.

PR freshness and release verification follow [the frozen-candidate policy](release-verification.md).
Do not update-branch solely because main advanced. Keep exact final-HEAD checks and both reviews.
Manual `ci.yml` dispatch runs the complete matrix and core fork gate without docs/smoke shortcuts;
push/main smoke is not release evidence.

Required checks on `main`, twelve contexts:

- `owned (ubuntu-24.04)`, `owned (macos-14)` and `owned (wsl2)`
- `contracts (ubuntu-24.04)`, `contracts (macos-14)` and `contracts (wsl2)`
- `stack (ubuntu-24.04, personal)`, `stack (ubuntu-24.04, local)`, `stack (macos-14, personal)`, `stack (macos-14, local)`, `stack (wsl2, personal)` and `stack (wsl2, local)`

Dropping a cell from a matrix would leave its context pending forever, which is why the cells that no longer test anything stay as bypass cells.

The `macos-14` in these names is a stable check context, not the OS version: GitHub retired that image, so the cells run on `xcode-27` (macOS 27, GitHub names new images after the Xcode major) via `matrix.runner`. Renaming them would need a ruleset change.

The historical nine-context receipt remains in `scripts/tests/fixtures/merge-pr-135.json`, unchanged. Tests explicitly add synthetic replacement matrix records; they are not hosted execution evidence.

The twelve jobs are the configured required checks of ruleset `main required checks` (id `25524267`, `integration_id` 15368 each); `Promote stack` reads them from `GET /repos/nredd/pi-harness/rules/branches/main`, then attests and releases `stack/<sha>` (`docs/stack-promotion.md`). `migration-review/standards` and
`migration-review/spec` are no longer required. Reviews are our process, not a CI gate:

- Run separate Standards + Spec reviews on the exact final HEAD; any HEAD change invalidates both
- `scripts/merge-pr.sh` is the tracked source; `scripts/merge_pr_checks.py` owns its read-only CI
  predicate. Invoke the helper from an exact reviewed checkout. It validates distinct reviewer IDs,
  exact final-report HEAD and axis, unresolved-revision errors, receipt posting and
  `--match-head-commit`. Each reviewer's **final assistant report** must begin with these literal
  lines (use `Axis: Spec` for the other axis), then its normal `Checked:` and `Findings:` sections (`Findings:` alone on its line, then findings or `None.`; the inline `Findings: None.` refuses). `packages/preset/agents/code-reviewer.md` ships this exact skeleton and a test feeds it through `merge-pr.sh`:
  ```text
  Axis: Standards
  Reviewed HEAD: <full-40-character-reviewed-sha>
  ```
  Missing, duplicate or conflicting declarations refuse. A SHA in an earlier request, tool call or
  incidental prose is not a receipt. Git diagnostic detection requires explicit boolean `isError`
  metadata: successful source reads/diffs may quote every failure pattern without invalidating the
  review. An actual failed unresolved-revision result blocks even if a later call succeeds. Missing
  or malformed Git-result status/content and reader errors fail closed. Renew the review rather than
  editing a transcript. The unmanaged
  `~/code/pi-harness-builds/merge-pr.sh` is a distribution copy, not source. Only after this PR is
  reviewed and merged may the parent copy **both** scripts together from the merged revision into
  that directory. Do not activate an unreviewed copy or change managed Pi config
- The helper gates **all** reported checks, including optional fork jobs, not just required contexts.
  It independently verifies every ruleset context against its bound app and reviewed SHA. Missing,
  pending, failed and current cancelled checks refuse. `SKIPPED` remains accepted for non-required
  conditional jobs
- A zero-step completed/cancelled literal CI matrix placeholder (`owned`, `contracts`, `stack`, and
  the non-required `owned shard` jobs)
  is stale only with a later completed/successful execution of the same workflow ID/path, event,
  PR/head/base (including repository identity), Actions app and SHA. All twelve expected expanded
  matrix cells must individually succeed. The latest workflow execution must qualify; an intermediate
  green run cannot hide a later cancellation. Ordering uses `run_number`, then `run_attempt`, never
  timestamps or API page order. Evidence is fully paginated and validated as strict Pydantic records;
  missing, malformed or ambiguous evidence refuses.
  The bounded matrix contract test must change alongside any CI matrix change
- Bootstrap this helper's own PR without replacing the scratch copy: after independent Standards +
  Spec reviews of its final HEAD and existing hosted checks are green, invoke its reviewed tracked
  helper directly from the candidate worktree:
  Install the existing locked integration environment (`uv sync --locked` in `integration/`)
  for Pydantic evidence validation. Select trusted absolute executables and the actual transcript
  storage directory explicitly; there is no PATH-based or workstation-specific fallback.
  The shell uses `/bin/bash` and absolute native `ls`, `wc`, `dirname`, `mktemp` and `cat` paths;
  embedded readers resolve transcript paths with `Path` and require regular files before reading.
  The poisoned-PATH regression covers every external utility, including gate-path selection:

  ```sh
  MERGE_PR_TRANSCRIPT_ROOT=<absolute-transcript-store> \
  MERGE_PR_GH=/opt/homebrew/bin/gh \
  MERGE_PR_PYTHON=$HOME/code/pi-harness-merge-helper/integration/.venv/bin/python \
  bash ~/code/pi-harness-merge-helper/scripts/merge-pr.sh \
    <helper-pr> <full-reviewed-head> <standards-task-id> <spec-task-id> \
    <gate-history-file> nredd/pi-harness
  ```
  This uses real green checks and the same receipt/expected-head enforcement, not a bypass.
  Any actual conflict resolution or other HEAD change invalidates both reviews; unrelated base advancement does not. Refresh the distribution copy
  only after that reviewed merge. This procedure does not authorize merging router PR135,
  publishing packages, or activating live configuration
- `forks.yml` is path-filtered and not a required protection check; when triggered, the remaining core Gitlink job must pass before merging

The session-kit `/mon` mapping test injects a deadline-truncated sampler snapshot instead of assuming
that a bounded host scan always includes the test process. Real-sampler cancellation tests continue to
exercise the published sampler; the host-dependent polling smoke is not in the coverage-gated suite.

The dev-tools real-host `resource_snapshot` smoke requires process metadata and includes the producer's
unavailable reason in its failure. Separate controls exercise registry sampler `0.2.0` through the tool
schema with an injected Linux enumeration failure and a genuinely exhausted scan budget. The injected
Linux path on macOS is not a native Linux run.

`resource_snapshot` also resamples, at most twice more, when either scan of the window reports
`process-collection-unavailable` (#557), sliding the window to the latest pair of scans. Failures that
outlast the two resamples still report the producer's reason (or leave a lost baseline's entries `warming`). This works around
published sampler `0.2.0` without a pin bump; the sampler source fix (#499) still needs its release.

Flake policy (migration plan section 7):

- A new correctness failure blocks
- A documented, isolated flake may get ONE fresh rerun of the whole failed job, only when nothing else
  failed. The rerun must pass. Both attempts stay in the run's attempt history; name the flake in the PR
- Known timing-sensitive suites: session-kit `monitor` and `diff` reaping, dev-tools kill escalation,
  core `chord`/`durable` 5 s timeouts. They were green alone and flaky on a loaded laptop
- dev-tools real-host `resource_snapshot` child sample on Linux (#499): published sampler `0.2.0` drops
  the whole baseline when a process exits mid-`/proc` scan, so the child reads `warming` or
  `process-collection-unavailable`. Fixed in sampler source, flaky until `0.2.1` is pinned
- `npm` SIGABRT on the `pi-macos` pool (#542): the job log's shell line reads
  `<pid> Abort trap: 6  npm ci ...` or `npm install ...`, the step exits 134 with no npm error output,
  the runner is `pi-macos-*` and no other step failed. Cause: macOS LaunchServices aborts in
  `_LSApplicationCheckIn` when npm sets `process.title`. Only that exact match allows ONE fresh rerun
  of the whole job; record each occurrence on #542 (run, job, host crash report name). An abort from any other
  process, any other runner, or with other output is a new correctness failure and blocks. The
  allowance lapses when a macOS update removes the `_LSApplicationCheckIn` abort, or when a different
  signature appears, which blocks
- Subagents' genuine manager-reload fixture also includes synchronous TypeScript preparation and child
  imports inside its 5 s test deadline. PR #138's macOS failure reported that deadline at 5597 ms
  ([here](https://github.com/nredd/pi-harness/actions/runs/40369078357/job/121734701111)). Controlled
  compiler/import delays reproduce the same timeout on the unchanged `origin/main` source while the
  child passes every budget assertion and exits successfully. Vitest checks elapsed time even after
  a synchronous test returns. Compile each source once and write its output to two physical ESM trees;
  the test pins that operation count and retains distinct managers, shared waiters and final zero usage.
  Neither the 5 s test deadline nor the 10 s child watchdog changes. This does not authorize a rerun
- Never rerun until green, never relabel NOT RUN as a pass

Both assembled stacks use `npm:@gotgenes/pi-anthropic-auth@3.4.3`, not the retained auth Gitlink.
`test_auth_transport.py` records direct Anthropic and `router/default` OAuth requests: native bearer
and Pi user agent, exact versioned billing block, section-shaped system prompt retained in `system[]`
and unchanged first user text. API-key and unconfigured custom-provider requests stay unshaped.
Refresh persistence/refusal and the missing-Node-preload fail-closed branch remain covered. No live
subscription is used. Explicit pi-ai compat dispatch and legacy loops without `streamFn` bypass the
provider wrapper; compaction/modelRegistry coverage is upstream-documented, not asserted here.

The `stack` job explicitly selects `integration/scenarios/test_*.py` plus
`integration/scenarios/tui/test_footer_resize.py`, marked `stack`, under xdist `--dist loadfile`.
No unported non-boundary Python scenarios remain. Package-native suites and `integration/inprocess/`
own the ported assertions; the destination ledger is [here](verification-rebuild.md).
The thirteen historical `DOTFILES` rows belong to dotfiles, not a distribution check. Eleven
remain doctor checks; the two REA rows were retired in `nredd/dotfiles#58` and replaced with
absence/cleanup regressions in dotfiles' `tests/rea-retirement.test.mjs`. See
[here](../integration/README.md) for inputs, package sets and deliberate headless exclusions.

Tap and profile pin bumps require green CI on the candidate stack, not local `pi-harness-e2e make verify`.
A correctness failure blocks promotion; the existing one-fresh-whole-job-rerun policy applies unchanged.
`stack` still tests the released Homebrew-shaped Node bundle. Fork release `v1.3.0-nredd.8`
publishes the coding-agent and pi-tui npm tarballs, no standalone assets. Each running `stack` cell also builds the exact
Gitlinked source using `.bun-version` (1.4.4), the official `scripts/build-binaries.sh`, and frozen
release model data with `build:offline`. It does not depend on a future standalone release, commit
binaries, or test a Node wrapper in place of the compiled executable.

Bun scope:

- Native execution on `xcode-27`, macOS 27 (darwin-arm64) and `ubuntu-24.04` (baseline linux-x64).
  Each running cell builds once for its own stack
- `--runtime bun-standalone` skips only the seven marked auth dispatch/refresh cases from
  `integration/scenarios/test_auth_transport.py`: Bun ignores the `NODE_OPTIONS --import` redirect
  and egress/readiness preload in `harness/anthropic_mock.py`. The missing-preload refusal case runs
  on both runtimes. Skip reasons appear in pytest and JUnit before fake auth fixtures can dispatch.
  Separate candidate auth steps pass `--bun-auth-adapter` for each stack on the same compiled core:
  `BUN_OPTIONS --preload` loads the shared redirect before entrypoint startup, while Node retains
  its original hook. These steps retain the actual shaping/refresh/refusal assertions and write
  `standalone-auth-personal.xml` / `standalone-auth-local.xml`. This is an explicit receipt lane,
  not a blanket unskip or a claim that those hosted executions passed. Default skips remain until
  receipts demonstrate compiled-core acceptance. The small native fixture in infrastructure units
  proves hook admission and failures only, not assembled-stack behavior
- No other selected D/E case uses preloads, scaled timers or `--expose-gc`. Clock-driven behavior
  moved to native suites, and the unused `providers/fast_timers.mjs` preload is deleted (#378);
  `harness/probe.py`'s `--expose-gc` is used only by excluded `scenarios/bench/test_render.py`.
  The render probe (`probes/render.ts`) picks its collector per runtime: Node's `--expose-gc` hook,
  else `Bun.gc(true)` (compiled Bun has no such flag and ignores `NODE_OPTIONS`), else `gc: false`.
  `render.test.ts` pins all three; `make check-probes` runs it
- The adapter blocker is [here](https://github.com/nredd/pi-harness/issues/14). Previous references
  to #58 are stale: no such issue exists in this repository. The timer migration removed one
  dependency, not the remaining auth transport interception requirement
- NOT RUN: linux-arm64 (no `ubuntu-24.04-arm` job added), darwin-x64, Windows, packed contracts
  hosted by the standalone, quiet-runner benchmarks, live credentials and desktop/TCC helpers.
  REA is retired, not an outstanding standalone acceptance requirement.
  Source-built D/E coverage is not published-binary acceptance or a completed Bun checklist

Capacity: full PR CI requests four macOS jobs (two `owned` shards, `contracts`, `stack (macos-14, local)`) and three Windows jobs only with WSL inputs (two `owned` shards, `contracts`). Before #350 it requested three macOS jobs, and before that four of each, every run. The `owned` fan-ins are Ubuntu jobs that start after their shards. Ubuntu now builds the standalone twice, once per stack cell, where it used to build once and run both stacks serially. Stack timeouts are 40 minutes. Linux ARM64 is omitted to avoid another build and two stack installs. Bun failures fail their own stack cell.

`.github/workflows/publish.yml`, pushes of tags matching `@nredd/*@*`:

| Job | Runs | Permissions |
| --- | --- | --- |
| `verify (ubuntu-24.04)` | `scripts/npm_release.py` validates package/version, tag commit ancestry on freshly fetched `origin/main`, and npm absence; installs, checks the selected package with pinned Bun, packs once, runs applicable contracts on those exact bytes, generates SHA-256/SHA-512 identity and release manifest, uploads the artifact | `contents: read` |
| `publish (ubuntu-24.04)` | Environment `npm`; downloads and validates the artifact, asserts/prints Node >=22.14.0 and npm >=11.5.1, publishes the verified tarball via trusted publishing; checks npm integrity, runs `npm audit signatures` in a one-package throwaway install, and binds the fetched DSSE provenance to the tarball, workflow, tag and commit. Matching existing bytes skip publication; different bytes fail | `contents: read`, `id-token: write` |
| `release (ubuntu-24.04)` | Creates a verified-tag GitHub release with the original tarball, checksum, identity and manifest attached | `contents: write` |

The jobs have bounded timeouts and per-tag concurrency without cancellation. No npm tokens, no rebuild
in publish, no manual dispatch. External trusted-publisher/environment/tag protections and failed-job
recovery are documented [here](releases.md#owned-npm-packages). Only a real tag-triggered publication
can prove the external OIDC binding, automatic provenance and registry acceptance end to end.

Not in CI yet: bench on a quiet runner, live `G` (deliberately never CI).
