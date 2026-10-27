# Hosted per-OS floor receipt

Starting HEAD: `2747a1d3ff12c6506989c0daf053831277a43260`, branch `coverage-phase0`.
Fetched origin first; `HEAD..origin/main` was zero, so no merge was needed. No rebase,
force push, PR merge or live activation. Local Phase 0 receipts remain advisory.

First independent hosted measurement: [run 40441614924](https://github.com/nredd/pi-harness/actions/runs/40441614924),
artifacts `coverage-ubuntu-24.04` and `coverage-macos-14`. Both owned test-producer steps
succeeded; accounting correctly failed on local single-platform floors. Every measured report
is present and validates against owned source. No failed test producer establishes a budget.
The pending inventories, including dev-tools, are unchanged despite extra artifact reports.

Downloaded with `gh run download`, then ran the new `--measure --os linux/darwin
--reports-root <artifact> --summary <output>` mode independently on each artifact. These are
source-scoped counters, not copied unvalidated runner summaries. Both measurements exited 0.
The same artifacts replayed as gates with `--base origin/main` exit 0 using the new floors.
Main has no policy yet; this PR establishes the first per-OS floors, not a main ratchet increase.

| Signal | Linux uncovered lines/functions | Darwin uncovered lines/functions |
| --- | ---: | ---: |
| plan-mode/primary | 555 / 138 | 555 / 138 |
| plan-mode/bun | 3479 / 245 | 3479 / 245 |
| preset/primary | 19 / 12 | 19 / 12 |
| preset/bun | 244 / 15 | 244 / 15 |
| resource-sampler/primary | 31 / 2 | 58 / 2 |
| resource-sampler/bun | 46 / 8 | 163 / 14 |
| session-kit/primary | 110 / 31 | 110 / 32 |
| session-kit/bun | 859 / 114 | 859 / 116 |
| subagents/primary | 500 / 68 | 500 / 68 |
| subagents/bun | 7728 / 512 | 7728 / 512 |
| subscription-router/primary | 20 / 4 | 20 / 4 |
| subscription-router/bun | 226 / 31 | 226 / 31 |
| todo/primary | 120 / 20 | 120 / 20 |
| todo/bun | 936 / 71 | 936 / 71 |
| import-audit/primary | 9 / 0 | 9 / 0 |
| probes/primary | 45 / 1 | 45 / 1 |
| inprocess/primary | 25 / 8 | 15 / 4 |
| inprocess/bun | 37 / 5 | 22 / 4 |

The Linux in-process delta is entirely the Darwin-only wake-helper path in `support.ts`:
21 / 5 uncovered versus 11 / 1, with identical `goal-support.ts` and `native-timers.ts` counts.
`stopWake`, `exitedWithin` and its callbacks never run without `caffeinate`. The sleep-assertion
test explicitly skips Linux; this is not tmux/Pi availability. See `docs/coverage.md`.
Windows/WSL coverage is not measured.

Regression evidence:
- `make check-scripts`: formatter, ruff and ty clean; 819 pytest tests passed in 83.04 seconds,
  then all 8 Node import-audit tests passed. Log: `/tmp/cov-platform-gate.log`.
- All 128 coverage tests pass, including 20 new per-platform cases with real LCOV fixtures.
- Real disposable Git CLI cases raise/lower each OS's line/function floor while selecting both
  runner OSes. A change to the nonrunning platform is still checked against the base.
- Missing selected-OS floors fail even with fully covered LCOV and the global target enabled.
- Missing base OS floors fail; base-enabled/current-disabled global enforcement fails.
- Artifact measurement prints a reviewable diff and JSON counts without changing policy bytes;
  mixing measurement and base gating is rejected, and missing artifacts fail.

Isolated revert proofs, `/tmp/cov-platform-proofs/summary.json`:

| Reverted contract | Expected failing tests |
| --- | ---: |
| Select the requested OS, rather than always Darwin | 6 |
| Reject a missing selected-OS floor | 4 |
| Ratchet uncovered lines independently per OS | 2 |
| Ratchet uncovered functions independently per OS | 2 |
| Retain every base OS declaration | 2 |
| Reject disabling an already-enabled global target | 1 |
| Total: 6 variants | 17 |

Unmodified proof control: 20 passed. Mutations run only in disposable copies, not the worktree.
No timeouts/retries, test skips, source exclusions or producer commands changed.

Second independent hosted measurement: pending the new commit's CI run. This receipt does not
claim determinism from one hosted run. Compare every package/signal/OS after that fresh run,
not a retry. Any changed counts require investigation and an explicitly linked issue before
retaining observed maxima; no floor has been widened speculatively.
