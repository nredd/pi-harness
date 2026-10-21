# Pi harness

Development home for independently versioned Pi plugins, an optional preset, integration tests,
benchmarks, and exact-stack release tooling. Upstream forks retain their histories as submodules.

- Owned npm packages ship through `publish.yml`; core ships through `nredd/tap/pi-coding-agent`.
- Dotfiles selects pins and applies them with `chezmoi update --upgrade`; require `pi-profile doctor`
  after activation. There is no staging/activation transaction or standalone distribution installer.
- CI builds the Bun standalone from the Gitlinked core and runs the stack D/E scenarios on it on darwin-arm64 and
  linux-x64; seven auth-interception cases are explicit skips. linux-arm64 is NOT RUN. Details [here](docs/bun-prerequisite.md).

Current status is [here](PLAN.md); the original migration plan and its superseded requirements are
[here](docs/migration-plan.md).
Every migration PR requires separate Standards and Spec reviewer subagents against its final HEAD,
including documentation, fork, dotfiles, and automated promotion changes.

Layout:

- `packages/`: independently versioned plugins and optional preset, including imported `@nredd/pi-computer-use`. Its packed contract proves stock-Pi loading and the model-visible tool surface; native desktop behavior is explicitly NOT RUN without an interactive macOS TCC-granted session.
- `forks/`: exact upstream-fork source commits (submodules), with their native build systems. See
  [fork ownership](docs/forks.md).
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
(`.python-version`), Bun `1.3.14` (`.bun-version`), npm `11.20.0` (`packageManager`), uv `0.13.1`.
Fork build toolchains are separate, see [forks.md](docs/forks.md).

Packages build and test against the core fork's `v1.3.0-nredd.7` coding-agent/TUI release tarballs (root `overrides`
plus each package's `devDependencies`), the host that ships `@earendil-works/pi-coding-agent/testing` and
`/testing/interactive`.
Stock Pi compatibility is `make check-package-contracts`' job, not the unit gate's.

`integration/inprocess/` loads `packages/{subagents,plan-mode,todo}`. Keep package-local
`node_modules/` host copies absent: the stack loader refuses a second host copy. Its API and coverage are in [CI](docs/ci.md).

Development (Node with npm workspaces, `uv`, Git, macOS or Linux; the benchmark is macOS-only):

```sh
make install               # npm ci --ignore-scripts; uv sync --locked (integration, benchmark)
make check                 # owned-code gates, see below
make bootstrap-forks       # init/update fork submodules; refuses if any initialized fork is dirty
make bootstrap-forks-check # preflight only
make check-package-contracts # explicit: real tarballs through stock Pi 1.3.0, see docs/package-contracts.md
make check-todo-package-contract # explicit: packed todo tool through stock Pi 1.3.0
```

`make check` runs, without rewriting files:

- `check-ts`: Biome, `tsc --noEmit`, Vitest for `packages/*`, plus the private
  `integration/inprocess/` stack suite under Vitest and Bun (published packages:
  `@nredd/pi-dev-tools@0.5.1`, `@nredd/pi-session-kit@0.6.0`,
  `@nredd/pi-subscription-router@0.4.0`, `@nredd/pi-preset@0.2.0`; `@nredd/pi-todo@2.13.10` is pending its first CI-attested release)
- `check-scripts`: ruff, ty, pytest for `scripts/` (real disposable git repositories), then `check-import-audit`
- `check-import-audit`: Biome, strict `tsc` and `node --test` for `scripts/import_audit.ts`, the package-contract
  import parser (installed TypeScript 7 `unstable/sync` API; real parses, no mocks)
- `check-integration`: ruff, ty, unit tests for `integration/`, then `check-probes`
- `check-probes`: Biome and strict `tsc` for `integration/probes/process-lifecycle.test.ts` and `stack-resources.ts` (real
  `dev-tools` and `session-kit` runner sources), then `node --test` on the explicit
  `transcript-types.test.ts` and `process-lifecycle.test.ts` (no glob; `todo-history.test.ts` is not in this gate)
- `check-benchmark`: ruff, ty, all unit tests with the 90% coverage threshold for
  `benchmarks/comparison`, including the `native_runtime` Codex sandbox test (see below)

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
[forks.md](docs/forks.md). The CI `stack` matrix is the assembled gate for tap/profile pin bumps:
exact Gitlinked core release, `integration/stacks/{personal,local}.json`, real `pi install`,
throwaway HOME/agent directories, D boundaries and the one E tmux resize seam. It replaces local
`pi-harness-e2e make verify`; no owner config or installed package state is read. Inputs and
headless exclusions are documented [here](integration/README.md). Bench remains visibly NOT RUN
until a quiet runner exists, and Bun auth interception remains unfinished.

`bootstrap-forks` discovers submodules from the index and checks every initialized one (nested
included) for tracked, staged, and untracked changes before running
`git submodule update --init --recursive`. On any dirt it exits 1 having changed nothing; it never
forces, cleans, or discards. Exit 2 is a git or usage error.

Distribution policy:

- Publish reusable plugins independently; gate pin promotion with the matching CI `stack` jobs.
- Standalone Bun verification: macOS ARM64 and Linux x64 run in CI (stack D/E, minus auth interception); Linux ARM64 is NOT RUN.
- Keep credentials, enterprise endpoints, and machine policy outside public artifacts.
- Activate managed pins with `chezmoi update --upgrade`, then require `pi-profile doctor` and restart
  Pi sessions. Updates do not stage a separate runtime for later transactional activation.
- The original staging, rollback and state-preservation acceptance requirements are not implemented
  as a distribution transaction. Current scope and deferred work are [here](PLAN.md).
