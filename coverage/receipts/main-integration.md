# Main integration checkpoint

Branch `coverage-phase0`, starting `580917f`, merges `origin/main` `6d7b13cb` without
rebasing or force-pushing. No other worktree, runtime pin, publication or live install changed.

Conflict decisions:
- Retain main's shared home guards, injected fixtures and spawn-time-home Vitest launchers.
- Retain Phase 0's independent report paths, text/LCOV reporters, accounting and CI artifacts.
- Combine subagents' native Bun coverage subset with main's guarded real-loader canary; disable
  coverage for the canary so it cannot replace Node's primary report with a one-file Bun run.
- Pin Vitest/Istanbul to matching `5.0.3` in the mixed-loader packages. Preserve the lockfile's
  published sampler `0.1.1` integrity entries for dev-tools/session-kit, rather than silently
  substituting the workspace implementation during dependency resolution.

Provider decisions:
- Primary Istanbul: subagents (existing), plan-mode, todo and preset (mixed-loader V8 corruption).
- Other primary producers retain V8; import-audit/probes retain c8. Broader consolidation is separate.
- Full-suite Bun Istanbul: subscription-router, preset, resource-sampler, todo and inprocess.
  The shared launcher, sampler's one-worker cap and todo's config selection remain intact.
- All Bun signals remain report-only. Full producers use the complete explicit primary source
  inventory, including newly added sampler `src/darwin.ts`; subagents primary also inventories
  `home-paths.ts`, `model-tiers.ts`, `resource-loader.ts` and `ui/fleet-state.ts` from main.
- Node stays primary. No engine counters or OS counts are combined. No global target flip.

Scope:
- Eight eligible packages retain enforced primary measurements, except dev-tools pending below.
- Eligible runtime build tooling/workflow examples remain pending blockers; no eligible source
  was hidden by the owner scope correction.
- Verification helpers/probes/import-audit/inprocess are report-only, with explicit reasons.
- Computer-use is owner-excluded from coverage maintenance but fully inventoried; existing
  platform/native checks remain. Python retains existing tests, outside the eight-package goal.

Dependencies and measurements:
- PR #155 remains OPEN at `4322d5fb623782720dc45dbcfb7ece5d70464dc1` when inspected.
  Dev-tools stays measurement-pending; do not establish a baseline from failed cargo producers.
- Historical hosted floors in `policy.json` and `hosted-platforms.md` precede this merge/provider
  change. They have NOT been relabeled as current measurements. Current source/provider
  macOS + Linux artifacts and their replay are still required, including complete full-Bun
  inventories and updated primary counts for all changed source. Local receipts are advisory only.
- The repository pins Bun `1.3.14`; workstation PATH has `1.4.4`. Local verification uses downloaded
  official `bun-darwin-aarch64.zip` SHA-256
  `d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620`, not the workstation Bun.

Local gates (advisory macOS, Node 26.12.0, pinned Bun 1.3.14):
- `npm ci --ignore-scripts`: passed with matching lockfile and preserved published sampler pins.
- `make check-scripts`: passed, Ruff format/lint, ty, 861 pytest tests, strict import-audit
  TypeScript/Biome checks and 8 real Node tests. Includes schema validation, source traversal,
  producer inventories and new owner-scope regressions. An earlier npm-pack fixture aborted
  once with signal 6; the subsequent two full script-suite runs passed that fixture.
- All workspace TypeScript checks passed. Root `npm run lint --workspaces` is not a valid complete
  gate (computer-use and plan-mode have no `lint` script); actual package checks below run their
  declared lint/format gates. Dev-tools emits four existing informational template-literal notices.
- Full package `check` passed for router (206 primary/full Bun tests), preset (127 each), sampler
  (39 each), todo (390 each), inprocess (91 each), plan-mode (539 primary, 8 dist, native subset),
  subagents (3448 primary passed/8 skipped, native subset plus 10 guarded canary tests) and
  session-kit (718 primary plus 74 native Bun scenarios). No assertions or timeouts were weakened.
- Dev-tools check failed its three known cargo integration cases (380 passed/3 failed); Bun step
  was not reached. Its emitted failed-run report remains diagnostic and is not a baseline.
- `make check-coverage BASE=origin/main`: fails closed, as expected for this checkpoint. Current
  local primary misses exceed old hosted floors: sampler 72/6, session-kit 111/31, subagents
  507/72 (lines/functions). Do NOT raise floors from these local receipts.
- Plan-mode Istanbul omits pure re-export barrels `src/index.ts` and `src/interactive-ui.ts`
  from LCOV. They remain owned and in instrumentation includes; accounting reports missing
  expected files. No exclusion or fabricated zero-counter record hides this producer limitation.
  Complete-source producer evidence is still required before accounting can pass.

This is a pushed integration checkpoint, not a passing repository-gate or 100% claim.
