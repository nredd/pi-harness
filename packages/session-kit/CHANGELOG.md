# Changelog

## [Unreleased]

- Export Claude Code, Codex and OpenCode usage: snapshot version 2 adds `harness` on events, a nullable `cost` (`null` for Claude and Codex, not 0) and quota observations (freshest `observedAt` per `(provider, limitId, window)` wins across machines); `harness` joins the event fingerprint and the dedup key; v1 snapshots still import as `pi`. `pi-stats-export export` gains `--harness` (default `pi` only) and `--claude-dir` / `--codex-dir` / `--opencode-db`. The harness cache is bumped to version 3. Quota readings carry an `account` (salted local hash of the harness's account ID, `""` when none) so two accounts do not merge, and an expired reading never beats a live one. Export state (`export-state.json`: salt and published harness set) refuses a narrower `--harness` than last published unless `--replace-harnesses`; a harness that fails mid-export keeps its last published contents instead of aborting. `loadCombined` returns only pi events from imported machines until `/stats` labels harnesses. Counts only; `/stats` display follows (part of [#367](https://github.com/nredd/pi-harness/issues/367))

- Add readers for Claude Code, Codex CLI and OpenCode usage in `src/stats/harness/` and a `harness` field on `Call` (pi calls are `"pi"`), with entry dedup by `(message.id, requestId)` for Claude, per-turn Codex records joined to their model, Codex `rate_limits` quota observations and a read-only WAL-aware OpenCode query. Counts only; not yet exported or shown in `/stats` (part of [#367](https://github.com/nredd/pi-harness/issues/367))

- Cover omitted stats API arguments and remove the unreachable private help default; preserve the stats library's runtime/type export contract with a validated named facade. Full local Node/Bun L/F/B/S reports are zero-miss; hosted zero receipts remain required before Bun enforcement (#824)

- Isolate monitor regex workers in a killable child process so Bun cleanup does not wait for `Worker.terminate()`; preserve match ordering and existing deadlines, reap on close, and exit on parent IPC loss even during backtracking (#320)
- Run the full session-kit suite through the disposable-home Vitest launcher on Bun; retain report-only enforcement until the remaining stats branch/facade work is admitted (#320)

- Pin published `@nredd/pi-resource-sampler@0.2.1` for `/mon`, removing the known Linux `/proc` iterator PID-exit collection race (#499); the historical #557 WSL incident errno remains unproven

- Add an optional `todo` (an id, or a list of up to 20) to `monitor_start`, and carry `wake`, `match` and `todos` on `session-kit:monitor:started` / `:stopped` (`{ sessionId, id, name, wake, match?, todos? }`), so todo can show the linked work as waiting on the monitor instead of held; a monitor without `todo` no longer counts as a todo's continuation ([#522](https://github.com/nredd/pi-harness/issues/522))

- Skip all-NUL crash-padding lines in session JSONL instead of counting them as bad lines, so `exportStats` no longer fails closed on them ([#585](https://github.com/nredd/pi-harness/issues/585)); NULs mixed with data still count. Bump the stats cache to version 3: older entries with bad lines are marked stale (`size: -1`) and re-parsed whenever their root is next listed; records for deleted or out-of-root files are kept. A migrated record for a since-deleted file keeps its old `badLines` (it cannot be re-derived), so export still fails closed for it

- Cover every `/stats`, title and rule branch ([#408](https://github.com/nredd/pi-harness/issues/408)); remove unreachable fallbacks (`stats/nth.ts` replaces `?? default` after bounded index reads) and drop the primary branch cap to 0

- Emit `session-kit:monitor:started` and `session-kit:monitor:stopped` on `pi.events` (`{ sessionId, id, name }`; once per monitor, `stopped` also at session shutdown) so other extensions can tell a wake is armed ([#586](https://github.com/nredd/pi-harness/issues/586), part of [#522](https://github.com/nredd/pi-harness/issues/522))

- Stop counting a background agent stopped before it starts as awaiting a completion notice ([#525](https://github.com/nredd/pi-harness/issues/525)); started background agents still wait for their notices

- Report a run that settles with monitors running, naming what each is armed to wake the parent on: `every batch`, its `/match/` (terminal controls stripped), or exit ([#292](https://github.com/nredd/pi-harness/issues/292))
- Add a `homeDir` option to `createSessionKit`: config, rules, title aliases and stats session/cache defaults derive from it when no `agentDir` is given; `PI_CODING_AGENT_DIR` still wins
- Remove the `agentDir` re-exports from `src/config.ts` and `src/stats/load.ts`; deep imports now use `src/agent-dir.ts`. The rules `register` takes `{ agentDir, homeDir }` like titles and stats and resolves the user rule directory at use time

- Make configured `titles.model` selection fail closed: invalid, unavailable and unauthenticated configured models now skip title generation rather than trying aliases or defaults

- Make the portable stats CLI import-safe: importing `dist/pi-stats-export.mjs` no longer runs an operation; direct Node execution still runs it

- Replace `/mon`'s ambiguous non-free label with `total-free` (`T-F` compact); accept additive native App+Wired+Compressed and swap metrics without silently substituting free-page subtraction
- Accept native macOS interval CPU and footprint; add `f` to toggle the labelled byte column between `RSS` and `FOOT`, with failed measurements shown as `--`
- Explain RSS versus footprint, compressed pages, executable names (`pi` as `node`), strong native identity and unavailable-CPU fallback in `?`; native metrics require the subsequent published sampler dependency bump

- Raise the `monitor_start` `timeout_s` cap from 24h to 7 days (`604800`) so monitors can outlive long jobs

## 0.8.0

- Add `/mon`: a read-only TUI dashboard of host CPU history, non-free memory, load and sampled processes, on by default (`mon.enabled`)
- Depend on the exact published `@nredd/pi-resource-sampler@0.1.1` (executable names, never argv or process titles; Bun host CPU measured), locked as a nested registry install so tests never borrow the workspace copy; one sampler per open view, disposed (children reaped, no timers) on close, session shutdown or replacement
- Map warming/unavailable metrics to `--`, never zero; split warnings (budget-limited lists, unavailable host CPU) from muted platform hints (Linux kernel-thread skips, unknown names, macOS process CPU)
- Render unreadable names as `(unknown)` and mark macOS names that may be cut at 16 bytes with `…`
- Header shows collector state with the last successful collection's local time; every resolved sample counts as live, separate from host CPU `warming`/`unavailable`
- Side-by-side cards from 72 columns with a two-row CPU history at the observed monotonic interval; process table `PID CPU% RSS MEM% NAME` with a selection marker and overflow scrollbar
- Pack `docs/mon-dashboard.md`, which the README links

## 0.7.0

- Add a `/stats` **Machines** tab (Tab/Shift-Tab): each known machine's label and opaque UUID, local scan status, and remote producer `exportedAt` UTC instant plus age at opening
- Label the header clock `viewer last import` (or `viewer never imported`); it is not producer freshness, so an old export stays old after a fresh import
- Flag future export clocks as `future; clock skew`, absent/invalid timestamps as `unknown`, and missing/rejected sources with `Incomplete import; retained last-good snapshot`; print/JSON output carries the same provenance
- Keep snapshot schema v1 and the exporter CLI contract unchanged; existing snapshots need no migration or re-export
- Redesign the monitors widget like the Todos and subagents panels: disclosure heading with running/failed/done counts, one bulleted row per monitor (running, matched, failed, exited) with flush-right `elapsed · N lines`, and a constant-height window with `↑/↓ N more`
- Collapse with a heading click or `monitor.collapseKey` (default `ctrl+shift+m`, `"off"` disables, validated with the rpiv-todo key grammar); cap rows with `monitor.maxWidgetLines` (default 12, minimum 4)
- Keep finished monitors visible beside running ones while any monitor runs; the widget still never writes to the transcript or model context
- Add `MonitorInfo.matches` and `KitConfig.monitor`; hosts passing a config without `monitor` get the defaults

## 0.6.0

- Keep passive monitor output only in the monitor ring buffer; `monitor_read` is the explicit output surface and match/exit/timeout wakes are compact summaries with a cursor
