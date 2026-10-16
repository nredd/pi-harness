"""Run the in-process render probe (`probes/render.ts`) in a live pane and read its result."""

from __future__ import annotations

import json
import statistics
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING

from harness.interactive import submit
from harness.paths import PROBE_EXTENSION

if TYPE_CHECKING:
    from pathlib import Path

    from harness.tmux import TmuxPane

PROBE_TIMEOUT_S = 120.0
POLL_INTERVAL_S = 0.1
BYTES_PER_MB = 1024 * 1024
# `--expose-gc` lets the probe collect before it reads the heap, so the figure is live data.
PROBE_NODE_OPTIONS = "--expose-gc"


@dataclass(frozen=True)
class ProbeResult:
    """One probe reading.

    Attributes:
        frames_ms (list[float]): wall time of each forced full frame.
        steady_frames_ms (list[float]): wall time of each steady frame (no invalidate).
        heap_used_mb (float): `heapUsed` after a GC.
        gc (bool): whether a GC ran first.
    """

    frames_ms: list[float]
    steady_frames_ms: list[float]
    heap_used_mb: float
    gc: bool

    @property
    def frame_ms(self) -> float:
        """Median full-frame time in milliseconds."""
        return statistics.median(self.frames_ms)

    @property
    def steady_frame_ms(self) -> float:
        """Median steady-frame time in milliseconds."""
        return statistics.median(self.steady_frames_ms)


def probe_args(out: Path) -> tuple[list[str], dict[str, str]]:
    """Return the pi flags and environment that load the probe.

    Parameters:
        out (Path): file the probe appends its JSON lines to.

    Returns:
        tuple[list[str], dict[str, str]]: extra argv and extra environment.
    """
    return ["-e", str(PROBE_EXTENSION)], {"HARNESS_PROBE_OUT": str(out), "NODE_OPTIONS": PROBE_NODE_OPTIONS}


def run_probe(pane: TmuxPane, out: Path, frames: int = 10) -> ProbeResult:
    """Run `/harness-probe` and return the reading it appends to `out`.

    Parameters:
        pane (TmuxPane): pane launched with `probe_args(out)`.
        out (Path): probe output file.
        frames (int): frames to time.

    Returns:
        ProbeResult: the new reading.

    Raises:
        AssertionError: no reading arrived in time.
    """
    before = out.read_text().count("\n") if out.is_file() else 0
    submit(pane, f"/harness-probe {frames}")
    deadline = time.monotonic() + PROBE_TIMEOUT_S
    while time.monotonic() < deadline:
        lines = out.read_text().splitlines() if out.is_file() else []
        if len(lines) > before:
            record = json.loads(lines[before])
            return ProbeResult(
                frames_ms=[float(value) for value in record["frames_ms"]],
                steady_frames_ms=[float(value) for value in record["steady_frames_ms"]],
                heap_used_mb=float(record["heap_used"]) / BYTES_PER_MB,
                gc=bool(record["gc"]),
            )
        time.sleep(POLL_INTERVAL_S)
    raise AssertionError(
        f"`/harness-probe` wrote nothing to '{out}' in {PROBE_TIMEOUT_S}s\n" + pane.capture()
    )
