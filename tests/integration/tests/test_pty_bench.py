"""Fail-closed reduction controls for real interactive PTY observations.

References:
- https://github.com/nredd/pi-harness/issues/977
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path
from textwrap import dedent
from typing import TYPE_CHECKING, Any

import pytest

from harness import pty_bench
from harness.pty_bench import calibrate, probe_metrics, run_cell
from harness.pty_driver import Child, Drain, PtyFleet
from harness.sandbox import build_sandbox
from scenarios.bench import test_throttled_pty as scenario

if TYPE_CHECKING:
    from collections.abc import Callable


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


@pytest.mark.parametrize(
    ("count", "cap", "failure"),
    [
        (4, None, ""),
        (8, pty_bench.AGGREGATE_CAP, ""),
        (8, pty_bench.AGGREGATE_CAP, "delivered no output"),
        (8, pty_bench.AGGREGATE_CAP, "not-started"),
        (8, pty_bench.AGGREGATE_CAP, "PTY child exited"),
        (8, pty_bench.AGGREGATE_CAP, "PTY input stalled"),
        (8, pty_bench.AGGREGATE_CAP, "Missing measured latency windows"),
        (8, None, "Missing measured latency windows"),
        (4, pty_bench.AGGREGATE_CAP, "Missing measured latency windows"),
    ],
)
def test_cell_reports_latency_only_with_measured_windows(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    count: int,
    cap: int | None,
    failure: str,
) -> None:
    """Only missing measured windows in the capped eight-child cell yield NOT RUN."""
    template = build_sandbox(tmp_path / "template")
    monkeypatch.setenv("PI_BIN", sys.executable)
    sent: list[tuple[int, bytes]] = []
    cell_root = tmp_path / "cell"

    class Fleet:
        """Recording boundary double; real interactive execution is a separate requirement."""

        def __init__(self, specs: list[Child]) -> None:
            self.specs = specs
            self.counts = [50] * count
            assert len(specs) == count
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
                assert kwargs["bytes_per_s"] == cap
                for spec in self.specs:
                    data = records()
                    data[1]["t"] = time.time() * 1000
                    data[1]["window_s"] = 0.01
                    if failure == "Missing measured latency windows":
                        data.pop()
                    elif failure == "not-started":
                        data.clear()
                    save(Path(spec.env["PI_LATENCY_PROBE"]), data)
                if failure in ("PTY child exited", "PTY input stalled"):
                    self.counts[0] += 73
                    error = TimeoutError if failure == "PTY input stalled" else RuntimeError
                    raise error(failure)
            return Drain((0 if failure == "delivered no output" else 100,) * count, duration)

    monkeypatch.setattr(pty_bench, "PtyFleet", Fleet)
    not_run = count == 8 and cap is not None and failure == "Missing measured latency windows"
    if failure and not not_run:
        match = "did not start" if failure == "not-started" else failure
        error = TimeoutError if failure == "PTY input stalled" else RuntimeError
        with pytest.raises(error, match=match):
            run_cell(cell_root, template.home, count, cap)
        raw = json.loads((cell_root / "throttled-pty.json").read_text())
        assert match in raw["failure"]
        assert "status" not in raw
        assert "probe" not in raw
        if failure in ("PTY child exited", "PTY input stalled"):
            assert raw["delivery"]["delivered"] == [73, *([0] * (count - 1))]
            assert raw["delivered_bytes_per_s"] > 0
            assert all(child_records[0]["kind"] == "start" for child_records in raw["raw_probes"])
    else:
        result = run_cell(cell_root, template.home, count, cap)
        assert result["count"] == count
        assert result["aggregate_cap"] == cap
        assert result["delivery"]["delivered"] == (100,) * count
        raw = json.loads((cell_root / "throttled-pty.json").read_text())
        if not_run:
            assert result.get("status") == raw["status"] == "NOT RUN"
            assert result.get("reason") == raw["failure"] == failure
            assert "probe" not in result
            assert raw["raw_probes"] == [[{"kind": "start", "tui": True}]] * count
        else:
            assert "probe" in result
            assert "status" not in result
    assert sent == [(i, b"go\r") for i in range(count)] + [(i, b"x") for i in range(count)]


@pytest.mark.parametrize(
    "failure",
    [
        "none",
        "missing",
        "empty",
        "partial",
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
            if failure == "empty":
                self.report.write_text("")
            elif failure == "partial":
                self.report.write_text('{"writes":')
            elif failure != "missing":
                self.report.write_text(json.dumps(record))
            return Drain((0 if failure == "zero-output" else rate,), 1)

    monkeypatch.setattr(pty_bench, "PtyFleet", Fleet)
    if failure == "none":
        result = calibrate(tmp_path)
        assert result[0]["cap"] is None
        assert result[1]["cap"] == 65536
    elif failure in ("empty", "partial"):
        with pytest.raises(RuntimeError, match=r"^Calibration writer observations are missing$"):
            calibrate(tmp_path)
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
            probe_metrics([out], 1000, 3000 if failure == "overlap" else 4000)


def test_writer_preserves_heartbeat_when_interrupted_mid_write(tmp_path: Path) -> None:
    """Interrupt the real writer's second dump after flushing a partial JSON record."""
    interrupt = dedent("""\
        import json, os
        dump = json.dump
        def interrupt_second_dump(record, stream):
            if os.path.isfile(sys.argv[1]):
                stream.write('{"writes":')
                stream.flush()
                os._exit(42)
            dump(record, stream)
        json.dump = interrupt_second_dump
        """)
    report = tmp_path / "heartbeat.json"
    result = subprocess.run(
        [sys.executable, "-u", "-c", interrupt + pty_bench.WRITER, str(report)],
        stdout=subprocess.DEVNULL,
        check=False,
        timeout=5,
    )
    assert result.returncode == 42
    assert json.loads(report.read_text())["writes"] > 0
    assert (tmp_path / "heartbeat.json.pending").read_text() == '{"writes":'


def test_scenario_warns_without_failing_not_run_cell(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The overall report and pytest warnings both expose the partial outcome."""
    box = build_sandbox(tmp_path / "scenario")

    def cell(_root: Path, _home: Path, count: int, cap: int | None) -> dict[str, object]:
        if count == 8 and cap == pty_bench.AGGREGATE_CAP:
            return {"status": "NOT RUN", "reason": "Missing measured latency windows"}
        return {"count": count, "aggregate_cap": cap, "probe": {}}

    monkeypatch.setattr(scenario, "calibrate", lambda _root: [])
    monkeypatch.setattr(scenario, "run_cell", cell)
    with pytest.warns(pytest.PytestWarning, match="Capped eight-child latency NOT RUN") as warnings:
        scenario.test_throttled_pty_fleet(box, box.home)
    assert len(warnings) == 1
    recorded = json.loads((box.root / "throttled-pty.json").read_text())["cells"]
    assert len(recorded) == 6
    assert recorded[-1] == {"status": "NOT RUN", "reason": "Missing measured latency windows"}


def test_real_writer_stalling_after_initial_progress_is_refused(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An alive writer can supply valid output and then hang; that is not calibration."""
    writer = dedent("""\
        import json, os, sys, time
        before = time.monotonic()
        os.write(1, b'x')
        finished = time.monotonic()
        pending = sys.argv[1] + '.pending'
        with open(pending, 'w') as out:
            json.dump({'writes': 1, 'max_write_ms': (finished - before) * 1000,
                       'last_write_s': finished}, out)
        os.replace(pending, sys.argv[1])
        time.sleep(30)
        """)

    class ReadyFleet(PtyFleet):
        """Wait for the real writer's last heartbeat before starting calibration."""

        def drain(
            self,
            duration_s: float,
            *,
            bytes_per_s: float | None = None,
            tick: Callable[[PtyFleet], None] | None = None,
        ) -> Drain:
            # Wait without consuming the first byte: calibration must see real delivery.
            report = tmp_path / f"writer-{bytes_per_s}.json"
            deadline = time.monotonic() + 5
            while not report.is_file():
                if time.monotonic() >= deadline:
                    pytest.fail("Stall fixture did not publish its heartbeat")
                time.sleep(0.01)
            return super().drain(duration_s, bytes_per_s=bytes_per_s, tick=tick)

    monkeypatch.setattr(pty_bench, "WRITER", writer)
    monkeypatch.setattr(pty_bench, "PtyFleet", ReadyFleet)
    with pytest.raises(RuntimeError, match="writer stalled"):
        calibrate(tmp_path)
