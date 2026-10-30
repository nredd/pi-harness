# Stack promotion

`integration/stacks/personal.json` is the only editable personal package list. A promotion turns one exact, already-gated `main` commit into an attested `stack/<sha>` release. Flow: verify -> attest -> `stack/<sha>` release -> dotfiles pins the sha. There is no moving pointer: consumers pin an exact `source_sha`, never `main`. This is the trust root for adoption, so every gate fails closed.

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

The snapshot's `stack` JSON obeys the canonical-JSON rules in `integration/README.md` (no floats, unsafe integers, non-string keys or lone surrogates); the producer guard lives in `integration/harness/stack.py`.

The module rejects unknown fields, malformed SHAs, non-personal stacks, digest mismatch, duplicate evidence, and owned-package evidence that is not exactly the stack's `@nredd/` sources.

The snapshot schema remains strict v1 and retains its historical owned-only integrity boundary. New promotions additionally publish and independently attest strict `dependency-graph.json`, containing its own schema version, exact `source_sha`, and source-selected complete native runtime locks bound to the canonical stack digest. The hardened standalone installer requires BOTH assets; historical snapshot-only promotions are unsupported, never silently downgraded. Existing dotfiles snapshot-v1 consumers are unchanged and do not gain installer runtime-byte guarantees. Source selection, threat model and bootstrap acceptance limits are documented [here](runtime-locks.md).

## What gets verified

Workflow: `.github/workflows/promote-stack.yml` (`workflow_dispatch`, `main` only). The workflow concurrency group is `operation` plus the selected SHA, so a `verify-only` dispatch never replaces a pending `promote` of the same commit and two promotions of one SHA run one at a time. With 3+ duplicate same-SHA, same-operation dispatches GitHub keeps one pending run and cancels older pending ones, so duplicate pending dispatches coalesce. That is harmless: `stack/<sha>` creation is idempotent and fails closed on mismatch. Different SHAs are independent: each writes only its own `stack/<sha>` tag and release. Every job has `if: github.ref == 'refs/heads/main'`. All gate logic lives in Python with fixture tests, and every `run:` is one Python (or one `gh`/action) call with inputs passed through `env:` only. The read-only `verify` job runs a single `python -m harness.promotion_verify`, which fetches the evidence itself (`gh`/`git` through `promotion.run_command`) and calls `select_source_sha`, `descends_from`, `verify_required_checks`, `registry_stack_runs`, `verify_core`, `collect_owned_evidence` (worktree per owned tag plus `stack-check`), `build_gates` and `build_snapshot`. The verifier also reads `integration/stacks/runtime-locks.json` from that exact source commit, binds its roots/digest to the selected stack, cross-checks owned SRI, and verifies every selected tarball against standard npm SRI (plus authenticated core SHA-256). It never re-resolves the graph during promotion or resume. The write-privileged `attest-and-publish` job runs stdlib-only `python3 -m harness.publish_gate` subcommands `prepare-release` and `tag-target` (the complete set), plus `gh attestation verify`, `actions/attest-build-provenance` and `gh release create`. `harness.promotion` is a library with no CLI. Evidence failures and Git failures print `FAILED: ...`, never a traceback.

- Inputs: `select_source_sha` (called by `promotion_verify`) requires `operation` to be `verify-only` or `promote` and `source_sha` to match `^[0-9a-f]{40}$`. The commit must be an ancestor of `origin/main`. The `fetch origin main` that gets `origin/main` carries no credentials (`persist-credentials: false`), which is fine because the repository is public.
- Required checks: every context from `GET /repos/nredd/pi-harness/rules/branches/main` (ruleset `main required checks`, readable by `GITHUB_TOKEN`) must be `completed`/`success` on that exact SHA, reported by the rule's `integration_id` app (`app.id`, 15368 for every configured context). No checks from the rules API fails closed. Review statuses are not required checks.
- Deferred, review statuses (`migration-review/standards`, `migration-review/spec`): they are no longer required checks and the merge flow posts no commit statuses (`docs/ci.md`), so there is nothing to read; reviews stay a process step.
- Deferred, tap readiness when core changes: not implemented; the core release's asset digests and attestation are the only core gate, and a tap bump is gated by its own green CI.
- Registry-stack evidence: a CI run on that SHA with `event=push`, `branch=main`, conclusion `success`, and a non-expired `stack-ubuntu-24.04-personal` artifact (from `actions/runs/<id>/artifacts`) whose `workflow_run` id and `head_sha` equal the run's and the selected SHA. The artifact is the machine evidence; job names are not consulted, so renaming a matrix cell cannot break or spoof promotion. The stack job installs the explicit personal sources from the registry and the core release into a disposable tree.
- Why the artifact: a skipped cell still reports its job as `success` (recorded run `39545048647` shows `stack (macos-14, personal)` green on a main push though it ran nothing). `ci.yml` uploads `stack-<os>-<stack>` only when `steps.plan.outputs.run == 'true'`, so docs-only and main-push smoke cells never produce it. The verifier matches only the exact artifact name, and a test guards that template in `ci.yml`.
- Docs-only SHAs cannot be promoted: CI skips the native Ubuntu personal cell for them, so its required registry-stack artifact does not exist. WSL cells still run but their differently named artifacts are not promotion substitutes. Promote the nearest commit where the stack job ran, or a later one. Artifacts expire with CI retention, so an old SHA must be re-run through CI before it can be promoted.
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

The historically configured nine required checks live in ruleset `main required checks` (id `25524267`, strict): eight native matrix contexts plus the retired `wsl2 (windows-2022)` context. The new CI produces twelve matrix contexts; an authorized migration must preserve the eight native contexts and replace that obsolete WSL context with `owned (wsl2)`, `contracts (wsl2)`, `stack (wsl2, personal)` and `stack (wsl2, local)` after all twelve are green. No protection edit is part of this change. Until migration the missing old context blocks promotion. The verifier discovers the live contexts rather than hard-coding eight, nine or twelve, so `GET /repos/nredd/pi-harness/rules/branches/main` returns them to `GITHUB_TOKEN` with no extra token. Classic branch protection is not read: if the rules API yields no check, `verify_required_checks` fails closed.

## Operations

Dispatch `Promote stack` with `operation`:

- `verify-only` (the default): runs every check above and builds the candidate snapshot. Writes nothing: no artifact, release, attestation or tag, and the `attest-and-publish` job (the only job in the `stack-promotion` environment, with write credentials) is skipped. Run it first to see exactly what a promotion would do; it needs no approval.
- `promote`: `verify-only` plus attestation and the `stack/<sha>` release.

Rollback is re-pinning: point dotfiles at an older retained `stack/<sha>`. Nothing in this repository moves, so there is no rollback operation. Tags are protected from update and deletion (ruleset `25524298`); release assets are not, but a replaced asset fails `gh attestation verify`, so every previously promoted snapshot stays usable only as attested.

Environment: `environment: stack-promotion` gates the whole `attest-and-publish` job, so a required reviewer (the owner) must approve before the job gets `contents`/`attestations`/`id-token` write. It is kept deliberately: it is the only human gate between a green `verify` and a permanent attested release, and a release cannot be retracted. It also restricts the job to `main`. No secret is stored in it any more.

Privilege split: the `verify` job runs only `main` code plus data from the selected commit, holds `contents`/`actions`/`checks` read only, and runs no `npm ci` or `uv sync` from the selected commit. The `attest-and-publish` job holds `id-token`/`attestations`/`contents` write, installs nothing, and only downloads the verified artifact, runs `harness.publish_gate` (standard library only, from `main`, asserted by a test), attests, and publishes.

## Release

`promote` attests both `stack-snapshot.json` and `dependency-graph.json` (`actions/attest-build-provenance`), creates release/tag `stack/<source_sha>` containing both, then confirms the tag points at `source_sha`. The tag namespace deliberately does not overlap package tags (`@nredd/<package>@<version>`).

Resume: `prepare-release` runs before any attestation. It asks `git/matching-refs/tags/stack/<sha>` for the exact ref; only an empty answer means `create`. Any `gh` failure (403, 5xx, rate limit) raises instead of being read as "absent". An existing tag must be a lightweight tag pointing at `source_sha` (annotated tags are rejected: `gh release create --target` only makes lightweight tags, so one is hand-made), its release must carry BOTH `stack-snapshot.json` and `dependency-graph.json` (otherwise refuse), and both assets must be byte-equal to the rebuilt source-selected evidence (`resume`). Both existing attestations are then verified and nothing new is created. A retained legacy release without a graph cannot be upgraded/backfilled. `tag-target` re-reads the ref after publication and requires the same. Evidence is deterministic (sorted checks, earliest qualifying run); if the required-check set changed in between, equality fails closed, so investigate.

## Owner touchpoints

Created 2026-10-20 via `gh api`; the workflow does not create or change any of them:

- Ruleset `25524267` `main required checks`: the historically configured nine contexts (`integration_id` 15368, strict), pending the authorized twelve-context migration described above.
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

## Historical waived record

`stack/17236539759ccc8858e605ed3f07531cacf2d9e0` is an immutable historical owner-waived record, not green-CI evidence. Do not alter its tag or release, and do not treat retrospective review as satisfying its pre-release gates. The `owner-override` operation no longer exists; recovery requires an ordinary reviewed, green-CI `verify-only` then `promote` flow.
