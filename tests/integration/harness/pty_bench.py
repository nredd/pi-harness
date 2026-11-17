"""Synthetic interactive PTY cells using the existing faux/session/latency fixtures.

References:
- https://github.com/nredd/pi-harness/issues/977
- https://nodejs.org/api/process.html#a-note-on-process-io
"""

from __future__ import annotations

import json
import logging
import math
import sys
import time
from itertools import pairwise
from textwrap import dedent
from typing import TYPE_CHECKING, Any, NotRequired, TypedDict

from harness.fleet_load import make_sandboxes, streaming_script
from harness.interactive import FIRST_FRAME_PATTERN
from harness.latency import Reading, combine, latency_args, read_records, summarize
from harness.paths import FAUX_EXTENSION, pi_command
from harness.pty_driver import Child, Drain, PtyFleet
from harness.sessions import write_session

if TYPE_CHECKING:
    from pathlib import Path

LOGGER = logging.getLogger(__name__)
AGGREGATE_CAP = 65536
WINDOW_S = 6.0
KEY_INTERVAL_S = 0.15
WRITER = dedent("""\
    import json, os, sys, time
    out = sys.argv[1]
    maximum = 0.0
    writes = 0
    last = time.monotonic()
    while True:
        started = time.monotonic()
        os.write(1, b'x' * 4096)
        maximum = max(maximum, (time.monotonic() - started) * 1000)
        writes += 1
        if time.monotonic() - last >= 0.1:
            with open(out, 'w') as report:
                json.dump({'max_write_ms': maximum, 'writes': writes,
                           'last_write_s': time.monotonic()}, report)
            last = time.monotonic()
    """)


class DeliveryRecord(TypedDict):
    """Actual driver delivery, excluding startup."""

    delivered: tuple[int, ...]
    elapsed_s: float


class WriterRecord(TypedDict):
    """Completed synchronous writes and their monotonic progress heartbeat."""

    writes: int
    max_write_ms: float
    last_write_s: float


class CalibrationEntry(TypedDict):
    """One requested load condition and observed delivery/write behavior."""

    cap: int | None
    delivery: DeliveryRecord
    delivered_bytes_per_s: float
    writer: WriterRecord


class ReadingRecord(TypedDict):
    """JSON-compatible existing latency reading, without fabricated empty samples."""

    loop_lag_p99_ms: float
    loop_lag_max_ms: float
    stalls: int
    bytes_per_s: float
    max_block_ms: float
    input_to_paint_ms: list[float]


class ProbeMetrics(TypedDict):
    """Combined/individual readings and existing probe start metadata."""

    combined: dict[str, float]
    readings: list[ReadingRecord]
    starts: list[dict[str, Any]]


class RawCell(TypedDict):
    """Retained driver/probe evidence, also when the cell is refused."""

    count: int
    aggregate_cap: int | None
    delivery: DeliveryRecord
    delivered_bytes_per_s: float
    raw_probes: list[list[dict[str, Any]]]
    failure: NotRequired[str]


class Cell(TypedDict):
    """A complete cell; incomplete observations never construct this result."""

    count: int
    aggregate_cap: int | None
    delivery: DeliveryRecord
    delivered_bytes_per_s: float
    probe: ProbeMetrics


def _delivery_record(sample: Drain) -> DeliveryRecord:
    """Serialize the driver's typed delivery without weakening its field contract."""
    return {"delivered": sample.delivered, "elapsed_s": sample.elapsed_s}


def _reading_record(reading: Reading) -> ReadingRecord:
    """Serialize the reused probe reading without weakening its field contract."""
    return {
        "loop_lag_p99_ms": reading.loop_lag_p99_ms,
        "loop_lag_max_ms": reading.loop_lag_max_ms,
        "stalls": reading.stalls,
        "bytes_per_s": reading.bytes_per_s,
        "max_block_ms": reading.max_block_ms,
        "input_to_paint_ms": reading.input_to_paint_ms,
    }


def calibrate(root: Path) -> list[CalibrationEntry]:
    """Prove actual writer backpressure against an uncapped control, or fail closed.

    Parameters:
        root (Path): private writable synthetic scratch directory.

    Returns:
        list[CalibrationEntry]: requested cap, delivered rate and synchronous write observations.
    """
    root.mkdir(parents=True, exist_ok=True)
    cells: list[CalibrationEntry] = []
    for cap in (None, AGGREGATE_CAP):
        report = root / f"writer-{cap}.json"
        spec = Child((sys.executable, "-u", "-c", WRITER, str(report)), root, {})
        with PtyFleet([spec]) as fleet:
            sample = fleet.drain(2.0, bytes_per_s=cap)
            finished_s = time.monotonic()
        if not report.is_file() or not all(sample.delivered):
            raise RuntimeError("Calibration writer produced no completed write observations")
        record: WriterRecord = json.loads(report.read_text())
        if record["writes"] <= 0 or record["max_write_ms"] <= 0:
            raise RuntimeError("Calibration writer observations are missing")
        if not math.isfinite(record["last_write_s"]) or not 0 <= finished_s - record["last_write_s"] <= 0.5:
            raise RuntimeError("Calibration writer stalled before the window ended")
        cells.append(
            {
                "cap": cap,
                "delivery": _delivery_record(sample),
                "delivered_bytes_per_s": sample.bytes_per_s,
                "writer": record,
            }
        )
    control, capped = cells
    if control["delivered_bytes_per_s"] <= AGGREGATE_CAP * 2:
        raise RuntimeError("Uncapped writer control did not exceed the cap")
    if not AGGREGATE_CAP * 0.5 < capped["delivered_bytes_per_s"] <= AGGREGATE_CAP:
        raise RuntimeError("Capped writer delivery did not demonstrate the requested rate")
    if capped["writer"]["max_write_ms"] <= control["writer"]["max_write_ms"]:
        raise RuntimeError("Calibration did not distinguish capped write blocking from the control")
    return cells


def probe_metrics(outs: list[Path], since_ms: float, until_ms: float) -> ProbeMetrics:
    """Reduce contiguous measured windows; refuse missing output, samples or startup.

    Parameters:
        outs (list[Path]): explicit per-child latency probe paths.
        since_ms (float): epoch start of the measured window.
        until_ms (float): epoch end; endpoint heartbeats must be within one second.

    Returns:
        ProbeMetrics: combined observations and per-child readings/start metadata.
    """
    if not outs:
        raise ValueError("No child probe paths")
    readings: list[Reading] = []
    starts: list[dict[str, Any]] = []
    for out in outs:
        records = read_records(out)
        if not records or records[0].get("kind") != "start" or records[0].get("tui") is not True:
            raise RuntimeError("Interactive latency probe did not start")
        windows = [
            r for r in records if r.get("kind") == "summary" and r["t"] - r["window_s"] * 1000 >= since_ms
        ]
        if (
            not windows
            or any(
                not math.isfinite(r["window_s"]) or r["window_s"] <= 0 or not math.isfinite(r["t"])
                for r in windows
            )
            or windows[0]["t"] - windows[0]["window_s"] * 1000 > since_ms + 1000
            or windows[-1]["t"] < until_ms - 1000
            or any(
                abs(right["t"] - right["window_s"] * 1000 - left["t"]) > 2
                for left, right in pairwise(windows)
            )
        ):
            raise RuntimeError("Missing measured latency windows")
        reading = summarize(windows)
        if reading.bytes_per_s <= 0 or len(reading.input_to_paint_ms) < 4:
            raise RuntimeError("Missing measured terminal writes or input-to-paint samples")
        readings.append(reading)
        starts.append(records[0])
    return {
        "combined": combine(readings),
        "readings": [_reading_record(r) for r in readings],
        "starts": starts,
    }


def run_cell(root: Path, template_home: Path, count: int, cap: int | None) -> Cell:
    """Run one bounded real interactive synthetic cell, without changing any baseline.

    Parameters:
        root (Path): new private cell directory.
        template_home (Path): explicitly constructed fixture, never an owner HOME.
        count (int): fleet size (1, 4 or 8).
        cap (int | None): aggregate delivered byte rate, `None` for the uncapped control.

    Returns:
        Cell: throughput and probe observations, not idle-host acceptance.
    """
    if count not in (1, 4, 8) or cap not in (None, AGGREGATE_CAP):
        raise ValueError("Use fleet sizes 1/4/8 and the documented aggregate cap or control")
    boxes = make_sandboxes(root, template_home, count, shared=True)
    session = root / "2k.jsonl"
    write_session(session, boxes[0].workdir, 2000)
    script = root / "faux.json"
    script.write_text(json.dumps(streaming_script(48000, 600)))
    outs = [root / f"latency-{index}.jsonl" for index in range(count)]
    specs = []
    for box, out in zip(boxes, outs, strict=True):
        args, env = latency_args(out, 500)
        specs.append(
            Child(
                (
                    *pi_command(),
                    "-e",
                    str(FAUX_EXTENSION),
                    "--model",
                    "faux/main",
                    "--session",
                    str(session),
                    *args,
                ),
                box.workdir,
                box.env(env | {"HARNESS_SCRIPT": str(script)}),
            )
        )
    with PtyFleet(specs) as fleet:
        # Match the existing launcher's first-frame footer seam. Raw PTY bytes
        # contain styling inside transcript text; they are not a tmux screen capture.
        fleet.wait_for(FIRST_FRAME_PATTERN.replace(r"\b", "").encode())
        fleet.drain(1.0)
        since_ms = time.time() * 1000
        for index in range(count):
            fleet.send(index, b"go\r")
        next_key = time.monotonic() + KEY_INTERVAL_S

        def type_keys(active: PtyFleet) -> None:
            """Inject spaced input into every editor during the measured drain."""
            nonlocal next_key
            if time.monotonic() >= next_key:
                for index in range(count):
                    active.send(index, b"x")
                next_key = time.monotonic() + KEY_INTERVAL_S

        delivery = fleet.drain(WINDOW_S, bytes_per_s=cap, tick=type_keys)
        observations: RawCell = {
            "count": count,
            "aggregate_cap": cap,
            "delivery": _delivery_record(delivery),
            "delivered_bytes_per_s": delivery.bytes_per_s,
            "raw_probes": [read_records(out) for out in outs],
        }
        report = root / "throttled-pty.json"
        report.write_text(json.dumps(observations, indent=2))
        try:
            if not all(delivery.delivered):
                raise RuntimeError("A measured PTY delivered no output")
            metrics = probe_metrics(outs, since_ms, time.time() * 1000)
        except RuntimeError as error:
            observations["failure"] = str(error)
            report.write_text(json.dumps(observations, indent=2))
            LOGGER.error(f"Refused synthetic PTY observations: {json.dumps(observations)}")
            raise
    return {
        "count": count,
        "aggregate_cap": cap,
        "delivery": _delivery_record(delivery),
        "delivered_bytes_per_s": delivery.bytes_per_s,
        "probe": metrics,
    }
