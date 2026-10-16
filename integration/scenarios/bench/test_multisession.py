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


def run_cell(sandbox: Sandbox, template_home: Path, count: int, *, stream: bool) -> dict[str, float]:
    """Launch `count` panes on the 2k session, load them, and read the probes.

    Parameters:
        sandbox (Sandbox): supplies the scratch root and workdir.
        template_home (Path): session chezmoi render.
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
        fleet.mark()
        if stream:
            fleet.submit_all("go")
            fleet.type_into(0, KEYSTROKES)
            time.sleep(1.5)
        else:
            time.sleep(IDLE_WINDOW_S)
        return fleet.metrics()
    finally:
        fleet.kill()


def test_multi_session_responsiveness(sandbox: Sandbox, template_home: Path) -> None:
    """Latency scales gracefully from 1 to 8 panes, holds its baselines, and idle panes stay silent."""

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
