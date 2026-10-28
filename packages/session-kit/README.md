# pi-session-kit

Published to npm as `@nredd/pi-session-kit` (public). From `0.4.0`, each version is cut by the monorepo `Publish` workflow from a signed `@nredd/pi-session-kit@<version>` tag, with npm provenance and a GitHub release carrying the tarball, checksums and manifest (`docs/releases.md`); earlier versions were published manually without provenance. `0.4.0` adds `createSessionKit(options)` (explicit `config`, `agentDir`, `monitorRoot`, injectable `clock` and `spawnMonitor`; the default export is unchanged) and fixes leaderless orphan-group sweeps at `ps` start-time resolution. `0.5.0` redesigns `/stats` around the full pane (pinned header, aligned stat cells, a Models table on wide panes) and gives every chart a clock- or calendar-aligned time axis, including the 5h and 24h hourly views.
Use the [monorepo development commands](https://github.com/nredd/pi-harness/blob/main/README.md). The Git install and standalone harness
references below describe the legacy deployment, not installation or candidate verification of
this package. `0.6.0` keeps passive monitor output only in the monitor ring buffer rather than adding it to the transcript or model context; `monitor_read` is the explicit output surface, and match/exit/timeout wakes are compact summaries with a cursor. `0.7.0` adds the `/stats` Machines tab with per-machine producer export age, separate from the viewer's last import, and the collapsible monitors widget. `0.8.0` adds `/mon`.

## Standalone use

The packed tarball is self-contained: Pi host modules (`@earendil-works/pi-*`, `typebox`) are `*` peers supplied by Pi, and no sibling plugin is required. Its only runtime dependency is the exact published `@nredd/pi-resource-sampler@0.1.1` library (no Pi imports), which npm installs from the registry for `/mon`. Verified by installing the tarball alone and running it in exact stock Pi 1.3.0 (see the repository's `docs/package-contracts.md`). Optional fork integrations (subagents, Plan mode) are absent in that setup; the exercised behavior does not need them.

Session-scoped pi extensions for tmux users. No daemon, supervisor, core patch or cross-pane
registry. Each runtime owns its goal, loops and monitors; persisted goal state follows the active
session branch. Closing pi stops its work.

`/mon` opens a read-only, full-pane view of local CPU, memory, load and processes, sampled
every ~2s by the shared `@nredd/pi-resource-sampler` library only while it is open. Details and
limits (macOS native CPU/footprint require the upcoming sampler pin, executable names keep 16 bytes,
RSS excludes compressed pages, `f` toggles a labelled footprint column,
and memory labels state their measurement basis) are in
[docs/mon-dashboard.md](docs/mon-dashboard.md). It is not a second `/monitor` process runner.

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

Every module defaults on. Malformed config reports a diagnostic and uses defaults. SDK hosts can use
`createSessionKit({ config, agentDir, monitorRoot })` from `src/index.ts`: explicit `config` avoids
loading the config file, `agentDir` scopes config/rules/title aliases, and `monitorRoot` isolates
monitor pidfiles and orphan sweeps. Optional `clock` (`now`, cancellable `setTimeout`/`setInterval`)
and `spawnMonitor` seams control scheduling and child lifetime in SDK tests; the real manager,
ring, coalescer, regex worker and host follow-up queue still run. Controlled stdout callbacks resolve
after matching/ingestion; native pipe events need not await them. Omitted options keep the CLI defaults. No daemon or
persistent cron is installed. Deferred-tool configurations need `goal_update` in `neverDefer`
(without forcing it active), and `monitor_read` in `alwaysActive` and `neverDefer` for Plan mode.

## Goal and loop

- `/goal <objective> [--turns N] [--tokens N]`: keep working toward an explicit objective. Default
  budget: 30 parent turns. Token accounting uses reported usage. `status`, `pause`, `resume` and
  `clear` manage it; the footer chip shows turn and token consumption.
- `goal_update({status: "complete" | "blocked", evidence})`: complete requires nonempty evidence.
  This is a self-report, not an independent verifier; it does not replace tests or todo evidence.
- The settle nudge respects existing continuations, background-agent delivery and Plan permissions.
  Abort, settled provider error, budgets and a Plan-mode excursion pause/stop it. Resume restores a
  goal paused. Quota recovery is left to the router; a parked dispatch or direct refusal pauses
  goals and loops, cancels goal wake timers, and requires explicit resume. Goal resume is refused
  while a quota-parked dispatch remains. A settled provider failure also pauses rather than spinning.
- `/loop <interval> <prompt> [--max N]`: repeat a prompt in the current conversation, unlike
  `Agent({schedule: ...})`, which launches fresh children. Minimum interval 30s; maximum 50 runs.
  `list` and `stop [id|all]` manage loops. Busy ticks are skipped, never queued. Plan mode and an
  active goal suspend ticks; settled errors pause loops. Loops are not persisted across restarts.

## Monitor

- `monitor_start({argv, name, match?, wake?, timeout_s?})`: run an argv command with stdin closed,
  no implicit shell. Five active monitors maximum, one-hour default timeout, 7 day (`604800` s) maximum. Explicitly passing a
  shell remains arbitrary command execution; this is not a sandbox.
- `monitor_read({id, since?})`: numbered output since a cursor. Ring buffers retain 2000 lines.
- `monitor_stop({id})`, `/monitor list`, `/monitor stop <id|all>`: stop and inspect owned monitors.
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
Print/JSON output includes the same provenance. Details: [here](docs/stats-snapshots.md).

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
  are reparsed for preserved IDs. A corrupt record is dropped and rebuilt. Lines that are not JSON
  objects show as `! N unreadable lines`.
- Print mode prints a per-model table and coverage; JSON emits a display message. Works in Plan mode.
- After `make install` at the monorepo root, `npm run build:stats-export --workspace @nredd/pi-session-kit`
  reproduces `dist/pi-stats-export.mjs` inside this package. Copy this standalone Node 22+ artifact
  to another machine: neither Pi nor the loaded session-kit extension is needed at runtime.
  `node ARTIFACT export --agent-dir DIR --output OUT` writes ONLY `OUT/machines/<UUID>/`.
  `node ARTIFACT import --agent-dir DIR --input REPO` validates all machines and atomically
  publishes the local global cache. Both emit one JSON object on success; partial imports emit
  JSON and diagnostics with a nonzero exit. No Git/network operations are part of the CLI.
  Schema, identity, atomicity and harness API details: [here](docs/stats-snapshots.md).

## Titles and rules

- Titles: one attempt after the first eligible TUI run of an unnamed persisted session. Default
  candidates are Haiku 5.5, validated enterprise alias candidates (including the legacy Haiku 4.5
  logical key), then GPT 6 Luna. `titles.model` overrides the preferred candidate. No silent retry
  after provider failure; explicit names and session switches win races. Children, headless runs,
  no-session runs and active planning are skipped. Output is capped at six words/60 characters;
  shorter names are accepted.
- Rules: Markdown files in `.pi/rules/` and the agent directory's `rules/`, with YAML frontmatter
  `paths: ["src/**/*.ts"]`. No `paths`, no injection. Successful read/edit/write results receive
  matching rules once per context lifetime. Compaction resets deduplication. Eight rules per turn,
  4096 UTF-8 bytes per appended block. The system prompt is not rewritten. Rules injected after an
  edit inform subsequent work, not the edit already performed.

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
tabs and exact provider totals remain covered at every width. Each stats-view body owns its fixture
and disposes it in `finally`, so runner timeout teardown cannot race a still-running callback.
Monitor scenarios use a shared fake clock and controlled children; native `test/monitor/` keeps real
workers/processes, and process-group kill/orphan recovery stays in the assembled integration tier.
`npm run check` runs Biome, TypeScript, the full Vitest suite and `bun test test/scenarios` (Bun 1.3.14).
Cross-extension Plan/subagent/todo interactions and OS terminal boundaries remain in the integration tier;
`docs/verification-rebuild.md` at the monorepo root tracks their destinations.
