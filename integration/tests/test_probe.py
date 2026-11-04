"""`run_probe` through a real pane: `/harness-probe` in the stub TUI appends the reading.

The stub writes frame times `1..N` ms, steady frames at half that, and a 3 MiB heap, so the
parsed `ProbeResult` math is exact.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from harness import probe
from harness.paths import PROBE_EXTENSION
from harness.probe import ProbeResult, probe_args, run_probe
from tests.stub_pi_session import FakeClock, stub_sandbox, stub_tui

if TYPE_CHECKING:
    from pathlib import Path


def test_probe_args_load_the_extension_with_gc(tmp_path: Path) -> None:
    """The probe extension, its output path and `--expose-gc` are the whole contract."""
    out = tmp_path / "probe.jsonl"
    assert probe_args(out) == (
        ["-e", str(PROBE_EXTENSION)],
        {"HARNESS_PROBE_OUT": str(out), "NODE_OPTIONS": "--expose-gc"},
    )


def test_run_probe_returns_each_new_reading(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Each run reads only the line its own command appended."""
    out = tmp_path / "probe.jsonl"
    args, env = probe_args(out)
    with stub_tui(monkeypatch, stub_sandbox(tmp_path), name="probe", extra_args=args, env=env) as pane:
        first = run_probe(pane, out, frames=3)
        second = run_probe(pane, out, frames=4)
    assert first == ProbeResult(
        frames_ms=[1.0, 2.0, 3.0], steady_frames_ms=[0.5, 1.0, 1.5], heap_used_mb=3.0, gc=True
    )
    assert (first.frame_ms, first.steady_frame_ms) == (2.0, 1.0)
    assert (second.frame_ms, second.steady_frame_ms) == (2.5, 1.25)
    assert len(out.read_text().splitlines()) == 2


def test_run_probe_times_out_with_the_screen(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A probe that never writes the awaited file fails with the pane capture attached."""
    written, awaited = tmp_path / "written.jsonl", tmp_path / "awaited.jsonl"
    args, env = probe_args(written)
    with stub_tui(monkeypatch, stub_sandbox(tmp_path), name="silent", extra_args=args, env=env) as pane:
        clock = FakeClock()
        monkeypatch.setattr(probe, "time", clock)
        with pytest.raises(AssertionError, match=r"wrote nothing to '.*awaited.jsonl' in 120.0s\n") as caught:
            run_probe(pane, awaited, frames=2)
        assert "stub pi model main" in str(caught.value)
        assert clock.now >= probe.PROBE_TIMEOUT_S
        assert not awaited.exists()
