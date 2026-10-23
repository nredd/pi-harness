# Changelog

## [Unreleased]

- Add `/mon`: a read-only TUI dashboard of host CPU history, non-free memory, load and sampled processes, on by default (`mon.enabled`)
- Depend on the exact published `@nredd/pi-resource-sampler@0.1.0`; one sampler per open view, disposed (children reaped, no timers) on close, session shutdown or replacement
- Map warming/unavailable metrics to `--`, never zero; explain partial coverage, persistent warming and macOS's unavailable process CPU (default RSS order there)
- Draw CPU history newest-right at the observed monotonic sampling interval, so only real gaps render as `·` and the warming baseline stays blank
- Treat every resolved sample as a live collection, separate from host CPU `warming`/`unavailable`, so last success stays fresh
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
