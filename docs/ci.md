# CI

CI is the gate. Local runs are for development. Hosted runners only, no credentials, no secrets.

`.github/workflows/ci.yml`, every PR and `main`:

| Job | Runs | Proves |
| --- | --- | --- |
| `owned (ubuntu-24.04, macos-14)` | `make install`, `make check-ts check-scripts check-integration`; `make check-benchmark` on macOS only | Biome, tsc, Vitest and `bun test` for every package, `scripts/` and `integration/` unit gates. `check-benchmark`'s `native_runtime` test needs Seatbelt, so Linux reports it NOT RUN |
| `contracts (ubuntu-24.04, macos-14)` | `make check-package-contracts`, `make check-fork-package-contracts` | Packed tarballs alone on exact stock Pi 1.3.0, and the packed preset + dev-tools through the Gitlinked `pi-subagents`. JSON reports uploaded as artifacts |
| `bench (not run)` | a notice and a step summary | Nothing. No quiet self-hosted runner exists yet (migration plan section 7) |

`.github/workflows/forks.yml`, when `forks/**`, `.gitmodules` or the workflow changes, plus manual dispatch:

| Job | Runs |
| --- | --- |
| `core (forks/pi)` | `npm ci`, the release's model data restored from npm `@earendil-works/pi-ai@<version>` (never the live fetch), `npm run build:offline`, `npm run check` + `git diff --exit-code`, the env daemon, `./test.sh` |
| `pi-subagents` | `npm ci`, `npm run check` |
| `pi-plan-mode` | `npm ci`, `npm run check`, `npm test` |
| `pi-claude-auth` | pnpm at the fork's `packageManager`, `pnpm install --frozen-lockfile`, lint, build, test |
| `rpiv-todo, pi-computer-use (not run)` | a notice: rpiv-todo gates inside an upstream `rpiv-mono` clone, pi-computer-use needs macOS TCC |

Toolchain: Node from `.node-version`, npm from `packageManager`, Bun from `.bun-version`, uv `0.13.1`
(Python from `.python-version` via uv). Every action is pinned to a commit SHA.

Required checks on `main`:

- `migration-review/standards` and `migration-review/spec` stay manual: the orchestrator posts them with
  `gh api -X POST repos/nredd/pi-harness/statuses/<FULL sha>` after both Sol reviews pass on that exact
  HEAD. No review bot exists. A PR cannot set them itself
- CI jobs become required once they are green on `main`

Flake policy (migration plan section 7):

- A new correctness failure blocks
- A documented, isolated flake may get ONE fresh rerun of the whole failed job, only when nothing else
  failed. The rerun must pass. Both attempts stay in the run's attempt history; name the flake in the PR
- Known timing-sensitive suites: session-kit `monitor` and `diff` reaping, dev-tools kill escalation,
  core `chord`/`durable` 5 s timeouts. They were green alone and flaky on a loaded laptop
- Never rerun until green, never relabel NOT RUN as a pass

Not in CI yet: the assembled-stack smoke and the TUI tier (`PLAN.md` item 4), bench on a quiet runner,
npm trusted publishing.
