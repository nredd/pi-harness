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

Workflow: `.github/workflows/promote-stack.yml` (`workflow_dispatch`, `main` only). Concurrency has two levels. The workflow group is `operation` plus the selected SHA (or rollback tag), so a `verify-only` dispatch never replaces a pending `promote` of the same commit. The `attest-and-publish` job also sits in one global `stack-channel` group (`cancel-in-progress: false`), so promote and rollback serialize across SHAs. GitHub keeps only one *pending* job per group, so a second queued write for another SHA replaces the first pending one; the replaced run is cancelled, fails safe with no side effects, and is simply re-dispatched. The global group wins on purpose: interleaved pointer writes are worse than a dropped queue entry. Every job has `if: github.ref == 'refs/heads/main'`. All gate logic lives in Python with fixture tests, and every `run:` is one Python (or one `gh`/action) call with inputs passed through `env:` only. The read-only `verify` job runs a single `python -m harness.promotion_verify`, which fetches the evidence itself (`gh`/`git` through `promotion.run_command`) and calls `select_source_sha`, `descends_from`, `verify_required_checks`, `registry_stack_runs`, `verify_core`, `collect_owned_evidence` (worktree per owned tag plus `stack-check`), `build_gates`, `build_snapshot`, `channel_exists` and `verify_successor`. The write-privileged `attest-and-publish` job runs stdlib-only `python3 -m harness.publish_gate` subcommands `prepare-release`, `preflight-channel`, `tag-target` and `advance-channel` (the complete set), plus `gh attestation verify`, `actions/attest-build-provenance` and `gh release create`. `harness.promotion` is a library with no CLI: the per-stage subcommands and `publish_gate release-state` were deleted because nothing ran them. Evidence failures and Git failures print `FAILED: ...`, never a traceback.

- Inputs: `select_source_sha` (called by `promotion_verify`) requires `source_sha` to match `^[0-9a-f]{40}$` for `promote`/`verify-only`, and `rollback_tag` to match exactly `^stack/[0-9a-f]{40}$` (with no `source_sha`) for `rollback`. The commit must be an ancestor of `origin/main`. The `fetch origin main` that gets `origin/main` carries no credentials (`persist-credentials: false`), which is fine because the repository is public.
- Required checks: every context from `GET /repos/nredd/pi-harness/rules/branches/main` (ruleset `main required checks`, readable by `GITHUB_TOKEN`) must be `completed`/`success` on that exact SHA, reported by the rule's `integration_id` app (`app.id`, 15368 for all eight). No checks from the rules API fails closed. Review statuses are not required checks.
- Deferred, review statuses (`migration-review/standards`, `migration-review/spec`): they are no longer required checks and the merge flow posts no commit statuses (`docs/ci.md`), so there is nothing to read; reviews stay a process step.
- Deferred, tap readiness when core changes: not implemented; the core release's asset digests and attestation are the only core gate, and a tap bump is gated by its own green CI.
- Registry-stack evidence: a CI run on that SHA with `event=push`, `branch=main`, conclusion `success`, and a non-expired `stack-ubuntu-24.04-personal` artifact (from `actions/runs/<id>/artifacts`) whose `workflow_run` id and `head_sha` equal the run's and the selected SHA. The artifact is the machine evidence; job names are not consulted, so renaming a matrix cell cannot break or spoof promotion. The stack job installs the explicit personal sources from the registry and the core release into a disposable tree.
- Why the artifact: a skipped cell still reports its job as `success` (recorded run `39545048647` shows `stack (macos-14, personal)` green on a main push though it ran nothing). `ci.yml` uploads `stack-<os>-<stack>` only when `steps.plan.outputs.run == 'true'`, so docs-only and main-push smoke cells never produce it. The verifier matches only the exact artifact name, and a test guards that template in `ci.yml`.
- Docs-only SHAs cannot be promoted: CI skips the stack job for them, so no artifact exists. Promote the nearest commit where the stack job ran, or a later one. Artifacts expire with CI retention, so an old SHA must be re-run through CI before it can be promoted.
- Owned packages: `scripts/npm_release.py stack-check` runs per `@nredd/` source against a worktree of its exact tag: registry presence, npm `audit signatures` (signature and attestation), and the SLSA provenance binding to `publish.yml`, the tag and the commit. The registry lookup (`npm view`) runs in a fresh empty directory with `NPM_CONFIG_USERCONFIG=/dev/null` and `--registry https://registry.npmjs.org`, so a `.npmrc` in the selected tag's tree cannot steer it.
- Core: asset digests are compared with the release's `SHA256SUMS`. For non-legacy tags `SHA256SUMS` is a mutable release asset, so each recorded asset is also downloaded, hashed against the recorded digest, and verified read-only with `gh attestation verify --repo nredd/pi --signer-workflow nredd/pi/.github/workflows/fork-release.yml --source-ref refs/tags/<tag>`. Legacy tags `v1.3.0-nredd.3` through `.7` predate that workflow and rely on the frozen `LEGACY_CHECKSUMS` hashes.
- Stable pointer: the current `stable.json` is verified with `gh attestation verify --repo nredd/pi-harness --signer-workflow .../promote-stack.yml --source-ref refs/heads/main` before it is used for ancestry.
- Ancestry: whether `stack-channel` exists comes from `channel_exists` over `git/matching-refs` (exact ref, not a prefix). If it exists, `stable.json` must be readable and attested or the run fails; only a missing channel is a seed. The candidate `source_sha` must differ from stable's and be a descendant of it (`git merge-base --is-ancestor stable candidate`). A duplicate, stale, or diverged candidate fails before anything is written. The first seed has no stable and skips this.

The CI evidence is the only coupling to CI: run IDs are read with `gh run list/view`, the `actions: read` and `checks: read` permissions are granted, and an unreadable response fails with an explicit error.

## Required-check visibility

The eight required checks live in ruleset `main required checks` (id `25524267`, strict), so `GET /repos/nredd/pi-harness/rules/branches/main` returns them to `GITHUB_TOKEN` with no extra token. Classic branch protection is not read: if the rules API yields no check, `verify_required_checks` fails closed.

## Operations

Dispatch `Promote stack` with `operation`:

- `verify-only` (the default): runs every check above, builds the snapshot, and checks it against the attested stable pointer. Writes nothing: no artifact, release, attestation, tag, or branch, and the `attest-and-publish` job (the only job in the `stack-promotion` environment, with write credentials) is skipped. Run it first to see exactly what a promotion would do; it needs no approval.
- `promote`: `verify-only` plus attestation and publication.
- `rollback`: dispatch with `rollback_tag=stack/<source_sha>` and no `source_sha`. The retained release asset is downloaded, its attestation and schema are verified, and only `stack-channel` is advanced. The immutable release is untouched. Rollback is the only way the pointer moves to a non-descendant.

Environment: `environment: stack-promotion` gates the whole `attest-and-publish` job, not only the key step, so the reviewer prompt appears before checkout and the read-only steps. The secret itself is referenced only by the last step. No split: the job has no unprivileged work worth running before approval. `advance-channel` writes the key with `O_EXCL`/`0600`, reads SSH host keys unauthenticated from `https://api.github.com/meta`, and gives git/ssh children only `GIT_SSH_COMMAND`, `PATH`, `HOME` and a config-free git environment (no `GH_TOKEN`, no secrets).

Privilege split: the `verify` job runs only `main` code plus data from the selected commit, holds `contents`/`actions`/`checks` read only, and runs no `npm ci` or `uv sync` from the selected commit. The `attest-and-publish` job holds `id-token`/`attestations`/`contents` write, installs nothing, and only downloads the verified artifact, runs `harness.publish_gate` (standard library only, from `main`, asserted by a test), attests, and publishes.

## Release and pointer

`promote` attests `stack-snapshot.json` (`actions/attest-build-provenance`), creates release/tag `stack/<source_sha>` containing it, confirms the tag points at `source_sha`, then pushes a commit containing only `stable.json` (byte-identical to the snapshot) to `stack-channel`. The tag namespace deliberately does not overlap package tags (`@nredd/<package>@<version>`).

Resume: `prepare-release` runs before any attestation. It asks `git/matching-refs/tags/stack/<sha>` for the exact ref; only an empty answer means `create`. Any `gh` failure (403, 5xx, rate limit) raises instead of being read as "absent". An existing tag must be a lightweight tag pointing at `source_sha` (annotated tags are rejected: `gh release create --target` only makes lightweight tags, so one is hand-made), its release must carry `stack-snapshot.json` (otherwise refuse), and the asset must be byte-equal to the rebuilt snapshot (`resume`). Its attestation is then verified and only the pointer advances. `tag-target` re-reads the ref after publication and requires the same.

Preflight: `preflight-channel` runs read-only, after `prepare-release` and before any attestation, release or tag. It requires a non-empty deploy key (only its presence reaches the step, not the secret), reads the live `stack-channel` tip through the API, verifies the tip's attestation (same repo, workflow and `refs/heads/main`, so the write job does not rely on the branch ruleset alone for the tip), and for `promote` applies the same-bytes and descendant (`git merge-base --is-ancestor`) checks. For `rollback` it requires `stack/<sha>` to be a retained, previously promoted snapshot whose release asset is byte-equal to the artifact. A stale key, diverged candidate or unreachable API therefore fails with no permanent release or tag. The re-check below stays as the final guard, because the tip can move after preflight; that re-read is guarded by the ruleset (only the deploy key and admin can write) rather than a second attestation.

Pointer race: `advance-channel --operation promote` re-reads `stable.json` at the live `stack-channel` tip inside the write job and requires the candidate to descend from its `source_sha` (the job checks out full history), so a push that lands between verification and publication is not overwritten by a stale candidate. A tip already equal to the candidate with identical bytes is a no-op; `rollback` skips the check by design. Evidence is deterministic (sorted checks, earliest qualifying run), but if the required-check set changed in between, equality fails closed; investigate or roll back to the retained snapshot.

## Owner touchpoints

Created 2026-10-20 via `gh api`; the workflow does not create or change any of them:

- Ruleset `25524267` `main required checks`: the eight required checks (`integration_id` 15368, strict).
- Environment `stack-promotion`: required reviewer the owner, deployment branches `main` only, secret `STACK_CHANNEL_DEPLOY_KEY` (write deploy key, id `167140535`). The only job in it is `attest-and-publish`.
- Ruleset `25524297` `stack channel pointer` on `refs/heads/stack-channel`: blocks creation, update, deletion and non-fast-forward; bypass actors are the deploy key and repository admin. `GITHUB_TOKEN` cannot be a bypass actor, so the workflow pushes over SSH with the deploy key. It pins GitHub's SSH host keys from the `meta` API.
- Ruleset `25524298` `stack snapshot tags` on `refs/tags/stack/**`: blocks update and deletion; bypass is admin. Creation stays open: an unattested tag is unconsumable because consumers verify attestation, and `GITHUB_TOKEN` creates the tag through the release.
- Dotfiles has no CI, so nothing there is checked automatically.

## Consumer requirements

Consumers MUST NOT trust `stable.json` by branch name. Before use they MUST verify `stable.json`:

```
gh attestation verify stable.json --repo nredd/pi-harness \
  --signer-workflow nredd/pi-harness/.github/workflows/promote-stack.yml \
  --source-ref refs/heads/main --deny-self-hosted-runners
```

`stable.json` is byte-identical to the `stack-snapshot.json` release asset and the attestation subject is its digest, so one verification covers both. To verify the release asset directly:

```
gh release download stack/<source_sha> --repo nredd/pi-harness --pattern stack-snapshot.json
gh attestation verify stack-snapshot.json --repo nredd/pi-harness \
  --signer-workflow nredd/pi-harness/.github/workflows/promote-stack.yml \
  --source-ref refs/heads/main --deny-self-hosted-runners
```

Then validate it with `StackSnapshot` (`integration/harness/promotion.py`). An unattested file, or one attested from another workflow or ref, must be rejected, keeping the last good stack.

## First seed

After this PR merges, run `verify-only` on current `main`'s SHA, then `promote` with the same SHA. No prior `stack-channel` exists, so ancestry is skipped and the first run seeds the branch as an orphan containing only `stable.json`. This PR dispatches nothing and creates no tag, release, branch, ruleset, environment, or secret.
