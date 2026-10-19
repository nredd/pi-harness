# Fork queue on tintinweb master ca93a52

Maintainer review notes. This branch is not a release and must not be merged into its review base.

## History and conflict resolutions

- Start from `origin/nredd/v0.22.0` (`465fb6d14096cfe988c0c12663a7d1ea1d9c32cf`), not the old local `nredd/v0.19.0` checkout.
- Run `git rebase --onto ca93a5247e72e7053fcd10bea7125d6c4205f949 v0.22.0` in a dedicated worktree. Replay all 37 non-merge patches individually. The two PR merges (`2fc9632`, `465fb6d`) have no tree changes relative to their second parents, so linearize them; no merge-only content is lost.
- Resolve `CHANGELOG.md` by retaining upstream and fork entries under one `[Unreleased]` section, deduplicating subsections and entries. Leave every released section byte-identical to the new upstream base.
- Resolve `docs/rpc.md` by keeping upstream's steer/ownership descriptions and symbol-based references, with the fork's directory-specific worktree errors and inherited config-root trust field.
- Resolve `src/agent-runner.ts` by moving the fork's final-report state into upstream's shared `observeRun`, rather than restoring the old spawn-only observer. Forward physical message identity and model-call activity through that observer.
- Resolve `test/nested-tools.test.ts` by retaining upstream's resume-limit test with a foreground-owned child. Drop the obsolete background-start-failure case: the fork refuses nested background work before startup. Keep the explicit explanatory refusal tests.

## Semantic decisions and coverage

- Spawn and resume both retain the forced final-report turn, tool pinning after deferred promotion, call-time `terminate` refusal, the one-turn hard bound, invocation-local output accounting and abort cleanup. `test/resume-rebase.test.ts` exercises successful reports, tool/second-turn violations, previous-output isolation, report rejection, abort while the previous batch drains, and fresh counters/latches. Existing `test/agent-runner.test.ts` retains the corresponding spawn regressions and pre-aborted resume coverage.
- A session switch that leaves detached work alive does not emit `subagents:disposed`, even when that detached manager later finishes. No source change was needed: the fork's early return already protects upstream's event. Four new `test/usage-reporting.test.ts` cases cover `new`, `resume`, `fork` and `reload`, continued physical-model usage and eventual child disposal. The existing last-usage-before-disposed test covers actual shutdown disposal. This event is activation-local, not a process-global usage barrier.
- Keep outcome precedence `stopped` > `aborted` > provider `error` > `steered` > `completed`. New foreground/background matrices in `test/agent-manager.test.ts` combine the flags and check fresh controllers, current output and completion timestamps. Existing tests retain spawn-budget fallback, inline/pre-aborted stopping and owned-child cleanup.
- Forward resumed text/model-call callbacks through manager and extension wiring on both foreground and background paths; these were missing after the textual merge. Two new `test/background-resume-wiring.test.ts` cases check callbacks, physical per-message spend, final turn/tool counts and steered outcomes. Two more preserve an explicit `max_turns: 0` through dispatch: normalizing it before the manager would wrongly restore the spawn's prior cap. Only the UI normalizes it to an absent ceiling. The shared-observer regression checks the final model-call end event and message identity.
- Keep RPC steering complementary to the fork's queued-tool fix. The manager emits the RPC/viewer/mention event; the tool emits its own event after accepting a steer. Queue flushing emits neither. A new `test/rpc-lifecycle-gating.test.ts` case holds the concurrency slot, sends one RPC steer and one tool steer to the queued child, releases the slot, and verifies exactly two deliveries and two events.
- Keep nested ownership and canonical config-root trust. `test/nested-tools.test.ts` covers foreign-child result/resume/steer refusal and nested resume `max_turns`; `test/agent-runner.test.ts` and `test/project-agent-trust.test.ts` cover inherited trust and fatal strict startup. No trust or nesting policy is replaced by upstream's resume support.
- Keep router admission refusal, parking and re-admission, `createSubagentsExtension({ clock })`, and directory package-name matching unchanged. Existing quota/scheduler, injected-clock/extension-clock, and runner extension-name suites remain in the full gate.

## Verification boundary

All commands use an empty `PI_CODING_AGENT_DIR` and `PI_E2E_LIVE=0`. No pi binary, tmux session or live provider is run. Logs are under `~/code/pi-harness-builds/rebase-subagents/`.

Mutation checks temporarily disabled resumed reports, model activity callbacks, outcome precedence, the detach event guard and single steering emission: all five test files failed in their targeted cases (`mutations.log`). A separate run broke report tool pinning, the hard bound and the post-drain abort guard (`report-mutations.log`). The explicit-unlimited dispatch cases also fail against the pre-fix normalization (`unlimited-mutation.log`). All mutations were restored before the final gate.

- `npm ci --ignore-scripts`: passed, 217 packages installed, zero vulnerabilities (`npm-ci-final.log`).
- `npm run check`: passed, Biome checked 211 files with no fixes; `tsc --noEmit` clean; 134 Vitest files passed, 2691 tests passed, 7 opt-in tests skipped (`check-final.log`). The existing Vite native-config advisory is non-blocking.
- `npm run build`: passed (`build.log`).
- `git diff --check` and released-changelog equality against `ca93a524`: passed.
- `git range-diff v0.22.0..v0.22.0-nredd.3 ca93a524..nredd/v0.22.0-ca93a52`: all 37 original patches matched, 22 identical and 15 adjusted (conflicts/context), none dropped, plus one integration/regression/documentation commit. The two content-free merges are omitted. Full output: `range-diff.log`.

This is a review branch only. No tag, release, existing branch/tag modification, harness Gitlink, installed package or pin is changed. The parent assembled-stack CI gate and independent reviewer reports are still required before any promotion.
