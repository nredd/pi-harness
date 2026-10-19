# TUI latency with several sessions

Symptom: keystrokes, streaming and clicks get slow with several pi sessions open, while CPU,
GPU and RAM stay low. Terminals: Ghostty (macOS), Windows Terminal (WSL2).

## Instrument

`probes/latency.ts`, loaded with `-e`. One JSONL line per window:

- `loop_lag_ms` -- drift of a 10 ms timer; `stalls` lists ticks late by 50 ms or more, with timestamps
- `write` -- bytes, calls and bytes/s of `terminal.write`, plus `max_block_ms` (time inside the write, i.e. stdout backpressure from a slow terminal)
- `input_to_paint_ms` -- stdin data to the next `terminal.write` (excludes the terminal's own paint)
- `fs` -- type, `stat` and `fsync` latency of the agent dir (`/mnt/c` vs ext4 is a suspect on WSL2)
- `start` line -- platform, `wsl`, node, cpus

Calibration lives in `scenarios/bench/test_multisession.py`: a separate premeasurement process must capture the TUI and report a forced 400 ms block (320..1200 ms). Every measured pane needs a start/TUI record and summary windows; typing needs >=4 input-to-paint samples with p95 <500 ms, idle panes stay <200 B/s individually and <100 B/s combined. The calibration process cannot contaminate fleet windows. This merge is implemented but unexecuted: no quiet runner exists, and bench runs neither locally on the owner's Mac nor in hosted CI.

## Run it in your real sessions (manual)

Neither Ghostty nor Windows Terminal (ConPTY) can be driven from the harness, so run the probe in
the real thing:

```sh
PI_LATENCY_PROBE=/tmp/pi-lat-$$.jsonl pi -e ~/code/pi-harness-e2e/probes/latency.ts
```

Open 4 to 8 tabs like that, work normally until it feels slow, then:

```sh
tail -n 3 /tmp/pi-lat-*.jsonl | jq -c 'select(.kind=="summary") | {pid, lag: .loop_lag_ms.p99, stalls: (.stalls|length), bps: .write.bytes_per_s, block: .write.max_block_ms, in: .input_to_paint_ms}'
```

Reading it:

- Loop lag and `input_to_paint_ms` clean but it still feels slow -> terminal side. Check `bytes_per_s` summed over tabs and `max_block_ms`
- Lag spikes -> pi side. Match `stalls[].at` against the 60 s footer quota poll, fleet ticks, router RPC, file locks on the shared agent dir
- Large `max_block_ms` -> the terminal (or ConPTY) is not draining stdout fast enough

## What the harness found (macOS, 10 cores, faux providers, shared agent dir)

Fleet of N panes, paced 9000-char reply in every pane, 20 keystrokes typed into pane 0
(`harness/fleet_load.py`, numbers from the probe):

Empty transcript:

| N | input p95 | loop lag p99 | output |
| --- | --- | --- | --- |
| 1 | 2.5 ms | 8 ms | 23 KB/s |
| 8 | 1.6 ms | 8 ms | 158 KB/s |

Resumed 2000-message transcript:

Measured on core `1.0.0-nredd.5`:

| N | input p95 | loop lag p99 | stalls | output |
| --- | --- | --- | --- | --- |
| 1 | 87 ms | 163 ms | 41 | 14 KB/s |
| 4 | 108 ms | 117 ms | 150 | 60 KB/s |
| 8 | 209 ms | 212 ms | 258 | 95 KB/s |

- An empty-transcript pi is fine at N=8: the pi event loop is not contended by other sessions
- Cost is per-frame render work on a long transcript: ~80 ms per keystroke at 2k messages even when idle (20 stalls for 20 keys), matching `render_2k_frame_ms`. It is single-threaded, so it blocks input and streaming together
- FIXED in core `1.0.0-nredd.6`: collapsed `OneLineRow`s re-rendered and re-stripped every settled entry on every frame (at two widths). Settled rows now cache per width until invalidated. N=4 went from 93 ms input p95 / 100 ms loop lag p99 to 9 ms / 20 ms on a quiet machine; `render_2k_steady_over_full` guards it
- At N=8 the same work is about 2.4x slower per session with CPU still available, so something shared is contended (candidates: the terminal-side tmux servers here, memory bandwidth, efficiency cores). Not yet attributed
- Idle panes write nothing
- Output per streaming pane is ~18x the streamed text rate, so the terminal sees 100+ KB/s across tabs. Ghostty/ConPTY cost cannot be measured here; use the live probe above

Next: run the live probe in Ghostty and Windows Terminal and compare against a fresh table on `nredd.6`.
Fixes belong to the owning repo (core render path: differential output; the N=8 contention above).

## Gate

`scenarios/bench/test_multisession.py` (`bench`, `slow`; N in 1, 4, 8, 3 samples, ~3 min):

- Per-OS baselines, +20%: `ms_input_p95_n4`, `ms_loop_lag_p99_n4`
- Ceilings, same on every machine: N=8/N=1 ratio of input p95 (5.0) and loop lag p99 (4.0); idle bytes/s at N=8 (100)
- WSL2 keeps `bench.linux.json`. Recording writes `_meta` (`wsl`, `cpus`); a run on a different `wsl` value warns
- On the WSL2 laptop the baselines for the two per-OS metrics are missing until you run
  `UPDATE_BASELINES=1 uv run pytest scenarios/bench/test_multisession.py`; the ceilings work unrecorded
