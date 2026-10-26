# CI

CI is the gate. Local runs are for development. Hosted runners only, no stored credentials or secrets.
The publish job alone requests a short-lived npm OIDC identity.

`.github/workflows/ci.yml`, every PR and `main`:

| Job | Normal PR | `main` push | Docs-only PR or push | Proves |
| --- | --- | --- | --- | --- |
| `owned (ubuntu-24.04, macos-14)` | `make install`, `make check-ts check-scripts check-integration`; `make check-benchmark` on macOS only. `cargo-nextest` is installed so dev-tools' real cargo suite runs instead of skipping | Same | Reports success after the classifier logs the bypass | Biome, tsc and each package's Vitest suite and declared `test:bun` suite (preset runs all of `test/`; a notice names every package without `test:bun`, as NOT RUN), `scripts/` and `integration/` unit gates. `check-benchmark`'s `native_runtime` test needs Seatbelt, so Linux reports it NOT RUN. See the computer-use note below. |
| `contracts (ubuntu-24.04, macos-14)` | `make check-package-contracts` (includes the packed preset audit + install), `make check-plan-mode-package-contract`, `make check-subagents-package-contract`, `make check-todo-package-contract`, `make check-computer-use-package-contract` | Same | Reports success after the classifier logs the bypass | Packed tarballs alone on exact stock Pi 1.3.0 (dev-tools with its exact `@nredd/pi-resource-sampler` from the registry, integrity checked against `npm view`, real parent-child discovery by that installed sampler's full scan, and a bounded `resource_snapshot`), the packed preset audited and installed alone, and the packed `@nredd/pi-subagents` with `croner`/`nanoid` from the registry plus one faux `Agent` call (the same gate the release `verify` runs, so a PR proves it before a tag does). The packed `@nredd/pi-todo` with `@juicesharp/rpiv-config`/`rpiv-i18n` from the registry plus one faux `todo` create. The packed `@nredd/pi-computer-use` through the platform-aware tool set (13 tools on macOS, 11 on Linux) plus Mach-O arch/mode checks of both prebuilt helpers; its `postinstall` and every desktop tool are NOT RUN. JSON reports uploaded as artifacts |
| `stack (ubuntu-24.04, macos-14; personal, local)` | Node release-bundle D/E scenarios in each cell; each personal cell also builds the core Gitlink with Bun and runs standalone D/E for both stacks | Only `stack (ubuntu-24.04, personal)` runs, including both standalone stacks; the other three required job names log the selective smoke | Every cell reports success after the classifier logs the bypass | Node release bundle plus source-built linux-x64/darwin-arm64 standalone, independent stack installations, startup/transport/lifetime/output/tool surfaces and tmux resize; seven Node-preload auth cases per standalone stack explicitly skip, missing-preload refusal runs. Separate Node/Bun JUnit and failure artifacts, stack identities and binary/archive SHA-256 retained. Computer-use helper explicitly excluded |
| `bench (not run)` | a notice and a step summary | Same | Same | Nothing. No quiet self-hosted runner exists yet (migration plan section 7) |

On the `owned` job, `@nredd/pi-computer-use`'s macOS-only checks (`test:invariants` INV-8/INV-17, `test:macos-native`, `test:desktop`'s helper wire mapping and gating, `test:macos-live`) print `NOT RUN` lines on Linux and are not passes. Conversely, `test:linux-native` runs headless on the Ubuntu cell only (`NOT RUN` on macOS): the crate's `cargo test --locked`, a source build from the *packed* tarball into a user-cache target dir, the built x64 helper's real `diagnostics` (protocol 4, shared architecture invariants), the cargo-missing hint and compiler cleanup on `SIGTERM`. The aarch64 target (`rustup target add`) is `cargo check --locked` compile-only; ARM64 runtime, WSL, desktop/display and live UI are NOT RUN. This is coverage inside the existing `owned` job, not a new required check (`test:linux-native` prints `Linux native checks passed` on Ubuntu, `NOT RUN` on macOS.)

The resource sampler's package gate runs real host sampling and bounded helper cleanup in each
`owned` OS cell. `check-package-contracts` also builds/audits/installs its exact ESM tarball and
runs an isolated Node consumer in each `contracts` OS cell. This library has no Pi entrypoint;
Darwin process CPU is explicitly unavailable because `ps` start identity has one-second precision.
No consumer migration, publication, extra CI job or runner is added.

## Capacity controls

`classify changed paths` compares the pull request base and head, or the pre-push and pushed `main` revisions, with real Git. It never path-filters a required job: all eight required matrix jobs and `wsl2 (windows-2022)` start and report a terminal status. A docs-only change skips their expensive steps, and every skipped job writes a notice plus a step summary containing the changed-file list. Each job's `plan` step emits `run=true` or `run=false`, logs the changed files when bypassing, and gates every checkout-dependent step on `steps.plan.outputs.run`. `always()` cleanup and artifact steps, plus failure and cancellation conditions, remain in those step predicates.

The allowed docs-only paths are Markdown under `docs/`, root Markdown, `PLAN.md`, and a package-root `README.md` or `CHANGELOG.md`. The classifier is deliberately narrower than "all Markdown": workflow files, manifests, lockfiles, Gitlinks, `integration/**`, `scripts/**`, and `releases/*.json` are code because they do not match an allowed path. It also treats root `README.md` and `packages/preset/README.md` as code because repository tests read their text. A mixed change is code.

The 2026-10-20 capacity measurement found median final-head PR latency of 11m45s, p95 queue waits of 22m37s on macOS and 19m56s on Ubuntu, and four macOS jobs in each full run against five hosted macOS slots. A docs-only `PLAN.md` PR alone consumed 100.25 runner-minutes across 18 stack executions. Bypassing that work reduces real contention without leaving a protected check pending.

`main` still validates the merged result: both `owned` and `contracts` OS cells plus `stack (ubuntu-24.04, personal)` run. The other three stack cells report the selective smoke rather than repeating work that a strict PR head already ran. This keeps one end-to-end merged-tree check while removing the most redundant post-merge macOS demand. The same measurement found six explicit update-branch CI runs plus one Forks run used 180.07 assigned runner-minutes; full main-push workflows used 599.13 assigned runner-minutes, including 334.02 macOS minutes. Those are upper bounds, not promised savings, and this policy preserves the higher-value merged-result coverage.

The required checks live in ruleset `main required checks` (id `25524267`, not classic branch protection), which remains `strict`. Strict means that advancing `main` invalidates a PR's previous green result and requires an update-branch rerun before merge. That cost is intentional for combined-result safety; docs-only bypasses make documentation updates cheaper without weakening it.

`.github/workflows/wsl2.yml`, every PR and `main` push:

| Job | Runs | Proves |
| --- | --- | --- |
| `wsl2 (windows-2022)` | One `windows-2022` host with `Ubuntu-24.04` explicitly verified as WSL version 2. The Windows checkout is copied from `/mnt/...` to a non-`drvfs` WSL filesystem before executing the existing release fetcher and personal-stack D/E pytest entrypoint. | Real Node release-bundle Pi startup, text/JSON/RPC and extension discovery, installed personal-stack integration, process lifetime/output/auth seams, and the tmux footer resize boundary under WSL2. Bun is installed at the repository's pinned `1.3.14` only to keep the WSL toolchain identity aligned; this job does not run standalone Bun scenarios. |

Root core overrides: before the WSL `npm ci`, the job installs the pinned official GitHub CLI with `scripts/install_gh_linux.sh` and runs `harness.release --verify-root-overrides`. Ubuntu 24.04's apt `gh` is 2.45 and has no `attestation` command, and the later `harness.release --gitlink` fetch of a non-legacy core tag needs it too. The script downloads `gh_2.103.2_linux_amd64.tar.gz` from the immutable `cli/cli` release, refuses anything but the pinned sha256 (`62ccf747115ddc61237efffdde66a3c8f70ba249433dc64f70801089b59c59c8`, confirmed with `gh release verify-asset v2.103.2 gh_2.103.2_linux_amd64.tar.gz --repo cli/cli`), and checks `attestation` exists. Bump the version and digest together after repeating that verification. `setup-wsl` does not forward Windows environment, so the step sets `GH_TOKEN: ${{ github.token }}` (read-only `contents: read`) with `WSLENV: GH_TOKEN/u`. The token is never written to a file or echoed. The CLI bootstrap, `npm ci` and `uv sync` run with `env -u GH_TOKEN`; verification and the later core fetch retain it. The script `unset`s it right after the core fetch, before any scenario runs. `python3` is installed via `additional-packages`. The job stays a single WSL job on the Linux filesystem.

The job has no docs-only bypass: unavailable WSL, a non-version-2 distribution, a mounted Windows worktree, bootstrap failure, or any scenario failure fails it. Its always-running `wsl2-diagnostics` artifact retains the JUnit result, harness-generated synthetic failure artifacts, and explicit WSL/Pi/Gitlink identities outside the disposable Linux worktree. A pre-created status file makes an early failure explicit; preservation and cleanup warn without replacing the original harness status. It uploads neither arbitrary worktree files nor command/environment logs, so no credentials or runner state are dumped. It does not test the local stack, standalone binaries, macOS, Linux ARM64, packed contracts, benchmarks, live credentials, REA, or desktop/TCC helpers. It is deliberately one serial Windows-hosted execution rather than another broad OS/stack matrix. Its stable check name is a candidate for protection only after independent review and a native WSL2 green run; this PR does not change rulesets.

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
- `isolateStackHome()` isolates `HOME`, `PI_CODING_AGENT_DIR`, XDG config before loading entries.
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

Toolchain: Node from `.node-version`, npm from `packageManager`, Bun from `.bun-version`, uv `0.13.1`
(Python from `.python-version` via uv). Every action is pinned to a commit SHA.

Required checks on `main`:

- `owned (ubuntu-24.04)` and `owned (macos-14)`
- `contracts (ubuntu-24.04)` and `contracts (macos-14)`
- `stack (ubuntu-24.04, personal)`, `stack (ubuntu-24.04, local)`, `stack (macos-14, personal)` and `stack (macos-14, local)`

- `wsl2 (windows-2022)` from `.github/workflows/wsl2.yml`

These nine jobs are the required checks of ruleset `main required checks` (id `25524267`, `integration_id` 15368 each); `Promote stack` reads them from `GET /repos/nredd/pi-harness/rules/branches/main`, then attests and releases `stack/<sha>` (`docs/stack-promotion.md`). `migration-review/standards` and
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
  PR/head/base (including repository identity), Actions app and SHA. All eight expected expanded
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

Capacity: ZERO added jobs, including zero new macOS jobs. Full CI still requests four macOS jobs,
not six. The existing `stack (..., personal)` runner builds once and runs both standalone stacks
serially with two pytest workers; `stack (..., local)` adds no work. No build producer, artifact
transfer or extra queue admission. Budget an additional 7-12 minutes on macOS personal and 5-9 minutes
on Ubuntu personal (12-21 added runner minutes total); local cells add zero. These are estimates until
CI measurements, not promised runtimes. Stack timeouts are 40 minutes. Linux ARM64 is omitted to avoid
another build and two stack installs while establishing both current OS targets. The ruleset's required
checks are unchanged; Bun failures now fail the existing personal stack check, not a new required context.

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
