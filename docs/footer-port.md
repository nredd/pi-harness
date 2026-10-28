# Footer-only adoption

Comparison inputs: dotfiles `origin/main` `bb7297f`,
`private_dot_pi/agent/extensions/expanded-footer.ts`, `lib/footer-cache.ts`, `lib/footer-quota.ts`
and `tests/footer-{cache,quota}.test.mjs`; pi-harness `origin/main` `aa5826f`,
`packages/preset/extensions/expanded-footer.ts`, `lib/` and `test/`. The preset pins the
core `v1.3.0-nredd.7` tarballs.
Paths below are relative to those directories unless otherwise stated.

## Behavior comparison

| Behavior | Live dotfiles | Preset before this change | Difference |
| --- | --- | --- | --- |
| Mount/modes | `extensions/expanded-footer.ts:69-81`, TUI `session_start` only, shutdown stops quota | same in `createExpandedFooter`, `:101-125` | None |
| Cwd, home, branch, session | `formatCwd`, `:111-118`; HOME/USERPROFILE/OS fallback, width clipping | same `formatCwd`, render `:160-167` | Formatting only |
| Usage totals | `emptyTotals`/`addUsage`, render `:120-134`; assistant, tool result, standalone usage, summaries, compaction | same helpers and `:169-183` | None; intentional inclusion of tool-result usage preserved, not replaced with `/stats` accounting |
| Cache | `lib/footer-cache.ts`, `analyzeCache`, `cacheTtlSeconds`, `formatCacheMarker` | byte-identical | None: latest branch prompt, TTL 300/default, >=10-point drop below 50%, cause priority idle/model/compaction/prefix, full/compact markers |
| Cache repaint | `:92-101`, one timeout at expiry +50ms, unref | `scheduleCold`, `:141-151`, injectable timeout | Same deadline, clock seam only |
| Context | `:140-177`, context API/model fallback, >70 warning, >90 error, unconditional auto suffix | same `:192-229` | None; neither reads the live compaction toggle |
| Token/cost/subscription | `formatTokens`, `buildParts`, `:143-150`; OAuth or kimi-coding | same `formatTokens`, `buildParts`, subscription detection | None |
| Model/provider/thinking | `:193-239`, minimum two cells padding; provider only when it fits | same `rightSideBase`/`buildLine` | None |
| Full/compact tier and clipping | `:178-244`, word labels only if untruncated with model | same `buildParts`/`buildLine`/`fitsUntruncated` | None |
| Quota protocol, parsing, rendering | `lib/footer-quota.ts`, all exports | same exports plus `formatResetAt`/`fitQuotaRows`; changed: OpenAI 5h hidden, reset times, provider-wrapped narrow rows | Intentional: OpenAI has no 5h window, rows carry reset times and wrap by provider when narrow. Unchanged: Anthropic/OpenAI weekly window names, floors, clamps, freshness and the per-field stale merge of percents (a reset or identity now travels with its percent), 20/5 colors, error/timeout retained values, expiry, 60s/12s, unique channels, single flight |
| Deferred startup | `:82-91`, zero-delay startup timer, cancelled on dispose | same `:125-139` using injected clock | Same behavior, clock seam only |
| Quota timers | helper default Node timers remain referenced | footer passes clock timers, default clock unrefs all handles | Preset timers do not keep Node alive; no visual/poll cadence change |
| Statuses | `:252-262`, sorted keys, whitespace normalized, clipped row after quota | same `getExtensionStatuses` block | None |
| Settings/config | no custom config keys/files; runtime model metadata including `promptCache.short`, OAuth, thinking level, context, footer/session data, home env | same | None; neither reads preset reference settings, cacheWarming, router JSON or compaction JSON |
| Factory/API | default extension function only | `createExpandedFooter({ clock })` plus default real-clock instance | Preset adds deterministic embedding/test seam; no required config |
| Helper tests | `tests/footer-cache.test.mjs`, `tests/footer-quota.test.mjs` | `test/footer-cache.test.mjs`, `test/footer-quota.test.mjs` | `footer-cache` assertions preserved. `footer-quota` assertions preserved except the OpenAI 5h and row-text expectations, changed for the quota reset change; new reset/DST/width tests added. Static sibling imports and Vitest replace path-based import and node:test |
| Host coverage | no renderer assertions in the two dotfiles helper suites | `test/scenarios/footer-{cache,quota,headless}.test.ts` | Preset additionally exercises real core renderer, resizing, lifecycle, modes, polling and cache causes under Vitest and Bun |

No missing live implementation was found, so no duplicate code or new quota/accounting owner was
introduced. This release retains the existing port and adds direct renderer contracts for previously
untested usage types, numeric formatting boundaries, context thresholds, subscription selection,
cwd/status normalization and model/provider/thinking labels (`test/footer-render.test.ts`).

## Placement

Keep the footer in the already-public `@nredd/pi-preset`, minor `0.2.0`. It already owns all three
implementation files, the preserved helper tests and native renderer scenarios. Session-kit owns
session features and physical usage statistics; subscription-router owns quota acquisition and
admission. Neither should gain a second footer implementation or a dependency on the other merely
to display event-bus snapshots. No new npm name or owner bootstrap is needed.

Pi `docs/packages.md` (Select package resources) and `docs/settings.md` (Resources) support an
object source with `extensions: ["extensions/expanded-footer.ts"]`, `skills: []`, `prompts: []`,
`themes: []`. `test/discovery.test.ts` verifies this through the real core loader in a sandbox.

Important limit: the pinned pi-subagents `v0.22.0-nredd.5` reads `pi.subagents.agents` independently
in `src/package-resources.ts` (`configuredPackages`, `listPiPackages`, `scan`). It takes installed
roots from `DefaultPackageManager.listConfiguredPackages`, not Pi's resource filters. Filters alone
therefore do NOT make this a footer-only install. Dotfiles also sets `packageAgents: false` in its
`subagents.json` while local agents stay authoritative. Consumers of other packaged agents can
instead allowlist those packages. No fork change or unsupported fifth resource filter is required.

## Ship order

1. Review/merge this branch and pass package/TypeScript and release CI. Configure the existing npm
   package's trusted publisher for this repository's `publish.yml` if not already configured:
   `0.1.0` was published manually. DONE: the trusted publisher was already configured, and item 2
   proved publication through this workflow.
2. DONE: `@nredd/pi-preset@0.2.0` published through `publish.yml` (run 39506908135) from signed tag
   `@nredd/pi-preset@0.2.0` at `e18831a`; registry integrity equals `identity.json`, with SLSA provenance.
3. DONE, this PR: the personal stack pins the published filtered preset `0.2.0` first, matching
   dotfiles' package position, with CI assertions. `stack (personal)` installs it from npm; do not
   skip installation failures or silently test a local preset in its place.
4. Apply dotfiles only AFTER publication: resource filters, package-agent gate and explicit chezmoi
   retirement of the three old footer files land together. Tests move, user configuration stays.
   Restart Pi and require `pi-profile doctor` green. Do not activate both implementations.

## Stack promotion

`integration/stacks/personal.json` carries the exact filtered `npm:@nredd/pi-preset@0.2.0` object
in first position. Because `0.2.0` is published, the personal stack jobs install it from npm;
do not skip them or substitute local code.

`local.json` stays full/unfiltered to cover the whole preset. It should not mirror the personal
filter: both selections need CI evidence. The fixture policy sets `packageAgents: false` whenever a stack
contains a filtered object source (`sandbox.subagents_policy`), derived from content, not the stack
name. For personal this matches dotfiles, which sets it unconditionally on every profile; `local`
intentionally keeps package agents to cover the full preset. `scenarios/test_stack.py::test_preset_resource_selection` checks the exact first
personal entry and actual host resource resolution, with no preset skills/prompts/themes; the
registered Agent schema must expose only built-in types, not preset specialists. Local must
expose all preset resources and specialist types. Tool-name goldens do not change (no footer tools).
`scenarios/tui/test_footer_resize.py` now uses ONLY the selected stack's installed preset, proving
the published personal footer renders without injecting a local copy. These scenarios run in the
existing CI `stack` job; they were deliberately not run locally.

Gate (rebased onto `e18831a`): `make check-integration` clean, 123 Python unit tests and 15 Node
probe tests passed; `make check-scripts` 457 passed; `make check-ts` exit 0 (preset 126 Vitest at that time, HISTORICAL; 62 in-process
stack tests). No scenario pytest, Pi binary or tmux was invoked locally; the CI `stack` jobs are the gate.

## Local gate evidence

- `npm run check -w @nredd/pi-preset` with the pinned Bun 1.3.14 (`.bun-version`) on PATH: Biome/strict tsc clean,
  126 Vitest tests and 126 Bun tests passed (HISTORICAL count at the original port; the current suite is 156 on each runtime after the quota reset change). This includes all then-preserved helper assertions,
  real-host footer scenarios, the new renderer contracts and resource-filter discovery.
- `make check-ts`: passed across every workspace, including 62 Vitest and 62 Bun in-process
  stack tests. The first attempt failed because the fresh worktree had no fork files; initializing
  pi-subagents, pi-plan-mode and rpiv-todo at their unchanged Gitlinks fixed it. No fork edits.
- Dotfiles `node --test tests/*.test.mjs`: 157 passed, 0 failed, 3 existing platform skips
  (PTY and Windows interop). Includes positive/negative doctor fixtures, both rendered profiles
  and explicit retirement paths. No applied machine configuration was used as a test fixture.

No live Pi, assembled process scenarios, benchmark, tag, publication, push or machine activation
is claimed. Separate mandatory reviewer reports and CI remain the owner's pre-merge gates.

## Quota reset change gate (current)

- Quota rows: OpenAI weekly only, reset date/time from router `windows[].resetAt` in the process-local
  timezone (tests inject `timeZone`/clock), and router `spanSource` (`reported` | `assumed`) decides OpenAI
  window identity. An assumed-only OpenAI window renders as `quota ... (window unknown)`, never 5h or weekly.
- Current counts (this change): preset 156 Vitest + 156 Bun; router 209 Vitest + 209 Bun. The 126 above is historical.
- NOT run: real Pi binary, tmux scenarios (`integration/scenarios/tui/test_footer_resize.py`), live provider
  payloads. No captured real Codex payload exists in-repo; weekly-only support rests on the documented
  `limit_window_seconds` contract and router fixtures, not a live capture.
- Istanbul (provider `@vitest/coverage-istanbul@5.0.3`, Vitest 5.0.3, Node 26.12.0, reused from an untracked
  `/tmp` install and symlinked into the ignored worktree `node_modules`; no dependency, config or lock change)
  over `lib/**` + `extensions/**`: see the PR comment for before/after totals. Primary coverage policy stays with #162/#190.
