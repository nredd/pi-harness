# Authenticated installer runtime locks

The hardened standalone installer requires two independently attested release assets:
`stack-snapshot.json` (unchanged strict evidence schema v1) and `dependency-graph.json`
(new strict supplemental schema v1). Both use the existing protected promotion workflow's
GitHub attestation identity. Historical snapshot-only promotions are unsupported by this
installer; they are not silently upgraded or repinned.

## Source ownership and trust

`integration/stacks/personal.json` selects the top-level stack.
`integration/stacks/runtime-locks.json` freezes native npm v3 core/agent locks for
`darwin-arm64` and `linux-x64`, including optional/native package records. The root manifests
are derived, not another editable package list. The source locks bind the canonical stack
SHA-256; the supplemental release asset adds the exact promoted `source_sha`.

Initial lock generation selects registry bytes under the owner's current transport trust.
This is NOT independent upstream publisher assurance. Review that initial selection and
its diff before promotion. Existing owned top-level npm provenance and core release
attestations remain mandatory and are cross-checked against the frozen graphs. Third-party
publisher attestations are not universally available and are not invented here.

Regenerate deliberately after changing the selected stack or resolving a dependency update:

```sh
cd integration
uv run --locked python -m harness.runtime_lock \
  --stack stacks/personal.json --output stacks/runtime-locks.json
```

Generation uses the selected native npm, empty npm configuration, no credentials and
`--package-lock-only --ignore-scripts`, separately for both supported targets. Commit the
source locks with the selection change; do not regenerate during promotion or resume.
The initial committed lock was generated with npm 11.20.0. These are runtime locks, not the
root development workspace `package-lock.json`.

Both graphs take all four fork packages (`pi-coding-agent`, `pi-tui`, `pi-agent-core`, `pi-ai`)
from the selected core release assets, the same four the root `package.json` overrides. The core
graph depends on `pi-coding-agent` and overrides the other three; the agent graph overrides all
four, which also stops automatic peer resolution from following newer upstream releases. The fork
`pi-ai`/`pi-agent-core` carry fixes upstream 1.3.0 lacks (e.g. nredd/pi#16), so installing upstream
copies under the fork CLI is wrong. Pi's Node extension loader aliases
ordinary Jiti imports to the running core (`forks/pi/packages/coding-agent/src/core/extensions/loader.ts`),
but native imports or subprocesses need not use that loader. The agent graph therefore
keeps the fork peer rather than assuming every import is aliased.

The stack records SHA-256 for the formula-consumed assets only (`pi-coding-agent`, `pi-tui`). The
other two come from the release `SHA256SUMS` (`runtime_lock.core_checksums`; recorded digests win),
and the installer and promotion (`promotion.verify_core_assets`) additionally download and
`gh attestation verify` them, so all four are authenticated identically. Acquisition requires the
release SHA-256 for every GitHub-hosted tarball. `test_every_fork_core_package_resolves_to_the_selected_release`
requires every `@earendil-works/pi-{coding-agent,tui,agent-core,ai}` in both graphs on both targets to
resolve to the selected release.

## Producer and consumer

Promotion reads the exact source commit's lock file via Git, requires its roots/digest to
match the selected stack, compares owned root SRI with verified publication evidence, and
downloads every graph tarball to verify selected bytes. Core URL bytes must additionally
match the authenticated core release SHA-256. It writes `dependency-graph.json`, uploads
and attests BOTH assets, and publishes them together. Resume requires byte equality and
valid existing attestations for BOTH assets. An old release missing the graph is refused;
no existing promotion is backfilled.

The installer verifies both assets using the same fixed repository, signer workflow,
`refs/heads/main` and hosted-runner requirements. It rejects a graph for another source or
stack. Before staging, it verifies all selected-platform tarball bytes against authenticated
SHA-512 SRI, never live registry-supplied expected hashes. Native npm imports only these
local verified tarballs into a fresh cache and runs `npm ci --offline --ignore-scripts`.
A cache miss fails closed. No `pi install` or lifecycle code executes during staging.

Tar extraction envelopes refuse traversal, ambiguous prefixes, escaping links, unsupported
entry kinds, more than 100,000 members or more than 512 MiB expanded bytes per archive.
Historical single-prefix npm archives are supported using npm/pacote's strip-one layout.
Bundled dependencies are authenticated by their parent's archive. After replay, all installed
archive files/links are compared with authenticated bytes; unexpected files are refused.
The verification directory holding authenticated archives stays alive through planning, staging
and executable checks, including plan-only and no-op reruns. The same actual-byte audit precedes
a rerun's installed executable check. Missing optional
packages cannot execute and may be omitted by native npm; present optional packages receive
the same byte audit.

This does not sandbox later package behavior, concurrent same-user file swaps, or filesystem
access by installed code. Dotfiles' independent installation path remains unchanged and is
NOT covered by this runtime-lock guarantee. Its strict snapshot-v1 decoder needs no change:
the new asset adds an installer requirement, not extra snapshot fields.

## Verification and bootstrap boundary

`integration/tests/test_runtime_lock.py` exercises real native npm offline replay, coherent
same-version top-level/transitive byte replacement, metadata non-resolution, cache misses,
archive changes and installed-file corruption. `test_runtime_promotion.py` checks exact
asset authentication ordering, foreign/missing/unbound graphs and immutable publication.
Fixtures use disposable paths and no real credentials.

The required personal `stack` CI cells additionally run:

```sh
cd integration
uv run --locked python -m harness.runtime_lock \
  --stack stacks/personal.json --replay stacks/runtime-locks.json
```

This downloads the source-selected graph, replays and audits both roots, then starts the
verified core with `--version` in a private HOME. It proves source-lock runtime compatibility,
NOT verification of a published supplemental attestation. Do not run harness scenarios locally.

The retained installer acceptance default `stack/24889f7` has no supplemental asset.
Acceptance explicitly tests its refusal and reports successful-install/rerun/consent/kill
acceptance as NOT RUN for that exact historical selection. After the first ordinary,
owner-approved new-format promotion, dispatch installer acceptance with that SHA to exercise
the complete real GitHub-attestation-to-install chain on both supported platforms. No tag,
promotion, activation or pin update is performed by this implementation PR.
