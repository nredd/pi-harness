# Round 3 verification receipt

Starting PR HEAD: `9a7b78429b7ba95be5199105f1dd23285c1e9b9b`.
The initial fetch found `origin/main` at `fd5d638269e4d11a71773a47389b345991ad4b96`, matching
three commits ahead / zero behind. The JavaScript classification measurements below precede the
final fetch, which discovered #147 and #161 at `646519a5dc6a16871adc2bb1c56f3a4122462575`.
The classification change is committed before merging that main revision with plain Git; post-merge
verification is recorded in the follow-up section. No rebase or force push is used.

Classification at this base, using the same nonignored tracked/untracked Git traversal:

| JavaScript classification | Files |
| --- | ---: |
| Owned, measurement-pending production/build/example source | 11 |
| Exact per-file `verification_helpers` entries with individual reasons | 27 |
| Conventional test/fixture source | 14 |
| Explicit generated stats-export bundle exclusion | 1 |
| Total Git-listed `.mjs` / `.js` / `.cjs` files | 53 |

Production source includes computer-use's shipped `scripts/setup-helper.mjs`,
`scripts/build-native.mjs` and `src/platform/macos/helper-path.mjs`. Computer-use has no standard
coverage runner, so these stay owned/pending, never verification helpers. The macOS helper-path
module was an additional omission found by the broader scan. Plan-mode's two runtime build scripts
and six executable subagents workflow example/library files are also explicitly pending source.
The generated session-kit CLI bundle is excluded with a reason; its original TS implementation
remains owned and measured. No coverage floors or existing test invocations changed.

Verification entries name each of the 21 non-shipped computer-use `check-*.mjs` scripts,
`pi-cubench-agent.mjs`, `scripts/router_contract.mjs`, three integration auth/timer preloads and
the offline Anthropic classification probe. Each entry has its own reason. The real computer-use
npm `files` manifest is tested to prevent shipped JavaScript from being mislabeled verification.
Wildcard helper entries, absent paths, duplicates and production overlap fail validation.
Executable configuration filenames have no implicit exemption.

Gates:
- `PATH=/tmp/cov-bun-1314/node_modules/.bin:$PATH make check-scripts`: ruff format/check and ty
  clean; **799 pytest tests passed in 87.22 seconds**, then **8 Node import-audit tests passed**.
- Coverage-specific tests: **108 passed**, including **35 new round-three cases**. Cases add
  unknown `.mjs`, `.cjs` and `.js` files under scripts, integration and package roots; configuration
  filenames also fail until explicitly classified. Reasoned classifications pass, while an old
  production path still needs a separate tree-ratchet reclassification to become verification.
- `make check-coverage BASE=9a7b784`: exit 0, 18 independent measured signals, explicit pending
  inventories and no accounting errors.
- Stored LCOV replay: an isolated export of the previous HEAD, overlaid with these changes,
  uses the original saved LCOV receipt files. The accounting CLI runs with `--root <snapshot>
  --base HEAD`; exit 0, no accounting errors. No package coverage suite was rerun.
- `git diff --check`: clean.

The first lint invocation caught a 111-character docstring line. It was shortened before the
passing final gate; no lint rule, threshold or test assertion was waived.

Revert proofs run in isolated copies. The unmodified control passes all 35 new cases. Each
variant reverses one check/classification and runs the relevant regressions:

| Reversion | Expected failing tests |
| --- | ---: |
| Restore the TS/Python-only scanner | 13 |
| Introduce an implicit configuration-file exemption | 4 |
| Ignore explicit reasoned helper classifications | 4 |
| Remove nonblank per-file reason validation | 1 |
| Permit blanket helper-path declarations | 2 |
| Permit duplicate helper entries | 1 |
| Permit nonexistent helper paths | 1 |
| Permit helper/production overlap | 1 |
| Drop helper classification when scoping LCOV | 1 |
| Restore the previous uninventoried JavaScript policy | 9 |
| Misclassify shipped setup-helper as verification | 1 |
| Total: **11 reversion variants** | **38 expected red tests** |

Artifacts: `/tmp/cov-round3-proofs/summary.json`, per-variant logs, `control.log`,
`stored-summary.json` and `stored-receipts.log`; runner: `/tmp/cov-round3-proofs.py` (uses the
round-two snapshot helpers). Final gate log: `/tmp/cov-round3-gate-final.log`.

`docs/coverage.md` now includes a new-source checklist, explicitly covering #161's anticipated
`packages/subagents/src/model-selection.ts`: its ownership glob is automatic, but primary
instrumentation includes and any actually measured compatibility subset must be updated. The
file was not added speculatively. It was absent at the initial fetch, then arrived on main at
the final fetch and therefore requires merged-source producer checks and refreshed subagents LCOV.

## Main merge follow-up

The final fetch advanced main to `646519a5dc6a16871adc2bb1c56f3a4122462575`:
- #147 removed thinking pins from preset agent Markdown and updated its resource test/docs.
- #161 consolidated model selection and added `packages/subagents/src/model-selection.ts` plus
  two test modules. No new JavaScript files arrived; the 53-file classification table is unchanged.

Ran plain `git merge origin/main`. Git completed the merge without conflicts as
`59bece1d16123b6bc9e9c0bf61442fd45ea92547`; no `git merge --continue` was needed, and no
commit tool was invoked mid-merge. The inventory scan returned no unclassified files: the
existing TS ownership glob picked up `model-selection.ts` automatically. The producer-include
regression then FAILED with exactly that missing file, before the include update, and PASSED
afterwards. This is one additional real red-before-change / green-after-change proof.

Because main changed subagents production source, only that package's coverage was refreshed,
serially with one primary worker:
- Subagents lint/typecheck: pass.
- Primary Istanbul: **3058 passed, 7 skipped**, 147 test files, 160.30 seconds.
- Declared Bun compatibility suite: **22 passed, 0 failed**, 2.29 seconds. Its real LCOV includes
  `src/model-selection.ts`, so the independent expected-file list now names it.
- Post-merge `make check-scripts`: **799 passed** in 85.98 seconds, **8 Node tests passed**,
  ruff format/check and ty clean.
- Post-merge inventory audit: no unclassified files. `make check-coverage BASE=9a7b784`: exit 0.

Only the measured subagents ceilings tightened; no budget increased:

| Signal | Previous uncovered lines/functions | Merged-source uncovered lines/functions | Total lines/functions |
| --- | ---: | ---: | ---: |
| Primary | 525 / 72 | 494 / 65 | 6625 / 1308 |
| Bun | 7821 / 515 | 7728 / 512 | 13324 / 1084 |

Merged-source LCOV SHA-256:
- Primary: `9f4d2d2c86708d66412bd4000c72d9821b1a813d46a51ab2b819fbd18e347344`
- Bun: `881cea476702fde187f9f9c712ba3f3f788ad22f4313267ed676de5dd22caf61`

Saved as `subagents-round3-main-{primary,bun}.info` under the original local `baseline-lcov/`
receipt directory. The merged receipt replay uses these fresh subagents files and reuses all
unchanged-package receipts. Merged-run logs: `/tmp/cov-round3-subagents-{static,primary,bun}.log`,
`/tmp/cov-round3-merged-scripts.log`, `/tmp/cov-round3-accounting-merged.log`.
The merged-source isolated proof rerun again passed all 35 control cases and produced the same
38 expected failures across 11 reversions. Its accounting CLI replay passed with the fresh merged
subagents receipts and all unchanged-package receipts. Artifacts are retained under
`/tmp/cov-round3-proofs-merged/`. The final 108 coverage-specific tests and working-tree accounting
also passed after tightening the policy; the latter log is `/tmp/cov-round3-accounting-merged-final.log`.

NOT RUN: other package coverage reruns, new pending-surface instrumentation, clean dev-tools
baseline, hosted coverage timing, quiet performance benchmarks or live desktop/credential checks.
No PR merge or live activation was performed. Independent review of the new HEAD remains needed.
