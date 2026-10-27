# Phase 0 measurement receipt

Production source: `67730bb718635067bb42375ecf08af9f4f904bdd` (`origin/main` at worktree creation).
Only coverage configuration/manifests changed before these measurements; no production source or
existing assertions changed. Fresh worktree `~/code/cov-phase0`, initialized only its core Gitlink,
`make install` exit 0. macOS 27.2 arm64, Node 26.12.0, pinned Bun 1.3.14 (isolated npm install,
not the workstation's Bun 1.4.4). Vitest 5.0.3/V8 except todo 4.1.12/V8 and subagents
4.1.12/Istanbul. c8 12.0.0. Run serially, one workspace at a time; one Vitest worker.

Each primary measurement ran `npm test -- --maxWorkers=1`, except sampler already pins one
worker and ran `npm test`. Each declared Bun measurement ran `npm run test:bun` with the
coverage flags committed in its manifest. Node measurements ran the exact c8 commands in
`make check-import-audit check-probes` (test portions only). All measurements below exited 0.
`dev-tools` is deliberately PENDING, not baselined from the known failing cargo run (#155).
`computer-use` is not measured, tracked. Neither pending status means 100%.

Integer budgets below are **uncovered lines/functions**, not percentages. Bun has a distinct,
explicitly inventoried subset, never a complete-source denominator and never merged with primary.

| Package | Primary total lines/functions | Primary uncovered lines/functions | Bun total lines/functions | Bun uncovered lines/functions | Primary tests passed/skipped |
| --- | ---: | ---: | ---: | ---: | ---: |
| resource-sampler | 246 / 38 | 58 / 2 | 417 / 40 | 163 / 14 | 22 / 0 |
| subscription-router | 535 / 125 | 20 / 4 | 923 / 125 | 226 / 31 | 182 / 0 |
| preset | 310 / 73 | 21 / 12 | 505 / 51 | 244 / 15 | 126 / 0 |
| todo | 957 / 220 | 121 / 20 | 1273 / 94 | 936 / 71 | 387 / 0 |
| plan-mode | 2994 / 699 | 552 / 138 | 6127 / 541 | 3479 / 245 | 539 / 0 |
| session-kit | 3526 / 824 | 111 / 31 | 5587 / 814 | 859 / 116 | 711 / 0 |
| subagents | 6557 / 1291 | 533 / 73 | 13214 / 1066 | 7727 / 506 | 2769 / 7 |
| inprocess | 180 / 56 | 15 / 4 | 354 / 66 | 22 / 4 | 64 / 0 |
| import-audit | 161 / 7 | 9 / 0 | N/A | N/A | 8 / 0 |
| probes | 45 / 1 | 45 / 1 | N/A | N/A | 15 / 0 |

The never-imported probe helper is reported by c8 `--all` as an `(empty-report)` function and
45 uncovered source lines. This is a deliberately visible gap, not a test success or a reason
to remove the helper from scope. Type-named files containing executable constants remain in
scope, e.g. `subagents/src/types.ts` and `todo/tool/types.ts`.

Wall-clock sample, seconds, one clean control/coverage pair per primary suite. Controls used
`--coverage.enabled=false`; Bun controls ran the same declared command with coverage flags
removed. This extra control execution is measurement work ONLY, not CI wiring.

| Package | Primary control | Primary coverage | Bun control | Bun coverage |
| --- | ---: | ---: | ---: | ---: |
| resource-sampler | 5 | 4 | 3 | 3 |
| subscription-router | 7 | 7 | 0 | 1 |
| preset | 6 | 7 | 3 | 2 |
| todo | 10 | 10 | 0 | 1 |
| plan-mode | 22 | 25 | 1 | 1 |
| session-kit | 57 | 62 | 6 | 7 |
| subagents | 137 | 148 | 2 | 2 |
| inprocess | 23 | 25 | 8 | 8 |
| import-audit | 1 | 0 | N/A | N/A |
| probes | 8 | 9 | N/A | N/A |
| Total | 276 | 297 | 23 | 25 |

Measured aggregate delta: **23 seconds**, 299 -> 322 seconds (**7.7%**), excluding install,
lint/type checks and pending packages. Seconds are coarse wall-clock samples on a variable-load
host, not a CI promise; 0 means under one second, not zero work. Accounting alone took about
0.5 seconds. Initial duplicate `--maxWorkers=1` sampler invocations failed argument parsing;
those were discarded and the clean rerun above is the only sampler primary baseline.
No failed test run established any budget. A second clean 711-test session-kit suite during
`make check` measured 111 missing lines versus 110 initially. Comparing LCOV identifies only
`src/diff/git.ts:87`, the `if (closed)` arm of a real subprocess kill callback. The 110-line run
happened to execute it; the clean 111-line run did not. The initial Phase 0 budget is the observed
111, not the lucky 110. No production code, assertion, timeout or source exclusion was changed
to obtain either result. Deterministic coverage of that kill path belongs in the later test-gap
work, not this wiring PR. This is an explicit baseline-establishment decision, not a claim that
the suite is deterministic. The clean native plan-mode `npm run check` (539 primary tests)
also reported 552 missing lines versus 551 in the one-worker timing sample; the only differing
line is `src/presentation.ts:78`. The initial policy uses that clean native-check measurement,
retaining both LCOV hashes rather than silently claiming the lower sample is stable.
CI/Linux deltas have not yet been measured.

Local raw logs and snapshots: `/tmp/cov-phase0-results/`, including `timing.txt` and
`baseline-lcov/`. SHA-256 binds the following clean-run raw LCOV bytes (before source-only
accounting removes test helpers, sibling imports and justified generated duplicates):

| Signal | SHA-256 |
| --- | --- |
| plan-mode primary (552, clean native check) | `8ac005b270e4b4a26d58e3b2d6be2e3ca0b834e155e8a3278b9a9532c815cb33` |
| plan-mode primary (551, one-worker timing sample) | `00e03701b17176279750e0d9fe084143877c4c29901e5f4c9eedd61efe34eb81` |
| plan-mode bun | `39318aa64df1bf6f80fa7eef09c2f362dd7956851f813f976e90fc2edc339deb` |
| preset primary | `239269a048a92349629fb46d249d27055ec903b96e39416900e165ec12567893` |
| preset bun | `e4898fc97545feaf88751b9bf04dc774bed6bc7d814c113a19e47a22176315a8` |
| resource-sampler primary | `3acc3d1c9d6b8fb6c814e73aab4208ff7ba37c05f080335367a4e6092fa4134a` |
| resource-sampler bun | `1f54ad1ef01ffb4ce4ddf1e5e64ce56d9e0790d66f005d6ec5df8916dba762d1` |
| session-kit primary (111, clean second run) | `75a114dbada4abdc3a57fdbe7ada8c2afce4d608d815494090e2484864a139bf` |
| session-kit primary (110, first timing sample) | `cfac269a0ad761cd561a961cb4ebe9e2e41e8b72c97198705e89505d9df6cc27` |
| session-kit bun | `dfa4c11f17f88f89ae5d0d52f9402271c0f0d78c3e98d2c47d7040f46ffdd26e` |
| subagents primary | `56dc7a70abc90c3e4ec8392a0a98057836b5ec1b822a7c0e876a5fa0906953ef` |
| subagents bun | `8b15c590df22e86a3147bc00fe6564b63c68bf1784726ed139df27b006c178b5` |
| subscription-router primary | `67e3fa0dec4b13d1cb75156a78af98e5ad517c81067513cabb87ab7ba7147f89` |
| subscription-router bun | `3e4396ec1880cc5393712479a6ef7ea2382b31ed279b8a31e01ae19c0b9b0f20` |
| todo primary | `5cd18fbcfd31744ec74ca3f0b2e9106e1355782b69e8b7804444a27ae80fb32d` |
| todo bun | `0ca54059c9d44e52d3490205ecb44e890d8bef79bd4274c60cec58ac55f6cc3a` |
| import-audit primary | `86a87ef02eec002178224cb65793d2d06963c307838225b120459e30b8e21d25` |
| probes primary | `9c29e6b93687a8bef016022146d7eb271f4e9b25971f1bbb5176076466905edc` |
| inprocess primary | `e46995e17c98e8467c200c885e0b4eb5a3fb8df15661b191f8286a60c766ec2e` |
| inprocess bun | `2686c017ae9a18604cfcb802c4ec792d396faddc39743a9694c11d252d278329` |

Gate receipts:
- `make check` was RUN and exited 2, including the three known dev-tools cargo assertions from #155.
  Its failed coverage report was not baselined. The first repeat also found generated HTML reaching
  whole-workspace linters; package-local `coverage/` ignores fix that generated-output issue.
- The corrected native `plan-mode` and `inprocess` checks both passed, including their primary
  and declared Bun suites. Other package checks passed in the full gate except dev-tools.
- `make check-scripts`: formatter, ruff, ty, 721 tests and the 8-test c8 import audit passed.
  Three subsequently added wiring regressions passed with all accounting/producer tests (37 total).
- `make check-integration`: formatter, ruff, ty, 272 tests and the 15-test Node probe gate passed.
- `make check-benchmark`: 91 passed with isolated Codex 0.154.0; combined coverage 92.98% clears
  its unchanged 90% gate. No performance baseline was regenerated.
- `make check-coverage`: exit 0 with independent current reports, pending packages explicitly
  listed in the summary. `git diff --check` passed. Full `make check` is NOT claimed green.

NOT RUN by these measurements: dev-tools clean primary/Bun baseline, computer-use instrumentation,
Linux/WSL2 coverage, quiet-runner benches, benchmark rebaselining, live credentials, REA and
live desktop/TCC acceptance. The final global 100% flip is intentionally not enabled.
