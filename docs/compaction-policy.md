# Compaction operating targets

Source dependency: merged [nredd/pi#28](https://github.com/nredd/pi/pull/28) at
`7ace73f14`, followed by navigation #31 and timestamps #32. The coordinated candidate is
canonical `nredd/v1.3.0` commit `ee059aa4050a221a83dae782f4575b1258e84b45`, not
pre-squash source `569a2e9219a351d0e109f909392291927dfe1641`. The original harness Gitlink
was `4d857379f37f83397871a66c522abbe8469a003d`. The intervening unavailable-tools fix is
landed; unrelated upstream-sync core PR #26 is excluded. Release coordination is tracked in
[#774](https://github.com/nredd/pi-harness/issues/774).

Core owns the shared policy used by direct, virtual and child sessions. `targetTokens` defaults
to `"auto"`: our application fallback is `min(128000, floor(0.5 * B))`, with `B` equal to
`contextWindow - reserveTokens`, bounded by a verified hard input ceiling if supplied. Unknown
capacity uses the 128000 application cap without inventing a hard window. The exact selected
model override wins over the exact physical override, ordinary target and default. A positive
safe integer explicitly sets the working target; `"contextWindow"` is the legacy opt-out.

Reserve, retained-history and summary output budgets remain independent. The entire pending
input suffix stays verbatim until its answering request dispatches. Large extension context
must not cause an earlier user instruction in that batch to be summarized before its first
answer. Committed `turn_end` and `agent_before_settle` batches share that registration,
including provider-visible `display: false` custom messages; previews register nothing.
Summary dispatches and failed request gates do not release the pending batch. The recommendation
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

The owner separately authorized release coordination in #774. Preparation remains draft until
`v1.3.0-nredd.11` is signed, published and authenticated, and all dependencies, overrides,
locks and stack selections match it. The exact-release identity gate stays unchanged: this
untagged candidate cannot pass `make check` against the old selected release. Do not merge the
Gitlink alone. Preserve #754's child probes and #767's timestamp tests together; the original
PRs stay open until the coordinated replacement lands. Parent owns pre-tag admission, final
critics, CI observation, protected merges and the owner-only promotion environment approval.
Preparation is not publication, promotion or live activation.
