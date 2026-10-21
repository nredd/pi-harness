# Stack promotion

`integration/stacks/personal.json` is the only editable personal package list. A promotion turns one exact, already-gated `main` commit into deployment state. Machines consume `stack-channel/stable.json`, never `main`. This is the trust root for automatic adoption, so every gate fails closed.

## Snapshot format

`stack-snapshot.json` is compact, sorted JSON with this strict schema (`integration/harness/promotion.py`):

- `schema_version`: currently `1`.
- `source_sha`: the exact 40-character `main` commit selected.
- `stack`: the validated `personal` stack object, including ordered sources and core release identity.
- `stack_sha256`: SHA-256 of compact sorted UTF-8 JSON for `stack`, not of the surrounding snapshot.
- `gates`:
  - `required_checks`: the configured `main` check names, all successful on `source_sha`.
  - `stack_run_ids`: the earliest qualifying push/`main` CI run (see below).
  - `owned_packages`: one `{package, integrity}` per `npm:@nredd/` source, with the registry's real SHA-512 integrity from `scripts/npm_release.py stack-check`.
  - `core`: the core release tag and asset SHA-256 digests, which must equal the stack's `core` and the release's `SHA256SUMS`.

The module rejects unknown fields, malformed SHAs, non-personal stacks, digest mismatch, duplicate evidence, and owned-package evidence that is not exactly the stack's `@nredd/` sources.

## What gets verified

Workflow: `.github/workflows/promote-stack.yml` (`workflow_dispatch`, `main` only). Every job has `if: github.ref == 'refs/heads/main'`. All gate logic lives in `python -m harness.promotion` subcommands (and, for the write-privileged job, stdlib-only `harness.publish_gate`) with fixture tests. The YAML only fetches JSON and calls them: `select`, `ancestor`, `checks`, `candidate-runs`, `stack-runs`, `owned-evidence` (worktree per owned tag plus `stack-check`), `core`, `gates`, `build`, `channel-exists`, `successor`, `release-state` and `tag-target`. Evidence failures and Git failures print `FAILED: ...`, never a traceback.

- Inputs: `select` requires `source_sha` to match `^[0-9a-f]{40}$` for `promote`/`verify-only`, and `rollback_tag` to match exactly `^stack/[0-9a-f]{40}$` (with no `source_sha`) for `rollback`. The commit must be an ancestor of `origin/main`.
- Required checks: every context from `GET /repos/nredd/pi-harness/rules/branches/main` (ruleset `main required checks`, readable by `GITHUB_TOKEN`) must be `completed`/`success` on that exact SHA, reported by the rule's `integration_id` app (`app.id`, 15368 for all eight). No checks from the rules API fails closed. Review statuses are not required checks.
- Registry-stack evidence: a CI run on that SHA with `event=push`, `branch=main`, conclusion `success`, that has a job matching `stack (*, personal)` with conclusion `success` AND a non-expired `stack-ubuntu-24.04-personal` artifact (from `actions/runs/<id>/artifacts`, bound to that run ID and SHA). The stack job installs the explicit personal sources from the registry and the core release into a disposable tree.
- Why the artifact: a skipped cell still reports its job as `success` (recorded run `39545048647` shows `stack (macos-14, personal)` green on a main push though it ran nothing). `ci.yml` uploads `stack-<os>-<stack>` only when `steps.plan.outputs.run == 'true'`, so docs-only and main-push smoke cells never produce it. No step name or display text is matched; a test asserts the job and artifact templates in `ci.yml` still render the required names.
- Docs-only SHAs cannot be promoted: CI skips the stack job for them, so no artifact exists. Promote the nearest commit where the stack job ran, or a later one. Artifacts expire with CI retention, so an old SHA must be re-run through CI before it can be promoted.
- Owned packages: `scripts/npm_release.py stack-check` runs per `@nredd/` source against a worktree of its exact tag: registry presence, npm `audit signatures` (signature and attestation), and the SLSA provenance binding to `publish.yml`, the tag and the commit. The registry lookup (`npm view`) runs in a fresh empty directory with `NPM_CONFIG_USERCONFIG=/dev/null` and `--registry https://registry.npmjs.org`, so a `.npmrc` in the selected tag's tree cannot steer it.
- Core: asset digests are compared with the release's `SHA256SUMS`. For non-legacy tags `SHA256SUMS` is a mutable release asset, so each recorded asset is also downloaded, hashed against the recorded digest, and verified read-only with `gh attestation verify --repo nredd/pi --signer-workflow nredd/pi/.github/workflows/fork-release.yml --source-ref refs/tags/<tag>`. Legacy tags `v1.3.0-nredd.3` through `.7` predate that workflow and rely on the frozen `LEGACY_CHECKSUMS` hashes.
- Stable pointer: the current `stable.json` is verified with `gh attestation verify --repo nredd/pi-harness --signer-workflow .../promote-stack.yml --source-ref refs/heads/main` before it is used for ancestry.
- Ancestry: whether `stack-channel` exists comes from `channel-exists` over `git/matching-refs` (exact ref, not a prefix). If it exists, `stable.json` must be readable and attested or the run fails; only a missing channel is a seed. The candidate `source_sha` must differ from stable's and be a descendant of it (`git merge-base --is-ancestor stable candidate`). A duplicate, stale, or diverged candidate fails before anything is written. The first seed has no stable and skips this.

The CI evidence is the only coupling to CI: run IDs are read with `gh run list/view`, the `actions: read` and `checks: read` permissions are granted, and an unreadable response fails with an explicit error.

## Required-check visibility

The eight required checks live in ruleset `main required checks` (id `25524267`, strict), so `GET /repos/nredd/pi-harness/rules/branches/main` returns them to `GITHUB_TOKEN` with no extra token. Classic branch protection is not read: if the rules API yields no check, `checks` fails closed.

## Operations

Dispatch `Promote stack` with `operation`:

- `verify-only` (the default): runs every check above, builds the snapshot, and checks it against the attested stable pointer. Writes nothing: no artifact, release, attestation, tag, or branch, and the `attest-and-publish` job (the only job in the `stack-promotion` environment, with write credentials) is skipped. Run it first to see exactly what a promotion would do; it needs no approval.
- `promote`: `verify-only` plus attestation and publication.
- `rollback`: dispatch with `rollback_tag=stack/<source_sha>` and no `source_sha`. The retained release asset is downloaded, its attestation and schema are verified, and only `stack-channel` is advanced. The immutable release is untouched. Rollback is the only way the pointer moves to a non-descendant.

Privilege split: the `verify` job runs only `main` code plus data from the selected commit, holds `contents`/`actions`/`checks` read only, and runs no `npm ci` or `uv sync` from the selected commit. The `attest-and-publish` job holds `id-token`/`attestations`/`contents` write, installs nothing, and only downloads the verified artifact, runs `harness.publish_gate` (standard library only, from `main`, asserted by a test), attests, and publishes.

## Release and pointer

`promote` attests `stack-snapshot.json` (`actions/attest-build-provenance`), creates release/tag `stack/<source_sha>` containing it, confirms the tag points at `source_sha`, then pushes a commit containing only `stable.json` (byte-identical to the snapshot) to `stack-channel`. The tag namespace deliberately does not overlap package tags (`@nredd/<package>@<version>`).

Resume: if `stack/<source_sha>` already exists (the pointer push failed), the workflow downloads that release's snapshot, `release-state` requires it to be byte-equal to the rebuilt snapshot (`resume`; no asset means `create`), its attestation is verified, and only the pointer advances. `tag-target` then requires the tag to resolve to `source_sha`. Evidence is deterministic (sorted checks, earliest qualifying run), but if the required-check set changed in between, equality fails closed; investigate or roll back to the retained snapshot.

## Owner touchpoints

Created 2026-10-20 via `gh api`; the workflow does not create or change any of them:

- Ruleset `25524267` `main required checks`: the eight required checks (`integration_id` 15368, strict).
- Environment `stack-promotion`: required reviewer the owner, deployment branches `main` only, secret `STACK_CHANNEL_DEPLOY_KEY` (write deploy key, id `167140535`). The only job in it is `attest-and-publish`.
- Ruleset `25524297` `stack channel pointer` on `refs/heads/stack-channel`: blocks creation, update, deletion and non-fast-forward; bypass actors are the deploy key and repository admin. `GITHUB_TOKEN` cannot be a bypass actor, so the workflow pushes over SSH with the deploy key. It pins GitHub's SSH host keys from the `meta` API.
- Ruleset `25524298` `stack snapshot tags` on `refs/tags/stack/**`: blocks update and deletion; bypass is admin. Creation stays open: an unattested tag is unconsumable because consumers verify attestation, and `GITHUB_TOKEN` creates the tag through the release.
- Dotfiles has no CI, so nothing there is checked automatically.

## Consumer requirements

Consumers MUST NOT trust `stable.json` by branch name. Before use they MUST verify both `stable.json` and the snapshot:

```
gh attestation verify stable.json --repo nredd/pi-harness \
  --signer-workflow nredd/pi-harness/.github/workflows/promote-stack.yml \
  --source-ref refs/heads/main --deny-self-hosted-runners
```

then validate it with `StackSnapshot` (`integration/harness/promotion.py`). An unattested file, or one attested from another workflow or ref, must be rejected, keeping the last good stack.

## First seed

After this PR merges, run `verify-only` on current `main`'s SHA, then `promote` with the same SHA. No prior `stack-channel` exists, so ancestry is skipped and the first run seeds the branch as an orphan containing only `stable.json`. This PR dispatches nothing and creates no tag, release, branch, ruleset, environment, or secret.
