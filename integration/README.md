# pi-harness-e2e

End-to-end verification for my pi setup: the core fork (`nredd/pi`), the extension forks
(`pi-plan-mode`, `pi-subagents`, `pi-subscription-router`, `rpiv-todo`), and the chezmoi
config that wires them together. Per-repo tests can't see the integration, and chezmoi
shouldn't carry node/tmux test code, so it lives here.

`make verify` is REQUIRED before any fork tag, tap bump, or chezmoi pin bump.

Current fork-upgrade follow-up and transcript classification evidence: [here](docs/fork-upgrade-followup.md).

Accepted `ms_input_p95_n4` exception for the coordinated Plan/todo/subagents release (full gate NOT green): [here](docs/coordinated-release-exception.md).

The offline `probes/anthropic-block-types.mjs` checks wire-to-normalized block types against built pi-ai packages without credentials or network.

Targets:
- `make test` delegates its probe step to the root `make check-probes` (lifecycle conformance for both process runners plus the capture probe test)
- `make verify-fast` -- format, lint, type, unit tests, then static + integration scenarios (under 2 min)
- `make verify` -- fast + real-tmux TUI + benchmarks. Includes the `slow` marker (see below)
- `make verify-live` -- opt-in real providers, cost-capped
- `make goldens` / `make baselines` -- re-record goldens / bench baselines

Tiers (pytest markers match the dirs):
- `static` -- config and pins, no pi process
- `integration` -- headless pi, faux providers
- `tui` -- interactive pi in tmux. `slow` marks real-time waits of minutes: `test_fleet_stall.py` waits out pi-subagents' hard-coded 2 min `STALL_MS` (no setting shortens it). Still in `make verify`; `-m "tui and not slow"` skips it while iterating
- `bench` -- median of 5 vs `baselines/bench.<system>.json` (`darwin` = the Mac, `linux` = the WSL2 work laptop), fails past +20%. Baselines are per OS and per machine; re-record with `make baselines` after a hardware change
- `live` -- real providers, skipped unless `HARNESS_LIVE=1`

Bench methods:
- macOS runs hold process-scoped `caffeinate -disu -w <pytest-pid>` assertions so detached tmux panes cannot measure maintenance sleep/dark wake as latency. Assertions release at teardown or runner exit; Linux is unchanged. `--log-cli-level=INFO` reports measured baseline metrics. Controlled kit module probes and red -> green evidence are [here](docs/session-kit-performance.md)
- Startup / TTFT -- launch to first footer frame (tmux), process start to first `message_update` (headless)
- Render -- `probes/render.ts` is loaded with `-e`; `/harness-probe N` grabs the TUI via a throwaway widget factory, then times N forced full frames (`invalidate()` + `renderNow(true)`, terminal write included), then N steady frames (`renderNow()`, no invalidate: what a keystroke or spinner tick pays), and reads `heapUsed` after a GC (`NODE_OPTIONS=--expose-gc`). In-process timing, so tmux polling jitter stays out of it
- 2k transcript -- `harness/sessions.py` writes a 2000-message session (500 turns of prompt, `bash` call, result, markdown reply), resumed with `--session`. `render_2k_frame_ms`, `render_2k_heap_mb`, plus the ceiling `render_2k_steady_over_full` <= 0.25 (same on every OS, no baseline): settled rows must answer from their caches. Core `1.0.0-nredd.5` measured 0.674, `nredd.6` ~0.06
- 50k-line bash -- `seq 1 50000` through the `bash` tool. `bash_50k_settle_s` (submit to settled), `bash_50k_expanded_frame_ms` (row expanded)
- Fan-out -- 8 foreground `Agent` calls in one turn, faux children answering after 2 s. `fanout_8_wall_s` is first `tool_execution_start` to `agent_settled`, and must beat the serial sum
- Compaction -- not a timing: resumes a generated history with one prompt and pins the faux `contextWindow` either side of core's `contextTokens > contextWindow - reserveTokens`. At the threshold nothing happens, one token past it compacts

Multi-session latency (`scenarios/bench/test_multisession.py`, `slow`; details and findings in `docs/tui-latency.md`):
- `probes/latency.ts` (`-e`, also usable in real sessions via `PI_LATENCY_PROBE=<file>`) reports event-loop lag, stalls, terminal output bytes/s, write blocking, input-to-paint and agent-dir fs latency. `harness/fleet_load.py` runs N panes sharing one agent dir, each resuming a 2k transcript and streaming a paced reply (`tokensPerSecond` / `tokenSize` in the faux script)
- Gates: `ms_input_p95_n4` and `ms_loop_lag_p99_n4` against the per-OS baseline; N=8 vs N=1 ratios and idle bytes/s against fixed ceilings, so they hold on macOS and WSL2 alike. Baselines carry `_meta` (`wsl`, `cpus`); a `wsl` mismatch warns
- Ghostty and Windows Terminal cannot be driven from here: run the probe live, see `docs/tui-latency.md`

Live (`make verify-live`, opt-in only):
- A minimal auth-only Anthropic request (the `auth.json` OAuth entry alone, no Claude Code store), `router/default` on Anthropic + `subscription_usage`, `router/default` on Codex (Codex entry moved to the head of the sandbox chain), and a background subagent
- No faux provider. The real `~/.pi/agent/auth.json` is SYMLINKED in (nothing under `~/.claude` is read or linked; Anthropic runs on pi's native OAuth), never copied, so a token refresh writes through to the real file. Its lock file lands next to the sandbox link, so don't run it while another pi is mid-refresh
- Every run sums `usage.cost.total` (JSON events, or session files when children spent more) into one ledger; the tier fails past $0.50. Thinking `off`, one-line prompts

Quota footer (`scenarios/tui/test_quota_footer.py`, `scenarios/integration/test_quota_footer_headless.py`):
- No credentials, no network. `providers/usage_fixture.ts` (`-e`) answers `router:rpc:usage` from a JSON state file re-read on every request (`ok` / `hang` / `error`, any snapshot status), logs each request to JSONL, and sets an extension status so the status line is checked intact. The real router package is dropped from the sandbox (`install_usage_fixture`), or it would answer too
- The fixture becomes ready after startup dispatch; the first quota request must wait for readiness, rather than racing package `session_start` handlers
- Time: no pi build has a fake clock, so `providers/fast_timers.mjs` (`NODE_OPTIONS --import`, `HARNESS_TIMER_MAP`) rewrites exactly the footer's `60000` and `12000` ms timers to 1.5 s and 0.8 s. `test_real_poll_interval_is_sixty_seconds` runs unscaled (`slow`)
- Covers values, `--`, severity colours (real ANSI), compact tier, 25-column truncation, idle polling, stale, hung/errored poll retention and recovery, `/reload` + `/new` polling rate, absent router, and no polling in headless runs. The unit tier also runs the dotfiles' actual TS helper and fake-clock lifecycle suite via Node; arithmetic (floor, clamp, thresholds) is not mirrored in Python
- Non-TUI checks cover JSON and plain-text print runs, plus RPC initialization with a tool-free `get_state` query and EOF. None issues the usage RPC

Stats (`scenarios/tui/test_session_kit_stats.py`, `scenarios/integration/test_stats_portable.py`):
- Real tmux at 60/80/120/160/200/240/320 columns: both tabs, All/5h/24h charts, provider filters, scroll, resize, Escape/q, footer restoration and Plan mode. UTC-relative hourly fixtures have exact totals below compact-number thresholds; ignored faux/router/tool-result/future calls cannot inflate them
- Shared-machine fixtures run the actual chezmoi-rendered `~/.local/lib/pi-stats-export.mjs`, not a Python snapshot-schema clone. Three independently enrolled installs copy events; only distinct remote entry IDs add to the default combined totals, even with identical timestamps/models/counters. Repeated imports, coverage/last-sync labels, local-only/never-synced labels, corrupt import retention and fresh local scanning are asserted in the ordinary kit overlay
- The work-producer scenario copies only the standalone bundle to an empty home and uses absolute Node with no inherited Node loaders, private packages or credentials. Exports must contain month shards and omit planted private text/names/paths; repeated export keeps the UUID. The rendered artifact is required, never skipped or replaced with kit source
- Router passthrough runs `e2e/run.sh all` from the selected router checkout, including balanced multi-provider/prompt/continuation/fallback scenarios as added by the router. No harness-side routing algorithm or narrower case list

Anthropic auth (`scenarios/integration/test_claude_auth.py`):
- The real native Anthropic provider and OAuth refresh run against `harness/anthropic_mock.py` with FAKE tokens. `providers/redirect_anthropic.mjs` (`NODE_OPTIONS --import`) points `fetch` for `api.anthropic.com`, `platform.claude.com`, `claude.ai` and `console.anthropic.com` at it, so nothing real is sent and every header, body and refresh grant is recorded. It uses an accessor on `globalThis.fetch` because pi installs undici's fetch at startup
- `claude` and `security` are also recording PATH shims; any recorded call fails the test
- Covers: no Claude Code store, native refresh persisted, refresh failure, unrelated credentials, logout/re-login, custom agent dir, `router/default` routed requests
- Needs the headers-only `pi-claude-auth` fork. On installed 0.1.3 the header, credential, refresh, logout and router tests fail on purpose; until the fork is pinned run it with `HARNESS_LOCAL=pi-claude-auth`
- The router test skips when `pi-subscription-router` is not a configured package (work profile). The preload also blocks and records node `child_process` launches of `claude` and `security` (absolute paths included); other subprocesses run normally. API-key and custom `anthropic-messages` providers are checked for no billing block

How it works:
- Each test gets a sandbox `$HOME` whose `~/.pi` is the chezmoi *target* state, rendered with `chezmoi cat`. So it checks the config as committed, not what drifted onto disk
- Installed extension code is symlinked from `~/.pi/agent/{npm,git}`. `auth.json` is never copied; a placeholder one makes configured models resolve
- Public model metadata and cached `fd`/`rg` helpers are copied into offline sandboxes, preserving executable permissions without sharing writable live files. Missing caches retain Pi's normal PATH fallback; unrelated files under `bin/` are not copied
- `providers/faux.ts` registers scripted faux providers (`HARNESS_SCRIPT` JSON), so no scenario talks to a real model. Subagent scenarios give each child its own faux provider, so which one answered proves which model a spawn resolved to
- `harness/session_kit.py` selects the kit from sandbox package settings: installed gates use the configured pin with no duplicate `-e`; `HARNESS_LOCAL=pi-session-kit` replaces the sandbox package source while preserving filters. Only pre-pin sandboxes without a kit package use `-e ~/code/pi-session-kit/src/index.ts`. Quota fixtures disable discovery to control hook order and explicitly load the same selected pin
- `build_sandbox` disables `pi-session-kit.json` auto-titles by default, preserving other module settings (and creating the cfg when absent), so generic faux TUI runs cannot dispatch a title request to the default real provider. Explicit title scenarios enable titles with a faux model
- pi-subagents v0.22 contract: `test_notices_wait_for_the_turn_and_coalesce` expects one coalesced notice headed `N background tasks finished.` (was `N agent(s) finished`) with every child result, delivered at the `turn_end` after the parent's tool batch (never mid-batch) and before its next model call, proven by a context-echoing faux reply (`echoLast`) whose request carries both results, so no extra turn is needed. `test_conversation_viewer.py` targets the fullscreen observer: no backdrop margin, footer `↑↓ scroll · PgUp/PgDn or Shift+↑↓ · Esc close`, wheel/Alt+wheel scroll, and a click on the footer `Esc close` label closes it
- `inprocess/{specialists,reviewer}.test.ts` checks real package-discovered preset agents through pi-subagents' child pipeline; `test_session_kit_titles.py` checks real-TUI auto-titles with a faux preferred title model and preserves manually set names
- `ssh`, `curl`, `gh`, `sudo`, `brew`, `chezmoi`, `npm` and friends are shimmed on `PATH`, so a policy regression in a "must block" row can't do real damage
- TUI scenarios run pi in a private tmux server (`xterm-256color`, fixed size, `TZ=UTC`) and drive it with `send-keys` plus raw SGR mouse reports. Failed launches clean up their private server before raising, even when no pane was returned to the caller
- `scenarios/tui/test_transcript_rows.py` is the catch-all: every entry settles as one row. Rows with hidden detail carry `▸` and toggle on click; no-detail settled tools have a blank gutter and ignore click/`Ctrl+O`. The batch-todo regression prevents expansion that only moves the success checkmark onto a second line. New tools and renderers share this invariant
- Role framing (ruled assistant prose, `▸ Thinking · <first sentence>` with inline Markdown, the user-turn `─` rule) and disclosure clicks (click toggles, drag does not, running rows toggle) are core's own tests since `v1.3.0-nredd.6`: `forks/pi/packages/coding-agent/test/interactive-{framing,disclosure}.test.ts`
- On failure, pane captures (plain + ANSI), pi stderr, sessions, and the faux script land in `artifacts/<test>/`
- Every `mcp.json` server is overridden to `enabled: false` in sandboxes: the configured `rea` server is an `npx -y rea-agents@X.Y.Z` download plus a 207-tool stdio process, and a faux run must neither hit the network nor wait on it. `scenarios/static/test_config.py` checks the committed config instead (exact pin, no `exposure`, vendored skill at the same version); the live connection is a manual `pi mcp list` check (pi README, Pinning and verifying)
- `PI_MEMORY_QMD_UPDATE=off` in every sandbox: otherwise pi-memory pulls a 300 MB qmd embedding model into each fresh `$HOME` and holds the process ~35 s at exit
- Faux steps: `delayMs` is silence before the stream opens; `openMs` sends `start` at once and then goes silent, which is what a thinking model looks like to activity/stall indicators

Knobs:
- `PI_BIN="node ~/code/pi/packages/coding-agent/dist/bundle/cli.js"` -- test a staged core build instead of `pi` on `PATH`
- Scenarios that need a repo's source (e.g. the router e2e) get it from `harness/pinned.py`: the installed `~/.pi/agent/git/**` checkout when it sits on the chezmoi pin, else a clone of the exact pin in `~/.cache/pi-harness-e2e/`. Never `~/code/<name>`, so the code under test is the code the live harness loads
- `HARNESS_LOCAL=pi-subagents,pi-plan-mode` -- swap installed fork checkouts for `~/code/<name>` (or `name=path`). While `pi-claude-auth` is still an `npm:` package, the override rewrites its sandbox `settings.json` entry to the checkout path (the live `~/.pi/agent/npm` tree is never touched); once the fork is pinned as a git package it is an ordinary git override
- `UPDATE_GOLDEN=1`, `UPDATE_BASELINES=1`

Layout:
- `inprocess/` -- real-session stack scenarios under Vitest and pinned Bun, including Plan annotations, child scoping, nesting, turn caps and workflow triggering; inputs and doubles documented in `inprocess/README.md`
- `harness/` -- `quota.py` (usage fixture helpers), sandbox, headless runner, tmux driver, config checks, goldens, bench, session generator, render probe driver, live ledger
- `providers/faux.ts`, `providers/usage_fixture.ts`, `probes/render.ts` -- extensions loaded with `-e`, never installed
- `scenarios/{static,integration,tui,bench,live}/` -- the scenarios, pytest markers match the dirs
- `manifest.json` -- scenario -> requirement/finding it covers
- `golden/`, `baselines/bench.{darwin,linux}.json`

No CI, on purpose: the private repos (`nredd/dotfiles`, `nredd/pi-subscription-router`) would
need a token secret on the runner. `make verify` on this machine is the gate.

Work laptop (WSL2, Linux; full `make verify` works, tools are resolved from `PATH` and the brew prefix, bench uses `baselines/bench.linux.json`):

```sh
chezmoi update                      # pulls the pins, re-renders settings/subagents, runs the pi package hook
brew upgrade nredd/tap/pi-coding-agent && pi --version   # expect 1.3.0
gh repo clone nredd/pi-harness-e2e ~/code/pi-harness-e2e  # private: same GitHub auth that clones the dotfiles
cd ~/code/pi-harness-e2e && make install && make verify
```

- `enterprise.local.json` is read in place: only its permissions and key shape are checked, never values
- `test_subagents_default_model_is_router` expects NO `agentModels["*"]` there, and the router scenarios skip without `~/code/pi-subscription-router`
- Expected skips: the router e2e and anything gated on the personal router. Any FAILED is real; send me `artifacts/`
