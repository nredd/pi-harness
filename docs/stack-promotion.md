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

Workflow: `.github/workflows/promote-stack.yml` (`workflow_dispatch`, `main` only). Every job has `if: github.ref == 'refs/heads/main'`. All gate logic lives in `python -m harness.promotion` subcommands with fixture tests; the YAML only fetches JSON and calls them.

- Inputs: `select` requires `source_sha` to match `^[0-9a-f]{40}$` for `promote`/`verify-only`, and `rollback_tag` to match exactly `^stack/[0-9a-f]{40}$` (with no `source_sha`) for `rollback`. The commit must be an ancestor of `origin/main`.
- Required checks: every context from `GET /repos/nredd/pi-harness/rules/branches/main` (readable by `GITHUB_TOKEN`) unioned with classic branch protection `required_status_checks` must be `completed`/`success` on that exact SHA. Review statuses are not required checks.
- Registry-stack evidence: a CI run on that SHA with `event=push`, `branch=main`, conclusion `success`, containing job `stack (ubuntu-24.04, personal)` whose step starting with `Assembled D and E boundaries` concluded `success` (not `skipped`). That job installs the explicit personal sources from the registry and the core release into a disposable tree. The step prefix is asserted against `ci.yml` by a test.
- Docs-only SHAs cannot be promoted: CI skips the stack job for them, so no run qualifies. Promote the nearest commit where the stack job ran, or a later one.
- Owned packages: `scripts/npm_release.py stack-check` runs per `@nredd/` source against a worktree of its exact tag: registry presence, npm `audit signatures` (signature and attestation), and the SLSA provenance binding to `publish.yml`, the tag and the commit.
- Core: asset digests are compared with the release's `SHA256SUMS`. The CI stack job additionally fetched that release with `gh attestation verify` against `nredd/pi`.
- Stable pointer: the current `stable.json` is verified with `gh attestation verify --repo nredd/pi-harness --signer-workflow .../promote-stack.yml --source-ref refs/heads/main` before it is used for ancestry.
- Ancestry: the candidate `source_sha` must differ from stable's and be a descendant of it (`git merge-base --is-ancestor stable candidate`). A duplicate, stale, or diverged candidate fails before anything is written. The first seed has no stable and skips this.

The CI evidence is the only coupling to CI: run IDs are read with `gh run list/view`, the `actions: read` and `checks: read` permissions are granted, and an unreadable response fails with an explicit error.

## Required-check visibility

Today `main`'s checks live in classic branch protection, and `rules/branches/main` returns `[]`. Classic protection needs Administration read, which `GITHUB_TOKEN` cannot have. Either:

- Preferred: move the eight checks into a branch ruleset `required_status_checks` rule. No token is needed.
- Or add repository secret `STACK_PROMOTION_RULES_TOKEN`: a fine-grained token on this repository with only Repository permission Administration: read. The workflow uses it for one `gh api` call and nothing else.

If neither yields a check, `verify` fails naming the token.

## Operations

Dispatch `Promote stack` with `operation`:

- `verify-only` (the default): runs every check above, builds the snapshot, and checks it against the attested stable pointer. Writes nothing: no artifact, release, attestation, tag, or branch, and the `attest-and-publish` job (the only job in the `stack-promotion` environment, with write credentials) is skipped. Run it first to see exactly what a promotion would do; it needs no approval.
- `promote`: `verify-only` plus attestation and publication.
- `rollback`: dispatch with `rollback_tag=stack/<source_sha>` and no `source_sha`. The retained release asset is downloaded, its attestation and schema are verified, and only `stack-channel` is advanced. The immutable release is untouched. Rollback is the only way the pointer moves to a non-descendant.

Privilege split: the `verify` job runs only `main` code plus data from the selected commit, holds `contents`/`actions`/`checks` read only, and runs no `npm ci` or `uv sync` from the selected commit. The `attest-and-publish` job holds `id-token`/`attestations`/`contents` write, installs nothing, and only downloads the verified artifact, attests, and publishes.

## Release and pointer

`promote` attests `stack-snapshot.json` (`actions/attest-build-provenance`), creates release/tag `stack/<source_sha>` containing it, confirms the tag points at `source_sha`, then pushes a commit containing only `stable.json` (byte-identical to the snapshot) to `stack-channel`. The tag namespace deliberately does not overlap package tags (`@nredd/<package>@<version>`).

Resume: if `stack/<source_sha>` already exists (the pointer push failed), the workflow downloads that release's snapshot, verifies its attestation, requires it to be byte-equal to the rebuilt snapshot, and then advances only the pointer. Evidence is deterministic (sorted checks, earliest qualifying run), but if the required-check set changed in between, equality fails closed; investigate or roll back to the retained snapshot.

## Owner touchpoints

- Environment `stack-promotion` with required reviewers (the approval gate for every write), holding secret `STACK_CHANNEL_DEPLOY_KEY`.
- Ruleset on `refs/tags/stack/**`: block update and deletion. Creation stays open: an unattested tag is unconsumable because consumers verify attestation, and `GITHUB_TOKEN` creates the tag through the release.
- Ruleset on `refs/heads/stack-channel`: block deletion and force-push, and restrict pushes to a bypass actor. `GITHUB_TOKEN` cannot be a bypass actor, so the workflow pushes with a repository deploy key that has write access: add its public half as a deploy key with write access and as a ruleset bypass actor (Deploy keys), and store the private key as the `STACK_CHANNEL_DEPLOY_KEY` environment secret. A GitHub App with bypass would also work but would need a token-minting step; the deploy key is what the workflow uses. The workflow pins GitHub's SSH host keys from the `meta` API.
- Optionally the read-only `STACK_PROMOTION_RULES_TOKEN` above, if checks stay in classic protection.
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

After this PR merges and the touchpoints exist, run `verify-only` on current `main`'s SHA, then `promote` with the same SHA. No prior `stack-channel` exists, so ancestry is skipped and the first run seeds the branch as an orphan containing only `stable.json`. This PR dispatches nothing and creates no tag, release, branch, ruleset, environment, or secret.
