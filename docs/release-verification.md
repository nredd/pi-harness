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
shortcuts, executes every owned and contracts cell plus the three stack cells that run a stack
(`ubuntu-24.04` personal and local, `macos-14` local), and calls the existing complete core fork
gate. The `not_run` stack cells (`macos-14` personal, both `wsl2`) are required-check names with
no work behind them; the verifier never asks for them, and a test binds its stack cells to the
`ci.yml` matrix. It reuses the native checks, packed contracts, Node D/E and standalone D/E producers.
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
The classification step requires both the exact SHA-encoded branch name and main ancestry;
`test_dispatch_classifies_only_frozen_main_candidates` runs that real step against a fixture repo.
Each dispatch's `release-core` call groups per SHA without cancellation, so a later dispatch never
cancels an earlier candidate's core gate.
The verifier accepts only `main` or that exact frozen ref, never arbitrary PR branches. Delete
the temporary ref after release evidence is retained. Rerunning the original dispatch also keeps
the original commit. No branch is moved forward merely to satisfy release freshness.

`harness.release_gate` requires a successful `workflow_dispatch` run of `ci.yml`, its exact
candidate `head_sha`, the current attempt's complete matrix and core jobs, the successful actual
execution steps (not just successful job labels), and all retained, nonempty coverage, packed
contract, Node stack and standalone stack artifacts bound to that run and SHA.

The required steps follow the CI plan (`scripts/ci_paths.py`, [ci.md](ci.md)): each `owned shard (<os>, <shard>)` job must have executed its planned `Owned gate <target>` steps, and the macOS `python` shard its `Benchmark unit gate` (the macOS `check-ts` work is split across the `subagents`, `computer-use` and `ts` shards, #660) (`OWNED_SHARDS`: native cells `check-ts`, `check-scripts`, `check-integration`; WSL `check-ts`, `check-probes`, `check-providers`, `check-import-audit`), each `owned (<os>)` fan-in its `Require every planned shard to succeed` and coverage accounting steps, and the stack cells are exactly those the plan can run, never the `STACK_NOT_RUN` names. A dispatch is planned with `ci_paths.py --full`, so every such cell runs. Tests pin `harness.release_gate` to `OWNED_SHARDS`, `OWNED_GATES`, `STACK_NOT_RUN` and the step names in `ci.yml`.

Artifacts are per run, with no attempt field, so each required artifact is bound to the job that
uploads it (`coverage-<os>` to `owned (<os>)`, `contract-reports-<os>` to `contracts (<os>)`,
`stack-*` and `standalone-*` to their `stack (<os>, <stack>)` cell). That job must be in the
current attempt's job list and successful, and exactly one upload of that name must have a
`created_at` inside the job's `started_at`..`completed_at`, both bounds inclusive, compared as
offset-aware instants. A naive timestamp refuses. Two uploads inside one window refuse, the newest
never wins. After "Re-run failed jobs", the new attempt lists the carried-over successful jobs with
their original timestamps, so their original uploads still qualify; a re-run job qualifies only
through its new upload, never the failed attempt's same-named artifact. Missing, skipped, failed,
expired or mismatched evidence refuses, and so does a malformed REST page. `python -m harness.release_gate` exits 0 with evidence and 1 when refused; a
harness defect raises instead of reading as a refusal. Ordinary push/main smoke and old PR checks are
not fallbacks. Artifacts use normal Actions retention; expired evidence needs a real rerun, not
a replacement receipt. The verifier paginates run, job and artifact collections. Ubuntu publication/promotion jobs use
trusted `/usr/bin/gh`, not PATH lookup. Read-only local diagnostics on another platform must set
`RELEASE_GATE_GH` to its trusted absolute executable, e.g. `/opt/homebrew/bin/gh` on this Mac;
relative, missing or nonexecutable paths refuse.

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
