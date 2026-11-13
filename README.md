# Pi harness

Development home for the `@nredd/pi-*` Pi plugins, the Pi core fork, their integration tests and
the exact-stack release tooling.

Documentation lives in this file, each package's `README.md` and git history. `docs/` holds only
the references a test, workflow or release procedure reads: [CI](docs/ci.md),
[coverage](docs/coverage.md), [install](docs/install.md), [releases](docs/releases.md),
[release verification](docs/release-verification.md), [stack promotion](docs/stack-promotion.md)
and [self-hosted runners](docs/self-hosted-runners.md), plus `docs/agents/issue-tracker.md` for the
`code-review` skill. Do not add plans, coverage write-ups or
investigation notes; put the why in the commit.

## Layout

- `packages/`: independently versioned npm workspaces. Versions live in each `package.json`
  - `computer-use`, `plan-mode`, `subagents`, `todo`: forks, upstream noted in each README
  - `dev-tools`, `session-kit`, `subscription-router`, `preset`: own extensions and the optional preset
  - `resource-sampler`: Pi-independent ESM library used by session-kit
- `forks/pi`: the only Gitlink, the `nredd/pi` core fork
- `integration/`: `inprocess/` (real extension factories on core's session harness, Vitest and
  Bun), `scenarios/` (process and terminal boundaries, run by the CI `stack` jobs), `stacks/`
  (`personal.json` is the one maintained package selection), `harness/` and its unit tests.
  See [its README](integration/README.md)
- `scripts/`: CI classification, coverage accounting, package contracts and release tooling
- `coverage/policy.json`: enforced coverage policy
- `benchmarks/comparison/`: historical comparison experiments
- `releases/`: generated release manifests

## Development

Node `26.12.0` (`.node-version`), npm `11.20.0` (`packageManager`), Python `3.13.15`
(`.python-version`) under `uv`, Bun `1.4.4` (`.bun-version`), Git, `tmux`, macOS or Linux.

```sh
make install                 # install-owned (verify core overrides, npm ci --ignore-scripts, uv sync --locked) + install-benchmark
make check                   # owned-code gate: check-ts check-scripts check-integration check-benchmark
make check-package-contracts # packed tarballs through exact stock Pi; not part of `make check`
make help                    # every target
```

- `make check` never rewrites files and never touches `forks/`. `check-ts` takes `WORKSPACES=<paths>`
- `check-benchmark` needs `@openai/codex@0.154.0` first on `PATH` on macOS; it fails, never skips
- Packages build and test against the core fork's release tarballs pinned in root `overrides`.
  Stock Pi compatibility is `make check-package-contracts`' job
- Keep package-local `node_modules/` host copies absent: the in-process stack loader refuses a
  second host copy
- On macOS run long gates under `/usr/bin/caffeinate -is`. Do not relax real-time deadlines
- Never run an unguarded `npm audit fix`: test-host pins are deliberate

## CI and release

- Branch protection requires the twelve `owned`, `contracts` and `stack` matrix checks. What runs,
  what is NOT RUN and the flake policy: [CI](docs/ci.md)
- Owned packages publish through `publish.yml` from a signed tag; core ships through
  `nredd/tap/pi-coding-agent`. Procedure: [releases](docs/releases.md)
- `promote-stack.yml` attests a gated `main` commit as `stack/<sha>`:
  [stack promotion](docs/stack-promotion.md). Anyone installs one with a single `uvx` command:
  [install](docs/install.md)
- Dotfiles selects pins and activates them with `chezmoi update --upgrade`; require
  `pi-profile doctor` afterwards. Nothing here reads a machine's home, Brewfile or chezmoi source

## Core fork

- `forks/pi` tracks `earendil-works/pi` as a patch queue on an upstream release tag. Inspect it
  with `git submodule status`; add the `upstream` remote by hand when rebasing the queue
- A parent worktree does NOT isolate the submodule. Never `--force`, clean or discard inside it
- Order: core fork PR with its native gate and both reviews, publish the reviewed commit and
  release, then a parent PR that moves the Gitlink, root `overrides`, `integration/stacks/personal.json`
  and the lockfiles together
- `make check` is not the core gate. `forks.yml` runs the core suite at the exact Gitlink and
  `make check-core-compaction` runs the assembled child-compaction probes
- The extension forks are imported workspaces, not submodules. They are not kept in sync with
  upstream; each README records where it came from
