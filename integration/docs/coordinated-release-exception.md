# Coordinated Plan/todo/subagents release: accepted n4 exception

Date: 2026-10-16. The full `make verify` was NOT green for this release. One benchmark failed and the owner accepted deploying anyway.

Candidates:
- `pi-subagents` `fix/subagents-v022-review` `8ed6404` (-> `v0.22.0-nredd.1`)
- `pi-plan-mode` `fix/plan-todo-lifecycle` `d91bb2b` (-> `v0.59.2-nredd.4`)
- `rpiv-todo` `fix/plan-todo-lifecycle` `3403b65` (-> `v2.12.0-nredd.6`)
- harness `release/coordinated-forks`, on `31f1fcb` plus this commit
- core stays `v1.3.0-nredd.1`

Staged full `make verify` (`/tmp/pi-coordinated-full-verify.log`, exit 2):
- 86 Python + 7 Node unit tests passed
- 148 static/integration passed, 1 expected skip (no enterprise manifest)
- 122 TUI/bench passed, 1 failed
- Sole failure: `scenarios/bench/test_multisession.py::test_multi_session_responsiveness`, `ms_input_p95_n4` measured 11.817ms against a 9.903ms limit (baseline 8.253ms + 20%). That is 19.3% over the limit and 43.2% over the baseline
- Other gates on the candidates: router e2e 13/13, subagents e2e 88 passed/7 skipped plus build, `npm run check` 2578 tests plus dir-entry tests, Plan 529 and todo 351 own gates, both review axes clear

The owner approved deployment with this single benchmark exception and requested a written record.
The approval used an approximate 10% overage; the measured overage is larger, so the numbers above
remain authoritative. Private conversation quotations were paraphrased for public import.

Scope:
- Applies ONLY to `ms_input_p95_n4`. Any other failure blocks
- No threshold, baseline or assertion was changed. `baselines/` is untouched
- The owner subsequently requested stopping the duplicate live verification. That run was cancelled, not passed; deployment acceptance uses the staged results above.

Deployment:
- All three tags above are published and installed; installed SHAs match the peeled remote tags
- Settings and inventory updates are on dotfiles `main` at `1593b14`; scoped apply completed and the recursive `~/.pi` diff against that source is empty
- Startup smoke passed without package warnings
- Live full-gate log: `/tmp/pi-coordinated-live-verify.log`; cancellation receipt: `/tmp/pi-coordinated-live-verify.cancelled`
- Restart existing Pi sessions to load the new extension code

Unresolved:
- Not diagnosed whether the regression comes from the candidates or from machine load/noise. The same run passed `ms_loop_lag_p99_n4` and the N=8 ratios
- TODO: rerun the n4 cell on an idle machine against the previous pins (`v0.19.0-nredd.15`, `nredd.3`, `nredd.5`) to bisect, then fix or re-baseline with evidence
