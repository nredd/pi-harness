# Handoff: the rebuilt pi harness verification stack

- Updated 2026-10-19 against pi-harness `main` at `c3bf27a`. This is a handoff, not a request to rebuild again.
- Repo-relative paths below belong to pi-harness unless another checkout is named. Historical receipts describe their own release, not the current pins.

Owner rules, non-negotiable:

- CI is the gate; local runs are for development. NO local scenario runs, including by subagents. Read CI logs for timing evidence.
- Every PR, including docs, forks and dotfiles, gets independent Standards + Spec `code-reviewer` reviews on the EXACT final HEAD. Dotfiles `agentModels` routes `code-reviewer` through `router/review` (Sonnet 5.5, `gpt-6.1-sol`); the receipt names the model each transcript actually ran and what it read. A changed HEAD invalidates both reviews.
- Fetch the reviewed SHA locally FIRST. Read-only reviewers cannot fetch; an unresolved revision is not a clean review.
- `~/code/pi-harness-builds/merge-pr.sh` checks the exact HEAD and both transcripts, quotes each one's model, verdict and reads, refuses unresolved-revision transcripts and non-green CI, posts the receipt and `migration-review/standards` / `migration-review/spec` statuses, then merges. Its transcript directory is session-specific; inspect it before reuse.
- Main requires `owned` and `contracts` on `ubuntu-24.04` + `macos-14`, `stack` on both OSes x `personal` / `local`, and both review statuses. Applicable path-filtered fork jobs must also pass. See [here](docs/ci.md).
- No CPU load generators. Reproduce races with deterministic injected delays/awaits and plain repeats, not synthetic load on this Mac.
- No toolchain installs (`rustup`, `brew`, `apt`, `npm -g`). Use installed tools. Pinned Bun 1.3.14: `~/code/pi-harness-builds/tools/bun-1.3.14/bun-darwin-aarch64/bun`; put its directory FIRST on `PATH`.
- `check-benchmark` uses pinned Codex: `~/code/pi-harness-builds/tools/codex-0.154.0/node_modules/.bin`, with throwaway `CODEX_HOME` / `XDG_CACHE_HOME`; root `README.md` has the recipe.
- Power down `nas` when done: `ssh nas 'sudo -n shutdown -h now'`.
- Commit style: terse `-` bullets, `--`, ASCII arrows, no extra headers or checkbox templates; keep the Claude attribution footer. Edit -> document -> gate -> commit -> push.

## State of the world

Repos, verified with GitHub branch heads (upstream/default branches are NOT the released fork selections):

- `nredd/pi-harness` main `c3bf27a`: owned packages, fork Gitlinks, native suites, contracts, assembled stack, release tooling. Local checkout `~/code/pi-harness`.
- `nredd/dotfiles` main `fea75d5`: machine configuration, activation and doctor. Local checkout `~/code/dotfiles`; chezmoi source `~/.local/share/chezmoi`.
- `nredd/homebrew-tap` main `66e9289`: core nredd.6 formula, #1.
- `nredd/pi` main `bd6444a`; released selection is `v1.3.0-nredd.6` at `9351a78` on `nredd/v1.3.0`.
- `nredd/pi-subagents` has no main; master `927cf03`. Released selection is `v0.22.0-nredd.4` at `a4116d3`, rebased onto tintinweb master `ca93a524`, on `nredd/v0.22.0-ca93a52`.
- `nredd/pi-plan-mode` main `cb9b7c1`; default branch remains `nredd/v0.59.2` at `d91bb2b`. Released selection is `v0.59.3-nredd.1` at `4c2bfc3` on `nredd/v0.59.3`.
- `nredd/rpiv-todo` main `0f46ed9`; released selection is `v2.13.9-nredd.1` at `3c62a0b`.
- Archived on GitHub: `nredd/pi-dev-tools`, `nredd/pi-session-kit`, `nredd/pi-subscription-router`, `nredd/pi-harness-benchmark`, `nredd/pi-harness-e2e`. Their open follow-ups moved to dotfiles issues [here](https://github.com/nredd/dotfiles/issues). Do not revive standalone harness ownership.
- `~/code/pi-harness-builds/` holds historical evidence and pinned tools, not source ownership. Read `~/.pi/agent/README.md` before changing Pi config or pins.

Live selection / promotion state:

- Tap formula selects core `v1.3.0-nredd.6`. Dotfiles #4 selected it and the gated stack; #10 selected the three rebased forks above; #11 selected `@nredd/pi-session-kit@0.4.0`; #14 selects `@nredd/pi-dev-tools@0.5.1` and `@nredd/pi-subscription-router@0.4.0`.
- Compare `integration/stacks/personal.json` with `~/code/dotfiles` main's `third_party/pi-agent-settings.base.json`; both currently select the same twelve package sources. Git/gh verifies the committed selections, not whether a particular machine has applied them.
- Exact third-party npm pins: `pi-web-access@0.36.0`, `pi-deferred-context-engine@0.5.0`, `@quintinshaw/pi-dynamic-workflows@3.14.0`, `pi-memory@0.4.2`.
- Other fork pins: `pi-claude-auth v0.1.3-nredd.1`, `pi-computer-use v0.5.1-nredd.2`. The stack installs but never loads computer-use in headless CI.
- Owned pins: `@nredd/pi-dev-tools@0.5.1`, `@nredd/pi-subscription-router@0.4.0` (gated by #51 `stack`, promoted by dotfiles#14), `@nredd/pi-session-kit@0.4.0` (gated by #46 `stack`, promoted by dotfiles#11). preset carries unreleased changes; cut it through `publish.yml` when needed.
- `@nredd/pi-preset@0.1.0` is published, not adopted live. The live footer remains dotfiles-owned until profiles/preset adoption.

Verification layers now implemented:

- Package-native Vitest + pinned Bun suites own package behavior, including interactive host / `VirtualTerminal` tests and injectable clocks.
- `integration/inprocess/` owns A-stack tests with real extension factories and one host identity. It also hosts the four single-fork rpiv-todo B rows; that is not a claim that the split fork's native suite runs.
- `.github/workflows/forks.yml` runs applicable full fork suites. Before tagging a fork, use a temporary CI probe PR selecting the candidate Gitlink, fetch its SHA for reviews, wait for full fork CI, then close the probe without merging. Receipts: #37, #39.
- `contracts` owns packed artifact identity, installation/discovery/trust and stock-host compatibility. See `docs/package-contracts.md`; do not confuse it with assembled-stack coverage.
- `stack` D/E jobs use a formula-shaped released Node binary plus explicit `integration/stacks/personal.json` / `integration/stacks/local.json` in throwaway agent dirs, on both OSes. No chezmoi, Brewfile or live install input. D owns process boundaries; E owns the real tmux resize seam.
- Bun standalone D/E is NOT RUN: nredd.6 has no standalone asset. Package-native Bun passes are not standalone evidence.
- Bench F is visibly NOT RUN until a quiet runner exists. G remains explicit live-provider opt-in, never CI.
- `pi-profile doctor` belongs to dotfiles, checks machine-specific render/pins/install consistency, and runs warn-only after apply. It is not a package gate.
- `docs/verification-rebuild.md` is the destination ledger. No unported non-boundary Python scenarios remain; old progress paragraphs retain their historical port-base context.

npm trusted publishing:

- `.github/workflows/publish.yml`: signed package tag -> verify exact packed bytes/contracts -> publish with OIDC in environment `npm` -> verify registry integrity/signatures/provenance -> GitHub release.
- All four packages trust `nredd/pi-harness` / `publish.yml` / `npm`, require 2FA and disallow tokens. No npm token in CI. The `npm` environment admits only `@nredd/*@*` tags; the active `npm release tags` ruleset restricts `refs/tags/@nredd/**` to admin bypass.
- First trusted-published release: `@nredd/pi-session-kit@0.4.0`, tag at `718b033`, workflow [here](https://github.com/nredd/pi-harness/actions/runs/39328655931) (attempt 1 published but timed out its 60 s registry poll; attempt 2 skipped re-publication and verified), release [here](https://github.com/nredd/pi-harness/releases/tag/%40nredd/pi-session-kit%400.4.0). #46 widened the poll to ten minutes.
- Cut a release using `docs/releases.md`: reviewed version/lock bump -> green CI -> signed tag on merged main -> push only that tag -> watch Publish -> separately gate the candidate stack and dotfiles promotion. No local publishing; failed-job recovery reuses the original artifact, never repacks accepted bytes.

## Everything done in the migration (2026-10-16 .. 18), with receipts

Historical, not the current deployment inventory:

- Monorepo bootstrap/imports/contracts/preset: pi-harness #1 `575674b`, #2 `1000e9a`, #3 `45fe49b`, #4 `0d40aa3`, #5 `5428d2a` (92.98% benchmark coverage).
- Startup barrier/provider gate/held-message identity: nredd/pi#1 receipt [here](https://github.com/nredd/pi/pull/1#issuecomment-6243491406). Schema packaging: nredd/pi#2. Held sends through public session methods: nredd/pi#3 receipt [here](https://github.com/nredd/pi/pull/3#issuecomment-6244480714).
- Project-agent trust: nredd/pi-subagents#3 receipt [here](https://github.com/nredd/pi-subagents/pull/3#issuecomment-6237019898). Parent selections #6 `63e7519`, #7 `639bf14`, #8 `4c962e2`.
- Historical releases: core `v1.3.0-nredd.3` at `4729330`, subagents `v0.22.0-nredd.2` at `2fc9632`. Superseded by the pins above.
- Manifest generator #9 `a17d520`; dependency audit #10 `9d00f96`; first npm publication #11 `c1857f3`, #12 `8ed2d6b`, #13 `13fbcf6`. Initial registry bytes matched gated tarballs; those initial versions had no OIDC provenance. See `releases/2026-10-18-npm-publication.json`.
- First Bun gate #15 `403bb87`: darwin-arm64 and linux-x64 execution; linux-arm64 cross-build only. Bun ignores `NODE_OPTIONS --import`, so timer/auth/GC preloads did not run. This was NOT a session-kit timer bug. See `docs/bun-prerequisite.md`.
- Archived e2e perf/isolation receipts: `c839816`, `5673579`, `380d369`. They improved xdist/isolation but retained too many process tests; the rebuild replaced that boundary choice.
- Keep the lessons: use public session methods because extensions wrap them; identity tokens and synchronous dispatch checks close await races; compare downloaded npm bytes, not unlike digest formats; diff ported probes before trusting them; CI owns flake policy, not loaded-laptop timing.

## Plan item status (the approved plan, pi-harness docs/migration-plan.md)

- Ownership/imports, package publication, fork provenance, staging/activation/rollback, CI and machine-local doctor are implemented. Rebuild items 1-7 below are DONE, not new work.
- The approved plan still contains deferred acceptance and automation work. In particular, CI's formula-shaped Node binary is not acceptance of the Bun standalone prerequisite. Do not mark the entire migration complete.
- Release records intentionally omit complete third-party integrities, profile fields and runtime-tree archives; see `docs/releases.md` for the current manifest boundary.

## The rebuild

1. DONE -- export the core session harness and interactive/terminal testing APIs. Parent #18, #19, #28; fork nredd/pi#4, #5, #6. Selected core nredd.6; nredd.5 was released but never selected after full-suite regressions.
2. DONE -- audit each scenario at its smallest owning boundary. Ledger #17, finalized by #45. Migration inventory: 191 functions -> 20 real-process survivors; the new fatal-startup boundary adds one, for 21 D/E/F/G functions. No non-boundary scenario remains unported.
3. DONE -- native package, A-stack and fork ports. #20, #22, #23, #26, #27, #31, #32, #33, #36, #40, #41, #42, #43, #45. Process-output regression fixed by #38.
4. DONE -- explicit assembled-stack gate without chezmoi. #30, host-sleep fix #34. Formula-shaped Node release, both stacks/OSes, nine D functions and one E seam. Standalone Bun and F remain NOT RUN, not hidden passes.
5. DONE -- hosted owned/contracts/forks/stack gates and OIDC publication. #21, #30, #35; first version/release #44, registry-wait fix #46. See `docs/ci.md` for protections and the one fresh whole-job rerun policy. Bench provisioning and review/promotion automation remain deferred.
6. DONE -- archive all five standalone repos after the replacement gate landed. GitHub reports `archived: true` for each; final archive-pointer heads: dev-tools `91656c2`, session-kit `75fc5a6`, subscription-router `eaee3ed`, benchmark `d4b9896`, e2e `5d078a7`. Replacement PR receipts: #21, #30; follow-ups now in dotfiles. GitHub archival is a repository operation, not a pi-harness PR; local checkout deletion is not assumed.
7. DONE -- machine-specific checks moved to dotfiles `pi-profile doctor` and its apply hook/runbook. dotfiles#3, activation pins #4, rebased forks #10; matching harness stack receipt #30. No package gate consumes the owner's config.
8. OPEN -- resume deferred work on the rebuilt stack:
   - Profiles/model roles and preset footer adoption (migration plan #21); do not replace the live dotfiles footer implicitly.
   - Work-profile switch and enterprise WSL acceptance.
   - Bun standalone checklist #26-31 and compiled-runtime adapter #58; auth transport interception remains a runtime boundary, native timer tests no longer need preloads.
   - linux-arm64 execution/acceptance, not just cross-building.
   - Quiet bench runner; F stays NOT RUN until provisioned and baselined with evidence.
   - GitHub App / promotion automation #57. `migration-review/*` remains manual until a trusted review bot exists.
   - Scratchpad: rpiv-todo `renderCall` reads the live task subject without `context.invalidate()`; a collapsed update/delete row can retain the subject from settlement. Diagnose at the fork seam before changing it.

## Where to start

- Read `PLAN.md`, `docs/verification-rebuild.md` (destination ledger; no non-boundary scenarios left), `docs/forks.md`, `docs/releases.md`, `docs/ci.md`.
- Recheck current main/PR heads and pins, then choose from item 8. Fetch the exact review SHA before dual reviews. Do not rerun the archived e2e suite or restart items 1-7.
