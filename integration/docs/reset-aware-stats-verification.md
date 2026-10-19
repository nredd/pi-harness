# Reset-aware routing and global hourly stats

Historical release receipt, not current gate instructions. The router shell runner is retired;
all 13 case destinations are recorded in `docs/verification-rebuild.md`. Use the monorepo native
checks and CI assembled-stack gate described in `docs/ci.md`, not the old commands below.

The release changes `pi-subscription-router`, `pi-session-kit`, and chezmoi together. Testing only
one extension does not verify the installed behavior.

Release bases:

- Router: `54d5746` (`v0.2.2`).
- Session kit: `04846cf` (`v0.2.7`).
- Dotfiles: `e63439e`.
- Harness: `e796037`.

Required gates:

1. Run `npm run check` in both extension repos and `e2e/run.sh all` in the router.
2. Build and execute the portable stats exporter without Pi or private extension dependencies.
3. Run the complete dotfiles Node suite, including actual exporter/sync-helper tests against a local
   bare Git remote. Temporary machine identities, source histories and Git remotes must not use
   live credentials or the real `pi-usage` branch.
4. Run `HARNESS_LOCAL=pi-subscription-router,pi-session-kit make verify` in this repo. This includes
   static, integration, real tmux, slow scenarios and benchmarks; focused tests are iteration only.
5. Review each change set on Standards and Spec axes, using the approved spec in the router repo's
   `docs/reset-aware-stats-plan.md`. Fix blocking findings and rerun affected gates.
6. Push code, release both extensions as `v0.3.0`, pin them through chezmoi, and apply/install.
7. Run full `make verify` again without local overrides. Confirm installed pins match source pins
   and `chezmoi diff --recursive ~/.pi` is empty. Existing sessions need restarting.

`verify-live` remains separately opt-in. Baselines and scenario markers must not be relaxed to get
this change through.

Behavior checked:

- Balance any number of normalized subscription providers using the tightest applicable reset-aware
  headroom. New user prompts need a strictly greater than 20% improvement before switching a
  measured incumbent; continuations/direct calls stay sticky. Soft scores never become hard blocks.
- Sum real call timestamps into hourly 5h/24h charts, including partial and empty hours, without
  changing the totals or token accounting. Local-time labels distinguish repeated DST hours.
- Combine current local Pi history with cached usage-only snapshots from other machines. Opening
  `/stats` performs no network work. Coverage and sync age remain visible, including never-synced
  and incomplete imports.
- Preserve history across cache migration and session pruning. Strong event identities distinguish
  equal-valued independent calls and deduplicate actual copied/forked calls across machines.
- Sync only on full chezmoi application or explicit `pi-usage-sync`. The isolated data checkout never
  changes the normal dotfiles checkout. Offline, push, signing and malformed-data failures retain
  recoverable local state, without force-push or disabled hooks.
- Export work-machine usage with the standalone artifact, without installing the personal kit or
  router. Snapshots contain counters and opaque identities, not transcript text, paths or secrets.

Machine enrollment happens on each machine's next full `chezmoi apply` / `chezmoi update`. A viewer
cannot include activity that another machine has not yet exported, or that it has not yet fetched.
Provider quota endpoints already account for other clients on the subscription; global stats never
feed back into routing.

Iteration findings:

- Background runners need `$HOME/.pi/agent/bin` on `PATH` so offline reviewer `find` can use the
  installed `fd`. The unchanged reviewer integration passed once that prerequisite was supplied.
- The first full TUI/benchmark pass found an incorrect machine-count assertion: it searched for
  `machines ... 3`, accidentally accepting a digit in the sync timestamp. The rendered counter was
  correctly `3 machines`. Assert that exact counter instead; the focused scenario passes.
- Router normalization needs its own floating-point error allowance near exhaustion. A red/green
  regression covers exact 20% pairs including 99.9%/99.88%, across full, half and floored reset
  windows, while preserving genuinely better challengers and tiny direct scores.
- The Standards review required pre-export outbox symlink isolation and recommended sharing local
  and combined session metadata merging. The Spec review required real bundled-exporter failure and
  concurrency cases, not only protocol-stub tests. Both blockers and the merge judgement were
  resolved with regression coverage before the final full-gate rerun.
- The first actual full apply exposed nested `chezmoi source-path` failing under the parent's
  state lock. Prefer the supplied `CHEZMOI_SOURCE_DIR`, retaining CLI discovery for manual calls.
  A red/green real full-apply regression installs and runs the actual helper/bundle without source
  or exporter overrides, repeats sync, and checks unchanged source bytes/index/HEAD. The patched
  full apply then exported, pushed and imported successfully without warnings or coverage problems.
- The first installed full gate passed 131 static/integration and 121 TUI/benchmark scenarios but
  failed `ms_input_p95_n4`: 11.024 ms against the unchanged 9.903 ms limit. Focused installed/local
  runs measured 9.923/9.611 ms; individual cells varied from 5.84 to 11.99 ms. Code trees and host
  SDK resolution were identical. The complete unchanged installed rerun passed all 122 TUI/benchmark
  scenarios with no concurrent agent/diagnostic work. No baseline, threshold or scenario was changed;
  these observations establish timing variance, not a proven production-code cause.

Final review:

- Standards (`openai-codex/gpt-6.1-sol`): No findings.
- Spec (`openai-codex/gpt-6.1-sol`): No findings.
- The source-discovery follow-up received both reviews on the same model: No findings.

Source gates:

- Router: `npm run check`, 115 tests; `e2e/run.sh all`, 13 scenarios.
- Session kit: `npm run check`, 508 tests, including reproducible standalone bundle checks.
- Dotfiles: complete Node suite, 109 passed and 3 platform-only skips; strict helper typecheck,
  Biome, ShellCheck and syntax checks clean. The vendored artifact matches kit `dist` byte for byte.
- Both extension production dependency audits: zero vulnerabilities.
- Actual live export/sync/import succeeded with no coverage problems and a signed data commit;
  the normal dotfiles source checkout stayed on `main`. Full chezmoi dry-run left the data branch
  unchanged.
- Full source `HARNESS_LOCAL=pi-subscription-router,pi-session-kit make verify`: exit 0 in
  26m13s, 131 static/integration passed, 1 expected no-enterprise skip, and all 122 real TUI,
  slow and benchmark scenarios passed. No baseline or scenario marker was relaxed.

Installed gates:

- Signed `v0.3.0` tags: router `5454e65`, session kit `6323d99`. Both are pushed, managed pins are
  applied, and installed checkout HEADs match the tag commits. Pi's tag fetches need not create a
  local tag ref, so compare commit identities rather than relying on `git describe`.
- Full `make verify` with both `HARNESS_LOCAL` and `PI_BIN` unset: exit 0 in 26m18s, 131
  static/integration passed, 1 expected no-enterprise skip, and all 122 real TUI, slow and benchmark
  scenarios passed, including the previously failed multi-session benchmark.
- Installed `/stats` print mode exercised actual local history and displayed machine/sync coverage.
  The actual full-apply sync hook succeeded. Applied helper and portable artifact match their sources;
  `chezmoi status --include=files` and `chezmoi diff --recursive ~/.pi` are empty.
- All four source repositories and the data checkout are clean and pushed. Restart existing Pi
  sessions to load the releases; other machines enroll on their next full apply/update or manual sync.
