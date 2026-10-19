"""Multi-session TUI responsiveness: N pi panes sharing one agent dir, each with a 2k transcript.

The user-visible slowdown (keystrokes and streaming lag with several sessions open, little CPU
used) shows up in the in-process latency probe (`probes/latency.ts`), not in a single-pane frame
time. Every cell resumes the same generated 2000-message session, streams a paced reply in all N
panes, and types into pane 0 meanwhile.

- Per-OS baselines (+20%): `ms_input_p95_n4`, `ms_loop_lag_p99_n4`.
- Ceilings, identical on macOS and WSL2: how much worse N=8 is than N=1 (`ratio_*`), and the
  bytes per second an idle pane writes (an idle pane must stay silent).
Windows Terminal (ConPTY) and Ghostty cannot be driven from here; see `docs/tui-latency.md`.
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING

import pytest

from harness.bench import check_against_baseline, check_ceiling, measure_many
from harness.fleet_load import IDLE_SCRIPT, launch_fleet, make_sandboxes, streaming_script
from harness.interactive import launch_tui
from harness.latency import latency_args, read_records, summarize
from harness.sessions import write_session

if TYPE_CHECKING:
    from pathlib import Path

    from harness.sandbox import Sandbox

pytestmark = [pytest.mark.bench, pytest.mark.slow]

TRANSCRIPT_MESSAGES = 2000
PANES = (1, 4, 8)
SAMPLES = 3
REPLY_CHARS = 9000
TOKENS_PER_S = 300
KEYSTROKES = 20
SETTLE_S = 2.0
IDLE_WINDOW_S = 5.0
RATIO_CEILINGS = {"ratio_input_p95_n8_n1": 5.0, "ratio_loop_lag_p99_n8_n1": 4.0}
IDLE_BYTES_PER_S_CEILING = 100.0
BLOCK_MS = 400


def calibrate_probe(sandbox: Sandbox) -> None:
    """Validate the deliberate stall in a separate process, outside every measured window.

    Parameters:
        sandbox (Sandbox): Explicit installed stack and scratch root.
    """
    out = sandbox.root / "calibration.jsonl"
    args, env = latency_args(out, 500)
    pane = launch_tui(
        sandbox, IDLE_SCRIPT, extra_args=args, env=env | {"PI_LATENCY_STALL_BLOCK_MS": str(BLOCK_MS)}
    )
    try:
        deadline = time.monotonic() + 15
        reading = summarize([])
        while time.monotonic() < deadline and reading.stalls == 0:
            time.sleep(0.3)
            reading = summarize(read_records(out))
        records = read_records(out)
        assert records, records
        assert records[0]["kind"] == "start", records
        assert records[0]["tui"] is True, records
        assert reading.stalls >= 1, records
        assert BLOCK_MS * 0.8 <= reading.loop_lag_max_ms <= BLOCK_MS * 3, reading
    finally:
        pane.kill()


def run_cell(sandbox: Sandbox, template_home: Path, count: int, *, stream: bool) -> dict[str, float]:
    """Launch `count` panes on the 2k session, load them, and read the probes.

    Parameters:
        sandbox (Sandbox): supplies the scratch root and workdir.
        template_home (Path): explicit installed stack fixture.
        count (int): panes.
        stream (bool): stream a reply in every pane and type into pane 0; else stay idle.

    Returns:
        dict[str, float]: fleet metrics, see `harness.fleet_load.Fleet.metrics`.
    """
    root = sandbox.root / f"cell{count}-{'s' if stream else 'i'}-{time.monotonic_ns()}"
    boxes = make_sandboxes(root, template_home, count, shared=True)
    session = root / "2k.jsonl"
    turns = write_session(session, boxes[0].workdir, TRANSCRIPT_MESSAGES)
    script = streaming_script(REPLY_CHARS, TOKENS_PER_S) if stream else IDLE_SCRIPT
    fleet = launch_fleet(
        boxes,
        script,
        root,
        extra_args=["--session", str(session)],
        wait_pattern=rf"Turn {turns} found 8 files",
    )
    try:
        time.sleep(SETTLE_S)
        for out in fleet.outs:
            records = read_records(out)
            assert records, records
            assert records[0]["kind"] == "start", records
            assert records[0]["tui"] is True, records
        fleet.mark()
        if stream:
            fleet.submit_all("go")
            fleet.type_into(0, KEYSTROKES)
            time.sleep(1.5)
        else:
            time.sleep(IDLE_WINDOW_S)
        readings = fleet.readings()
        for out in fleet.outs:
            assert any(
                record.get("kind") == "summary" and record["t"] >= fleet.started_ms
                for record in read_records(out)
            ), f"No measured probe window in '{out}'"
        if stream:
            assert len(readings[0].input_to_paint_ms) >= 4, readings[0]
            assert readings[0].input_p95_ms < 500, readings[0]
        else:
            assert all(reading.bytes_per_s < 200 for reading in readings), readings
        return fleet.metrics()
    finally:
        fleet.kill()


def test_multi_session_responsiveness(sandbox: Sandbox, template_home: Path) -> None:
    """Latency scales gracefully from 1 to 8 panes, holds its baselines, and idle panes stay silent."""
    calibrate_probe(sandbox)

    def sample() -> dict[str, float]:
        metrics: dict[str, float] = {}
        for count in PANES:
            cell = run_cell(sandbox, template_home, count, stream=True)
            metrics[f"ms_input_p95_n{count}"] = cell["input_p95_ms"]
            metrics[f"ms_loop_lag_p99_n{count}"] = cell["loop_lag_p99_ms"]
        idle = run_cell(sandbox, template_home, PANES[-1], stream=False)
        metrics["idle_bytes_per_s_n8"] = idle["bytes_per_s"]
        return metrics

    medians = measure_many(sample, SAMPLES)
    check_against_baseline("ms_input_p95_n4", medians["ms_input_p95_n4"])
    check_against_baseline("ms_loop_lag_p99_n4", medians["ms_loop_lag_p99_n4"])
    ratios = {
        "ratio_input_p95_n8_n1": medians["ms_input_p95_n8"] / max(medians["ms_input_p95_n1"], 0.1),
        "ratio_loop_lag_p99_n8_n1": medians["ms_loop_lag_p99_n8"] / max(medians["ms_loop_lag_p99_n1"], 0.1),
    }
    for name, ceiling in RATIO_CEILINGS.items():
        check_ceiling(name, ratios[name], ceiling)
    check_ceiling("idle_bytes_per_s_n8", medians["idle_bytes_per_s_n8"], IDLE_BYTES_PER_S_CEILING)
