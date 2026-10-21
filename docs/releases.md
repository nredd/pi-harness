# Releases

- Generate `releases/<release-id>.json` with `make release-manifest ARGS='<release-id> ...'` after exact Gitlinks, package manifests, artifacts, and evidence are available.
- The schema-versioned manifest records the monorepo commit, Gitlink provenance, owned package versions, existing root lockfile digests, supplied artifact digests/URLs, and free-form verification evidence. Core tags cut after `nredd/pi` adopts `fork-release.yml` publish a release `SHA256SUMS` covering the coding-agent, tui, `pi-agent-core` and `pi-ai` tarballs; the stack fetcher verifies every one of them against that release file and GitHub provenance from `nredd/pi/.github/workflows/fork-release.yml` at the exact tag. The trust decision authenticates CI-built bytes by that provenance, not by rebuilding: dry-run [39502658787](https://github.com/nredd/pi/actions/runs/39502658787) showed `v1.3.0-nredd.7` is not byte-reproducible, and rebuilds will differ. Reproducibility is tracked in [nredd/pi-harness#84](https://github.com/nredd/pi-harness/issues/84). `v1.3.0-nredd.3` through `.7` are explicit legacy exceptions: `integration.harness.release.LEGACY_CHECKSUMS` hard-codes their verified release SHA-256 values (`.4`-`.6` include `pi-agent-core` and `pi-ai`; `.3` and `.7` shipped only coding-agent and tui), but they have no provenance because the release workflow did not exist. Do not backfill them with a newer workflow, which would attest a different build definition. The root `package.json` overrides for all four packages are resolved by npm from `package-lock.json`, not through `fetch_release`, so they are covered only by lockfile sha512 integrity. `test_root_overrides_stay_tied_to_verified_legacy_releases` requires each to name a legacy tag whose lockfile `resolved` and `integrity` match the frozen sha256 values; moving an override to a new tag means first migrating that consumption path onto `SHA256SUMS` plus provenance. The CI signature check is bypassable by an edited workflow in a tagged commit; the creation control is `nredd/pi`'s tag ruleset `Fork release tags` (id `25519508`, [here](https://github.com/nredd/pi/rules/25519508)), which blocks creating, moving or deleting `refs/tags/v*-nredd.*` for everyone except the repository admin role (the owner, the only admin), the same shape as `npm release tags` below. Inspect with `gh api repos/nredd/pi/rulesets/25519508`.
- It is generated, never a hand-edited fork-pin file. Refuse a dirty tree unless `--allow-dirty` deliberately records `release.dirty: true`. Generate it on the clean tree that already contains the generator, then commit it: the recorded `release.commit` is the manifest commit's parent, by construction.
- Gitlink-only selections may pass no `--artifact`: the generated `artifacts: []` records source provenance, not a new core asset release. The assembled-stack checksum reader skips these snapshots and still requires every downloaded asset's digest from an artifact-bearing manifest; absent, conflicting or invalid checksums still block before installation.
- Deliberately omitted: profiles, runtime-tree archives, and a complete third-party resolution lock. Those inputs do not exist in this minimal slice yet.
- `2026-10-17-startup-trust`: core `v1.3.0-nredd.3` + `pi-subagents` `v0.22.0-nredd.2`. `2026-10-18-npm-publication`: first npm publication of the four owned packages, tarballs packed from `c1857f3` after `make check-package-contracts`, registry bytes re-downloaded and compared. Those initial versions have no provenance attestation; subsequent versions use the OIDC workflow below.
- `2026-10-18-testing-export`: core `v1.3.0-nredd.4` (nredd/pi#4, `@earendil-works/pi-coding-agent/testing`). Ships four tarballs: `pi-coding-agent` and `pi-tui` for the CLI, `pi-agent-core` and `pi-ai` so package tests get the fork's provider gate and Responses default instead of stock npm `1.3.0`. Not pinned in the tap or chezmoi: `dist/bundle` is byte-identical to `v1.3.0-nredd.3`.
- `2026-10-19-interactive-testing`: core `v1.3.0-nredd.6` (nredd/pi#5 + #6): `@earendil-works/pi-tui/testing`, `TUI.flushRender()`, `@earendil-works/pi-coding-agent/testing/interactive`; pi-subagents `v0.22.0-nredd.3` (nredd/pi-subagents#4, injectable clock). `v1.3.0-nredd.5` was released but never selected: the full fork suite found 6 regressions, fixed in nredd.6. `pi-tui`/`pi-agent-core`/`pi-ai` tarballs byte-identical to nredd.5. Not pinned: the CLI bundle changed, so the pin waits for the assembled-stack gate.
- `2026-10-19-rebased-fork-scenarios`: Gitlink-only selection of pi-subagents `v0.22.0-nredd.4` (tintinweb `ca93a524`) and pi-plan-mode `v0.59.3-nredd.1` (upstream 0.59.3), with 23 B rows and the final router shell case moved to native fork suites. No new artifact is built or published; the generator accepts an empty artifact list and records exact fork identities plus gate/probe evidence. Personal stack pins match the selected tags; dotfiles promotion remains separate.
- `2026-10-19-rpiv-todo-2.13.9`: Gitlink-only selection of rpiv-todo `v2.13.9-nredd.1` (upstream 2.13.9 with per-call state persistence and the legacy-snapshot replay guard); no new artifacts
- `2026-10-20-pi-subagents-skill-links`: Gitlink-only selection of pi-subagents `v0.22.0-nredd.5` (nredd/pi-subagents#7): `skills:` preload follows symlinks in user roots like Pi core, project roots stay strict (now including a linked `.pi/`/`.agents/` dir). Probe #54 ran the full fork suite before tagging; no new artifacts
- `2026-10-20-rpiv-todo-standalone-suite`: Gitlink-only selection of rpiv-todo `v2.13.9-nredd.2` (nredd/rpiv-todo#2): the fork's own suite runs standalone (Vitest 382 incl. all 253 stock upstream tests, Bun 2) and in `forks.yml`, and live-fallback todo rows invalidate core's cached settled rows. Probe #59 ran the new job before tagging; no new artifacts
- `2026-10-20-anthropic-auth-web-access-0.43`: stack-source selection with unchanged Gitlinks. #63 drops the `pi-claude-auth` fork from both stacks (its Gitlink stays in the tree, unused, until #77 removes it) in favor of `npm:@gotgenes/pi-anthropic-auth@3.4.3` (CI proves direct and `router/*` OAuth shaping); #70 bumps `pi-web-access` 0.36.0 -> 0.43.0, whose `fetch_content` answer mode now goes through `registry.complete` and so gets shaped too. Evidence keys name the two PRs since neither is a fork tag; no new artifacts
- `2026-10-20-core-compaction-queue`: core `v1.3.0-nredd.7` (nredd/pi#7) queues extension custom messages triggered during manual, automatic, or branch compaction, then admits them in order once compaction settles. Ships the changed coding-agent tarball and unchanged pi-tui tarball; pi-agent-core and pi-ai remain the nredd.6 artifacts.
- Each npm publication is also a signed monorepo tag `@nredd/<name>@<version>` at the commit the tarball was packed from (`@nredd/pi-dev-tools@0.4.0`, `@nredd/pi-session-kit@0.3.0`, `@nredd/pi-subscription-router@0.3.0`, `@nredd/pi-preset@0.1.0` at `c1857f3`). Tag at publication, never retroactively to a different commit.
- `@nredd/pi-session-kit@0.4.0` (`718b033`): first publication through `publish.yml` with npm trusted publishing (OIDC, no token) and SLSA provenance; GitHub release carries the tarball, `SHA256SUMS`, `identity.json` and `manifest.json`. Attempt 1 published but failed the one-minute registry poll; the failed-jobs rerun skipped re-publication on matching integrity, then verified signatures, attestations and source binding
- `@nredd/pi-subscription-router@0.4.0` (`3cf77bc`): published by `publish.yml` in one attempt (npm served it after ~3.5 min of the ten-minute poll); release carries the four assets
- `@nredd/pi-dev-tools@0.5.0` (signed tag at `3cf77bc`): NEVER PUBLISHED. `verify` failed one dev-tools test (run [here](https://github.com/nredd/pi-harness/actions/runs/39370449677)): it ran the package check inside the `uv run --project integration` venv, so `uv run pytest` in a pytest-less fixture project found the harness's `pytest`. CI's `owned` job never activates that venv. `scripts/npm_release.py` now strips the activation from every child command; the tag stays where it is and the release moves to `0.5.1`
- `@nredd/pi-dev-tools@0.5.1` (`90538d7`, #50): the `0.5.0` content, published by `publish.yml` in one attempt (run [here](https://github.com/nredd/pi-harness/actions/runs/39373169935)); release carries the four assets. `integration/stacks/personal.json` pins it with router `0.4.0` (#51)
- `@nredd/pi-session-kit@0.5.0` (`8c7c084`, #52): the `/stats` redesign with timescale-aware time axes, published by `publish.yml` in one attempt (run [here](https://github.com/nredd/pi-harness/actions/runs/39377430743)); release carries the four assets. `integration/stacks/personal.json` pins it (#53)
- `@nredd/pi-session-kit@0.6.0` (signed tag at `7f26025`, #68): quiet passive monitor output, compact wakes with unread `since` cursors, and a summary widget, published by `publish.yml` in one attempt (run [here](https://github.com/nredd/pi-harness/actions/runs/39475730345)); release carries the four assets. `integration/stacks/personal.json` pins it
- `@nredd/pi-preset@0.2.0` (signed tag at `e18831a`, #81): the footer port with direct renderer contracts, published by `publish.yml` (run [here](https://github.com/nredd/pi-harness/actions/runs/39506908135); verify, publish and release succeeded); release carries the four assets, npm `dist.integrity` equals `identity.json`, SLSA provenance. `integration/stacks/personal.json` pins it as a filtered footer-only source (`extensions: ["extensions/expanded-footer.ts"]`, empty `skills`/`prompts`/`themes`)

## Owned npm packages

`.github/workflows/publish.yml` is the only automated publish path for `@nredd/pi-dev-tools`,
`@nredd/pi-session-kit`, `@nredd/pi-subscription-router`, `@nredd/pi-subagents` and `@nredd/pi-preset`.

`scripts/release_descriptors.py` is the publisher's data registry. Each entry supplies a package name,
repository-relative workspace, shell-free verify commands, packed-artifact contract gates, and optional
native-artifact glob requirements. The publisher rejects unknown tags, a workspace outside the checkout,
package/tag skew, or missing native files before it packs. Adding a package means adding its descriptor
and package contract, not another name-specific workflow or Python branch. `@nredd/pi-subagents`
uses `packages/subagents` and its native `npm run check` (Biome, TypeScript, Vitest and pinned-Bun
session tests). The `verify` stage then packs it once and runs the `stock` gate on those exact bytes:
the file allowlist (`files` in its `package.json` and `SUBAGENTS_CONTRACT.allowed` enumerate the same
set, checked by `test_subagents_pack_matches_contract`), its own `LICENSE`, the manifest audit with
declared allowances (runtime dependencies `croner` and `nanoid`, the fork's `>=1.1.0` peer floor), the
import audit, an install of the tarball plus those dependencies from the registry, and a stock Pi 1.3.0
run that must offer `Agent`, `get_subagent_result`, `steer_subagent` and `SubagentWorkflow`. The contract
sits outside `package_contracts.CONTRACTS` because `make check-package-contracts` installs offline and
never runs it, but CI's `contracts` job runs the same gate on every
non-docs PR as `make check-subagents-package-contract` (registry install plus a stock Pi run with one
faux `Agent` call). The retained
`forks.yml` job still covers the Gitlink source, not the tarball.
For example, the future todo import will add an entry shaped like:

```python
ReleaseDescriptor(
    name="@nredd/pi-todo",
    workspace=PurePosixPath("packages/rpiv-todo"),
    verify_commands=(("npm", "ci", "--ignore-scripts"), ("npm", "run", "check", "--workspace", "@nredd/pi-todo")),
    contract=TODO_CONTRACT,
    contract_gates=("stock",),
    stock_gate=todo_stock_gate,
)
```

`@nredd/pi-computer-use` will additionally declare `native_artifacts=(PurePosixPath("prebuilt/macos/*"),)`.
Patterns use `PurePosixPath.full_match`: `*` and `?` stay within one path segment, while `**` matches zero
or more segments. Requirements check both the source workspace and packed tarball, but the helper build
and macOS native suites belong to its later import PR. No extension descriptor is added by this change.

1. Bump the package version and root lockfile in a reviewed PR, pass CI, and merge to `main`.
2. Select the merged `main` SHA whose package version equals the intended version. Create a signed tag:
   `git tag -s '@nredd/<pkg>@<v>' <main sha>` (e.g. `@nredd/pi-session-kit@0.3.1`).
3. Push only that tag: `git push origin '@nredd/<pkg>@<v>'`.
4. Watch the `Publish` workflow. It runs `verify -> publish -> release`, serially per tag with no
   cancellation. Never publish locally or rebuild an accepted tarball.
5. Bump the dotfiles pin in a reviewed PR only after pi-harness CI's `stack` job is green for the
   candidate package set in `integration/stacks/personal.json` and matching Gitlinked core release.
   Follow the dotfiles activation runbook; npm publication alone is not a promotion gate.

`verify` refuses unknown packages, tag/version skew, tags not at the checkout commit, commits outside
`origin/main`, and versions already present on npm. It installs with `npm ci --ignore-scripts`, runs
only the selected package's `npm run check` with pinned Bun, and packs once. Child commands run without
the integration venv `uv run` activated for the script (`VIRTUAL_ENV` and its `bin` on `PATH`), matching
CI's `owned` job. The stock package contract
consumes that tarball for each standalone plugin; dev-tools also runs the fork contract, and preset
runs the fork contract instead of a standalone contract. The fork contract packs only the companion
package from the same checkout. Existing tarballs enter the gates via `supplied` (CLI equivalent:
`--tarball DIRECTORY=PATH`); the candidate is never repacked.

The artifact contains the candidate `.tgz`, `SHA256SUMS`, `identity.json` (source commit, tag, SHA-256
and npm SHA-512 integrity), and `manifest.json` generated by `scripts/release_manifest.py` with contract
evidence. It is retained for 30 days. `publish` downloads it, asserts Node >=22.14.0 and npm >=11.5.1,
and cross-checks the bytes, checksum, manifest, source and tag before `npm publish <tarball> --access public`.
Public OIDC publishing generates provenance automatically; no provenance flag or npm token is needed.
The job polls npm every 15 s for up to ten minutes for matching integrity and provenance visibility
(npm can take minutes to serve a new version; the first OIDC release, `@nredd/pi-session-kit@0.4.0`,
failed a one-minute poll and passed on a failed-jobs rerun that skipped re-publication), then:

- Install the exact `<name>@<version>` into a throwaway npm project with scripts and peer installation
  disabled. Require the selected package's exact lock entry to match the recorded version and SHA-512
  integrity; runtime dependencies are allowed.
- Copy only that installed subject and its exact lock entry into a second throwaway audit project, then
  run `npm audit signatures` there. npm verifies registry signatures and Sigstore attestations for exactly
  one named subject, so aggregate verification counts from dependencies cannot satisfy the release. The
  audit may not mutate either subject-root manifest. No custom cryptography is implemented.
- Fetch `https://registry.npmjs.org/-/npm/v1/attestations/<name>@<version>` directly. Decode the SLSA
  bundle's DSSE in-toto statement, not merely `dist.attestations` metadata. Require the package URL
  `pkg:npm/<name>@<version>` (including npm's percent-encoded scope form), the recorded tarball SHA-512
  digest, SLSA v1 predicate, workflow repository `https://github.com/nredd/pi-harness`, exact
  `refs/tags/<tag>` ref, and path `.github/workflows/publish.yml`. The resolved build source must also
  name the tagged commit recorded in `identity.json`.

Only after both cryptographic verification and source/subject binding pass can `release` create the
GitHub release with `gh release create <tag> --verify-tag` and attach those same four files.
The parser fixture is trimmed from the real public `vite@7.1.3` provenance bundle; it tests bindings,
not signature validity. npm performs signature verification against the live registry.

Bootstrap a new npm name before its first release:

- The owner publishes the exact pre-verified tarball using npm's owner-authenticated 2FA flow.
- Configure trusted publishing for `nredd/pi-harness`, `.github/workflows/publish.yml`, environment `npm`; require 2FA and disallow tokens.
- Push a later signed package tag to run a real OIDC publication and prove its provenance.

External configuration, already configured (not managed by this repository):

- Each owned npm package trusts repository `nredd/pi-harness`, workflow filename `publish.yml`,
  environment `npm`, with direct publishing allowed. Publishing access requires 2FA and disallows tokens;
  CI uses OIDC only. No npm secret or `NODE_AUTH_TOKEN` is configured.
- GitHub environment `npm` permits deployments only from tags matching `@nredd/*@*`.
- GitHub tag ruleset `npm release tags` makes `refs/tags/@nredd/**` admin-only.
- Only `publish` gets `id-token: write`; only `release` gets `contents: write`.

Recovery:

- Publish succeeded, release job failed: rerun **failed jobs**, preserving the successful verify
  artifact. A release-only rerun does not publish. If GitHub already created a partial release, download
  the original artifact with `gh run download <run-id> --name npm-release-<run-id> --dir <artifact-dir>`,
  inspect its identity and the release, then attach missing files with `gh release upload <tag> <files>`.
  Do not overwrite different assets without investigating.
- npm accepted the upload but the publish step or registry verification failed: rerun **failed jobs**
  on the same run while the original artifact is retained. `publish-check` skips publishing with a
  notice if the version exists with matching integrity, then retries provenance verification. Different
  bytes fail immediately. Persistent missing provenance blocks the release; investigate npm/OIDC, do
  not unpublish, replace a tag, use a token, or try to republish that version.
- Rerunning **all jobs** deliberately fails verify once the version exists. Recovery must reuse the
  original artifact, not reproduce it. If it expired, recover the exact files from an existing GitHub
  release or escalate to the maintainer; do not manufacture a new artifact. Fix source/workflow bugs in
  a reviewed PR and cut a new version/tag when a new publication is needed.
