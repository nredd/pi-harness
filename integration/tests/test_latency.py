"""Latency helpers: percentiles, probe-record reduction, WSL detection, fleet wiring, ceilings."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

import pytest

from harness import bench
from harness.fleet_load import make_sandboxes, streaming_script
from harness.latency import Reading, combine, latency_args, percentile, read_records, summarize
from harness.paths import is_wsl

if TYPE_CHECKING:
    from pathlib import Path


def window(
    t: float, *, p99: float, max_: float, stalls: int, nbytes: int, inputs: list[float]
) -> dict[str, object]:
    return {
        "kind": "summary",
        "t": t,
        "window_s": 1.0,
        "loop_lag_ms": {"p50": 1, "p95": 2, "p99": p99, "max": max_},
        "stalls": [{"at": t, "ms": 60}] * stalls,
        "write": {"bytes": nbytes, "calls": 1, "max_block_ms": 0.5, "total_block_ms": 0.5},
        "input_to_paint_ms": inputs,
    }


def test_percentile_nearest_rank() -> None:
    assert percentile([], 0.95) == 0.0
    assert percentile([5.0], 0.5) == 5.0
    assert percentile(range(1, 101), 0.95) == 95
    assert percentile([3, 1, 2], 1.0) == 3
    with pytest.raises(ValueError, match="`q`"):
        percentile([1], 0)


def test_summarize_filters_by_time_and_reduces() -> None:
    records = [
        {"kind": "start", "t": 0},
        window(100, p99=90, max_=90, stalls=3, nbytes=5000, inputs=[9.0]),
        window(2000, p99=10, max_=20, stalls=1, nbytes=1000, inputs=[1.0, 3.0]),
        window(3000, p99=30, max_=40, stalls=0, nbytes=3000, inputs=[]),
    ]
    reading = summarize(records, since_ms=1000)
    assert reading.loop_lag_p99_ms == 30
    assert reading.loop_lag_max_ms == 40
    assert reading.stalls == 1
    assert reading.bytes_per_s == 2000
    assert reading.input_to_paint_ms == [1.0, 3.0]
    assert summarize(records, since_ms=10_000) == Reading(0.0, 0.0, 0, 0.0, 0.0, [])


def test_combine_uses_median_for_p99_and_worst_for_max() -> None:
    readings = [Reading(p, p * 2, 1, 100.0, p, []) for p in (10.0, 20.0, 90.0)]
    fleet = combine(readings)
    assert fleet["loop_lag_p99_ms"] == 20.0
    assert fleet["loop_lag_max_ms"] == 180.0
    assert fleet["stalls"] == 3
    assert fleet["bytes_per_s"] == 300.0
    with pytest.raises(ValueError, match="No readings"):
        combine([])


def test_read_records_skips_a_torn_line(tmp_path: Path) -> None:
    path = tmp_path / "p.jsonl"
    assert read_records(path) == []
    path.write_text(json.dumps({"kind": "start"}) + '\n{"kind": "summ')
    assert read_records(path) == [{"kind": "start"}]


def test_latency_args_point_at_the_file(tmp_path: Path) -> None:
    args, env = latency_args(tmp_path / "x.jsonl", 250)
    assert args[0] == "-e"
    assert args[1].endswith("probes/latency.ts")
    assert env == {"PI_LATENCY_PROBE": str(tmp_path / "x.jsonl"), "PI_LATENCY_INTERVAL_MS": "250"}


def test_is_wsl(tmp_path: Path) -> None:
    version = tmp_path / "version"
    assert not is_wsl(version)
    version.write_text("Linux version 6.6.87.2-microsoft-standard-WSL2 (root@x)")
    assert is_wsl(version)
    version.write_text("Linux version 6.8.0-generic (buildd@lcy02)")
    assert not is_wsl(version)


def test_baseline_meta_is_recorded_and_ceiling_is_fixed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    path = tmp_path / "bench.json"
    monkeypatch.setattr(bench, "BASELINES_PATH", path)
    monkeypatch.setenv("UPDATE_BASELINES", "1")
    bench.check_against_baseline("m", 2.0)
    monkeypatch.delenv("UPDATE_BASELINES")
    assert json.loads(path.read_text())["_meta"]["wsl"] is is_wsl()
    bench.check_against_baseline("m", 2.2)
    bench.check_ceiling("r", 3.0, 3.0)
    with pytest.raises(AssertionError, match="ceiling"):
        bench.check_ceiling("r", 3.1, 3.0)


def test_wsl_mismatch_warns_but_does_not_fail(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    path = tmp_path / "bench.json"
    path.write_text(json.dumps({"m": 1.0, "_meta": {"wsl": not is_wsl(), "cpus": 4}}))
    monkeypatch.setattr(bench, "BASELINES_PATH", path)
    bench.check_against_baseline("m", 1.0)
    assert "this run differs" in caplog.text


def test_make_sandboxes_share_or_isolate(tmp_path: Path) -> None:
    template = tmp_path / "tpl"
    (template / ".pi" / "agent").mkdir(parents=True)
    shared = make_sandboxes(tmp_path / "a", template, 3, shared=True)
    assert len({box.agent_dir for box in shared}) == 1
    isolated = make_sandboxes(tmp_path / "b", template, 3, shared=False)
    assert len({box.agent_dir for box in isolated}) == 3
    with pytest.raises(ValueError, match="`count`"):
        make_sandboxes(tmp_path / "c", template, 0, shared=True)


def test_streaming_script_is_paced() -> None:
    provider = streaming_script(100, 250)["providers"]["faux"]
    assert provider["tokensPerSecond"] == 250
    assert len(provider["steps"][0]["text"]) == 100
