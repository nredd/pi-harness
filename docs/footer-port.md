# Footer-only adoption

Comparison inputs: dotfiles `origin/main` `10ca8dd`,
`private_dot_pi/agent/extensions/expanded-footer.ts`, `lib/footer-cache.ts`, `lib/footer-quota.ts`
and `tests/footer-{cache,quota}.test.mjs`; pi-harness `origin/main` `1b2332d`,
`packages/preset/extensions/expanded-footer.ts`, `lib/` and `test/`.
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
| Quota protocol, parsing, rendering | `lib/footer-quota.ts`, all exports | same exports, formatting-only diff | None: provider/window names, floors, clamps, freshness/merge, 20/5 colors, error/timeout retained values, expiry, 60s/12s, unique channels, single flight |
| Deferred startup | `:82-91`, zero-delay startup timer, cancelled on dispose | same `:125-139` using injected clock | Same behavior, clock seam only |
| Quota timers | helper default Node timers remain referenced | footer passes clock timers, default clock unrefs all handles | Preset timers do not keep Node alive; no visual/poll cadence change |
| Statuses | `:252-262`, sorted keys, whitespace normalized, clipped row after quota | same `getExtensionStatuses` block | None |
| Settings/config | no custom config keys/files; runtime model metadata including `promptCache.short`, OAuth, thinking level, context, footer/session data, home env | same | None; neither reads preset reference settings, cacheWarming, router JSON or compaction JSON |
| Factory/API | default extension function only | `createExpandedFooter({ clock })` plus default real-clock instance | Preset adds deterministic embedding/test seam; no required config |
| Helper tests | `tests/footer-cache.test.mjs`, `tests/footer-quota.test.mjs` | `test/footer-cache.test.mjs`, `test/footer-quota.test.mjs` | All assertions preserved; static sibling imports and Vitest replace path-based import and node:test, formatting only otherwise |
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
   `0.1.0` was published manually. Existing package ownership is sufficient; publication through
   this workflow has not yet been demonstrated for preset.
2. Publish `@nredd/pi-preset@0.2.0` through the existing release workflow and verify registry
   integrity/provenance. No publication is performed by this change.
3. Replace the dotfiles placeholder pin and inventory version, then update the assembled selection
   and root planning docs through the owner's separate pin work. Require the matching CI gates.
4. Apply dotfiles only AFTER publication: resource filters, package-agent gate and explicit chezmoi
   retirement of the three old footer files land together. Tests move, user configuration stays.
   Restart Pi and require `pi-profile doctor` green. Do not activate both implementations.

## Local gate evidence

- `npm run check -w @nredd/pi-preset`, pinned Bun 1.3.14 on PATH: Biome/strict tsc clean,
  126 Vitest tests and 126 Bun tests passed. This includes all preserved helper assertions,
  real-host footer scenarios, the new renderer contracts and resource-filter discovery.
- `make check-ts`: passed across every workspace, including 61 Vitest and 61 Bun in-process
  stack tests. The first attempt failed because the fresh worktree had no fork files; initializing
  pi-subagents, pi-plan-mode and rpiv-todo at their unchanged Gitlinks fixed it. No fork edits.
- Dotfiles `node --test tests/*.test.mjs`: 157 passed, 0 failed, 3 existing platform skips
  (PTY and Windows interop). Includes positive/negative doctor fixtures, both rendered profiles
  and explicit retirement paths. No applied machine configuration was used as a test fixture.

No live Pi, assembled process scenarios, benchmark, tag, publication, push or machine activation
is claimed. Separate mandatory reviewer reports and CI remain the owner's pre-merge gates.
