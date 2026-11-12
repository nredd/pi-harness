# Core release train

Artifact-backed selection for [#774](https://github.com/nredd/pi-harness/issues/774).
This ONE change preserves all #754 child-compaction probes and #767 timestamp tests.
Neither original should close until this replacement lands. Publication, harness admission,
stack promotion and live activation are separate outcomes.

## Released source

- Core: `v1.3.0-nredd.11`, commit `640d64bcd4da08231232b5c08acd48b88ee1fd45`.
- Signed annotated tag object: `09168f564bdecb12ce67826d5a1c108a001c46d0`.
- Previous release: `v1.3.0-nredd.10`, commit `4d857379f37f83397871a66c522abbe8469a003d`.
- Complete source delta: #27 unavailable-tool diagnostics, #28 compaction targets,
  #31 previous-user navigation, #32 timestamps, #34 disabled-compaction budget fix,
  #36 selection preservation and the isolated env fixture repair.
- Open core #26 is excluded. Package versions stay upstream `1.3.0`.
- Canonical CI [43273354732](https://github.com/nredd/pi/actions/runs/43273354732)
  passed the actual audit, restored model data, offline build, check, daemon build,
  sandboxed full tests and MCP conformance.
- Fresh independent Standards and Spec reviews covered the WHOLE shipped `.10`-to-`640d64bc`
  delta, both with no findings. The independent parent whole-release critic also found none;
  [receipt](https://github.com/nredd/pi-harness/issues/774#issuecomment-6831481541).

After explicit parent admission, the owner signed and pushed only the fork tag. Existing
`Fork release` [43275325794](https://github.com/nredd/pi/actions/runs/43275325794)
completed its build and release jobs. All four published tarballs were downloaded and checked
against `SHA256SUMS`, then EACH passed `gh attestation verify` against
`nredd/pi/.github/workflows/fork-release.yml`, `refs/tags/v1.3.0-nredd.11`, exact source digest
`640d64bcd4da08231232b5c08acd48b88ee1fd45` and hosted-runner policy. These are authenticated
CI-built bytes, not a reproducible-rebuild claim or merely a release-existence check.

The Gitlink, all selected core dependency/override URLs, native root lock, published-digest guard,
personal stack and source runtime locks select that same release. Owned npm selections and package
versions are unchanged. Root installs still authenticate all four tarballs before npm runs; the
runtime locks retain both target graphs and both core/agent roots.

## Lock regeneration

Both locks were regenerated through their native producers, not manually patched. Review the
transitive drift independently from the four core URL/integrity changes:

- Development root: AWS/Smithy compatible resolution updates, including `@aws-sdk/core`
  `3.978.7 -> 3.981.0`, nested clients `3.997.52 -> 3.998.3`, token providers
  `3.1159.0 -> 3.1166.0`, `@smithy/core` `3.38.0 -> 3.40.0`, types `4.19.0 -> 4.20.0`;
  `@babel/runtime` `7.29.10 -> 7.29.14`, `tslib` `2.8.1 -> 2.9.1`, `ws` `8.22.0 -> 8.22.2`.
- Both runtime graphs on both targets: AWS credential providers ini `3.973.29 -> 3.973.30`,
  login `3.972.91 -> 3.972.92`, node `3.972.96 -> 3.972.97`; `@babel/runtime`
  `7.29.13 -> 7.29.14`; `graceful-fs` `4.2.11 -> 4.2.12` (registry license metadata
  changes from ISC to BlueOak-1.0.0).
- Agent runtime graph only, both targets: `@hono/node-server` `2.1.7 -> 2.1.8`,
  `encodeurl` `2.0.1 -> 2.0.2`, `typebox` `1.4.6 -> 1.4.7`.

No owned package publication is implied by this resolution drift. Promotion consumes the exact
reviewed source lock; it never resolves another graph.

## Verification boundaries and continuation

Source-only child and timestamp probes were useful before publication, but never admitted a
source-only Gitlink or pretended the `.10` installed host contained timestamps. The artifact-backed
selection now requires actual `make check`, released-host Node and Bun transcript gates, child probes,
registry/local stack CI, exact-final-HEAD independent axes and the parent's critic. Their current
execution evidence belongs in the PR receipt, not an assertion that staging already deployed.

1. Merge only this coherent released-core selection after its exact-HEAD gates and reviews.
   Resolve #754/#767 with explicit preservation receipts.
2. Freeze the merged combined main candidate and dispatch full `ci.yml`. Require every executed
   matrix/core cell and retained artifact through `harness.release_gate`; main push smoke and old
   PR runs are not substitutes.
3. Dispatch `promote-stack.yml` `verify-only`, then `promote` for that same verified SHA.
   The owner alone approves `stack-promotion`; no approval bypass or second package selection.
4. Prepare reviewed tap and dotfiles pins matching that promoted stack and core checksums.
   Only then perform ONE managed `chezmoi update --upgrade`, require live doctor and recursive
   render diff green, exercise patched behavior and restart sessions.

Core #72's future binary-workflow gate is separate work. This release authenticates four npm
workspace tarballs; it does not prove a standalone binary's tested-digest carry, a newer Bun binary
workflow, or a `pi-memory` binary smoke. Keep #72 open; historical 183-clean results are not a
330-case proof. No frozen `.11` source or tag is changed to absorb that work.

## Separate package follow-up

The original preparation inventory below is frozen at harness base
`995fe3b1b1e6c870b816ae60280648545e762cb2`, using
`git log <selected-package-tag>..995fe3b1 -- packages/<name>`, not stale changelog headings.
It is historical source inventory, NOT current package publication or live-install evidence.
Later router reset and agent explanation work must be inventoried separately, not silently
installed or version-bumped in this core-only train.

| Selected package tag | Landed changes since that tag at inventory base | Follow-up scope |
| --- | --- | --- |
| `pi-preset@0.4.0` | #760 routed physical-model footer | Feature release candidate |
| `pi-subscription-router@0.6.0` | #744 versioned routing policies | Feature release candidate |
| `pi-computer-use@0.7.0` | #714 actions; #730 browser fixes; #732 disconnects; #749 cancellation; coverage/sync-ledger changes through #773 | Separate reviewed feature release; native desktop/TCC acceptance remains distinct |
| `pi-subagents@0.22.0-nredd.10` | #716 coverage closure | No demonstrated independent release need |
| `pi-plan-mode@0.59.3-nredd.4` | #691 policy-state typing/model-switch extraction | Review independently before deciding publication |
| `pi-todo@2.15.0` | None | Do not bump |
| `pi-session-kit@0.11.0` | #716 coverage; #752 sampler consumer/loss diagnostics | Coordinate sampler dependency review |
| `pi-dev-tools@0.8.0` | #676 smoke diagnostics; #716 coverage; #752 sampler consumer/loss diagnostics | Coordinate sampler dependency review |

No service deployment, privileged disk cleanup, WSL activation, promotion, tap pin or live apply
is performed by this harness selection.
