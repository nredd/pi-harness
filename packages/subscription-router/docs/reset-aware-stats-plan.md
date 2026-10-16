# Reset-aware routing and hourly, cross-machine Pi stats

Approved implementation specification, 2026-10-13.

## Routing

Add per-profile `strategy: "ordered" | "balanced"`, default ordered. Personal default/deep opt into balanced through chezmoi without changing models/thinking/exhaustion policy. Add optional UsageWindow.durationMs, populated by Anthropic known durations and Codex reported durations (legacy positional fallback if absent). Selection must be provider-neutral and support N providers.

For every eligible model and applicable provider/family window: remaining = 1 - usedPercent/100; timeLeft = clamp((resetAt-now)/durationMs, .05, 1); score = remaining/timeLeft. Missing usable reset/duration uses timeLeft=1; passed reset windows are ignored. Model score is the minimum applicable window score. Fresh unlimited > fresh measured > missing/stale/failed/empty fallback. Ties use chain order. A balanced new user prompt keeps an eligible measured incumbent unless the challenger is STRICTLY >20% better; promotes an unmeasured incumbent to measured, retains incumbent if all unmeasured. Eligible continuations and direct requests stay sticky. Existing ordered routing, retry confirmation, recovery, credentials, hard blocking, stale exhausted protection and parking policies remain unchanged. Balancing never blocks quota or adds network I/O. Use the same selection in route/recovery/admission/status. Status explains score, limiting window, fallback reason. No volatile score in prompts. Adding provider 3 only requires normalized collector and chain entry, no new algorithm. Unknown collectors stay fallback usable. No third-vendor integration/footer redesign.

## Hourly stats

Retain All/7d/30d; add rolling 5h/24h with `r`, default All, compact labels. Short-range chart sums original call timestamps into one-hour buckets, zero filling, labeling partial edges. Same time filter feeds chart/model/overview totals. UTC instants, viewer-local labels distinguishing repeated DST hours using UTC offsets. Ignore future calls. Retain daily long-range chart/heatmap, current styling, numeric precision, token math and exclusions (faux, router, tool-result and compaction usage).

## Global stats and identities

`/stats` combines fresh local scan with cached machine snapshots, NEVER network I/O. Show machine coverage, last remote sync, explicit local-only/never-synced state. Snapshot allowlist: schema version, persistent per-install UUID/label, exportedAt, opaque session/event IDs, timestamps, raw provider/model, token counts, notional cost, child-session metadata. NEVER export text, arguments, paths, session names, environment or credentials. UUID stays local outside synced data. Monthly per-machine shards and manifest preserve deleted local history.

Identified event fingerprint covers preserved assistant entry ID, timestamp, raw model/provider and counters. Distinct entry IDs remain distinct despite equal usage. Legacy no-ID records retain existing tuple fingerprint; discard legacy duplicate when identified counterpart exists. Session metadata dedup separately; children excluded from session count. Migrate cache without losing deleted-file history, reparsing available legacy files for IDs. Strictly validate imports; bad/unsupported snapshots retain last-good data and show incomplete coverage. Atomic imports prevent mixed reads.

## Chezmoi sync

Use a `pi-usage` data-only branch in existing private dotfiles repo. Independent checkout `~/code/pi-usage-data`, NEVER switch/stage/commit normal chezmoi source. `pi-usage-sync` manually callable and plain run_after_ hook on FULL chezmoi apply/update. No service/DB/timer/per-turn upload. Export local, fetch data branch, update own files, commit/push, then atomically import all machines. Lock local runs, retry concurrent non-FF pushes up to 3 times via fetch/rebase, never force push or bypass signing/hooks. Bound network work to 60 seconds. Failures retain exports/imports; manual helper nonzero, hook warns and does not break config apply. Dry run has no sync. Portable bundled CLI MUST share kit parser/identity implementation, distributed in dotfiles so work producers need no private kit/router install. Enroll on each machine's next full apply, no SSH provisioning. Remote data is stale until producer and viewer each sync. Local usage always fresh.

## Verification and shipping

Router unit coverage: short/weekly bottlenecks, reset timing/floor, missing metadata, family limits, weekly-only, >=3 providers, ties, >20% boundary, unlimited, stale/missing, fallbacks, pure status/admission, existing confirmation/recovery/parking. Faux E2E adds balanced 3-provider route, prompt switching, continuation stickiness and fallback, all in e2e/run.sh all.

Stats tests: hour boundaries, partial/midnight/DST, inactive hours, future timestamps, total invariance, cache migration/deleted history, copied/fork/multi-machine dedup, legacy/strong matching, distinct identical-value events, corrupt import retention. Actual bundled CLI + actual sync helper against bare Git with multiple machines: concurrent/offline/rejected pushes, signing failures, repeat sync, isolation, atomic imports, unchanged dotfiles main, absence of secrets/paths/text. Harness tmux 60..320 columns, both tabs, resize/scroll/filter/close/Plan mode/freshness/footer and work-profile producer without personal extensions.

Update behavior docs in every repo and Pi inventory/runbook. Gate both extension npm run check, router E2Es, portable build and full dotfiles tests. REQUIRED full HARNESS_LOCAL=pi-subscription-router,pi-session-kit make verify (static, integration, real tmux, slow, benchmarks; no weakened baselines), then two-axis Standards/Spec review, blockers fixed/re-gated. Commit/push all changed repos, release BOTH extensions v0.3.0, bump/apply/install pins, full make verify AGAIN with no overrides, empty managed Pi diff, report restart required. verify-live stays opt-in. No paid service. Routing quota endpoints include account-wide use; stats is NOT router input.
