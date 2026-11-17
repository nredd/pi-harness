# pi-session-kit

Session-scoped tools for goals, loops, process monitoring, diffs, offline usage statistics,
auto-titles, path rules and a read-only resource dashboard. Each runtime owns its work; no daemon,
cross-pane supervisor or persistent cron is installed. Closing Pi stops active work.

- [Install and configure](#install-and-config)
- [Goals and loops](#goal-and-loop), [monitors](#monitor) and [process recovery limits](#monitor-process-and-matching-limits)
- [Diff](#diff), [stats](#stats), [portable export/import](#offline-stats-and-portable-snapshots)
- [Titles and rules](#titles-and-rules), [child restrictions](#subagents-and-verification)
- [Resource dashboard](#mon-resource-dashboard), [development](#development)

Published as `@nredd/pi-session-kit` under MIT. Versions from `0.4.0` use signed package
tags, npm provenance and release tarballs/checksums/manifests through the monorepo
[release workflow](https://github.com/nredd/pi-harness/blob/main/docs/releases.md); earlier versions were manual publications.

## Monitor process and matching limits

Process and matching limits:
- `../diff/git.ts` awaits the scheduled group `SIGKILL` after timeout or output-cap termination, even if the leader exits and descendants close their pipes. The existing 2s TERM grace and 1s hard-resolve bound remain. Signals never fall back to a potentially reused bare PID.
- `pidfiles.ts` serializes each record behind a PID/token sweep guard, then rereads it before validation. A live guard is never removed, regardless of age; confirmed dead guards are reclaimed by unlinking only their immutable owner filename and removing the empty directory. Empty/unknown guards require manual inspection and are reported as failures, never age-reclaimed. Interrupted cleaners retain persisted recovery identities. Cleanup failures/busy guards are returned in `failed` and reported as startup warnings.
- For a leader that exited before the first sweep, a surviving member must belong to the recorded group and have started in the recorded spawn second, no later than the recorded spawn timestamp. Linux additionally validates the detached session ID against the original leader PID; macOS `ps` exposes an unusable zero session field, so group membership plus start time is the available identity boundary. Later-born-only survivors, changed persisted identities, reused live leaders and failed process queries retain the record and report failure rather than signal or silently discard it. An empty group permits removal. This conservative fallback cannot reclaim every orphan safely.
- `pidfiles.ts` authenticates the leader, snapshots group member PID/start-time/command identities, revalidates the leader, and atomically persists the snapshot before TERM. Cleanup is awaited; the file remains on uncertainty. Escalation and recovery require an exact surviving member identity in the recorded group, so leader death does not skip KILL. Reused identities do not authorize signals. Groups that escape via `setsid`, or change every recorded identity, cannot be safely reclaimed. `ps` has one-second start-time precision and identity checking plus signaling is not atomic on macOS; identical-command same-second PID reuse and check-to-signal races remain platform limitations.
- `matcher.ts` evaluates JavaScript regexes in one killable child process per matching monitor. A worker inside the child keeps its main loop responsive to IPC disconnect, so parent death also exits a child whose regex is spinning. Cleanup kills and reaps the whole process instead of waiting for Bun's slow `Worker.terminate()`. `BUN_BE_BUN=1` lets a compiled Bun host run the child as an interpreter rather than re-enter its bundled application. Each line has a 100ms execution deadline, startup and final drain have 1s deadlines, and queued text plus per-item overhead is capped at 256KiB. Lines already have the splitter's 4096-character cap. Matching preserves order and final-output match markers. Timeout, queue overflow or worker failure disables matching for that monitor and marks pending/future lines matched, conservatively waking on output rather than silently dropping alerts. This can produce false-positive wakes. Child process cleanup is awaited on exit and disposal; disposal interrupts pending matching immediately. Timer deadlines are subject to normal event-loop scheduling, not realtime guarantees. They run on the manager's `Clock` (real unreferenced timers by default), so an injected fake clock decides when a worker is late, not host load.

Regression commands (from the repository root):
```
cd packages/session-kit && npx vitest run tests/diff/git.test.ts tests/monitor/pidfiles.test.ts tests/monitor/manager.test.ts tests/monitor/matcher.test.ts
```
These exercise real TERM-resistant descendant processes, leader exit with closed pipes, orphan escalation, leader exit before any sweep, two concurrent real cleaners with interruption and dead-guard recovery, persisted recovery, changed identities, catastrophic backtracking, final match draining and shutdown during matching. Process fixtures require macOS or Linux.

## Standalone use

The packed tarball is self-contained: Pi host modules (`@earendil-works/pi-*`, `typebox`) are `*` peers supplied by Pi, and no sibling plugin is required. Its only runtime dependency in current source is the exact published `@nredd/pi-resource-sampler@0.2.1` library (no Pi imports), which npm installs from the registry for `/mon`. Verified by installing the tarball alone and running it in exact stock Pi 1.3.0 (`make check-package-contracts`). Optional fork integrations (subagents, Plan mode) are absent in that setup; the exercised behavior does not need them.

Persisted goal state follows the active session branch; restored goals remain paused.

`/mon` opens a read-only, full-pane view of local CPU, memory, load and processes, sampled
every ~2s by the shared `@nredd/pi-resource-sampler` library only while it is open. Details and
limits (macOS native CPU/footprint require Node >=26.1 or Bun, executable names keep 16 bytes,
RSS excludes compressed pages, `f` toggles a labelled footprint column,
and memory labels state their measurement basis) are in
[here](#mon-resource-dashboard). It is not a second `/monitor` process runner.

## Install and config

```sh
pi install npm:@nredd/pi-session-kit
```

Optional `~/.pi/agent/pi-session-kit.json` (respects `PI_CODING_AGENT_DIR`):

```json
{
  "titles": { "enabled": true, "model": "anthropic/claude-haiku-5-5" },
  "rules": { "enabled": true },
  "goal": { "enabled": true },
  "loop": { "enabled": true },
  "monitor": { "enabled": true, "collapseKey": "ctrl+shift+m", "maxWidgetLines": 12 },
  "diff": { "enabled": true },
  "stats": { "enabled": true },
  "mon": { "enabled": true }
}
```

Every module defaults on. Malformed config reports a diagnostic and uses defaults. Config, rules,
title aliases and stats share one call-time agent-directory resolver, preserving the environment override.
SDK hosts can use
`createSessionKit({ config, agentDir, homeDir, monitorRoot })` from `src/index.ts`: explicit `config` avoids
loading the config file, `agentDir` scopes config/rules/title aliases, `homeDir` derives those paths and stats
cache/session defaults when no agent directory is supplied (and is an isolated root for stats: other harnesses' paths, including `XDG_DATA_HOME`, come from it, never `process.env`), and `monitorRoot` isolates
monitor pidfiles and orphan sweeps. Optional `clock` (`now`, cancellable `setTimeout`/`setInterval`)
and `spawnMonitor` seams control scheduling and child lifetime in SDK tests; the real manager,
ring, coalescer, regex worker and host follow-up queue still run. The regex worker's startup,
per-line and drain deadlines use the same `clock`. Controlled stdout callbacks resolve
after matching/ingestion; native pipe events need not await them. Omitted options keep the CLI defaults. No daemon or
persistent cron is installed. Deferred-tool configurations need `goal_update` in `neverDefer`
(without forcing it active). `monitor_*` need no pin and can stay deferred behind `search_tools` (#291);
Plan mode freezes its tool selection at `/plan`, so it reaches `monitor_read` only when that tool was active before `/plan`.

## Goal and loop

- `/goal <objective> [--turns N] [--tokens N]`: keep working toward an explicit objective. Default
  budget: 30 parent turns. Token accounting uses reported usage. `status`, `pause`, `resume` and
  `clear` manage it; the footer chip shows turn and token consumption.
- `goal_update({status: "complete" | "blocked", evidence})`: complete requires nonempty evidence.
  This is a self-report, not an independent verifier; it does not replace tests or todo evidence.
- The settle nudge respects existing continuations, background-agent delivery and Plan permissions.
  Abort, settled provider error, budgets and a Plan-mode excursion pause/stop it. Resume restores a
  goal paused. A background agent stopped while still queued has no completion notice, so it no longer
  holds the goal busy; a stopped agent that started still waits for its notice. Quota recovery is left to the router; a parked dispatch or direct refusal pauses
  goals and loops, cancels goal wake timers, and requires explicit resume. Goal resume is refused
  while a quota-parked dispatch remains. A settled provider failure also pauses rather than spinning.
- `/loop <interval> <prompt> [--max N]`: repeat a prompt in the current conversation, unlike
  `Agent({schedule: ...})`, which launches fresh children. Minimum interval 30s; maximum 50 runs.
  `list` and `stop [id|all]` manage loops. Busy ticks are skipped, never queued. Plan mode and an
  active goal suspend ticks; settled errors pause loops. Loops are not persisted across restarts.

## Monitor

- `monitor_start({argv, name, match?, wake?, todo?, timeout_s?})`: run an argv command with stdin closed,
  no implicit shell. Five active monitors maximum, one-hour default timeout, 7 day (`604800` s) maximum. Explicitly passing a
  shell remains arbitrary command execution; this is not a sandbox.
- `monitor_read({id, since?})`: numbered output since a cursor. Ring buffers retain 2000 lines.
- `monitor_stop({id})`, `/monitor list`, `/monitor stop <id|all>`: stop and inspect owned monitors.
- A run that settles with monitors running shows an info notice naming each one and what wakes the parent (the
  `match` with terminal controls stripped), e.g.
  `Run ended with 2 monitors running, armed: m1 "ci" on /PASS|FAIL/ or exit, m2 "log" on exit`.
- Each monitor emits `session-kit:monitor:started` and, once, `session-kit:monitor:stopped` (exit, timeout, stop or
  session shutdown) on `pi.events` with `{ sessionId, id, name, wake, match?, todos? }`: `wake` is true when every batch
  wakes, `match` is the wake regex source, and `todos` is the deduplicated list of todo ids passed as `todo` to `monitor_start` (one
  positive integer, or up to 20; session-kit does not check they exist). A monitor with no `todo` arms no todo. The todo package reads them to tell what is armed at a settle and
  for which todo; no package imports the other.
- Output batches every two seconds into the bounded ring buffer (with dropped-line reporting). Passive batches neither start turns nor create transcript/model-context entries; call `monitor_read` to fetch them. A regex match, natural exit, timeout or `wake: true` emits one compact visible wake with a cursor after the output the model last saw through a wake or read, not a replay of buffered output. A bounded batch preserves its first and latest dropped matching lines as wake evidence even if later output evicts them from the ring.
- Children run in process groups: SIGTERM, then SIGKILL. Exit cleanup and pidfiles cover orderly quit
  and later recovery after SIGKILL. Sweeps reauthenticate the leader after enumerating members;
  uncertain identities or guards never authorize signaling. Reap checks are bounded to 20 polls
  after escalation; a timeout keeps authenticated recovery on disk rather than claiming cleanup.
  Spawn failures after child creation kill the child; matcher initialization failures also remove
  its pidfile. A spawn completing after session disposal is killed without registration. Files live at
  `$TMPDIR/pi-monitors-<uid>/<sessionId>.<ownerPid>/<monitorId>.json`. Startup checks dead-owner
  records, including a resumed session, and validates process identity before signalling. It never
  sweeps a live owner's monitors. Two panes resuming the same session have separate directories.
  A group whose leader already exited is reaped only when a member started at spawn anchors it: its
  `ps lstart` must read under one second after, or under two before, the recorded spawn (`lstart` is
  a whole-second floor). A member that reads a second or more after the spawn cannot authenticate a
  possibly reused group, so its record is kept, not signalled. Within that window a later-born member
  in a reused group is indistinguishable; the dead leader, matching group and session, and no prior
  members bound that case, they do not exclude it.
- Widget: while any monitor runs, a Todos/subagents-style panel sits above the editor. Heading
  `▾ ● Monitors (2 running · 1 failed · 1 done)`; one row per retained monitor (running monitors
  plus up to ten finished ones) with a bullet by state (green running, yellow matched, red
  failed = non-zero exit, signal or timeout, dim exited/stopped), the name and last line truncated,
  and `elapsed · N lines` flush right. It is display only: the quiet rules above are unchanged, and
  a repaint never adds anything to the transcript or model context. Clicking the heading or
  pressing `monitor.collapseKey` collapses it to the heading plus a `ctrl+shift+m to expand` hint
  (`▸`). `monitor.maxWidgetLines` caps content rows (heading included, default 12, integer >= 4,
  else the default), excluding the one trailing spacer row. It is a constant-height window:
  `↑ N more` / `↓ N more` take a row each, so it never resizes while you scroll with the mouse
  wheel. Pi's tool-output expansion shows every row.
  `collapseKey` takes the same grammar as rpiv-todo's `collapseKey` (trimmed, lowercased; distinct
  `ctrl`/`shift`/`alt`/`super` modifiers plus one printable key or a named key; `"off"` removes the
  binding; anything else falls back to the default). It is bound once per runtime, so a change needs
  `/reload`. The default `ctrl+shift+m` is unused by pi core, Todos (`ctrl+shift+t`), subagents and
  Plan mode (no default key). Like Todos' key it needs a terminal with the kitty keyboard protocol.
  There is no `collapseOnResume`: monitors never survive a resume, so there is nothing to collapse.
- Plan mode admits only `monitor_read`; start and stop are mutating tools. Ordinary tool hooks apply
  to the tool call, but a custom argv tool does not automatically inherit Bash-specific policies.

## Diff

`/diff [ref]` opens a read-only file/patch overlay. Default: staged and working changes against HEAD,
with untracked files listed. `j/k` or arrows scroll, `n/p` select files, `g/G` and PageUp/PageDown
navigate, `q` or Escape closes. Output is capped. Invalid refs and non-repositories produce clear
errors. Print mode emits a stat (pi currently redirects extension stdout to stderr); JSON emits a
non-triggering display message. The overlay is TUI-only and works in Plan mode.

## Stats

`/stats` is Claude Code's `/stats` pane over fresh local sessions plus imported machine snapshots,
split by provider and model. It NEVER performs network I/O. The header shows `viewer last import`,
not producer freshness; without imports it says `viewer never imported`. Tab/Shift-Tab reaches
**Machines**, with each known label/opaque UUID, local scan status, per-harness status (found or
not installed, last event, unreadable-line counts locally; last clean read and `STALE` for imported
machines) and remote exported-at UTC instant plus age at opening. Old exports stay old after a fresh import; future clocks are flagged.
Unknown/rejected sources and retained last-good snapshots are explicit. This lists known sources,
not undiscovered machines. Invalid or missing snapshots show `incomplete coverage`.
Print/JSON output includes the same provenance. Recorded costs stay unchanged; a separate offline current-rate API-equivalent estimate shows priced/unpriced coverage, never presenting a partial sum as complete. Details: [here](#offline-stats-and-portable-snapshots).

Pinned header: tabs and the coverage note, then the date ranges, the harness and the model filter, then a rule.
Overview: an activity heatmap (one column per week) with the headline numbers (favorite model,
total tokens, sessions, longest session, active days, streaks, cache tokens, recorded cost) beside
it from about 105 columns and under it below that, then the token chart. Models: the chart, then every
model grouped under its provider. From about 100 columns that is a table (tokens, share, in, out, cache
read, cache write, recorded cost; a subtotal line per provider), else three-line cards. Tab switches
tabs, `r` cycles All / 7d / 30d / 5h / 24h (default All), `h`/`H` cycle the harness (All, then each of
pi, claude, codex, opencode that has data; hidden when only one does), `m`/`M` cycle the filter (All,
each provider, each `provider/model`; it composes with the harness and falls back to All where that
harness lacks the model), `j/k` or arrows scroll, `q` or Escape closes.

- Harnesses: `/stats` reads pi sessions plus local Claude Code, Codex CLI and OpenCode usage
  (read-only, no network, nothing opened beyond usage fields; see [Offline stats](#offline-stats-and-portable-snapshots)) and
  imported machines' events of every harness, each labelled. Under All the Models table gains a
  Harness column (the harnesses behind each row; cards say `· pi,claude`) and, under the All model
  filter, the chart plots one line per harness. A harness that records no cost (Claude, Codex) is
  `unpriced`, never `$0`: a partial total reads `$1.50 + 3 unpriced`.
- Quota: Overview shows one row per quota window with a gauge, percent used, `resets in ...` and
  `observed 12m ago via codex`, dimmed once older than 15 minutes. A window that has already reset
  shows `reset 5m ago, no newer reading` and no percent (unknown, not the old value). Readings come
  from local Codex rollouts, optional Claude statusLine captures and imported snapshots, are
  account-wide (no harness, model or range filter applies), and are never fetched. Claude without
  a valid capture says `no local reading`.

- The chart is an asciichart-style line plot (`╭╮╰╯`), one line per provider under All (one per
  harness when several have data and none is picked), else the top three models. Where lines overlap they merge into junctions (`┴┬├┤┼`) so every line stays
  connected; the larger series keeps the colour. Line colours start at the theme's `accent` hue,
  saturated, with hues spread evenly over the lines drawn (two providers get opposite hues), so
  muted themes still separate them. The title row carries the legend on its right (it wraps under the
  title on narrow panes). Every block spans the whole pane, except the heatmap, which shows as many
  weeks as fit up to two years. Days sum into 1/2/3/7/14/30-day buckets (longer when needed) so the
  range fits the width; short ranges are interpolated, not stepped. Y ticks land on round values with
  little headroom. Height follows the pane in whole tick steps (5 to 40 rows): Overview grows the chart
  into the rows it has left, Models gives it what a short list leaves, at least half.
- X axis: a baseline with a mark under every tick, labels centred on their bucket's column (the first and
  last clamp to the plot edges). Ticks are evenly spaced, at most 13, never overlap and are never cut; the
  finest set whose labels fit wins, so a wider pane gets more of them. 5h and 24h label hours starting on
  the clock (`09:00`, or `9a` / `12p` when narrow; every hour, 2, 3, 4, 6, 12 or 24 hours apart; across a
  DST change they stay evenly spaced, so later labels shift by the hour) with a row of dates where they
  fit: each new local day first, then the first bucket. Day buckets: a week of single days gets `Wed 7`
  (or `Wed`), longer ranges get dates on every day, 2 or 3 days, every Monday or every other Monday
  (counted back from today for multi-day buckets), then month names, quarters, half years and years, with
  `'26` only where the ticks span more than one year. A pane too narrow for any label draws the baseline
  alone.
- Rolling 5h/24h use the original call timestamps in zero-filled one-hour UTC buckets, with
  partial edges labeled. Labels use viewer-local time and UTC offsets, including repeated DST
  hours. The same rolling filter feeds chart/model/overview totals; future calls are ignored in
  every range. Long ranges retain the daily chart and activity heatmap.
- Tokens = input + output + cache read + cache write. Anthropic reports almost every prompt token
  as a cache read or write while Codex reports it as input, so anything less undercounts agentic
  use by orders of magnitude. Cost is pi's recorded list price: notional on a subscription.
- Counted: assistant messages, under the provider/model that answered. Not counted: tool-result
  usage (pi-subagents' parent-side report; its child sessions already hold those calls), compaction
  usage, `router/*` rows, `faux` and zero-usage rows. A `/fork` or cross-machine copy counts once.
  Preserved assistant entry IDs distinguish equal-value events. Legacy records use the old tuple
  identity and are discarded when an identified counterpart exists. Raw names drive dedup;
  only display text is sanitized.
- Subagent children (parent link plus a `<type>#<8 hex>` name, or the matching persisted child
  marker, including renamed children) count toward tokens but not
  Sessions. A filter narrows Sessions to the sessions that used the filtered models.
- Source: `*.jsonl` under `$PI_CODING_AGENT_SESSION_DIR` or `<agentDir>/sessions`. Cache:
  `<agentDir>/pi-session-kit/stats-cache.json`, re-parsing only files whose size or mtime changed;
  deleted sessions keep counting; machine views also retain history from previously configured
  session roots. Version 1 caches migrate without dropping deleted-file records; available files
  are reparsed for preserved IDs. Version 1 and 2 records with unreadable lines are reparsed when
  their file is next listed; a deleted file keeps its old count. A corrupt record is dropped and
  rebuilt. All-NUL lines (crash padding) are skipped; other lines that are not JSON objects show
  as `! N unreadable lines`.
- Print mode prints a per-model table (with a harness column and a `by harness:` split when several
  harnesses have data), the `quota:` rows and coverage; JSON emits the same as a display message.
  Works in Plan mode.
- After `make install` at the monorepo root, `npm run build --workspace @nredd/pi-session-kit`
  reproduces `dist/pi-stats-export.mjs` inside this package. Copy this standalone Node 22+ artifact
  to another machine: neither Pi nor the loaded session-kit extension is needed at runtime.
  `node ARTIFACT export --agent-dir DIR --output OUT` writes ONLY `OUT/machines/<UUID>/`.
  `node ARTIFACT import --agent-dir DIR --input REPO` validates all machines and atomically
  publishes the local global cache. Both emit one JSON object on success; partial imports emit
  JSON and diagnostics with a nonzero exit. No Git/network operations are part of the CLI.
  Schema, identity, atomicity and harness API details: [here](#offline-stats-and-portable-snapshots).

## Titles and rules

- Titles: one attempt after the first eligible TUI run of an unnamed persisted session. Without
  `titles.model`, candidates are Haiku 5.5, validated enterprise alias candidates (including the
  legacy Haiku 4.5 logical key), then GPT 6 Luna. `titles.model` is an explicit, fail-closed
  selection: an invalid, unavailable or unauthenticated configured model skips title generation;
  it never walks aliases or defaults. No silent retry after provider failure; explicit names and session switches win races. Children, headless runs,
  no-session runs and active planning are skipped. Output is capped at six words/60 characters;
  shorter names are accepted.
- Rules: Markdown files in `.pi/rules/` and the agent directory's `rules/`, with YAML frontmatter
  `paths: ["src/**/*.ts"]`. No `paths`, no injection. Successful read/edit/write results receive
  matching rules once per context lifetime. Compaction resets deduplication. Eight rules per turn,
  4096 UTF-8 bytes per appended block. The system prompt is not rewritten. Rules injected after an
  edit inform subsequent work, not the edit already performed. The agent directory is resolved on
  each tool result, like title aliases and stats, so a later `PI_CODING_AGENT_DIR` change applies
  to the next result.

## Subagents and verification

`pi-subagents` exposes no public child-context marker. The kit recognises its generated
`<type>#<8 hex>` session names; this is a compatibility heuristic, not a security boundary.
Commands/continuations are guarded. At `session_start`, parent-only goal/monitor tools are
re-registered with Pi's `hidden` exposure: child scoping and deferred promotion cannot reactivate
their schemas or nested-call capabilities. Tool-call and execute guards also deny child calls,
even after a child renames itself and reloads. Initial child binding persists a
`session-kit:child` entry with its session id; reload reads the active branch, not a generic
parent-session link (fresh Plan sessions also have parents). Replacement sessions do not inherit
cached identity or another session's marker. Goal/monitor factories register the shared identity
hook before their rebuild hooks, without querying an unbound runtime during factory loading.
No private subagent marker is imported. Existing tool permissions are not widened.

A prior settle handler's continuation (including a todo reminder) suppresses the goal nudge;
the kit does not append a second reminder or request another continuation.

For verification commands and test boundaries, see [development](#development).

## /mon resource dashboard

`/mon` is a read-only, interactive-TUI view of local host resources. It is on by default and
disabled with `{ "mon": { "enabled": false } }` in `pi-session-kit.json`. In RPC/print/JSON modes
it only warns; it never samples there.

### Source

`src/mon/source.ts` is a thin mapping over the published `@nredd/pi-resource-sampler`, declared
as the exact runtime dependency `0.2.1` (`0.1.0` leaked argv-style process titles as macOS names
and could fake Bun host CPU). No collector lives in session-kit. Each open view creates
one sampler (its own CPU baseline) and disposes it on close; disposal aborts and awaits any active
sample, including its `ps` child on macOS. Mapping rules:

- Collector success and host CPU state are separate. Every resolved sample is `LIVE` and refreshes
  the last-success time, even while host CPU is `warming` or `unavailable`, because its memory,
  load and process data are fresh. The CPU readout then says `-- warming` or `-- unavailable`.
  The header pairs the state (`● LIVE`, `○ WAITING`, `▲ STALE`) with the local wall time of the
  last successful collection (`updated HH:MM:SS`, `last ok` when stale), so freshness is never
  inferred from the CPU state.
- `warming` and `unavailable` metrics become `--`, never zero. The first observation is a warming
  baseline; persistent warming shows the sampler's reason (e.g. `Host CPU warming: CPU counters
  have not advanced`).
- Two diagnostic tones. A warning (`▲`, warning color) means a limit hides data the user would
  expect: `Partial list: S of E seen (reasons)` for budget caps or collector failures (at most three
  reasons, in words: `time budget`, `process cap`, `read budget`, `ps failed`, ...), unavailable host
  CPU, persistent warming. A muted hint states an expected platform limit: Linux always skips kernel
  threads (no RSS) and processes that exit mid-scan, so a scan whose only reason is
  `process-unreadable-or-changed` is `N skipped: kernel threads, exited or unreadable`, not a
  warning; `N names unknown (no access, e.g. other users)`; macOS process CPU. The process header
  counts *sampled* rows, not host processes.
- Names are the sampler's executable basenames, never argv or process titles. `""` renders as a dim
  `(unknown)` (Linux hides other users' `/proc/PID/exe` without ptrace access). macOS `p_comm` keeps
  16 bytes, so a macOS name of 16+ UTF-8 bytes ends in a dim `…` (`Google Chrome He…`): possibly cut,
  never claimed complete. Names stay untrusted text: sanitized, never interpreted.
- Sampler `0.2.0` supplies macOS native interval CPU and footprint via builtin FFI and libproc,
  with process-start absolute ticks plus microsecond identity. Inaccessible PIDs and unsupported
  runtimes have unknown metrics; Node 22-25 lack the builtin FFI. `ps` whole-second start times
  alone never authenticate CPU. The view orders by RSS only when every process CPU is unavailable,
  until the user picks a sort. First samples are warming, so CPU order stays stable.
- History spacing uses the sampler's monotonic `monotonicTimeMs`, so wall-clock steps (NTP, manual
  changes) cannot invent or hide gaps; the wall `wallTimeMs` is only displayed (header clock and
  last-success UTC).
  Node's monotonic clock pauses during system sleep on macOS and Linux, so a suspend shows no gap.
  `scan Nms` (80+ columns) is the sampler's collection duration. Missing/zero memory totals and non-finite values become unknown.

### Presentation

- From 72 columns and 17 rows (one more per diagnostic line), CPU and memory/load cards sit side
  by side; CPU history is two rows (16 levels) there. Narrower or shorter terminals get a
  three-line summary (`CPU`, `RAM`, 1-minute load, one-row history); at six rows summary/chrome
  yields to the selected process, but a compact partial-list or stopped/retry warning remains visible.
  At eight rows, core CPU/RAM/load metrics take priority over optional history and platform hints.
  Compact metrics tighten spacing when needed to keep CPU, RAM and the 1-minute load visible.
  The last row reserves close/help. Below 60 columns the header
  keeps the update clock over the tagline.
- Columns: `PID`, `CPU%` (100 = one core), `RSS`, `MEM%` (RSS over total RAM, 60+ columns),
  `NAME` last so long names never push numbers off screen. `f` toggles the byte column between
  `RSS` and `FOOT` (native physical footprint, including compressed memory); unavailable/failed
  PIDs show `--`, never zero. `MEM%` and `m` sorting remain RSS-based in either view. `--` is dimmed. A `▸` marks the
  selection; a theme scrollbar appears only when the list overflows. The memory card adds 1-minute
  load per logical CPU.
- Host CPU severity colors the value (success under 50%, warning under 85%, error above) next to
  the number itself. Stale CPU retains the last measured value, muted rather than live severity-colored.
  Cards add a `last value` label; compact summaries rely on the `STALE` header instead, reserving
  the metric row for CPU, RAM and load.
- Host CPU history keeps each capture timestamp, uses a fixed 0..100% scale and at most 120
  samples, newest on the right. A column is the lower-median interval between captures, widened
  only when the history is longer than the width, so completion-paced drift never invents gaps.
  Columns with no CPU value after the first one are gaps (`·`), never zero or interpolation;
  columns before it are blank, including the warming baseline. Stale snapshots add no point. The caption states the actual span. The latest sample in a bucket wins.
  Stale views show the last successful capture's UTC timestamp (or `none`). Waiting/live/stale and
  CPU warming/unavailable use semantic theme colors and text, so meaning does not depend on color.
- Memory labels its actual basis. Older samplers report **total-free** (`T-F` in the compact
  summary), which includes cached files and is NOT Activity Monitor's Memory Used. Additive v1
  `memory.usage` metrics instead render **used (A+W+C)** (`A+W+C` compact), an estimate of resident
  App + Wired + Compressed physical RAM. A failed native metric stays `--`, never total-free under
  a used label. Cards also show free pages and swap used/allocated; missing swap stays `--/--`.
  `?` explains each basis, RSS excluding compressed pages versus Activity Monitor's footprint,
  executable names (`pi` runs as `node`), and decaying `ps %cpu` versus interval CPU.
  Load averages are not percentages. Process CPU is interval CPU, where 100% is one logical CPU and
  multithreaded processes can exceed 100%.
- The source registry dependency is `0.2.1`, which removes the known Linux `/proc` iterator PID-exit race (the historical WSL incident's errno remains unproven). On native-capable macOS it supplies used/swap memory,
  footprint and interval process CPU; unsupported or inaccessible metrics remain `--`, never zero
  or an invented total-free fallback. Both consumer registry-resolution tests require those
  published bytes rather than a workspace link.
- The process viewport preserves selection by sampler identity, not PID or sorted row.
  Exited identities choose a bounded neighboring row; PID reuse cannot inherit selection.
  Unknown/non-finite measurements sort last with deterministic PID/identity tie breaks.
- `j/k` and arrows select; PageUp/PageDown page; `g/G` jump first/last; `f` toggles RSS/FOOT; `c/m/p` sort
  CPU/RSS/PID; `s` cycles sort; `?` toggles help; `q`/Escape close. CPU/RSS descend,
  PID ascends. Help has a bounded, wrapped viewport with a visible range and scroll hint;
  `j/k`, arrows, PageUp/PageDown and `g/G` scroll help without moving the process selection.
  No kill, locks, workload control, process arguments or environment display. Process names
  are the sampler's sanitized display names and are never interpreted.

### Ownership

`MonView` accepts presentation snapshots and never collects data. It caches rendered lines
by dimensions until update/input/theme invalidation. `MonPoll` owns one completion-paced probe
(~2s after the previous one completed), with no catch-up queue. Closing aborts collection,
cancels the timeout and awaits the sampler's disposal. Errors stop collection and retain
explicitly stale values; reopening is the retry mechanism. Late results are discarded.

`registerMon` opens a source only inside a TUI interaction and serializes replacement through
completed asynchronous disposal, including concurrent opens. Session shutdown/start invalidates
pending openers before they can create a source, even when Pi defers the UI factory. It registers
no model tool, persists no history, sends no model messages and does no network work.

### Verification

Run the [workspace gate](#development). Real-sampler tests collect two host observations and test
in-flight cancellation; fixture previews and before/after process-list snapshots are not equivalent
cancellation/reaping evidence. Node and Bun exercise the real interactive host, resize, close/reopen,
close-before-first-sample and shutdown. Mapping/layout tests use typed snapshots and fakes.

The source test requires the nested published sampler install, never the same-version workspace link.
The root packed-package contract installs the tarball alone through stock Pi with the registry sampler.
No Linux terminal recording is claimed by these automated proofs.

For a labelled manual preview without sampling, from `packages/session-kit`:

```sh
bun tests/mon/terminal.ts dark
bun tests/mon/terminal.ts light
```

These display `FIXTURE DATA` and `fixture-*` names, not host measurements.

## Offline stats and portable snapshots

Build `dist/pi-stats-export.mjs` (gitignored, not committed; it bundles the harness readers) with `npm ci && npm run build`.
The exact esbuild version and dependencies are locked; tests assert byte-identical rebuilds.
Copy only that file. Runtime is Node 22+ with builtins only, no Pi install, extension, private
repository, package install, auth or network access. Importing the artifact is silent, even when
an importing process supplies a nonexistent entrypoint argument; direct and symlinked Node execution
still run the CLI. Packed-CLI tests explicitly launch `node`, including when their Vitest
host is Bun; this tests the artifact's declared runtime, not Bun's entry-module resolver.

Chart tick steps parse decimal powers directly rather than using implementation-approximated
exponentiation, keeping large finite ticks consistent between Node and Bun. Steps above the
numeric range retain infinite headroom.

```
node ARTIFACT export --agent-dir DIR --output OUT [--sessions-dir ROOT]
  [--harness pi,claude,codex,opencode] [--claude-dir DIR] [--codex-dir DIR] [--opencode-db FILE]
  [--replace-harnesses]
node ARTIFACT import --agent-dir DIR --input REPO
```

`--harness` picks what an export reads; the default is `pi` only, so other tools are opt-in. Roots
default to each harness's own variable, then its standard path (`CLAUDE_CONFIG_DIR` or `~/.claude`,
`CODEX_HOME` or `~/.codex`, `OPENCODE_DB` or `$XDG_DATA_HOME/opencode/opencode.db`); the flags take
precedence. A scheduled run with a minimal environment must pass the flags. Without `pi` in the list
no pi session is read. The export-only flags are rejected on `import`.

The set an export published is recorded (see `export-state.json` below). A later export with a
*narrower* set than the last published one is refused before anything is read or written, because
its snapshot would silently drop the missing harnesses' history (e.g. a scheduled `--harness pi`
run after a manual `--harness pi,claude`). Widen the set, or pass `--replace-harnesses` to drop
the history on purpose. The check is against the recorded set *and* what the last published
snapshot holds, so a lost state file, or one that failed to update after a widening, cannot hide a
narrowing. What a snapshot holds is every harness with an event, a quota reading or a `lastGoodAt` mark in it
(a pi-era snapshot counts as `pi`; one that cannot be read is assumed to be `pi`), and nothing if
nothing was published. After a narrowing the state and snapshot agree again. With the snapshot
unreadable *and* no recorded set the last published set cannot be established, so the export is
refused unless `--replace-harnesses` is given; with a recorded set it still guards a narrowing.
(If both the state and the snapshot have gone bad, a stale state can understate a widening that
was never recorded; that double fault is not defended.)

Callers must not run two exports into the same outbox at once: nothing in the artifact locks. The
only scheduled caller, `pi-usage-sync`, already serializes its runs under its own lock, so a manual
export should go through it (or not overlap one).

`--agent-dir` defaults to `PI_CODING_AGENT_DIR`, then `~/.pi/agent`. The session root defaults to
`PI_CODING_AGENT_SESSION_DIR`, then `DIR/sessions`; `--sessions-dir` takes precedence. History
already cached under former roots is retained, even after files disappear. Paths are resolved
locally and never exported. Run export before fetch/commit/push, then import the updated data
checkout. Git, locking concurrent sync runs, retrying pushes and network deadlines belong to the
sync helper, not this data-only artifact.

Incomplete pi scans still fail before publishing: prior shards, manifest and export state stay unchanged.
The CLI reports totals plus at most 20 `pi-stats-scan: {"path":...,"line":...,"reason":...}`
records on local stderr. Lines are physical, one-based (including skipped empty/NUL padding);
`0` means a filesystem operation or an unavailable cached record, not a known line. Reasons are
`invalid-record`, `read-directory`, `read-file`, `write-cache`, or `cached-invalid-record`.
Paths are JSON-quoted, capped at 1024 characters and have C1 and all Unicode `Bidi_Control` characters
(including ALM, LRM and RLM) neutralized; JSON escaping preserves C0 safety. No raw
records, parser/OS exception text, prompts, message IDs or credentials are reported. These local
locations never enter usage shards or manifests. Bad cached files are re-read to recover locations;
deleted/former-root bad records remain fail-closed with an unknown line. Wrappers must explicitly
forward this bounded protocol; forwarding arbitrary exporter stderr is not safe.

CLI results:

- Export: `{ "machineId": "<UUID>", "snapshotDir": "<OUT>/machines/<UUID>" }` on stdout, plus
  `"harnesses": { "<name>": { "found": bool, "problems": [..] } }` for each requested non-pi harness.
  A missing harness is `found: false`, not an error. `problems` are counts only (e.g.
  `claude: ! 2 unreadable lines`, Codex turns skipped for lack of per-turn records).
  A harness whose scan is incomplete (unreadable transcript files, a harness cache that cannot be
  written, a data root or OpenCode database that exists but cannot be reached, an OpenCode database
  that is busy or unreadable) is `failed: "kept"`. So is one that is *not found* while the last
  published snapshot holds data for it (a moved or unmounted root, a wrong `--codex-dir`), with the
  diagnostic `<harness>: not found, but data was published before`; only `--replace-harnesses`
  publishes the empty replacement. A harness never published and not found stays silent. Kept: what this machine
  last published for that harness (events, sessions, quota) is carried into the new snapshot
  unchanged, a diagnostic goes to stderr, and the export still succeeds, so one flaky harness
  cannot stop the pi export or replace good history with a partial scan. With nothing published
  yet there is nothing to carry. If the previous snapshot itself is unreadable the harness is
  `failed: "lost"` (diagnostic `<harness>: last published contents unreadable`): it is missing
  from this snapshot, and stderr says so. Pi itself still fails closed.
  `consecutiveFailures` counts failed exports of a harness in a row (kept in `export-state.json`,
  reset by a clean one). It never changes the exit code (see below): a caller that wants to warn
  about a harness stuck on carried data reads `failed`, `consecutiveFailures` and, on import,
  `stale`.
  A transcript that vanishes between listing and reading (Claude and Codex prune old ones) is not a
  failure; its cached record stays.
- Import: `{ "imported": N, "retained": N, "problems": [], "importedAt": MS, "stale": [..] }` on
  stdout. `stale` lists `{machineId, harness, lastGoodAt}` for every cached machine harness whose
  `lastGoodAt` is more than 2 days behind its manifest `exportedAt` (data carried through failures);
  each is also a stderr line, and none changes the exit code.
- Exactly one JSON object is emitted. Diagnostics go to stderr.
  Exit contract: an export that published a snapshot exits 0, however many harnesses `failed`
  (kept or lost) and however many times in a row: those are fields of the JSON result, plus a
  stderr line each, for the caller to record as warnings. So is `warnings: ["export state not
  recorded"]`, when the snapshot is out but `export-state.json` could not be written (the next
  export still derives the set from the snapshot). A nonzero exit means nothing was published: an invalid
  command, an incomplete pi scan or unwritable pi cache, an unwritable output, corrupt installation
  state, or a refused narrower harness set. (A harness cache that cannot be written is a failed
  harness, carried, not a nonzero exit.) A partial or corrupt import emits a JSON result and exits
  nonzero, retaining every failed machine's last-good snapshot; one that only finds stale harnesses
  exits 0 and lists them in `stale`.
- A failed export never replaces the previous manifest. Its validated immutable shards may remain
  unpublished. Export writes only its own machine directory; it never edits another machine.

Installation state, never synced:

- `DIR/pi-session-kit/machine.json`: persistent UUID v4 and label, created exclusively and
  atomically on first use. Default label is `Pi machine`, not the hostname. A corrupt identity
  fails rather than silently enrolling another machine. Copying an entire agent dir also copies
  its installation identity: remove `machine.json` on a genuinely new installation before export.
- `DIR/pi-session-kit/stats-cache.json`: local parser cache v2, including file paths and compact
  usage tuples. Version 1 entries for deleted files stay intact; existing files reparse even if
  their mtime/size match. Strong identities are not invented for inaccessible legacy files.
  Failed stat/parse operations count as incomplete history; a failed reparse retains the last-good
  cached record. Invalid cached identities and raw provider/model pairs are discarded. Persisted
  child markers apply only to the matching session ID, surviving user-visible renames.
- `DIR/pi-session-kit/export-state.json`: the installation's secret salt (32 hex) and the harness set
  the last successful export published (`null` until one is recorded). `failures` holds the consecutive failed exports per harness.
  The salt keys the quota
  account discriminators below and never appears in a snapshot; like `machine.json`, it is created
  exclusively and atomically, and a corrupt file fails rather than being replaced. The set is
  written only after the manifest is published.
- `DIR/pi-session-kit/stats-global.json`: one atomically replaced document containing validated
  last-good machine snapshots, last successful import time and coverage problems. Imports do not
  mutate local usage or installation identity. A wholly failed import does not advance the sync
  time; a partial import records valid updates and marks coverage incomplete. The assembled cache
  accepts up to 128 MiB; exceeding that limit fails before replacement and retains its last-good
  bytes. Tests inject final-document byte accounting at the exact limit and one byte over, while
  retaining real import validation and atomic publication.

Snapshot version 2 (version 1 is still imported, see Compatibility):

```
machines/<UUID>/manifest.json
machines/<UUID>/<YYYY-MM>-<sha256>.json
```

Manifest exact keys:

- `version`: `2` (`1` for legacy exports).
- `machineId`: persistent UUID v4, matching its directory.
- `label`: installation label, maximum 1024 characters. Not a session name.
- `exportedAt`: positive UTC Unix milliseconds.
- `lastGoodAt` (v2 only): per harness in the snapshot (`pi`, `claude`, ...), when it was last read
  cleanly: positive, at most `exportedAt`. Equal to `exportedAt` unless the harness failed and its
  previous contents were carried, when it stays at the previous mark (or the previous `exportedAt`
  for a snapshot with none), never later than `exportedAt` even if the previous snapshot's clock ran
  ahead; absent when that is unknown.
- `shards`: unique month references, each exactly `{month, file, sha256, bytes}`. `file` MUST
  equal `<month>-<sha256>.json`. No absolute paths, traversal or arbitrary filenames.

Shard exact keys: `{version, machineId, month, events, sessions, quota}`; v1 shards have no `quota`. All shard JSON is canonical
`JSON.stringify` output (no indentation/newline), bounded to 128 MiB per file. Manifest hashes
cover exact UTF-8 shard bytes. Immutable content-addressed shards are published first, manifest
last; unreferenced old shard generations are deliberately retained and ignored. No cleanup races
with readers. Each manifest references exactly one shard per month.

Event exact keys:

- `id`: SHA-256 event fingerprint.
- `harness`: `pi`, `claude`, `codex` or `opencode` (v2 only).
- `entryId`: SHA-256 of `entry:<preserved assistant entry ID>`, or `null` for legacy records.
- `sessionId`: opaque session ID.
- `ms`: original positive UTC Unix milliseconds, in the shard's UTC month.
- `provider`, `model`: raw physical attribution, each nonempty and at most 1024 characters.
- `input`, `output`, `cacheRead`, `cacheWrite`: nonnegative safe integers, not all zero.
- `cost`: finite nonnegative recorded notional cost, or `null` when the harness records none
  (Claude, Codex; v2 only). `null` is not 0: totals treat it as 0, but it is not a recorded price.

The identified fingerprint is SHA-256 of the JSON array
`[harness, entryId, ms, provider, model, input, output, cacheRead, cacheWrite]` (v1 had no
`harness`, and the same arrays without it still verify v1 shards). The harness is also part of
the dedup key, so a pi row and a Codex row with equal counts never merge.
Notional price changes do not create new events. Different entry IDs survive equal usage. Copied entries across forks/machines count once. Legacy
fingerprinting and matching use `[provider, model, ms, input, output, cacheRead, cacheWrite]`,
intentionally without cost to preserve the old tuple rule; identified counterparts supersede
legacy duplicates.

Quota observation exact keys (v2; stored in the UTC month of `observedAt`):
`{harness, provider, limitId, window, usedPercent, resetAt, durationMs, observedAt, planType, account}`.
`harness` is the observer, `provider` the router provider name (Codex: `openai-codex`), `window`
`5h`, `7d` or `<seconds>s`, times are epoch ms, `planType` is a string or `null`. No account email,
ID or credits. `account` is `""` or a SHA-256 of `<salt>`, the harness and the harness's own account
ID, computed locally (Codex `creator_account_id`); the ID is never stored and the salt never leaves
the machine. Where a harness exposes no account ID (Claude, or a Codex rollout without one) the
value is `""` and the reading assumes a single account for that harness: two such accounts would
merge. Because the salt is per installation, the same account seen on two machines carries two
discriminators and shows as two readings, not one. A snapshot reports each
`(provider, limitId, window, account)` once.
Across machines and harnesses a reading that has not yet reset beats one whose `resetAt` has passed,
then the freshest `observedAt` wins (ties break deterministically) and the observer is kept;
readings are never summed. An expired reading is kept only when nothing live exists, for display
as `reset, no newer reading`; it never beats a live one however fresh its clock. `loadCombined`
returns the merged `quota`, evaluated at its `now` argument.

Compatibility: import accepts v1 and v2 machines side by side, in one global cache (still
validated with each manifest's own version). A v1 event loads as `harness: "pi"`. v1 shards are
never rewritten; a machine moves to v2 on its next export, and the viewer's `exportedAt` ordering
applies as before. Older kits cannot read v2 manifests, so update viewers before producers.

Session exact keys: `{id, startMs, endMs, child}`. Header IDs hash as `session:<header ID>`;
unidentified legacy sessions use a local path hash and therefore cannot always be matched across
machines. Session metadata is independent of event dedup, lives in the start timestamp's UTC
month, and merges time bounds by ID through the same helper for local and imported histories.
Children retain usage but do not contribute to session count.
Only sessions owning a retained event count. The oldest session owns copied events, independent
of machine read order. Every exported event references session metadata.

No message content, tool arguments/results, paths, session names, environment, credentials or
source objects are exported. Explicit projections, not object spreads, enforce the allowlist.
Raw attribution is retained to avoid display-sanitization collisions. Schema validators reject
unknown fields, unsupported versions, duplicate IDs, invalid counters/time/months, excluded test
providers, identity/digest/byte-size mismatches, symlink files and missing session metadata.

Import validates a whole machine before replacement, retaining last-good data for bad, missing
or older snapshots. Other valid machines still advance. Only the final validated global document
is atomically renamed, so `/stats` sees either the old or new complete cache, never a mixed import.
Producer updates are invisible until the producer exports AND the viewer imports. Coverage counts
known machines, not undiscovered installations; it is not proof that every machine has synced.

`/stats` freshly scans local sessions and combines them with this cache without network access.
`loadCombined` keeps every imported event's `harness` label (v1 shards are `pi`). Passing
`{ harnesses: [...] }` also scans this machine's Claude, Codex and OpenCode data (the `/stats`
command does; the library default reads none, and an explicit `agentDir` without `homeDir` is an
isolated root that reads none either). Local scans are deduplicated against imported events by the
same fingerprint, their quota merges with imported quota (`Combined.quota`, freshest per window and
account), and their count-only diagnostics land in `Combined.harnessProblems`. A null cost stays
`null`: `/stats` shows `unpriced`, and a total over mixed calls reads `$X + N unpriced`.
`Coverage.sources[].harnesses` holds per-harness status: locally `found` (false is "not
installed"), `lastEventMs` and `problems`; for imported machines `lastGoodAt`, `lastEventMs` and
`stale` (see `STALE_AFTER_MS`).
Its header labels cached coverage, **viewer last import**, local-only/never-imported state and
incomplete coverage. Tab/Shift-Tab cycles Overview, Models and **Machines**. Machines lists each
known installation's label plus full opaque UUID (default labels may repeat), fresh local scan
status, and each remote producer's **exported-at** UTC instant and age at opening. Use j/k or
arrows to scroll; narrow panes wrap details. Print/JSON output includes the same provenance;
empty histories include it in the notification. Range/model filters do not filter provenance.

The viewer import clock is NOT producer freshness: importing a ten-day-old export today still
shows a ten-day producer age. Future export clocks say `future; clock skew`, never fresh.
Absent/invalid display timestamps say `unknown`. Invalid v1 manifests still fail validation and
retain last-good data; rejected known UUIDs without last-good data show unknown export time.
Missing/rejected sources with retained data say `Incomplete import; retained last-good snapshot`.
Existing v1 snapshots require no migration or re-export. Unreadable caches report incomplete
coverage, not invented machine identities. Only known sources are listed; this cannot discover
machines that have never supplied a snapshot. No freshness threshold implies fleet completeness.

Labels come only from the existing local `machine.json`, never automatic hostname/environment
collection. Keep custom labels non-sensitive: they are exported. No schema or sync cadence changes.
Future calls are ignored in display totals, not removed from durable history. Statistics
are not subscription quota measurements or router inputs.

Harness readers (#367; exported by the CLI above and shown in `/stats`):

`src/stats/harness/` reads Claude Code, Codex CLI and OpenCode usage into the same `Call` model as
pi (`Call.harness`: `pi | claude | codex | opencode`). Roots: `CLAUDE_CONFIG_DIR` or `~/.claude`;
`CODEX_HOME` or `~/.codex`; `OPENCODE_DB`, else `$XDG_DATA_HOME/opencode/opencode.db`. Local file
reads only. A missing root is silent ("not installed"). Parsed files are cached in
`DIR/pi-session-kit/stats-harness-cache.json` by size and mtime, history for deleted files kept. A record that counted
unreadable lines is re-read on every scan until it parses clean; a deleted file's record keeps its count.
That local, never-synced file is keyed by absolute transcript path (so Claude's cwd-encoded project
directory names live there as keys); its values and every reader result carry no paths. It also
records a hash of the installation salt (never the salt). When that changes, usage records are kept
(a pruned transcript's history exists nowhere else) but quota is dropped and every record is marked
for re-parse, so quota for files that still exist is re-derived under the new salt on the next scan.

Purging a harness: history for transcripts a tool has since pruned lives only in this cache and in
the published snapshots. To drop a harness on purpose, export without it using
`--replace-harnesses`; to also forget what the cache remembers of deleted files, delete
`stats-harness-cache.json` (existing files re-parse; pruned history is gone for good).

- Claude: `projects/**/*.jsonl` including `subagents/`. One response is written once per content
  block, so rows collapse by `(message.id, requestId)`, keeping the largest output count.
  Subagent files and sidechain rows count toward tokens, not Sessions. Cost `null`.
  The optional `<Claude config root>/rate-limits.json` capture is read on every scan, outside the
  transcript cache. Root selection is unchanged: explicit `--claude-dir`/`roots.claude`, then
  `CLAUDE_CONFIG_DIR`, then the injected home or native `~/.claude` (an injected home ignores
  process environment). Contract: `{observed_at:<epoch seconds>,rate_limits:{five_hour?:
  {used_percentage,resets_at},seven_day?:{used_percentage,resets_at}}}`. Observation time must be
  finite, positive and not in the future; percentages finite 0..100; resets positive safe-integer
  epoch seconds within the canonical snapshot timestamp bound (8,640,000,000,000 seconds). Only these named windows become
  canonical `anthropic` quota (`5h`/`7d`, account `""`, plan `null`), never arbitrary fields or IDs.
  Missing, unreadable, malformed, non-file or over-64-KiB captures silently contribute no quota;
  invalid/absent windows are unknown, not zero. They never fail a transcript scan or replace its
  history. Partial captures do not retain a previous sibling; expired readings follow the reset
  display policy above, not old usage as current. Snapshot v2 and v1 import compatibility stay unchanged.
  Source reader integration is #963; capture producer nredd/dotfiles#144 is merged. The reader must
  still be published and the producer configured before an installed exporter/viewer can consume
  captures. Merging capture alone never enabled this reader. This change does not publish, activate
  or bump pins.
- Codex: `sessions/` and `archived_sessions/` rollouts. `token_usage_record` rows are joined to
  `turn_context.model` by turn. `input` is `input_tokens` minus the cached and cache-write subsets.
  Turns without per-turn records (older Codex, including old turns of a resumed rollout) are
  skipped with a count-only diagnostic, never approximated.
  `rate_limits` from `token_count` rows become quota observations (provider `openai-codex`),
  freshest per `(limitId, window, account, resetAt)` per rollout, so a newer already-reset reading
  never hides an older live one. No account dimension on usage; quota carries the salted `account`.
- OpenCode: a read-only `node:sqlite` read in keyset pages of 2000 rows, yielding to the event loop
  between pages, cached per session in the harness cache under a stamp of the database plus its
  `-wal` (summed size, newest mtime): an unchanged database is never reopened, a changed one is
  re-read in full (`/stats` shows `reading opencode, N rows` in its loading status). The
  open is `immutable=1` only when the WAL is checkpointed and absent (so a read never creates
  `-shm`/`-wal` and pending WAL rows are always visible); 2s busy timeout, then a generic "database
  busy" diagnostic. The query projects only counters, IDs, timestamps and model names. `reasoning` tokens count as output. The
  schema follows third-party readers; a mismatch or missing `node:sqlite` is a diagnostic.
- Entry IDs hash `<harness>:<native id>`, session IDs `<harness>-session:<native id>`. Only counts,
  timestamps, raw provider/model names, Codex quota labels (`limit_id`, `plan_type`, percentages,
  reset times) and hashes are projected: no text, tool arguments, cwd,
  titles, directory names, account IDs or credentials. `history.jsonl`, `auth.json`, credential
  files and Codex SQLite databases are never opened. Diagnostics are counts only.
- Cost is `null` for Claude and Codex (snapshot v2); OpenCode's recorded cost is kept, `null` when
  absent. The harness cache is version 4: older caches (cost 0, quota without `account`) are dropped and
  re-parsed.

Current-rate API-equivalent value:

- `Recorded cost` is the saved observation: never overwritten, never a current-rate fallback, not
  subscription spend. Transcripts, snapshots, event IDs, dedup and deleted-file history are unchanged.
- `/stats` also estimates each retained physical event with `estimateTokenCost` from the host's
  `@earendil-works/pi-ai`, over already-loaded models only (no catalogue refresh, auth or network).
  Context tiers apply per event before summing.
- Overview and Models show the range/filter estimate and priced/unpriced event and token coverage;
  print mode adds a per-model column. Machines adds source, checked date, units, conditions and
  unpriced reasons. A partial sum reads `priced subset only`; no priced events reads `unknown`, never
  $0. Verified free events price at zero.
- Lookups are exact provider/model identities with assessed rates; aliases are never guessed. A host
  without the estimator, unavailable models, non-token charges and unassessed rates stay unpriced.
- It is list-price value, not request-date billing or an invoice. Bedrock uses published Standard,
  global cross-region, US East (N. Virginia) USD per million tokens as a baseline, not actual routing.
- Snapshots do not keep cache-write lifetime, service mode, region or provenance, so a write with
  unknown TTL stays unpriced. Classifier/image calls reported inside tool results are not counted.
- The exporter/importer carries recorded values only; no snapshot migration.
- `tests/stats/pricing-core.test.ts` runs in the normal suite against the real estimator.

Harness API:

- `src/stats/library.ts` is a Pi-independent barrel for parser, aggregation and snapshot APIs.
- `parseSession`, `flatten`, `dedupCalls`, `hourlySeries`, `makeSnapshot`, `validateManifest`,
  `validateShard`, `validateSnapshot`, `exportStats`, `importStats`, `loadCombined`, `coverageLabel`.
- `hourlySeries(calls, "5h" | "24h", now, keyOf?)` is deterministic, zero-filled, filters exact
  rolling boundaries and labels partial edges. UTC buckets keep repeated DST hours separate;
  viewer-local labels carry UTC offsets, including fractional-offset zones.

Limits: legacy no-ID copies can only use tuple dedup, legacy session metadata without header IDs
cannot reliably match across machines, and concurrent sync workflows must serialize writes to
one agent directory. The combined global cache is bounded to 128 MiB; a larger import fails
without replacing last-good data. There is no automatic discovery/network refresh or daemon. Reinitializing
both the local parser cache and source history permanently loses that machine's local history;
keep these installation files out of synced snapshots but do not routinely delete them.

## Development

From the repository root:

```sh
make install-owned
npm run check --workspace @nredd/pi-session-kit
make check
make check-package-contracts
```

The workspace check runs Biome, strict TypeScript and the full Vitest suite on Node and pinned Bun.
Tests mirror `src/` under `tests/`; package helpers/data live in `tests/fixtures/` and
shared clocks/doubles in `@nredd/pi-test-lib`. Real core session/interactive harness scenarios
cover file-backed restore, child rename/reload, command completions, rules, titles, loops,
monitor wakes/cursors/caps/timeouts, diffs, stats and resource views without operator credentials.
Cross-extension Plan/subagent/todo behavior remains in the root integration tier.

`tests/fixtures/session.ts` uses the public-SDK `@nredd/pi-test-lib/harness`; only
`tests/fixtures/terminal.ts` imports the fork interactive host. The same fixed 38-case scope
runs on fork and stock Pi 1.5.2, on Node and Bun: `tests/fixture-boundary.test.ts`,
`tests/monitor/extension-boundaries.test.ts`, and `tests/scenarios/{goal,goal-restore,loop,monitor,
child-identity,isolation,rules,command-callbacks}.test.ts`. These cover goal continuation,
evidence/restore, loop scheduling/isolation, monitor lifecycle/failure/cleanup, child rename/reload,
command completions and rules. Pass those ten files to `node ../../scripts/run-vitest.ts node
--coverage.enabled=false` (replace the engine argument `node` with `bun` for Bun).
The graph controls follow the shared helpers and reject the real terminal fixture's fork export.
The full fork suite remains mandatory. Terminal scenarios still require the fork's
`/testing/interactive` (`InteractiveMode`, runtime replacement, `TUI.flushRender` and virtual
terminal disposal); title routing also uses `registerVirtualModel`. This fixed headless scope
is not a full-package stock-compatibility claim.

Native process tests require macOS or Linux. From `packages/session-kit`:

```sh
node ../../scripts/run-vitest.ts node tests/diff/git.test.ts tests/monitor/pidfiles.test.ts tests/monitor/manager.test.ts tests/monitor/matcher.test.ts
```

They exercise TERM-resistant descendants, leader exit/closed pipes, concurrent/interrupted cleaners,
recovery guards, identity changes, catastrophic regexes, final-match drain and disposal. Keep fixture
parent-liveness guards and real readiness barriers: aborting a worker must not leave an infinite
fixture process, and fake timeout clocks must not race native startup. Synthetic PIDs never reach
real signals. Zombie observations are not evidence of a live process; direct children are reaped
before native stop/dispose resolves and orphan disappearance is checked separately.

Use one injected clock for lifecycle deadlines and fixed stats histories. Real terminal input is
split through Pi's `StdinBuffer`; each fixture owns/disposes its host, including assertion failures.
The nested worker-death regression uses the isolated-home launcher environment and checks both its
owning process and detached group cleanup. Do not replace these with passing mocks or fixed sleeps.

The stats CLI rebuild test writes to per-test temporary output, never shared `dist/`.
Packed CLI tests disable lifecycle scripts and launch Node explicitly, including under Bun;
byte-identical rebuilds verify the declared standalone Node artifact, not Bun's entry resolver.
