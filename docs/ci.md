# CI

CI is the gate. Local runs are for development. Hosted runners only, no stored credentials or secrets.
The publish job alone requests a short-lived npm OIDC identity.

`.github/workflows/ci.yml`, every PR and `main`:

| Job | Normal PR | `main` push | Docs-only PR or push | Proves |
| --- | --- | --- | --- | --- |
| `owned (ubuntu-24.04, macos-14, wsl2)` | `make install`, `make check-ts check-scripts check-integration`; `make check-benchmark` on macOS only. `cargo-nextest` is installed so dev-tools' real cargo suite runs instead of skipping | Same | Reports success after the classifier logs the bypass | Biome, tsc and each package's Vitest suite and declared `test:bun` suite (router, preset, resource-sampler, todo and inprocess run FULL Vitest suites on both engines with the shared homedir guard; subagents retains native scenarios plus a guarded real-loader gate until #174, with its full Node suite guarded; the other packages retain native Bun subsets; a notice names every package without `test:bun`, as NOT RUN), `scripts/` and `integration/` unit gates. `check-benchmark`'s `native_runtime` test needs Seatbelt, so Linux/WSL reports it NOT RUN. See the computer-use note below. |
| `contracts (ubuntu-24.04, macos-14, wsl2)` | `make check-package-contracts` (includes the packed preset audit + install), `make check-plan-mode-package-contract`, `make check-subagents-package-contract`, `make check-todo-package-contract`, `make check-computer-use-package-contract` | Same | Reports success after the classifier logs the bypass | Packed tarballs alone on exact stock Pi 1.3.0 (dev-tools with its exact `@nredd/pi-resource-sampler` from the registry, integrity checked against `npm view`, real parent-child discovery by that installed sampler's full scan, and a bounded `resource_snapshot`), the packed preset audited and installed alone, and the packed `@nredd/pi-subagents` with `croner`/`nanoid` from the registry plus one faux `Agent` call (the same gate the release `verify` runs, so a PR proves it before a tag does). The packed `@nredd/pi-todo` with `@juicesharp/rpiv-config`/`rpiv-i18n` from the registry plus one faux `todo` create. The packed `@nredd/pi-computer-use` through the platform-aware tool set (13 tools on macOS, 11 on Linux) plus Mach-O arch/mode checks of both prebuilt helpers; its `postinstall` and every desktop tool are NOT RUN. JSON reports uploaded as artifacts |
| `stack (ubuntu-24.04, macos-14, wsl2; personal, local)` | Node release-bundle D/E scenarios in each cell; each personal cell also builds the core Gitlink with Bun and runs standalone D/E for both stacks | `stack (ubuntu-24.04, personal)` and both WSL cells run, including standalone stacks in personal cells; the other three native job names log the selective smoke | Every cell reports success after the classifier logs the bypass | Node release bundle plus source-built linux-x64/darwin-arm64 standalone, independent stack installations, startup/transport/lifetime/output/tool surfaces and tmux resize; seven Node-preload auth cases per standalone stack explicitly skip, missing-preload refusal runs. Separate Node/Bun JUnit and failure artifacts, stack identities and binary/archive SHA-256 retained. Computer-use helper explicitly excluded |
| `bench (not run)` | a notice and a step summary | Same | Same | Nothing. No quiet self-hosted runner exists yet (migration plan section 7) |

On the `owned` job, `@nredd/pi-computer-use`'s macOS-only checks (`test:invariants` INV-8/INV-17, `test:macos-native`, `test:desktop`'s helper wire mapping and gating, `test:macos-live`) print `NOT RUN` lines on Linux and are not passes. Conversely, `test:linux-native` runs headless on the Ubuntu and WSL cells (`NOT RUN` on macOS): the crate's `cargo test --locked`, a source build from the *packed* tarball into a user-cache target dir, the built x64 helper's real `diagnostics` (protocol 4, shared architecture invariants), the cargo-missing hint and compiler cleanup on `SIGTERM`. The aarch64 target (`rustup target add`) is `cargo check --locked` compile-only; ARM64 runtime, desktop/display and live UI are NOT RUN. This is coverage inside the existing `owned` job, not a new required check (`test:linux-native` prints `Linux native checks passed` on Ubuntu, `NOT RUN` on macOS.)

The resource sampler's package gate runs real host sampling and bounded helper cleanup in each
`owned` OS cell. `check-package-contracts` also builds/audits/installs its exact ESM tarball and
runs an isolated Node consumer in each `contracts` OS cell. This library has no Pi entrypoint;
Darwin process CPU is explicitly unavailable because `ps` start identity has one-second precision.
No consumer migration, publication, extra CI job or runner is added.

## Capacity controls

`classify changed paths` compares the pull request base and head, or the pre-push and pushed `main` revisions, with real Git. It never path-filters a required job: all twelve matrix jobs start and report a terminal status. A docs-only change skips the native Linux/macOS expensive steps; WSL2 retains the old workflow's always-execute policy, and every skipped job writes a notice plus a step summary containing the changed-file list. Each job's `plan` step emits `run=true` or `run=false`, logs the changed files when bypassing, and gates every checkout-dependent step on `steps.plan.outputs.run`. `always()` cleanup and artifact steps, plus failure and cancellation conditions, remain in those step predicates.

The allowed docs-only paths are Markdown under `docs/`, root Markdown, `PLAN.md`, and a package-root `README.md` or `CHANGELOG.md`. The classifier is deliberately narrower than "all Markdown": workflow files, manifests, lockfiles, Gitlinks, `integration/**`, `scripts/**`, and `releases/*.json` are code because they do not match an allowed path. It also treats root `README.md` and `packages/preset/README.md` as code because repository tests read their text. A mixed change is code.

The 2026-10-20 capacity measurement found median final-head PR latency of 11m45s, p95 queue waits of 22m37s on macOS and 19m56s on Ubuntu, and four macOS jobs in each full run against five hosted macOS slots. A docs-only `PLAN.md` PR alone consumed 100.25 runner-minutes across 18 stack executions. Bypassing that work reduces real contention without leaving a protected check pending.

`main` still validates the merged result: all `owned` and `contracts` OS cells, both WSL stack cells and `stack (ubuntu-24.04, personal)` run. The other three stack cells report the selective smoke rather than repeating work that a strict PR head already ran. This keeps one end-to-end merged-tree check while removing the most redundant post-merge macOS demand. The same measurement found six explicit update-branch CI runs plus one Forks run used 180.07 assigned runner-minutes; full main-push workflows used 599.13 assigned runner-minutes, including 334.02 macOS minutes. Those are upper bounds, not promised savings, and this policy preserves the higher-value merged-result coverage.

The required checks live in ruleset `main required checks` (id `25524267`, not classic branch protection), which remains `strict`. Strict means that advancing `main` invalidates a PR's previous green result and requires an update-branch rerun before merge. That cost is intentional for combined-result safety; docs-only bypasses make documentation updates cheaper without weakening it.

WSL2 is `matrix.os: wsl2` in the same `owned`, `contracts`, and `stack` jobs in `.github/workflows/ci.yml`. `matrix.runner: windows-2022` selects the host; `matrix.guest: wsl2` selects the explicit PowerShell -> WSL shell boundary, with Ubuntu-24.04 verified as version 2 and a non-`drvfs` guest checkout. The stack platform is `linux-x64`, never a fictitious GitHub runner label or native Windows execution. There is no separate WSL workflow or duplicated WSL test job.

The old split was intentional: commit `cfb5542c` says "without expanding the existing OS and stack matrix"; it covered only personal-stack Node D/E. This change retains that entire entrypoint and adds local-stack Node D/E, both source-built standalone stacks, all applicable owned gates and all packed contracts through the ordinary shared steps. Mac-only Seatbelt, desktop/TCC, live credentials and ARM64 runtime remain NOT RUN. Linux helper checks and ARM64 compile-only checks now run inside the owned WSL guest, not on its Windows host.

Shared setup lives in `.github/actions/setup-ci-tools`, with WSL-specific host setup in `setup-ci-wsl` and tool bootstrap in `scripts/wsl2_setup.sh`. Node, npm, Bun and Python read `.node-version`, `packageManager`, `.bun-version` and `.python-version`; uv stays at the existing CI pin. The pinned, checksum-verified `scripts/install_gh_linux.sh` supplies attestation-capable gh. Only owned cells install Rust/nextest. Native setup-node's npm cache remains native-only; WSL uses its guest HOME tool cache, never Windows Node/Bun/cache paths. Frozen model-data tarballs, strict locks and release verification remain in the shared gate steps. No unmerged #197 or #162 source is copied: #197's authoritative Bun pin remains file-driven, and #162 must preserve its future coverage producer/upload steps through this guest boundary when integrated.

`scripts/wsl2_shell.ps1` forwards an explicit `WSLENV` allowlist. GitHub control-file paths translate to mounted paths, while `RUNNER_TEMP`, builds and execution stay in the Linux filesystem. `GITHUB_ENV` carries Linux `PI_BIN` values unchanged between steps. Only the existing verification/fetch steps receive `GH_TOKEN`; guest bootstrap and scenarios do not. `make install` and stack installs scrub the token from npm/uv children. The token is never dumped or written by these scripts. The existing same-repo workflow trust assumption applies; this is not a sandbox against arbitrary PR code.

WSL cells retain no docs-only or main-push bypass. Unavailable WSL, wrong distribution version/filesystem, bootstrap or gate failure fails the cell. Before ordinary artifact uploads, `capture-ci-wsl` exports only explicit synthetic artifact directories and contract JSON reports to the host. Node artifacts survive standalone runs separately as `artifacts-node`; standalone artifact names include `matrix.os` to prevent WSL/native Linux collisions. Final cleanup preserves the first guest-step failure status and bounded diagnostics. Early host diagnostics survive setup failures. No arbitrary worktree files, command logs, environment or HOME are uploaded.

Reproduce guest execution on a Windows machine with WSL2 Ubuntu-24.04 using the same setup action and `scripts/wsl2_shell.ps1 <step-script>`; run the ordinary Make targets and pytest entrypoints above. A local macOS shell test proves adapter behavior, not WSL execution. Acceptance requires all four exact-HEAD hosted WSL cells and their normal artifacts, plus the unchanged native cells; local tests are not a hosted receipt. CI triggers remain every pull request and main push, without workflow_call/dispatch or path filters; permissions stay contents-read and concurrency remains `ci-${{ github.ref }}` with cancellation.

`.github/workflows/installer.yml`, PRs and `main` pushes that change the installer or the harness modules it reuses, plus manual dispatch with a `stack_sha`:

| Job | Runs | Proves |
| --- | --- | --- |
| `installer (ubuntu-24.04, macos-14)` | `make -C integration installer` with `INSTALLER_SPEC` set to this exact commit (`git+https://...@<sha>#subdirectory=integration`) and `STACK_SHA` the published promotion. The installer reads no token. On `main` pushes/dispatches and owner-reviewed same-repo pull requests (`head.repo.full_name == github.repository`), `GH_TOKEN` is set for the fallback when hosted runner IPs hit GitHub's anonymous 60 requests/hour limit. Job permissions are only `contents: read` and `attestations: read` (needed to fetch attestations); no write permissions are granted. Only the separate `Authenticate gh attestation fallback` step sees `GH_TOKEN`: it pipes the token to `gh auth login --with-token --insecure-storage` with `GH_TOKEN` unset in that child and a temporary `GH_CONFIG_DIR`. `--insecure-storage` deliberately confines the ephemeral login to that private plaintext config rather than an OS keychain, so removing the directory removes the login. `make` and pytest receive only the nonsecret directory path (`INSTALLER_GH_CONFIG_DIR`), not a token. Acceptance wraps `gh` alone to set `GH_CONFIG_DIR` to that path; `uvx`, Git, package builds and other installer children receive neither variable nor token. An always-running cleanup removes the login directory. Fork PRs and non-main dispatches stay anonymous and fail if the limit refuses them (`test_installer_workflow_token_policy` pins and evaluates the expression; `test_installer_workflow_token_permissions_are_read_only` pins permissions and checkout credential stripping). Triggers cover the installer's `harness` import closure, `conftest.py`, `.node-version`, `Makefile`, `pyproject.toml` and `uv.lock` (checked by `test_installer_workflow_covers_its_inputs`). | The documented one-shot `uvx` command in throwaway HOMEs: missing prerequisites, an unpromoted SHA, real `gh` rejecting tampered bytes and a foreign signer/ref, a fresh install equal to the snapshot (order, filters, disabled computer-use, owned npm integrity), a no-op rerun, consent and preservation with an existing setup, and a SIGKILL during staging then a clean rerun. See [install](install.md). |

TRUST assumption: same-repo PR branches are owner-reviewed code. Same-repo `pull_request` workflows are not fork-sandboxed: a branch author can edit the PR's workflow to request write permissions or reference secrets. The read-only block constrains this submitted workflow only; it is not a security boundary against arbitrary same-repo PR code. KNOWN RESIDUAL: same-UID package code inherits the PATH-prepended `gh` shim through `uvx`, the installer, `pi install`, npm/package scripts and Git children that preserve PATH. `make`/pytest also receive `INSTALLER_GH_CONFIG_DIR`; stripping it and the token variables from other child environments does not remove the capability. A child can invoke the shim to authenticate or read its embedded config path and plaintext `hosts.yml`. This is known credential-capability leakage, not merely a theoretical filesystem permission concern. It remains within the same-repo trust assumption: the submitted job token is read-only, but branch authors already control their workflow. No claim of package-script credential isolation is made. The sentinel subprocess test `test_acceptance_token_environment_is_clean_but_gh_capability_remains` demonstrates both clean environments and successful same-UID credential retrieval using the real CLI and a real-format `hosts.yml`.

It is not a required check and has no docs-only bypass; it only starts when its paths change.

`.github/workflows/forks.yml`, when the remaining `forks/pi` Gitlink, `.gitmodules` or the workflow changes, plus manual dispatch:

| Job | Runs |
| --- | --- |
| `core (forks/pi)` | `npm ci`, the release's model data restored from npm `@earendil-works/pi-ai@<version>` (never the live fetch), `npm run build:offline`, the steps of the fork's `check` with Biome check-only (the step fails if the fork's `check` list changes), the env daemon, `./test.sh` |

`integration/inprocess/`, the private `A-stack` workspace, runs in `check-ts` on Vitest and Bun:

- `make install` first runs `make verify-root-overrides` (see [releases](releases.md)); `owned`, `contracts`, `stack` (a dedicated step before `npm ci`, plus the core fetch) and `publish.yml` verify pass the read-only job token as `GH_TOKEN` to those steps only, for non-legacy core tags. Hosted Linux and macOS runners ship a `gh` with `attestation`.
- `owned` initializes only `forks/pi` (core) before `make install`. The extensions load from
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
`subscription-router`, `preset`, `resource-sampler`, `todo` and `integration/inprocess`.
`test:bun` launches `bun --bun vitest run` through `scripts/run-vitest.ts` in a disposable
spawn-time home; `make check-ts` and both existing `owned` OS cells run it. Each invocation
prints engine/OS/package duration and exit status and appends it to the CI step summary.
The shared guard checks `os.homedir() === HOME` at setup, before each test and after each test,
failing with the offending file and an instruction to inject home directories. These are
boundary checks, not interception of transient mutations between boundaries.

Phase 2 #171 resolves the todo/subagents guard deferral from
[spec PR #170](https://github.com/nredd/pi-harness/pull/170), tracking
[#160](https://github.com/nredd/pi-harness/issues/160). Both Vitest configs now install the
shared guard and fixtures inject their homes instead of mutating `HOME`. Todo runs its full
390-test suite on Bun. Subagents keeps its native-scenario subset plus the guarded real-loader
gate; full Bun activation remains blocked by the unrelated workflow-runtime stack-line
failure [#174](https://github.com/nredd/pi-harness/issues/174). Its full Node suite is guarded.
No guard-related skip list or informational-only guard is used. See the current matrix,
boundary negative controls and package-addition procedure [here](verification-engines.md).
Python stays on pytest/uv/ruff/ty; dotfiles stays on dependency-free `node --test` as the
bootstrap exception. Istanbul consolidation is phase 3, not part of this producer change.

Toolchain: Node from `.node-version`, npm from `packageManager`, Bun from `.bun-version`, uv `0.13.1`
(Python from `.python-version` via uv). Every action is pinned to a commit SHA.

Required checks on `main`:

- `owned (ubuntu-24.04)` and `owned (macos-14)`
- `contracts (ubuntu-24.04)` and `contracts (macos-14)`
- `stack (ubuntu-24.04, personal)`, `stack (ubuntu-24.04, local)`, `stack (macos-14, personal)` and `stack (macos-14, local)`

Migration required, not applied by this PR:

- Remove the retired `wsl2 (windows-2022)` context and add `owned (wsl2)`, `contracts (wsl2)`, `stack (wsl2, personal)` and `stack (wsl2, local)` only after their hosted runs pass.
- Preserve the existing eight native contexts. Until an authorized orchestrator updates the ruleset, the old WSL context stays pending and merge/promotion must remain blocked. No remote protection change is authorized here.
- The historical nine-context receipt remains in `scripts/tests/fixtures/merge-pr-135.json`, unchanged. Tests explicitly add synthetic replacement matrix records; they are not hosted execution evidence.

The historical nine jobs are the configured required checks of ruleset `main required checks` (id `25524267`, `integration_id` 15368 each); `Promote stack` reads them from `GET /repos/nredd/pi-harness/rules/branches/main`, then attests and releases `stack/<sha>` (`docs/stack-promotion.md`). `migration-review/standards` and
`migration-review/spec` are no longer required. Reviews are our process, not a CI gate:

- Run separate Standards + Spec reviews on the exact final HEAD; any HEAD change invalidates both
- `scripts/merge-pr.sh` is the tracked source; `scripts/merge_pr_checks.py` owns its read-only CI
  predicate. Invoke the helper from an exact reviewed checkout. It validates distinct reviewer IDs,
  exact final-report HEAD and axis, unresolved-revision errors, receipt posting and
  `--match-head-commit`. Each reviewer's **final assistant report** must begin with these literal
  lines (use `Axis: Spec` for the other axis), then its normal `Checked:` and `Findings:` sections:
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
- A zero-step completed/cancelled literal CI matrix placeholder (`owned`, `contracts`, `stack`)
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
  Any update for strict base freshness invalidates both reviews. Refresh the distribution copy
  only after that reviewed merge. This procedure does not authorize merging router PR135,
  publishing packages, or activating live configuration
- `forks.yml` is path-filtered and not a required protection check; when triggered, the remaining core Gitlink job must pass before merging

Flake policy (migration plan section 7):

- A new correctness failure blocks
- A documented, isolated flake may get ONE fresh rerun of the whole failed job, only when nothing else
  failed. The rerun must pass. Both attempts stay in the run's attempt history; name the flake in the PR
- Known timing-sensitive suites: session-kit `monitor` and `diff` reaping, dev-tools kill escalation,
  core `chord`/`durable` 5 s timeouts. They were green alone and flaky on a loaded laptop
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
The thirteen `DOTFILES` rows moved to dotfiles' implemented `pi-profile doctor`, not a distribution check. See
[here](../integration/README.md) for inputs, package sets and deliberate headless exclusions.

Tap and profile pin bumps require green CI on the candidate stack, not local `pi-harness-e2e make verify`.
A correctness failure blocks promotion; the existing one-fresh-whole-job-rerun policy applies unchanged.
`stack` still tests the released Homebrew-shaped Node bundle. Fork release `v1.3.0-nredd.7`
publishes the coding-agent and pi-tui npm tarballs, no standalone assets. Each OS's existing `stack (..., personal)` job also builds the exact
Gitlinked source using `.bun-version` (1.3.14), the official `scripts/build-binaries.sh`, and frozen
release model data with `build:offline`. It does not depend on a future standalone release, commit
binaries, or test a Node wrapper in place of the compiled executable.

Bun scope:

- Native execution on `macos-14` (darwin-arm64) and `ubuntu-24.04` (baseline linux-x64).
  Each job reuses one extracted official archive for both stacks, with independent installations
- `--runtime bun-standalone` skips only the seven marked auth dispatch/refresh cases from
  `integration/scenarios/test_auth_transport.py`: Bun ignores the `NODE_OPTIONS --import` redirect
  and egress/readiness preload in `harness/anthropic_mock.py`. The missing-preload refusal case runs
  on both runtimes. Skip reasons appear in pytest and JUnit before fake auth fixtures can dispatch
- No other selected D/E case uses preloads, scaled timers or `--expose-gc`. Clock-driven behavior
  moved to native suites. `providers/fast_timers.mjs` is no longer used by selected D/E scenarios;
  `harness/probe.py`'s `--expose-gc` is used only by excluded `scenarios/bench/test_render.py`
- The adapter blocker is [here](https://github.com/nredd/pi-harness/issues/14). Previous references
  to #58 are stale: no such issue exists in this repository. The timer migration removed one
  dependency, not the remaining auth transport interception requirement
- NOT RUN: linux-arm64 (no `ubuntu-24.04-arm` job added), darwin-x64, Windows, packed contracts
  hosted by the standalone, quiet-runner benchmarks, live credentials, REA and desktop/TCC helpers.
  Source-built D/E coverage is not published-binary acceptance or a completed Bun checklist

Capacity: four WSL matrix cells replace one old WSL job, adding three Windows-hosted admissions and zero macOS jobs. Full CI still requests four macOS jobs,
not six. The existing `stack (..., personal)` runner builds once and runs both standalone stacks
serially with two pytest workers; `stack (..., local)` adds no work. No build producer, artifact
transfer or extra queue admission. Budget an additional 7-12 minutes on macOS personal and 5-9 minutes
on Ubuntu personal (12-21 added runner minutes total); local cells add zero. These are estimates until
CI measurements, not promised runtimes. Stack timeouts are 40 minutes. Linux ARM64 is omitted to avoid
another build and two stack installs while establishing both current OS targets. The native required
checks are unchanged; Bun failures fail their personal stack check. WSL required-check migration is described above.

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
