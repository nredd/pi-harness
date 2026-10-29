# Stack promotion

`integration/stacks/personal.json` is the only editable personal package list. A promotion turns one exact, already-gated `main` commit into an attested `stack/<sha>` release. Flow: verify -> attest -> `stack/<sha>` release -> dotfiles pins the sha. There is no moving pointer: consumers pin an exact `source_sha`, never `main`. This is the trust root for adoption, so every gate fails closed.

Full [frozen-candidate verification](release-verification.md) is mandatory before snapshot
construction. It requires actual full matrix/core execution and retained artifacts for the exact
combined source SHA, not the selective push/main smoke or old PR checks. Unrelated later main
advancement does not invalidate a frozen verified candidate. No operation waives this barrier.

## Snapshot format

`stack-snapshot.json` is compact, sorted JSON with this strict schema (`integration/harness/promotion.py`):

- `schema_version`: currently `1`.
- `source_sha`: the exact 40-character `main` commit selected.
- `stack`: the validated `personal` stack object, including ordered sources and core release identity.
- `stack_sha256`: SHA-256 of compact sorted UTF-8 JSON for `stack`, not of the surrounding snapshot.
- `gates`:
  - `required_checks`: the configured `main` check names, all successful on `source_sha`.
  - `stack_run_ids`: the qualifying full-dispatch CI run for this exact frozen candidate.
  - `owned_packages`: one `{package, integrity}` per `npm:@nredd/` source, with the registry's real SHA-512 integrity from `scripts/npm_release.py stack-check`.
  - `core`: the core release tag and asset SHA-256 digests, which must equal the stack's `core` and the release's `SHA256SUMS`.

The snapshot's `stack` JSON obeys the canonical-JSON rules in `integration/README.md` (no floats, unsafe integers, non-string keys or lone surrogates); the producer guard lives in `integration/harness/stack.py`.

The module rejects unknown fields, malformed SHAs, non-personal stacks, digest mismatch, duplicate evidence, and owned-package evidence that is not exactly the stack's `@nredd/` sources.

## What gets verified

Workflow: `.github/workflows/promote-stack.yml` (`workflow_dispatch`, `main` only). The workflow concurrency group is `operation` plus the selected SHA, so a `verify-only` dispatch never replaces a pending `promote` of the same commit and two promotions of one SHA run one at a time. With 3+ duplicate same-SHA, same-operation dispatches GitHub keeps one pending run and cancels older pending ones, so duplicate pending dispatches coalesce. That is harmless: `stack/<sha>` creation is idempotent and fails closed on mismatch. Different SHAs are independent: each writes only its own `stack/<sha>` tag and release. Every job has `if: github.ref == 'refs/heads/main'`. All gate logic lives in Python with fixture tests, and every `run:` is one Python (or one `gh`/action) call with inputs passed through `env:` only. The read-only `verify` job runs `harness.release_gate` followed by `python -m harness.promotion_verify`, which repeats the full barrier before candidate construction and fetches the remaining evidence itself (`gh`/`git` through `promotion.run_command`) and calls `select_source_sha`, `descends_from`, `verify_required_checks`, `registry_stack_runs`, `verify_core`, `collect_owned_evidence` (worktree per owned tag plus `stack-check`), `build_gates` and `build_snapshot`. The write-privileged `attest-and-publish` job runs stdlib-only `python3 -m harness.publish_gate` subcommands `prepare-release` and `tag-target` (the complete set), plus `gh attestation verify`, `actions/attest-build-provenance` and `gh release create`. `harness.promotion` is a library with no CLI. Evidence failures and Git failures print `FAILED: ...`, never a traceback.

- Inputs: `select_source_sha` (called by `promotion_verify`) requires `operation` to be `verify-only` or `promote` and `source_sha` to match `^[0-9a-f]{40}$`. The commit must be an ancestor of `origin/main`. The `fetch origin main` that gets `origin/main` carries no credentials (`persist-credentials: false`), which is fine because the repository is public.
- Required checks: every context from `GET /repos/nredd/pi-harness/rules/branches/main` (ruleset `main required checks`, readable by `GITHUB_TOKEN`) must be `completed`/`success` on that exact SHA, reported by the rule's `integration_id` app (`app.id`, 15368 for every configured context). No checks from the rules API fails closed. Review statuses are not required checks.
- Deferred, review statuses (`migration-review/standards`, `migration-review/spec`): they are no longer required checks and the merge flow posts no commit statuses (`docs/ci.md`), so there is nothing to read; reviews stay a process step.
- Deferred, tap readiness when core changes: not implemented; the core release's asset digests and attestation are the only core gate, and a tap bump is gated by its own green CI.
- Registry-stack evidence: the exact full `workflow_dispatch` run validated by `harness.release_gate`. Every native matrix cell and the core gate must actually execute, with retained nonempty per-cell artifacts whose `workflow_run` id and `head_sha` match. Both step names and artifact templates are bounded producer contracts guarded by tests; update the verifier alongside producer renames. The personal stack installs the explicit sources from the registry and the core release into a disposable tree.
- Why the artifact: a skipped cell still reports its job as `success` (recorded run `39545048647` shows `stack (macos-14, personal)` green on a main push though it ran nothing). `ci.yml` uploads `stack-<os>-<stack>` only when `steps.plan.outputs.run == 'true'`, so docs-only and main-push smoke cells never produce it. The verifier matches only the exact artifact name, and a test guards that template in `ci.yml`.
- Docs-only pushes do not supply release evidence. A manual full dispatch can verify their exact candidate without the docs bypass. Artifacts expire with CI retention; rerun the exact frozen candidate when its evidence expires.
- Owned packages: `scripts/npm_release.py stack-check` runs per `@nredd/` source against a worktree of its exact tag: registry presence, npm `audit signatures` (signature and attestation), and the SLSA provenance binding to `publish.yml`, the tag and the commit. The registry lookup (`npm view`) runs in a fresh empty directory with `NPM_CONFIG_USERCONFIG=/dev/null` and `--registry https://registry.npmjs.org`, so a `.npmrc` in the selected tag's tree cannot steer it.
- Core: asset digests are compared with the release's `SHA256SUMS`. For non-legacy tags `SHA256SUMS` is a mutable release asset, so each recorded asset is also downloaded, hashed against the recorded digest, and verified read-only with `gh attestation verify --repo nredd/pi --signer-workflow nredd/pi/.github/workflows/fork-release.yml --source-ref refs/tags/<tag>`. Legacy tags `v1.3.0-nredd.3` through `.7` predate that workflow and rely on the frozen `LEGACY_CHECKSUMS` hashes.

Core SSH signing keys are checked by the core release workflow, not by the promotion
consumer's attestation verifier. The core allowlist uses principal `nredd` and namespace `git`:
MacBook `SHA256:YHzjQXY3SPl20zOMMOoNz8o4dk+eOZEi8FA+vS6nwFY` (retained for historical tags)
and Mac mini (`nick-mac`) `SHA256:+16+g7/7VKDJ2svgiuGIbfPnPF9pKKSU/h51+K9iHdk`.
The latter is owner-approved for `.8` and future releases. No wildcard principal, skipped
verification, new legacy exception, Gitlink move, or stack/pin change is implied.
The [trust-location audit](source-provenance.md#core-release-signer-trust) records the separate
core, harness, dotfiles and tap boundaries.

The CI evidence is the only coupling to CI: run IDs are read with `gh run list/view`, the `actions: read` and `checks: read` permissions are granted, and an unreadable response fails with an explicit error.

## Required-check visibility

All twelve matrix contexts are configured in active ruleset `main required checks`
(id `25524267`, app `15368`), including the four replacement WSL matrix contexts. The owner
authorized `strict_required_status_checks_policy=false`; checks and protections remain active,
with no bypass actors. No protection edit is part of this change. The verifier discovers the live contexts rather than hard-coding eight, nine or twelve, so `GET /repos/nredd/pi-harness/rules/branches/main` returns them to `GITHUB_TOKEN` with no extra token. Classic branch protection is not read: if the rules API yields no check, `verify_required_checks` fails closed.

## Operations

Dispatch `Promote stack` with `operation`:

- `verify-only` (the default): runs every check above and builds the candidate snapshot. Writes nothing: no artifact, release, attestation or tag, and the `attest-and-publish` job (the only job in the `stack-promotion` environment, with write credentials) is skipped. Run it first to see exactly what a promotion would do; it needs no approval.
- `promote`: `verify-only` plus attestation and the `stack/<sha>` release.

Rollback is re-pinning: point dotfiles at an older retained `stack/<sha>`. Nothing in this repository moves, so there is no rollback operation. Tags are protected from update and deletion (ruleset `25524298`); release assets are not, but a replaced asset fails `gh attestation verify`, so every previously promoted snapshot stays usable only as attested.

Environment: `environment: stack-promotion` gates the whole `attest-and-publish` job, so a required reviewer (the owner) must approve before the job gets `contents`/`attestations`/`id-token` write. It is kept deliberately: it is the only human gate between a green `verify` and a permanent attested release, and a release cannot be retracted. It also restricts the job to `main`. No secret is stored in it any more.

Privilege split: the `verify` job runs only `main` code plus data from the selected commit, holds `contents`/`actions`/`checks` read only, and runs no `npm ci` or `uv sync` from the selected commit. The `attest-and-publish` job holds `id-token`/`attestations`/`contents` write, installs nothing, and only downloads the verified artifact, runs `harness.publish_gate` (standard library only, from `main`, asserted by a test), attests, and publishes.

## Release

`promote` attests `stack-snapshot.json` (`actions/attest-build-provenance`), creates release/tag `stack/<source_sha>` containing it, then confirms the tag points at `source_sha`. The tag namespace deliberately does not overlap package tags (`@nredd/<package>@<version>`).

Resume: `prepare-release` runs before any attestation. It asks `git/matching-refs/tags/stack/<sha>` for the exact ref; only an empty answer means `create`. Any `gh` failure (403, 5xx, rate limit) raises instead of being read as "absent". An existing tag must be a lightweight tag pointing at `source_sha` (annotated tags are rejected: `gh release create --target` only makes lightweight tags, so one is hand-made), its release must carry `stack-snapshot.json` (otherwise refuse), and the asset must be byte-equal to the rebuilt snapshot (`resume`). Its attestation is then verified and nothing new is created. `tag-target` re-reads the ref after publication and requires the same. Evidence is deterministic (sorted checks, earliest qualifying run); if the required-check set changed in between, equality fails closed, so investigate.

## Owner touchpoints

Created 2026-10-20 via `gh api`; the workflow does not create or change any of them:

- Ruleset `25524267` `main required checks`: twelve active contexts (`integration_id` 15368, non-strict), with no bypass actors. Preserve that policy.
- Environment `stack-promotion`: required reviewer the owner, deployment branches `main` only. The only job in it is `attest-and-publish`.
- Ruleset `25524298` `stack snapshot tags` on `refs/tags/stack/**`: blocks tag update and deletion; bypass is admin. It does not protect release assets, but consumers verify the attestation, so a tampered asset is rejected. Creation stays open: an unattested tag is unconsumable because consumers verify attestation, and `GITHUB_TOKEN` creates the tag through the release.
- One-time cleanup after this PR merges (the owner/orchestrator does it, the workflow does not): delete ruleset `25524297` and deploy key `167140535`, and remove the `STACK_CHANNEL_DEPLOY_KEY` env secret from `stack-promotion`. All three belonged to the retired `stack-channel` pointer.

## Consumer requirements

Consumers pin an exact `source_sha`, download the `stack/<source_sha>` release asset and MUST verify its attestation before use:

```
gh release download stack/<source_sha> --repo nredd/pi-harness --pattern stack-snapshot.json
gh attestation verify stack-snapshot.json --repo nredd/pi-harness \
  --signer-workflow nredd/pi-harness/.github/workflows/promote-stack.yml \
  --source-ref refs/heads/main --deny-self-hosted-runners
```

Then validate it with `StackSnapshot` (`integration/harness/promotion.py`) and require its `source_sha` to equal the pin. `load_promoted_snapshot` does both. `gh attestation verify` needs a GitHub login unless it is given the bundle: the public attestations API serves it anonymously, which is what the installer does (`--bundle`, see [install](install.md)). An unattested file, or one attested from another workflow or ref, must be rejected, keeping the last good stack. To roll back, pin an older retained `stack/<sha>`.

## First promotion

After this PR merges, run `verify-only` on a `main` SHA whose CI ran the stack job, then `promote` with the same SHA and approve the `stack-promotion` environment. This PR dispatches nothing and creates no tag, release, ruleset or environment.

## Retiring owner override

The historical `owner-override` operation is being removed separately by the combined recovery
change. Do not use it. The new full release barrier is unconditional, including for that legacy
input; it cannot waive missing full execution evidence. This PR neither restores nor authorizes
an override, and must be integrated without reverting its separate removal.
