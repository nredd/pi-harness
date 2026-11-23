# @nredd/pi-preset

Published to npm as `@nredd/pi-preset` (public). This package is the canonical source of the
generic agent and workflow skill definitions below. Deployments select resources explicitly;
it is not an automatic machine-configuration installer.
Releases use the monorepo [publication workflow](../../docs/releases.md); the initial `0.1.0`
manual-publication receipt is `releases/2026-10-18-npm-publication.json`.

The full managed preset is still not a supported release: no installer, no profile resolver, no activation path exists yet.

Standalone plugin users are unaffected. This is deliberately opt-in policy, not a replacement
imposed on `@nredd/pi-dev-tools`, `@nredd/pi-session-kit`, or `@nredd/pi-subscription-router`.

Tested hosts: the package tests run on core `v1.3.0-nredd.10` (upstream `1.3.0` plus the fork's patch queue,
the release tarballs pinned in `devDependencies`); `make check-package-contracts` installs the packed
preset into exact stock Pi `1.3.0` and loads its footer and skills through that host's resource loader. Peers are `*` per Pi's package rules.

## Install only the footer

For published `0.4.0`, add this object to `settings.json`'s `packages` array:

```json
{
  "source": "npm:@nredd/pi-preset@0.4.0",
  "extensions": ["extensions/expanded-footer.ts"],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Pi's package-source filters narrow its declared resources. The native discovery test exercises
the workspace's `src/index.ts` filter against the real resource loader, without invoking a Pi binary.
The example above remains the published `0.4.0` filter. Workspace builds now declare
`./src/index.ts`; change the promoted filter to `src/index.ts` only when promoting a new
preset version containing that entry. Do not apply the new filter to published `0.4.0`.

**If pi-subagents is installed**, also set `"packageAgents": false` in `subagents.json` when
agents remain locally managed. Its package-agent discovery is separate from Pi's four resource
filters and otherwise still discovers this package's eight agents. This disables *all* packaged
agents, not local/global/project agents. If you need other packaged agents, use pi-subagents'
`packageAgents` allowlist naming only those packages, excluding `pi-preset`. Do not claim that
`skills: []` or `extensions` alone filters agents. Local agent precedence is not an exclusion.

Retire the old local `extensions/expanded-footer.ts` and `lib/footer-{cache,quota}.ts` through
your configuration manager in the same activation; loading both footers is unsupported. Keep
local themes, skills, agents and their configuration. Restart sessions after activation.

## Select the shared agents and skills

After `0.5.0` is published, select `npm:@nredd/pi-preset@0.5.0` unfiltered in
`settings.json`'s `packages` (or a stack's `sources`) to load the footer, skills and themes.
To keep themes disabled, use:

```json
{
  "source": "npm:@nredd/pi-preset@0.5.0",
  "extensions": ["src/index.ts"],
  "skills": ["skills/**"],
  "prompts": [],
  "themes": []
}
```

Separately set `"packageAgents": ["pi-preset"]` in the deployment's `subagents.json`,
or use `true` to allow all declaring packages. Remove `packageAgents: false`; Pi's resource
filters do not control agents. The manifest already declares `pi.skills: ["./skills"]` for
Pi and `pi.subagents.agents: ["./agents"]` for pi-subagents. No copying is needed.

While local copies and the widened selection overlap, the copies stay in charge: a global skill of the same
name wins and Pi reports the packaged one as a `collision` diagnostic, and a global agent file
(`<agentDir>/agents/<name>.md`, matched by its declared `name:`) silently replaces the packaged agent of that name. Once the copy
is removed the packaged definition loads. Both rules are tested in `tests/discovery.test.ts`.
So widening the selection before the copies go changes nothing those copies define, while
retiring copies before the widened release is selected removes those agents and skills.
A project agent file (`.pi/agents/<name>.md`) shadows the packaged agent the same way, but only when the project is trusted. After cutover, discovery is duplicate-free only when the skill diagnostics contain no `collision` and no global or trusted-project agent file declares a packaged agent's name (the frontmatter `name:`; the filename only matters when `name:` is absent).

Retire duplicate generic definitions through the deployment's configuration manager only
when the selected release is published and available. Keep machine-local agents, skills,
third-party skill installs and `AGENTS.md` local. Do not remove working local copies before
the replacement package is selected. Publication, stack promotion and activation are separate
steps; a version bump alone changes none of them.

Keep `agentModels` and `modelTiers` in each user's own `subagents.json`, not this package.
Model precedence is: explicit dispatch parameter -> `agentModels[type]` -> `agentModels["*"]`
-> definition `model:` -> parent. Thus even a wildcard binding outranks a definition's model.
The built-in `Explore` already requests `@cheap`; no duplicate Explore definition is needed.
Bind that tier locally, and keep any intentional `agentModels["Explore"]` binding locally too.

## Footer behavior and configuration

- TUI only, installed on `session_start`; print, JSON and RPC modes never mount it or poll.
- Cwd/home abbreviation, branch, session name; usage totals for assistant/tool-result messages,
  standalone usage, compaction and branch summaries; sorted, whitespace-sanitized statuses.
- Unpriced usage keeps its tokens but contributes no invented spend: mixed totals show the priced
  subtotal plus `N unpriced`; wholly unpriced totals show `unknown`, including on subscriptions.
  Free requests with billable tokens count as priced; zero-usage failures count as neither.
- Word labels when they fit with the selected model, compact labels otherwise. Every row is
  width-bounded, including provider, model and thinking-level labels. Context warnings are
  strictly above 70%/90%; `(auto)` is always displayed, not the live compaction toggle.
- Virtual selections keep the selected profile/level, then show `-> (provider) model` from the
  actual assistant request metadata. The dispatched thinking level appears only when core records
  it, never copied from the selected level. Pending requests show `(routing)` until physical
  metadata arrives; idle selections with no attributed request show `(unresolved)`. Physical errors
  and cancellation show `(error)` / `(aborted)` beside the attempted model. A routing failure never
  reuses an older physical label. Each TUI `turn_start` appends a non-context
  `preset:footer-request` entry with no identity or payload data. A response is attributed only
  when that boundary follows the current branch's latest model change; an older request finishing
  after a selection switch is ignored, even after switching away/back, reload or resume. Unmarked
  historical responses remain unresolved until a new request establishes ownership. Defaults, `/model`, tier bindings
  and quota admission/fallback remain unchanged: the virtual profile stays selected.
- Cost is shown for nonzero totals or subscriptions (OAuth or `kimi-coding`). The hit rate is
  from the latest prompt-bearing assistant on the current branch, not cumulative session totals.
- Cache temperature uses the model's positive finite `promptCache.short` in seconds, default
  300. One timer repaints at expiry plus 50ms. A low hit rate below 50% after a drop of at least
  10 points gets `idle>ttl`, `model-switch`, `compaction`, or `prefix-changed`, in that priority;
  compact markers shorten these words. Cache diagnostics never perform I/O or warm a cache.
- Optional router quota row: provider-scoped remaining quotas, floored/clamped to 0..100, `--`
  for unknown values, warning at <=20%, error at <=5%. Anthropic always shows weekly, and 5h only
  while its last fresh reading reports a provider-scoped `five_hour` window (some plans, e.g. 20x Max,
  have none): `Quota left: Anthropic weekly 35% (resets Nov 2 09:00) | OpenAI weekly 76% (resets Nov 3 11:05)`.
  A stale reply never brings back a 5h that the last fresh reading left out, and before the first reply
  the placeholder is `Anthropic (stale) weekly --`. A reported idle window (`{ utilization: 0, resets_at: null }`)
  renders as `5h 100%` with no reset. OpenAI
  shows weekly only (it has no 5h quota, so a window with a reported 18000s span is ignored; a window whose span the router only assumed is shown as an unidentified quota, see below). Each window is
  followed by its reset, taken from the router's `windows[].resetAt` (epoch ms), never computed
  or guessed. With a 5h window: `Quota left: Anthropic 5h 66% (resets 14:30) weekly 35% (resets Nov 2 09:00) | OpenAI weekly 76% (resets Nov 3 11:05)`.
  Compact: `Left: Anth 5h 66% @14:30 7d 35% @Nov 2 09:00 | OAI 7d 76% @Nov 3 11:05`. Times are 24h
  in the process-local timezone (the zone the router's own `/router` output uses; DST and
  calendar days follow it). 5h resets show `HH:MM`, or `Mon D HH:MM` when past local midnight;
  weekly resets always show the date. An unknown reset is omitted and the percent stays. A stale
  retained percent keeps its own reset. A reset time already in the past is simply not shown; it never changes the percent, its color or its staleness.
  OpenAI window identity comes from the router's optional `windows[].spanSource`
  (`reported` | `assumed`, provenance only; names, `durationMs`, scoring and admission are unchanged):
  weekly is the window with a reported 604800000 ms duration (or the legacy `7d` name on snapshots with no
  `spanSource`). A reported 18000s window is never shown. If no weekly is proven but the router only
  *assumed* a span (Codex payload with no `limit_window_seconds`), the footer does not claim 5h or weekly:
  it shows the most limiting such window as `OpenAI quota 62% (resets Oct 24 11:05; window unknown)`,
  compact `OAI quota? 62% @Oct 24 11:05`, with the same local-timezone date and time.
  A proven weekly always wins over an assumed window, and a stale retained weekly is not displaced by one.
  When the router supplies `views`, the footer uses their labels and window selectors. It shows
  reported percentages, metered counts and balances, and active blocks with their evidence.
  Counts such as `37/250 req obs` describe locally observed usage, not account-wide quota;
  unknown limits have no denominator. Model buckets appear for the routed or directly selected
  model and for models with active blocks. No Google collector or credentials are needed by the footer.
  Every active block is shown, legacy rows included: v1 `blocks` attach to their provider (a block
  for a provider without a row gets its own), and a confirmed Opus block appears beside healthy
  provider-wide quota, e.g. `| opus blocked->Jan 18 12:00 read`. The pre-view footer ignored
  blocks; legacy rows without an active block keep their bytes. A tracker mark without `evidence`
  is a confirmed read and says `read`. Compact blocks keep the date unless they lift today.
  Provenance is never promoted: an inferred span reads `10m~` (full: `span inferred`) and an
  assumed or unrecognized one `name?` (full: `window unknown`), on percentages and counts alike;
  only the legacy Codex row keeps `quota?`. A selector never lends its duration to an assumed or
  inferred fallback reading: one with no duration shows its own name, e.g. `est~`. A count with an
  unrecognized basis is skipped; a block with unrecognized evidence shows `unk` (full: `unknown`).
  Counts keep their reset time, and only an observed zero is hidden (no calls, no row). Legacy
  rules apply only to v1 replies and views that keep the built-in Anthropic or Codex selection.
  Freshness is the snapshot status and expiry against the clock (a legacy row with no counts or
  pools also needs a percentage window). Staleness covers percentages, counts and pools: an
  expired or failed snapshot says `(stale)`, never on an active block. A failed view whose layout
  shows no cached value (decided after each layout drops cells) (only `--` placeholders, unknown pools or another model's buckets) shows
  `quota error`, `quota unavailable` or `quota stale` beside any active block.
  Provider, bucket, pool and family labels are cut to 48 characters (`...`), and a block names at
  most four families, then `+N`; matching always uses the full ids. Providers whose labels collide
  (long ids cut alike, or identical display names) get a stable `#xx` tag from a hash of their id,
  lengthened until the tags differ and kept whole when the label shortens; a lone legacy row keeps
  its pinned label.
  The layout tries one full or compact row, then compact provider rows, then removes reset times
  and drops counts and pools if needed. The fallback shows at most four provider rows: blocked
  providers first, each group by lowest remaining quota. Each fallback row fits the width: the
  label shortens first, then whole lower cells drop behind ` ...`, or ` +K!` when K blocks are
  dropped. Provider-wide blocks lead model blocks, and every block is tried whole, then terse
  (`blocked inf`, or `model blocked inf`), before the row falls back to its label; a block is omitted
  rather than clipped away from its evidence. A legacy row
  keeps its pinned bytes unless it carries a block; then it is budgeted the same way, its
  percentages in legacy order. The last row points to the rest and always fits, keeping the hidden
  blocked count longest: `+2 more (1 blocked): /router status`, `+2 more (1 blocked)`, `+1!`
  (blocked providers hidden), `!`; without hidden blocks `+2 more: /router status`, `+2 more`,
  `+2`, `+`. Deferred
  startup, 60s polling, one outstanding request, unique reply channel, 12s timeout, expiry repaint,
  stale retained readings and recovery. Without a valid reply the row stays hidden. Disposal
  cancels listeners and timers; unreferenced default timers do not keep the process alive.

There is no footer config file, command, or custom settings key. It reads model metadata,
OAuth state, context usage, branch/session entries and footer data from Pi; home abbreviation
uses `HOME`, then `USERPROFILE`, then the OS home; SDK callers can instead inject `homeDir` through
`createExpandedFooter`. It does not read `settings/personal-defaults.json`,
router configuration files, `cacheWarming`, or the persisted compaction setting.

## Development layout

Runtime TypeScript lives in `src/`. Tests live in `tests/`, with helper code in
`tests/fixtures/`. Headless helpers use `@nredd/pi-test-lib/harness`; the neutral
`tests/fixtures/usage.ts` keeps the router bus independent of the interactive host.
The same three `footer-headless.test.ts` cases (RPC, print and JSON bindings) run on
stock Pi `1.5.2` under Node and Bun. This is not a stock full-suite or typecheck claim:
`tests/fixtures/footer.ts` still imports `createInteractiveHarness`, `InteractiveHarness`
and `InteractiveHarnessOptions` from the fork's `/testing/interactive`, and
`tests/scenarios/footer-model.test.ts` still imports its `InteractiveHarness` type.
Those hosts depend on private `InteractiveMode` and TUI render flushing; private model-route
and interactive behavior are unchanged. Run `npm run check` for lint, types, Node and Bun tests plus the
packed-file contract. `CHANGELOG.md` records releases from `0.5.0` on, with unreleased changes under `[Unreleased]`;
earlier history remains in the root `docs/releases.md`. Pi resource directories and license texts keep their names.

## Contents

- `agents/`: `architect`, `code-reviewer`, `critic`, `debugger`, `general-purpose`,
  `principal-investigator`, `researcher`, `verifier`. Declared in `pi.subagents.agents`, found
  through pi-subagents' package-agent discovery (the pinned fork; stock Pi ignores the key)
- `skills/`: `code-review`, `ship-issue`, `get-it-merged`, `coding-like-redd`. Discovered by Pi
  through `pi.skills`. `coding-like-redd` is explicitly opinionated (Python/Rust conventions of the
  author) and is public, opt-in content
- `src/index.ts` with sibling `src/footer-cache.ts` and `src/footer-quota.ts`.
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
  `principal-investigator`, `verifier`; and `pi-web-access`, used by `architect`,
  `principal-investigator` and `researcher`
- `code-review` mentions `/setup-matt-pocock-skills` and `docs/agents/issue-tracker.md`, both
  optional repo-local context

Agents select tools as `ext:pi-dev-tools/<tool>` and `extensions: [pi-dev-tools]`. The forked
pi-subagents strips the npm scope when it matches package names (`@nredd/pi-dev-tools` ->
`pi-dev-tools`). Do **not** change these to `ext:@nredd/pi-dev-tools/...`: the selector parser
splits on the first `/`, and a scoped string in `extensions:` is read as a path. Tests reject any
scoped selector.

## Agent command limits

`researcher`, `architect`, `critic`, `code-reviewer` and `principal-investigator` have no shell/SSH and cannot run commands. Their descriptions say so in the first sentence, which survives pi-subagents compact listings. `critic` and `principal-investigator` can run existing tests via `py_test`/`cargo_test`, not arbitrary shell commands. Each prompt requires a FIRST-turn explanation before tool calls when requested commands are unavailable, then a handoff to the caller or a shell-capable agent. Use `general-purpose`/`debugger` for command investigations or `verifier` for gates. There is no per-call tool-override flag.

Grant changes in `0.5.0`: `architect` gains the four `pi-web-access` research tools (`web_search`,
`fetch_content`, `get_search_content`, `source_check`; fetch tools may cache material, so read-only
is not a filesystem sandbox), and `general-purpose` may delegate only to `code-reviewer` (was
`all`). Passive waits and merged-worktree sweeps stay with the continuing parent; workers only prune
worktree metadata. Workers remove their untracked scratch before handback and claim any leftovers
with a creation record. After merge, the parent removes only verified claims and sweeps again.
Scratch removal is limited to regular files and symlinks with a `??` status entry and a matching
creation-time type and SHA-256. Both roles hash file bytes or raw `readlink` bytes (no added newline).
Check that the file's real path, or the link parent's real path joined with the link name, stays
inside the worktree. Unlink only the link, without resolving its target. See the shipping skills.

Use `architect` for architecture reviews and web research. It preloads `codebase-design`
and ranks cited survey cards by payoff and migration cost (`S`, `M`, `L`). It treats
`shortcut:` comments as decisions and reports unread scope. Surveys stay under 1500 words;
concrete interface alternatives are reserved for opt-in grilling (`Q1`, `Q2`, `Rec:`).
`general-purpose` delegates Standards and Spec reviews to `code-reviewer`; the parent
owns the final critic review.

Local overrides shadow these packaged definitions; update their managed source separately.
Installing this package does not activate anything else or change a deployment's model bindings.

## Models and roles

Agents carry no `model:`; skills name tiers only. Bind tiers in your own `subagents.json`
(`agentModels`, `modelTiers`), never here. A quota-parked tier waits; it never falls back to another tier.

`principal-investigator` (a multi-round judge of findings, not diffs) is unpinned too; route it with
`agentModels["principal-investigator"] = "@deep"` next to `code-reviewer` -> `@review`, and pass
`Agent({ model: "@frontier" })` per call for a final acceptance round and `thinking: high` per
dispatch. The same tier rules apply: a parked tier waits, never substitutes. The binding itself is
profile config, not preset content.

`tests/resources.test.ts` parses `agents/` and `skills/` (frontmatter, fenced YAML/JSON, `key: value`
and call arguments, flow lists and maps, `--model` flags and pi's `/model` command, tables with a
`model` column) and fails on any non-tier value under a model-like key (`model`, `models`,
`subagentModel`, `model_id`, `agentModels`, ...), comments in data fences included. Only pi's
`--model`/`--models` flags may add a thinking suffix (`--models @review:high`); pi-subagents never
parses one, so `model: "@review:high"` fails. A best-effort prose scan also fails on
provider-qualified refs, model ids and family names. The guard lives in `tests/lib/src/model-guard.ts` (`@nredd/pi-test-lib/model-guard`);
pi-subagents' default-agent test shares it.

`code-review` captures the original PR merge-base
and one full reviewed HEAD, binds both axis diffs and prompts to that entire range, and discards both
reports if HEAD changes. Renewed axes retain the original base through the new final HEAD; corrective
deltas are supplemental only. Top-level parents
launch the separate Standards and Spec `code-reviewer` calls without a model override; delegated
workers use blocking calls and consume their inline results. Verified absence of a spec still
invokes the Spec reviewer, which returns its SHA-bound `- No spec available.` receipt. `ship-issue`
runs one supplementary critic only when the caller's allowed-subagent list permits it; a worker
restricted to `code-reviewer` keeps its permissions and returns `Parent critic: PENDING`. Either way
the continuing parent runs its independent final critic after exact-HEAD review.
Parent sessions keep ownership through the single PR's terminal outcome; auto-merge is permitted
only when applicable protection is readable, effective and not bypassable by the merging caller.
Otherwise the parent waits for complete exact-HEAD CI and merges explicitly.
Before creating an issue worktree and after merge, the parent follows the
[guarded sweep](skills/get-it-merged/SKILL.md#guarded-merged-worktree-sweep). The preset ships
[`sweep_guard.py`](skills/ship-issue/sweep_guard.py) beside `ship-issue`. It needs Python 3.8+,
Git 2.36+, `gh` and `lsof`. The guard keeps without reading the candidate if the Git version
is too old or cannot be parsed. This rollout is keep-only: the shipped CLI never emits `eligible` and
never authorizes removing a worktree or even one claimed scratch file. Supply known
ownership and retained directory holds with `--hold`; `lsof` only sees processes visible to the
caller. The guard requires one hour of quiet on the checkout and Git activity markers. Exit `0`
means a scan produced verdicts; unreadable inventory or no matching worktree exits `1`.
Gitlinks and retained submodule
metadata stay put without running submodule status. Nested `.git` files or directories, incomplete
walks, malformed inventory or HEAD logs (including non-UTF-8 branch names or log records and
inventory or log IDs of the wrong width for the repository), unreachable old or new HEAD log IDs, and conversion
attributes (including `text=auto`), conversion configuration or mismatched index/worktree line
endings also mean keep. The `git ls-files --eol` probe classifies raw bytes without running
filters. Effective
`core.filemode=false` means keep because Git status can hide executable-bit changes.
After the earlier holds pass, the guard hashes tracked entries in process as raw Git blobs (file
bytes, or a symlink's target string, with no filters or stat cache) and compares each with its
index object ID and mode, stopping at the first entry that keeps. A same-size edit with a restored
mtime under `core.trustctime=false` therefore keeps. Parent directories are opened without
following symlinks and the leaf is read relative to them; a symlinked parent, a parent or file
replaced or rewritten while it is hashed, unmerged or unexpected index entries, and missing entries
or entries that are neither regular files nor symlinks also keep. A tracked symlink compares by its
target string only and passes when that matches.
Limits:
- Use a trusted `python3 -I -S` so `PYTHON*` startup settings and site initialization do not load.
  Children inherit only absolute `PATH` entries, `HOME`, `LANG`, `LC_ALL` and `TMPDIR`; `gh` also
  receives `GH_TOKEN`, `GITHUB_TOKEN`, `GH_HOST`, `GH_CONFIG_DIR`, `HTTPS_PROXY`, `HTTP_PROXY` and
  `NO_PROXY`. Its local config and proxy settings can still affect routing and authentication.
  The guard does not sandbox the interpreter, the binaries or their trusted environment.
- The CLI cannot prove a closed borrower scope: Git cannot enumerate independent clones,
  alternate stores or unmounted checkouts. Every verdict carries that hold first, even when the
  candidate has no other hold. Report only the guard's evidence; delete nothing.
- The guard does not probe upstream transports. If no PR exists, it reports `no PR; upstream not checked`.
- The guard omits `git status` and does not compare staged changes. Attributes
  or driver configuration could change after an attribute scan and cause `git status` to run a
  clean filter. Untracked and ignored paths are reported separately. Never run standalone
  `git status` or `git diff` on a retained worktree to fill that gap.
- The raw content comparison is a snapshot: a write after an entry is hashed is not seen.
  Its total cost is unbounded: chunked reads bound per-file memory only and there is no time
  budget yet (#1388); measure it before any deletion is enabled.
- Non-goals here: the raw comparison does not detect a case-only rename under `core.ignorecase` or
  an intent-to-add entry whose file is still empty; the index-vs-`HEAD` check in #1369 covers
  intent-to-add. The CLI stays keep-only until #1220.
- The guard does not check `core.ignorecase` or `core.symlinks`; the CLI authorizes nothing.
  A verdict is a snapshot, not a lock. The installed `git prune-merged-worktrees` command and
  older copies of the skills are unchanged; migrate those separately before retiring the legacy helper.
Critic receipts retain the original SHA-bound
invocation and tool-routing metadata, accepting its native findings-only output rather than a
fabricated `Checked:` checklist. A future configurable role is not permission to silently
substitute reviewers.

No preset agent pins `thinking:`. With no `thinking` on the `Agent` call, pi-subagents passes no level
to the child session, so pi picks it: the per-model setting, else `defaultThinkingLevel`, clamped to the
model (not the parent's live level if changed mid-session). An `Agent` call's `thinking` overrides
frontmatter, so callers can still ask for e.g. `high` per dispatch.

No `role:` references are introduced. Logical-role conversion needs strict required-role support
in the pinned pi-subagents fork (exact available candidates, no fuzzy/provider/parent fallback,
across dispatch, parking, and schedule paths). **Pending.** Enterprise role mapping and
acceptance are **pending** too. Public managed workflows must not be activated before then.

## Precedence and collisions

Local wins. Verified against real Pi 1.3.0 (`tests/discovery.test.ts`) and the pinned
pi-subagents source (below):

- Skills: Pi keeps the first discovered skill of a name and reports the packaged one as a
  collision. A same-named skill in `~/.agents/skills` therefore shadows the packaged one. Any
  existing global copy of the four skills (and the `code-review` from `mattpocock/skills`, which
  shares the name) collides the same way
- Agents: package agents load first and any global (`~/.pi/agent/agents`) or project agent of the
  same name overrides them

Retirement of old global copies belongs to the deployment's configuration manager, not this
package. Reconcile intentional changes first, preserve unrelated local resources and retire
known managed copies only during explicit activation. Tests never read a deployment's dotfiles.

## Evidence and what is pending

The [development gate](#development) covers footer helpers, real interactive footer scenarios
(quota, cache, widths, lifecycle), headless bindings, resource/schema/privacy/dependency checks,
packed-file allowlist/licenses and real Pi 1.3.0 resource discovery in a temporary home/agent directory.
Node and Bun run the tests without live model calls or operator auth. Quota assertions use the
current reset-time/OpenAI-window contract above, not the retired helper's display strings.

Packed-tarball evidence (`make check-package-contracts`): the packed preset is audited and installed alone.
The native preset package gate separately loads its installed skill/extension resources through Pi
from the tarball path. Child behavior of the `code-reviewer` agent (tools exactly
the read-only allowlist, denied tools refused, global/project overrides, untrusted project agents
ignored) is exercised against real children from these sources by
`tests/inprocess/{reviewer,specialists}.test.ts`.

Pending, not claimed: profile resolution, model roles, activation, the full assembled-stack check,
Bun compiled-artifact behavior, any other fork commit or Pi version, `pi install npm:@nredd/pi-preset` through a live Pi, and npm provenance attestation.

## Development

From the repository root:

```sh
npm ci --ignore-scripts
npm run check -w @nredd/pi-preset   # biome, strict tsc, full Vitest on Node and Bun 1.4.4
```

- `tests/scenarios/`: real core `createInteractiveHarness`/`VirtualTerminal` footer scenarios and mode-correct headless binds, run under Vitest and Bun; no Pi process, tmux, timer preloads or wall-clock waits.
- `createExpandedFooter({ clock, timeZone, homeDir })` optionally injects one clock, an IANA zone pinning reset labels, and a home for cwd presentation (all default to process values) for deferred startup, quota polling/staleness and cache expiry. Its local `FooterClock`/`TimerHandle` interfaces mirror `packages/session-kit/src/clock.ts`: `now()` reads time; `setTimeout()` and `setInterval()` return handles owning `cancel()`. The default uses unreferenced real timers, 60s polls, 12s replies and the 50ms cache repaint margin.
- `tests/*.test.ts` and `tests/fixtures/` are checked by strict TypeScript, including the migrated footer helper assertions. Everything under `src/` and `tests/` is Biome-formatted.
- The footer provides the optional factory/clock seam and routed physical model/thinking labels. `src/footer-quota.ts` additionally drops OpenAI 5h, shows Anthropic 5h only when reported, adds reset times, router window-identity handling and width-fitting rows; `src/footer-cache.ts` remains byte-identical. The migrated helper tests use static sibling imports and Vitest instead of `node:test`.
- All live dotfiles helper assertions exist here, except the OpenAI 5h and quota row-text expectations, which this package deliberately superseded (see the quota row above). `tests/footer-render.test.ts` adds previously uncovered usage-entry totals, token-format boundaries, subscription detection, context warning thresholds, cwd/status handling and model labels. Footer-only adoption is independent of the deferred full profile split (#21). Retire duplicate local footer files through the configuration manager during explicit activation, not by loading both implementations.

Discovery tests redirect `HOME`, `USERPROFILE`, `PI_CODING_AGENT_DIR`, `TMPDIR`/`TMP`/`TEMP`, `XDG_*`,
and `PI_OFFLINE` into a temporary directory (restored afterwards) and pass the agent dir explicitly.
They run in the test process, so a path Pi computed at import time would not be redirected; Pi 1.3.0
computes none of the ones used (see the comment in `tests/discovery.test.ts`).
