# Compaction operating targets

Source dependency: [nredd/pi#28](https://github.com/nredd/pi/pull/28), based on
`52b517bd246b19f5b75fa70bd6e01b952a18583f` (`nredd/v1.3.0`), with candidate
`a8715607c5e2e59457f0982879e2d5278dc8237a`. The original harness Gitlink was
`4d857379f37f83397871a66c522abbe8469a003d`. The intervening fork commit is the landed
unavailable-tools fix, not the unrelated upstream-sync work in core PR `#26`.

Core owns the shared policy used by direct, virtual and child sessions. `targetTokens` defaults
to `"auto"`: our application fallback is `min(128000, floor(0.5 * B))`, with `B` equal to
`contextWindow - reserveTokens`, bounded by a verified hard input ceiling if supplied. Unknown
capacity uses the 128000 application cap without inventing a hard window. The exact selected
model override wins over the exact physical override, ordinary target and default. A positive
safe integer explicitly sets the working target; `"contextWindow"` is the legacy opt-out.

Reserve, retained-history and summary output budgets remain independent. The recommendation
mapping is empty: provider product defaults and examples do not establish a universal Pi
quality optimum. Sources and retrieved passages live in the Gitlinked core's
`packages/coding-agent/docs/compaction-policy-evidence.md`.

Candidate verification, separate from the release-tarball host used by ordinary owned tests:

```sh
git submodule update --init forks/pi
# Install/build the fork using docs/forks.md, including its pinned release model data.
make check-core-compaction
```

The target builds the real `subagents` bundle, checks formatting/lint/types against candidate
core source, then runs `integration/core-source/compaction-children.test.ts` in an empty HOME
and environment with no credentials. The real `Agent` tool creates direct and routed children
on the shared model runtime. Faux requests verify the automatic fallback after a large read,
child-local settings, and isolation from the parent and a later sibling with an explicit target.
No transport calls a provider. The existing `Forks` workflow runs this target after its native
core gate, after installing the root owned dependencies. No installed host is replaced.

This PR only coordinates source and verification. It does not publish core, change release or
stack selections, edit live configuration, or activate this behavior. Merge core first. The harness Gitlink PR remains draft: the existing shipped-stack identity
test requires an exact released tag, so an untagged source candidate cannot pass `make check`
while the shipped stack still selects the old release. That invariant is unchanged. A later,
separately authorized release and matching stack coordination are prerequisites to admitting the
Gitlink update. No release is authorized in this issue. Parent owns that coordination, critics,
CI observation and merges.
