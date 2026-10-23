# Resource dashboard foundation

`src/mon/` is a fixture-tested dashboard and interaction shell, NOT an enabled `/mon`
command yet. `src/index.ts` deliberately does not register it. No production sampler,
workspace-only dependency, release, pin change or live activation is included.

## Presentation

- At 100+ columns, CPU history and memory/load cards sit side by side. At 60..99 they
  stack. Narrow or short terminals get the compact summary. The last row reserves close/help.
- Host CPU history uses a fixed 0..100% scale, at most 120 samples, newest on the right.
  Unknown/stale history points are gaps, not zero. Warming/live/stale states use semantic
  theme colors and text, so meaning does not depend on color.
- Memory is total minus free, explicitly **non-free**, not an estimate of available memory
  or a pressure score. Load averages are not percentages. Process CPU is interval CPU,
  where 100% is one logical CPU and multithreaded processes can exceed 100%.
- The process viewport preserves selection by sampler identity, not PID or sorted row.
  Exited identities choose a bounded neighboring row; PID reuse cannot inherit selection.
  Unknown/non-finite measurements sort last with deterministic PID/identity tie breaks.
- `j/k` and arrows select; PageUp/PageDown page; `g/G` jump first/last; `c/m/p` sort
  CPU/RSS/PID; `s` cycles sort; `?` toggles help; `q`/Escape close. CPU/RSS descend,
  PID ascends. No kill, locks, workload control, process arguments or environment display.

## Ownership

`MonView` accepts presentation snapshots and never collects data. It caches rendered lines
by dimensions until update/input/theme invalidation. Pi coalesces `requestRender` calls.
`MonPoll` owns one completion-paced probe, schedules the next timeout only after completion,
and has no catch-up queue. Closing aborts collection, cancels the timeout and awaits the
source's asynchronous disposal. Errors stop collection and retain explicitly stale values;
reopening is the retry mechanism. Late results are discarded.

`registerMon` requires an explicit source factory, opens it only inside a TUI interaction,
and closes on replacement/session shutdown/start. It registers no model tool, persists no
history, sends no model messages and does no network work. RPC/print/JSON cannot sample.

## Remaining integration boundary

Use the independently published `@nredd/pi-resource-sampler`, with a registry-resolvable
exact dependency, before enabling the feature in `src/index.ts` and configuration. The adapter
must map its available/warming/unavailable metrics without inventing zeros, expose partial
coverage and sampling age, distinguish unavailable memory from zero, use its stable process
identity, and await its `dispose()`. Do not copy its collector or import a workspace source path.

Publication/adapter/config integration, real-sampler lifecycle acceptance, packed-install
verification and full harness CI remain pending. The fixture preview is not evidence of real
resource measurements.

## Verification

- `npm run check` in `packages/session-kit` runs formatter/linter, types, Vitest and real-session
  Bun tests. `test/mon/` adds responsive/cache/identity/sorting/key and fake-clock lifecycle tests.
  `resource-fixture.ts` uses the actual v1 snapshot shape, compile-checked against PR122
  `e6bbe312eaa14f4920c47dc063c213fb36c3b077`'s exported `ResourceSnapshot` in the external
  `~/code/pi-harness-builds/mon-fixture-contract.ts` check. No source-path dependency ships.
  The Darwin fixture preserves available host CPU but unavailable process CPU; tests forbid
  replacing that unavailable value with zero.
- Manual real-terminal fixture: `bun test/mon/terminal.ts dark` (or `light`). This uses the
  actual Pi alternate-screen TUI and marks itself `FIXTURE / macOS process CPU unavailable`. Resize through 40x12,
  60x20, 80x24 and 120x40, navigate, toggle help and quit. It creates no sampling timers.
- Local acceptance captures: `~/code/pi-harness-builds/mon-evidence/` contains raw terminal
  write recordings, ANSI/plain tmux captures for both themes at all four sizes, navigation,
  help, and exit status (`1 0`: pane exited successfully). These are terminal recordings,
  not desktop screenshots and not live-sampler proof.
