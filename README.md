# Pi harness

Development home for the `@nredd/pi-*` Pi plugins, the Pi core fork, their integration tests and
the exact-stack release tooling.

Documentation lives in this file, each package's `README.md` and git history. `docs/` holds only
the long references a test or release procedure reads: [coverage](docs/coverage.md) (720 lines,
policy pins and hosted replay), [install](docs/install.md) (254 lines, including the tested recovery
table) and [releases](docs/releases.md) (336 lines, publication and recovery procedures), plus
`docs/agents/issue-tracker.md` for the `code-review` skill. These exceed the roughly 100-line folding
threshold and stay separate. Shorter documentation goes in a README; CI policy lives in comments
next to its workflow or action. Do not add plans, coverage write-ups or investigation notes;
put the why in the commit.

## Layout

- `packages/`: independently versioned npm workspaces. Versions live in each `package.json`
  - `computer-use`, `plan-mode`, `subagents`, `todo`: forks, upstream noted in each README
  - `dev-tools`, `session-kit`, `subscription-router`, `preset`: own extensions and the optional preset
  - `resource-sampler`: Pi-independent ESM library used by session-kit
- `forks/pi`: the only Gitlink, the `nredd/pi` core fork
- `tests/lib/`: private `@nredd/pi-test-lib` workspace, the one copy of shared test helpers: `FakeClock`, `deferred`, faux tool-call turns (`toolCall`, `settled`, `outcomes`, `nextEvent`), terminal constants, the disposable git fixture, temp/agent-dir/config-home sandboxes, the HOME guard, the recording `ExtensionAPI` / context doubles for tests that load an extension factory directly (`createRecordingPi`, `createRecordingContext`; typed against the public SDK types, so they compile on stock releases too) and the non-interactive in-process session harness (`createHarness`, `createTestUiContext`, `createTestExtensionsResult`; public `@earendil-works/pi-coding-agent` root export only, so it typechecks and runs on the fork and on stock releases; the interactive harness stays on the fork's `/testing/interactive`, which needs fork-only `InteractiveModeOptions.{keybindings,footerDataProvider,prepareTools,onInput,onEditorSubmit}`, `InteractiveMode.flushRender()` -> `TUI.flushRender()`, the `FooterDataProvider` and `KeybindingsManager` classes (stock exports only types) and `@earendil-works/pi-tui/testing` `VirtualTerminal`). It imports nothing under `packages/` and is measured at 0/0/0/0 by its own tests (`test-lib` in `coverage/policy.json`). Packages take it as an exact-pinned devDependency; package-specific fixtures stay in the package under its `fixtures/` directory (today `test/fixtures/`; the `test/` -> `tests/` rename is left to the package issues)
- `release/`: independent measured uv project, `pi_release/` product implementation and the
  `pi-stack-install` entry point; `release/stacks/personal.json` is the maintained package selection
- `tests/inprocess/`: the complete former `integration/inprocess/` npm workspace, unchanged internal
  layout and Node/Bun invocation, real extension factories on core's session harness
- `tests/integration/`: the remaining former `integration/` Python harness, scenarios, probes,
  providers, goldens, historical baselines and all retained unit tests. See [here](tests/integration/README.md)
- `scripts/`: CI classification, coverage accounting, package contracts and release tooling
  - `coverage_provenance_record.py`: shared sidecar schema, producer job keys and strict JSON decoding.
  - `coverage_report.py`: local-only Markdown/SVG renderer for trusted plans and downloaded evidence.
    Malformed artifacts (including corrupt LZMA streams) degrade only their host; filesystem failures
    expose only error types and basenames. File totals validate in one pass. Explicit partial-row
    warnings remain essential state under the 60,000-character cap. No publishing.
    For `coverage-<os>`, the renderer requires `coverage/provenance.json` beside `coverage/summary.json`
    in the same ZIP or unpacked directory. The producer records run ID, attempt, job key, matrix cell
    (the declared artifact name), checkout SHA read directly from Git, PR head SHA (null outside PRs),
    event and workflow ref using `coverage_provenance_record.py`. The producer CLI
    (`coverage_provenance.py`) no longer takes `--tested-sha`: it deletes a stale sidecar first,
    reads the checkout SHA from Git stdout, and refuses unknown job keys. Non-PR reports show
    `head: n/a` separately from the tested SHA. Swift
    and native Windows keep their independent diagnostic uploads without a presentation sidecar.
    The fan-in stamps the summary only when all downloaded shards match its run,
    attempt and checkout; a partial rerun that reuses older shards can retain reports without a stamp.
    Missing, malformed or mismatched records render `unavailable`, never zero. Accounting and floors
    are unchanged. The local renderer takes trusted `--repository`, `--tested-sha`, `--run-id`, `--attempt`,
    `--event-name`, `--workflow-ref` and (on PRs only) `--head-sha`; measured-main comparison also
    requires `--baseline-identity SHA RUN ATTEMPT EVENT WORKFLOW_REF` independently of the PR inputs.
    Renderer plans accept `ubuntu-24.04` and `macos-14` only. Fan-in evidence is Ubuntu-only on PRs;
    macOS is eligible on pushes and dispatches. Matching a record is not authentication; the caller
    must authenticate the run and artifacts.
- `coverage/policy.json`: enforced coverage policy
- `releases/`: generated release manifests

## Development

Node `26.12.0` (`.node-version`), npm `11.20.0` (`packageManager`), Python `3.13.15`
(`.python-version`) under `uv`, Bun `1.4.4` (`.bun-version`), Git, `tmux`, macOS or Linux.

```sh
make install                 # install-owned (verify core overrides, npm ci --ignore-scripts, uv sync --locked)
make check                   # owned-code gate: check-commits check-ts check-scripts check-integration
make check-package-contracts # packed tarballs through exact stock Pi; not part of `make check`
make help                    # every target
```

- `make check` never rewrites files and never modifies `forks/`
- `PI_TIMEOUT_SCALE` scales the 300s package-contract npm and native lint subprocess deadlines. It defaults
  to `1`, requires a finite number `>= 1`, and caps values at `10`; e.g. `PI_TIMEOUT_SCALE=3` gives 900s.
- `check-integration` needs the `forks/pi` Gitlink initialized
- `check-changelog-fragments` and explicit `fold-changelog` use the managed `tests/integration` uv project;
  folding edits source fragments only, never publishes or releases. Edits to enrolled packages'
  `CHANGELOG.md` files run the scripts gate, including fragment validation, rather than bypassing CI as docs-only
- `check-commits` validates repository commit subjects independently of workspace selection; set `COMMIT_RANGE=<base>..<head>` locally. CI runs it before path classification on every PR and push
- `check-ts` takes `WORKSPACES=<paths>` and always checks literal `mkdtemp` and `mkdtempSync`
  references in owned JS/TS test sources only. Python and the `forks/pi` Gitlink are not scanned.
  The regex counts comments and strings as well as code (including aliased imports), but misses
  computed spellings assembled from fragments. Use `makeTestTempDir(prefix, onTestFinished)` from
  `@nredd/pi-test-lib/temp-dir` for scratch paths that should live until a test finishes.
  It defaults to OS temp. For fixtures that must live under an existing directory, pass
  `makeTestTempDir(prefix, onTestFinished, { baseDir })` with a prefix relative to `baseDir`.
  Plan Mode build fixtures use the real package root only for its builder output path checks or
  workspace module resolution. Standalone validation and self-contained builders use OS temp.
  A killed run can leave in-package fixtures behind: they are outside the launcher's temp sandbox.
  `scripts/test-tempdirs-baseline.json` may only shrink against the merge base of `HEAD` and `BASE`
  (unset or empty means `origin/main`), like the package layout allowlist. A missing baseline at
  the merge base is allowed for its initial introduction only.
- Scripts that use `node ../../scripts/run-vitest.ts` give Vitest and its subprocesses a private
  `TMPDIR`, `TMP` and `TEMP`. The launcher removes the sandbox after the child exits, even on test
  failure. Direct Vitest and Bun invocations bypass this cleanup. `SIGINT` or `SIGTERM` delivered
  to the launcher itself can leave the sandbox behind.
- `install-owned` also runs `install-lint-tools`: checksum-pinned ShellCheck `0.11.0`, actionlint
  `1.7.12`, PowerShell LTS `7.4.22` and PSScriptAnalyzer `1.24.0` unpack into the gitignored
  `.native-lint/` prefix, never global tools or the live home. The manifest supports macOS x64/arm64
  and Linux x64/arm64 (including the WSL guest). Downloads fail closed on checksum errors; native
  version checks reject stale tools. `make install-lint-tools` rebuilds the isolated prefix.
- `check-scripts` first runs `check-native-lint`. It requires the installed prefix, runs ShellCheck on
  tracked `.sh`/`.bash` files, actionlint with ShellCheck on workflows, and PSScriptAnalyzer plus the
  PowerShell parser on tracked PowerShell and extracted composite/workflow `pwsh` blocks, including
  job/workflow shell defaults and implicit Windows PowerShell. Step overrides take precedence. Tools
  run with disposable home/cache directories. Composite Bash blocks also run through ShellCheck. Expressions in extracted blocks become inert synthetic
  text, not executed commands. Expression-valued workflow shells receive separate ShellCheck runs when
  every literal result alternative (including `format` templates) starts with a fixed Bash executable.
  Selectors are inspected without evaluation; unknown or mixed-shell alternatives refuse with the
  workflow file, job and step, rather than relying on actionlint's expression-shell bypass. Analyzer Error/Warning diagnostics block, except `PSAvoidUsingWriteHost`
  (CI diagnostics must not pollute function success output) and `PSUseShouldProcessForStateChangingFunctions`
  (noninteractive disposable fixture constructors). Only the actual custom runner labels are declared.
  Native malformed-source, missing-tool, version and checksum controls run in the Python suite.
  This is static analysis, NOT execution or coverage. The existing inert workflow-data inventory and
  per-file shell/PowerShell coverage decisions under #695 remain unchanged. No kcov/Pester policy is added.
- `check-scripts` enforces package layout with a shrinking allowlist. Retired sync markers are denied in
  script commands and code even under renamed entry points; repeated occurrences of an allowlisted
  import escape cannot grow versus the merge base. Shared `tests/inprocess` and `tests/lib` also
  reject tracked binaries and standalone shell scripts. Growth detection includes staged renames in
  the index, so a move within the same banned entry is not a new file.
- Shared toolchain: one root `biome.json` (tabs, width 120, `recommended` plus eight `error` rules; JSON
  config files use two spaces), one `tsconfig.base.json` that every package `tsconfig.json` extends, and one
  set of pins (`@biomejs/biome`, `typescript`, `@types/node`, `vitest`, the coverage providers, `esbuild`) in the
  root `package.json`. Packages never pin them. A package that cannot meet a flag yet overrides it in its own
  `tsconfig.json` with a comment naming the issue; `subagents` and `todo` keep their own
  `biome.json` until their layout issues land (`computer-use` has none yet). In `dev-tools`, `preset`, `resource-sampler`,
  `session-kit`, `subscription-router` and `plan-mode`, `npm run lint` is `biome check .` and `npm run format` is `biome check --write .`
- `dist/` is gitignored build output (#866): `npm run build` or `make install-owned` regenerates it, `npm run check` builds first, and
  `package_contracts.pack` removes and rebuilds it in place before `npm pack --ignore-scripts`, so do not run contract packing
  concurrently with builds or readers of the same checkout. A missing `dist/index.ts` fails the `required` audit
- Vitest 5.0.3 applies `VITEST_MAX_WORKERS` over `maxWorkers` and `fileParallelism: false` alike (the heavy-slot wrapper
  exports it). `definePackageConfig` therefore sets `fileParallelism: false` and drops the variable for packages with
  `maxWorkers: 1` (`computer-use`, `resource-sampler`, `subagents` runtime-build), pinned in `scripts/coverage-configs.test.ts` (#934).
  CI never sets `VITEST_MAX_WORKERS`; locally the `heavy` wrapper sets 2, so these packages now run serially and `computer-use` takes about twice as long locally; CI timings are unchanged.
  A suite that shares state beyond serial files (HOME, ports, global tools) isolates it per file; it does not lean on serialization
- Packages build and test against the core fork's release tarballs pinned in root `overrides`.
  Stock Pi compatibility is `make check-package-contracts`' job.
  `scripts/package_contracts.py` is the sole tarball-membership authority: every package has exact
  `packed_files` (and counted patterns for hashed chunks). `make check-scripts` runs its
  `--packed-files-only` path without stock Pi, including production-source completeness and test/fixture
  exclusion. Compiled libraries require their matching JavaScript and declaration outputs instead of
  raw sources. Computer-use, preset and todo also begin their own `npm run check` with
  `--packed-files-only --package <workspace-directory>` using the shared uv environment. This catches
  missing assets and newly added, unpacked production modules before their language/test gates.
  Before building, the packer uses `npm pack --dry-run --ignore-scripts` to reject existing
  `packed_files` omitted from the payload, so a missing native source does not wait for compilation.
  Absent generated outputs remain the real post-build tarball audit's responsibility; the preflight
  proves no successful payload on its own.
  Add moved shipped paths there, not in package-local tarball tests
- Keep package-local `node_modules/` host copies absent: the in-process stack loader refuses a
  second host copy
- On macOS run long gates under `/usr/bin/caffeinate -is`. Do not relax real-time deadlines
- Never run an unguarded `npm audit fix`: test-host pins are deliberate

## CI and release

- What runs, what is NOT RUN, sharding, coverage and stack diagnostics: comments in [CI](.github/workflows/ci.yml).
  macOS runs `check-scripts` in its own shard, separate from `check-integration`,
  within the unchanged 30-minute budgets. Both full release/harness coverage passes and all Node/Bun
  producers remain mandatory; the required `owned` check fans in their independent artifacts.
  The admitted `probes/bun` and `import-audit/bun` signals keep their independent zero-miss
  enforcement at `tests/integration/probes/coverage/bun` and `scripts/coverage/bun`.
  Windows build-routing failures retain bounded child output tails and exit/deadline provenance;
  the native build deadline is still 120 seconds, not a claim that a cold-build cause is proven.
- CI expands only Ubuntu cells on PRs; macOS runs on `main` and full dispatches, including frozen release verification. See `macOS PR skip` in the PR CI summary. WSL2 is not a CI target.
- Shared tool and cache setup: [setup-ci-tools](.github/actions/setup-ci-tools/action.yml).
- Other workflow policy: [installer](.github/workflows/installer.yml), [core forks](.github/workflows/forks.yml),
  [publishing](.github/workflows/publish.yml), [runner rescue](.github/workflows/runner-rescue.yml). Review policy stays [here](#review-and-merge-evidence); flakes follow the comments in `ci.yml`
- [Publish coverage](.github/workflows/coverage-publish.yml) updates one comment per PR, including forks. It checks the Ubuntu artifact's sidecar for run and SHA consistency, not whether the PR-reported numbers are correct. Missing or mismatched provenance is `unavailable`; macOS is not run on PRs and WSL2 is no longer scheduled. Required checks, not the comment, gate merges.
- Owned packages publish through `publish.yml` from a signed tag; core ships through
  `nredd/tap/pi-coding-agent`. Procedure: [releases](docs/releases.md)
- `promote-stack.yml` attests a gated `main` commit as `stack/<sha>`:
  [stack promotion](#stack-promotion). Anyone installs one with a single `uvx` command:
  [install](docs/install.md)
- Dotfiles selects pins and activates them with `chezmoi update --upgrade`; require
  `pi-profile doctor` afterwards. Nothing here reads a machine's home, Brewfile or chezmoi source

### Required checks

Required checks on `main`, four contexts:

- `owned (ubuntu-24.04)`
- `contracts (ubuntu-24.04)`
- `stack (ubuntu-24.04, personal)`
- `stack (ubuntu-24.04, local)`

Docs-only PRs still report the four Ubuntu checks without running their gates. macOS is not required and runs only on main pushes and eligible dispatches. Its owned shards report through a separate fan-in, so their queue and result do not affect `owned (ubuntu-24.04)`.

### Review and merge evidence

The historical nine-context receipt remains in `scripts/tests/fixtures/merge-pr-135.json`, unchanged. Tests explicitly add synthetic replacement matrix records; they are not hosted execution evidence.

The four Ubuntu jobs are the configured required checks of ruleset `main required checks` (id `25524267`, `integration_id` 15368 each); `Promote stack` reads them from `GET /repos/nredd/pi-harness/rules/branches/main`, then attests and releases `stack/<sha>` ("Stack promotion" in `README.md`). `migration-review/standards` and
`migration-review/spec` are no longer required. Reviews are our process, not a CI gate:

- Run separate Standards + Spec reviews on the exact final HEAD; any HEAD change invalidates both
- `scripts/merge-pr.ts` is the measured Node merge/receipt implementation; `scripts/merge-pr.sh`
  is only its unmeasured compatibility bootstrap. `scripts/merge_pr_checks.py` retains the read-only CI
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
  reviewed and merged may the parent copy **all three** scripts together from the merged revision into
  that directory. Do not activate an unreviewed copy or change managed Pi config
- The helper gates **all** reported checks, including optional fork jobs, not just required contexts.
  It independently verifies every ruleset context against its bound app and reviewed SHA. Missing,
  pending, failed and current cancelled checks refuse. `SKIPPED` remains accepted for non-required
  conditional jobs
- A zero-step completed/cancelled literal CI matrix placeholder (`owned`, `contracts`, `stack`, and
  the non-required `owned shard` jobs)
  is stale only with a later completed/successful execution of the same workflow ID/path, event,
  PR/head/base (including repository identity), Actions app and SHA. All four expected expanded
  matrix cells must individually succeed. The latest workflow execution must qualify; an intermediate
  green run cannot hide a later cancellation. Ordering uses `run_number`, then `run_attempt`, never
  timestamps or API page order. Evidence is fully paginated and validated as strict Pydantic records;
  missing, malformed or ambiguous evidence refuses.
  The bounded matrix contract test must change alongside any CI matrix change
- Bootstrap this helper's own PR without replacing the scratch copy: after independent Standards +
  Spec reviews of its final HEAD and existing hosted checks are green, invoke its reviewed tracked
  helper directly from the candidate worktree:
  Install the existing locked integration environment (`uv sync --locked` in `tests/integration/`)
  for Pydantic evidence validation. Select trusted absolute executables and the actual transcript
  storage directory explicitly; there is no PATH-based or workstation-specific fallback.
  Select `MERGE_PR_NODE` as a trusted absolute Node executable (the repository Node version supports
  direct TypeScript execution). The six positional arguments are unchanged. Node uses filesystem APIs
  for transcript discovery, regular-file checks and private temporary receipt cleanup; child commands
  use literal argv without a shell. The Python predicate is selected relative to the Node module, not
  the working directory or PATH. The poisoned-PATH regression retains the actual wrapper/Node/Python
  chain and synthetic GitHub CLI; no real merge is attempted. `make check-import-audit` produces actual
  V8 lines/functions/branches/statements for `merge-pr.ts`, enforced at zero gaps by coverage accounting.
  The tiny shell executable-selection/exec bootstrap is still pending/unmeasured, not a shell coverage
  claim. Root WSL, PowerShell and workflow-inline measurement remains open under #695; this slice does
  not close that umbrella or replace its remaining lint requirements.

  Example:

  ```sh
  MERGE_PR_TRANSCRIPT_ROOT=<absolute-transcript-store> \
  MERGE_PR_NODE=<absolute-node-executable> \
  MERGE_PR_GH=/opt/homebrew/bin/gh \
  MERGE_PR_PYTHON=$HOME/code/pi-harness-merge-helper/tests/integration/.venv/bin/python \
  bash ~/code/pi-harness-merge-helper/scripts/merge-pr.sh \
    <helper-pr> <full-reviewed-head> <standards-task-id> <spec-task-id> \
    <gate-history-file> nredd/pi-harness
  ```
  This uses real green checks and the same receipt/expected-head enforcement, not a bypass.
  Any actual conflict resolution or other HEAD change invalidates both reviews; unrelated base advancement does not. Refresh the distribution copy
  only after that reviewed merge. This procedure does not authorize merging router PR135,
  publishing packages, or activating live configuration
- `forks.yml` is path-filtered and not a required protection check; when triggered, the remaining core Gitlink job must pass before merging

## Core fork

The selected core is `v1.3.0-nredd.13`, with GPT-6.2 Sol/Astra in its model catalog.
See [releases](docs/releases.md) for the artifact and provenance details.

- `forks/pi` is `nredd/pi` (integration branch `main`), a patch queue on an `earendil-works/pi` release tag. Inspect it
  with `git submodule status`; add the `upstream` remote by hand when rebasing the queue
- A parent worktree does NOT isolate the submodule. Never `--force`, clean or discard inside it
- Order: core fork PR with its native gate and both reviews, publish the reviewed commit and
  release, then a parent PR that moves the Gitlink, root `overrides`, `release/stacks/personal.json`
  and the lockfiles together
- `make check` is not the core gate. `forks.yml` runs the core suite at the exact Gitlink and
  the ordinary `tests/integration/scenarios/candidate/test_core_compaction.py` pytest scenario runs the
  assembled direct/routed child probes after authenticated root installation and `make build`.
  It type-checks `compaction-children.test.ts` against the Gitlink source via `forks/pi/tsconfig.json`
  before running the Node tests. It requires the built candidate core, fails rather than skips when
  missing, and owns its private HOME/auth/tmp and offline environment through `harness.sandbox`.
  `make check-probes` still lints the whole probe directory and type-checks the other probes against
  the released host. The fork gate's non-rewriting
  check mirrors the entire selected core script, including worktree readiness and the binary-release
  and fork-audit type checks; only Biome's `--write` is removed
- The Forks system dependency step always installs the upstream packages. It tries the Ubuntu mirrors in
  turn: Azure first, then the Ubuntu archive if the index or package download
  fails. Each apt command has its own deadline inside the five-minute step and prints its captured
  output on completion or timeout. The script writes a scratch sources file, points apt's
  `Dir::Etc::sourcelist` at it, and disables list cleanup so the runner's configured sources and
  other repositories' indexes stay in place. An unsupported sources layout fails the step; if both
  mirrors fail, the log names each one. The script installs the downloaded packages without another
  network fetch.
- The extension forks are imported workspaces, not submodules. They are not kept in sync with
  upstream; each README records where it came from

## Frozen release verification

PR merge policy and release policy are separate. A PR needs all configured checks green on its
own final HEAD and independent Standards + Spec reviews of that exact HEAD. Unrelated advancement
of `main` does not require update-branch, a rebase, or another PR matrix. Actual conflicts still
need resolution; every HEAD change needs fresh checks and both reviews. Never weaken checks,
protection, app bindings or review requirements to merge.

The owner authorized non-strict required status checks on ruleset `25524267` on 2026-10-29.
All four matrix contexts remain bound to Actions app `15368`, with no bypass actors. This
source change does not edit remote protection. Keep `strict_required_status_checks_policy=false`.
The merge helper still compares the old and replacement executions' tested base SHA when proving
that a cancelled zero-step placeholder was superseded. It does not compare that base SHA against
the moving current main tip. Required checks and reviews remain tied to the unchanged PR HEAD.

Before publication or promotion, freeze one combined `main` candidate and run the complete CI
lane for that exact commit. `ci.yml` manual dispatch disables PR shortcuts, executes every owned
and contracts cell plus the three stack cells that run a stack
(`ubuntu-24.04` personal and local, `macos-14` local), and calls the existing complete core fork
gate. It reuses the native checks, packed contracts, Node D/E and standalone D/E producers.
It does not make bench F, live-provider G, linux-arm64 runtime, native desktop or the documented
standalone auth-interception exclusions into passes.

Dispatch it on the frozen candidate:

```sh
gh workflow run ci.yml --repo nredd/pi-harness --ref main
```

Record the run's exact `headSha`. All checkouts use that frozen event commit. If main advances
after dispatch, the run and release candidate remain valid; no newest-tip or timestamp freshness
predicate exists. If the desired candidate is already an older ancestor of main, create a
`release-verification/<full-sha>` branch at that exact commit and dispatch on that ref instead.
The classification step requires both the exact SHA-encoded branch name and main ancestry;
`test_dispatch_classifies_only_frozen_main_candidates` runs that real step against a fixture repo.
Each dispatch's `release-core` call groups per SHA without cancellation, so a later dispatch never
cancels an earlier candidate's core gate.
The verifier accepts only `main` or that exact frozen ref, never arbitrary PR branches. Delete
the temporary ref after release evidence is retained. Rerunning the original dispatch also keeps
the original commit. No branch is moved forward merely to satisfy release freshness.

`pi_release.release_gate` requires a successful `workflow_dispatch` run of `ci.yml`, its exact
candidate `head_sha`, the current attempt's complete matrix and core jobs, the successful actual
execution steps (not just successful job labels), and all retained, nonempty coverage, packed
contract, Node stack and standalone stack artifacts bound to that run and SHA.

The required job set is the verifier's own `OWNED_SHARDS`, not the candidate's. Each caller runs
the verifier that matches its candidate: `publish.yml` runs from the tag's commit, and
`promote-stack.yml` verifies a candidate from current `main`. A candidate that predates a shard
change (e.g. the #660 macOS split) therefore verifies under its own commit's gate, not current
`main`'s; do not promote such a candidate from a later `main` without re-freezing it.

The required steps follow the CI plan (`scripts/ci_paths.py`, [workflow policy](.github/workflows/ci.yml)): each `owned shard (<os>, <shard>)` job must have executed its planned `Owned gate <target>` steps (`OWNED_SHARDS`: native cells `check-ts` (on macOS split across the `subagents`, `computer-use` and `ts` shards, #660), `check-scripts`, `check-integration`), each `owned (<os>)` fan-in its `Require every planned shard to succeed` and coverage accounting steps, and the stack cells are exactly those the plan can run, never the `STACK_NOT_RUN` names. A dispatch is planned with `ci_paths.py --full`, so every such cell runs. Tests pin `pi_release.release_gate` to `OWNED_SHARDS`, `OWNED_GATES`, `STACK_NOT_RUN` and the step names in `ci.yml`.

Artifacts are per run, with no attempt field, so each required artifact is bound to the job that
uploads it (`coverage-<os>` to `owned (<os>)`, `contract-reports-<os>` to `contracts (<os>)`,
`stack-*` and `standalone-*` to their `stack (<os>, <stack>)` cell). That job must be in the
current attempt's job list and successful, and exactly one upload of that name must have a
`created_at` inside the job's `started_at`..`completed_at`, both bounds inclusive, compared as
offset-aware instants. A naive timestamp refuses. Two uploads inside one window refuse, the newest
never wins. After "Re-run failed jobs", the new attempt lists the carried-over successful jobs with
their original timestamps, so their original uploads still qualify; a re-run job qualifies only
through its new upload, never the failed attempt's same-named artifact. Missing, skipped, failed,
expired or mismatched evidence refuses, and so does a malformed REST page. `python -m pi_release.release_gate` exits 0 with evidence and 1 when refused; a
harness defect raises instead of reading as a refusal. Ordinary `main` runs and old PR checks are
not fallbacks. Artifacts use normal Actions retention; expired evidence needs a real rerun, not
a replacement receipt. The verifier paginates run, job and artifact collections. Ubuntu publication/promotion jobs use
trusted `/usr/bin/gh`, not PATH lookup; the `publish.yml` `verify` job runs computer-use releases on
macOS and sets `RELEASE_GATE_GH=/opt/homebrew/bin/gh` there. Read-only local diagnostics on another platform must set
`RELEASE_GATE_GH` to its trusted absolute executable, e.g. `/opt/homebrew/bin/gh`;
relative, missing or nonexecutable paths refuse.

Publication and promotion are distinct candidates and evidence:

- Prepublication: merge the reviewed package/version/lock changes without selecting unpublished
  versions in `personal.json`. Run full frozen CI on that source candidate. Its owned suites,
  local workspace stack and packed contracts verify the candidate source/package graph. Its
  personal registry stack still describes the existing published selection, NOT the new release.
  `publish.yml` requires full execution evidence before verification and again before the
  privileged publish step, then packs once and checks/publishes those exact bytes through the
  existing descriptor and provenance gates. Do not reinterpret old registry-stack evidence as
  verification of the new package versions.
- Postpublication: after the registry integrity, signatures and provenance checks succeed, merge
  the reviewed exact published stack selection. This changes selected inputs, so freeze and fully
  verify that combined main candidate separately. `promote-stack.yml` requires its full execution
  evidence before snapshot construction; `promotion_verify` records the full dispatch run ID in
  `stack_run_ids`. Existing required-check, registry-byte, core and snapshot checks still apply.
  Owner environment approval remains mandatory before attestation/publication. Dotfiles adoption,
  deployment and activation consume that exact attested snapshot, never old PR or another package
  set's checks.

Older push/main-only evidence is insufficient for new publications and promotions. Existing published releases and snapshots remain historical artifacts and
are not retroactively relabelled as fully verified by this lane.

## Stack promotion

`release/stacks/personal.json` is the only editable personal package list. A promotion turns one exact, already-gated `main` commit into an attested `stack/<sha>` release. Flow: verify -> attest -> `stack/<sha>` release -> dotfiles pins the sha. There is no moving pointer: consumers pin an exact `source_sha`, never `main`. This is the trust root for adoption, so every gate fails closed.

Full [frozen-candidate verification](#frozen-release-verification) is mandatory before snapshot
construction. It requires actual full matrix/core execution and retained artifacts for the exact
combined source SHA, not ordinary `main` runs or old PR checks. Unrelated later main
advancement does not invalidate a frozen verified candidate. No operation waives this barrier.

### Snapshot format

`stack-snapshot.json` is compact, sorted JSON with this strict schema (`release/pi_release/promotion.py`):

- `schema_version`: currently `1`.
- `source_sha`: the exact 40-character `main` commit selected.
- `stack`: the validated `personal` stack object, including ordered sources and core release identity.
- `stack_sha256`: SHA-256 of compact sorted UTF-8 JSON for `stack`, not of the surrounding snapshot.
- `gates`:
  - `required_checks`: the configured `main` check names, all successful on `source_sha`.
  - `stack_run_ids`: the qualifying full-dispatch CI run for this exact frozen candidate.
  - `owned_packages`: one `{package, integrity}` per `npm:@nredd/` source, with the registry's real SHA-512 integrity from `scripts/npm_release.py stack-check`.
  - `core`: the core release tag and asset SHA-256 digests, which must equal the stack's `core` and the release's `SHA256SUMS`.

The snapshot's `stack` JSON obeys the canonical-JSON rules in `tests/integration/README.md` (no floats, unsafe integers, non-string keys or lone surrogates); the producer guard lives in `release/pi_release/stack.py`.

The module rejects unknown fields, malformed SHAs, non-personal stacks, digest mismatch, duplicate evidence, and owned-package evidence that is not exactly the stack's `@nredd/` sources.

The snapshot schema remains strict v1 and retains its historical owned-only integrity boundary. New promotions additionally publish and independently attest strict `dependency-graph.json`, containing its own schema version, exact `source_sha`, and source-selected complete native runtime locks bound to the canonical stack digest. The hardened standalone installer requires BOTH assets; historical snapshot-only promotions are unsupported, never silently downgraded. Existing dotfiles snapshot-v1 consumers are unchanged and do not gain installer runtime-byte guarantees.

### What gets verified

Workflow: `.github/workflows/promote-stack.yml` (`workflow_dispatch`, `main` only). The workflow concurrency group is `operation` plus the selected SHA, so a `verify-only` dispatch never replaces a pending `promote` of the same commit and two promotions of one SHA run one at a time. With 3+ duplicate same-SHA, same-operation dispatches GitHub keeps one pending run and cancels older pending ones, so duplicate pending dispatches coalesce. That is harmless: `stack/<sha>` creation is idempotent and fails closed on mismatch. Different SHAs are independent: each writes only its own `stack/<sha>` tag and release. Every job has `if: github.ref == 'refs/heads/main'`. All gate logic lives in Python with fixture tests, and every `run:` is one Python (or one `gh`/action) call with inputs passed through `env:` only. The read-only `verify` job runs `pi_release.release_gate` followed by `python -m pi_release.promotion_verify`, which repeats the full barrier before candidate construction and fetches the remaining evidence itself (`gh`/`git` through `promotion.run_command`) and calls `select_source_sha`, `descends_from`, `verify_required_checks`, `verify_core`, `collect_owned_evidence` (worktree per owned tag plus `stack-check`), `build_gates` and `build_snapshot`. The verifier also reads `release/stacks/runtime-locks.json` from that exact source commit, binds its roots/digest to the selected stack, cross-checks owned SRI, and verifies every selected tarball against standard npm SRI (plus authenticated core SHA-256). It never re-resolves the graph during promotion or resume. The write-privileged `attest-and-publish` job runs stdlib-only `python3 -m pi_release.publish_gate` subcommands `prepare-release` and `tag-target` (the complete set), plus `gh attestation verify`, `actions/attest-build-provenance` and `gh release create`. `pi_release.promotion` is a library with no CLI. Evidence failures and Git failures print `FAILED: ...`, never a traceback.

- Inputs: `select_source_sha` (called by `promotion_verify`) requires `operation` to be `verify-only` or `promote` and `source_sha` to match `^[0-9a-f]{40}$`. The commit must be an ancestor of `origin/main`. The `fetch origin main` that gets `origin/main` carries no credentials (`persist-credentials: false`), which is fine because the repository is public.
- Required checks: every context from `GET /repos/nredd/pi-harness/rules/branches/main` (ruleset `main required checks`, readable by `GITHUB_TOKEN`) must be `completed`/`success` on that exact SHA, reported by the rule's `integration_id` app (`app.id`, 15368 for every configured context). No checks from the rules API fails closed. Review statuses are not required checks.
- Deferred, review statuses (`migration-review/standards`, `migration-review/spec`): they are no longer required checks and the merge flow posts no commit statuses (`.github/workflows/ci.yml`), so there is nothing to read; reviews stay a process step.
- Deferred, tap readiness when core changes: not implemented; the core release's asset digests and attestation are the only core gate, and a tap bump is gated by its own green CI.
- Registry-stack evidence: the exact full `workflow_dispatch` run validated by `pi_release.release_gate`. Every owned and contracts cell, each stack cell that runs a stack, and the core gate must actually execute, with retained nonempty per-cell artifacts whose `workflow_run` id and `head_sha` match. Both step names and artifact templates are bounded producer contracts guarded by tests; update the verifier alongside producer renames. The personal stack installs the explicit sources from the registry and the core release into a disposable tree.
- Why the artifact: a green job context does not prove the scenario ran. `ci.yml` uploads `stack-<os>-<stack>` only when `steps.plan.outputs.run == 'true'`. On PRs only Ubuntu cells exist, and bypassed Ubuntu cells do not produce the artifact. The verifier matches only the exact artifact name, and a test guards that template in `ci.yml`.
- Push, PR and docs-only runs never qualify: only a full `ci.yml` dispatch of the exact SHA does, and it skips no docs or stack-input shortcut, so a docs-only candidate is promotable once dispatched; see [release verification](#frozen-release-verification). Differently named artifacts are not promotion substitutes. Artifacts expire with CI retention, so an old SHA must be dispatched again before it can be promoted.
- Owned packages: `scripts/npm_release.py stack-check` runs per `@nredd/` source against a worktree of its exact tag: registry presence, npm `audit signatures` (signature and attestation), and the SLSA provenance binding to `publish.yml`, the tag and the commit. The registry lookup (`npm view`) runs in a fresh empty directory with `NPM_CONFIG_USERCONFIG=/dev/null` and `--registry https://registry.npmjs.org`, so a `.npmrc` in the selected tag's tree cannot steer it.
- Core: asset digests are compared with the release's `SHA256SUMS`. For non-legacy tags `SHA256SUMS` is a mutable release asset, so each recorded asset is also downloaded, hashed against the recorded digest, and verified read-only with `gh attestation verify --repo nredd/pi --signer-workflow nredd/pi/.github/workflows/fork-release.yml --source-ref refs/tags/<tag>`. Legacy tags `v1.3.0-nredd.3` through `.7` predate that workflow and rely on the frozen `LEGACY_CHECKSUMS` hashes.

Core SSH signing keys are checked by the core release workflow, not by the promotion
consumer's attestation verifier. The core allowlist uses principal `nredd` and namespace `git`:
legacy key `SHA256:YHzjQXY3SPl20zOMMOoNz8o4dk+eOZEi8FA+vS6nwFY` (retained for historical tags)
and current key `SHA256:+16+g7/7VKDJ2svgiuGIbfPnPF9pKKSU/h51+K9iHdk`.
The latter is owner-approved for `.8` and future releases. No wildcard principal, skipped
verification, new legacy exception, Gitlink move, or stack/pin change is implied.
Core, harness, dotfiles and tap keep separate trust boundaries.

The CI evidence is the only coupling to CI: run IDs are read with `gh run list/view`, the `actions: read` and `checks: read` permissions are granted, and an unreadable response fails with an explicit error.

### Required-check visibility

The required checks live in ruleset `main required checks` (id `25524267`, non-strict). The verifier discovers the live contexts via `GET /repos/nredd/pi-harness/rules/branches/main` with `GITHUB_TOKEN`. Green required checks do not replace evidence from the full dispatch. Classic branch protection is not read: if the rules API yields no check, `verify_required_checks` fails closed.

### Operations

Dispatch `Promote stack` with `operation`:

- `verify-only` (the default): runs every check above and builds the candidate snapshot. Writes nothing: no artifact, release, attestation or tag, and the `attest-and-publish` job (the only job in the `stack-promotion` environment, with write credentials) is skipped. Run it first to see exactly what a promotion would do; it needs no approval.
- `promote`: `verify-only` plus attestation and the `stack/<sha>` release.

Rollback is re-pinning: point dotfiles at an older retained `stack/<sha>`. Nothing in this repository moves, so there is no rollback operation. Tags are protected from update and deletion (ruleset `25524298`); release assets are not, but a replaced asset fails `gh attestation verify`, so every previously promoted snapshot stays usable only as attested.

Environment: `environment: stack-promotion` gates the whole `attest-and-publish` job, so a required reviewer (the owner) must approve before the job gets `contents`/`attestations`/`id-token` write. It is kept deliberately: it is the only human gate between a green `verify` and a permanent attested release, and a release cannot be retracted. It also restricts the job to `main`. No secret is stored in it any more.

Privilege split: the `verify` job runs only `main` code plus data from the selected commit, holds `contents`/`actions`/`checks` read only, and runs no `npm ci` or `uv sync` from the selected commit. The `attest-and-publish` job holds `id-token`/`attestations`/`contents` write, installs nothing, and only downloads the verified artifact, runs `pi_release.publish_gate` (standard library only, from `main`, asserted by a test), attests, and publishes.

### Release

`promote` attests both `stack-snapshot.json` and `dependency-graph.json` (`actions/attest-build-provenance`), creates release/tag `stack/<source_sha>` containing both, then confirms the tag points at `source_sha`. The tag namespace deliberately does not overlap package tags (`@nredd/<package>@<version>`).

Resume: `prepare-release` runs before any attestation. It asks `git/matching-refs/tags/stack/<sha>` for the exact ref; only an empty answer means `create`. Any `gh` failure (403, 5xx, rate limit) raises instead of being read as "absent". An existing tag must be a lightweight tag pointing at `source_sha` (annotated tags are rejected: `gh release create --target` only makes lightweight tags, so one is hand-made), its release must carry BOTH `stack-snapshot.json` and `dependency-graph.json` (otherwise refuse), and both assets must be byte-equal to the rebuilt source-selected evidence (`resume`). Both existing attestations are then verified and nothing new is created. A retained legacy release without a graph cannot be upgraded/backfilled. `tag-target` re-reads the ref after publication and requires the same. Evidence is deterministic (sorted checks, earliest qualifying run); if the required-check set changed in between, equality fails closed, so investigate.

### Owner touchpoints

Created 2026-10-20 via `gh api`; the workflow does not create or change any of them:

- Ruleset `25524267` `main required checks`: four Ubuntu contexts (`integration_id` 15368, non-strict).
- Environment `stack-promotion`: required reviewer the owner, deployment branches `main` only. The only job in it is `attest-and-publish`.
- Ruleset `25524298` `stack snapshot tags` on `refs/tags/stack/**`: blocks tag update and deletion; bypass is admin. It does not protect release assets, but consumers verify the attestation, so a tampered asset is rejected. Creation stays open: an unattested tag is unconsumable because consumers verify attestation, and `GITHUB_TOKEN` creates the tag through the release.

### Consumer requirements

Consumers pin an exact `source_sha`, download the `stack/<source_sha>` release asset and MUST verify its attestation before use:

```
gh release download stack/<source_sha> --repo nredd/pi-harness --pattern stack-snapshot.json
gh attestation verify stack-snapshot.json --repo nredd/pi-harness \
  --signer-workflow nredd/pi-harness/.github/workflows/promote-stack.yml \
  --source-ref refs/heads/main --deny-self-hosted-runners
```

Then validate it with `StackSnapshot` (`release/pi_release/promotion.py`) and require its `source_sha` to equal the pin. `load_promoted_snapshot` does both. `gh attestation verify` needs a GitHub login unless it is given the bundle: the public attestations API serves it anonymously, which is what the installer does (`--bundle`, see [install](docs/install.md)). An unattested file, or one attested from another workflow or ref, must be rejected, keeping the last good stack. To roll back, pin an older retained `stack/<sha>`.

### Promoting

Run `verify-only` on a `main` SHA whose CI ran the stack job, then `promote` with the same SHA and approve the `stack-promotion` environment.

### Historical waived record

`stack/17236539759ccc8858e605ed3f07531cacf2d9e0` is an immutable historical owner-waived record, not green-CI evidence. Do not alter its tag or release, and do not treat retrospective review as satisfying its pre-release gates. The `owner-override` operation no longer exists; recovery requires an ordinary reviewed, green-CI `verify-only` then `promote` flow.

## Self-hosted runners

`nredd/pi-harness` is PUBLIC. A self-hosted runner executes whatever a workflow says, and a fork PR brings its own workflow file, so the design assumes any job may be hostile and makes the runner worthless to compromise.

Infra code and runbook live in the private `nredd/ci-runners` repo. This page is the policy and the spec.

### Pools

CI plans cells across these pools and hosted runners by effective capacity, and a cron rescue moves cells
queued too long on a pool back to hosted. Policy, bounds and residuals live in the `Self-hosted routing policy` comment
in [`ci.yml`](.github/workflows/ci.yml) and the header of [`runner-rescue.yml`](.github/workflows/runner-rescue.yml);
there is no hard queue-time guarantee.

The macOS `native-helper.yml` build can use `pi-macos` through shared admission, with `xcode-27`
as the hosted fallback (only on attempt 1). It has not passed on the pool image; a started failure fails its
check. Cron rescue reads every repo run: a stranded pool `build` is rescued only once all unfinished jobs of
its run are unstarted (e.g. `windows-helper` finished), and the whole run is then cancelled and re-run.
If `windows-helper` cannot bootstrap the pinned Python interpreter through `uv` (including when
an earlier step fails and skips bootstrap), it attempts to upload only `build.txt` with
`staging=BOOTSTRAP_FAILED`, `executable=NOT_BUILT`, and `fixture=NOT_REACHED`.
The macOS `scripts` shard stays hosted (`HOSTED_ONLY_CELLS`), DEPARTING from the original issue scope, because
core provenance verification in `make install-owned` needs `GH_TOKEN` and the pool has none. Follow-up: make
that verification work without a token, then drop the denylist. The installer stays hosted for its read-only
token; publish stays hosted for OIDC and attestation.

| Label | Host | Isolation |
| --- | --- | --- |
| `pi-linux` | Linux VM host | One linked-clone VM per job, destroyed after the job. Per-VM PVE firewall drops every private net, so no LAN, no tailnet. 8 vCPU, 10 GiB, 50 min cap |
| `pi-macos` | macOS arm64 host | One job at a time as the unprivileged hidden `ci` user. All `ci` processes killed and its home and `/tmp` files wiped before and after every job, runner restored from a root-owned golden copy. pf rules block `ci` from every private net. 50 min cap |


All register repo-scoped with single-use JIT configs: a runner takes one job and its registration dies with it. No org or user level runners, no runner groups to misconfigure, nothing persistent to steal. The PAT that mints configs (`Administration: write`, `Actions: read`, this repo only) lives root-only (SYSTEM and Administrators on Windows) on the host, never inside a VM or the `ci` account.

### Repo settings (enforced, check with `gh api`)

- Actions allowed: `selected` -- GitHub-owned plus `astral-sh/setup-uv`, `oven-sh/setup-bun`, `taiki-e/install-action`
- `sha_pinning_required: true` (every `uses:` is already a full SHA)
- Fork PR approval: `all_external_contributors`, i.e. EVERY fork PR run waits for the owner. Never use "first-time contributors". Do NOT approve a fork PR run without reading its workflow diff: a fork can rewrite `runs-on` to a self-hosted label
- Workflow token default `read`, `can_approve_pull_request_reviews: false`
- No collaborators, no repo or org secrets (environments `npm`, `stack-promotion` are branch-gated), no `pull_request_target`, `workflow_run` or `issue_comment` workflows. Adding any of these with a self-hosted `runs-on` is a blocking change
- Ruleset `main required checks` requires the same names the hosted cells report

### Threat model

- Fork PR: never reaches a runner unless the owner approves the run (see above). Even then it gets a throwaway VM / wiped user with public internet only
- Same-repo PR or push: owner-authored, trusted like hosted, but still ephemeral
- Compromised dependency in a job: can burn that one VM or the `ci` account, cannot reach the LAN, tailnet, the PAT, the owner's home or any credential, and leaves nothing for the next job
- RESIDUAL on `pi-macos`: `ci` shares a kernel with the laptop, so a local privilege-escalation exploit would break out; loopback services stay reachable; DNS (port 53) to the resolvers stays open. A VM would be better but there is no disk for a macOS+Xcode image. Keep macOS patched
- RESIDUAL on `pi-linux`: `runner` has passwordless sudo inside the throwaway VM (apt installs); link-local IPv6 is not dropped

### Smoke

`runner-smoke.yml` is `workflow_dispatch` only. Each pool must show: runner name and arch, public internet reachable, and non-identifying private, shared-address and link-local targets blocked. These probes do not prove every address is blocked. Host-specific extra targets go in the repository variable `SMOKE_EXTRA_TARGETS` (space-separated `host:port`, appended to the neutral targets in both loops; the job prints a note when it is empty and fails on any entry that is not `host:port`) and the home directory to probe in `SMOKE_OWNER_HOME` (the macOS home probe is skipped with a note when unset and fails when the path is not a directory). Set both privately, never in the repository. `scripts/tests/test_private_probe_addresses.py` enforces this across every tracked file except `forks/`, lockfiles and generated build output (`dist/` and `*.map`). Any RFC1918, CGNAT (`100.64/10`) or link-local address, tailnet-style hostname (`*.ts.net`, `*.tailscale.net`) or ULA/link-local IPv6 address (also zero-padded octets and IPv4-mapped IPv6 forms), and any path rooted at a `Users` or `home` directory whose next segment is not `<user>`, `$USER` or `runner`, fails unless it is one of the neutral probe targets allowlisted in that test. Fixture files that carry synthetic values (e.g. made-up home names or private-range test addresses) are scanned too: their exact values are listed per file in `FIXTURE_VALUES`, and a stale entry fails the test.

### Throttled synthetic PTY experiment

`tests/integration/scenarios/bench/test_throttled_pty.py` is a separate POSIX experiment
(#977). It reuses the generated 2,000-message
session, faux provider, installed fixture homes and latency probe. No existing multisession
threshold, history or baseline changes. From `tests/integration`, run serially on an admitted
quiet runner with explicit `PI_BIN` and `--stack`:

```sh
uv run --locked pytest scenarios/bench/test_throttled_pty.py --stack stacks/local.json -n 0 --log-cli-level=INFO
```

- Each 1/4/8-child fleet has an uncapped control and a **65,536 bytes/s aggregate cap**, not a
  per-child allowance. One rotating 1,024-byte quantum services ready PTYs; elapsed monotonic
  time paces reads without catch-up bursts. Startup drains uncapped, then each measured window
  lasts six seconds. Readiness is bounded at 60 seconds; input writes at one second; teardown
  kills owned groups before reaping their leaders and closes all masters, including partial
  startup and cancellation. Output tails are bounded at 64 KiB per child. During the capped
  drain, each tick sends input serially: `send()` may block up to one second per child, so
  the eight-child run includes driver-side input delay.
- Calibration first runs a real fast synchronous writer with and without the same cap. It
  refuses absent writes, a writer heartbeat older than 0.5 seconds at the window end, low
  uncapped throughput, failure to deliver the capped rate, or no observed increase in completed
  write duration. Retain the raw calibration JSON, not just a
  claimed cap. A hung writer, exited child, failed probe startup, missing terminal output or
  insufficient input-to-paint samples in measured windows fails the experiment. Probe windows
  must be contiguous (2 ms timestamp-rounding tolerance), with start/end coverage within one
  second; a recent final heartbeat cannot hide an omitted interior interval. Missing measured
  windows fail all cells except the capped eight-child cell, which reports `NOT RUN`.
- The report separates actual delivered bytes/s from probe write volume, event-loop lag,
  synchronous write duration and raw input-to-paint samples. Input-to-paint is stdin receipt
  to the *next write invocation*, not terminal display or the rendering of that exact input.
  Node may buffer asynchronous stdout writes: a short or zero `max_block_ms` does NOT establish
  absence of pressure, a drained queue, or responsive terminal painting. Only the calibrated
  synchronous writer establishes this driver's backpressure; compare paired controls before
  attributing any Pi observation to rendering, runtime or polling.
- An initial 16,384 bytes/s aggregate trial passed the one-child pair but the four-child
  capped cell was refused for missing probe heartbeats. That is a failed observation, not a
  zero-latency result. The 65,536 bytes/s condition measures a less severe terminal link;
  it does not replace or relax any existing performance ceiling.
- The macOS functional trial used Pi `v1.3.0-nredd.11`, Node `v26.13.0`, and a bare fixture
  HOME (no installed extension stack). Both 1/4-child pairs and the uncapped eight-child
  control completed. The capped eight-child cell lacked measured probe windows. A retry
  with Pi `v1.3.0-nredd.13`, the same Node version and bare fixture HOME also lacked measured
  windows. Capped eight-child latency is `NOT RUN`: pytest warns, and the suite report
  records the reason and throughput, not latency metrics. Missing measured windows cannot
  distinguish a hung Pi from a late-starting probe. #1096 tracks the complete eight-child
  measurement without raising the aggregate cap.
- Cumulative and per-cell `throttled-pty.json` reports flush and `fsync` a same-directory
  `.pending` file before atomically replacing the previous snapshot. A write or replace
  exception removes the pending file. The directory is not synced, so replacement is not
  guaranteed to survive power loss. Readiness, warm-up, or measurement failures still fail
  the experiment, with any partial delivery and raw probe records in the cell report.
  If readiness or warm-up fails, that delivery is startup output, not a measured window.
- Busy-host functional execution is not idle performance acceptance. Native WSL2 and quiet-host
  baselines remain NOT RUN until actually measured. No ConPTY, terminal emulator or live-provider
  claim is made. The driver uses the standard library plus the repo's own process-group helper.

### Remaining

- `pi-macos` availability: a sleeping laptop leaves its jobs queued forever. `caffeinate -s` keeps it awake on AC; the rescue moves an idle-queued cell to hosted after five minutes on a stale pool, but not while a sibling job of the run is already running (it never cancels a started job)
- Quiet benchmark runner (`bench`): `pi-linux` is a shared host, so it does NOT yet meet the [bench admission policy](.github/workflows/ci.yml)
- Alerting: the daemon only logs to journald; nothing pages when it is down
