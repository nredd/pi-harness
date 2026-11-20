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
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any

import pytest

from harness import pty_bench
from harness.pty_bench import AGGREGATE_CAP, LARGEST_FLEET, PENDING_SUFFIX, calibrate, probe_metrics, run_cell
from harness.pty_driver import Child, Drain, PtyFleet
from harness.sandbox import build_sandbox
from scenarios.bench import test_throttled_pty as scenario

if TYPE_CHECKING:
    from collections.abc import Callable
    from typing import TextIO


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


class RecordingFleet:
    """Record input and startup output without a subprocess or real clock."""

    def __init__(self, specs: list[Child]) -> None:
        self.specs = specs
        self.counts = [0] * len(specs)
        self.sent: list[tuple[int, bytes]] = []

    def __enter__(self) -> RecordingFleet:
        return self

    def __exit__(self, *_exc: object) -> None:
        pass

    def wait_for(self, marker: bytes) -> None:
        assert marker == b"main"
        for spec in self.specs:
            save(Path(spec.env["PI_LATENCY_PROBE"]), records()[:1])
        self.counts[0] += 50

    def send(self, index: int, data: bytes) -> None:
        self.sent.append((index, data))

    def warm_up(self, duration_s: float) -> Drain:
        """Account for startup output before the measurement snapshot."""
        assert duration_s == 1.0
        self.counts[0] += 10
        return Drain((10, *([0] * (len(self.specs) - 1))), duration_s)


@pytest.mark.parametrize(
    ("count", "cap", "delivered_bytes", "probe_rows", "fault", "expected_failure", "not_run"),
    [
        (4, None, 100, 2, None, "", False),
        (LARGEST_FLEET, AGGREGATE_CAP, 100, 2, None, "", False),
        (LARGEST_FLEET, AGGREGATE_CAP, 0, 2, None, "delivered no output", False),
        (LARGEST_FLEET, AGGREGATE_CAP, 100, 0, None, "did not start", False),
        (LARGEST_FLEET, AGGREGATE_CAP, 100, 2, RuntimeError("PTY child exited"), "PTY child exited", False),
        (LARGEST_FLEET, AGGREGATE_CAP, 100, 2, TimeoutError("PTY input stalled"), "PTY input stalled", False),
        (LARGEST_FLEET, AGGREGATE_CAP, 100, 1, None, "Missing measured latency windows", True),
        (LARGEST_FLEET, None, 100, 1, None, "Missing measured latency windows", False),
        (4, AGGREGATE_CAP, 100, 1, None, "Missing measured latency windows", False),
    ],
)
def test_cell_reports_latency_only_with_measured_windows(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    count: int,
    cap: int | None,
    delivered_bytes: int,
    probe_rows: int,
    fault: RuntimeError | OSError | None,
    expected_failure: str,
    not_run: bool,
) -> None:
    """Only missing measured windows in the capped eight-child cell yield NOT RUN."""
    template = build_sandbox(tmp_path / "template")
    monkeypatch.setenv("PI_BIN", sys.executable)
    cell_root = tmp_path / "cell"
    clock = 0.0
    fleets: list[RecordingFleet] = []
    monkeypatch.setattr(
        pty_bench,
        "time",
        SimpleNamespace(
            time=lambda: 1 + clock, monotonic=lambda: clock, monotonic_ns=lambda: int(clock * 1e9)
        ),
    )

    class MeasuredFleet(RecordingFleet):
        """Replay the chosen delivery, probe data and interruption independently."""

        def __init__(self, specs: list[Child]) -> None:
            super().__init__(specs)
            fleets.append(self)
            assert len(specs) == count
            assert all(Path(spec.env["HOME"]).is_relative_to(cell_root) for spec in specs)
            assert all("HARNESS_SCRIPT" in spec.env for spec in specs)

        def drain(
            self,
            duration_s: float,
            *,
            bytes_per_s: float | None = None,
            tick: Callable[[RecordingFleet], None] | None = None,
        ) -> Drain:
            nonlocal clock
            if tick is None:
                return self.warm_up(duration_s)
            assert bytes_per_s == cap
            tick(self)
            clock = 1.0
            tick(self)
            for spec in self.specs:
                save(Path(spec.env["PI_LATENCY_PROBE"]), records()[:probe_rows])
            if fault is not None:
                self.counts[0] += 73
                raise fault
            return Drain((delivered_bytes,) * count, duration_s)

    monkeypatch.setattr(pty_bench, "PtyFleet", MeasuredFleet)
    if expected_failure and not not_run:
        with pytest.raises(type(fault) if fault is not None else RuntimeError, match=expected_failure):
            run_cell(cell_root, template.home, count, cap)
        raw = json.loads((cell_root / "throttled-pty.json").read_text())
        assert expected_failure in raw["failure"]
        assert "status" not in raw
        assert "probe" not in raw
        if fault is not None:
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
            assert result.get("reason") == raw["failure"] == expected_failure
            assert "probe" not in result
            assert raw["raw_probes"] == [[{"kind": "start", "tui": True}]] * count
        else:
            assert "probe" in result
            assert "status" not in result
    assert fleets[0].sent == [(i, b"go\r") for i in range(count)] + [(i, b"x") for i in range(count)]


class ReadinessTimeoutFleet(RecordingFleet):
    """Time out after collecting startup output and the probe start record."""

    def wait_for(self, marker: bytes) -> None:
        super().wait_for(marker)
        raise TimeoutError("PTY startup marker missing")


class WarmupExitFleet(RecordingFleet):
    """Exit after passing readiness and delivering some warm-up output."""

    def drain(self, duration_s: float) -> Drain:
        self.warm_up(duration_s)
        raise RuntimeError("PTY child exited during warm-up")


@pytest.mark.parametrize(
    ("fleet_type", "error_type", "message", "delivered"),
    [
        (ReadinessTimeoutFleet, TimeoutError, "PTY startup marker missing", 50),
        (WarmupExitFleet, RuntimeError, "PTY child exited during warm-up", 60),
    ],
)
def test_cell_retains_startup_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    fleet_type: type[RecordingFleet],
    error_type: type[Exception],
    message: str,
    delivered: int,
) -> None:
    """Startup failures stay hard failures and retain the evidence collected so far."""
    template = build_sandbox(tmp_path / "template")
    monkeypatch.setenv("PI_BIN", sys.executable)
    monkeypatch.setattr(pty_bench, "PtyFleet", fleet_type)
    ticks = iter((1_000_000_000, 2_000_000_000))
    monkeypatch.setattr(pty_bench, "time", SimpleNamespace(monotonic_ns=lambda: next(ticks)))
    root = tmp_path / "cell"
    with pytest.raises(error_type, match=message):
        run_cell(root, template.home, LARGEST_FLEET, AGGREGATE_CAP)
    raw = json.loads((root / "throttled-pty.json").read_text())
    assert raw == {
        "count": LARGEST_FLEET,
        "aggregate_cap": AGGREGATE_CAP,
        "failure": message,
        "delivery": {"delivered": [delivered, *([0] * (LARGEST_FLEET - 1))], "elapsed_s": 1.0},
        "delivered_bytes_per_s": delivered,
        "raw_probes": [[{"kind": "start", "tui": True}]] * LARGEST_FLEET,
    }


@pytest.mark.parametrize(
    ("rates", "payload", "expected_failure"),
    [
        pytest.param((200000, 50000), {}, "", id="valid"),
        pytest.param((200000, 50000), None, "produced no completed", id="missing"),
        pytest.param((200000, 50000), "", "^Calibration writer observations are missing$", id="empty"),
        pytest.param(
            (200000, 50000), '{"writes":', "^Calibration writer observations are missing$", id="partial"
        ),
        pytest.param((0, 50000), {}, "produced no completed", id="zero-output"),
        pytest.param((200000, 50000), {"writes": 0}, "observations are missing", id="zero-writes"),
        pytest.param((200000, 50000), {"max_write_ms": 0}, "observations are missing", id="zero-block"),
        pytest.param((1000, 50000), {}, "control did not exceed", id="slow-control"),
        pytest.param((200000, 1), {}, "did not demonstrate", id="slow-cap"),
        pytest.param((200000, 100000), {}, "did not demonstrate", id="fast-cap"),
        pytest.param((200000, 50000), {"max_write_ms": 1}, "did not distinguish", id="no-pressure"),
        pytest.param((200000, 50000), {"last_write_s": 9}, "writer stalled", id="stale-progress"),
        pytest.param(
            (200000, 50000), {"last_write_s": float("nan")}, "writer stalled", id="nonfinite-progress"
        ),
    ],
)
def test_calibration_requires_distinguishing_controls(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    rates: tuple[int, int],
    payload: dict[str, float] | str | None,
    expected_failure: str,
) -> None:
    """A requested cap alone, silent writer or low control is never a calibration success."""

    class CalibrationFleet:
        """Deterministic delivery/report boundary for each deliberate refusal."""

        def __init__(self, specs: list[Child]) -> None:
            self.report = Path(specs[0].argv[-1])

        def __enter__(self) -> CalibrationFleet:
            return self

        def __exit__(self, *_exc: object) -> None:
            pass

        def drain(self, _duration: float, *, bytes_per_s: int | None) -> Drain:
            capped = bytes_per_s is not None
            if isinstance(payload, dict):
                record = {"writes": 100, "max_write_ms": 100 if capped else 1, "last_write_s": 10} | payload
                self.report.write_text(json.dumps(record))
            elif payload is not None:
                self.report.write_text(payload)
            return Drain((rates[capped],), 1)

    monkeypatch.setattr(pty_bench, "PtyFleet", CalibrationFleet)
    monkeypatch.setattr(pty_bench, "time", SimpleNamespace(monotonic=lambda: 10))
    if expected_failure:
        with pytest.raises(RuntimeError, match=expected_failure):
            calibrate(tmp_path)
    else:
        result = calibrate(tmp_path)
        assert result[0]["cap"] is None
        assert result[1]["cap"] == AGGREGATE_CAP


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
    interrupted = report.with_name(report.name + PENDING_SUFFIX)
    assert interrupted.read_text() == '{"writes":'


def test_scenario_warns_without_failing_not_run_cell(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The overall report and pytest warnings both expose the partial outcome."""
    box = build_sandbox(tmp_path / "scenario")

    def cell(_root: Path, _home: Path, count: int, cap: int | None) -> dict[str, object]:
        if count == LARGEST_FLEET and cap == AGGREGATE_CAP:
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


def test_scenario_keeps_last_complete_report_on_interrupted_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Interrupt the second cell publication after writing a partial JSON prefix."""
    box = build_sandbox(tmp_path / "scenario")
    out = box.root / "throttled-pty.json"
    pending = out.with_name(out.name + PENDING_SUFFIX)
    dump = json.dump
    first_cell = {"count": 1, "aggregate_cap": None, "probe": {}}

    def interrupt(data: pty_bench.FleetReport, stream: TextIO, *, indent: int) -> None:
        """Write an incomplete second-cell snapshot before simulating an interruption."""
        if len(data["cells"]) == 2:
            stream.write('{"calibration":')
            raise OSError("interrupted fleet report publication")
        dump(data, stream, indent=indent)

    monkeypatch.setattr(scenario, "calibrate", lambda _root: [])
    monkeypatch.setattr(scenario, "run_cell", lambda *_args: first_cell)
    monkeypatch.setattr(pty_bench.json, "dump", interrupt)
    with pytest.raises(OSError, match="interrupted fleet report publication"):
        scenario.test_throttled_pty_fleet(box, box.home)
    assert json.loads(out.read_text()) == {"calibration": [], "cells": [first_cell]}
    assert not pending.exists()


@pytest.mark.parametrize("replace_fails", [False, True])
def test_cell_flushes_and_syncs_evidence_before_replace(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, replace_fails: bool
) -> None:
    """Check publication order and preserve the old cell report on a replace error."""
    out = tmp_path / "throttled-pty.json"
    pending = out.with_name(out.name + PENDING_SUFFIX)
    previous = {"failure": "previous cell"}
    out.write_text(json.dumps(previous))
    calls: list[str] = []
    replace = Path.replace

    def sync(_fd: int) -> None:
        """The new evidence must be fully flushed while the old snapshot is visible."""
        assert json.loads(pending.read_text())["failure"] == "startup timeout"
        assert json.loads(out.read_text()) == previous
        calls.append("fsync")

    def replace_report(source: Path, dest: Path) -> Path:
        """Record the rename or inject an error without touching the destination."""
        assert source == pending
        assert dest == out
        calls.append("replace")
        if replace_fails:
            raise OSError("report replace failed")
        return replace(source, dest)

    monkeypatch.setattr(pty_bench.os, "fsync", sync)
    monkeypatch.setattr(Path, "replace", replace_report)
    if replace_fails:
        with pytest.raises(OSError, match=r"^report replace failed$"):
            pty_bench._record_cell(
                [tmp_path / "probe.jsonl"], out, None, Drain((0,), 1), {"failure": "startup timeout"}
            )
        assert json.loads(out.read_text()) == previous
    else:
        pty_bench._record_cell(
            [tmp_path / "probe.jsonl"], out, None, Drain((0,), 1), {"failure": "startup timeout"}
        )
        assert json.loads(out.read_text())["failure"] == "startup timeout"
    assert calls == ["fsync", "replace"]
    assert not pending.exists()


def test_real_writer_stalling_after_initial_progress_is_refused(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An alive writer can supply valid output and then hang; that is not calibration."""
    writer = dedent(f"""\
        import json, os, sys, time
        before = time.monotonic()
        os.write(1, b'x')
        finished = time.monotonic()
        pending = sys.argv[1] + {PENDING_SUFFIX!r}
        with open(pending, 'w') as out:
            json.dump({{'writes': 1, 'max_write_ms': (finished - before) * 1000,
                       'last_write_s': finished}}, out)
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
