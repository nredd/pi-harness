# pi vs Codex CLI vs Claude Code (2026-10-12)

Two read-only research passes, one per upstream, compared against pi (`~/.pi/agent/README.md` + pi docs).

## Method and evidence quality

- Primary: Claude Code `CHANGELOG.md` + releases (v2.1.100 -> v2.1.296), Codex releases (`rust-v0.119` -> `v0.162.1`), vendor docs, GitHub issues
- Search backend was DuckDuckGo only. Reddit, X, YouTube, HN could NOT be read directly
- `[SEO]` = AI-written or aggregator source, low confidence
- Issue numbers below spot-checked via `gh api` (all 10 matched titles)
- Release dates between pulled tags are interpolated

## Claude Code inventory

- Auto mode: classifier-gated approvals, announced 2026-03-25, default for Pro/Max/Team 2026-08-14. `hard_deny`, `classifyAllShell`. https://anthropic.com/engineering/claude-code-auto-mode
- Agent view, `claude agents`, `--bg`, `/goal` (v2.1.139, 05-11); cross-session `SendMessage`/`ListAgents` (v2.1.224)
- Dynamic Workflows (`Workflow` tool, JS fan-out). https://code.claude.com/docs/en/workflows
- Mods (v2.1.287, 10-01): in-process TS function hooks, on by default
- Hooks: `PreCompact` can block, `onFailure: "block"`, `Pre/PostModelSwitch`
- Plugins/marketplaces, `plugin details` token cost, `/skill-doctor`, `/reload-skills`
- MCP: `alwaysLoad`, tool search auto at >10% context, elicitation
- Cache diagnostics in `/cost` (hit ratio, miss cause, warm/cold; v2.1.251/260), 1h TTL options
- Fullscreen TUI default, `/diff` panel, `/recap`, `/btw`, `/output-style`
- Models/effort: `xhigh`, `ultracode`, `fallbackModel` (3), per-agent `effort`, `/advisor`
- Sandbox credential masking, `Tool(param:value)` permission rules
- AGENTS.md fallback when CLAUDE.md absent (v2.1.277)
- Ultrareview (cloud multi-agent review), `/loop`, Routines, `Monitor` tool, agent teams (experimental)

## Codex inventory

- Auto-review guardian agent (~0.12x, Apr 2026); circuit breaker 3 consecutive / 10 of 50 denials. https://alignment.openai.com/auto-review
- Permission profiles (deny globs, domain allowlist, `requirements.toml`), Windows sandbox
- Hooks GA 2026-05-14, 12 events. https://developers.openai.com/codex/hooks
- `/goal` with token budget (0.128, 04-30), default on since 0.133
- MultiAgentV2, `@` task mentions, `/side`
- MCP tool search default (0.142), parallel read-only MCP (0.134), Code Mode (0.162)
- Remote (server-side) compaction, memories (0.121), `/recap`, `/resume` search, `/archive`
- Fullscreen TUI default (0.157), vim mode, `instant_interrupt` (0.159), voice
- Shared daemon/app-server (0.157), `remote-control` (GA 06-25), managed worktrees
- `exec --json`, `--output-schema`, Python + TS SDKs; `codex mcp-server` removed 09-05
- Product changelog: https://developers.openai.com/codex/changelog

## Community sentiment

Claude Code:
- Mar-Apr quality regression, strongest negative. AMD filing `anthropics/claude-code#42796` (read-to-edit ratio 6.6 -> 2.0 over 234k calls)
- 04-23 post-mortem blamed harness-layer changes: effort default high -> medium, caching bug wiping thinking history, a "<=25 words" verbosity cap (~3% quality drop). Fixed by v2.1.116. Details via `[SEO]` secondary
- Auto mode: praised for stopping tangents (HN 49227253); `#97868` classifier "no verdict" halted all Bash while Read/Edit worked
- Dynamic Workflows: 16-agent review burned 592k-743k tokens, ~2/3 nitpicks (`tekkix.com`, `[SEO]`-ish field test)
- `/rewind` misses Bash-made changes (repeated, `[SEO]`); workaround is git
- Mods: enthusiastic, but on-by-default trust concerns
- Ultrareview $5-$20/run after free runs `[SEO]`; tool search "95% savings" `[SEO]`

Codex:
- 0.157 daemon backlash: `#48074`, `#48043`; fullscreen TUI broke screen-scraping tools
- Remote compaction opaque/unrecoverable: `#22107`, `#53323`
- TUI noise, users want opt-outs: `#41622` (recap), `#39903` ("Ran N commands"), `#44561` (whimsy)
- `#39973`: removing `untrusted` approval silently weakens the boundary
- Windows sandbox bug flood (`#51601`, `#51590`, `#51634`); auth 401s `#48237`
- MultiAgentV2 reportedly dropped per-role models (community.openai.com, second-hand)
- `/goal`: positive guides, recurring worry is verification of unattended runs
- "2-3x token efficiency vs Claude Code" repeated, no benchmark

Cross-cutting:
- Users want every output-compression or automation feature to be OPTIONAL
- Harness-layer prompt/effort/cache changes, not weights, caused the worst regression
- Fast breaking removals (Codex `untrusted`, `mcp-server`) cost trust

## Gap table

| Feature | Claude Code | Codex | pi today | Verdict | Effort | Fit |
|---|---|---|---|---|---|---|
| `/goal` loop + budgets | yes | yes | none; todos + `agent_before_settle` | YES | M | `agent_before_settle` `continue`, evidence-gated todos, router park-on-exhaustion |
| File checkpoints / `/rewind` | yes (Bash gap) | no | `/tree`, `/fork` (conversation only) | YES | M | `tool_call` snapshot pre `edit`/`write`, git snapshot around Bash |
| Cache/cost diagnostics | `/cost` miss cause | `/usage` | `cache_warming_decision`, quota footer | YES | S | `expanded-footer.ts` |
| `/review` | `/ultrareview` (cloud) | `/review` | skill + `workflow` | YES | S | template/skill + read-only subagent |
| `/skill-doctor`, pkg cost | yes | no | none | YES | S | scan session JSONL |
| Plan -> fresh session build | no | yes | same-session todo seeding | MAYBE | S-M | `/fork` or new session + todos |
| OTel | rich | rollout tracing | none | MAYBE | M | exporter extension |
| `/side`, `/btw` | yes | yes | `/fork`, `/clone` | MAYBE | S-M | fork, ask, discard |
| Session auto-titles | n/a | yes | rename only | MAYBE | S | router cheap model |
| Worktree tools | `--worktree` | managed | `Agent cwd` | MAYBE | S | `git_worktree_*` in `pi-dev-tools` |
| codemode in `defaultTools` | tool search | Code Mode | built in, not enabled | MAYBE | S | settings flag |
| `pi doctor` | `/doctor` | `codex doctor` | `/bug`, `/session` | MAYBE | S | extension |
| Path-scoped rules | `.claude/rules/` | n/a | none | MAYBE | S | loader |
| Transcript search, `/copy` picker | yes | yes | not documented | MAYBE | M | core fork |
| Vim mode | yes | yes | not documented | MAYBE | M | core fork; unconfirmed absent |
| Background sessions + supervisor | agent view | daemon | subagents only | DEFER | L | RPC/print modes |
| Cross-session messaging | yes | `@task` | none | DEFER | M | tied to above |
| `/loop`, cron, Monitor tool | yes | no | router schedules only | DEFER | M | extension |
| `/diff` panel | yes | no | `git_diff` tool | DEFER | M | `ctx.ui.custom()` |
| Auto-review / classifier | auto mode | guardian | custom Plan Mode | DECLINED BY DESIGN | - | Plan Mode is the answer |
| OS sandbox / permission profiles | yes | yes | containers per docs | DECLINED BY DESIGN | - | |
| Declarative shell hooks | yes | yes | TS extensions (richer) | DECLINED | - | |
| Daemon / app-server | no | yes | RPC/SDK | DECLINED | - | biggest Codex backlash |
| Remote/mobile/cloud | yes | yes | none | DECLINED | - | out of scope |
| Remote compaction | no | yes | local, auditable | DECLINED | - | |
| `/import` | no | yes | AGENTS/CLAUDE.md load | DECLINED | - | |
| Subagents, workflows, MCP, plan mode, routing | parity or behind | behind | ahead | NO | - | see below |

## Ranked recommendations

1. `/goal` plus run budgets (M). Turn and token caps to prevent runaway loops. Both upstreams ship it; most-discussed feature in both communities
2. File checkpoints and `/rewind` (M). Git-based Bash snapshot fixes CC's top complaint instead of copying it
3. Cache/cost diagnostics in footer (S). Answers the regression lesson: harness-layer cache bugs are invisible without telemetry
4. `/review` (S)
5. `/skill-doctor` + per-package context cost (S)
6. Plan approval into fresh session (S-M)
7. OTel exporter (M), only if wanted
8. Polish (S each): `/side`, auto-titles, `git_worktree_*`, try `+codemode`, `pi doctor`, path-scoped rules; transcript search + `/copy` picker (M, core)

Deferred (L/M): background sessions + supervisor, cross-session messaging, `/loop`/cron, Monitor, `/diff` panel.

Declined by design (researched, NOT recommended): auto-review/classifier gating, sandbox/permission profiles. Plan Mode's per-segment bash policy is the intended answer.

## Where pi is already ahead

- Cross-provider quota routing (`pi-subscription-router`); CC has `fallbackModel`, Codex is OpenAI-only
- Subagents survive `/new`, `/resume`, `/fork`, `/reload`; steering, model precedence, quota-parked jobs
- Plan Mode: per-segment bash policy, `ssh` re-validation, GET-only `gh api`, plans -> evidence-gated todos
- Local, auditable compaction with raw entries kept; Codex remote compaction fails opaquely
- `/tree` session branching with summaries
- Typed `pi-dev-tools` with honest `readOnlyHint`
- In-process extension events (`provider_stream_event`, `context`, `agent_before_settle`, `cache_warming_decision`); CC Mods only reached parity-ish 2026-10-01
- MCP exposure tiers + codemode
- `make verify` regression gate; both upstreams shipped user-reported regressions
- Transcript UX (one-line rows, disclosure gutter) regression-tested
- CC adopted the AGENTS.md convention only in v2.1.277

## Unverified or flagged

- Reddit, X, YouTube sentiment: not read
- Codex "2-3x token efficiency" and auto-review stats (~200x fewer stops, ~99% approval): vendor/aggregator claims
- CC auto-mode false-positive/negative rates: scrape garbled, see the Anthropic post
- CC billing split of SDK/`claude -p` credits (announced 05-13, paused): `[SEO]`
- Ultrareview pricing, tool-search "95%": `[SEO]`
- Codex `#46022` mass-delete incident: unverified, auto-review status unknown
- Interpolated release dates
- pi vim mode / transcript search: not found in docs, not confirmed absent
- Some Codex changelog entries are app/iOS, filtered where possible
