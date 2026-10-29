# Merge current main and close concrete review findings

Plain merge of `origin/main` `b51e177444bd9ec5d644ca00ee89f6306c1a3bce` into checkpoint
`9eb4463c1b347d60c9d28bc95548c1b7fa6d9e3f`. No rebase/force or PR merge/publish/apply.
The PR had merge conflicts, which prevented CI from attaching to the intervening checkpoints.

## Per-file merge decisions

Only `packages/subscription-router/package.json` conflicted: keep main's published `examples`
asset alongside `src`, and retain the branch's guarded full Bun Vitest/Istanbul coverage command,
primary coverage command and compatible provider dependencies. Do not restore native Bun subsets.

The following main changes applied cleanly and are retained without coverage-specific rewrites:

- `integration/inprocess/model-tiers.test.ts`: retain the real-host Explore/cheap binding regressions.
- `packages/subagents/CHANGELOG.md`: retain #182's Explore migration release note.
- `packages/subagents/README.md`: retain machine-local cheap-tier configuration guidance.
- `packages/subagents/src/default-agents.ts`: retain built-in Explore's `@cheap` binding.
- `packages/subagents/src/home-paths.ts`: retain checked drive-letter destructuring.
- `packages/subagents/src/index.ts`: retain `isError: true` on failed model selection.
- `packages/subagents/src/model-selection.ts`: retain explicit cheap-tier precedence and the
  legacy enterprise alias fallback, not an unconditional provider/model replacement.
- `packages/subagents/src/process-budget.ts`: retain main's bounds-checked indexing/type refinements.
- `packages/subagents/test/agent-types.test.ts`: retain updated Explore binding assertions.
- `packages/subagents/test/model-tiers.test.ts`: retain binding compatibility/precedence tests.
- `packages/subscription-router/CHANGELOG.md`: retain the shipped cheap-profile example note.
- `packages/subscription-router/README.md`: retain example/profile documentation.
- `packages/subscription-router/examples/subscription-router.json`: retain the ordered cheap
  chain (`anthropic/claude-haiku-5-5`, `openai-codex/gpt-6-luna`) and `exhaustionPolicy: "wait"`.
- `packages/subscription-router/test/config.test.ts`: retain exact example/profile validation.
- `scripts/package_contracts.py`: retain required/allowed packed example asset accounting.
- `scripts/tests/test_package_contracts.py`: retain missing-example package failure regression.

No new executable source module was added by this main merge. Existing explicit subagents and
router instrumentation inventories cover all changed modules. JSON profile assets are published
and validated as JSON, not disguised executable source. All coverage inventories, facade source
validation and shared Git-environment isolation remain intact.

## Independent review findings

The owner supplied three hard findings from independent review `eda65fe1-c84a-4c6` of
`71b0aea..9eb4463`. That agent is not owned by this nested parent, so its full result could not be
retrieved here; the supplied concrete findings are addressed:

- Add exact reasoned `reclassifications` for both plan-mode facade paths in `owned` and the
  affected `interactive-ui.ts` Bun subset. That is three scope entries for two physical files.
  Do not change the ratchet implementation or waive any inventory loss.
- Add a regression against the actual immutable base `71b0aea29173d56b181551b7579ff7557c500a24`:
  budget/inventory ratchets pass with all exact receipts; deleting the ledger or any one receipt
  fails with `Inventory ratchet requires`. Existing inventory tests remain unchanged.
- Apply `textwrap.dedent` to the embedded compiler/instrumenter JavaScript.
- Rename the hostile Git test's local `config` variable to `cfg`.

The reviewer confirmed that the real zero-executable facades and strict grammar are correct.
No other facade validation or Git-isolation implementation was changed while that review ran.

## Gates and remaining measurements

- Full `make check-scripts`: Ruff formatting/lint and ty clean, **883 pytest tests passed**,
  import-audit Biome/strict TypeScript plus **8 Node tests passed**. Includes schema, producer
  config, exact source inventory, facade and immutable-base ledger checks.
- Full router `check`: **207 primary +207 full Bun tests passed**, lint/type checks clean.
- Full subagents `check`: **3449 primary passed/8 skipped**, **31 native Bun scenarios passed**,
  **10 guarded real-loader canaries passed**, lint/type checks clean.
- Full inprocess `check`: **99 primary +99 full Bun tests passed**, lint/type checks clean.
- Actual CLI accounting with `--base 71b0aea...` now passes the real membership/budget ratchets
  and reaches report accounting. Only historical primary floors fail locally: sampler 72/6,
  session-kit 111/31 and subagents 506/72. These are advisory local observations, never new floors.
- Both old run `40706379839` artifacts remain partial because its scripts failure prevented helper
  producers. No counters were accepted; old/new diagnostics stay in the earlier receipts.
- Current push must make PR #162 conflict-free and attach fresh hosted jobs before any floor refresh.
  Require complete per-OS producers and independent-run comparison; disclose exact failures rather
  than polling or using partial/local reports.

Owner updates arriving after this merge/gate started: todo #192 merged at `166e801` with exact green
CI; session-kit #186 is running after a GitHub merge update. Per the owner, finish this checkpoint
push rather than restarting gates for moving main. This commit does NOT claim to contain `166e801`;
subsequent inventory integration must preserve its merged Istanbul producer and source changes.
Dev-tools #195 advanced to `e05b4a5` with clean split/delta reviews, still pending #155. Its unmerged
local zero-gap receipts remain advisory; no source copied and no hosted floors fabricated.
