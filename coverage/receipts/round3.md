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

NOT RUN: package coverage reruns, new pending-surface instrumentation, clean dev-tools baseline,
hosted coverage timing, quiet performance benchmarks or live desktop/credential checks.
No PR merge or live activation was performed. Independent review of the new HEAD remains needed.
