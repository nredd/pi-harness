# /mon resource dashboard

`/mon` is a read-only, interactive-TUI view of local host resources. It is on by default and
disabled with `{ "mon": { "enabled": false } }` in `pi-session-kit.json`. In RPC/print/JSON modes
it only warns; it never samples there.

## Source

`src/mon/source.ts` is a thin mapping over the published `@nredd/pi-resource-sampler`, declared
as the exact runtime dependency `0.1.1` (`0.1.0` leaked argv-style process titles as macOS names
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
- macOS process interval CPU is always unavailable (the sampler's `ps` start time has one-second
  precision, so PID reuse cannot be excluded). The view says so, explains it in help, and orders by
  RSS until the user picks a sort. Linux first samples are warming, so CPU order stays stable.
- History spacing uses the sampler's monotonic `monotonicTimeMs`, so wall-clock steps (NTP, manual
  changes) cannot invent or hide gaps; the wall `wallTimeMs` is only displayed (header clock and
  last-success UTC).
  Node's monotonic clock pauses during system sleep on macOS and Linux, so a suspend shows no gap.
  `scan Nms` (80+ columns) is the sampler's collection duration. Missing/zero memory totals and non-finite values become unknown.

## Presentation

- From 72 columns and 18 rows, CPU and memory/load cards sit side by side; CPU history is two rows
  (16 levels) there. Narrower or shorter terminals get a three-line summary (`CPU`, `RAM`, 1-minute
  load, one-row history); at six rows summary/chrome yields to the selected process. The last row
  reserves close/help. Below 60 columns the header keeps the update clock over the tagline.
- Columns: `PID`, `CPU%` (100 = one core), `RSS`, `MEM%` (RSS over total RAM, 60+ columns),
  `NAME` last so long names never push numbers off screen. `--` is dimmed. A `▸` marks the
  selection; a theme scrollbar appears only when the list overflows. The memory card adds 1-minute
  load per logical CPU.
- Host CPU severity colors the value (success under 50%, warning under 85%, error above) next to
  the number itself.
- Host CPU history keeps each capture timestamp, uses a fixed 0..100% scale and at most 120
  samples, newest on the right. A column is the lower-median interval between captures, widened
  only when the history is longer than the width, so completion-paced drift never invents gaps.
  Columns with no CPU value after the first one are gaps (`·`), never zero or interpolation;
  columns before it are blank, including the warming baseline. Stale snapshots add no point. The caption states the actual span. The latest sample in a bucket wins.
  Stale views show the last successful capture's UTC timestamp (or `none`). Waiting/live/stale and
  CPU warming/unavailable use semantic theme colors and text, so meaning does not depend on color.
- Memory is total minus free, explicitly **non-free**, not available memory or a pressure score
  (on macOS free pages are small by design). Load averages are not percentages. Process CPU is
  interval CPU, where 100% is one logical CPU and multithreaded processes can exceed 100%.
- The process viewport preserves selection by sampler identity, not PID or sorted row.
  Exited identities choose a bounded neighboring row; PID reuse cannot inherit selection.
  Unknown/non-finite measurements sort last with deterministic PID/identity tie breaks.
- `j/k` and arrows select; PageUp/PageDown page; `g/G` jump first/last; `c/m/p` sort
  CPU/RSS/PID; `s` cycles sort; `?` toggles help; `q`/Escape close. CPU/RSS descend,
  PID ascends. Help has a bounded, wrapped viewport with a visible range and scroll hint;
  `j/k`, arrows, PageUp/PageDown and `g/G` scroll help without moving the process selection.
  No kill, locks, workload control, process arguments or environment display. Process names
  are the sampler's sanitized display names and are never interpreted.

## Ownership

`MonView` accepts presentation snapshots and never collects data. It caches rendered lines
by dimensions until update/input/theme invalidation. `MonPoll` owns one completion-paced probe
(~2s after the previous one completed), with no catch-up queue. Closing aborts collection,
cancels the timeout and awaits the sampler's disposal. Errors stop collection and retain
explicitly stale values; reopening is the retry mechanism. Late results are discarded.

`registerMon` opens a source only inside a TUI interaction and serializes replacement through
completed asynchronous disposal, including concurrent opens. Session shutdown/start invalidates
pending openers before they can create a source, even when Pi defers the UI factory. It registers
no model tool, persists no history, sends no model messages and does no network work.

## Verification

- `npm run check` in `packages/session-kit`. The root lock pins a nested registry install
  (`packages/session-kit/node_modules/@nredd/pi-resource-sampler`, exact `0.1.1` tarball and
  integrity), so tests run the published bytes, not the same-version workspace that npm would
  otherwise link. `source.test.ts` fails if resolution ever reaches the workspace.
  - `test/mon/source.test.ts`: two actual host observations (warming, then measured), a real poll's
    two updates, and mapping edge cases. In-flight close wraps the real sampler to hold its pending
    sample, then requires that sample to reject with `AbortError`, no update, no child and no timer.
    On macOS it first requires the sampler's live `ps` child; Linux reads `/proc` in process, so
    there the `AbortError` is the only provider evidence and no child is claimed.
  - `test/mon/theme.test.ts`: actual built-in dark and light themes over an actual observation at
    40x12, 60x20, 80x24 and 120x40.
  - `test/scenarios/mon.test.ts` (Vitest and Bun): the real interactive Pi host, `createSessionKit`
    and the real sampler; two observations, resize matrix, close/Escape/reopen, close before the
    first sample and session shutdown all leave no kit timer or child process.
  - `test/mon/{component,poll,index}.test.ts`: layout, identity, history, lifecycle interleavings
    with fakes; `resource-fixture.ts` is type-checked against the package's `ResourceSnapshot`.
- `make check-package-contracts` packs session-kit, installs it alone (sampler from npm, exact
  lockfile closure) and drives it through stock Pi.
- Manual fixture preview (no sampling): `bun test/mon/terminal.ts dark|light`. It is labelled
  `FIXTURE DATA` and uses `fixture-*` names, so a capture can never pass for host data; it is not
  evidence of real measurements.
