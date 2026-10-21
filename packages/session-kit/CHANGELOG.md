# Changelog

## [Unreleased]

- Redesign the monitors widget like the Todos and subagents panels: disclosure heading with running/failed/done counts, one bulleted row per monitor (running, matched, failed, exited) with flush-right `elapsed · N lines`, and a constant-height window with `↑/↓ N more`
- Collapse with a heading click or `monitor.collapseKey` (default `ctrl+shift+m`, `"off"` disables, validated with the rpiv-todo key grammar); cap rows with `monitor.maxWidgetLines` (default 12, minimum 4)
- Keep finished monitors visible beside running ones while any monitor runs; the widget still never writes to the transcript or model context
- Add `MonitorInfo.matches` and `KitConfig.monitor`; hosts passing a config without `monitor` get the defaults

## 0.6.0

- Keep passive monitor output only in the monitor ring buffer; `monitor_read` is the explicit output surface and match/exit/timeout wakes are compact summaries with a cursor
