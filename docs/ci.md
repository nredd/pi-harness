# CI

CI is the gate. Local runs are for development. Hosted runners only, no stored credentials or secrets.
The publish job alone requests a short-lived npm OIDC identity.

`.github/workflows/ci.yml`, every PR and `main`:

| Job | Normal PR | `main` push | Docs-only PR or push | Proves |
| --- | --- | --- | --- | --- |
| `owned (ubuntu-24.04, macos-14)` | `make install`, `make check-ts check-scripts check-integration`; `make check-benchmark` on macOS only. `cargo-nextest` is installed so dev-tools' real cargo suite runs instead of skipping | Same | Reports success after the classifier logs the bypass | Biome, tsc and each package's Vitest suite and declared `test:bun` suite (preset runs all of `test/`; a notice names every package without `test:bun`, as NOT RUN), `scripts/` and `integration/` unit gates. `check-benchmark`'s `native_runtime` test needs Seatbelt, so Linux reports it NOT RUN |
| `contracts (ubuntu-24.04, macos-14)` | `make check-package-contracts`, `make check-fork-package-contracts` | Same | Reports success after the classifier logs the bypass | Packed tarballs alone on exact stock Pi 1.3.0, and the packed preset + dev-tools through the Gitlinked `pi-subagents`. JSON reports uploaded as artifacts |
| `stack (ubuntu-24.04, macos-14; personal, local)` | Node release-bundle D/E scenarios in each cell; each personal cell also builds the Gitlinked core with Bun and runs standalone D/E for both stacks | Only `stack (ubuntu-24.04, personal)` runs, including both standalone stacks; the other three required job names log the selective smoke | Every cell reports success after the classifier logs the bypass | Node release bundle plus source-built linux-x64/darwin-arm64 standalone, independent stack installations, startup/transport/lifetime/output/tool surfaces and tmux resize; seven Node-preload auth cases per standalone stack explicitly skip, missing-preload refusal runs. Separate Node/Bun JUnit and failure artifacts, stack identities and binary/archive SHA-256 retained. Computer-use helper explicitly excluded |
| `bench (not run)` | a notice and a step summary | Same | Same | Nothing. No quiet self-hosted runner exists yet (migration plan section 7) |

## Capacity controls

`classify changed paths` compares the pull request base and head, or the pre-push and pushed `main` revisions, with real Git. It never path-filters a required job: all eight required matrix jobs start and report a terminal status. A docs-only change skips their expensive steps, and every skipped job writes a notice plus a step summary containing the changed-file list. Each job's `plan` step emits `run=true` or `run=false`, logs the changed files when bypassing, and gates every checkout-dependent step on `steps.plan.outputs.run`. `always()` cleanup and artifact steps, plus failure and cancellation conditions, remain in those step predicates.

The allowed docs-only paths are Markdown under `docs/`, root Markdown, `PLAN.md`, and a package-root `README.md` or `CHANGELOG.md`. The classifier is deliberately narrower than "all Markdown": workflow files, manifests, lockfiles, Gitlinks, `integration/**`, `scripts/**`, and `releases/*.json` are code because they do not match an allowed path. It also treats root `README.md` and `packages/preset/README.md` as code because repository tests read their text. A mixed change is code.

The 2026-10-20 capacity measurement found median final-head PR latency of 11m45s, p95 queue waits of 22m37s on macOS and 19m56s on Ubuntu, and four macOS jobs in each full run against five hosted macOS slots. A docs-only `PLAN.md` PR alone consumed 100.25 runner-minutes across 18 stack executions. Bypassing that work reduces real contention without leaving a protected check pending.

`main` still validates the merged result: both `owned` and `contracts` OS cells plus `stack (ubuntu-24.04, personal)` run. The other three stack cells report the selective smoke rather than repeating work that a strict PR head already ran. This keeps one end-to-end merged-tree check while removing the most redundant post-merge macOS demand. The same measurement found six explicit update-branch CI runs plus one Forks run used 180.07 assigned runner-minutes; full main-push workflows used 599.13 assigned runner-minutes, including 334.02 macOS minutes. Those are upper bounds, not promised savings, and this policy preserves the higher-value merged-result coverage.

`main` protection remains `strict: true`. Strict means that advancing `main` invalidates a PR's previous green result and requires an update-branch rerun before merge. That cost is intentional for combined-result safety; docs-only bypasses make documentation updates cheaper without weakening it.

`.github/workflows/forks.yml`, when `forks/**`, `.gitmodules` or the workflow changes, plus manual dispatch:

| Job | Runs |
| --- | --- |
| `core (forks/pi)` | `npm ci`, the release's model data restored from npm `@earendil-works/pi-ai@<version>` (never the live fetch), `npm run build:offline`, the steps of the fork's `check` with Biome check-only (the step fails if the fork's `check` list changes), the env daemon, `./test.sh` |
| `pi-subagents` | Pinned Bun, `npm ci`, `npm run check` (full Vitest suite and Bun session scenarios) |
| `pi-plan-mode` | Pinned Bun, `npm ci`, `npm run check` (Bun session scenarios), `npm test` (full Vitest suite) |
| `pi-claude-auth` | pnpm at the fork's `packageManager`, `pnpm install --frozen-lockfile`, lint, build, test |
| `rpiv-todo` | Pinned Bun, `npm ci --ignore-scripts`, `npm run check` (Biome, strict TypeScript, full standalone Vitest suite and native Bun settled-row regressions) at the Gitlinked commit |
| `pi-computer-use (not run)` | a notice: pi-computer-use needs macOS TCC |

The rpiv-todo job needs the standalone gate that `v2.13.9-nredd.2` (nredd/rpiv-todo#2) added; an older
Gitlink has no lockfile or `check` script, so the job fails rather than reporting a false pass.

`integration/inprocess/`, the private `A-stack` workspace, runs in `check-ts` on Vitest and Bun:

- `owned` initializes `forks/pi-subagents`, `forks/pi-plan-mode`, `forks/rpiv-todo` at their Gitlinks
  before `make install`. No fork-local `npm ci`, no fork-local `node_modules/`
- `support.ts`: `startStack({ cwd?, factories, settings?, sessionManager?, useModelRuntimeStream?, withConfiguredAuth?, mode?, ui? })` creates and
  binds core's real harness. `loadFork(name)` imports each fork's declared entry; `loadOwned(name)`
  imports the owned plugin's `src/index.ts`. Direct `createXxx()` factories work too
- Before importing a fork, resolve `pi-coding-agent`, `pi-tui`, `pi-ai`, `typebox` from both directories
  and compare real paths. A mismatch or unresolvable entry fails with the fork's `node_modules/`
  deletion path. Node uses import conditions on `createRequire().resolve`; Bun uses
  `import.meta.resolve` with an explicit parent. No aliases or copied extension code
- Root workspace dependencies supply `croner` `10.0.1`, `nanoid` `5.1.16`, `pi-tui-kit` `0.65.5`
  from the forks' lockfiles. Root also anchors `nanoid` `5.1.16`: otherwise npm hoists PostCSS's
  `3.x` and leaves the fork's `5.x` unreachable inside the stack workspace. The `rpiv-todo`
  split's own lockfile serves only its `forks.yml` gate; the stack workspace never installs fork-local
  dependencies, so `rpiv-config` and optional peer `rpiv-i18n` are pinned here to the fork's `2.13.9`,
  with the same integrity as its lockfile
- `isolateStackHome()` isolates `HOME`, `PI_CODING_AGENT_DIR`, XDG config before loading entries.
  `plan-todos.test.ts` drives the real Plan/todo pair, canonical RPC chooser selections, core
  compaction with scripted summaries, file-backed dispose/reopen and legacy mode entries.
  `/todos` heading counts share the evidenced-batch test; no second process
- `goal-support.ts` shares one injected clock across the real kit, router and subagents factories,
  with credential-free usage snapshots and explicitly configured faux auth. Goal/Plan/todo,
  loop/Plan, child accounting, scheduled/busy/idle notices and quota park/refuse/resume tests
  run on the same host. The child runner loads the real kit itself. All assertion destinations
  and native timer boundaries live in the ledger: [here](verification-rebuild.md)

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

These eight jobs are the configured protection checks. `migration-review/standards` and
`migration-review/spec` are no longer required. Reviews are our process, not a CI gate:

- Run separate Standards + Spec reviews on the exact final HEAD; any HEAD change invalidates both
- `~/code/pi-harness-builds/merge-pr.sh` checks that HEAD, both transcripts and green CI, then posts
  the review receipt as a PR comment and merges. It does not post commit statuses
- `forks.yml` jobs are path-filtered, not required protection checks; when triggered, every applicable
  fork job must still pass before merging

Flake policy (migration plan section 7):

- A new correctness failure blocks
- A documented, isolated flake may get ONE fresh rerun of the whole failed job, only when nothing else
  failed. The rerun must pass. Both attempts stay in the run's attempt history; name the flake in the PR
- Known timing-sensitive suites: session-kit `monitor` and `diff` reaping, dev-tools kill escalation,
  core `chord`/`durable` 5 s timeouts. They were green alone and flaky on a loaded laptop
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
another build and two stack installs while establishing both current OS targets. Branch protection
is unchanged; Bun failures now fail the existing personal stack check, not a new required context.

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
