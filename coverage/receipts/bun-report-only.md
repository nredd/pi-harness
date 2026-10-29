# Bun report-only policy receipt

Starting HEAD: `2d6d80e7dad9c57acb3a88ebb788ee53eea2927a`. Fetched origin first; main advanced
from `6d979f6` (#153) to `e2ebe2a` (#154, fleet-list). Plain `git merge origin/main` completed
without conflicts. No rebase, force push or PR merge. #148, #152 and #155 remained open at this
fetch; no speculative floor adjustments anticipate their changes.

The owner explicitly chose report-only Bun compatibility signals until the source-complete port
specified in [#160](https://github.com/nredd/pi-harness/issues/160). All eight current signals
now declare their mode, a reason, and that issue. Primary signals remain enforced and define
the 100% goal. Bun reference numbers are unchanged, not raised to conceal the #153 delta.

## Primary comparison before editing policy

Reparsed the owned-scope reports from hosted run `40455349710` independently for both OSes.
All primary uncovered counts match stored floors; **no primary floor changed**:

| Primary signal | Linux artifact / stored floor | Darwin artifact / stored floor |
| --- | --- | --- |
| plan-mode | 555/138 / 555/138 | 555/138 / 555/138 |
| preset | 19/12 / 19/12 | 19/12 / 19/12 |
| resource-sampler | 31/2 / 31/2 | 58/2 / 58/2 |
| session-kit | 110/32 / 110/32 | 110/32 / 110/32 |
| subagents | 500/68 / 500/68 | 500/68 / 500/68 |
| subscription-router | 20/4 / 20/4 | 20/4 / 20/4 |
| todo | 120/20 / 120/20 | 120/20 / 120/20 |
| import-audit | 9/0 / 9/0 | 9/0 / 9/0 |
| probes | 45/1 / 45/1 | 45/1 / 45/1 |
| inprocess | 25/8 / 25/8 | 15/4 / 15/4 |

That hosted run predates #154's fleet-list changes. Its artifacts cannot prove the new fleet-list
coverage. The next hosted run must measure that source; any primary failure will be reported,
not preemptively waived. The same applies if another PR lands later.

Both original artifact replays now pass accounting, with subagents Bun still measured at 7763/515
versus references 7728/512 and explicit signed deltas +35/+3 on both OSes. The JSON `signals`
map retains mode, reason, reference and delta. These replays validate the report-only behavior,
not a claim that the old artifacts cover newly merged source.

## Evidence retained by report-only mode

Missing, empty or malformed LCOV still fails. An absent expected file fails even if another
expected file has positive executable lines. Unknown files, zero owned lines and missing OS
references fail. Base-tree inventory ratcheting and both text+LCOV reporter requirements remain.
The real pinned-Bun LCOV-only bypass reproduction is unchanged.

An enforced-to-report-only transition requires a fresh exact `enforcement_changes` entry,
separate from the signal's standing reason. Blank, duplicate, unrelated and historical entries
cannot authorize it. Primary signals cannot become report-only. Initial policy/signal addition
is allowed, and complete-source report-only-to-enforced promotion establishes its own floor.
Subsequent enforced-to-enforced counts ratchet per OS.

The owner's 1-7% shorthand is not a measured percentage of production source covered. Hosted
suite counts include plan-mode 8/539 (1.5%), subagents 22/3078 (0.7%), todo 2/387 (0.5%), and
exceptions preset 127/127 and inprocess 64/64 cases (one Linux skip). Documentation preserves
those actual figures rather than calling every Bun suite 1-7% source coverage. The gating
criterion is full-suite Bun execution on both owned OSes AND complete owned-source inventory,
including never-imported files, not a compatibility-suite count.

## Gates and revert proofs

`make check-scripts`: formatter, ruff and ty clean; **855 pytest tests passed**, then **8 Node
import-audit tests passed**. Log: `/tmp/cov-report-only-gate.log`. Coverage-specific tests now
include **36 new enforcement cases** with real LCOV fixtures and disposable Git-base CLI runs.
Both artifact gating replays exit 0. `git diff --check` is clean.

Isolated revert proofs, unmodified control **36 passed**:

| Reverted contract | Expected red tests |
| --- | ---: |
| Report-only excess is advisory | 12 |
| Report-only reports still parse and validate | 6 |
| Missing expected files fail, including positive partial reports | 2 |
| Downgrades require explicit fresh authorization, including the Git CLI | 2 |
| Primary remains enforced | 1 |
| Enforced Bun requires complete source inventory | 1 |
| Text+LCOV remains mandatory | 1 |
| Report-only retains base-tree membership ratchet | 1 |
| Report-only requires a nonblank reason | 2 |
| Historical downgrade entries cannot be recycled | 1 |
| Enforced budgets still fail on excess | 3 |
| Total: 11 variants | 32 |

Proof runner: `/tmp/cov-report-only-proofs.py`; logs/results:
`/tmp/cov-report-only-proofs/summary.json`. No live-worktree mutations, weakened assertions,
timeouts or retries. Hosted CI on the new commit is pending; local gates/replays are not a
hosted-green claim. No required check names or production test invocations changed.
