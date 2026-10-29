# Final closure integration

Plain merge `33dda4ad` incorporates main without rewriting the policy branch. PR #203 is closed,
not marked merged: its continuation landed through #210 at `1d24b829` according to its closing
receipt. No separate open continuation remains.

Local primary producers passed on macOS, Node 26.12.0 and Bun 1.4.4. After adding worker-error
settlement/cancellation assertions and applying #195's reviewed Istanbul inventory:

| Package | Covered/total lines | Covered/total functions |
| --- | --- | --- |
| dev-tools | 1502/1502 | 260/260 |
| plan-mode | 2996/2996 | 699/699 |
| preset | 365/365 | 91/91 |
| resource-sampler | 371/371 | 55/55 |
| session-kit | 3541/3541 | 824/824 |
| subagents | 7173/7173 | 1422/1422 |
| subscription-router | 566/566 | 129/129 |
| todo | 964/964 | 221/221 |

The initial dev-tools V8 producer omitted `src/git/push-remote.ts`; the Istanbul producer now
lists all 22 executable modules. Its `src/core/index.ts` is a static named-export barrel. Real
TypeScript and emitted ESM Istanbul maps are tested for zero counters, not assigned fictional
LCOV coverage. The strict facade grammar now accepts TypeScript local specifiers, trailing
commas and inline type bindings, preserving rejection of executable additions.

The subagents worker error is delivered at the real worker's public EventEmitter boundary with
a held child. Both Error and string payloads must settle as failed and abort that exact child.
No production guard or assertion is removed. Replacing the worker diagnostic with a fixed wrong
message fails both new cases (`2 failed, 1 passed`); restore the source before full measurement.

Bun 1.4.4 now exits nonzero for the 50%-function fixture with either LCOV alone or text plus
LCOV. The pinned-runtime regression asserts that repair; both reporters remain mandatory.

The cross-platform Darwin collector regression injects two fixed metadata rows with absent PIDs,
requires exact name/parent/RSS retention for the admitted row, and requires a PID-limit reason with
one enumerated/sampled row. It runs on either host OS without attempting real Darwin commands.
Replacing parsed RSS with zero makes this test fail. Both source mutations were restored.

Local gates after restoration: `make check-ts check-scripts check-integration` passed, including
887 scripts tests, 1,444 integration units, 8 import-audit tests and 15 probe tests. All workspace
primary and declared compatibility suites passed. `make check-benchmark` reached 92.98% coverage
but failed one test because `codex` is absent from this host's PATH (90 passed); no fake executable
or skipped assertion substitutes for that dependency.

## First complete hosted measurement

Run [40852918834](https://github.com/nredd/pi-harness/actions/runs/40852918834), commit `b682723`,
produced complete `coverage-macos-14` and `coverage-ubuntu-24.04` artifacts after successful owned
producers. Only Linux accounting failed, on the outdated sampler budget. Both artifacts pass
measurement-mode validation; the policy records each independent signal's exact observed counts.
Primary counts match the table except session-kit has one uncovered function on both OSes and
Linux sampler has 52 uncovered lines / 8 functions. No failed producer establishes a floor.

Linux `collect.ts` misses are lines 155-157 (bounded stdout's row cap) and 240-241 (process-row
admission cap). The new two-row fixed-output test exercises both. Linux's other 47 missing lines
and all eight missing functions belong to Darwin-native FFI paths in `darwin.ts`; those remain
owned, measured and recorded as a per-OS floor. No platform file is excluded.

The hosted session-kit miss is `formatMessage`'s sort comparator in `src/monitor/messages.ts:38`.
A direct fixture now combines unsorted retained/dropped matches, checks exact first/last text,
ordered match IDs and unchanged input. It does not rely on manager flush timing.

The historical facade regression's `71b0aea` base anchors membership only. Its old advisory
pre-main budgets are not a second ratchet base: the CLI still enforces all budget/membership
ratchets against the actual PR base, which has no policy yet. The historical membership test
still rejects every missing classification receipt, including dev-tools' newly validated barrel.

## Final hosted floors

Run [40857829296](https://github.com/nredd/pi-harness/actions/runs/40857829296), commit `9193280`,
is green, with complete validated artifacts for both OSes. All primary packages match the full
local table, except Linux sampler covers 324/371 lines and 47/55 functions: the entire 47-line,
eight-function remainder is native Darwin FFI, not `collect.ts`. The new collector test closes
exactly five Linux lines in both primary and Bun signals. Session-kit is now 3541/3541 lines,
824/824 functions on both OSes. Its reversed-sort mutation fails exactly the new test (1 failed,
8 passed); the source is restored.

Independent two-commit comparison, per signal and OS:
- Every signal is stable except the explained test closures: Linux sampler primary/Bun lines
  decrease 52 -> 47; session-kit primary functions decrease 1 -> 0 on both OSes.
- No platform is averaged and no runtime counter is combined. Final policy uses the second
  clean run for those deterministic reductions, not the obsolete misses from the first run.
- Independent native Bun references remain advisory. Dev-tools and session-kit have stable
  per-OS function differences; sampler Bun on Darwin retains eight lines/four Node-FFI functions.
- Both complete second-run artifacts replay as gates against `origin/main`; `measurement_only`
  is false. The same reports validate in measurement mode before the manual floor edit.

Reproduction (repository root, matching production source/inventory):

```sh
gh run download 40857829296 -R nredd/pi-harness -n coverage-ubuntu-24.04 -D /tmp/cov162-second-linux
gh run download 40857829296 -R nredd/pi-harness -n coverage-macos-14 -D /tmp/cov162-second-darwin
uv run --locked --project integration python scripts/coverage_accounting.py --os linux --reports-root /tmp/cov162-second-linux --base origin/main --summary /tmp/replay-linux.json
uv run --locked --project integration python scripts/coverage_accounting.py --os darwin --reports-root /tmp/cov162-second-darwin --base origin/main --summary /tmp/replay-darwin.json
```

Global enforcement remains disabled: a blanket zero target rejects the approved Linux native
Darwin floor and the explicitly eligible measurement-pending tooling/examples. Do not remove
those inventories, falsify their goal or change global accounting semantics just to flip a flag. Independent Bun signals remain
report-only even when they have zero misses. Eligible runtime tooling/examples remain explicit
measurement-pending blockers; a global flip must not silently exempt them. Linux's Darwin-native
per-OS floor is not a claim that those paths execute on Linux.

## WSL2 matrix reconciliation

Main `f59b146a` (#206) moves WSL2 into `ci.yml`'s owned/contracts/stack matrix and restores
strict up-to-date protection with 12 required contexts. The plain merge preserves its shared
`setup-ci-tools` and guest adapter, with no rebase/force. The sole workflow conflict was the
old native setup versus the new composite setup; the composite wins, while explicit offline
reviewer binaries are retained (native Ubuntu apt, pinned macOS install-action, WSL setup apt).

WSL2 coverage is explicitly Linux-like and **enforced**, not advisory: ordinary producer and
accounting steps execute in Ubuntu's Linux filesystem, where `sys.platform` selects the existing
Linux floors. A separate `coverage-wsl2` artifact preserves every independent signal. Neither
native Windows coverage nor contract/stack scenario coverage is claimed. Never combine WSL and
native Linux counters or use WSL evidence to substitute for a missing native artifact.

Artifact actions run on the Windows host, so `wsl2_capture.sh` now mirrors only the declared
LCOV locations and `coverage/summary.json` to the host before upload. It deletes stale host
reports first. A real disposable guest/host filesystem regression checks exact contents and
layout, prevents unrelated-file export, and verifies a subsequent empty capture clears all
previous evidence. Producers/accounting still fail on missing reports; export does not invent
coverage or erase their status. Full `make check-scripts`: 917 passed, plus 8 import-audit tests.
Run [40865524633](https://github.com/nredd/pi-harness/actions/runs/40865524633), commit `dbcdb36d`,
passes all three owned cells and produces complete artifacts, including `coverage-wsl2`. The WSL
artifact replays with `--os linux --base origin/main`: `measurement_only=false`, 20 signals,
`errors=[]`. Every primary counter matches native Linux, so no floor changes are needed.

One advisory difference is explicit: WSL session-kit/Bun is 948 uncovered lines / 96 functions,
versus native Linux's 947/94 reference. The extra missing line is `src/mon/source.ts:99`, the
routine-skip-only process hint. Its conditional `filter`/`every` callbacks depend on real-host
process visibility in the native compatibility subset; WSL's process population need not have
kernel-thread/unreadable routine skips. The full primary remains zero on both. Keep the native
Linux advisory reference and show WSL's signed delta, rather than blending runner maxima or
calling the subset source-complete. Other signal counts agree with native Linux.

This run is NOT globally green: the sole failed required cell is `stack (wsl2, personal)` during
`wsl.exe --update`, before guest setup, with `Forbidden (403)` and exit 4294967295. All other
11 required cells passed. This infrastructure failure does not invalidate the successful owned
producers or authorize retrying tests to obtain lower coverage counters. The final exact-head
run must still pass all 12 required contexts; no merge is authorized.

Run `40868682068` at `07277f7` passes WSL personal stack but fails the WSL owned gate. Its
source bytes expose a different, reproducible boundary defect: committed plan-mode runtime
snapshots contain CRLF while the fresh build emits LF, and the Swift source-string invariant
fails on its exact newline. Dev-tools' format check also reports drift. Those partial coverage
reports do not establish any floor. The final cleanup action returns the original owned failure,
not an independently diagnosed export defect.

A real disposable Git regression recreates a clean CRLF text checkout with explicit EOL
configuration, then executes the setup action's actual Git command lines. Old setup fails the
exact Swift/TypeScript byte comparison while preserving the binary sentinel. Pinning `core.eol=lf`
alone, adding forced `checkout-index`, or forced path checkout still fails: cached clean index
entries prevent rematerialization. Emptying the **disposable CI checkout's index** before the
existing hard reset passes (one focused test), while exact binary bytes remain unchanged.
No production source, formatter rule, source-string assertion or runtime snapshot is relaxed.
Full `make check-scripts` after the fix: 918 passed plus 8 import-audit tests. Hosted confirmation
is still required; failed-run counters remain diagnostic only.

Run `40872336251` at `fe48182` confirms the checkout fix: WSL owned/contracts/both stack cells
pass, and its complete WSL artifact replays as a Linux-floor gate with 20 signals and no errors.
Compared independently with WSL run `40865524633` on `dbcdb36d`, every signal's line/function
counter is identical, including the explicitly advisory session-kit/Bun delta. No runner counters
are combined. Native macOS and every other required context pass except native Ubuntu accounting.

That native Ubuntu producer succeeds but misses `subagents/src/workflow/runtime.ts:976–977`:
the paused-after-semaphore-admission guard. The existing test waits for first-child startup and
sleeps, so another worker message can arrive only after pause and take the earlier gate instead.
A deterministic test now waits for the third worker call before pausing/releasing the first child,
proving the second already arrived at the host. One check-phase boundary drains same-thread
permit microtasks before asserting that only the first child started. Resume must complete all
three values without aborting a child. Disabling the post-admission pause guard fails this exact
assertion (`[0, 1]` versus `[0]`); the source is restored. Full subagents lint/types/primary/native
Bun/loader checks pass, and full `make check-scripts` remains 918 passed plus eight import-audit.
The zero floor is retained, not widened to accommodate incidental timing.
