# Round 2 verification receipt

Starting PR HEAD: `23f1d8452fab5d3019d168c69d488dba2e975546`.
Fetched `origin`; `origin/main` had not advanced beyond the existing base
`fd5d638269e4d11a71773a47389b345991ad4b96`, so no merge was necessary.
No rebase or force push. No production package source, package coverage floors or runner changed.

Changes under test:
- Capture combined output for every Git metadata read and retain fatal diagnostics in summaries.
- Describe every serialized policy field and document typed callable contracts, including tests.
- Expand base ownership against its immutable Git tree, current ownership against the working tree,
  and require new reasoned reclassification entries for lost owned or compatibility membership.
- Audit nonignored tracked and untracked TS/Python files against measured/pending inventories and
  explicit reasoned exclusions. Name the previously omitted Python, probe and provider surfaces.
- Test uncovered functions independently from uncovered lines, plus valid raw LCOV that filters
  to zero owned executable lines.

Gates:
- `PATH=/tmp/cov-bun-1314/node_modules/.bin:$PATH make check-scripts`: ruff format/check and ty
  clean, **764 pytest tests passed**, then the existing **8 Node import-audit tests passed** under c8.
- Coverage-specific tests: **73 passed**, including **36 new round-two cases**.
- `make check-coverage BASE=23f1d84`: exit 0 against the PR's previous policy/tree and existing
  reports, with all new pending packages explicitly retained in the summary.
- Stored receipt replay: export the previous HEAD into an isolated repository, overlay this
  change, populate report paths from the original `baseline-lcov/` snapshots, then invoke the
  accounting CLI with `--root <snapshot> --base HEAD`. Exit 0, no accounting errors. This exercises
  Git-base membership comparison and real saved LCOV without another package test pass.
- `git diff --check`: clean.

Revert proofs use isolated copies, never edits to the live worktree. The unmodified round-two
control passes all 36 cases. Each variant reverts one contract/guard or restores the original
uninventoried policy, then runs the relevant regression selection:

| Reverted contract | Expected failing tests |
| --- | ---: |
| Combined stderr capture and retained Git diagnostics | 2 |
| Serialized field description | 1 |
| Typed function documentation | 1 |
| Required declarations for inventory membership losses | 8 |
| Expansion against the immutable base tree, rather than the checkout | 3 |
| Nonblank reclassification reason | 1 |
| Repository-wide new-source audit | 1 |
| Original policy without the missing pending inventories | 9 |
| Function-budget enforcement alone | 1 |
| Line-budget enforcement alone | 1 |
| Separate zero-owned-lines guard | 1 |
| Pending-inventory validation | 1 |
| Total: **12 reversion variants** | **30 expected red tests** |

The membership cases cover shrinking owned globs, new exclusions, changed roots, renames,
actual deletion, shrinking compatibility subsets and moving source into fixture scope. Positive
cases cover explicit reasoned rename/removal/reclassification. Historical approvals cannot be
reused for a new loss; duplicate, unrelated, escaping or nonexistent-replacement entries fail.

Local proof artifacts: `/tmp/cov-round2-proofs/summary.json`, per-variant logs, `control.log`,
`stored-summary.json`, `stored-receipts.log`; runner: `/tmp/cov-round2-proofs.py`.
Final gate log: `/tmp/cov-round2-gate-final.log` (764 passed in 83.74 seconds, plus the eight
Node tests). Final working-tree accounting log: `/tmp/cov-round2-accounting-final.log`.

NOT RUN: package coverage reruns (not needed; package source/runners/floors unchanged), clean
`dev-tools` baseline pending #155, Python follow-up instrumentation, hosted coverage timing,
quiet performance benchmarks or live credentials/desktop checks. Existing Python validation
is not coverage accounting; the new pending inventories do not claim otherwise. The benchmark's
existing pytest-cov 90% gate remains unchanged. No PR merge or live activation was performed.
