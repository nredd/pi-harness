# CI

CI is the gate. Local runs are for development. Hosted runners only, no credentials, no secrets.

`.github/workflows/ci.yml`, every PR and `main`:

| Job | Runs | Proves |
| --- | --- | --- |
| `owned (ubuntu-24.04, macos-14)` | `make install`, `make check-ts check-scripts check-integration`; `make check-benchmark` on macOS only. `cargo-nextest` is installed so dev-tools' real cargo suite runs instead of skipping | Biome, tsc and each package's unit suite (Vitest; preset `node --test`), `bun test` on each package's `test/scenarios/` where it has one (`test:bun`; a notice names every package without one, as NOT RUN), `scripts/` and `integration/` unit gates. `check-benchmark`'s `native_runtime` test needs Seatbelt, so Linux reports it NOT RUN |
| `contracts (ubuntu-24.04, macos-14)` | `make check-package-contracts`, `make check-fork-package-contracts` | Packed tarballs alone on exact stock Pi 1.3.0, and the packed preset + dev-tools through the Gitlinked `pi-subagents`. JSON reports uploaded as artifacts |
| `bench (not run)` | a notice and a step summary | Nothing. No quiet self-hosted runner exists yet (migration plan section 7) |

`.github/workflows/forks.yml`, when `forks/**`, `.gitmodules` or the workflow changes, plus manual dispatch:

| Job | Runs |
| --- | --- |
| `core (forks/pi)` | `npm ci`, the release's model data restored from npm `@earendil-works/pi-ai@<version>` (never the live fetch), `npm run build:offline`, the steps of the fork's `check` with Biome check-only (the step fails if the fork's `check` list changes), the env daemon, `./test.sh` |
| `pi-subagents` | `npm ci`, `npm run check` |
| `pi-plan-mode` | `npm ci`, `npm run check`, `npm test` |
| `pi-claude-auth` | pnpm at the fork's `packageManager`, `pnpm install --frozen-lockfile`, lint, build, test |
| `rpiv-todo, pi-computer-use (not run)` | a notice: rpiv-todo gates inside an upstream `rpiv-mono` clone, pi-computer-use needs macOS TCC |

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
  split has no lockfile: `rpiv-config` and optional peer
  `rpiv-i18n` are pinned to its release `2.12.0`, recorded in the root lockfile
- `isolateStackHome()` isolates `HOME`, `PI_CODING_AGENT_DIR`, XDG config before loading entries.
  `plan-todos.test.ts` drives the real Plan/todo pair, canonical RPC chooser selections, core
  compaction with scripted summaries, file-backed dispose/reopen and legacy mode entries.
  `/todos` heading counts share the evidenced-batch test; no second process
- `goal-support.ts` shares one injected clock across the real kit, router and subagents factories,
  with credential-free usage snapshots and explicitly configured faux auth. Goal/Plan/todo,
  loop/Plan, child accounting, scheduled/busy/idle notices and quota park/refuse/resume tests
  run on the same host. The child runner loads the real kit itself. All assertion destinations
  and native timer boundaries live in the ledger: [here](verification-rebuild.md)

The unit gates must not read the machine: the first CI run found three `integration/tests` that only
passed on the owner's laptop (`pi` on `PATH`, the chezmoi source tree). They are gone or isolated.

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
