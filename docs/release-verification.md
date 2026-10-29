# Frozen release verification

PR merge policy and release policy are separate. A PR needs all configured checks green on its
own final HEAD and independent Standards + Spec reviews of that exact HEAD. Unrelated advancement
of `main` does not require update-branch, a rebase, or another PR matrix. Actual conflicts still
need resolution; every HEAD change needs fresh checks and both reviews. Never weaken checks,
protection, app bindings or review requirements to merge.

The owner authorized non-strict required status checks on ruleset `25524267` on 2026-10-29.
All twelve matrix contexts remain bound to Actions app `15368`, with no bypass actors. This
source change does not edit remote protection. Keep `strict_required_status_checks_policy=false`.
The merge helper still compares the old and replacement executions' tested base SHA when proving
that a cancelled zero-step placeholder was superseded. It does not compare that base SHA against
the moving current main tip. Required checks and reviews remain tied to the unchanged PR HEAD.

Before publication or promotion, freeze one combined `main` candidate and run the complete CI
lane for that exact commit. `ci.yml` manual dispatch disables docs-only and main-push smoke
shortcuts, executes all twelve owned/contracts/stack cells, and calls the existing complete core
fork gate. It reuses the native checks, packed contracts, Node D/E and standalone D/E producers.
It does not make bench F, live-provider G, linux-arm64 runtime, native desktop or the documented
standalone auth-interception exclusions into passes.

After this workflow reaches `main` and GitHub indexes its dispatch trigger:

```sh
gh workflow run ci.yml --repo nredd/pi-harness --ref main
```

Record the run's exact `headSha`. All checkouts use that frozen event commit. If main advances
after dispatch, the run and release candidate remain valid; no newest-tip or timestamp freshness
predicate exists. If the desired candidate is already an older ancestor of main, create a
`release-verification/<full-sha>` branch at that exact commit and dispatch on that ref instead.
The classification step requires both the exact SHA-encoded branch name and main ancestry.
The verifier accepts only `main` or that exact frozen ref, never arbitrary PR branches. Delete
the temporary ref after release evidence is retained. Rerunning the original dispatch also keeps
the original commit. No branch is moved forward merely to satisfy release freshness.

`harness.release_gate` requires a successful `workflow_dispatch` run of `ci.yml`, its exact
candidate `head_sha`, the current attempt's complete matrix and core jobs, the successful actual
execution steps (not just successful job labels), and all retained, nonempty coverage, packed
contract, Node stack and standalone stack artifacts bound to that run and SHA. Missing, skipped,
failed, expired or mismatched evidence refuses. Ordinary push/main smoke and old PR checks are
not fallbacks. Artifacts use normal Actions retention; expired evidence needs a real rerun, not
a replacement receipt. The verifier paginates run, job and artifact collections.

Publication and promotion are distinct candidates and evidence:

- Prepublication: merge the reviewed package/version/lock changes without selecting unpublished
  versions in `personal.json`. Run full frozen CI on that source candidate. Its owned suites,
  local workspace stack and packed contracts verify the candidate source/package graph. Its
  personal registry stack still describes the existing published selection, NOT the new release.
  `publish.yml` requires full execution evidence before verification and again before the
  privileged publish step, then packs once and checks/publishes those exact bytes through the
  existing descriptor and provenance gates. Do not reinterpret old registry-stack evidence as
  verification of the new package versions.
- Postpublication: after the registry integrity, signatures and provenance checks succeed, merge
  the reviewed exact published stack selection. This changes selected inputs, so freeze and fully
  verify that combined main candidate separately. `promote-stack.yml` requires its full execution
  evidence before snapshot construction; `promotion_verify` records the full dispatch run ID in
  `stack_run_ids`. Existing required-check, registry-byte, core and snapshot checks still apply.
  Owner environment approval remains mandatory before attestation/publication. Dotfiles adoption,
  deployment and activation consume that exact attested snapshot, never old PR or another package
  set's checks. This change performs no release, promotion, protection edit or activation.

Migration is fail-closed: older push/main-only evidence is insufficient for new publications and
promotions. This PR cannot have a hosted full-dispatch receipt before its workflow has merged and
been indexed. Its PR CI validates the change; the first actual release verification is a separate
post-merge dispatch. Existing published releases and snapshots remain historical artifacts and
are not retroactively relabelled as fully verified by this lane.
