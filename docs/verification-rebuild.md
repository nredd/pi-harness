# Rebuild verification at the owning boundary

| Destination | Scenario functions |
| --- | ---: |
| `A:dev-tools` | 4 |
| `A:session-kit` | 44 |
| `A:subscription-router` | 1 |
| `A:preset` | 21 |
| `A-stack` | 37 |
| `B:core` | 5 |
| `B:pi-subagents` | 16 |
| `B:pi-plan-mode` | 7 |
| `B:rpiv-todo` | 4 |
| `B:pi-claude-auth` | 0 |
| `C` | 1 |
| `D` | 8 |
| `E` | 1 |
| `F` | 7 |
| `G` | 4 |
| `DOTFILES` | 13 |
| `MERGE:<test>` | 14 |
| `DROP` | 3 |
| Total | 190 |
| Real-process scenarios before -> after (`D` + `E` + `F` + `G`) | 190 -> 20 (89.5% fewer) |

- Count functions, not collected parameter cases or process launches. The baseline is the requested 190-function inventory; static functions and the portable exporter never needed a Pi process even before this rebuild. Router shell cases are accounted separately below, not another 13 functions in this total. `C` has its own artifact runner and is outside the requested real-process subtotal.
- Read-only audit of `pi-harness-e2e/scenarios/`, not adoption of the verdicts in `docs/perf-profile.md` or `docs/verification-layers.md`. Their 181 retained scenarios defend an accidental implementation boundary. A real session is necessary for many invariants; a new Pi process is not.
- Paths beginning `packages/`, `forks/`, `scripts/` and `integration/` are relative to `pi-harness`. Source `File` labels are relative to `pi-harness-e2e`. `write` means a replacement still needs implementing, not verified coverage. No scenarios, binaries, tmux, benchmarks or test runners were run for this document.
- Every `A:<package>` target is under `packages/<package>/test/scenarios/`, on the exported core harness or its injected-terminal renderer. Every `A-stack` target is under `integration/inprocess/`, loading the real named extension factories together. Both run under Vitest and `bun test`; fake clocks advance production timer callbacks, not reimplementations of the decision logic. No real-clock waits or `NODE_OPTIONS` timer preloads.
- `B:<fork>` stays in that fork's suite. Rows explicitly distinguish existing coverage from tests to write. Similar helper tests are seeds, not proof of a complete host sequence. `MERGE:<test>` transfers all listed assertions to the named destination; it is not permission to discard them. Delete old scenarios only when their replacement is green in its required gate.
- `C` owns packed bytes, installation, discovery and trust. `D` owns a declared package-set JSON list installed into a throwaway agent dir and actual process modes/lifetime/auth transport. `E` owns the one retained real terminal resize seam. `F` owns serial performance; `G` owns opt-in live interoperability. No package gate reads the live install, `~/.pi/agent`, `~/.local/share/chezmoi` or the Brewfile. Live `G` receives an explicit credential path, never discovers the owner's default path.
- Existing `scripts/package_contracts.py::install_alone` uses npm installation followed by explicit `--extension`; `scripts/fork_package_contracts.py` also explicitly loads the archived fork. Neither currently proves `pi install`. Upgrade `C` to install the exact tarballs through `pi install`, then load through declared package discovery. Keep its stock-host identity/import/peer/license checks. Do not claim that improvement exists today.
- Add `integration/scenarios/test_startup.py::test_fatal_startup_modes` to `D`: ordinary/fatal factory and `session_start` failures across print text/JSON, RPC and TUI; nonzero fatal exit, no provider call, no held-message leak. This is a new boundary test, not a 191st migrated function. The rebuilt boundary inventory is therefore 21 functions including this addition, versus 20 surviving migration rows; parameterized modes still cause multiple launches. Core's startup race permutations stay in `B:core`, not this matrix. `D` runs Node and Bun; `E` runs once per OS terminal job, not twice to retest runtime logic.

Progress (a row is DONE when its native test is green under Vitest and `bun test` and the scenario is deleted from `integration/scenarios/`; `pi-harness-e2e` stays frozen until it is archived):

- dev-tools: 4 DONE in `packages/dev-tools/test/scenarios/`, `test_py_tools`/`test_cargo_tools` dropped as duplicates, `test_git_commit_relays_hook_failure` dropped as `D1`. `integration/scenarios/integration/test_dev_tools.py` deleted; its git fixture moved to `integration/harness/git_fixture.py` for `test_code_reviewer.py`
- subscription-router: 9 of 13 `run.sh` cases DONE in `packages/subscription-router/test/scenarios/{recovery,balanced}.test.ts` on `createSubscriptionRouter({ config, usage, tracker, now })`. `run.sh` keeps `wait`/`fail`/`capped`/`no-router` (pi-subagents), so `test_router_e2e_all` stays until those land
- session-kit (batch 1): 14 DONE in `packages/session-kit/test/scenarios/{child-identity,goal,goal-restore,rules,titles}.test.ts` on `createSessionKit({ config, agentDir, monitorRoot })`. `test_session_kit_child_identity.py` and `test_session_kit_titles_rules.py` deleted (the latter's leftover unmatched-path case is asserted by `rules.test.ts`); `test_session_kit_goal.py` keeps its seven `A-stack` rows
- session-kit (batch 2): 12 DONE in `packages/session-kit/test/scenarios/{monitor,loop,isolation}.test.ts`: real manager/ring/coalescer/matcher and host queue, controlled child processes through `createSessionKit({ spawnMonitor })`, one injected `clock` (`src/clock.ts`) for loop intervals, goal wakes and monitor batching/timeouts. Process-group kill, pidfile cleanup and orphan sweep stay in `D`

Orchestrator adjudication, 2026-10-18 (verdicts reviewed row by row against `PLAN.md` "The rebuild"; changes from the drafting pass):

- Six specialist/reviewer rows (`test_agent_types.py`, `test_code_reviewer.py`) moved `A:preset` -> `A-stack`. The invariant is `pi-subagents` enforcing the preset's frontmatter on a child; a stub runner in the preset package would only test the stub. Real `pi-subagents` + preset agents + dev-tools factories in one harness session.
- Footer rows (`test_footer_cache.py`, `test_quota_footer.py`, `test_quota_footer_headless.py`, `tests/test_quota.py`): the LIVE footer is still the dotfiles copy (`private_dot_pi/agent/extensions/expanded-footer.ts`, `lib/footer-{cache,quota}.ts`), which today differs from `packages/preset` only by formatting. Deleting those scenarios is gated on the profile loading the preset's footer (item 7), not only on the native tests going green.
- `static/` split: the chezmoi-free half of `test_settings_keys_are_known_to_pi` is a package invariant and is ALREADY native: `packages/preset/test/resources.test.ts` / `settings defaults are a public-safe subset of keys Pi knows` validates `settings/personal-defaults.json` against the host's `schemas/settings.schema.json`. The owner-render half stays `DOTFILES`.
- Interactive export: 41 rows replace tmux with `VirtualTerminal` + an interactive host bound to a harness session (13 `A:preset`, 10 `A:session-kit`, 4 `A-stack`, 4 `B:core`, 5 `B:pi-subagents`, 4 `B:rpiv-todo`, 1 `B:pi-plan-mode`). Core `v1.3.0-nredd.4` (nredd/pi#4) exports only the session harness + caller-owned `cwd`. A follow-up core PR exports `VirtualTerminal`, the interactive binder and a clock-aware render flush before any of those 41 ports start. The other 98 native rows (`A`, `A-stack`, `B`: 139 total) need nothing beyond nredd/pi#4.
- Rejected: a "mode-correct binding adapter" export. `session.bindExtensions({ mode, uiContext })` already is that API (`mode` is `tui | rpc | json | print`).
- Accepted as drafted: the eight `D` rows (auth transport, loader warnings, tool-set golden, process lifetime, print output routing, orphan sweep), the single `E` resize seam, `F`/`G` unchanged, compaction to `B:core`.

- File: `scenarios/bench/test_fanout.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_eight_agent_fanout_wall_time` | Eight foreground children complete concurrently within the wall-time baseline. | `F` | Retain as `integration/scenarios/bench/test_fanout.py::test_eight_agent_fanout_wall_time`; explicit package set, eight scripted children, quiet runner. Timing is the invariant, not a scheduler unit test. |

- File: `scenarios/bench/test_multisession.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_multi_session_responsiveness` | Input/stream latency scales from 1/4/8 panes; idle output stays bounded. | `F` | Retain as `integration/scenarios/bench/test_multisession.py::test_multi_session_responsiveness`; explicit shared agent dir and 2k history, paced faux streams, three samples. Absorb probe self-calibration below. |

- File: `scenarios/bench/test_render.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_render_2k_message_transcript` | Full/steady frame cost and live heap hold with 2k messages. | `F` | Retain as `integration/scenarios/bench/test_render.py::test_render_2k_message_transcript`; explicit history/artifacts, runtime-specific in-process GC capability with readiness, never silently omit heap. |
| `test_render_50k_line_bash_output` | A 50k-line result settles and expands within render baselines. | `F` | Retain as `integration/scenarios/bench/test_render.py::test_render_50k_line_bash_output`; real output/terminal writes, explicit stack, quiet runner. |

- File: `scenarios/bench/test_startup.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_cold_startup_to_first_frame` | Cold process-to-first-footer time holds. | `F` | Retain as `integration/scenarios/bench/test_startup.py::test_cold_startup_to_first_frame`; declared stack, real startup paint, fixed runner identity. |
| `test_time_to_first_token` | Cold process-to-first-stream-update time holds. | `F` | Retain as `integration/scenarios/bench/test_startup.py::test_time_to_first_token`; scripted immediate response, explicit binary and stack. |

- File: `scenarios/bench/test_typed_vs_bash.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_typed_vs_bash` | Typed git preserves facts and its byte/spawn/time advantage (`diff`, `log`, `status`). | `F` | Retain as `integration/scenarios/bench/test_typed_vs_bash.py::test_typed_vs_bash`; real disposable git repo, paired calls in one process, three samples, unchanged ceilings. |

- File: `scenarios/integration/test_agent_types.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_agent_tool_surface` | Five specialists expose their required tools and exclude forbidden tools. | `A-stack` | Write `integration/inprocess/specialists.test.ts` / `specialists expose their declared surfaces` (`architect`, `critic`, `debugger`, `researcher`, `verifier`); REAL `pi-subagents` factory discovering `packages/preset/agents` as package agents, real dev-tools factory, inert web/memory declarations, faux child turn capturing model-visible schemas. Scope enforcement belongs to `pi-subagents`; a stub runner would only test the stub. |
| `test_read_only_agent_rejects_write` | Read-only specialists cannot execute an undeclared write or alter the target. | `A-stack` | Write `integration/inprocess/specialists.test.ts` / `read-only specialists reject explicit writes` (`architect`, `critic`, `researcher`); same real subagents + preset agents, faux forbidden child call, sentinel file bytes unchanged. |
| `test_debugger_cannot_commit` | A debugger's explicit exclusion beats always-active commit registration. | `A-stack` | Write `integration/inprocess/specialists.test.ts` / `debugger excludes commit despite always-active defaults`; real subagents/preset/dev-tools factories, `git_commit` records zero executions. Dotfiles doctor separately compares local overrides; it is not a reason to keep process tests. |

- File: `scenarios/integration/test_agent_worktree.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_worktree_from_named_repo` | Explicit child cwd selects another repo and preserves the main checkout. | `B:pi-subagents` | Existing `forks/pi-subagents/test/worktree-isolation-e2e.test.ts` / `worktree isolation e2e (real git, real pi-mono, faux model)` / ``isolates a repo other than the session cwd when the caller names it as `cwd` ``; real git and in-process child. Extend its absolute-path case with fixture-home `~/code/target/pkg` expansion before deleting the old scenario. |
| `test_worktree_failure_names_directory` | Non-repo cwd failure names the directory and the cwd remedy. | `B:pi-subagents` | Existing same file/describe / `names the directory and cause when the session cwd is not a repo`; real in-process runner and git. No CLI boundary. |

- File: `scenarios/integration/test_claude_auth.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_request_uses_auth_json_token_with_claude_code_headers` | Native OAuth wire request uses Pi's token and the headers-only extension's billing format. | `D` | Write `integration/scenarios/test_auth_transport.py::test_request_uses_auth_json_token_with_claude_code_headers`; loopback messages server, fake OAuth, blocked egress, recording forbidden-command shims. Parameterize direct/router, API key/custom provider exclusions and planted Claude credentials from merged rows. This asserts actual transport hook assembly, not every transform permutation. |
| `test_claude_code_credentials_are_never_read` | Planted Claude credentials never replace Pi credentials or invoke Claude/security. | `MERGE:test_request_uses_auth_json_token_with_claude_code_headers` | Add planted token and forbidden-command assertions to `integration/scenarios/test_auth_transport.py::test_request_uses_auth_json_token_with_claude_code_headers`; same wire run, no second cold start. |
| `test_expired_token_refreshes_natively_and_persists` | Native refresh uses and persists the new token pair. | `D` | Write `integration/scenarios/test_auth_transport.py::test_expired_token_refreshes_natively_and_persists`; loopback token endpoint + messages endpoint, expired fake auth file, custom/default agent-dir sentinels, unrelated provider records. |
| `test_refresh_failure_sends_nothing_and_keeps_credentials` | Refresh refusal cannot dispatch stale credentials or resurrect logged-out auth. | `D` | Write `integration/scenarios/test_auth_transport.py::test_refresh_failure_sends_nothing_and_keeps_credentials`; mock 400 grant, exact auth preservation, no messages/CLI; table also covers logout then explicit relogin across launches. |
| `test_unrelated_credentials_survive_a_refresh` | Refresh leaves other provider entries unchanged. | `MERGE:test_expired_token_refreshes_natively_and_persists` | Seed/compare unrelated entries in `integration/scenarios/test_auth_transport.py::test_expired_token_refreshes_natively_and_persists`; no extra transport test. |
| `test_logout_stays_logged_out_and_relogin_is_picked_up` | Absence stays absent despite planted Claude auth; a later Pi login is honored. | `MERGE:test_refresh_failure_sends_nothing_and_keeps_credentials` | Add logged-out/relogin branch to `integration/scenarios/test_auth_transport.py::test_refresh_failure_sends_nothing_and_keeps_credentials`; explicit disk edits between launches, no live login. |
| `test_custom_agent_dir_is_the_only_one_touched` | CLI env selects the sole auth persistence directory. | `MERGE:test_expired_token_refreshes_natively_and_persists` | Run `integration/scenarios/test_auth_transport.py::test_expired_token_refreshes_natively_and_persists` with a nondefault `PI_CODING_AGENT_DIR`; default sentinel must remain byte-identical. |
| `test_router_routed_anthropic_requests_get_the_same_headers` | Physical Anthropic requests get headers despite a virtual selected model. | `MERGE:test_request_uses_auth_json_token_with_claude_code_headers` | Router variant in `integration/scenarios/test_auth_transport.py::test_request_uses_auth_json_token_with_claude_code_headers`; real router/auth factories, loopback transport, explicit profile. |
| `test_api_key_request_has_no_billing_block` | API-key wire requests have no OAuth bearer/billing block. | `MERGE:test_request_uses_auth_json_token_with_claude_code_headers` | API-key branch in `integration/scenarios/test_auth_transport.py::test_request_uses_auth_json_token_with_claude_code_headers`; assert `x-api-key` and absence of billing prefix. |
| `test_enterprise_anthropic_provider_has_no_billing_block` | Custom Anthropic-compatible wire requests are excluded from subscription mutation. | `MERGE:test_request_uses_auth_json_token_with_claude_code_headers` | Custom provider branch in `integration/scenarios/test_auth_transport.py::test_request_uses_auth_json_token_with_claude_code_headers`; fixture models config, no enterprise manifest. |

- File: `scenarios/integration/test_code_reviewer.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_configured_reviewer_tool_surface` | Reviewer has seven reads and no mutations. | `A-stack` | Write `integration/inprocess/reviewer.test.ts` / `reviewer exposes exactly seven reads plus the refusal helper`; real `pi-subagents` factory + preset `code-reviewer.md` as a package agent + real dev-tools factory, faux child turn captures schemas. Artifact discovery/trust remains in `C`. |
| `test_configured_reviewer_executes_reads` | Every allowed reviewer read succeeds through the restricted child pipeline. | `A-stack` | Write `integration/inprocess/reviewer.test.ts` / `reviewer executes each permitted read`; same real factories, temp git repo, faux seven child calls through real child scope enforcement. `A:dev-tools` owns git result correctness. |
| `test_configured_reviewer_rejects_mutations` | Seven explicit mutation attempts fail without modifying a sentinel. | `A-stack` | Write `integration/inprocess/reviewer.test.ts` / `reviewer rejects every explicit mutation`; same real factories, faux undeclared child calls, sentinel bytes. `scripts/fork_package_contracts.py::build_cases` owns only package/override/trust wiring. |

- File: `scenarios/integration/test_compaction.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_compaction_triggers_one_token_past_the_threshold` | Public prompting compacts strictly above, not at, the usage threshold. | `B:core` | Write `forks/pi/packages/coding-agent/test/suite/agent-session-compaction.test.ts` / `AgentSession compaction characterization` / `public prompt compacts at threshold plus one but not equality`; fresh seeded session per side, exact faux usage/summary. Existing private `_checkCompaction` tests are not this public-path receipt. Delete Python's mirrored token formula. |

- File: `scenarios/integration/test_dev_tools.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_git_reads` | Git reads preserve rename/space/staging facts and named structured failures. | `A:dev-tools` | DONE: `packages/dev-tools/test/scenarios/git.test.ts` / `reads return parsed state and compact text, and failures carry a named state`; real factory, temp git/bare remote, faux read calls, `structuredContent`/`isError` from `tool_execution_end`. |
| `test_git_commit_and_guard` | Named paths alone commit/push in house style; Bash bypasses are blocked. | `A:dev-tools` | DONE: `packages/dev-tools/test/scenarios/git.test.ts` / `commits only the named paths in house style and pushes; the guard blocks bash bypasses`; real `tool_call` hook in front of pi's real `bash` tool (red when the guard rules are emptied). |
| `test_git_worktrees` | Worktree tools add/list/refuse/remove/prune. | `A:dev-tools` | DONE: `packages/dev-tools/test/scenarios/git.test.ts` / `worktree tools add, list, refuse and remove`. The package registers every tool `direct`; deferral comes from the owner's `deferred-tools.json` + the third-party context engine, so `search_tools` promotion belongs to `D`'s `test_tool_set` golden, not here. |
| `test_git_commit_relays_hook_failure` | Failed hook reports modification/re-stage advice without a commit. | `DROP` | Existing `packages/dev-tools/test/git/tools.test.ts` / `git_commit` / `relays a failing hook and flags hook-modified files` already uses real git, executable failing hook, unchanged HEAD and exact result fields. No distinct process invariant. |
| `test_ssh_exec` | Host validation distinguishes remote exit, SSH failure and injection. | `A:dev-tools` | DONE: `packages/dev-tools/test/scenarios/ssh.test.ts` / `validates the host, runs the script, and separates remote from ssh failures`; `createDevTools({ ssh: { knownHosts, sshBin } })` with `test/fixtures/ssh/fake-ssh`, no network. |
| `test_py_tools` | Python diagnostics/format/test exits retain named states in tool results. | `DROP` | Existing `packages/dev-tools/test/py/tools.test.ts` / `py tools against a real uv project` runs real uv/ruff/ty/pytest on the same project and asserts every e2e fact (F401/I001, `would-reformat`, `invalid-return-type`, counts, failing nodeid, `math is hard`, `-k`). The AgentSession serialization is the generic path `git.test.ts` already proves. |
| `test_cargo_tools` | Cargo check/clippy/tests deduplicate diagnostics and preserve doctest/no-tests states. | `DROP` | Existing `packages/dev-tools/test/cargo/tools.test.ts` / `cargo tools against a real workspace` runs real cargo/nextest on the same workspace and asserts E0308 x1, `cast_possible_truncation`, `tests: 2`, `good tests::fails`, doctests, `no-tests`. Same serialization argument as `test_py_tools`. |

- File: `scenarios/integration/test_extensions.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_extensions_load_without_warnings` | The declared stack loads once without warnings, stdout noise or unwanted GUI helpers. | `D` | Write `integration/scenarios/test_stack.py::test_extensions_load_without_warnings`; package-set JSON + `pi install`, faux reply, stderr/stdout/Applications checks. Add print text/JSON, RPC state and TUI startup/exit cases here; no owner settings. |
| `test_tool_set` | The assembled model-visible tool surface and one deferred promotion match the declared stack. | `D` | Write `integration/scenarios/test_stack.py::test_tool_set`; golden keyed by explicit package set, faux schema capture and `search_tools` monitor/worktree promotion, not a personal golden copied blindly. |
| `test_workflows_trigger_does_not_arm_on_mentions` | Disabled keyword trigger leaves the user's workflow mention untouched. | `A-stack` | Write `integration/inprocess/workflow-trigger.test.ts` / `workflow mentions do not rewrite prompts when keyword triggering is disabled`; real pinned workflow factory with fixture settings + faux response. Doctor owns the personal setting, not this behavioral regression. |

- File: `scenarios/integration/test_plan_mode_confirmation.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_reproposal_confirmation_affirmative_allows_one_completion` | Canonical affirmative confirmation grants one replacement proposal. | `B:pi-plan-mode` | Write `forks/pi-plan-mode/test/confirmation-session.test.ts` / `canonical affirmative permits one completion after restore`; real factory/core harness, file-backed decline, `createTestUiContext.select` choices. Existing `decline-gate.test.ts` / `only explicit Re-propose now confirmation permits a re-proposal` is the local-state seed, not a persisted session test. |
| `test_reproposal_confirmation_nonaffirmative_keeps_completion_blocked` | Not-yet/cancel choices leave the restored gate closed (two cases). | `B:pi-plan-mode` | Write `forks/pi-plan-mode/test/confirmation-session.test.ts` / `nonaffirmative and cancellation preserve the restored gate`; select double returns canonical not-yet/undefined. Core RPC protocol serialization belongs to core; this scenario's policy does not require RPC. |

- File: `scenarios/integration/test_plan_mode_gate.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_reply_to_ready_plan_gates_completion` | Decline plus UI-unavailable clarification cannot authorize a replacement. | `B:pi-plan-mode` | Write `forks/pi-plan-mode/test/decline-session.test.ts` / `ready-plan reply blocks completion with actionable headless guidance`; real session/factory, faux repeated completion, print-mode UI double, assert entire error guidance. |
| `test_plan_finalize_lifts_gate` | Finalize dispatch completes a new proposal after a decline. | `B:pi-plan-mode` | Write `forks/pi-plan-mode/test/decline-session.test.ts` / `finalize awaits its headless completion turn`; core command/session lifecycle, faux final proposal, await queued turn. Existing `decline-gate.test.ts` / `/plan finalize confirms re-proposal without resetting the counter` seeds the local assertion. |

- File: `scenarios/integration/test_plan_mode_policy.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_allowed` | Seven read-only shell segments under fixture trusted roots are admitted. | `B:pi-plan-mode` | Write `forks/pi-plan-mode/test/policy-session.test.ts` / `admits every safe shell table row`; port all seven `ALLOWED` values, replace owner directories with fixture roots, real factory + inert Bash executor recording admission. |
| `test_blocked` | Eleven mutation/escape/interpreter shell rows are blocked before execution. | `B:pi-plan-mode` | Write `forks/pi-plan-mode/test/policy-session.test.ts` / `blocks every unsafe shell table row`; port all eleven `BLOCKED` values, same real hook, executor must receive zero blocked calls. Existing segment/path unit matrices stay local parser tests. |
| `test_tool_allowed` | Plan consumes real dev-tools read annotations and revalidates SSH host/command. | `A-stack` | Write `integration/inprocess/annotated-tools.test.ts` / `Plan admits annotated dev-tools reads`; real Plan/dev-tools factories, four `TOOL_ALLOWED` cases, explicit active tools and SSH config/fake executor. |
| `test_tool_blocked` | Plan rejects mutations and unsafe SSH despite typed-tool registration. | `A-stack` | Write `integration/inprocess/annotated-tools.test.ts` / `Plan blocks mutating tools and unsafe typed ssh`; all seven `TOOL_BLOCKED` cases, real annotations/Plan hook, sentinel side effects absent. |

- File: `scenarios/integration/test_plan_todos.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_plan_items_close_in_one_evidenced_batch` | Approval seeds work that one evidenced/deferred atomic batch closes verbatim. | `A-stack` | Write `integration/inprocess/plan-todos.test.ts` / `approved work closes in one evidenced batch`; real Plan/todo factories, faux proposal and `ops`, approval UI double, exact persisted statuses/rows. |
| `test_closed_plan_heading_counts_sum` | Closed-plan command counts sum to all seeded items. | `MERGE:test_plan_items_close_in_one_evidenced_batch` | Extend `integration/inprocess/plan-todos.test.ts` / `approved work closes in one evidenced batch` with `/todos` notification capture: two done, one deferred, no open. No second RPC launch. |
| `test_replacement_approval_replaces_unfinished_plan_todos` | Approved replacement atomically replaces unfinished old plan tasks. | `A-stack` | Write `integration/inprocess/plan-todos.test.ts` / `replacement approval replaces old work atomically`; real pair, file-backed reopen, exact new IDs/subjects. |
| `test_declined_replacement_preserves_old_plan_todos` | Declined/unanswered replacement cannot overwrite approved work. | `A-stack` | Write `integration/inprocess/plan-todos.test.ts` / `declined replacement preserves old work`; same pair, scripted select/undefined, reopen and list. |
| `test_replanning_defers_old_reminder_across_compaction_and_restore` | Replanning suppresses old-work reminders through compaction/restore, including legacy mode entries. | `A-stack` | Write `integration/inprocess/plan-todos.test.ts` / `replanning suppresses reminders across compaction and legacy restore`; real pair/core compaction, scripted summary, file-backed sessions and legacy custom entries, then exit/reopen and assert one reminder. Six launches become several in-process sessions. |
| `test_plan_items_are_seeded_verbatim` | Approval publishes exact plan bullets before model-created tasks. | `A-stack` | Write `integration/inprocess/plan-todos.test.ts` / `approval seeds verbatim bullets before any todo call`; real pair/event, faux list, exact plan headers/sections/subjects. |
| `test_completed_requires_evidence` | Plan-seeded tasks reject bare completion and accept proof. | `A-stack` | Write `integration/inprocess/plan-todos.test.ts` / `seeded plan tasks keep the evidence gate`; real pair, faux bare/proven updates and transcript assertions. Generic todo evidence validation stays in the fork's unit suite. |
| `test_ending_with_open_items_reminds_once` | Premature completion yields one request-local open-work reminder and one hidden marker. | `A-stack` | Write `integration/inprocess/plan-todos.test.ts` / `open approved work reminds once at settlement`; real pair/core settle, faux context inspector, branch entries. Assert completed item absent from reminder. |

- File: `scenarios/integration/test_quota_footer_headless.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_rpc_mode_never_mounts_quota_poller` | RPC binding never mounts the quota footer or requests usage. | `A:preset` | Write `packages/preset/test/scenarios/footer-headless.test.ts` / `rpc binding never mounts quota polling`; real footer factory/core bind, RPC UI double, usage bus spy, advance fake clock several intervals. CLI RPC startup itself is in `D`. |
| `test_plain_print_mode_never_polls` | Text print binding never polls even while a response is pending. | `A:preset` | Write `packages/preset/test/scenarios/footer-headless.test.ts` / `text binding never mounts quota polling`; mode-correct real bind, deferred faux response, fake clock and usage bus spy. |
| `test_json_print_mode_never_polls` | JSON print binding never polls during a turn. | `A:preset` | Write `packages/preset/test/scenarios/footer-headless.test.ts` / `json binding never mounts quota polling`; same mode fixture as text, assert no footer mount/RPC/timer. Preserve both output-mode bindings as data cases, not process waits. |

- File: `scenarios/integration/test_router_e2e.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_router_e2e_all` | Every recovery/admission/balanced shell case is covered. | `A:subscription-router` | Write `packages/subscription-router/test/scenarios/recovery.test.ts` and `balanced.test.ts`, plus `integration/inprocess/router-admission.test.ts`; exact 13 case/test names below. Delete this wrapper and `run.sh` only after every case has its receipt. No residual installed-core canary: `C` owns artifact dispatch, `D` owns assembled startup. |

- File: `scenarios/integration/test_session_kit_child_identity.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_child_identity_reload` | Child identity persists after rename/reload; parent remains unrestricted (two cases). | `A:session-kit` | DONE: `packages/session-kit/test/scenarios/child-identity.test.ts` / `rename and rebind preserve child restrictions only for children (child)` and `(parent)`; real kit factory/core reload, resource loader recreates factories, file-backed marker, explicit active-tool promotion and direct execute probes. No loader discovery assertion is needed to prove marker semantics. |

- File: `scenarios/integration/test_session_kit_goal.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_goal_continues_until_complete_with_evidence` | Settles nudge until evidenced completion, with exact turn accounting. | `A:session-kit` | DONE: `packages/session-kit/test/scenarios/goal.test.ts` / `goal nudges until evidenced completion`; real factory/core settle, faux three replies/completion, hidden branch markers and counts. |
| `test_complete_is_refused_without_evidence` | Empty/whitespace evidence cannot complete a goal. | `A:session-kit` | DONE: `packages/session-kit/test/scenarios/goal.test.ts` / `goal completion rejects empty evidence then accepts proof`; faux three tool calls, exact active/complete snapshots. |
| `test_blocked_stops_the_goal` | Blocked state preserves its reason and suppresses further nudges. | `A:session-kit` | DONE: `packages/session-kit/test/scenarios/goal.test.ts` / `blocked goal settles without another nudge`; faux blocked result and spare response remains unused. |
| `test_turn_budget_stops_continuation` | Three parent turns yield two nudges and a terminal budget state. | `A:session-kit` | DONE: `packages/session-kit/test/scenarios/goal.test.ts` / `parent turn cap stops at three`; real turns, faux queue, exact pending count. |
| `test_token_budget_stops_continuation` | Reported parent usage exhausts the configured token budget. | `A:session-kit` | DONE: `packages/session-kit/test/scenarios/goal.test.ts` / `parent usage exhausts token budget without another nudge`; real faux-estimated request usage above 20000 (core overwrites scripted usage), exact reported-token accounting, ignored non-assistant usage. |
| `test_goal_tool_is_active_only_while_a_goal_is` | Goal activation adds only its tool; completion removes it. | `A:session-kit` | DONE: `packages/session-kit/test/scenarios/goal.test.ts` / `goal lifetime changes only goal_update exposure`; inspect actual provider-request schemas before/during/after with real core tools. `D` owns generic deferred-engine compatibility. |
| `test_pause_stops_nudges_and_resume_restores_them` | Explicit pause/resume controls subsequent settle continuation. | `A:session-kit` | DONE: `packages/session-kit/test/scenarios/goal.test.ts` / `pause suppresses nudges until explicit resume`; commands through real session, faux replies/proof. |
| `test_resumed_session_restores_the_goal_paused` | A persisted active goal restores paused and needs explicit resume. | `A:session-kit` | DONE: `packages/session-kit/test/scenarios/goal-restore.test.ts` / `active disk snapshot restores paused`; file-backed `SessionManager`, dispose/reopen, fresh factory, no CLI required. |
| `test_no_goal_means_no_nudge_and_no_state` | Ordinary prompts create no goal state or continuation. | `A:session-kit` | DONE: `packages/session-kit/test/scenarios/goal.test.ts` / `ordinary prompt leaves goal inert`; faux spare response, no goal/nudge entries. |
| `test_provider_error_pauses_the_goal` | Real host error settlement pauses without nudging. | `A:session-kit` | DONE: `packages/session-kit/test/scenarios/goal.test.ts` / `provider error pauses goal at host settlement`; scripted faux error, real core outcome events, spare response untouched. |
| `test_foreground_subagent_is_not_nudged_and_not_counted` | Child turns/tools never spend or inherit the parent's goal budget. | `A-stack` | Write `integration/inprocess/goal-subagents.test.ts` / `foreground child is isolated from parent goal accounting`; real kit/subagents factories, separate faux child sessions, exact parent cap/schema/markers. |
| `test_background_subagent_notice_is_delivered_before_any_nudge` | Background notice reaches parent before any goal nudge. | `A-stack` | Write `integration/inprocess/goal-subagents.test.ts` / `background notice wins before goal nudge`; real outbox/kit/core, deferred faux child barrier, advance outbox clock, assert request and branch ordering. |
| `test_scheduled_subagent_notice_is_delivered_before_any_nudge` | Scheduled child delivery has the same ordering and goal isolation. | `A-stack` | Write `integration/inprocess/goal-subagents.test.ts` / `scheduled notice wins before goal nudge`; real scheduler/outbox/kit, injectable clock advances scheduled dispatch while parent tool is held by a promise. |
| `test_todo_reminder_and_goal_nudge_share_one_continuation` | Todo reminder wins one continuation and retains evidence enforcement. | `A-stack` | Write `integration/inprocess/goal-todos.test.ts` / `todo reminder and goal share one continuation`; real Plan/todo/kit factories, approved plan, faux context capture, no goal marker between the chosen turns. |
| `test_goal_is_refused_in_plan_mode` | Goal creation in Plan mode records nothing. | `A-stack` | Write `integration/inprocess/goal-plan.test.ts` / `Plan refuses goal creation`; real Plan/kit, command dispatch, branch/queue assertions. |
| `test_plan_mode_idle_excursion_pauses_until_explicit_resume` | Idle Plan enter/exit pauses an existing goal until explicit resume. | `A-stack` | Write `integration/inprocess/goal-plan.test.ts` / `idle Plan excursion pauses goal`; real factories/events, fake goal wake clock, exact state sequence. |
| `test_plan_mode_pauses_blocks_the_tool_and_resume_waits_for_exit` | Plan hides/denies goal completion and refuses resume until exit. | `A-stack` | Write `integration/inprocess/goal-plan.test.ts` / `Plan blocks goal execution and premature resume`; actual tool-call policy and kit execution guard, faux calls, exact snapshots. |

- File: `scenarios/integration/test_session_kit_monitor.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_tools_are_deferred_then_promoted_by_search_tools` | Monitor read stays active while start/stop become available only on search. | `MERGE:test_tool_set` | Add before/after schemas and actual `search_tools` result assertions to `integration/scenarios/test_stack.py::test_tool_set`; one third-party discovery seam, not 15 monitor tests loading it again. |
| `test_passive_output_is_coalesced_and_never_wakes` | Three lines coalesce into one passive message without a new turn. | `A:session-kit` | DONE: `packages/session-kit/test/scenarios/monitor.test.ts` / `passive batches coalesce without waking`; real manager/ring/coalescer/kit/core, controlled stdout and injected clock, numbered lines/display/no follow-up plus silent shutdown/termination/pidfile assertions. |
| `test_match_wakes_the_agent` | A matched batch drives one follow-up request carrying readable output. | `A:session-kit` | DONE: `packages/session-kit/test/scenarios/monitor.test.ts` / `matching output wakes once and is readable`; real regex worker/manager/tool/send/host follow-up queue, controlled child stdout, injected batching clock; nonmatch then READY batch and follow-up monitor_read. |
| `test_wake_true_wakes_on_every_batch` | Wake mode triggers each batch without needing regex matches. | `A:session-kit` | DONE: `packages/session-kit/test/scenarios/monitor.test.ts` / `wake mode follows every batch`; controlled stdout and injected batching clock, real host follow-up while busy plus a second idle wake, no regex. |
| `test_exit_wakes_and_reports_the_code` | Child exit wakes with its exact nonzero code. | `A:session-kit` | DONE: `packages/session-kit/test/scenarios/monitor.test.ts` / `exit code reaches one wake message`; controlled child exits 3 after output flush, real manager/message/host follow-up reports exact code with no output pending. OS mechanics stay native/assembled. |
| `test_read_since_returns_only_later_lines` | ID/name cursor reads return only newer lines and stable next cursor. | `A:session-kit` | DONE: `packages/session-kit/test/scenarios/monitor.test.ts` / `read cursor returns only later lines by id and name`; real splitter/ring/tools, controlled stdout a/b/c, name/id reads at since 2/3 retain next cursor and empty-output notice. |
| `test_stop_kills_the_process_group_and_stays_quiet` | Explicit stop kills descendants and cannot wake later. | `MERGE:test_children_die_when_pi_quits_mid_monitor` | Add stop-vs-quit branches to `integration/scenarios/test_monitor_lifetime.py::test_children_die_when_pi_quits_mid_monitor`; real tagged descendants + pidfiles + bounded event reader; assert no wake and second stop errors. Native `A` owns all wake-policy combinations. |
| `test_five_monitors_at_most` | Sixth concurrent/duplicate name is refused; a freed slot is reusable. | `A:session-kit` | DONE: `packages/session-kit/test/scenarios/monitor.test.ts` / `five-slot limit and names recover after stop`; real manager/validation/tools, controlled child handles, sixth/duplicate refusal, freed-slot reuse, active-child count and shutdown assertions. |
| `test_timeout_kills_and_wakes` | Timeout requests termination and one timeout follow-up. | `A:session-kit` | DONE: `packages/session-kit/test/scenarios/monitor.test.ts` / `timeout terminates and wakes once`; injected clock/child, real timeout/manager/message/host queue; exact deadline, termination grace and one timeout wake. Real OS kill stays assembled. |
| `test_children_die_when_pi_quits_mid_monitor` | Real Pi exit/explicit stop reaps monitor groups and owner pidfiles. | `D` | Write `integration/scenarios/test_monitor_lifetime.py::test_children_die_when_pi_quits_mid_monitor`; actual process groups, tagged descendants, explicit package set, print/RPC graceful shutdown and stop branches. No TUI required. |
| `test_bad_arguments_are_errors_not_crashes` | Spawn failure, invalid regex/name and missing monitor become tool errors. | `A:session-kit` | DONE: `packages/session-kit/test/scenarios/monitor.test.ts` / `bad monitor arguments return errors without crashing`; real validators/tool outcomes, injected ENOENT spawn, invalid regex/name and absent read return four errors and final prose; invalid input never spawns. |
| `test_plan_mode_admits_only_monitor_read` | Plan consumes real monitor read-only annotations and denies start/stop. | `A-stack` | Write `integration/inprocess/annotated-tools.test.ts` / `Plan admits only monitor_read`; real kit/Plan factories, active monitor from controlled spawn, all three actual calls, fake clock. |
| `test_subagents_do_not_get_monitor_tools` | Child scopes remain hidden/uncallable after promotion/reset in both load orders. | `A-stack` | Write `integration/inprocess/child-tools.test.ts` / `children cannot regain monitor tools in either factory order`; real subagents/kit + deferred engine factories, actual child schemas/direct calls, controlled runner and faux steps. Two factory orders stay parameterized. `C` alone proves installed discovery. |
| `test_diff_prints_the_stat_outside_the_tui` | CLI output routing exposes extension print text/errors without UI. | `D` | Write `integration/scenarios/test_print_output.py::test_diff_prints_the_stat_outside_the_tui`; real git diff and bad ref, text/JSON output routing, plus `/stats` table below; explicit package set. Only output-channel wiring lives here. |
| `test_stats_prints_the_model_table_outside_the_tui` | Print stats table reaches the CLI output and excludes synthetic usage. | `MERGE:test_diff_prints_the_stat_outside_the_tui` | Add seeded `/stats` output branch to `integration/scenarios/test_print_output.py::test_diff_prints_the_stat_outside_the_tui`; table accounting itself belongs in native stats tests, not this CLI smoke. |

- File: `scenarios/integration/test_session_kit_quota.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_settled_chain_exhaustion_pauses_goal_without_spin` | Confirmed chain exhaustion pauses goals with one settle in either hook order. | `A-stack` | Write `integration/inprocess/quota-goal.test.ts` / `exhausted chain pauses goal without spin in either order`; real router/kit, fake usage service + faux quota error, exact request/settle/nudge counts; router-first/kit-first cases. |
| `test_router_recovery_owns_continuation_before_goal` | Router recovery precedes the next goal nudge for terminal and retry errors. | `A-stack` | Write `integration/inprocess/quota-goal.test.ts` / `router owns terminal and retry recovery before goal`; real pair/core retry, two faux providers, usage confirmation double, fake retry clock, inspect request user counts. |
| `test_live_loop_and_goal_pause_after_confirmed_quota_failure` | A still-bound session cannot spin through loop/goal timers after exhaustion. | `A-stack` | Write `integration/inprocess/quota-goal.test.ts` / `bound loop and goal remain paused after exhaustion`; real router/kit, fake usage + all loop/wake timers advanced several periods, no extra agent start. RPC is incidental. |
| `test_goal_and_loop_do_not_duplicate_router_dispatch_wait` | Park/refuse admission suppresses kit dispatch and premature explicit resume (`wait`, `fail`). | `A-stack` | Write `integration/inprocess/quota-admission.test.ts` / `router admission owns parked and refused work`; real subagents/router/kit factories, fake usage/reset clock, one actual Agent call, exact paused reasons and two parked-resume refusals. |

- File: `scenarios/integration/test_session_kit_titles_rules.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_rule_injected_once_on_matching_read` | Rule attaches once to matching successful reads, never to unmatched paths. | `A:session-kit` | DONE: `packages/session-kit/test/scenarios/rules.test.ts` / `matching rule injects once after unmatched read`; temp rule/files, real read tool/kit/core, faux three reads, exact persisted rule ID. |
| `test_rule_state_survives_resume` | Reopening a session preserves already-injected rule IDs. | `A:session-kit` | DONE: `packages/session-kit/test/scenarios/rules.test.ts` / `file-backed restore remembers injected rules`; real file-backed session dispose/reopen, fresh factory, second matching read lacks rule. |
| `test_titles_skipped_in_print_mode` | Print sessions never dispatch the preferred title provider or write a name. | `A:session-kit` | DONE: `packages/session-kit/test/scenarios/titles.test.ts` / `print binding skips preferred title model`; print binding, explicit preferred faux model with separate title queue, real file/name entries; mode guard returns before any scheduling. |

- File: `scenarios/integration/test_stats_portable.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_work_producer_needs_no_pi_packages_or_credentials` | Packed standalone exporter/importer needs no Pi tree/auth and preserves privacy/stable UUID. | `C` | Extend `scripts/package_contracts.py::exercise_stats_artifact` with clean producer/viewer homes, repeat export/import, planted private sentinels, month-shard field inspection and stable UUID. Current function proves standalone bytes execute but lacks this whole privacy/idempotency matrix. Use packed `dist/pi-stats-export.mjs`, never rendered dotfiles bytes. |

- File: `scenarios/integration/test_subagents.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_background_spawn_and_fetch` | Background child result returns through the real result tool. | `B:pi-subagents` | Write `forks/pi-subagents/test/session-scenarios.test.ts` / `background child result is fetched through the session`; real factory/runner/child session, faux completion barrier instead of sleep. |
| `test_steer_running_child` | Steering a running child reaches its next request. | `B:pi-subagents` | Write `forks/pi-subagents/test/session-scenarios.test.ts` / `running child receives steer after held tool`; real runner, promise-held child tool, faux next-request inspection. |
| `test_steer_queued_child` | Queued child accepts steering and receives it when admitted. | `B:pi-subagents` | Write `forks/pi-subagents/test/session-scenarios.test.ts` / `queued child receives steer when slot opens`; real max-one scheduler, held first child, release barrier, faux second-child context. Existing scheduler tests are seeds; no process needed. |
| `test_evicted_agent_answers_with_tombstone` | Env-configured TTL eviction retains a useful result tombstone. | `B:pi-subagents` | Extend `forks/pi-subagents/test/evicted-agent-wiring.test.ts` / `evicted agents` with `zero consumed TTL from env is wired through session sweep`; existing `get_subagent_result and steer_subagent say it was evicted, not that it was never there` proves tombstone content. Add env parse -> manager sweep with injected clock, not a two-second wait. |
| `test_notices_wait_for_the_turn_and_coalesce` | Two completions enter one notice after tool batch and before the next request. | `B:pi-subagents` | Write `forks/pi-subagents/test/session-scenarios.test.ts` / `coalesced notice reaches next provider request after turn_end`; real outbox/runner/core, held parent tool, controlled faux children, fake outbox clock, request inspection. `completion-outbox.test.ts` / `busy parent` / `holds everything until the turn ends, then sends it as one message` is narrower existing coverage. |
| `test_early_fetch_suppresses_notice` | Waiting fetch consumes the result before any completion notice can fire. | `B:pi-subagents` | Write `forks/pi-subagents/test/session-scenarios.test.ts` / `waiting fetch suppresses completion notice`; real manager/outbox/result handler + core, held faux completion, advance hold clock and assert no extra request. |
| `test_fuzzy_model_picks_newest_enabled` | Fuzzy opus/sonnet/GPT selection excludes newer disabled models. | `B:pi-subagents` | Write `forks/pi-subagents/test/session-scenarios.test.ts` / `dispatch ranks only enabled fuzzy candidates`; fixture settings/registry with all enabled/disabled IDs from source, real resolver/dispatch, faux provider identities. |
| `test_agent_models_precedence` | Param -> type map -> star map -> file -> parent wins in that order. | `B:pi-subagents` | Write `forks/pi-subagents/test/session-scenarios.test.ts` / `dispatch applies all five model precedence levels`; real config/frontmatter/resolver/child, five tagged faux models, fixture global/project files. |
| `test_subagent_workflow_and_background_agent_are_denied` | Child workflows/background nesting fail with explanations, not silent absence. | `A-stack` | Write `integration/inprocess/nesting.test.ts` / `child refuses promoted workflow and background Agent with reasons`; real subagents/deferred/workflow factories, faux explicit calls through scoped child. Workflow is independently owned; this interaction is not merely a subagents parser test. |
| `test_subagent_workflow_tool_is_denied_with_reason` | Child `SubagentWorkflow` stand-in returns the explicit refusal reason. | `B:pi-subagents` | Write `forks/pi-subagents/test/session-scenarios.test.ts` / `child workflow stand-in refuses with reason`; real runner installs refusal tool, faux explicit call, assert result not generic not-found. |
| `test_turn_cap_ends_with_full_report` | Forced report drops tools even after deferred promotion. | `A-stack` | Write `integration/inprocess/turn-cap.test.ts` / `forced child report cannot regain deferred tools`; real subagents/deferred factories, faux looping calls then tool-free report, assert bounded request/schema sequence. |

- File: `scenarios/live/test_live.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_anthropic_with_only_pi_credentials` | Real native Anthropic OAuth works without Claude's store. | `G` | Retain as `integration/scenarios/live/test_live.py::test_anthropic_with_only_pi_credentials`; explicit opt-in credential source, cost ledger, no default-home discovery. |
| `test_anthropic_through_router_and_subscription_usage` | Real routed Anthropic request and usage endpoint interoperate. | `G` | Retain as `integration/scenarios/live/test_live.py::test_anthropic_through_router_and_subscription_usage`; explicit personal fixture profile, real credentials, shared spend cap. |
| `test_codex_through_router` | Real Codex dispatch through the router works. | `G` | Retain as `integration/scenarios/live/test_live.py::test_codex_through_router`; fixture chain order, real provider, cost cap. |
| `test_background_subagent` | Real provider-backed background child result reaches the parent. | `G` | Retain as `integration/scenarios/live/test_live.py::test_background_subagent`; explicit stack/credential source, shared child-aware spend ledger. |

- File: `scenarios/static/test_config.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_settings_keys_are_known_to_pi` | Owner-rendered top-level settings match the selected Pi schema. | `DOTFILES` | Write dotfiles `scripts/pi-profile-doctor` / `settings keys match selected schema`; explicit installed identity, local check only. Rebuilt `D` validates its own fixture settings against the artifact schema, not the owner's render. |
| `test_no_compaction_overrides_or_kendex` | Personal settings omit retired renderer/ineffective compaction overrides. | `DOTFILES` | `scripts/pi-profile-doctor` / `retired personal settings are absent`; no package invariant. |
| `test_quiet_startup_header` | Personal startup preference is header-only. | `DOTFILES` | `scripts/pi-profile-doctor` / `quiet startup preference is preserved`; no distribution gate. |
| `test_installed_git_pins_match_chezmoi` | Local git checkouts match rendered pins. | `DOTFILES` | `scripts/pi-profile-doctor` / `installed git sources match render`; do not import `harness/pinned.py` into package CI. |
| `test_installed_npm_pins_match_chezmoi` | Local npm manifests/dependencies match exact rendered versions. | `DOTFILES` | `scripts/pi-profile-doctor` / `installed npm sources match render`; owner-local filesystem only. |
| `test_brew_pin_chain_is_consistent` | Brewfile/tap/installed version agree. | `DOTFILES` | `scripts/pi-profile-doctor` / `Brew pin chain agrees`; distribution CI validates its supplied binary identity, never Homebrew state. |
| `test_workflows_keyword_trigger_is_off` | Personal workflow keyword setting stays disabled. | `DOTFILES` | `scripts/pi-profile-doctor` / `workflow keyword preference is off`; behavior with explicit false is in `A-stack`. |
| `test_plan_mode_prefixes_never_approve_a_whole_command` | Personal safe-prefix configuration contains no universal approvals. | `DOTFILES` | `scripts/pi-profile-doctor` / `Plan prefixes contain no blanket approval`; no live shell execution. Fork policy logic has separate in-process tables. |
| `test_plan_mode_trusts_code_and_chezmoi` | Personal trusted directories include the owner's code/dotfiles roots. | `DOTFILES` | `scripts/pi-profile-doctor` / `trusted local roots are configured`; these paths must not appear as gate inputs. |
| `test_subagents_default_model_is_router` | Personal/work profile choices and general-purpose model override agree. | `DOTFILES` | `scripts/pi-profile-doctor` / `profile subagent defaults agree`; no package should fail because an owner chooses another default. |
| `test_mcp_rea_server_is_pinned_and_codemode` | Owner MCP manifest has the exact REA pin/exposure choice. | `DOTFILES` | `scripts/pi-profile-doctor` / `REA server selection is exact`; future explicit release package-set validation is distinct from this personal manifest. |
| `test_rea_skill_is_vendored_at_the_server_version` | Owner skill/docs/warm script match the REA server version. | `DOTFILES` | `scripts/pi-profile-doctor` / `REA local skill and server versions agree`; not a gate for unrelated extensions. |
| `test_enterprise_manifest_shape` | Local secret manifest has valid shape and restrictive permissions. | `DOTFILES` | `scripts/pi-profile-doctor` / `enterprise manifest is valid and private`; inspect shape/permissions only, never values in evidence. |

- File: `scenarios/tui/test_conversation_viewer.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_viewer_wheel_and_click_footer_close` | Fleet keyboard navigation opens viewer; wheel/Alt wheel scroll 3/15 lines; footer click closes. | `B:pi-subagents` | Write `forks/pi-subagents/test/viewer-session.test.ts` / `fleet opens viewer and raw mouse closes its footer`; actual viewer/fleet on core interactive harness + VirtualTerminal, raw SGR input, controlled child; existing `conversation-viewer-mouse.test.ts` / `observer input isolation in Pi's fullscreen renderer` / `keeps real wheel, drag, click, and keyboard input off the main view, then restores focus` is the input-composition seed. |

- File: `scenarios/tui/test_fleet.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_fleet_survives_reload` | Core widget reset/rebind re-registers a running fleet. | `B:pi-subagents` | Write `forks/pi-subagents/test/fleet-session.test.ts` / `running fleet re-registers after core reload`; real factory/core reload + VirtualTerminal, child held on promise, widget registration and viewport assertions. |
| `test_fleet_survives_plan_mode_round_trip` | Plan enter/exit cannot erase the running fleet widget. | `A-stack` | Write `integration/inprocess/fleet-plan.test.ts` / `Plan round trip preserves running fleet`; real subagents/Plan factories/core widgets + VirtualTerminal, held faux child, no seconds-long delay. |
| `test_fleet_row_shows_model_and_activity` | Fleet displays effective model and live thinking duration. | `B:pi-subagents` | Write `forks/pi-subagents/test/fleet-session.test.ts` / `fleet paints model and live thinking activity`; real runner/fleet renderer + VirtualTerminal, faux start barrier, injected clock/tick at three seconds. |

- File: `scenarios/tui/test_fleet_stall.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_silent_child_reads_thinking_then_stalled` | A silent open stream repaints from thinking to stalled at 120 seconds. | `B:pi-subagents` | Write `forks/pi-subagents/test/fleet-session.test.ts` / `silent stream repaints at the stall threshold without input`; real model-call folding + fleet/ticker + VirtualTerminal, held faux stream, fake clock at 119999/120000 ms, flush actual renderer. A pure formatter assertion alone is insufficient; a real two-minute wait proves nothing more. |

- File: `scenarios/tui/test_footer_cache.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_width_matrix` | Cache/footer tiers fit four rows at seven widths for warm and cold-drop histories. | `A:preset` | Write `packages/preset/test/scenarios/footer-cache.test.ts` / `cache marker fits the width and history matrix`; real footer + core interactive renderer/VirtualTerminal; widths 60/80/120/160/200/240/320 x warm-healthy/cold-drop, fixed clock, fake usage RPC/status. |
| `test_states_and_causes` | Seven history shapes produce exact warm/cold and drop causes. | `A:preset` | Write `packages/preset/test/scenarios/footer-cache.test.ts` / `history causes paint the expected cache marker`; warm/cold/drop-warm/drop-cold/idle/model-switch/compaction, real session entries/footer, fixed clock + usage bus. |
| `test_warm_turns_cold_when_the_ttl_passes_while_idle` | Cache expiry alone invalidates/repaints an idle footer once. | `A:preset` | Write `packages/preset/test/scenarios/footer-cache.test.ts` / `idle cache expiry repaints once and disposes`; model TTL 120 seconds, fake clock moves past the 45-second remaining lead plus 50ms repaint margin, real timer/footer/VirtualTerminal, assert no input or extra timers. |
| `test_no_usage_yet_shows_no_hit_segment` | No assistant usage means no hit/marker while other footer rows remain. | `A:preset` | Write `packages/preset/test/scenarios/footer-cache.test.ts` / `empty history has no cache segment`; actual footer/VirtualTerminal with empty session and fake usage/status. |
| `test_resize_transitions_leave_no_stale_rows` | Actual SIGWINCH propagation clears old rows and changes footer tier. | `E` | Retain narrowed as `integration/scenarios/tui/test_footer_resize.py::test_resize_transitions_leave_no_stale_rows`; one real process/private tmux, 120 -> 60 -> 320 -> 120, actual terminal size change, cache-history fixture and immediate usage reply. Assert one stats/status row and no stale screen rows. Native width tests own tier arithmetic; this owns OS -> terminal -> host repaint. No timer scaling. |
| `test_long_cwd_branch_and_session_name` | Long cwd/branch/name truncate only the first footer row (60/120/320). | `A:preset` | Write `packages/preset/test/scenarios/footer-cache.test.ts` / `long cwd branch and name stay on the first row`; explicit long temp cwd, footer-data branch, file-backed name, actual footer/VirtualTerminal and display-cell checks. |
| `test_session_name_shows_when_it_fits` | Short name appears without displacing stats. | `A:preset` | Write `packages/preset/test/scenarios/footer-cache.test.ts` / `short session name fits beside cwd`; real session name/footer, VirtualTerminal at 160 columns. |
| `test_tui_modes_keep_the_footer_intact` | Both fullscreen and regular renderers preserve all footer rows. | `A:preset` | Write `packages/preset/test/scenarios/footer-cache.test.ts` / `both renderer modes preserve footer rows`; `createInteractiveTui` for fullscreen/regular with injected VirtualTerminal, fake quota/status, real history. Actual process startup is already `D`. |

- File: `scenarios/tui/test_latency_probe.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_probe_reports_a_blocked_event_loop` | Probe captures the real TUI and a deliberate 400ms event-loop block. | `MERGE:test_multi_session_responsiveness` | Add premeasurement calibration to `integration/scenarios/bench/test_multisession.py::test_multi_session_responsiveness`; assert blocked sample, exclude calibration from timing windows. This is instrument validation on the quiet runner, not ordinary TUI correctness. |
| `test_probe_sees_keystrokes_and_idle_silence` | Probe sees input-to-paint samples and an otherwise idle terminal. | `MERGE:test_multi_session_responsiveness` | Add sample-count/readiness assertions to `integration/scenarios/bench/test_multisession.py::test_multi_session_responsiveness`; its existing typing/idle cells already supply the data. Do not keep an extra 10-second idle test. |

- File: `scenarios/tui/test_one_line_rows.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_collapsed_rows_are_one_line` | Four built-in tool rows stay collapsed without leaking output at 120x40 and 80x24. | `MERGE:test_every_entry_is_one_line_and_collapsible` | Carry both dimensions and exact summary/entry-rule assertions into `integration/inprocess/transcript.test.ts` / `all real stack entries settle into one expandable row`; no smaller duplicate four-tool process. |
| `test_click_toggles_a_row` | Raw click opens/closes a row; drag selection never toggles it. | `B:core` | Write `forks/pi/packages/coding-agent/test/interactive-disclosure.test.ts` / `raw click toggles disclosure but drag does not`; actual ToolExecutionComponent/interactive renderer + VirtualTerminal raw SGR press/move/release, multiline result, no mocked toggle handler. |

- File: `scenarios/tui/test_quota_footer.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_row_shows_both_providers_for_direct_and_router_models` | Both providers' remaining windows paint regardless of three selected model forms. | `A:preset` | Write `packages/preset/test/scenarios/footer-quota.test.ts` / `direct and virtual selections show both providers after startup`; real footer/core binding + VirtualTerminal, usage RPC double becomes ready after startup, fake zero-delay clock, exact floored values and first-request readiness. |
| `test_missing_provider_reads_dashes` | Missing provider windows paint dashes. | `A:preset` | Write `packages/preset/test/scenarios/footer-quota.test.ts` / `missing provider paints dashes`; real footer, usage bus missing Codex snapshot, VirtualTerminal. |
| `test_severity_colours_follow_the_thresholds` | Actual theme styles separate remaining-value threshold classes. | `A:preset` | Write `packages/preset/test/scenarios/footer-quota.test.ts` / `quota thresholds paint distinct ANSI styles`; real theme/rendered ANSI, two source value rounds, fake usage/clock. Capture terminal writes or styled cells, not plain text alone. |
| `test_compact_tier_and_resize` | Resizing flips full/compact quota labels without wrapping or losing values. | `A:preset` | Write `packages/preset/test/scenarios/footer-quota.test.ts` / `quota tier follows injected terminal resize`; 120 -> 60 -> 120 VirtualTerminal, real footer layout, fake usage. OS SIGWINCH itself is owned by `E`. |
| `test_idle_pane_follows_polls_and_keeps_footer_intact` | Poll callbacks alone repaint new values without damaging stats/status. | `A:preset` | Write `packages/preset/test/scenarios/footer-quota.test.ts` / `idle quota poll repaints without disturbing other rows`; actual footer/timers/VirtualTerminal, changed usage RPC reply, advance injected 60000ms clock. |
| `test_stale_provider_is_marked_and_recovers` | Per-provider stale mark retains values and clears on fresh data. | `A:preset` | Write `packages/preset/test/scenarios/footer-quota.test.ts` / `stale provider recovers independently`; usage double stale/fresh sequence, clock, actual themed footer. |
| `test_failed_poll_retains_values_marks_stale_and_recovers` | Timeout/error retain last-good values, mark both stale and recover (two cases). | `A:preset` | Write `packages/preset/test/scenarios/footer-quota.test.ts` / `hung and errored polls retain then recover`; usage double no-reply/unsuccessful reply, fake 12000ms timeout and poll periods, real footer/VirtualTerminal. |
| `test_session_replacement_does_not_duplicate_polling` | Reload/new dispose old footer listeners/timers (two cases). | `A:preset` | Write `packages/preset/test/scenarios/footer-quota.test.ts` / `reload and new leave one quota poller`; real core rebind/session lifecycle and footer disposal, fake clock exact request counts, late old reply ignored. |
| `test_very_narrow_terminal_truncates_without_wrapping` | 25-column quota output is one bounded row and restores on widening. | `A:preset` | Write `packages/preset/test/scenarios/footer-quota.test.ts` / `25-column quota stays one row`; real renderer/VirtualTerminal 120 -> 25 -> 120, fake usage, assert fragment holders. |
| `test_absent_router_hides_the_row` | No usage listener leaves the quota row hidden and stats intact. | `A:preset` | Write `packages/preset/test/scenarios/footer-quota.test.ts` / `absent usage listener leaves quota hidden`; real bus without responder, fake clock across timeout/polls, VirtualTerminal. |
| `test_real_poll_interval_is_sixty_seconds` | Production poll wiring uses 60000ms, not a shortened interval. | `A:preset` | Write `packages/preset/test/scenarios/footer-quota.test.ts` / `production poll cadence is exactly sixty seconds`; use unmodified production defaults with injected clock: no second request at 59999, exactly one at 60000. This tests the production constant and callback wiring without burning a minute. |

- File: `scenarios/tui/test_session_kit_goal_loop.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_loop_stops_itself_at_the_run_cap` | Two-run loop removes itself and never sends a third prompt. | `A:session-kit` | DONE: `packages/session-kit/test/scenarios/loop.test.ts` / `loop stops at its run cap`; real factory/core dispatch, injected 30000ms intervals, exactly two responses, finish notice, no loops/timers/queued follow-ups after extra intervals. |
| `test_loop_stop_ends_ticks` | Explicit stop cancels future ticks. | `A:session-kit` | DONE: `packages/session-kit/test/scenarios/loop.test.ts` / `stop cancels future loop prompts`; real command/dispatch, one tick then stop, injected extra intervals leave response count unchanged and list/timers empty. |
| `test_busy_ticks_are_skipped_not_queued` | Busy ticks spend skipped count, not runs or a deferred prompt queue. | `A:session-kit` | DONE: `packages/session-kit/test/scenarios/loop.test.ts` / `busy loop ticks skip rather than queue`; promise-held real provider request and injected intervals, actual busy state, exact run/skipped counts, empty steering/follow-up queues, stop/release never dispatches skipped work. |
| `test_loop_is_suspended_in_plan_mode` | Plan ticks skip without spending runs; exit allows dispatch. | `A-stack` | Write `integration/inprocess/loop-plan.test.ts` / `Plan suspension skips loop ticks until exit`; real kit/Plan factories, fake clock, list and request assertions. |
| `test_no_tick_while_a_goal_waits_on_a_subagent` | Goal owns the idle child-wait gap; loop resumes only after goal completion. | `A-stack` | Write `integration/inprocess/goal-subagents.test.ts` / `loop cannot steal a goal child-wait gap`; real kit/subagents/outbox, fake intervals, controlled child completion, exact request order. |
| `test_two_panes_in_one_cwd_keep_independent_goals_and_loops` | Two simultaneous sessions in the same cwd cannot share loop/goal state. | `A:session-kit` | DONE: `packages/session-kit/test/scenarios/isolation.test.ts` / `same-cwd sessions isolate goals and loops`; two real harness sessions/factories sharing cwd/model runtime/clock, distinct file-backed managers; A goal continues while B busy, B loop finishes despite A goal, independent status/list/messages and pause. |

- File: `scenarios/tui/test_session_kit_monitor_diff.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_diff_overlay_layout_navigation_and_close` | Diff fits seven widths; file/line/page keys clamp and close restores footer. | `A:session-kit` | Write `packages/session-kit/test/scenarios/diff.test.ts` / `diff overlay width matrix navigates and restores footer`; real component/command/core interactive host + VirtualTerminal, five-file patch fixture with tabs/CJK/long lines, widths 60/80/120/160/200/240/320, fake UI scheduler. |
| `test_diff_overlay_survives_resize` | Overlay relayout preserves title/help/separator through five size transitions. | `A:session-kit` | Write `packages/session-kit/test/scenarios/diff.test.ts` / `diff relayout follows virtual terminal resize`; real overlay host, source width/height sequence, footer restored on Escape. `E` owns OS resize propagation once. |
| `test_diff_lists_every_status_and_shortens_long_paths` | Status/path labels and untracked content survive truncation/navigation. | `A:session-kit` | Write `packages/session-kit/test/scenarios/diff.test.ts` / `diff lists all statuses and shortens paths`; real parser/component, recorded five-file git fixture, VirtualTerminal at 80. |
| `test_diff_bad_ref_notifies_and_opens_nothing` | Bad ref notifies without mounting; subsequent good ref still opens. | `A:session-kit` | Write `packages/session-kit/test/scenarios/diff.test.ts` / `bad ref leaves overlay closed and next open works`; injected git runner returns error then patch; real command/UI host. |
| `test_diff_with_too_many_args_is_usage` | Two refs produce usage instead of mounting an overlay. | `A:session-kit` | Write `packages/session-kit/test/scenarios/diff.test.ts` / `extra diff arguments notify usage without loading git`; command through real session, notify/mount spies, zero git calls. |
| `test_diff_with_no_changes_says_so` | Empty diff notifies instead of mounting empty UI. | `A:session-kit` | Write `packages/session-kit/test/scenarios/diff.test.ts` / `clean tree notifies without overlay`; real command, empty git-result fixture, notify/mount assertions. |
| `test_diff_outside_a_repo_notifies` | Non-repo failure notifies without damaging editor/footer. | `A:session-kit` | Write `packages/session-kit/test/scenarios/diff.test.ts` / `non-repo diff leaves editor and footer intact`; git runner failure, actual interactive host/VirtualTerminal. |
| `test_diff_is_allowed_in_plan_mode` | Plan mode does not intercept the read-only diff slash command. | `A-stack` | Write `integration/inprocess/diff-plan.test.ts` / `Plan permits diff command overlay`; real kit/Plan factories, patch fixture/VirtualTerminal, mount/close and Plan state assertions. |
| `test_diff_is_read_only` | All navigation/unknown keys leave tree and index unchanged. | `A:session-kit` | Write `packages/session-kit/test/scenarios/diff.test.ts` / `diff browsing never mutates tree or index`; real disposable git fixture/loader, actual overlay input sequence, before/after status and sentinel bytes. |
| `test_next_session_sweeps_only_dead_owners` | SIGKILL orphan sweep reaps dead owner's children, never another live owner's. | `D` | Write `integration/scenarios/test_monitor_lifetime.py::test_next_session_sweeps_only_dead_owners`; three headless RPC processes sharing explicit tmp root, real kill/pidfiles/descendants, bounded readiness. tmux contributes nothing to this OS lifetime invariant. |

- File: `scenarios/tui/test_session_kit_stats.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_stats_overlay_layout_keys_and_close` | Both stats tabs, ranges/filters/scroll/close fit seven widths without synthetic usage. | `A:session-kit` | Write `packages/session-kit/test/scenarios/stats-view.test.ts` / `stats width matrix navigates and restores footer`; real loader/component/overlay host + VirtualTerminal, fixed 45-day fixture and clock, all seven widths 60..320 from source. |
| `test_stats_overlay_survives_resize` | Both tabs relayout across five size changes and close cleanly. | `A:session-kit` | Write `packages/session-kit/test/scenarios/stats-view.test.ts` / `stats tabs survive virtual resize`; actual overlay host/VirtualTerminal, source size sequence, fake render scheduler. |
| `test_stats_reopens_from_cache` | First open writes version-2 cache; reopening preserves visible totals. | `A:session-kit` | Write `packages/session-kit/test/scenarios/stats-data.test.ts` / `stats reopening uses versioned cache with unchanged totals`; temp history/cache, real load/command, UI double captures component data then VirtualTerminal renders it. |
| `test_stats_with_no_history_notifies` | Empty history notifies rather than opening an overlay. | `A:session-kit` | Write `packages/session-kit/test/scenarios/stats-data.test.ts` / `empty history notifies without overlay`; real load/command, empty temp tree, notify/mount capture. |
| `test_stats_short_pane_reaches_every_model` | Twenty-row viewport reaches all models and truthful scroll hints. | `A:session-kit` | Write `packages/session-kit/test/scenarios/stats-view.test.ts` / `short viewport reaches final model without false hints`; real component/VirtualTerminal 80x20, same four-model data, actual input sequence. |
| `test_stats_fullscreen_chart_fills_the_pane_and_stays_connected` | 130x38 chart uses height and has no broken box-drawing joins on either tab. | `A:session-kit` | Write `packages/session-kit/test/scenarios/stats-view.test.ts` / `fullscreen chart fills available rows with connected ports`; real chart/component/VirtualTerminal, port oracle ported to TS, fixed date. |
| `test_stats_hourly_ranges_totals_filters_and_close` | All/5h/24h totals and provider filters are exact at seven widths. | `A:session-kit` | Write `packages/session-kit/test/scenarios/stats-view.test.ts` / `hourly ranges paint exact filtered totals at every width`; real load/aggregate/component, fixed UTC instant/timezone, source 78/260/546 totals and provider splits; fake clock. |
| `test_stats_shared_machines_default_combined_freshness_and_plan_mode` | Imported/copied histories dedup correctly, retain distinct IDs and render freshness even in Plan mode. | `A-stack` | Write `integration/inprocess/stats-plan.test.ts` / `combined snapshots remain available in Plan mode`; real kit/Plan, native export/import functions over three temp machine dirs, fixed clock, repeat import, exact 624/338/156 totals, real overlay/VirtualTerminal + resize. Packed standalone execution is only `C`. |
| `test_stats_corrupt_import_retains_totals_and_local_scan_stays_fresh` | Bad remote import retains last-good usage while local history remains fresh. | `A:session-kit` | Write `packages/session-kit/test/scenarios/stats-data.test.ts` / `corrupt import retains remote totals and fresh local usage`; real snapshot import/cache/load, malformed manifest, append local event, assert 676 total/incomplete label via actual component. |
| `test_stats_chart_matches_heatmap_width_and_providers_contrast` | Heatmap/chart share 75% width and provider ANSI colors differ. | `A:session-kit` | Write `packages/session-kit/test/scenarios/stats-view.test.ts` / `chart matches heatmap extent with contrasting providers`; real theme/component/VirtualTerminal at 130x38, widest weekday oracle, fixed week position, capture styled writes/cells. |

- File: `scenarios/tui/test_session_kit_titles.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_tui_auto_title_respects_manual_name` | Unnamed persisted TUI gets one preferred title; manual name always wins (two cases). | `A:session-kit` | Write `packages/session-kit/test/scenarios/titles.test.ts` / `interactive auto-title runs once and never replaces manual name`; real TUI-mode binding/file-backed session, separate faux title model, actual `/name` command/VirtualTerminal, fixed scheduling. No terminal-dependent naming algorithm exists. |

- File: `scenarios/tui/test_todo_heading.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_heading_click_toggles_the_list` | Heading click collapses/expands tasks and hint consistently. | `B:rpiv-todo` | Write `forks/rpiv-todo/todo-widget-session.test.ts` / `heading click hides and restores tasks`; real todo factory/core widget host + VirtualTerminal raw SGR, two real tasks, viewport assertions. |

- File: `scenarios/tui/test_todo_history.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_reloaded_todo_row_uses_its_historical_subject` | Core rebind/resize renders historical todo outcome, never today's subject. | `B:rpiv-todo` | Write `forks/rpiv-todo/todo-history-session.test.ts` / `core reload and resize retain historical row subjects`; real factory/core ToolExecutionComponent cache and resource-loader reload, file-backed session, VirtualTerminal, capture renderer arguments as well as viewport. Existing `todo.history-render.test.ts` is a renderer-unit seed, not the full host receipt. |

- File: `scenarios/tui/test_todo_scroll.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_wheel_scrolls_every_todo` | Batch-created 28 tasks/three completions yield correct heading and full wheel reachability. | `B:rpiv-todo` | Write `forks/rpiv-todo/todo-widget-session.test.ts` / `wheel reaches all batched tasks with correct counts`; real tool/store/widget/core renderer, faux batch calls, raw wheel input in VirtualTerminal, top/bottom hints. |

- File: `scenarios/tui/test_transcript_framing.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_thinking_summary_renders_bold_markdown` | Thinking first-sentence headline renders bold, not literal Markdown. | `B:core` | Write `forks/pi/packages/coding-agent/test/interactive-framing.test.ts` / `thinking headline paints bold without delimiters`; actual assistant component/interactive host + VirtualTerminal, scripted thinking, styled terminal writes. |
| `test_roles_are_framed` | Prose/thinking/entry/user-turn rules have exact placement without blank spill. | `B:core` | Write `forks/pi/packages/coding-agent/test/interactive-framing.test.ts` / `two turns frame roles and separators exactly`; real core session/interactive renderer, faux thinking/text, 120x50 VirtualTerminal. Existing `interactive-mode-turn-rule.test.ts` is a lifecycle seed; retain all source viewport assertions. |

- File: `scenarios/tui/test_transcript_rows.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_every_entry_is_one_line_and_collapsible` | Built-ins, errors, todo, Agent/results/notices all settle to one row and disclose only real detail. | `A-stack` | Write `integration/inprocess/transcript.test.ts` / `all real stack entries settle into one expandable row`; real core/todo/subagents factories and tools, controlled child completions and fake clock, faux kitchen-sink calls, actual interactive host/VirtualTerminal. Include 140x90 and merged 120x40/80x24 matrix. Rendering composition is in-process; `D` alone discovers the installed stack. |
| `test_todo_without_extra_detail_has_no_disclosure` | Actual batch-todo result remains flat under click and Ctrl+O. | `B:rpiv-todo` | Write `forks/rpiv-todo/todo-host-disclosure.test.ts` / `batch result with no extra detail stays flat in core`; real factory/result + core disclosure probe/VirtualTerminal, faux four-create batch, click/Ctrl+O. Core generic no-detail rows already have their unit matrices. |
| `test_running_row_toggles_before_it_settles` | Live streamed tool row toggles before settlement and remains correct after it. | `B:core` | Write `forks/pi/packages/coding-agent/test/interactive-disclosure.test.ts` / `running row toggles before held tool settles`; promise-held real tool with incremental output, raw SGR/VirtualTerminal, release and assert final row. No six-second sleep. |
| `test_plan_mode_rows_are_one_line_and_collapsible` | Plan question/completion/proposed-plan rows collapse/toggle; Escape preserves ready plan. | `B:pi-plan-mode` | Write `forks/pi-plan-mode/test/transcript-session.test.ts` / `real host collapses Plan tools and proposed plan`; real factory/core interactive harness, faux Plan calls, actual selector keys and Escape via VirtualTerminal, `/plan show`, click each row. |

- File: `scenarios/tui/test_virtual_model_row.py`

| Test | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `test_row_follows_the_router_to_the_physical_model` | Fleet shows virtual routing until a physical assistant response identifies the effective model. | `B:pi-subagents` | Write `forks/pi-subagents/test/fleet-session.test.ts` / `virtual child row repaints physical model after first response`; real subagents/core virtual-model registration, faux virtual factory (source uses `vroute`, not the subscription router), held stream/tool barriers, fake tick clock + VirtualTerminal. It is not a router policy test. |

- Router `packages/subscription-router/e2e/run.sh` cases, each replaces one shell branch. `all` is iteration/exit aggregation, not a fourteenth behavior. `balanced-rpc.mjs`'s expected physical-provider arrays are the assertions, not a requirement to keep RPC. Import the real router factory, not a mock route function.

| Case | Invariant | Dest | Replacement / doubles |
| --- | --- | --- | --- |
| `terminal` | Confirmed terminal quota error continues once on B after A's tool turn. | `A:subscription-router` | DONE: `packages/subscription-router/test/scenarios/recovery.test.ts` / `terminal quota error recovers to B`; real factory/core settle hook, faux A tool/error + B answer, fresh confirmation, exact request roles, block expiry on injected clock; Vitest + Bun. |
| `retry` | Retryable 429 emits retry and routes the retried continuation to B. | `A:subscription-router` | DONE: `packages/subscription-router/test/scenarios/recovery.test.ts` / `retry quota error recovers to B`; real factory/usage fixture, core retry event with zero-delay retry settings, B answer and exact request roles; Vitest + Bun. |
| `unconfirmed` | Unconfirmed quota-looking error never rotates to B. | `A:subscription-router` | DONE: `packages/subscription-router/test/scenarios/recovery.test.ts` / `unconfirmed quota error does not recover`; fresh usage says unblocked, error stands, no recovery/loop/block, B queue untouched; Vitest + Bun. |
| `wait` | Exhausted background dispatch parks rather than starts/refuses. | `A-stack` | Write `integration/inprocess/router-admission.test.ts` / `wait policy parks exhausted child`; real router/subagents factories, two blocked faux models, reset at clock +1h, child runner records zero starts. |
| `fail` | Exhausted dispatch refuses immediately without queuing. | `A-stack` | Write `integration/inprocess/router-admission.test.ts` / `fail policy refuses exhausted child`; same real factories/usage/reset clock, no queued job or child request. |
| `capped` | Reset beyond max-wait cap refuses rather than parking. | `A-stack` | Write `integration/inprocess/router-admission.test.ts` / `max wait cap refuses distant reset`; real factories, 30-minute cap/one-hour reset, fake clock. |
| `no-router` | Missing optional router admits a physical foreground child normally. | `B:pi-subagents` | Write `forks/pi-subagents/test/session-scenarios.test.ts` / `absent admission RPC admits physical child`; real subagents factory/child, no router listener, deterministic admission-timeout clock and B faux response. Not an enterprise-dotfiles test. |
| `balanced-route` | Best reset-aware headroom among three providers selects C. | `A:subscription-router` | DONE: `packages/subscription-router/test/scenarios/balanced.test.ts` / `balanced route picks C across three providers`; real factory/core virtual routing, source 80/60/20 snapshots, fixed reset/clock, `[C]`, no errors; Vitest + Bun. |
| `balanced-switch` | New prompts stay on A at exactly 20% better; switch to B above it. | `A:subscription-router` | DONE: `packages/subscription-router/test/scenarios/balanced.test.ts` / `balanced prompt hysteresis is strictly above twenty percent`; three prompts, source usage sequence, physical arrays `[A]`, `[A]`, `[B]`, no errors; Vitest + Bun. |
| `balanced-sticky` | Eligible continuation stays on C despite newly better A. | `A:subscription-router` | DONE: `packages/subscription-router/test/scenarios/balanced.test.ts` / `balanced continuation stays sticky on C`; real quota-changing tool, source snapshots, physical sequence `[C,C]`, no errors; Vitest + Bun. |
| `balanced-blocked` | Confirmed exhaustion breaks continuation stickiness and selects A. | `A:subscription-router` | DONE: `packages/subscription-router/test/scenarios/balanced.test.ts` / `blocked continuation leaves C for A`; real quota-changing tool sets C 100 used, actual route callback, `[C,A]`, no errors; Vitest + Bun. |
| `balanced-fallback` | Fresh measured B beats stale/unmeasured chain entries. | `A:subscription-router` | DONE: `packages/subscription-router/test/scenarios/balanced.test.ts` / `fresh measured B beats stale fallback`; stale A/missing C, real factory/request, `[B]`, no errors; Vitest + Bun. |
| `balanced-unmeasured` | After measured B exhausts, stale/unmeasured fallback is still eligible. | `A:subscription-router` | DONE: `packages/subscription-router/test/scenarios/balanced.test.ts` / `unmeasured fallback remains usable after B exhausts`; source quota-changing tool, `[B,A]`, fixed usage/reset clock, no invented free quota/errors; Vitest + Bun. |

- Harness units: 93 functions under `pi-harness-e2e/tests/`, grouped below. Keep Python tests of surviving Python infrastructure; do not translate infrastructure into TS merely to change runners. Retire tests of removed implementations, not tests of the same production invariant. New explicit-package-set/installer/blocked-egress helpers need their own tests in `integration/tests/`.

| File | Functions | Disposition |
| --- | ---: | --- |
| `tests/test_anthropic_redirect_readiness.py` | 5 | Keep/rewrite four auth-readiness/count/nonce/error tests for the runtime adapter; delete `test_fast_timer_preload_marks_a_real_node_launch`. No timer preload remains. A readiness mark alone is not network isolation: require an effective loopback redirect/egress refusal before fake auth can dispatch. |
| `tests/test_harness_lib.py` | 23 | `test_faux_extension_loads_in_pi` (launched the live `pi` from the unit gate) deleted from `integration/tests`, as `pi-harness-e2e` already did. Remove/move to doctor the first eleven schema/pin/Brew parser tests through `test_brew_pin_chain_parsers`; remove `test_local_overrides_default_to_code_dir`, `test_local_npm_packages_swap_only_the_named_package`, `test_local_npm_packages_require_the_checkout` with `HARNESS_LOCAL`. Keep nine: SGR encoder, ANSI stripper, explicit fixture merge, golden policy, baseline arithmetic, two transcript oracles, stale tmux cleanup, computer-use offline exclusion rewritten against an explicit package set. Do not keep live-path schema discovery just because the parser is cheap. |
| `tests/test_harness_phase2.py` | 8 | Keep session-fixture chain/partial-turn validation, per-metric median/rejection and live cost/opt-in safety. Rewrite two credential-link tests to require an explicit supplied path, never default-home credentials. Four are `F`/fixture infrastructure, four protect opt-in `G`. |
| `tests/test_isolation.py` | 13 | Keep worker IDs, ports, private writable state, serial-tier refusal, prefixture bench admission, exact process tags, load/inspection/limit guards. Rewrite fixture construction to explicit package-set input. No chezmoi template or live package resolution remains. |
| `tests/test_latency.py` | 10 | Keep percentile/reducers/torn-line parsing, probe args, platform metadata/warning policy and paced fleet construction. Rewrite `make_sandboxes` fixture to the declared installed tree; retain shared-vs-isolated agent-dir assertions. |
| `tests/test_pinned.py` | 6 | Retire all six with `harness/pinned.py`: installed checkout selection, chezmoi pin fallback, npm source-tag cloning and overrides disappear. If `D` caches explicit artifacts, test its keyed immutable cache locking there; do not port this source-selection policy. |
| `tests/test_power.py` | 4 | Keep scope/process-owned sleep prevention, non-macOS no-op and stuck-helper reaping for quiet-runner `F`. |
| `tests/test_quota.py` | 6 | DONE for the wrapper: `test_footer_typescript_unit_suite` deleted from `integration/tests` (it read the chezmoi source; `packages/preset/test/footer-quota.test.mjs` runs in `check-ts`). Retire Python wrapper launching dotfiles TS tests, timer-scaling env test and quota-specific fixture/parser tests after native quota port. Move usage envelope/unknown-provider/missing-provider inputs into `packages/preset/test/scenarios/footer-quota.test.ts`; retire screen parsers not used by the one structural `E` resize smoke. |
| `tests/test_sandbox_binaries.py` | 2 | Retire live-helper copy/fallback tests; no live `~/.pi/agent/bin` cache is available. New installer tests validate explicit binary/resource fixture paths and independent writable copies where required. |
| `tests/test_sandbox_catalogue.py` | 2 | Retire copying the live model catalogue. `D` uses declared faux model metadata or the selected artifact's bundled catalogue; add new explicit-fixture isolation tests if copying is needed. |
| `tests/test_sandbox_titles.py` | 1 | Keep offline auto-title safety override preserving other module config, now applied to explicit fixture settings. Test that only dedicated title tests can enable a faux title model. |
| `tests/test_session_kit.py` | 6 | Retire all six `kit_args` installed-pin/local-override/pre-pin fallback tests with `harness/session_kit.py` discovery. Move useful history builders to native stats fixtures; package-set validation replaces discovery. |
| `tests/test_stats.py` | 6 | Move history arithmetic/identity/privacy fixture assertions to `packages/session-kit/test/scenarios/stats-data.test.ts`; move artifact-only invocation/env/protocol/missing-artifact checks to `scripts` contract unit tests for `C`. No Python stats fixture helper is needed by the surviving `D/E/F` tests beyond a small print-output history fixture. |
| `tests/test_tmux_lifecycle.py` | 1 | Keep private-server cleanup on launch/first-frame failure for `E/F` and TUI startup in `D`. Use a fake pane in units, no real tmux launch. |

- Source seams, not a new framework:

| Owner / source | Small change required by the rows |
| --- | --- |
| `packages/session-kit/src/index.ts`, `src/goal/index.ts`, `src/loop/index.ts` | Preserve default extension entry; expose factory/register dependencies for `now`, timeout/interval creation/cancellation and goal wake scheduling. Loop currently directly calls `setInterval`/`clearInterval` and `unref`; fake handles must not require Node-only timer objects. Goal wake timers must share the same injected clock as loop tests. |
| `packages/session-kit/src/monitor/index.ts`, `manager.ts`, `process.ts`, `coalescer.ts`, `matcher.ts`, `widget.ts`, `pidfiles.ts` | Pass a manager/process/matcher factory and clock through real registrations. Fake child streams exercise real manager/ring/coalescer; matcher/spawn worker mechanics keep existing native tests and `D` cleanup smoke. Inject owner pid/root only for deterministic fixtures; preserve real process-group behavior by default. Existing pidfile dependency ports can be reused rather than duplicated. |
| `packages/session-kit/src/diff/index.ts`, `src/diff/git.ts`, `src/stats/index.ts`, `src/titles/index.ts` | Allow explicit git runner, history/cache root, title completion function/model and scheduling dependencies. Reuse existing component constructors; do not stub the components whose rendering is asserted. `stats/component.ts` already accepts `now`; carry that clock through load/aggregate/import freshness instead of calling `Date.now()` in the command. |
| `packages/preset/extensions/expanded-footer.ts` | Extract an injectable factory retaining default export. Thread clock/timers into the 0ms deferred quota start, quota poller, cache analysis and one-shot cold timer. Inject footer cwd/home/branch/name inputs through normal context/footer-data, not global process edits. Render tests must mount the actual returned footer into core's interactive host, not just call helpers. |
| `packages/preset/lib/footer-quota.ts` | `PollerDeps` already accepts `now`, ID generator and timeout/interval ports. Use them from the footer factory; no rewrite of poll logic. Test production `POLL_INTERVAL_MS=60000`, `REPLY_TIMEOUT_MS=12000`, expiry repaint and disposal with exact fake time. |
| `packages/preset/test/footer-{quota,cache}.test.mjs`, `packages/preset/test/*.test.ts` | Convert `node:test` ownership to the package's Vitest + Bun gate, preserving existing helper coverage. New scenario rows own host composition; helper arithmetic stays helper-only, not rerun via Python. |
| `packages/subscription-router/src/index.ts`, `config.ts`, `usage.ts`, `router.ts`, `recovery.ts`, `exhaustion.ts` | Factory takes explicit config plus a usage/tracker instance and clock; default export retains process-shared state for real children. Tests must not leave `Symbol.for("pi-subscription-router.shared")` poisoned across files or read credentials via usage warmup. Fake usage service implements `peek/get/decisionFor`, including fresh-confirmation semantics, and reset times use the same clock. Existing pure routing/recovery tests remain narrower units. |
| `packages/dev-tools/src/core/process.ts`, `src/index.ts`, group registrations | Add only a runner/SSH-config-path injection where existing helpers cannot already supply it. Native scenario fixtures return actual CLI output shapes to the real parsers. Real git/SSH shims remain local executable fixtures; no toolchain installation in `D`. |
| `forks/pi-subagents/src/agent-runner.ts`, `agent-manager.ts`, `schedule.ts`, `completion-outbox.ts`, `index.ts`, `ui/agent-row.ts`, `ui/agent-widget.ts` | Child sessions already run through `createAgentSession`, not a new Pi process. Reuse runner hooks and expose scoped scheduler/clock/stream dependencies for held children, TTL cleanup, scheduled dispatch and outbox holds. `model-call.ts` already takes explicit `now`; inject the clock/ticker that supplies it and invalidates fleet/row rendering. Do not shorten `STALL_MS=120000`. Ticker must respect `context.probe`, stop at terminal state and repaint final state. |
| `forks/pi-plan-mode/src/plan-mode.ts`, fork test support | Reuse real factory/settings-read port and bind it to the exported core harness. Replace current event-only mock coverage only where a ledger row needs real session ordering; retain narrow parser/unit tests. UI doubles return actual canonical choices. |
| `forks/rpiv-todo` extension factory and existing history/invalidation tests | Compose real factory/store with core interactive binding; retain historical result snapshots through reload. No production renderer clone in the harness. If a test cannot reach a renderer without private-field construction, add the minimal test-host adapter in core, not a second cache implementation. |
| `integration/harness/headless.py`, `sandbox.py`, `paths.py`, `anthropic_mock.py`, `preload.py`, `probe.py` | Explicit binary/package-set/fixture roots; remove owner path constants/chezmoi rendering/pin lookup/`HARNESS_LOCAL`. Bound stdout and stderr concurrently with a real deadline. Auth adapter must operate inside Node/Bun process before transport, prove effective redirection, block unintended egress and forbid Claude/security fallback. `NODE_OPTIONS` marks are not Bun coverage. GC readiness remains `F`-specific, separate from auth/timers. |

- Testing exports justified by these rows:

| Export / helper | Need / limit |
| --- | --- |
| `@earendil-works/pi-coding-agent/testing`: `createHarness`, `createTestUiContext`, message/text/tool-result helpers and types | Actual `AgentSession`/extension runner/bind lifecycle, scripted responses, captured events. Existing `HarnessOptions` has `extensionFactories`, tools/settings/models/sessionManager/modelRuntime/resourceLoader, enough to compose factories, not just one extension. All rows must bind extensions explicitly; creating a session alone does not run startup hooks. |
| Faux re-exports from the same host module identity | Re-export `registerFauxProvider`, `fauxAssistantMessage`, `fauxToolCall` and response/model/registration types from the compatible host entry. Script text, tool calls, errors, usage and promise-controlled responses/delays. `virtual-models.test.ts` proves request/retry/continuation routing in-process. Avoid the older subagents test's split Vite faux registry instance. |
| `VirtualTerminal` via a testing-only entry | Publish the actual xterm-headless test terminal, raw `sendInput`, `resize`, viewport/scrollback/flush. Add styled-write/cell inspection for threshold/bold/palette assertions. Keep xterm as a testing dependency, not a production CLI dependency. |
| `createInteractiveTui` plus a small interactive session binder with injected terminal | Factory already accepts `terminal`; existing `interactive-tui.test.ts` demonstrates real fullscreen/raw mouse dispatch. External packages also need a supported way to bind a real session, widgets/footer/commands/overlays and lifecycle to it. Export that binder rather than demanding private `InteractiveMode.prototype` construction. This is a missing export, not current `createHarness` capability. |
| Clock-aware render flush | Current `VirtualTerminal.waitForRender` waits a real 20ms timeout. Provide a flush that lets the caller advance an injected render scheduler, then drains xterm writes/microtasks; otherwise fake-clock tests hang or secretly wait real time. No universal sleep helper. |
| Explicit filesystem/session fixture | Shipped in nredd/pi#4: `createHarness({ cwd })` takes a caller-owned cwd that `cleanup()` never removes (two sessions can share one cwd), and `sessionManager` accepts `SessionManager.create`/`open` for restore rows. Remaining work is per-package fixture helpers for temp git repos and dispose/reopen, not a core API. Never resolve the live agent root. |
| Mode binding | No export needed: `session.bindExtensions({ mode, uiContext })` binds `print`, `json`, `rpc` or `tui` with a `createTestUiContext()` double, then commands dispatch and settle through the real session. CLI parsing/stdout/protocol/exit remain `D`. |

- Capability receipts: `forks/pi/packages/coding-agent/test/suite/harness.ts` constructs real `Agent`, `AgentSession`, `SettingsManager`, `AuthStorage`, model runtime and resource loader, capturing events and accepting multiple inline factories. `extension-startup-error.test.ts` already tests later fatal handlers, reload latching and held sends. `virtual-models.test.ts` already routes per request/retry and compacts against physical model limits. `agent-session-compaction.test.ts` seeds actual sessions/summaries. None exercises CLI install/discovery/trust/OS exit or auth transport.
- Terminal receipts: `forks/pi/packages/tui/test/virtual-terminal.ts` parses actual emitted ANSI with xterm, injects raw input and invokes resize handlers. `forks/pi/packages/coding-agent/test/interactive-tui.test.ts` injects it through `createInteractiveTui`; `footer-width.test.ts`, `output-pad.test.ts` and the interactive mode tests establish native renderer ownership. A footer/overlay width matrix is not a tmux entitlement.
- Subagent receipts: `forks/pi-subagents/src/agent-runner.ts` calls `createAgentSession` inside `runInChildSessionContext`. Its `test/agent-runner-e2e.test.ts` already constructs real child sessions and observes active tools without a CLI. Manager/runner/scheduler/outbox suites exist. Expand their host sequences where rows say `write`; do not label helper-only coverage as complete.
- `forks/pi-claude-auth/src/{index,transforms,signing}.test.ts` own request-transform/signing permutations; the retained `D` matrix tests real native auth transport and hook assembly, not those algorithms again. `forks/pi-computer-use` has no dedicated scenario function in this inventory; its helper/TCC/live desktop suites stay fork-owned and opt-in, never introduced into the ordinary assembled sandbox.

- Port order. Each group deletes the named source rows only after its replacements pass Vitest and `bun test` (or the owning fork/artifact gate). `File` groups above disambiguate repeated test names.

| Order / owner | Port / rows deleted |
| --- | --- |
| 1. Core testing entry | Session harness exported and proven from packed bytes in nredd/pi#4 (`v1.3.0-nredd.4`); terminal/interactive adapters follow in a second core PR before the 41 interactive rows. Port `test_compaction_triggers_one_token_past_the_threshold`, core framing/disclosure rows `test_click_toggles_a_row`, `test_running_row_toggles_before_it_settles`, `test_thinking_summary_renders_bold_markdown`, `test_roles_are_framed`. No change to installed pins in this documentation task. |
| 2. `dev-tools` | DONE. Port all seven `integration/test_dev_tools.py` rows (four native scenarios, three existing duplicates dropped). Keep only fact/time comparison in `F`; move generic deferred discovery to the one `D` golden. |
| 3. `session-kit` | Port all 17 `integration/test_session_kit_goal.py` rows, allocating its seven cross-extension rows to `A-stack`; all title/rule/child-identity rows; monitor logic/annotations/child-scoping rows, reserving the one cleanup and one print-output survivor. Port all six goal/loop TUI rows, nine diff rows excluding orphan sweep, all ten stats rows and the two-case title row. Cross-extension rows land in `integration/inprocess/` in the same port series, not an excuse to defer deletion. |
| 4. `subscription-router` | Port the nine router-only `run.sh` cases to package scenarios and four admission/no-router cases to stack/fork owners. Delete `test_router_e2e_all` and shell/RPC driver after all 13 receipts pass. Port all four `integration/test_session_kit_quota.py` rows into the real factory stack. |
| 5. `preset` | Port all three headless quota rows, all eleven quota TUI rows and seven cache TUI rows excluding real SIGWINCH. Extend packed standalone stats contract and delete `test_work_producer_needs_no_pi_packages_or_credentials`. Retire Python quota wrapper/preload fixtures only after native factory lifecycle tests pass. |
| 6. Forks and stack | Port the six specialist/reviewer rows, both worktree rows, all eleven subagents rows, four Plan confirmation/gate rows, four policy rows and eight Plan/todo rows (one merged); four fleet/viewer/stall rows plus Plan/fleet round-trip, three todo widget/history rows, no-detail todo, Plan transcript, virtual-model row, workflow-trigger and composed transcript. `test_collapsed_rows_are_one_line` merges into the composed transcript test. Preserve exact file/row receipt mapping above rather than counting this prose as coverage. |
| 7. `integration` boundary rebuild | Retain the eight `D` rows, one `E`, seven `F`, four `G`; absorb the twelve `MERGE` rows assigned to these survivors and add the new fatal-startup matrix. Install declared sources, never render chezmoi. Validate Node/Bun runtime adapter before auth runs; if unavailable, report blocked rather than sending fake credentials remotely. Keep bench ceilings/baselines; rebaseline once on the quiet CI runner with reviewed evidence. |
| 8. Dotfiles | Move all 13 static rows to `pi-profile doctor`; compare owner resources against selected packaged resources where local drift matters. Retire `pinned.py`, render comparison, live kit discovery and their obsolete units. No doctor result gates a package PR. Archive the old e2e repo only after the rebuilt `integration/` gate and every native receipt is green in CI. |
