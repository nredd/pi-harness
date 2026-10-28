# @nredd/pi-preset

Published to npm as `@nredd/pi-preset` (public); `0.1.0` was the initial manual publication
(see `releases/2026-10-18-npm-publication.json`). Version `0.2.0` prepares footer-only adoption;
it must be published before configuring that pin. Nothing here changes a live Pi installation.

The full managed preset is still not a supported release: no installer, no profile resolver, no activation path exists yet.

Standalone plugin users are unaffected. This is deliberately opt-in policy, not a replacement
imposed on `@nredd/pi-dev-tools`, `@nredd/pi-session-kit`, or `@nredd/pi-subscription-router`.

Tested hosts: the package tests run on core `v1.3.0-nredd.7` (upstream `1.3.0` plus the fork's patch queue,
the release tarballs pinned in `devDependencies`); `make check-package-contracts` installs the packed
preset into exact stock Pi `1.3.0`. Peers are `*` per Pi's package rules.

## Install only the footer

After `0.2.0` is published, add this object to `settings.json`'s `packages` array:

```json
{
  "source": "npm:@nredd/pi-preset@0.2.0",
  "extensions": ["extensions/expanded-footer.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Pi's package-source filters narrow its declared resources. The native discovery test exercises
this exact filter against the real resource loader, without invoking a Pi binary.

**If pi-subagents is installed**, also set `"packageAgents": false` in `subagents.json` when
agents remain locally managed. Its package-agent discovery is separate from Pi's four resource
filters and otherwise still discovers this package's seven agents. This disables *all* packaged
agents, not local/global/project agents. If you need other packaged agents, use pi-subagents'
`packageAgents` allowlist naming only those packages, excluding `pi-preset`. Do not claim that
`skills: []` or `extensions` alone filters agents. Local agent precedence is not an exclusion.

Retire the old local `extensions/expanded-footer.ts` and `lib/footer-{cache,quota}.ts` through
your configuration manager in the same activation; loading both footers is unsupported. Keep
local themes, skills, agents and their configuration. Restart sessions after activation.

## Footer behavior and configuration

- TUI only, installed on `session_start`; print, JSON and RPC modes never mount it or poll.
- Cwd/home abbreviation, branch, session name; usage totals for assistant/tool-result messages,
  standalone usage, compaction and branch summaries; sorted, whitespace-sanitized statuses.
- Word labels when they fit with the selected model, compact labels otherwise. Every row is
  width-bounded, including provider, model and thinking-level labels. Context warnings are
  strictly above 70%/90%; `(auto)` is always displayed, not the live compaction toggle.
- Cost is shown for nonzero totals or subscriptions (OAuth or `kimi-coding`). The hit rate is
  from the latest prompt-bearing assistant on the current branch, not cumulative session totals.
- Cache temperature uses the model's positive finite `promptCache.short` in seconds, default
  300. One timer repaints at expiry plus 50ms. A low hit rate below 50% after a drop of at least
  10 points gets `idle>ttl`, `model-switch`, `compaction`, or `prefix-changed`, in that priority;
  compact markers shorten these words. Cache diagnostics never perform I/O or warm a cache.
- Optional router quota row: provider-scoped Anthropic/OpenAI 5h and weekly remaining quotas,
  floored/clamped to 0..100, `--` for unknown values, warning at <=20%, error at <=5%. Deferred
  startup, 60s polling, one outstanding request, unique reply channel, 12s timeout, expiry repaint,
  stale retained readings and recovery. Without a valid reply the row stays hidden. Disposal
  cancels listeners and timers; unreferenced default timers do not keep the process alive.

There is no footer config file, command, or custom settings key. It reads model metadata,
OAuth state, context usage, branch/session entries and footer data from Pi; home abbreviation
uses `HOME`, then `USERPROFILE`, then the OS home. It does not read `settings/personal-defaults.json`,
router configuration files, `cacheWarming`, or the persisted compaction setting.
See [the behavior comparison](../../docs/footer-port.md) for source references and migration boundaries.

## Contents

- `agents/`: `architect`, `code-reviewer`, `critic`, `debugger`, `general-purpose`, `researcher`,
  `verifier`. Declared in `pi.subagents.agents`, found through pi-subagents' package-agent
  discovery (the pinned fork; stock Pi ignores the key)
- `skills/`: `code-review`, `ship-issue`, `get-it-merged`, `coding-like-redd`. Discovered by Pi
  through `pi.skills`. `coding-like-redd` is explicitly opinionated (Python/Rust conventions of the
  author) and is public, opt-in content
- `extensions/expanded-footer.ts` with sibling `lib/footer-cache.ts` and `lib/footer-quota.ts`.
  The quota row stays hidden unless a `router:rpc:usage` responder (the subscription router) answers
- `themes/`: `belafonte-day`, `tokyonight-storm`. **Separately licensed**, see below
- `settings/personal-defaults.json`: reference data only. Pi does not read it from a package. A
  public-safe subset of the author's defaults: no `packages` pins, editor, shell, proxy, endpoint,
  path, or auth settings, and no router models
- `licenses/`, `NOTICE.md`: license texts and the theme change notices

Not included: global instructions (`AGENTS.md`), LAN, hardware, account, or credential details,
private manifests, `keybindings.json` (empty), and the machine skills `chezmoi-sync` and
the home-automation skills. Those stay in dotfiles.

## Licenses

The package is `MIT AND Apache-2.0 AND CC-BY-SA-4.0`. The root MIT `LICENSE` does **not** cover the
themes:

- `themes/tokyonight-storm.json`: Apache-2.0 (tokyonight.nvim), carrying the MIT notice of its Enkia origin
- `themes/belafonte-day.json`: CC-BY-SA-4.0 (Jan T. Sott), ShareAlike applies to the adaptation

Pi's theme schema forbids extra metadata, so the notices, sources, pinned revisions, and
per-color origin (upstream vs locally modified) are in [`NOTICE.md`](NOTICE.md). Ship it with the
themes.

## External dependencies (not vendored)

Declared in `package.json` under `piPreset.externalResources`, enforced by tests:

- Skills `codebase-design` (agent `architect`) and `diagnosing-bugs` (agent `debugger`), from
  `mattpocock/skills` (MIT) at the pinned revision. The package never ships them
- Extension `pi-dev-tools` (`@nredd/pi-dev-tools`), used by `architect`, `code-reviewer`, `critic`,
  `verifier`; and `pi-web-access`, used by `researcher`
- `code-review` mentions `/setup-matt-pocock-skills` and `docs/agents/issue-tracker.md`, both
  optional repo-local context

Agents select tools as `ext:pi-dev-tools/<tool>` and `extensions: [pi-dev-tools]`. The forked
pi-subagents strips the npm scope when it matches package names (`@nredd/pi-dev-tools` ->
`pi-dev-tools`). Do **not** change these to `ext:@nredd/pi-dev-tools/...`: the selector parser
splits on the first `/`, and a scoped string in `extensions:` is read as a path. Tests reject any
scoped selector.

## Models and roles

Agents carry no `model:` field. `code-review` keeps its explicit reviewer model,
`openai-codex/gpt-6.1-sol`, and `ship-issue` keeps its explicit `critic` models (`sonnet`,
`opus`). These stay as-is during the migration. The migration's own PR reviews continue to
select Sol explicitly; a future configurable role is not permission to substitute reviewers.

No preset agent pins `thinking:`. With no `thinking` on the `Agent` call, pi-subagents passes no level
to the child session, so pi picks it: the per-model setting, else `defaultThinkingLevel`, clamped to the
model (not the parent's live level if changed mid-session). An `Agent` call's `thinking` overrides
frontmatter, so callers can still ask for e.g. `high` per dispatch.

No `role:` references are introduced. Logical-role conversion needs strict required-role support
in the pinned pi-subagents fork (exact available candidates, no fuzzy/provider/parent fallback,
across dispatch, parking, and schedule paths). **Pending.** Enterprise role mapping and
acceptance are **pending** too. Public managed workflows must not be activated before then.

## Precedence and collisions

Local wins. Verified against real Pi 1.3.0 (`test/discovery.test.ts`) and the pinned
pi-subagents source (below):

- Skills: Pi keeps the first discovered skill of a name and reports the packaged one as a
  collision. A same-named skill in `~/.agents/skills` therefore shadows the packaged one. Any
  existing global copy of the four skills (and the `code-review` from `mattpocock/skills`, which
  shares the name) collides the same way
- Agents: package agents load first and any global (`~/.pi/agent/agents`) or project agent of the
  same name overrides them

Retirement of the old global copies is **not done here and must not be done by hand-deleting**.
Prerequisites, all before any activation: the old file is positively identified as an unchanged,
migrated copy of this package's content (hash match against a recorded source), modified files and
unrelated packages survive, the symlinked `mattpocock/skills` `code-review` is retired only when it
is exactly the known managed link, and it happens only during explicit activation.

## Evidence and what is pending

Executed in this workspace (see the gate below): preserved footer helper assertions, real interactive
footer scenarios (quota, cache, widths, lifecycle), headless mode bindings, static resource/schema/privacy/
dependency tests, `npm pack` allowlist/license tests, and real Pi 1.3.0 resource discovery in a temporary
`HOME`/agent dir with no live model calls or auth. Every test runs under Vitest and Bun.

Packed-tarball evidence (`make check-package-contracts`, see
[package contracts](../../docs/package-contracts.md)): the packed preset is audited against its
multi-license contract and installed alone. Child behavior of the `code-reviewer` agent (tools exactly
the read-only allowlist, denied tools refused, global/project overrides, untrusted project agents
ignored) is exercised against real children from these sources by
`integration/inprocess/{reviewer,specialists}.test.ts`.

Pending, not claimed: profile resolution, model roles, activation, the full assembled-stack check,
Bun compiled-artifact behavior, any other fork commit or Pi version, `pi install npm:@nredd/pi-preset` through a live Pi, and npm provenance attestation.

## Development

From the repository root:

```sh
npm ci --ignore-scripts
npm run check -w @nredd/pi-preset   # biome, strict tsc, full Vitest on Node and Bun 1.4.4
```

- `test/scenarios/`: real core `createInteractiveHarness`/`VirtualTerminal` footer scenarios and mode-correct headless binds, run under Vitest and Bun; no Pi process, tmux, timer preloads or wall-clock waits.
- `createExpandedFooter({ clock })` optionally injects one clock for deferred startup, quota polling/staleness and cache expiry. Its local `FooterClock`/`TimerHandle` interfaces mirror `packages/session-kit/src/clock.ts`: `now()` reads time; `setTimeout()` and `setInterval()` return handles owning `cancel()`. The default uses unreferenced real timers, 60s polls, 12s replies and the 50ms cache repaint margin.
- `test/*.test.ts` and support code are checked by strict TypeScript; preserved `test/footer-*.test.mjs` helper assertions stay JavaScript. Everything under `extensions/`, `lib/` and `test/` is Biome-formatted.
- The footer now differs from its [source snapshot](../../docs/source-provenance.md) by the optional factory/clock seam. `lib/footer-quota.ts` differs only by formatting; `lib/footer-cache.ts` remains byte-identical. The migrated helper tests use static sibling imports and Vitest instead of `node:test`.
- All live dotfiles helper assertions already exist here. `test/footer-render.test.ts` adds previously uncovered usage-entry totals, token-format boundaries, subscription detection, context warning thresholds, cwd/status handling and model labels. Footer-only adoption is independent of the deferred full profile split (#21). Once `0.2.0` is published and promoted, the dotfiles `remove-footer` change drops its own copy and only installs/configures this footer.

Discovery tests redirect `HOME`, `USERPROFILE`, `PI_CODING_AGENT_DIR`, `TMPDIR`/`TMP`/`TEMP`, `XDG_*`,
and `PI_OFFLINE` into a temporary directory (restored afterwards) and pass the agent dir explicitly.
They run in the test process, so a path Pi computed at import time would not be redirected; Pi 1.3.0
computes none of the ones used (see the comment in `test/discovery.test.ts`).
