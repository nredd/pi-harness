"""Read the JSONL written by `probes/latency.ts` and reduce it to comparable numbers.

The probe appends one `start` line and a `summary` line per window (see the probe's header for
the schema). Everything here is pure so it can be unit tested without a pi process.
"""

from __future__ import annotations

import json
import math
import statistics
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from harness.paths import LATENCY_EXTENSION

if TYPE_CHECKING:
    from collections.abc import Iterable
    from pathlib import Path

DEFAULT_INTERVAL_MS = 1000


def percentile(values: Iterable[float], q: float) -> float:
    """Return the nearest-rank percentile, `0.0` for no values.

    Parameters:
        values (Iterable[float]): samples.
        q (float): quantile in (0, 1].

    Returns:
        float: the sample at rank `ceil(q * n)`.

    Raises:
        ValueError: `q` is outside (0, 1].
    """
    if not 0 < q <= 1:
        raise ValueError(f"`q` must be in (0, 1], got '{q}'")
    ordered = sorted(values)
    if not ordered:
        return 0.0
    return ordered[max(0, math.ceil(q * len(ordered)) - 1)]


def latency_args(out: Path, interval_ms: int = DEFAULT_INTERVAL_MS) -> tuple[list[str], dict[str, str]]:
    """Return the pi flags and environment that load the latency probe.

    Parameters:
        out (Path): JSONL file for this pane.
        interval_ms (int): summary window.

    Returns:
        tuple[list[str], dict[str, str]]: extra argv and extra environment.
    """
    return ["-e", str(LATENCY_EXTENSION)], {
        "PI_LATENCY_PROBE": str(out),
        "PI_LATENCY_INTERVAL_MS": str(interval_ms),
    }


def read_records(path: Path) -> list[dict[str, Any]]:
    """Parse a probe file, skipping a torn last line from a live writer.

    Parameters:
        path (Path): probe JSONL.

    Returns:
        list[dict[str, Any]]: records in file order; empty when the file is missing.
    """
    if not path.is_file():
        return []
    records: list[dict[str, Any]] = []
    for line in path.read_text().splitlines():
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return records


@dataclass(frozen=True)
class Reading:
    """One pane's latency over a time range.

    Attributes:
        loop_lag_p99_ms (float): worst per-window p99 of event-loop lag.
        loop_lag_max_ms (float): worst single tick.
        stalls (int): ticks late by 50 ms or more.
        bytes_per_s (float): terminal output rate over the range.
        max_block_ms (float): longest single `terminal.write`.
        input_to_paint_ms (list[float]): stdin -> next write, one per keystroke burst.
    """

    loop_lag_p99_ms: float
    loop_lag_max_ms: float
    stalls: int
    bytes_per_s: float
    max_block_ms: float
    input_to_paint_ms: list[float]

    @property
    def input_p95_ms(self) -> float:
        """p95 of `input_to_paint_ms`, `0.0` without samples."""
        return percentile(self.input_to_paint_ms, 0.95)


def summarize(records: list[dict[str, Any]], since_ms: float = 0.0) -> Reading:
    """Reduce `summary` records stamped at or after `since_ms`.

    Parameters:
        records (list[dict[str, Any]]): output of `read_records`.
        since_ms (float): epoch milliseconds; earlier windows are dropped.

    Returns:
        Reading: the reduced numbers; zeros when no window qualifies.
    """
    windows = [r for r in records if r.get("kind") == "summary" and r["t"] >= since_ms]
    if not windows:
        return Reading(0.0, 0.0, 0, 0.0, 0.0, [])
    seconds = sum(w["window_s"] for w in windows)
    return Reading(
        loop_lag_p99_ms=max(w["loop_lag_ms"]["p99"] for w in windows),
        loop_lag_max_ms=max(w["loop_lag_ms"]["max"] for w in windows),
        stalls=sum(len(w["stalls"]) for w in windows),
        bytes_per_s=sum(w["write"]["bytes"] for w in windows) / seconds if seconds else 0.0,
        max_block_ms=max(w["write"]["max_block_ms"] for w in windows),
        input_to_paint_ms=[ms for w in windows for ms in w["input_to_paint_ms"]],
    )


def combine(readings: list[Reading]) -> dict[str, float]:
    """Collapse per-pane readings into fleet metrics.

    Parameters:
        readings (list[Reading]): one per pane.

    Returns:
        dict[str, float]: `loop_lag_p99_ms` (median across panes), `loop_lag_max_ms` (worst),
            `stalls` (sum), `bytes_per_s` (sum), `max_block_ms` (worst).

    Raises:
        ValueError: no readings.
    """
    if not readings:
        raise ValueError("No readings to combine")
    return {
        "loop_lag_p99_ms": statistics.median(r.loop_lag_p99_ms for r in readings),
        "loop_lag_max_ms": max(r.loop_lag_max_ms for r in readings),
        "stalls": float(sum(r.stalls for r in readings)),
        "bytes_per_s": sum(r.bytes_per_s for r in readings),
        "max_block_ms": max(r.max_block_ms for r in readings),
    }
