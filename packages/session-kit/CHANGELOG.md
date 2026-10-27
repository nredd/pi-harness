# Changelog

## [Unreleased]

- Replace `/mon`'s ambiguous non-free label with `total-free` (`T-F` compact); accept additive native App+Wired+Compressed and swap metrics without silently substituting free-page subtraction
- Explain RSS versus footprint, compressed pages, executable names (`pi` as `node`) and unavailable macOS interval CPU in `?`; the native memory adapter requires the subsequent published sampler dependency bump

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
