# Core release train

Preparation for [#774](https://github.com/nredd/pi-harness/issues/774), authorized separately
from the source issues. This draft is NOT mergeable or released. It preserves the complete
changes from #754 and #767; neither original should close until its replacement lands.

## Frozen source

- Canonical core: `ee059aa4050a221a83dae782f4575b1258e84b45` on `nredd/v1.3.0`.
- Previous release: `v1.3.0-nredd.10`, commit `4d857379f37f83397871a66c522abbe8469a003d`.
- Next unused tag at preparation: `v1.3.0-nredd.11`. Do not create a bare upstream tag.
- Complete source delta: #27 unavailable-tool diagnostics (`52b517bd2`), #28 compaction
  (`7ace73f14`), #31 previous-user navigation (`963e8a588`), #32 timestamps (`ee059aa40`).
- Open core #26 at `979cf1f4a46fa44b13aa0dc70bc36dbe3a991859` is excluded.
- Exact canonical core CI [43193144095](https://github.com/nredd/pi/actions/runs/43193144095)
  completed successfully: lock audit, restored release model data, offline build, check,
  daemon build, sandboxed full tests and MCP conformance actually executed.

The inherited per-feature reviews are not a new whole-release review. Parent must consume
exact-candidate final review/critic before signing. The active `Fork release tags` ruleset
`25519508` restricts creation/update/deletion to the owner admin role. Do not modify it.

## Preparation evidence and blockers

On this canonical source, local offline build and `npm run check` passed. The assembled
`make check-core-compaction` passed both real direct/routed child cases, including child-local
settings and parent/sibling isolation. Existing generated subagents module-type warning remains.
In-process lint passed (57 files), and types passed before the uncommitted developer probe.

The unchanged `.10` root overrides passed all four asset checksum/provenance checks. Forks
CI now runs that same preflight before installing root dependencies for the child probe, with
the read-only token scoped to the preflight step only. A regression binds ordering and token
scope; it failed before the workflow fix and passed afterward. The real
released-host transcript gate remains RED: 3 passed, 2 failed explicitly requiring #32.
The unchanged exact Gitlink identity test fails because `ee059aa40` has no release tag.
A temporary, uncommitted candidate alias config passed all five transcript cases on Node and
Bun; it is developer evidence ONLY, not released-host, stack or merge evidence. No alias or
fallback is committed. Full local `make check` has not passed and is not claimed.

This is a staged preparation branch, not permission to merge source-only Gitlinks. The
pre-tag source probes and canonical core CI do not replace post-publication combined gates.
Do not run a knowingly red full matrix merely to relabel the same missing release prerequisite.

## Ordered continuation

1. Parent reviews the canonical source and this draft, resolves any findings and admits the
   owner-signed exact-source tag. No signing or publication is performed by this preparation.
2. Push only `v1.3.0-nredd.11` on the admitted source. Existing `Fork release` builds, checks,
   tests, packs and attests exactly four tarballs plus `SHA256SUMS`. Never run manual release
   creation. Retain terminal run evidence and verify every tarball's digest and provenance.
3. Continue this ONE draft: replace every selected `.10` core dependency/override with the
   published `.11` URL; refresh the development lock through npm; update the published-digest
   guard in `integration/tests/test_release.py`; select the same tag and formula-asset SHA-256s
   in `integration/stacks/personal.json`; regenerate `runtime-locks.json` through the documented
   producer and review transitive drift. Keep owned npm selections unchanged for this core train.
   Search all current manifests and behavior assertions, not only the four root overrides.
   Generate the release receipt on a clean source tree; do not invent placeholder digests.
4. Run actual `make check`, root override authentication, both released-host transcript engines,
   child probes and exact-HEAD PR CI. Renew both axes and parent critic after the artifact-backed
   HEAD changes. Merge only this coherent released-core selection, then resolve #754/#767 with
   explicit preservation receipts. Draft preparation reviews do not admit the later HEAD.
5. Freeze that merged combined main candidate and dispatch full `ci.yml`. Require every executed
   matrix/core cell and retained artifact through `harness.release_gate`. Main push smoke and old
   PR runs are not substitutes. Unrelated subsequent main changes do not stale the frozen SHA.
6. Dispatch `promote-stack.yml` `verify-only`, then `promote` for that exact verified SHA. Parent
   links the run; the owner alone approves `stack-promotion`. Do not approve it on their behalf.
7. Prepare tap and dotfiles changes in separate worktrees, verify the exact promoted pin and tap
   checksums, gate/review/push their PRs, and use the documented managed interactive
   `chezmoi update --upgrade`. Require live `pi-profile doctor` and `--diff` green, exercise the
   patched behavior, and restart sessions. Do not touch applied files or the dirty owner checkout.

## Separate package follow-up

Inventory is frozen at harness base `995fe3b1b1e6c870b816ae60280648545e762cb2`, using
`git log <selected-package-tag>..995fe3b1 -- packages/<name>`, not stale changelog headings.
No package version bump or publication is included in this core preparation.

| Selected package tag | Landed changes since that tag | Follow-up scope |
| --- | --- | --- |
| `pi-preset@0.4.0` | #760 routed physical-model footer | Feature release candidate |
| `pi-subscription-router@0.6.0` | #744 versioned routing policies | Feature release candidate |
| `pi-computer-use@0.7.0` | #714 actions; #730 browser fixes; #732 disconnects; #749 cancellation; many coverage/sync-ledger changes through #773 | Separate reviewed feature release; native desktop/TCC acceptance remains distinct |
| `pi-subagents@0.22.0-nredd.10` | #716 coverage closure | No demonstrated independent release need |
| `pi-plan-mode@0.59.3-nredd.4` | #691 policy-state typing/model-switch extraction | Review independently before deciding publication |
| `pi-todo@2.15.0` | None | Do not bump |
| `pi-session-kit@0.11.0` | #716 coverage; #752 sampler consumer/loss diagnostics | Coordinate sampler dependency review |
| `pi-dev-tools@0.8.0` | #676 smoke diagnostics; #716 coverage; #752 sampler consumer/loss diagnostics | Coordinate sampler dependency review |

These are source-scope proposals, not chosen new versions or publication evidence. Preserve
pending #742, #763, #764, #771 and #772; none is merged or required merely to publish core.
Infrastructure agents own supervisor deployment and privileged disk inventory. This preparation
does not change host services, delete unrelated files, or duplicate their work.
