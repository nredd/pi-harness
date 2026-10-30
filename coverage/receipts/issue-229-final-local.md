# Issue #229 final local integration

Native Darwin local receipt, 2026-10-30. This is local producer and accounting evidence
only. Required CI must still collect fresh final-HEAD macOS and Linux primary reports;
this receipt makes no native Linux claim. Bun signals remain report-only under
[#160](https://github.com/nredd/pi-harness/issues/160).

The lockfile was installed at the canonical physical worktree path
`/Volumes/Scratch/code/issue-229` with `npm ci --ignore-scripts`. `forks/pi` was
initialized at `4af3d547ef0f78ed077ce7a373cdeebfc9e5cd6e` (`v1.3.0-nredd.8`). SDK
commands started with isolated `HOME`, `USERPROFILE`, `PI_CODING_AGENT_DIR`, and
`PI_AGENT_DIR`; the operator home was not used.

Execution:

- `npm run check --workspace @nredd/pi-plan-mode`: passed 13 runtime-builder tests,
  634 primary tests and 8 Bun tests. Runtime tooling primary report: 2 files, 119/119
  lines and 17/17 functions.
- `npm run check --workspace @nredd/pi-subagents`: passed 3737 primary tests / 8
  skipped, 29 workflow-example tests and 31 Bun tests plus 10 Bun real-loader tests.
  Workflow examples primary report: 6 files, 72/72 lines and 14/14 functions.
- `cd scripts && uv run --locked --project ../integration ruff format --check
  coverage_accounting.py tests/test_coverage_platforms.py && uv run --locked --project
  ../integration ruff check --no-fix --ignore-noqa coverage_accounting.py
  tests/test_coverage_platforms.py && uv run --locked --project ../integration ty check
  coverage_accounting.py tests/test_coverage_platforms.py && uv run --locked --project
  ../integration pytest tests/test_coverage_platforms.py -p no:cacheprovider`: 22 passed.

Artifacts:

| Report | Files | Lines | Functions | SHA-256 |
| --- | --- | --- | --- | --- |
| `packages/plan-mode/coverage/runtime-build-tooling/lcov.info` | 2 | 119/119 | 17/17 | `7299f4f4e5b8fc89cc7ffa36bfc1a70f851d6c409922ca74f84b62c9c81ff35b` |
| `packages/subagents/coverage/workflow-examples/lcov.info` | 6 | 72/72 | 14/14 | `d455ebca969ebfa2d15cf07ec986ef7534c473a168a93c2b143e52f3127bc98f` |

Source-input SHA-256 values:

- `README.md`: `ace42f4118d5a6906a5bbce4520c48fdb2975238ce5d867b47bcec0f45d2062f`
- `docs/coverage.md`: `fe9cd1933c24878e935cfc9855499c995327eec50eda5806b8656b0682908aa8`
- `coverage/policy.json`: `5e7850e079805745f4282eaa5b3a8aef467a53b712357c8c9d05a6968dfedc0d`
- `packages/plan-mode/test/build-runtime.test.ts`: `efd78ceab26e083f57daf2cde9c1c4d13aaa25807dda8f25429f2aaa78c2010e`
- `packages/subagents/test/workflow-examples.test.ts`: `4633816a2967efc13390285f81f42a3583ffcad949d712131a5a84857b85f8b6`
- `scripts/coverage_accounting.py`: `2e410e2b54ea173b046df35d9bdf61cfaf4dd69fb6f8df8c3bf01a2f701c5738`
- `scripts/tests/test_coverage_platforms.py`: `724410682fd31f07d63815679d5905f9b81384b770a31748ba46d7321e8a7a61`
- `scripts/tests/test_coverage_producers.py`: `8ff85178c27753ea56e7773d33d309aee11f3e784b4cbeda4317a9135b5d2746`

Mutation evidence:

All four runs used a fresh temporary `HOME`, `USERPROFILE`, `PI_CODING_AGENT_DIR` and
`PI_AGENT_DIR`, and ran exactly:

```sh
npm exec --workspace @nredd/pi-subagents -- vitest run test/workflow-examples.test.ts --coverage.enabled=false
```

The restored producer first passed 29/29. Each mutation saved the target bytes with
`cp`, applied only the following exact diff, ran the command above, restored with `cp`,
and passed `cmp -s` against the saved bytes. The restored focused suite then passed 29/29
again, followed by the final 29/29 dedicated producer run recorded above. Coverage was
disabled for these mutation controls so primary coverage thresholds and unrelated
uncovered-file accounting could not produce the failure.

Metadata-only instrumentation omission, SHA-256
`96de88eb15f3b2d2222ad06cde71233743730a73fbcb8421ad00f3112d08f25f`:

```diff
-  return instrumenter.instrumentSync(body, path);
+  return instrumenter.instrumentSync(body.replace("      const meta", "/* istanbul ignore next */\n      const meta"), path);
```

It failed the intended assertion:

```text
AssertionError: .../compose.js metadata initializer must be instrumented: expected undefined to be defined
```

Unconditional collection omission, SHA-256
`0ecc9ccdbbbcf23447a1ad76e4e54b9f068338ea2d3307d759e08be7a1c5e948`:

```diff
-  if (workerData.collectCoverage) {
+  if (false) {
```

It failed the collector assertion:

```text
AssertionError: .../compose.js worker VM must return coverage: expected undefined to be defined
```

The policy enables `enforce_target` only for eligible primary signals. It promotes the
complete runtime-build-tooling and workflow-examples primary reports with 0/0 Darwin and
Linux floors, retains all Bun signals as report-only, and declares only
`resource-sampler` Linux `src/darwin.ts` with the existing 47-line/8-function allowance.
The accounting regression proves a lowered declared Linux floor (46 lines/7 functions)
does not silently permit the allowance. It also rejects uncovered portable source, missing
allowance files, allowance expansion, unsupported OS scope and a disabled global target.

Historical sampler scope evidence:

Parent-provided hosted artifacts from run `41023232315` at source
`ebab693335f8a825db01c4c45173a0270e79cdfb` establish only the already-approved foreign
source slice. The preserved manifest is
`/Users/redd/code/pi-harness-builds/resume-20261029/coverage241-ebab-native-sampler-proof.json`.
Its macOS primary report SHA-256 is
`3ce9c1b8cea410d2b1a5278278846291e6695eafa4d2c6cffed95cca121ae4ea`, with all four
sampler source files at 0/0. Its Ubuntu and WSL Linux-like reports are respectively
`d59a90f8bd42890f5828b2cc365c4869083febe5e0bf732604e2d194122ea280` and
`a85aeafa0b0f4880a86a9773393cc660eb1b3ed483f5f1d6627e5782e4ddac5e`; both report
exactly `src/darwin.ts` at 47 lines/8 functions and `collect.ts`, `counters.ts`, and
`index.ts` at 0/0. These intermediate-HEAD reports do not accept this final candidate:
required CI must collect final-HEAD native reports after the combined policy commit.
