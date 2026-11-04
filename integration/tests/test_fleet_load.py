"""`launch_fleet` and `Fleet` over real panes whose stub writes per-pane latency windows.

Pane `i`'s stub writes windows with loop-lag p99 `1+i`, max `10+i`, 100 bytes per 0.5 s,
max block `3+i` and input-to-paint `4+i` ms, so the fleet metrics do not depend on how many
windows a run produced.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock

import pytest

from harness import fleet_load
from harness.fleet_load import dump, launch_fleet, make_sandboxes
from harness.latency import LATENCY_EXTENSION
from tests.stub_pi_session import (
    IDLE_SCRIPT,
    assert_exits,
    kill_and_prove_gone,
    stub_sandbox,
    tmux_query,
    use_stub_pi,
)

if TYPE_CHECKING:
    from pathlib import Path

    from harness.sandbox import Sandbox
    from harness.tmux import TmuxPane


def test_fleet_metrics_combine_every_pane(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Submit to every pane, type into pane 0, then reduce windows written after `mark()`."""
    use_stub_pi(monkeypatch)
    monkeypatch.setattr(fleet_load, "KEY_INTERVAL_S", 0)
    (tmp_path / "template").mkdir()
    boxes = make_sandboxes(tmp_path / "boxes", tmp_path / "template", 2, shared=False)
    fleet = launch_fleet(boxes, IDLE_SCRIPT, tmp_path, interval_ms=250, extra_args=["--session", "s"])
    try:
        fleet.mark()
        fleet.submit_all("hello")
        fleet.type_into(0, 3)
        fleet.panes[0].send_keys("Enter")
        fleet.panes[0].wait_for(r"^> xxx$")
        fleet.panes[1].wait_for(r"^> hello$")
        readings = fleet.readings()
        metrics = fleet.metrics()
    finally:
        panes = list(fleet.panes)
        for pane in panes:
            kill_and_prove_gone(pane)
    assert [len(reading.input_to_paint_ms) for reading in readings] == [2, 1]
    assert metrics == {
        "loop_lag_p99_ms": 1.5,
        "loop_lag_max_ms": 11.0,
        "stalls": 0.0,
        "bytes_per_s": 400.0,
        "max_block_ms": 4.0,
        "input_p95_ms": 4.0,
    }
    assert json.loads(dump(metrics)) == metrics
    assert json.loads(fleet.outs[0].read_text().splitlines()[0])["kind"] == "start"
    script = next(boxes[0].root.glob("script-fleet0x*.json"))
    assert json.loads(script.read_text()) == IDLE_SCRIPT


def test_launch_fleet_passes_probe_and_extra_args(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Every pane gets its own latency file, the shared extra args and the wait pattern."""
    launched: list[dict[str, Any]] = []

    def fake_launch(box: Sandbox, script: dict[str, Any], **kwargs: Any) -> TmuxPane:
        launched.append({"box": box, "script": script} | kwargs)
        return MagicMock()

    monkeypatch.setattr(fleet_load, "launch_tui", fake_launch)
    box = stub_sandbox(tmp_path)
    fleet = launch_fleet([box, box], {"s": 1}, tmp_path, interval_ms=7, extra_args=["--x"], wait_pattern=None)
    assert fleet.outs == [tmp_path / "latency-0.jsonl", tmp_path / "latency-1.jsonl"]
    assert [call["extra_args"] for call in launched] == [
        ["-e", str(LATENCY_EXTENSION), "--x"],
        ["-e", str(LATENCY_EXTENSION), "--x"],
    ]
    assert [call["env"]["PI_LATENCY_INTERVAL_MS"] for call in launched] == ["7", "7"]
    assert all(call["wait_pattern"] is None and call["box"] is box for call in launched)


def test_launch_fleet_kills_started_panes_on_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A failed second launch tears down the first pane before re-raising."""
    use_stub_pi(monkeypatch)
    real_launch = fleet_load.launch_tui
    started: list[TmuxPane] = []
    servers: list[int] = []
    failure = RuntimeError("second pane failed")

    def launch_once(box: Sandbox, script: dict[str, Any], **kwargs: Any) -> TmuxPane:
        if started:
            raise failure
        started.append(real_launch(box, script, **kwargs))
        assert started[0].is_alive()
        servers.append(int(tmux_query(started[0], "#{pid}")))
        return started[0]

    monkeypatch.setattr(fleet_load, "launch_tui", launch_once)
    box = stub_sandbox(tmp_path)
    boxes = [box, box]
    with pytest.raises(RuntimeError, match="second pane failed") as caught:
        launch_fleet(boxes, IDLE_SCRIPT, tmp_path)
    assert caught.value is failure
    (pane,) = started
    assert not pane.socket.parent.exists()
    assert not pane.is_alive()
    assert_exits(servers[0])
