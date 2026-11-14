# pi-session-kit

Published to npm as `@nredd/pi-session-kit` (public). From `0.4.0`, each version is cut by the monorepo `Publish` workflow from a signed `@nredd/pi-session-kit@<version>` tag, with npm provenance and a GitHub release carrying the tarball, checksums and manifest (`docs/releases.md`); earlier versions were published manually without provenance. `0.4.0` adds `createSessionKit(options)` (explicit `config`, `agentDir`, `monitorRoot`, injectable `clock` and `spawnMonitor`; the default export is unchanged) and fixes leaderless orphan-group sweeps at `ps` start-time resolution. `0.5.0` redesigns `/stats` around the full pane (pinned header, aligned stat cells, a Models table on wide panes) and gives every chart a clock- or calendar-aligned time axis, including the 5h and 24h hourly views.
Use the [monorepo development commands](https://github.com/nredd/pi-harness/blob/main/README.md). The Git install and standalone harness
references below describe the legacy deployment, not installation or candidate verification of
this package. `0.6.0` keeps passive monitor output only in the monitor ring buffer rather than adding it to the transcript or model context; `monitor_read` is the explicit output surface, and match/exit/timeout wakes are compact summaries with a cursor. `0.7.0` adds the `/stats` Machines tab with per-machine producer export age, separate from the viewer's last import, and the collapsible monitors widget. `0.8.0` adds `/mon`.

## Standalone use

The packed tarball is self-contained: Pi host modules (`@earendil-works/pi-*`, `typebox`) are `*` peers supplied by Pi, and no sibling plugin is required. Its only runtime dependency in current source is the exact published `@nredd/pi-resource-sampler@0.2.1` library (no Pi imports), which npm installs from the registry for `/mon`. Verified by installing the tarball alone and running it in exact stock Pi 1.3.0 (`make check-package-contracts`). Optional fork integrations (subagents, Plan mode) are absent in that setup; the exercised behavior does not need them.

Session-scoped pi extensions for tmux users. No daemon, supervisor, core patch or cross-pane
registry. Each runtime owns its goal, loops and monitors; persisted goal state follows the active
session branch. Closing pi stops its work.

`/mon` opens a read-only, full-pane view of local CPU, memory, load and processes, sampled
every ~2s by the shared `@nredd/pi-resource-sampler` library only while it is open. Details and
limits (macOS native CPU/footprint require Node >=26.1 or Bun, executable names keep 16 bytes,
RSS excludes compressed pages, `f` toggles a labelled footprint column,
and memory labels state their measurement basis) are in
[here](#mon-resource-dashboard). It is not a second `/monitor` process runner.

## Install and config

```sh
pi install npm:@nredd/pi-session-kit@0.8.0
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
cache/session defaults when no agent directory is supplied, and `monitorRoot` isolates
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
**Machines**, with each known label/opaque UUID, local scan status, and remote exported-at UTC
instant plus age at opening. Old exports stay old after a fresh import; future clocks are flagged.
Unknown/rejected sources and retained last-good snapshots are explicit. This lists known sources,
not undiscovered machines. Invalid or missing snapshots show `incomplete coverage`.
Print/JSON output includes the same provenance. Details: [here](#offline-stats-and-portable-snapshots).

Pinned header: tabs and the coverage note, then the date ranges and the model filter, then a rule.
Overview: an activity heatmap (one column per week) with the headline numbers (favorite model,
total tokens, sessions, longest session, active days, streaks, cache tokens, notional cost) beside
it from about 105 columns and under it below that, then the token chart. Models: the chart, then every
model grouped under its provider. From about 100 columns that is a table (tokens, share, in, out, cache
read, cache write, notional cost; a subtotal line per provider), else three-line cards. Tab switches
tabs, `r` cycles All / 7d / 30d / 5h / 24h (default All), `m`/`M` cycle the filter (All, each provider,
each `provider/model`), `j/k` or arrows scroll, `q` or Escape closes.

- The chart is an asciichart-style line plot (`╭╮╰╯`), one line per provider under All, else the top
  three models. Where lines overlap they merge into junctions (`┴┬├┤┼`) so every line stays
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
- Print mode prints a per-model table and coverage; JSON emits a display message. Works in Plan mode.
- After `make install` at the monorepo root, `npm run build:stats-export --workspace @nredd/pi-session-kit`
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

`test/scenarios/` drives the real kit through core's in-process session harness under Vitest and Bun,
covering goals, file-backed restore, child rename/reload, read-rule injection, titles,
monitor output/wakes/cursors/caps/timeouts and loop scheduling with same-cwd session isolation.
Command completion scenarios resolve public runner suggestions and execute the selected `/goal`,
`/loop` and `/monitor` commands, checking persisted state, timer removal and the selected child.
Loop resume starts from a provider-error pause: ticks stay quiet until the selected resume command
restores dispatch. Git setup uses child-only scratch HOME/config and empty hooks/templates, with
hostile config/template/hook controls; it never changes the parent process HOME.
Pidfile age-boundary fixtures pin file/directory mtimes to the injected sweep clock and check the
24-hour threshold under both past and future wall clocks.
The interactive host/VirtualTerminal covers `/diff`, `/stats` and real `/name`, including width/resize
matrices, chart glyph ports/colours and file-backed titles. Mounted command callbacks also verify
live-theme invalidation, empty Models ranges, help page boundaries, source-failure reopening,
stale deferred factories and stats load-error cleanup without replacing the interactive host. Stats histories use a fixed clock;
`createSessionKit({ agentDir, clock })` scopes both offline loading and displayed time ranges.
Terminal fixtures route input chunks through pi-tui's real `StdinBuffer`, matching ProcessTerminal's
keypress splitting (complete keys only; lone Escape is flushed immediately). Stats scroll-to-clamp
checks batch input and settle once; intermediate-frame checks still settle per step. Both hourly
tabs and exact provider totals remain covered at every width. The full-render sweeps run one case per width
(row count) or per range (stat grid), each asserting it checked something, so no single test owns hundreds of
renders against the 20s bound; the hourly ranges pin `now` so they lay out a grid. Each stats-view body owns its fixture
and disposes it in `finally`, so runner timeout teardown cannot race a still-running callback.
Monitor scenarios use a shared fake clock and controlled children; native `test/monitor/` keeps real
workers/processes, and process-group kill/orphan recovery stays in the assembled integration tier.
Native `STAY` fixtures exit themselves when their parent changes and signal nothing. Only the
worker-death fixture uses `STAY_GROUP`, which SIGKILLs its own detached group, addressed by its own
pid; production commands and leader/descendant probes are not modified.
Shell fixtures that outlive their test (`trap "" TERM` descendants, `sh -c` leaders with a background
descendant in `manager.test.ts`, `pidfiles.test.ts`, `diff/git.test.ts`) loop on `STAY_SH`, which
probes the worker's pid with `ps` and exits once it is gone, so an aborted gate leaves nothing
behind. A probe that exits 143 (procps `ps` catches a group SIGTERM despite `trap "" TERM`) counts as
alive, so a kill-path test cannot see its TERM-resistant descendant exit early. Other shell waits
(the diff shim's readiness loop) also stop on `WORKER_ALIVE_SH`, so a timed out test whose temp dir
is gone cannot spin forever. Fixtures one level down (the `sweep-child.ts` cleaner, the
`stay.test.ts` owners) `STAY` on their own parent via `stayFor`. `stay.test.ts` covers both guards,
including a stubbed `ps` that exits 143 (loop keeps running) or 1 (loop ends).
The diff tests' SIGTERM-resistant shim prints a readiness marker after its trap and fork; only then
does the test admit fake timeout clocks, so a SIGTERM cannot land before the trap.
Extension fixtures always emit shutdown in `afterEach`, including after assertion failures. A nested
Vitest regression bypasses `scripts/run-vitest.ts`, so it reuses the launcher's exported
`isolatedHomeEnv` and checks the child saw that `HOME`. It covers both a SIGKILLed worker and a
failed assertion (via the fixture's own `afterEach` dispose) and observes both the detached
`STAY_GROUP` leader and an in-group descendant disappearing. Liveness there is read from process
state, so an unreaped zombie (non-reaping PID 1) counts as dead.
Native stop/dispose checks assert direct children are reaped when the operation resolves, then
observe orphaned descendants disappearing with the existing bounded liveness check. Leader exit
and pipe closure do not synchronize PID 1's reaping; on Linux, `kill(pid, 0)` can still succeed
for a terminated zombie. No extra signal, fixed delay or larger timeout is needed.
The native diff descendant timeout fixture gates its fake deadline on real stdout readiness, so
slow process startup cannot race a fixed wall-clock deadline. Adapter fault tests cover monitor
startup/sweep/widget failures, post-spawn errors, worker startup timeout, rejected sampler cleanup,
first/latest dropped-match evidence, title-stream failure and real rule reinjection after tree
navigation. Synthetic PIDs are never passed to real signal capabilities. Native Promise construction
initializes the monitor exit resolver before child handlers register; synchronous close/error
registration fixtures lock that ordering. The overwritten no-op resolver initializer is removed,
not a reachable validation or lifecycle path.
`npm run check` runs Biome, TypeScript, the full Vitest suite and `bun test test/scenarios` (Bun 1.4.4).
Cross-extension Plan/subagent/todo interactions and OS terminal boundaries remain in the integration tier;

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

- `npm run check` in `packages/session-kit`. The root lock pins a nested registry install
  (`packages/session-kit/node_modules/@nredd/pi-resource-sampler`, exact `0.2.1` tarball and
  integrity), so tests run the published bytes, not the same-version workspace that npm would
  otherwise link. `source.test.ts` fails if resolution ever reaches the workspace.
  - `test/mon/source.test.ts`: two actual host observations (warming, then measured), a real poll's
    two updates, and mapping edge cases. In-flight close wraps the real sampler to hold its pending
    sample, then requires that sample to reject with `AbortError`, no update, no child and no timer.
    The check is timed by Node's `child_process` diagnostics channel, in the microtask after the
    first helper spawned, so it holds for a late spawn and for a helper that already exited, and it
    fails at once if no helper spawned. On macOS it requires that child (`vm_stat`) in the process
    list, even as an unreaped zombie; Linux reads `/proc` in process and spawns only `getconf`, so
    there the `AbortError` is the only provider evidence and no listed child is claimed.
  - `test/mon/theme.test.ts`: actual built-in dark and light themes over an actual observation at
    40x12, 60x20, 80x24 and 120x40.
  - `test/scenarios/mon.test.ts` (Vitest and Bun): the real interactive Pi host and the real sampler;
    two observations, resize matrix, close/Escape/reopen, close before the first sample and session
    shutdown all leave no kit timer or child process. Registration, shutdown and close-before-sample
    go through `createSessionKit`. The observation cases call `registerMon` directly, with the real
    sampler wrapped only to observe each resolved scan,
    then check the frame against that scan: its exact process count, and its `time budget` notice
    when a loaded host runs out of the 250ms scan budget. They never poll frames for a full scan,
    which only a later fake-clock tick could bring.
  - `test/mon/{component,poll,index}.test.ts`: layout, identity, history, lifecycle interleavings
    with fakes; `resource-fixture.ts` is type-checked against the package's `ResourceSnapshot`.
- `make check-package-contracts` packs session-kit, installs it alone (sampler from npm, exact
  lockfile closure) and drives it through stock Pi.
- Real macOS terminal recordings exercise the packed, registry-backed view, resize, navigation,
  close and reopen. Empty direct-child lists before and after close show only that no child was
  observed at those instants; they do NOT prove an in-flight helper was cancelled or reaped.
  In-flight cancellation/reaping evidence comes from the deterministic real-sampler tests above,
  not those terminal snapshots. No Linux terminal recording is claimed.
- Manual fixture preview (no sampling): `bun test/mon/terminal.ts dark|light`. It is labelled
  `FIXTURE DATA` and uses `fixture-*` names, so a capture can never pass for host data; it is not
  evidence of real measurements.

## Offline stats and portable snapshots

Build the committed `dist/pi-stats-export.mjs` with `npm ci && npm run build:stats-export`.
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
node ARTIFACT import --agent-dir DIR --input REPO
```

`--agent-dir` defaults to `PI_CODING_AGENT_DIR`, then `~/.pi/agent`. The session root defaults to
`PI_CODING_AGENT_SESSION_DIR`, then `DIR/sessions`; `--sessions-dir` takes precedence. History
already cached under former roots is retained, even after files disappear. Paths are resolved
locally and never exported. Run export before fetch/commit/push, then import the updated data
checkout. Git, locking concurrent sync runs, retrying pushes and network deadlines belong to the
sync helper, not this data-only artifact.

CLI results:

- Export: `{ "machineId": "<UUID>", "snapshotDir": "<OUT>/machines/<UUID>" }` on stdout.
- Import: `{ "imported": N, "retained": N, "problems": [], "importedAt": MS }` on stdout.
- Exactly one JSON object is emitted. Diagnostics go to stderr. Invalid commands, malformed local
  scans, unwritable caches and publication failures exit nonzero. Partial/corrupt imports emit
  a JSON result and exit nonzero, retaining every failed machine's last-good snapshot.
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
- `DIR/pi-session-kit/stats-global.json`: one atomically replaced document containing validated
  last-good machine snapshots, last successful import time and coverage problems. Imports do not
  mutate local usage or installation identity. A wholly failed import does not advance the sync
  time; a partial import records valid updates and marks coverage incomplete. The assembled cache
  accepts up to 128 MiB; exceeding that limit fails before replacement and retains its last-good
  bytes. Tests inject final-document byte accounting at the exact limit and one byte over, while
  retaining real import validation and atomic publication.

Snapshot version 1:

```
machines/<UUID>/manifest.json
machines/<UUID>/<YYYY-MM>-<sha256>.json
```

Manifest exact keys:

- `version`: `1`.
- `machineId`: persistent UUID v4, matching its directory.
- `label`: installation label, maximum 1024 characters. Not a session name.
- `exportedAt`: positive UTC Unix milliseconds.
- `shards`: unique month references, each exactly `{month, file, sha256, bytes}`. `file` MUST
  equal `<month>-<sha256>.json`. No absolute paths, traversal or arbitrary filenames.

Shard exact keys: `{version, machineId, month, events, sessions}`. All shard JSON is canonical
`JSON.stringify` output (no indentation/newline), bounded to 128 MiB per file. Manifest hashes
cover exact UTF-8 shard bytes. Immutable content-addressed shards are published first, manifest
last; unreferenced old shard generations are deliberately retained and ignored. No cleanup races
with readers. Each manifest references exactly one shard per month.

Event exact keys:

- `id`: SHA-256 event fingerprint.
- `entryId`: SHA-256 of `entry:<preserved assistant entry ID>`, or `null` for legacy records.
- `sessionId`: opaque session ID.
- `ms`: original positive UTC Unix milliseconds, in the shard's UTC month.
- `provider`, `model`: raw physical attribution, each nonempty and at most 1024 characters.
- `input`, `output`, `cacheRead`, `cacheWrite`: nonnegative safe integers, not all zero.
- `cost`: finite nonnegative recorded notional cost.

The identified fingerprint is SHA-256 of the JSON array
`[entryId, ms, provider, model, input, output, cacheRead, cacheWrite]`.
Notional price changes do not create new events. Different entry IDs survive equal usage. Copied entries across forks/machines count once. Legacy
fingerprinting and matching use `[provider, model, ms, input, output, cacheRead, cacheWrite]`,
intentionally without cost to preserve the old tuple rule; identified counterparts supersede
legacy duplicates.

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
