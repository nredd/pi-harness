"""Fail-closed reduction controls for real interactive PTY observations.

References:
- https://github.com/nredd/pi-harness/issues/977
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from textwrap import dedent
from typing import Any

import pytest

from harness import pty_bench
from harness.pty_bench import calibrate, probe_metrics, run_cell
from harness.pty_driver import Child, Drain
from harness.sandbox import build_sandbox


def records() -> list[dict[str, Any]]:
    """Return an independently specified valid latency sample."""
    return [
        {"kind": "start", "tui": True},
        {
            "kind": "summary",
            "t": 2000,
            "window_s": 1,
            "loop_lag_ms": {"p99": 2, "max": 3},
            "stalls": [],
            "write": {"bytes": 100, "max_block_ms": 0},
            "input_to_paint_ms": [1, 2, 3, 4],
        },
    ]


def save(path: Path, data: list[dict[str, Any]]) -> None:
    """Write explicit synthetic probe records, not generated expectations."""
    path.write_text("\n".join(json.dumps(record) for record in data))


def test_probe_reduction_and_missing_files(tmp_path: Path) -> None:
    """Recorded zero synchronous block time is valid; missing observations are not."""
    out = tmp_path / "probe.jsonl"
    with pytest.raises(RuntimeError, match="did not start"):
        probe_metrics([out], 1000, 2000)
    save(out, records())
    result = probe_metrics([out], 1000, 2000)
    assert result["combined"]["max_block_ms"] == 0
    assert result["combined"]["bytes_per_s"] == 100
    assert result["readings"][0]["input_to_paint_ms"] == [1, 2, 3, 4]
    with pytest.raises(ValueError, match="No child"):
        probe_metrics([], 1000, 2000)
    with pytest.raises(RuntimeError, match="Missing measured"):
        probe_metrics([out], 1000, 4001)


@pytest.mark.parametrize(
    "failure",
    ["empty", "not-tui", "not-start", "missing-window", "old-window", "zero-window", "no-writes", "no-input"],
)
def test_probe_refuses_incomplete_evidence(tmp_path: Path, failure: str) -> None:
    """Deliberate missing and stale evidence never reduces to successful zeros."""
    data = records()
    if failure == "empty":
        data = []
    elif failure == "not-tui":
        data[0]["tui"] = False
    elif failure == "not-start":
        data[0]["kind"] = "summary"
    elif failure == "missing-window":
        data.pop()
    elif failure == "old-window":
        data[1]["t"] = 0
    elif failure == "zero-window":
        data[1]["window_s"] = 0
    elif failure == "no-writes":
        data[1]["write"]["bytes"] = 0
    else:
        data[1]["input_to_paint_ms"] = []
    out = tmp_path / "probe.jsonl"
    save(out, data)
    with pytest.raises(RuntimeError):
        probe_metrics([out], 1000, 2000)


@pytest.mark.parametrize(("count", "cap"), [(0, None), (2, None), (1, 1)])
def test_cell_refuses_unsupported_inputs(tmp_path: Path, count: int, cap: int | None) -> None:
    """Refuse invalid fleet sizes/caps before reading fixtures or starting Pi."""
    with pytest.raises(ValueError, match="fleet sizes"):
        run_cell(tmp_path / "cell", tmp_path / "missing", count, cap)


@pytest.mark.parametrize("missing_output", [False, True])
def test_cell_assembles_existing_fixtures_and_refuses_missing_delivery(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    missing_output: bool,
) -> None:
    """The adapter uses explicit faux/session/probe fixtures and samples every child."""
    template = build_sandbox(tmp_path / "template")
    monkeypatch.setenv("PI_BIN", sys.executable)
    sent: list[tuple[int, bytes]] = []

    class Fleet:
        """Recording boundary double; real interactive execution is a separate requirement."""

        def __init__(self, specs: list[Child]) -> None:
            self.specs = specs
            assert len(specs) == 4
            assert all(Path(spec.env["HOME"]).is_relative_to(tmp_path / "cell") for spec in specs)
            assert all("HARNESS_SCRIPT" in spec.env for spec in specs)

        def __enter__(self) -> Fleet:
            return self

        def __exit__(self, *_exc: object) -> None:
            pass

        def wait_for(self, marker: bytes) -> None:
            assert marker == b"main"

        def send(self, index: int, data: bytes) -> None:
            sent.append((index, data))

        def drain(self, duration: float, **kwargs: Any) -> Drain:
            if "tick" in kwargs:
                kwargs["tick"](self)
                time.sleep(0.16)
                kwargs["tick"](self)
                for spec in self.specs:
                    data = records()
                    data[1]["t"] = time.time() * 1000
                    data[1]["window_s"] = 0.01
                    save(Path(spec.env["PI_LATENCY_PROBE"]), data)
            return Drain((0 if missing_output else 100,) * 4, duration)

    monkeypatch.setattr(pty_bench, "PtyFleet", Fleet)
    if missing_output:
        with pytest.raises(RuntimeError, match="delivered no output"):
            run_cell(tmp_path / "cell", template.home, 4, None)
    else:
        result = run_cell(tmp_path / "cell", template.home, 4, None)
        assert result["count"] == 4
        assert result["aggregate_cap"] is None
        assert result["delivery"]["delivered"] == (100, 100, 100, 100)
    assert sent == [(i, b"go\r") for i in range(4)] + [(i, b"x") for i in range(4)]


@pytest.mark.parametrize(
    "failure",
    [
        "none",
        "missing",
        "zero-output",
        "zero-writes",
        "zero-block",
        "slow-control",
        "slow-cap",
        "fast-cap",
        "no-pressure",
        "stale-progress",
        "nonfinite-progress",
    ],
)
def test_calibration_requires_distinguishing_controls(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
) -> None:
    """A requested cap alone, silent writer or low control is never a calibration success."""

    class Fleet:
        """Deterministic delivery/report boundary for each deliberate refusal."""

        def __init__(self, specs: list[Child]) -> None:
            self.report = Path(specs[0].argv[-1])

        def __enter__(self) -> Fleet:
            return self

        def __exit__(self, *_exc: object) -> None:
            pass

        def drain(self, _duration: float, *, bytes_per_s: int | None) -> Drain:
            cap = bytes_per_s is not None
            rate = 50000 if cap else 200000
            if failure == "slow-control" and not cap:
                rate = 1000
            elif failure == "slow-cap" and cap:
                rate = 1
            elif failure == "fast-cap" and cap:
                rate = 100000
            record = {"writes": 100, "max_write_ms": 100 if cap else 1, "last_write_s": time.monotonic()}
            if failure == "stale-progress":
                record["last_write_s"] -= 1.2
            elif failure == "nonfinite-progress":
                record["last_write_s"] = float("nan")
            if failure == "zero-writes":
                record["writes"] = 0
            elif failure == "zero-block":
                record["max_write_ms"] = 0
            elif failure == "no-pressure":
                record["max_write_ms"] = 1
            if failure != "missing":
                self.report.write_text(json.dumps(record))
            return Drain((0 if failure == "zero-output" else rate,), 1)

    monkeypatch.setattr(pty_bench, "PtyFleet", Fleet)
    if failure == "none":
        result = calibrate(tmp_path)
        assert result[0]["cap"] is None
        assert result[1]["cap"] == 65536
    else:
        with pytest.raises(RuntimeError):
            calibrate(tmp_path)


@pytest.mark.parametrize(
    "failure", ["interior-gap", "overlap", "late-start", "invalid-window", "invalid-stamp", "none"]
)
def test_probe_window_continuity(tmp_path: Path, failure: str) -> None:
    """A recent last heartbeat cannot hide an omitted interior interval."""
    data = records()
    data.append(records()[1])
    data[2]["t"] = 3000
    if failure == "interior-gap":
        data[2]["t"] = 4000
    elif failure == "overlap":
        data[2]["t"] = 2500
    elif failure == "late-start":
        data = [data[0], data[2]]
        data[1]["t"] = 4000
    elif failure == "invalid-window":
        data[1]["window_s"] = float("-inf")
    elif failure == "invalid-stamp":
        data[1]["t"] = float("inf")
    out = tmp_path / "probe.jsonl"
    save(out, data)
    if failure == "none":
        assert probe_metrics([out], 1000, 3000)["combined"]["bytes_per_s"] == 100
    else:
        with pytest.raises(RuntimeError, match="Missing measured latency windows"):
            probe_metrics([out], 1000, 4000)


def test_real_writer_stalling_after_initial_progress_is_refused(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An alive writer can supply valid output and then hang; that is not calibration."""
    writer = dedent("""\
        import json, os, sys, time
        started = time.monotonic()
        maximum = 0.0
        writes = 0
        while time.monotonic() - started < 1.2:
            before = time.monotonic()
            os.write(1, b'x' * 4096)
            maximum = max(maximum, (time.monotonic() - before) * 1000)
            writes += 1
            with open(sys.argv[1], 'w') as out:
                json.dump({'writes': writes, 'max_write_ms': maximum,
                           'last_write_s': time.monotonic()}, out)
        time.sleep(30)
        """)
    monkeypatch.setattr(pty_bench, "WRITER", writer)
    with pytest.raises(RuntimeError, match="writer stalled"):
        calibrate(tmp_path)
