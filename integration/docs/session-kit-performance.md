# Session-kit performance diagnosis, 2026-10-12

The dominant regression was host power state, not a session-kit renderer. Detached tmux
benchmarks ran during repeated macOS maintenance sleep/dark-wake cycles. Four panes, including
the no-kit control, simultaneously stalled for 42.7 seconds. Low CPU was not evidence of cheap
turns. `pmset -g log` recorded, for example:

```text
2026-10-12 14:51:16 Sleep     Entering Sleep state due to 'Maintenance Sleep' ... 18 secs
2026-10-12 14:51:34 DarkWake  DarkWake from Deep Idle ...
```

Holding a command-scoped `/usr/bin/caffeinate -disu` assertion made all five original failing
benchmark tests pass without changing extension code, input, thresholds, or baselines. The
session-scoped `awake_host` fixture now does this for direct pytest invocations too. `-w`
tracks the pytest pid, releasing assertions even after an interrupted run; normal teardown
terminates and waits for the helper. No persistent power settings are changed. Linux is a
no-op. The deterministic regression is `tests/test_power.py::test_runner_holds_assertion`:
red without the fixture, green with it, in approximately 0.05 seconds.

A separate teardown defect left test-owned tmux servers behind when the first-frame wait
failed before the caller received its pane. `launch_tui` now kills its private server on
failed starts/waits, including interruptions. Both failure seams went red before the fix.
Two pre-existing `pih-*` servers were counted; cleanup only addressed known harness sockets,
never the user's tmux. No live `pih-*` server remained after the final measurements.

Original benchmarks, unchanged:

| Metric | Red | Fixed |
| --- | ---: | ---: |
| `ms_input_p95_n4` | 14.4338 ms (limit 9.903) | 8.2656 ms |
| `render_2k_frame_ms` | 120.0589 ms (limit 101.086) | 84.5131 ms |
| `startup_first_frame_s` | previous full gate failed | 0.6094 s |
| `ms_loop_lag_p99_n4` | sleep-contaminated | 17.3840 ms |
| `render_2k_heap_mb` | not checked after first failure | 78.6082 MB |

The original render/startup/multi-session tests passed twice after holding wake assertions:
first with an external command wrapper (212.06s), then with the fixture alone (210.85s).
`npm run check` in `pi-session-kit` passed all 391 tests; harness unit tests passed all 70.
`pi-dev-tools` also timed out its cross-process lock test without assertions, then passed
all 297 tests under `/usr/bin/caffeinate -disu npm run check`, without any source changes.
The full serial `make verify` remains the next gate, deliberately not run here.

Controlled module probe:

```sh
HARNESS_LOCAL=pi-session-kit,pi-dev-tools uv run pytest \
  probes/test_kit_overhead.py -q --log-cli-level=WARNING
```

Every cell uses four shared-agent-dir panes, the same generated 2k history, 9000 reply
characters at 300 tokens/s, and 20 keystrokes. Three-sample medians match the original
benchmark's method. Title-enabled controls use `faux/main`, never a real provider. All
configuration edits are sandbox-local, preserving live config and source pins/order.
`startup_s` below is total sequential launch time for all four resumed panes, not cold
first-frame latency for one pane. All controls wrote **0 idle B/s** and recorded **0 stalls**.

| Enabled | Startup, seconds | Input p95, ms | Loop p99, ms |
| --- | ---: | ---: | ---: |
| All off | 6.089 | 8.221 | 17.319 |
| All on | 6.126 | 9.516 | 16.502 |
| Kit absent | 6.022 | 8.709 | 17.467 |
| All on, expanded footer absent | 6.099 | 8.144 | 14.256 |
| Titles only | 6.144 | 7.602 | 20.237 |
| Rules only | 6.101 | 8.491 | 18.653 |
| Goal only | 6.107 | 8.466 | 18.530 |
| Loop only | 6.080 | 8.292 | 16.487 |
| Monitor only | 6.088 | 8.869 | 16.762 |
| Diff only | 6.077 | 8.552 | 17.968 |

All ten controls passed the existing input-latency baseline and idle ceiling in 450.02s.
A single-sample exploratory diff-only cell measured 11.417ms; the same control's three-sample
median passed. The diagnostic intentionally uses the original median method rather than
turning one noisy cell into a new gate.

The footer cache analyzer alone took 0.0064ms/call over 10,000 calls on the same-size 2k
history. That does not explain the earlier 4-6ms input gap or synchronized seconds-long
stalls. There was no evidence for changing footer analysis, rendering tiers/widths, or
readonly rendering. Kit/core/footer code was left unchanged by this diagnosis.

Artifacts for this run: `/tmp/perf-current.log` (original red), `/tmp/perf-render.log`
(render red), `/tmp/perf-fixed.log` (fixed metrics), `/tmp/kit-fixed-matrix.log` (controlled
medians), `/tmp/perf-kit-check.log` (package gate). No tags, commits, config apply, pins,
package-order changes, or baseline edits were performed.
