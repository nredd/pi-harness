# Stack promotion

`integration/stacks/personal.json` is the only editable personal package list. A promotion turns one exact, already-gated `main` commit into deployment state. Machines must consume `stack-channel/stable.json`, never `main`.

## Snapshot format

`stack-snapshot.json` is compact, sorted JSON with this strict schema:

- `schema_version`: currently `1`.
- `source_sha`: the exact 40-character `main` commit selected.
- `stack`: the validated `personal` stack object, including ordered sources and core release identity.
- `stack_sha256`: SHA-256 of compact sorted UTF-8 JSON for `stack`, not of the surrounding snapshot.
- `gates`: the branch-protection check names, successful registry-byte personal-stack workflow run IDs, selected `@nredd/` subjects, and `core_verified: true`.

`integration.harness.promotion` builds and validates this format. It rejects unknown fields, malformed SHA values, non-personal stacks, digest mismatch, duplicate evidence and source movement that is not a descendant of stable. Dotfiles may import this module or consume the same strict document contract later.

## Promotion

`Promote stack` is intentionally manual (`workflow_dispatch`). A normal promotion requires `source_sha`; it refuses anything outside `main`, reads required status checks from `main` branch protection, and requires every configured check to be completed successfully on that commit. Review receipts are PR comments, not required statuses.

It also requires a successful `stack (ubuntu-24.04, personal)` job whose `Assembled D and E boundaries` step succeeded. That job checks out the selected commit, fetches the selected core release and installs the explicit personal sources into a disposable agent tree, so it is registry/release-byte coverage rather than a local workspace assertion.

For every selected owned npm source, the workflow invokes the existing publisher verifier against its exact signed package tag. That verifier requires npm's signature audit and SLSA subject, tarball-integrity, `publish.yml`, tag and source-commit bindings. Core validation follows `integration.harness.release`: selected `core.integrity` must agree with release checksums and new core tags require `gh attestation verify` against `nredd/pi`'s core-release workflow.

The verified job emits `stack-snapshot.json`, retains it as a 90-day artifact, and creates a GitHub artifact provenance attestation with `actions/attest-build-provenance`.

## Channel and recovery

Each normal promotion creates an immutable GitHub release/tag `stack/<source_sha>` containing the attested snapshot. This deliberately does not overlap package release tags (`@nredd/<package>@<version>`), so discovering the stable stack can never mean "latest release" in this multi-package repository.

The moving discovery pointer is the `stack-channel` branch, which contains only `stable.json`, copied byte-for-byte from the immutable snapshot after its release succeeds. This keeps automatic consumers simple while retaining exact recovery objects separately. Promotion is serialized by the `stack-promotion` concurrency group. Once initialized, a normal candidate must be a different commit descended from the source SHA in `stable.json`; stale, duplicate and accidental rollback candidates fail before the pointer moves.

Rollback is deliberately separate: dispatch with `operation=rollback` and `rollback_tag=stack/<source_sha>`, with no `source_sha`. The workflow downloads the retained release asset, verifies its artifact attestation and snapshot schema, then advances only `stack-channel`. It does not recreate or replace the immutable release.

The owner must create a dedicated tag ruleset for `refs/tags/stack/**` before the first dispatch. It must protect creation, update and deletion analogously to the existing `npm release tags` ruleset, while allowing the promotion workflow's intended release creation. Branch protection must also permit the workflow to advance only `stack-channel`; do not grant package-tag permissions for channel discovery.

## First seed

After this PR merges, the owner selects current `main`'s full 40-character SHA and dispatches `Promote stack` with `operation=promote`. No workflow is dispatched, tag created, release created, branch created, or ruleset changed by this PR. The first run has no prior `stack-channel` pointer and therefore seeds it after all normal verification succeeds.
