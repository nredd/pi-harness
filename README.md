# Pi harness

Development home for independently versioned Pi plugins, an optional preset, integration tests,
benchmarks, and exact-stack release tooling. Upstream forks retain their histories as submodules.

Migration is in progress. There is no supported release or installer yet. The existing installation
remains authoritative until the standalone Bun stack passes verification and is explicitly activated.

See [the migration plan](docs/migration-plan.md) for scope, acceptance criteria, and rollout policy.
Every migration PR requires separate Standards and Spec reviewer subagents against its final HEAD,
including documentation, fork, dotfiles, and automated promotion changes.

Layout:

- `packages/`: independently versioned plugins and optional preset.
- `forks/`: exact upstream-fork source commits (submodules), with their native build systems. See
  [fork ownership](docs/forks.md).
- `integration/inprocess/`: private `A-stack` workspace, real extension pairs on core's harness, Vitest + Bun.
- `integration/scenarios/`: remaining E2E scenarios, including the existing performance gates.
- `benchmarks/comparison/`: historical comparison experiments and annotated results.
- `scripts/`: build, release, and chezmoi integration implementation.
- `docs/`: development, source provenance, release, and recovery documentation.

`packages/preset` (`@nredd/pi-preset` `0.1.0`, published) is the optional opinionated
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

Packages build and test against the core fork's `v1.3.0-nredd.5` release tarballs (root `overrides`
plus each package's `devDependencies`), the host that ships `@earendil-works/pi-coding-agent/testing` and
`/testing/interactive`.
Stock Pi compatibility is `make check-package-contracts`' job, not the unit gate's.

`integration/inprocess/` needs `git submodule update --init forks/pi-subagents forks/pi-plan-mode
forks/rpiv-todo` before `make install`. Keep fork-local `node_modules/` absent: the stack loader
refuses a second host copy. Its API and coverage are in [CI](docs/ci.md).

Development (Node with npm workspaces, `uv`, Git, macOS or Linux; the benchmark is macOS-only):

```sh
make install               # npm ci --ignore-scripts; uv sync --locked (integration, benchmark)
make check                 # owned-code gates, see below
make bootstrap-forks       # init/update fork submodules; refuses if any initialized fork is dirty
make bootstrap-forks-check # preflight only
make check-package-contracts # explicit: real tarballs through stock Pi 1.3.0, see docs/package-contracts.md
make check-fork-package-contracts # explicit: real packed preset/dev-tools via the selected pi-subagents fork, same doc
```

`make check` runs, without rewriting files:

- `check-ts`: Biome, `tsc --noEmit`, Vitest for `packages/*`, plus the private
  `integration/inprocess/` stack suite under Vitest and Bun (published packages:
  `@nredd/pi-dev-tools@0.4.0`, `@nredd/pi-session-kit@0.3.0`,
  `@nredd/pi-subscription-router@0.3.0`, `@nredd/pi-preset@0.1.0`)
- `check-scripts`: ruff, ty, pytest for `scripts/` (real disposable git repositories), then `check-import-audit`
- `check-import-audit`: Biome, strict `tsc` and `node --test` for `scripts/import_audit.ts`, the package-contract
  import parser (installed TypeScript 7 `unstable/sync` API; real parses, no mocks)
- `check-integration`: ruff, ty, unit tests for `integration/`, then `check-probes`
- `check-probes`: Biome and strict `tsc` for `integration/probes/process-lifecycle.test.ts` (real
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

`make check-fork-package-contracts` is the optional-integration counterpart, also outside `make check`.
It needs an initialized, clean `forks/pi-subagents` at exactly its Gitlink (it refuses, changing
nothing, otherwise; run `make bootstrap-forks` yourself) and the npm registry for the stock Pi and the
fork's two locked runtime dependencies, which are installed into a disposable archive of the fork
commit, never into `forks/`. See [package contracts](docs/package-contracts.md).

`make check` is the owned-code unit gate *only*. It does not run fork gates (use each fork's native
tooling, see [forks.md](docs/forks.md)), the integration scenarios (`make verify-fast`/`verify` in
`integration/`, which need pi, tmux, and sandbox state), or any
candidate/full-stack verification. No such gate exists yet.

`bootstrap-forks` discovers submodules from the index and checks every initialized one (nested
included) for tracked, staged, and untracked changes before running
`git submodule update --init --recursive`. On any dirt it exits 1 having changed nothing; it never
forces, cleans, or discards. Exit 2 is a git or usage error.

Distribution policy:

- Publish reusable plugins separately from tested stack releases.
- Require standalone Bun verification on macOS ARM64 and Linux ARM64/x64.
- Keep credentials, enterprise endpoints, and machine policy outside public artifacts.
- Make `chezmoi update` stage only; activate explicitly through chezmoi after closing Pi sessions.
- Preserve auth, sessions, memory, trust state, local manifests, and modified user resources.

These are migration requirements, not claims that the distribution already implements them.
