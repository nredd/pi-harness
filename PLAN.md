# Handoff: rebuild the pi harness verification stack from the ground up

Written 2026-10-18 at the end of the migration session. This is the prompt for the next session:
read it fully, then start at "Where to start". Everything referenced is pushed; nothing below is
in a working tree.

Owner rules, non-negotiable:

- NO local `make verify` / `make verify-fast` / scenario runs on this Mac until the suite is rebuilt.
  It is 30 min wall, load-sensitive, and the Mac is swap-bound (16 GB, Music.app pinned at 99% CPU).
  Unit tests (`make test`, per-package `npm run check`) are fine
- Every PR gets independent Standards + Spec `code-reviewer` subagents on `openai-codex/gpt-6.1-sol`,
  verified in the transcript (`grep -o '"model":"[^"]*"' <task>.output`), on the EXACT final HEAD,
  receipt comment on the PR. `nredd/pi-harness` main is protected: post `migration-review/standards`
  and `migration-review/spec` statuses with `gh api -X POST repos/nredd/pi-harness/statuses/<FULL sha>`
  before merging. Forks (`nredd/pi`, `nredd/pi-subagents`) and `pi-harness-e2e` have no protection
- Prefer gpt-6.1-sol for subagents that reason; terra was unreliable today
- No toolchain installs by agents (rustup/brew/apt/npm -g). `check-benchmark` needs the pinned Codex
  on PATH: `PATH=$HOME/code/pi-harness-builds/tools/codex-0.154.0/node_modules/.bin:$PATH` with a
  throwaway `CODEX_HOME`/`XDG_CACHE_HOME` (root README recipe)
- Subagent-run scenario suites: never. If a subagent needs timing data, it reads existing logs
- Power down `nas` when done with it (`ssh nas 'sudo -n shutdown -h now'`)
- My writing style for everything committed: terse, `-` bullets, `--` not em-dashes, no headers
  beyond H1 in docs, no `## Summary`/checkbox lists in PRs or commits, Claude footer kept

## State of the world

Repos and where they are:

- `~/code/pi-harness` (`nredd/pi-harness`, main `403bb87`): the monorepo. `packages/{dev-tools,
  session-kit,subscription-router,preset}` (TS, Vitest/node:test), `integration/` (an imported COPY
  of the e2e harness, drifted), `benchmarks/comparison` (Python, pinned Codex 0.154.0 sandbox),
  `scripts/` (Python: `package_contracts.py`, `fork_package_contracts.py`, `release_manifest.py`,
  `bootstrap_forks.py`), `forks/*` Gitlinks, `docs/` (migration-plan.md is the approved plan;
  forks.md, package-contracts.md, releases.md, bun-prerequisite.md, source-provenance.md),
  `releases/*.json` generated manifests. Gate: `make check` (owned code only), `make
  check-package-contracts` (packed tarballs on stock Pi 1.3.0), `make check-fork-package-contracts`
- `~/code/pi-harness-e2e` (`nredd/pi-harness-e2e`, main `380d369`): the LIVE Python harness.
  `tests/` (121 harness unit tests), `scenarios/{static,integration,tui,bench,live}` (~275 scenario
  functions), `harness/` library, `providers/*.ts|mjs` (faux provider, usage fixture, fast-timers
  preload, anthropic redirect preload), `baselines/bench.darwin.json`, `docs/`. Since today runs
  under pytest-xdist (`c839816`, `5673579`): `make verify-fast`/`verify` are `-n auto --dist
  loadfile`, bench is `make verify-bench` serial behind a load guard. The parallel run is UNVALIDATED
- Fork worktrees: `~/code/pi-fatal-extension-startup` (nredd/pi, branch `nredd/v1.3.0`, released tgz
  untracked in `packages/*/`), `~/code/pi-binary-schemas` (same repo), `~/code/pi-subagents-project-trust`
  (nredd/pi-subagents, `nredd/v0.22.0`), `~/code/pi` (older core checkout), `~/code/pi-subagents`
- Old standalone repos still exist and are NOT archived: `~/code/pi-dev-tools`, `~/code/pi-session-kit`,
  `~/code/pi-subscription-router`, `pi-harness-benchmark`. The monorepo is the source of truth now
- Evidence directory: `~/code/pi-harness-builds/` (every gate log, Bun binaries `fatal-startup-out*`,
  `verify-*` matrices, `publish-20261017/`, `release-20261017/`, `npm-switch-20261018/`,
  `bun-checklist-20261018/`, `runtime-probes.md`, `runtime-adapter-notes.md`). Not a repo
- chezmoi source `~/.local/share/chezmoi` (main `5ab0de8`), pi config README `~/.pi/agent/README.md`
  (inventory, invariants, fork runbook: read before touching pins)

What is live on this Mac (verified, `chezmoi diff --recursive ~/.pi` empty):

- pi core `v1.3.0-nredd.3` via `nredd/tap/pi-coding-agent` (tap `ace6961`), tag at `4729330` on
  `nredd/v1.3.0`. GH release assets: coding-agent tgz `753efe6f…`, tui tgz `ccd8f2d2…`
- `pi-subagents` `v0.22.0-nredd.2` at `2fc9632` (git pin)
- `@nredd/pi-dev-tools@0.4.0`, `@nredd/pi-session-kit@0.3.0`, `@nredd/pi-subscription-router@0.3.0`
  installed from npm (personal profile only; the work profile still excludes them). `@nredd/pi-preset@0.1.0`
  published but not installed live
- unchanged pins: pi-plan-mode `v0.59.2-nredd.4`, rpiv-todo `v2.12.0-nredd.6`, pi-claude-auth
  `v0.1.3-nredd.1`, pi-computer-use `v0.5.1-nredd.2`
- npm: user `nredd`, 2FA auth-and-writes with a passkey; `npm publish` needs a TTY for the browser
  flow (`printf '\n' | script -q log npm publish …` works, open the printed URL). No token on disk

## Everything done in the migration (2026-10-16 .. 18), with receipts

Monorepo bootstrap and imports (pi-harness PRs #1-#5, all dual Sol reviewed):

- #1 bootstrap `575674b`; #2 five audited source snapshots + fork Gitlinks `1000e9a` (1,499 tests);
  #3 package contracts `45fe49b`; #4 preset `0d40aa3`; #5 `5428d2a` (92.98% benchmark coverage)

Two corrective forks, dual Sol reviewed on exact HEAD, merged, tagged, released, pinned:

- nredd/pi#1 `migration/fatal-extension-startup` (reviewed `c4bfc46`, 13 commits, 8 Spec rounds):
  `ExtensionStartupError` (session_start throwing it fails bind/reload), fail-closed provider gate
  (`beforeProviderRequest` per request on `Agent` loop options + session `Models` facade, synchronous
  recheck in the dispatch segment, `signal.throwIfAborted()`), ONE held-message queue replayed one at a
  time with a `StartupReplay` identity token revalidated at every resume point (entry, before the
  streaming decision, after `_prepareRun`, custom-message entry), fatal aborts in-flight run/compaction/
  branch summary, `ctx.modelRegistry` provider calls refused inside session_start, CLI print/rpc/tui
  nonzero exit with 0 provider calls and no `process.exit`. Receipt
  https://github.com/nredd/pi/pull/1#issuecomment-6243491406
- nredd/pi#2 `099546d`/`aff7da3`: standalone archives ship `schemas/`
- nredd/pi#3 `8754b00`: held startup sends go through the PUBLIC `prompt`/`sendUserMessage`/
  `sendCustomMessage` (replay token on `options` under a symbol). Found by the harness: pi-dynamic-
  workflows wraps `AgentSession.prototype.sendCustomMessage` to swallow a `workflow-delivery-probe`;
  bypassing it put the probe after the assistant reply and emptied print-mode text output. Receipt
  https://github.com/nredd/pi/pull/3#issuecomment-6244480714
- nredd/pi-subagents#3 `migration/project-agent-trust` (reviewed `e7ed253`): canonical session_start
  trust discovery, `src/startup-error.ts` host bridge, `configProjectTrusted` paired with `configCwd`
  through nested chains, package agent files warning-only under `strictAgentFiles`, globals fail the
  factory, trusted project-local files fail session_start, older host strict refusal documented as
  BREAKING. Receipt https://github.com/nredd/pi-subagents/pull/3#issuecomment-6237019898
- Parent Gitlink PRs #6 (`63e7519`, also flipped the fork contract case `project-override-untrusted`
  to the gated behavior), #7 (`639bf14`), #8 (`4c962e2`)
- Tags: `v0.22.0-nredd.2` at `2fc9632`; `v1.3.0-nredd.3` at `4729330` + GH release; tap `ace6961`;
  chezmoi `7236703`; `chezmoi update` applied; live `make verify` exit 0 (`release-20261017/verify-live.log`)

Publication:

- pi-harness #11 `c1857f3`: packages public-publishable, contract gate requires
  `publishConfig.access: public`; #12 `8ed2d6b`: `releases/2026-10-18-npm-publication.json`;
  #13 `13fbcf6`: signed per-package tags `@nredd/<name>@<version>` at `c1857f3`
- All four published; registry tarballs re-downloaded and byte-identical to the gated ones
  (`publish-20261017/registry-verify.txt`). No provenance attestation (no OIDC yet)
- npm switch on this Mac: chezmoi `5ab0de8` (npm pins, retire hook fixed: strip `@version` from npm
  sources, remove unconfigured git checkouts like pi's `removeGit`), acceptance through live Pi in
  `npm-accept-20261018/` (install, 0 warnings, dev-tools tool call, `router/default` dispatch,
  `/stats`, preset reviewer with the contract tool set, TUI exit 0). Harness `17615b8`: npm pins
  resolve from `~/.pi/agent/npm/node_modules/@nredd/<name>` at exact version, `pinned_source` clones
  the monorepo tag for source-only fixtures (router e2e). Live gate after: 1 accepted bench miss
  (`ms_input_p95_n4` 12.17 vs 9.90, concurrent Bun run), `docs/npm-package-switch.md`

Release tooling and records (pi-harness):

- #9 `a17d520`: `scripts/release_manifest.py` + `make release-manifest`, `releases/2026-10-17-startup-trust.json`
  (schema v1: release id/commit/dirty, Gitlinks from the INDEX + exact tags, owned versions, lockfile
  digests, artifact SHAs/URLs, evidence pairs). Deliberately omits profiles, runtime-tree archives,
  per-dependency third-party lock
- #10 `9d00f96`: core dependency audit triage in docs/forks.md (node-forge GHSA-86w9-cpqp-85rv only via
  the `gondolin` example workspace; tarball contents, bundle, Homebrew closure, Bun strings all clear)
- #15 `403bb87`: first full Bun gate recorded in docs/bun-prerequisite.md

Bun:

- Bun 1.3.14 standalones (`scripts/build-binaries.sh`, pinned bun FIRST on PATH from
  `~/code/pi-harness-builds/tools/bun-1.3.14/`) execute on darwin-arm64 and linux-x64 (nas, Debian 13
  glibc 2.41, first real Linux run, `verify-c4bfc46-linux-x64/`). Fatal-startup CLI matrix and trust
  cases A-F identical to Node on both. linux-arm64 cross-built only
- Full e2e gate on the Bun binary: 13 TUI failures + 2 bench. ROOT CAUSE (verified with a 5-line timer
  extension): Bun ignores `NODE_OPTIONS --import`, so the harness's `fast_timers.mjs` (shortens the
  kit's 30 s/60 s timers), `redirect_anthropic.mjs` and `--expose-gc` never load; raw timers are fine.
  NOT a session-kit bug. Harness `e1a64dd` now refuses preload-dependent scenarios up front on such a
  runtime (shared nonce-mark readiness probe). Tracking nredd/pi-harness#14. A runtime adapter that
  works inside the compiled process is still unbuilt (plan #58); `runtime-adapter-notes.md` has the
  probe findings (Bun.fetch is non-writable; `bun:test` spyOn can intercept it; binding capture order
  matters)

Harness perf work (pi-harness-e2e, today):

- `7c6ae30` fixed a date-dependent `/stats` heatmap scenario; `aa67720` npm-switch record
- `c839816` (Sol): `docs/perf-profile.md` (static profile + prior wall times, 28-29 min per full run;
  structural costs: per-test template-HOME copy + pi cold start ~270 launches, ~225 s of literal
  real-clock waits in three fleet/quota/cache tests, the `/stats` width matrix), per-test audit
  (274: 269 KEEP / 1 REDUNDANT / 3 MERGE / 1 DROP; applied), xdist with per-worker isolation
  (`harness/isolation.py`, `bench_guard.py`, `fcntl` lock on the clone cache, `awake_host` per worker,
  kernel ports), Makefile: `verify-fast`/`verify` parallel, `verify-bench` serial + guard
- `5673579` after a critic audit: nine-digit worker-slotted `sleep` tags + anchored `pkill` (two
  workers could kill each other's monitor child), bench guard recognizes staged core and `PI_BIN`
- `380d369` (Sol): `docs/verification-layers.md`: 273 stay / 9 move down / 1 duplicate. BOTH audits
  were soft because they took "real pi process" as a requirement. The owner rejects that framing

Issues open: nredd/pi-harness #14 (Bun preload adapter), #7 (turn-rule cleanup into next core),
#6, #4, #3, #2 (older TUI/latency follow-ups); nredd/pi-harness-e2e #8 (verify wall time).

Lessons that cost time today (keep):

- Core runtime paths must enter through PUBLIC `AgentSession` methods; extensions wrap the prototype
- Every Spec round on the startup barrier found a new await-boundary race; the structural fixes were
  identity token at dequeue, sync recheck in the dispatch segment, signal check at dispatch, one queue
- npm `dist.integrity` is sha512; compare by downloading. npm tarball `files` excludes e2e fixtures,
  hence source tags at publication
- Ported probe scripts drift (a dropped `[ $EARLY = 1 ] ||` guard gave +1 request); diff before trusting
- Process-timing tests (session-kit `monitor`, `diff/git` reaping, dev-tools kill escalation, core
  `chord`/`durable` 5 s timeouts) flake on this Mac under load; green alone. CI must own the flake policy
- A 30-min sequential gate that every pin bump needs is the actual bottleneck of the whole program

## Plan item status (the approved plan, pi-harness docs/migration-plan.md)

Completed: 1 (repo ownership, all five imports), 2 (review process, honored on 22 PRs), 3's packages
(#17-20 published), 5's darwin-arm64 + linux-x64 execution, 6's identity/Gitlinks/archive digests/
evidence, 8 (chezmoi staging + activation + rollback path), audit triage, npm ownership, publication.

Deferred, with why:

- 3 remainder: work-profile switch and archiving old repos (plan gates on enterprise WSL acceptance;
  the owner now wants archiving done as part of the rebuild below)
- 4 profiles / model roles: not started
- 5 Bun checklist #24 linux-arm64 (no glibc arm64 host), #26-31 blocked on #14/#58
- 6 #35 per-dependency integrities, #37 profile fields, runtime-tree archives
- 7 CI / promotion (#39-44): not started; #57 GitHub App / runner: owner provisioning
- 9 final verification: depends on 7
- #58 compiled-runtime interception adapter: not started

## The rebuild (what the next session does)

The owner's position, verbatim in spirit: we are stuck in a very complicated verification state;
finish the repo-level setup, nuke/archive the outdated repos, get real CI/CD validation; most of the
e2e harness probably belongs in package-native (Vitest + `bun test`) tests; and the harness must be
COMPLETELY separated from chezmoi. Not everyone manages pi with chezmoi, and minor packaging changes
must not be validated against this machine's dotfiles.

Key fact that makes this tractable (verified in `forks/pi` at `4729330`): upstream core ships an
in-process test harness, `packages/coding-agent/test/suite/harness.ts`: `createHarness({ extensionFactories,
tools, settings, models, sessionManager, modelRuntime })` builds a real `AgentSession` +
`SettingsManager` + `AuthStorage` with a scripted faux provider (`registerFauxProvider` from
`@earendil-works/pi-ai/compat`, which IS published), `setResponses`, event capture, tool-result
helpers, resume. It runs the real extension runner and tool/model plumbing. The 50 fatal-startup
scenarios run on it in ~4 s. It does NOT cover: CLI entry/arg parsing, package install + loader
discovery from `~/.pi/agent`, project trust prompts, the TUI, process boundaries, auth transport.
It is under `test/suite/`, not in the npm `files`, so packages cannot import it from published core.

Principles for the rebuild:

- Each layer proves only what it can prove, and nothing is tested twice across layers:
  (a) package unit/scenario, in-process on the core harness, Vitest AND `bun test`
  (b) core/fork in-process suites (already exist)
  (c) packaged-artifact gate: the real tarball installed on stock Pi via `pi install` into a throwaway
      `PI_CODING_AGENT_DIR`, real loader, real trust, print/json mode (today's `package_contracts.py`)
  (d) assembled-stack smoke: a declared package SET (a plain JSON list of sources, NOT chezmoi output)
      installed into a throwaway agent dir, real binary, print/rpc/tui startup, fatal-startup matrix
  (e) TUI rendering under tmux, only for rendering invariants (rows, framing, overlays, resize)
  (f) bench, serial, quiet runner only
  (g) live providers, opt-in
  Machine-specific validation (chezmoi render == installed state, tap pin == Brewfile) becomes a
  separate, tiny, owner-local check (`pi-profile doctor` or a script in the dotfiles), never a gate
  for a package change
- No gate reads `~/.pi/agent`, `~/.local/share/chezmoi`, the Brewfile, or the live install. Inputs are
  explicit: a pi binary path or version, a package-set file, a fixture dir
- Timing-dependent behavior is tested with injectable clocks at layer (a); no real-clock waits, no
  `NODE_OPTIONS` timer preloads, no tmux sleeps for logic
- Runtime parity (Node + Bun) is asserted at layer (a) and (d), not by running tmux twice
- CI is the gate. Local runs are for development. The flake policy from plan section 7 (one fresh
  rerun of the whole failed job, both outcomes retained) lives in CI, not in people's heads

Work items, in order. Each is a PR with the dual review. Numbers are new todo ids for the next session.

1. Core fork: export the suite harness as `@earendil-works/pi-coding-agent/testing` (`createHarness`,
   `createTestUiContext`, helpers, faux re-exports), add it to `files`/`exports`, docs in
   `docs/sdk.md`. Red/green: a package test importing it from the packed tarball. Tag `v1.3.0-nredd.4`,
   release, tap, pin. (Upstream-worthy; note it in docs/forks.md patch queue.)
2. Scrutinize every e2e scenario against the layer bar above, by hand, with the two audit docs as the
   index but NOT as the verdict: for each, name the invariant and the smallest layer that proves it.
   Expected: most of `scenarios/integration/*session_kit*`, `*router*`, `*dev_tools*`, `*plan_mode*`
   (policy, not UI), `*quota_footer_headless*`, `*titles_rules*`, `*monitor*` move to (a); `static/`
   is split into package-set validation (keep, chezmoi-free) and dotfiles validation (leave the
   harness); `tui/` keeps rendering, drops logic; `bench/` keeps multisession/render/startup/compaction,
   `typed_vs_bash` stays. Write the result as `docs/verification-rebuild.md` with a per-scenario
   destination and the native test that replaces it. Blunt; the list must get much shorter
3. Port, package by package, native scenario suites on the exported harness: `packages/session-kit/test/scenarios/`
   (goal, loop, monitor, titles/rules, stats data, quota footer logic with a fake clock),
   `packages/subscription-router/test/scenarios/` (dispatch, recovery, admission, exhaustion, the e2e
   `run.sh` cases), `packages/dev-tools/test/scenarios/` (tool results through a real AgentSession),
   `packages/preset/test/` (discovery + reviewer tool set via a stub subagents runner). Each file runs
   under `vitest` and `bun test` (add `bun test` to each package `check`; replace `node:test` in the
   preset; no `--expose-gc`; fake clocks via injectable timers, not preloads). Delete each e2e scenario
   the moment its native twin is green. Coverage must not drop: the destination doc is the ledger
4. Rebuild the assembled-stack gate inside `pi-harness/integration` (the imported copy, which replaces
   `pi-harness-e2e`): inputs are `PI_BIN` (or a version to fetch) and a package-set JSON; the sandbox
   is a throwaway agent dir populated by `pi install`; scenarios are (d)/(e)/(f) only; chezmoi, tap,
   Brewfile, `~/.pi` never read. Keep: xdist + isolation plumbing, readiness probes, tmux driver,
   bench guard, baselines (re-baselined ONCE on the CI runner, with evidence). Drop: `pinned.py` chezmoi
   pin parsing, `config_checks.py` render comparison, `session_kit.py` kit discovery from live settings,
   `HARNESS_LOCAL` (replaced by the package-set file pointing at a local path)
5. CI on `nredd/pi-harness` (GitHub Actions, hosted `macos-14` + `ubuntu-24.04`): format/lint/type,
   package unit (vitest + bun test), core/fork suites on the Gitlinked forks, package contract gate,
   assembled-stack smoke with the released binaries (Node bundle + Bun standalone, both OSes), TUI
   tier under tmux on macOS, bench only on a self-hosted quiet runner (skip with a visible "not run"
   until one exists). npm trusted publishing (OIDC + `--provenance`) for the four packages on tag push;
   release manifest generated in the workflow. `migration-review/*` statuses: keep manual until a
   review bot exists; document it
6. Archive: `nredd/pi-dev-tools`, `nredd/pi-session-kit`, `nredd/pi-subscription-router`,
   `nredd/pi-harness-benchmark` once CI is green on main (README pointer to the monorepo, `gh repo
   archive`); `nredd/pi-harness-e2e` after item 4 lands and `pi-harness/integration` is the gate.
   Delete the local `~/code/pi-dev-tools`, `~/code/pi-session-kit`, `~/code/pi-subscription-router`
   checkouts; keep the fork worktrees
7. Dotfiles: move the machine-specific checks (chezmoi render == installed, pin == tap == `pi
   --version`, enterprise manifest shape) into a `pi-profile doctor` script in the dotfiles repo, run on
   `chezmoi apply`, never in CI. Update `~/.pi/agent/README.md` "Changing anything" step 3 to the new
   gate (`make check` in pi-harness + CI green), and the fork runbook's "make verify" references
8. Then resume the plan's deferred items on the new stack: #14/#58 runtime adapter (now only needed
   for the auth redirect at layer (d); timers and gc no longer need preloads), profiles (#21), work
   profile switch (needs the enterprise WSL acceptance, which becomes a CI job on `ubuntu` + a manual
   WSL run), linux-arm64 (a hosted `ubuntu-24.04-arm` runner solves #24)

## Where to start

Spawn nothing until you have read: this file, `pi-harness/docs/migration-plan.md`,
`pi-harness-e2e/docs/perf-profile.md`, `pi-harness-e2e/docs/verification-layers.md`,
`forks/pi/packages/coding-agent/test/suite/harness.ts`, `pi-harness/scripts/package_contracts.py`,
`~/.pi/agent/README.md` (Changing anything, Invariants, Fork runbook). Then:

- Item 1 first (small, unblocks everything, proves the harness export packs). Dual review, tag, pin
- Item 2 in parallel as a Sol subagent with the explicit instruction that "real pi process" is NOT a
  requirement and that the owner expects the list to shrink by more than half; you review its verdicts
  yourself against the layer bar before accepting any
- Report after items 1-2 with the destination counts, then proceed through 3-7 without asking unless
  a release or an archive is about to happen (those get a one-line confirmation)

Open todo ids from the old session are reconciled in this file; the next session seeds its own todo
list from items 1-8 above, with each e2e scenario destination as a sub-item of 3.
