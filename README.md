# Pi harness

Development home for independently versioned Pi plugins, an optional preset, integration tests,
benchmarks, and exact-stack release tooling. The Pi core retains its upstream history as a submodule; extension packages are imported workspaces.

- Owned npm packages ship through `publish.yml`; core ships through `nredd/tap/pi-coding-agent`.
- Dotfiles selects pins and applies them with `chezmoi update --upgrade`; require `pi-profile doctor`
  after activation.
- Anyone else installs a promoted, attested `stack/<sha>` with one `uvx` command, no dotfiles or GitHub
  login: [install](docs/install.md). macOS arm64 and Linux x86-64 only. The hardened installer requires
  both attested snapshot and complete runtime graph assets; old snapshot-only promotions are unsupported.
  Source-selected npm locks replay offline with scripts disabled: [details](docs/runtime-locks.md).
- CI builds the Bun standalone from the Gitlinked core and runs the stack D/E scenarios on it on darwin-arm64 (`local`
  only) and linux-x64; auth interception runs through the `BUN_OPTIONS` preload adapter, no skips. linux-arm64 is NOT RUN. Details [here](docs/bun-prerequisite.md).
- CI also runs the owned gates and packed contracts on a hosted `windows-2025` runner inside verified Ubuntu WSL2, after
  copying the checkout from the mounted Windows drive to WSL's Linux filesystem: on `main`, and on PRs that change CI or
  WSL inputs. No stack runs in WSL. Coverage and exclusions: [CI](docs/ci.md).

Current status is [here](PLAN.md); the original migration plan and its superseded requirements are
[here](docs/migration-plan.md). Primary owned-source coverage enforcement is enabled through
`coverage/policy.json`; its eligible packages are documented in [coverage](docs/coverage.md), and no
package has a per-file or per-OS allowance. Bun signals are enforced at 0/0 for `plan-mode`, `preset`,
`resource-sampler`, `subscription-router` and `todo`; the other Bun compatibility signals remain report-only.
Every migration PR requires separate Standards and Spec reviewer subagents against its final HEAD,
including documentation, fork, dotfiles, and automated promotion changes.

The subscription router's `/router resets [refresh]` shows cached provider replenishment schedules
and an official free Codex reset handoff. Offer discovery/redemption are not integrated in Pi;
contract evidence and the staged safety design are [here](packages/subscription-router/README.md#reset-schedules-and-free-codex-resets).

`packages/resource-sampler` is the Pi-independent `@nredd/pi-resource-sampler` ESM library for
bounded, privacy-safe interval host sampling. It has no Pi entrypoint or runtime dependencies.
Its [README](packages/resource-sampler/README.md) defines CPU/coverage semantics and Darwin's
explicit process-CPU precision limitation. Releases are recorded in [releases](docs/releases.md); no
consumer migration is included.

Layout:

- `packages/`: independently versioned plugins and optional preset, including imported `@nredd/pi-computer-use`. Its packed contract proves stock-Pi loading and the model-visible tool surface; native desktop behavior is explicitly NOT RUN without an interactive macOS TCC-granted session.
- `forks/pi`: exact upstream core source commit (submodule), with its native build system. See
  [fork ownership](docs/forks.md).
- `integration/core-source/`: source-candidate direct/routed child compaction verification, run by `make check-core-compaction` and `Forks` CI, separate from the release host. Policy [here](docs/compaction-policy.md); coordinated release preparation and admission blockers [here](docs/core-release-train.md).
- `integration/inprocess/`: private `A-stack` scenarios on core's real harness, Vitest + Bun: Plan/todos, goals/loops, subagent delivery, router quota/admission. Assertion destinations and clock boundaries: [here](docs/verification-rebuild.md).
- `integration/scenarios/`: retained process/terminal boundaries, opt-in live checks and benchmarks.
  CI runs D/E; bench F is NOT RUN and live G is never CI. No unported non-boundary scenarios remain.
- `benchmarks/comparison/`: historical comparison experiments and annotated results.
- `scripts/`: build, release, and chezmoi integration implementation.
- `docs/`: development, source provenance, release, and recovery documentation.

`packages/todo` (`@nredd/pi-todo` `2.13.10`, pending its first CI-attested release) imports the maintained rpiv-todo fork as an independently releasable plugin. It registers the persistent `todo` tool, `/todos`, and task overlay; the imported source keeps its upstream license and uses the package's native check.

`packages/preset` (`@nredd/pi-preset` `0.2.0`, published) is the optional opinionated
preset with agents, skills, footer, themes, and public-safe defaults. It is a resource snapshot only: no
installer or activation, model roles and enterprise acceptance are pending, and its themes carry
their own licenses. See [its README](packages/preset/README.md) and
[NOTICE](packages/preset/NOTICE.md).

Imported sources and every deliberate sanitization: [source provenance](docs/source-provenance.md).
Standalone Bun evidence and limits: [Bun prerequisite](docs/bun-prerequisite.md).
Packed-package independence against exact stock Pi: [package contracts](docs/package-contracts.md).
Where every e2e scenario moves in the verification rebuild: [verification rebuild](docs/verification-rebuild.md).
What CI runs, what it does not, and the flake policy: [CI](docs/ci.md).

Validated development toolchain: Node `26.12.0` (`.node-version`), Python `3.13.15`
(`.python-version`), Bun `1.4.4` (`.bun-version`; upgrade evidence [here](docs/bun-upgrade.md)), npm `11.20.0` (`packageManager`), uv `0.13.1`.
Fork build toolchains are separate, see [forks.md](docs/forks.md).

Packages build and test against the core fork's `v1.3.0-nredd.10` coding-agent/TUI release tarballs (root `overrides`
plus each package's `devDependencies`), the host that ships `@earendil-works/pi-coding-agent/testing` and
`/testing/interactive`.
Stock Pi compatibility is `make check-package-contracts`' job, not the unit gate's.

`integration/inprocess/` loads `packages/{subagents,plan-mode,todo}`. Keep package-local
`node_modules/` host copies absent: the stack loader refuses a second host copy. Its API and coverage are in [CI](docs/ci.md).

Development (Node with npm workspaces, `uv`, Git, macOS or Linux; the benchmark is macOS-only):

```sh
make install               # make install-owned (verify root core overrides with stdlib python3, npm ci --ignore-scripts, uv sync --locked), then make install-benchmark
make check                 # owned-code gates, see below
make check-package-contracts # explicit: real tarballs through stock Pi 1.3.0, see docs/package-contracts.md
make check-todo-package-contract # explicit: packed todo tool through stock Pi 1.3.0
```

On macOS, keep the host awake for the entire gate, e.g. `/usr/bin/caffeinate -is make check`
on AC power. The assertion ends with the command and does not change power settings. Check
current CPU/memory pressure and concurrent builds before starting; a low load average alone
is not enough. Closed-lid maintenance sleep can suspend lifecycle timers for seconds or minutes,
so check `powerd` sleep/wake logs when real-time assertions overrun. Do not relax their deadlines.

`make check` runs, without rewriting files:

- `check-ts`: Biome, `tsc --noEmit`, Vitest for `packages/*`, plus the private
  `integration/inprocess/` stack suite under Vitest and Bun. The gate appends `$HOME/.pi/agent/bin` to
  its child `PATH` so a Pi-provisioned `fd` is available without shell setup; otherwise install `fd`
  on `PATH` as in CI. It does not download `fd` (published packages:
  `@nredd/pi-dev-tools@0.5.1`, `@nredd/pi-session-kit@0.7.0`,
  `@nredd/pi-subscription-router@0.4.0`, `@nredd/pi-preset@0.2.0`; `@nredd/pi-todo@2.13.10` is pending its first CI-attested release)
- `check-scripts`: ruff, ty, pytest for `scripts/` (real disposable git repositories), then `check-import-audit`. Git ignores
  coverage.py's `.coverage` and parallel `.coverage.*` data files
- `check-import-audit`: Biome, strict `tsc` and Vitest (V8 coverage, `scripts/vitest.config.ts`) for `scripts/import_audit.ts`, the package-contract
  import parser (installed TypeScript 7 `unstable/sync` API; real parses, the only mock forces a project lookup miss), plus the
  root `scripts/run-vitest.ts` launcher, `scripts/check-biome-paths.mjs` preflight and `scripts/router_contract.mjs` fixture, all enforced at 0/0
- `check-integration`: ruff, ty, unit tests for `integration/` (needs `tmux`: the live-session drivers run against a stub pi on private servers), then `check-probes` and `check-providers`
- `check-probes`: Biome and strict `tsc` for every `integration/probes` source and test (real `dev-tools` and
  `session-kit` runner sources; Biome only for `anthropic-block-types.mjs`), then Vitest with V8 coverage over
  `anthropic-block-types.mjs`, `latency.ts`, `render.ts`, `session-kit-child-scope.ts`, `stack-resources.ts` and
  `transcript-types.ts`, enforced at 0/0, on the config's explicit test files (no glob, `integration/probes/vitest.config.ts`)
- `check-providers`: Biome, strict `tsc` and Vitest (V8 coverage, `integration/providers/vitest.config.ts`) for the
  synthetic providers (`faux.ts`, `usage_fixture.ts`, `extension_inventory.ts`) and the auth preloads (`redirect_anthropic.mjs`,
  `auth_guard.mjs`, `auth_transport.mjs`, `auth_runtime_fixture.mjs`), against recording registries and a loopback mock, enforced at 0/0
- `check-benchmark`: ruff, ty, all unit tests with the 100% statement and branch coverage threshold for
  `benchmarks/comparison`, including the `native_runtime` Codex sandbox test (see below), writing the
  `python-benchmarks` LCOV for `check-coverage`

The `native_runtime` test runs the real Codex sandbox, so `check-benchmark` needs exactly
`@openai/codex@0.154.0` (the historical benchmark pin) first on `PATH`, on macOS (Seatbelt). It
fails, never skips, otherwise. Install it outside the repo, no global replacement:

```sh
npm install --ignore-scripts --prefix ~/code/pi-harness-builds/tools/codex-0.154.0 @openai/codex@0.154.0
T=$(mktemp -d); mkdir "$T/codex" "$T/cache"   # keep real Codex config/auth out of the test
CODEX_HOME="$T/codex" XDG_CACHE_HOME="$T/cache" \
  PATH="$HOME/code/pi-harness-builds/tools/codex-0.154.0/node_modules/.bin:$PATH" make check-benchmark
```

The package has no install scripts; the native binary comes from the `@openai/codex-darwin-arm64`
optional dependency. No credentials or model calls are used: only `codex sandbox` runs.

`make check-package-contracts` is deliberately not part of `make check`: it installs exact stock Pi
from the npm registry on first use and runs real Pi processes. Its tooling is unit tested in
`check-scripts`. A pass says nothing about the Bun candidate or the full stack.

`make check` is the owned-code unit gate *only*. Forks use their native gates, see
[forks.md](docs/forks.md). Audit the root lockfile with
`npm audit --package-lock-only --omit=dev --json` and investigate every reported chain. Never run
an unguarded `npm audit fix`: package sources and their exact test-host pins are deliberate. Keep
compatible transitive repairs in `package-lock.json`; use `--ignore-scripts --legacy-peer-deps` only
while resolving the lock and restore every manifest before committing. The CI `stack` matrix is the assembled gate for tap/profile pin bumps:
exact Gitlinked core release, `integration/stacks/{personal,local}.json`, real `pi install`,
throwaway HOME/agent directories, D boundaries and the one E tmux resize seam. It replaces local
`pi-harness-e2e make verify`; no owner config or installed package state is read. Inputs and
headless exclusions are documented [here](integration/README.md). Bench remains visibly NOT RUN
until a quiet runner exists, and Bun auth interception remains unfinished.

Distribution policy:

- Publish reusable plugins independently; gate pin promotion with the matching CI `stack` jobs.
- Standalone Bun verification: macOS ARM64 and Linux x64 run in CI (stack D/E, minus auth interception); Linux ARM64 is NOT RUN.
- Keep credentials, enterprise endpoints, and machine policy outside public artifacts.
- Activate managed pins with `chezmoi update --upgrade`, then require `pi-profile doctor` and restart
  Pi sessions. Updates do not stage a separate runtime for later transactional activation.
- The original staging, rollback and state-preservation acceptance requirements are not implemented
  as a distribution transaction. Current scope and deferred work are [here](PLAN.md).
