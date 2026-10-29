# Git isolation and dependency update

Follow-up to `632e3b48aa4704a05ba50da30ba0da44f1c56993`.

## Coverage Git fixtures

The #195 Standards warning also applied to coverage's fixtures: `commit_base()` called the
shared Git runner with inherited environment, and one CLI regression had a separate direct
init/add/commit loop. `git -C` alone does not override `GIT_DIR`, `GIT_WORK_TREE`, alternate index
or object paths, nor injected `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_*` / `GIT_CONFIG_VALUE_*`.
Those variables could redirect fixture writes or execute injected hooks outside the fixture root.

The shared explicit-root Git boundary now removes every inherited `GIT_*` variable, then sets
only `GIT_CONFIG_NOSYSTEM=1` and global/system config paths to the platform's null device.
Normal repository-local configuration and Git worktree topology still apply. Source accounting
therefore cannot have its explicit `--root` silently replaced by ambient Git routing. Fixture
writes use the same boundary, initialize with `--template=`, and disable hooks per command.
No user's real Git repository or configuration is modified.

Two real regressions verify the environment contract and initialize/add/commit with private
hostile routing/config/template variables pointed at a disposable decoy repository. The owned
repository receives the commit; the decoy's HEAD/index remain byte-identical, no alternate index
is written, no injected hook runs and no template hook is copied. Explicit injected config keys,
legacy `GIT_CONFIG_PARAMETERS`, global/system config paths, Git object/common-dir overrides and
`GIT_TEMPLATE_DIR` are all covered. No implementation was copied from unmerged #195.

`make check-scripts`: formatter/linter/ty clean, **881 pytest tests passed**, import-audit
Biome/strict TypeScript and **8 Node tests passed**. Includes all facade/inventory/schema/producer
and Git-isolation tests. Existing plan-mode gate receipts at `632e3b48` are unchanged.

## Dev-tools dependency decision

#195 is OPEN, stacked on #155 (`redd/cargo-diag`), at
`5d827a32c5ee6e91881702e7919ebeb58df83d58` when inspected. Read its actual
`docs/dev-tools-coverage.md` through GitHub, not another worktree. The proposed primary decision is
Istanbul over explicit `src/**/*.ts`, **22 executable modules**, with `src/core/index.ts` a separate
re-export-only barrel. Its local result is 1502/1502 lines and 260/260 functions, 408 Node/Bun
Vitest tests plus four native Bun scenarios. These are the author's LOCAL receipts, not hosted
floors and not a result reproduced by Phase 0.

Policy remains measurement-pending until #155 then #195 merge and complete per-OS producer
receipts exist. When wiring it, retain the actual Istanbul/inventory decision and validate the
core facade's real source shape (it includes TypeScript type specifiers and `.ts` targets, unlike
the current deliberately narrow plan-mode facade grammar). Do not copy unmerged production
changes or use failed-main reports as its baseline. #195's author owns the fixture-isolation
finding in that PR; this change addresses coverage's own shared root cause only.

Owner also reports #182 merged to main `b51e177444bd9ec5d644ca00ee89f6306c1a3bce`.
No main merge, unmerged source copying, publication or live apply was performed in this follow-up.
Hosted measurements remain tied to their recorded `71b0aea2` source, not relabeled as new main.

## Both hosted artifacts consumed

Run `40706379839` macOS owned job completed after the facade follow-up. All TypeScript workspace
producers passed there too. Its scripts gate has the SAME diagnosed failure as Linux: the Bun
reason wording assertion, 860 passed/1 failed, before import-audit/probe producers. The wording
was fixed in `632e3b48`; the assertion was preserved.

Downloaded `coverage-macos-14`, artifact `12825517196`, source `71b0aea2`, GitHub digest
`sha256:d98249cebcc5c7852e446ff47e7f7f7444f582cc350263fbf846b66b7c3ec0f5`.
Ran `coverage_accounting.py --measure --os darwin --reports-root /tmp/cov-phase0-hosted-darwin`.
It exits 1 on the same missing import-audit/probes reports. Both OS artifacts are therefore
partial and diagnostic only; no policy floors/references were changed. Linux details and diagnostic
counts are in `facade-followup.md`. Fresh complete successful producer artifacts remain required
on both OSes, plus independent-run comparison. No repeated polling or retry-until-green used.

Darwin diagnostic uncovered lines/functions, NOT accepted floors (causes are the same provider/main
changes itemized in `facade-followup.md`):

| Signal | Old Darwin floor/reference | Hosted diagnostic |
| --- | ---: | ---: |
| plan-mode/primary | 555/138 | 191/45 |
| plan-mode/bun | 3479/245 | 3479/245 |
| preset/primary | 19/12 | 8/10 |
| preset/bun | 244/15 | 8/10 |
| resource-sampler/primary | 58/2 | 72/6 |
| resource-sampler/bun | 163/14 | 72/6 |
| session-kit/primary | 110/32 | 110/32 |
| session-kit/bun | 859/116 | 860/116 |
| subagents/primary | 500/68 | 512/75 |
| subagents/bun | 7728/512 | 7743/522 |
| subscription-router/primary | 20/4 | 0/0 |
| subscription-router/bun | 226/31 | 0/0 |
| todo/primary | 120/20 | 15/5 |
| todo/bun | 936/71 | 15/5 |
| inprocess/primary | 15/4 | 15/4 |
| inprocess/bun | 22/4 | 17/4 |

Local accounting after Git isolation still fails only the three historical primary floors:
sampler 72/6, session-kit 111/31 and subagents 507/72. No invalid base, missing-facade or malformed
report error was introduced; no local measurement is accepted as a hosted floor.
