# Pi harness benchmark

Disposable, operator-driven benchmark comparing native coding-agent harnesses within provider pairs.
It prepares 36 interactive runs but never launches a model session itself.

Comparisons are deliberately limited to:

- Pi 0.85.1 + `anthropic/claude-sonnet-5` vs Claude Code 2.1.268 + `sonnet`
  (native display: Sonnet 5), both at medium reasoning
- Pi 0.85.1 + `openai-codex/gpt-5.6-terra` vs Codex 0.154.0 +
  `gpt-5.6-terra`, both at medium reasoning

There is no cross-provider aggregate because token accounting, caching, models, and native harness
behavior are not comparable across providers.

## Safety and isolation

- Fixture clones contain only pristine committed fixture content. Prompts, fixed clarification
  answers, terminal transcripts, native session copies, diffs, gate logs, manifests, and results
  live in `artifacts/runs/<run-id>/` outside each `worktree/`.
- Pi and Claude run through `/usr/bin/sandbox-exec` with a generated, harness-owned SBPL profile.
  The profile denies the benchmark root, then allows only the run worktree and, for Pi, that run's
  exact `native-sessions/pi/` directory. Codex cannot initialize its own tool sandbox inside a
  second Seatbelt sandbox, so its TUI uses a generated native `benchmark_isolated` permission
  profile instead. That profile inherits normal workspace permissions, permits the shared uv cache
  used by every harness, and denies the benchmark workspace, harness source/tests, top-level
  controls, the current run's control files, and every prepared sibling run. Native Claude and
  Codex session locations remain unchanged outside the
  benchmark root. Global CLI configuration, authentication, and native session writes remain
  available. Prompts, clarifications, manifests, hidden suites, harness source, and controls are
  inaccessible to agent tools.
- The framework inherits user CLI settings and authentication unchanged. It never reads auth files,
  credential stores, or environment secret values. The fixed answer is never a launch argument or
  environment value.
- Session discovery is limited to known session roots, the timed interval, `.json`/`.jsonl` files,
  and records containing the worktree/run identity. Timestamp-bounded Claude child logs beneath an
  associated session directory are retained with their parent. Paths shaped like auth, credentials,
  keychain, settings, secrets, and Codex configuration are rejected.
- Copied terminal and native logs redact generic token/password/secret assignments, common JSON
  and string forms, and bearer/basic authorization while preserving usage token-count fields. Raw
  terminal and Pi run-scoped logs are deleted after redacted copies are produced. Global Claude and
  Codex logs are never modified; only redacted copies are retained and referenced by results.
- `mark start` rejects a changed HEAD, any dirty path, benchmark artifact contamination, or an
  unfinished earlier matrix row. The CLI exposes `--allow-out-of-order` only for isolated
  development tests. Finalization rechecks generated-seed identity, seed ancestry, and
  contamination before it snapshots the agent's exact git state against `manifest.seed_commit`.
  Committed, staged, unstaged, and untracked agent changes are all included.
- Finalization never repairs the worktree. It applies the retained seed-based patch unchanged to
  separate visible and hidden clones with separate uv environments, homes, temp directories, and
  caches. Gate subprocesses run in harness-owned Seatbelt profiles that deny the rest of the
  benchmark root. Visible gates retain `uv sync`, Ruff format check, non-mutating Ruff lint, ty, and
  visible pytest outcomes. Hidden acceptance runs a private copy of the harness-owned suite with a
  harness-owned pytest configuration, disables external plugin autoload, and cannot inherit
  agent-controlled pytest configuration or plugins. Visible test side effects cannot reach hidden
  acceptance.
- `workspace/` and `artifacts/` are disposable, git-ignored, and local-only; never push them.
  This repository publishes audited source and sanitized historical results only. See the
  [import provenance](../../docs/source-provenance.md) for redactions and preserved evidence.

## Install

Requires Python 3.12+, `uv`, Git, Pi, Claude Code, and Codex on macOS. Pi, Claude, and independent
gates require `/usr/bin/sandbox-exec`; Codex uses its native filesystem permission profile. Terminal
capture uses native `/usr/bin/script` semantics.

```sh
cd benchmarks/comparison  # from the monorepo root
uv sync --all-extras
uv run pi-harness-benchmark generate
uv run pi-harness-benchmark matrix
```

`generate` creates three deterministic git seeds under `workspace/seeds/` and acceptance suites
under `workspace/hidden/`. Every seed has a locked `uv` environment, Ruff, ty, pytest, a documented
public API, visible tests, and one deterministic initial commit. Use `generate --force` to replace
generated data.

The fixtures are:

- `localized-bug`: one intended visible normalization failure; hidden cases reject space-only or
  punctuation-only fixes and check Unicode transliteration.
- `cross-file-feature`: one intended visible missing-API failure; hidden cases require strict parsing,
  environment precedence, and actual CLI integration. Its fixture and every generated `RunSpec`
  explicitly require a changed `README.md` or `docs/` path. A code-correct patch without that
  documentation update fails final acceptance. The other two fixtures do not require a docs patch.
- `ambiguity-heavy-change`: one intended visible limit-behavior failure. Every file in the clone
  leaves exactly one product choice unresolved and requires the harness to ask rather than guess:
  whether `limit` applies to raw input rows before the pipeline or emitted active records after it.
  The fixed answer lives only in external fixture/run metadata and `clarification.txt`. Hidden cases
  enforce the supplied after-filtering-and-ordering answer and catch the rejected input-row choice,
  list mutation, repeated consumption of one-shot iterables, both booleans, strings, floats,
  negatives, eager zero-limit consumption, and nondeterministic filtering/ordering semantics.

The generated seeds are intentionally red. Their static gates are clean, and their visible pytest
suite has only the stated failing test. Hidden suites stay outside all run clones.

## Operator workflow

List run IDs, then prepare the next matrix row in numeric order:

```sh
uv run pi-harness-benchmark prepare \
  01-anthropic-localized-bug-r1-pi-anthropic
```

`prepare` parses and verifies the exact pinned native CLI semantic version, clones the pristine
seed, writes the applicable Seatbelt or Codex-native permission profile, and emits
`INSTRUCTIONS.txt` with the exact isolated native launch.
For Pi it also verifies `@narumitw/pi-plan-mode` `0.58.0` and snapshots the non-secret relevant
`pi-plan-mode.json` values: `implementationPlanRetention=clear-after-first-run` and
`thinkingLevel=inherit`. `mark start` verifies those Pi values again. Configuration snapshots and
hashes are retained in the manifest. The command refuses drift and never starts Pi, Claude, or
Codex. Execute rows in matrix order; `mark start` enforces that every predecessor is finalized.

Every native run is interactive:

1. Complete setup outside timing. For Claude and Codex, launch once in the fresh clone with the
   emitted setup command, accept the per-path workspace trust prompt, then `/exit` without submitting
   a prompt. Confirm `git status --short` is empty. Pi does not need this trust setup.
2. Run the emitted `mark <run-dir> start` command immediately before the captured native launch.
3. Enter native Plan mode before submitting the exact external `prompt.txt`: `/plan start` in Pi,
   startup `--permission-mode plan` in Claude, or Shift+Tab to Plan mode in Codex.
4. For an ambiguity run, do not volunteer the answer. The harness must ask the unresolved product
   question rather than guess. When it asks, paste the exact answer emitted in `INSTRUCTIONS.txt`
   and stored in external `clarification.txt`. If it guesses without asking, do not coach it.
5. Copy the accepted plan text to the emitted external `accepted-plan.md` path. `mark
   <run-dir> implementation` rejects a missing or empty plan artifact. Nothing is written in the
   clone.
6. Review the saved plan. At acceptance, run `mark <run-dir> implementation` in another terminal,
   then accept it in the TUI. This timestamp splits plan and implementation metrics where native
   event timestamps permit it.
7. Use the exact same-session implementation transition emitted for the harness. Pi: choose
   `Implement here`; the verified retention policy clears plan state after the first implementation
   run, and the current Normal auto mode governs permissions. Claude: choose
   `Yes, and use auto mode`. Codex: press Shift+Tab after the plan and choose
   `Yes, implement this plan`; the native handoff switches to Default mode and injects
   `Implement the plan.`
8. If a harness asks whether to commit or push, give the fixed safety answer `Leave changes
   uncommitted and do not push.` For Claude's native choice UI, select `Neither, I'll review first`.
   This is the only safety response beyond the fixture's fixed product clarification.
9. Do not edit, repair, or run post-hoc prompts. Exit after the agent stops, run the emitted
   `mark <run-dir> stop`, then `finalize <run-dir>`.

The captured launch is `script -q <run-dir>/terminal.raw.log /usr/bin/sandbox-exec -f ...`; no log
is placed in the clone, and the raw transcript is removed after redaction. Claude's trust acceptance
is explicitly excluded from model timing. Reported wall duration is agent start-to-stop.

## Token accounting

Finalization copies and redacts native session data, then applies native semantics:

- Pi: sum each finalized assistant message once using `input`, `output`, `cacheRead`, `cacheWrite`,
  `reasoning`, and `totalTokens`. Also include non-overlapping tool-result usage, preferring a direct
  `usage` object over nested subagent `details.results[*].usage` so the same work is never counted
  twice.
- Claude: collapse repeated content chunks by message ID and retain one final/nonzero usage record,
  including `cache_creation_input_tokens`, `cache_read_input_tokens`, and
  `output_tokens_details.thinking_tokens`. Include discovered `isSidechain` assistant usage while
  keeping sidechain models out of main-thread identity verification.
- Codex: never sum cumulative `token_count` events. Keep each rollout independent and use the main
  rollout's final `total_token_usage`. For each detected subagent, sum native `last_token_usage`
  intervals when present; otherwise use the final-minus-initial cumulative delta so an inherited
  baseline is not counted as main-thread work. Apply the same per-rollout calculation at the Plan
  transition.

Reasoning tokens are a subset of output tokens and cached input is normalized to avoid counting it
again as uncached input. Cache hit ratio is cache-read input divided by uncached plus cache-read
input. Missing or invalid native categories remain `null`; metadata-only sessions have `usage=null`
and an explicit parser warning. Unknowns are never converted to zero and cannot enter token medians
or winner claims.

No classifier or subagent category is excluded. The approved exclusion rule requires every compared
harness to expose an equivalent separable category, and these pinned native formats do not. Detected
auxiliary usage is therefore included and retained in explicit `detected`, `included`, `separable`,
`usage`, `categories`, and `full_accounting_established` result metadata. Pi tool usage is optional,
Claude child discovery/linkage is not guaranteed, Codex child rollout discovery is not guaranteed,
and classifier work is not equivalently separable across all formats. Every result carries a parser
warning, and totals must not be described as guaranteed complete auxiliary accounting.

Native records also establish actual execution identity and interaction counts. Ambiguity evidence
includes timestamped assistant/user text and structured Pi `plan_mode_question`, Claude
`AskUserQuestion`, and Codex `request_user_input` arguments. A qualifying question must have a
native timestamp before every explicit choice; a post-choice confirmation does not qualify.

Identity rules are:

- Pi session metadata supplies provider, exact model, and thinking level.
- Claude assistant messages supply the exact model; the `sonnet` launch alias alone is never treated
  as proof. Claude reasoning level remains unknown when the native log omits it.
- Codex `session_meta` and `turn_context` supply provider, exact model, and reasoning effort.
- Finalized assistant turns, tool calls, blocked calls, and raw tool-name categories are deduplicated
  and split into Plan, implementation, and combined counts when timestamps permit.

Each schema 3.0 `result.json` retains requested selectors separately from actual native metadata,
fixture documentation requirements, fixed clarification metadata, planning quality, auxiliary usage
evidence, accepted-plan hash/path, seed-verification evidence, nullable raw token categories,
Plan/implementation/combined interaction counts, cache hit ratio, seed-based patch byte and line
counts, documentation status, isolated visible and hidden subgates, concrete failure reason,
redacted-only session artifacts, and parser limitations. Success requires every visible subgate,
every hidden subgate, accepted plan capture, required ambiguity-question behavior, and an updated
`README.md`/`docs/` path when the fixture requires documentation.

## Report

```sh
uv run pi-harness-benchmark report
```

The command writes machine-readable `artifacts/report.json` and concise `artifacts/report.md`.
Each provider pair reports visible/hidden/combined pass rates; successful-run-only median/range for
combined tokens, Plan token share, turns, tool calls, blocked calls, start-to-stop elapsed time, and
cache ratio; matched native-minus-Pi deltas; actual identities; and limitations. Every metric carries
its sample `n`. A partial successful-run sample is flagged and its median/range is suppressed;
matched deltas require complete matched availability. Failed runs affect pass rates but never
successful-run performance medians.

Pair eligibility requires the approved actual provider and concrete model, not just counterpart
agreement: `claude-sonnet-5` for both Anthropic harnesses and `gpt-5.6-terra` for both OpenAI
harnesses. Any available actual reasoning level must be `medium`. Wrong-but-equal identities are
ineligible; unavailable reasoning is reported rather than invented. A run with a recorded operator
protocol violation makes its provider pair ineligible and emits the concrete deviation as a report
limitation. Report generation also rejects start timestamps that contradict matrix order. Incomplete
pairs are not imputed. Anthropic and OpenAI metrics are never pooled.

Auxiliary accounting limitations are emitted prominently in JSON and Markdown. Detected auxiliary
usage remains included rather than excluded asymmetrically; the report labels the native discovery
limitation without adding a third condition to the approved decision rule.

Global decision rule: Say Pi is more token-efficient only if, in both complete eligible provider
pairs, Pi pass rate is greater than or equal to native pass rate and Pi successful-run median
combined tokens are lower than native successful-run median combined tokens.

`results/` contains the checked-in final report, operator notes, and one machine-readable result per
run. Raw terminal/native logs, gate environments, worktrees, and other generated `artifacts/` remain
excluded because they are large and may contain machine-local session data.

## Development

```sh
make all
make tox
uv build
```

`make all` formats, lints with `--ignore-noqa`, type-checks with ty, and runs pytest with branch
coverage. Non-native unit tests stub the historical CLI versions and plan-mode configuration.
The `native_runtime` test uses the real pinned Codex 0.154.0 sandbox without making model calls;
it is included in the monorepo gate and fails if that prerequisite is missing. Follow the isolated
Codex install/environment recipe in the [root README](../../README.md). The monorepo gate
(`make check-benchmark` at the root) does not rewrite files. These historical sandbox tests require
macOS. `tox` exercises Python 3.12, 3.13, and 3.14 when those interpreters are available.
