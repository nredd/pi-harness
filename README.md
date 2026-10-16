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
- `integration/`: E2E scenarios, including the existing performance gates.
- `benchmarks/comparison/`: historical comparison experiments and annotated results.
- `scripts/`: build, release, and chezmoi integration implementation.
- `docs/`: development, source provenance, release, and recovery documentation.

Imported sources and every deliberate sanitization: [source provenance](docs/source-provenance.md).
Standalone Bun evidence and limits: [Bun prerequisite](docs/bun-prerequisite.md).

Validated development toolchain: Node `26.12.0` (`.node-version`), Python `3.13.15`
(`.python-version`), Bun `1.3.14` (`.bun-version`), npm `11.20.0` (`packageManager`), uv `0.13.1`.
Fork build toolchains are separate, see [forks.md](docs/forks.md).

Development (Node with npm workspaces, `uv`, Git, macOS or Linux; the benchmark is macOS-only):

```sh
make install               # npm ci --ignore-scripts; uv sync --locked (integration, benchmark)
make check                 # owned-code gates, see below
make bootstrap-forks       # init/update fork submodules; refuses if any initialized fork is dirty
make bootstrap-forks-check # preflight only
```

`make check` runs, without rewriting files:

- `check-ts`: Biome, `tsc --noEmit`, Vitest for `packages/*` (`@nredd/pi-*`, all `private: true`
  until a publication pipeline exists)
- `check-scripts`: ruff, ty, pytest for `scripts/` (real disposable git repositories)
- `check-integration`: ruff, ty, unit tests, and the capture probe test for `integration/`
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
