# @nredd/pi-preset

Published to npm as `@nredd/pi-preset` (public), version `0.1.0`; see `releases/2026-10-18-npm-publication.json` for the tarball digest.
Not a supported release: no installer, no profile resolver, no activation path exists yet.
Nothing in this repository installs it, and nothing here changes a live Pi installation.

Standalone plugin users are unaffected. This is deliberately opt-in policy, not a replacement
imposed on `@nredd/pi-dev-tools`, `@nredd/pi-session-kit`, or `@nredd/pi-subscription-router`.

Tested host: stock Pi `1.3.0` only (exact devDependencies; peers are `*` per Pi's package rules).

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

Executed in this workspace (see the gate below): footer unit tests (migrated; Biome formatting plus
one import path each, no assertion changes), static resource/schema/privacy/dependency tests, `npm pack` allowlist and license
tests, and real Pi 1.3.0 resource discovery (extensions, skills, themes, collisions, package
manager resolution) in a temporary `HOME`/agent dir with no model calls or auth.

Real packed-tarball, real-fork evidence (committed, `make check-fork-package-contracts`, see
[package contracts](../../docs/package-contracts.md)): the packed preset and packed
`@nredd/pi-dev-tools` are installed as Pi `packages`, and exact stock Pi 1.3.0 runs the Gitlink-selected
`pi-subagents` (nredd/v0.22.0 `2fc9632198745527b0478b6e79b130eed75d284a`, canonical project trust) with a loopback faux
provider calling `Agent` with `subagent_type: code-reviewer` in the foreground. Observed through the
child's real request: tools exactly `read`, `grep`, `find`, `git_diff`, `git_show`, `git_log`,
`git_status` plus the fork's always-injected `SubagentWorkflow` refusal stub; no `edit`, `write`,
`bash`, `ssh_exec`, other dev-tools or delegation tools. The packaged prompt body and `max_turns`
reach the child; the child really runs `git_status` against a disposable repository, and Pi refuses
its `write`, `bash` and `git_commit` calls as unknown tools. A global and a project `code-reviewer.md`
each override the package. With dev-tools not installed the fork warns (`extension-error:`) and the
child runs with only its built-ins, no `git_*` tools. Project `.pi/agents` overrides follow Pi's
canonical project-trust decision: untrusted, the project file is ignored and the global override
wins. A project-scoped install of the preset is gated the same way (untrusted, the reviewer is not
found and the fork falls back to `general-purpose`, see the contracts doc).

Pending, not claimed: profile resolution, model roles, activation, the full assembled-stack check,
Bun compiled-artifact behavior, any other fork commit or Pi version, `pi install npm:@nredd/pi-preset` through a live Pi, and npm provenance attestation.

## Development

From the repository root:

```sh
npm ci --ignore-scripts
npm run check -w @nredd/pi-preset   # biome, tsc (against Pi 1.3.0 types), node:test
```

Everything under `extensions/`, `lib/`, and `test/` is formatted by Biome (no formatter override).
`extensions/expanded-footer.ts`, `lib/footer-quota.ts`, and the two migrated `test/footer-*.test.mjs`
therefore differ from the source snapshot in whitespace and line wrapping only (token-identical after whitespace
normalization), plus one `import` path per migrated test (see
[source provenance](../../docs/source-provenance.md)). They are not byte-faithful.
`lib/footer-cache.ts` is byte-identical.

The tests written for this package (`test/*.test.ts`, `test/support.ts`) are TypeScript, run directly
by Node's type stripping, and checked by `tsc --strict` with no `any`. The two migrated `.mjs` tests
stay untyped JavaScript, as in the source.

Discovery tests redirect `HOME`, `USERPROFILE`, `PI_CODING_AGENT_DIR`, `TMPDIR`/`TMP`/`TEMP`, `XDG_*`,
and `PI_OFFLINE` into a temporary directory (restored afterwards) and pass the agent dir explicitly.
They run in the test process, so a path Pi computed at import time would not be redirected; Pi 1.3.0
computes none of the ones used (see the comment in `test/discovery.test.ts`).
