"""The latency probe itself: it must see a blocked event loop, keystrokes, and idle silence."""

from __future__ import annotations

import time
from typing import TYPE_CHECKING

import pytest

from harness.fleet_load import IDLE_SCRIPT
from harness.interactive import launch_tui
from harness.latency import latency_args, read_records, summarize

if TYPE_CHECKING:
    from harness.sandbox import Sandbox

pytestmark = pytest.mark.tui

BLOCK_MS = 400


def test_probe_reports_a_blocked_event_loop(sandbox: Sandbox) -> None:
    """A deliberate 400 ms block is reported as a stall of about that size."""
    out = sandbox.root / "lat.jsonl"
    args, env = latency_args(out, 500)
    pane = launch_tui(
        sandbox, IDLE_SCRIPT, extra_args=args, env=env | {"PI_LATENCY_STALL_BLOCK_MS": str(BLOCK_MS)}
    )
    try:
        deadline = time.monotonic() + 15
        reading = summarize([])
        while time.monotonic() < deadline and reading.stalls == 0:
            time.sleep(0.3)
            reading = summarize(read_records(out))
        assert reading.stalls >= 1, read_records(out)
        assert BLOCK_MS * 0.8 <= reading.loop_lag_max_ms <= BLOCK_MS * 3, reading
        start = read_records(out)[0]
        assert start["kind"] == "start"
        assert start["tui"] is True, "the probe never captured the TUI; write accounting is blind"
    finally:
        pane.kill()


def test_probe_sees_keystrokes_and_idle_silence(sandbox: Sandbox) -> None:
    """Typing yields input-to-paint samples; an idle pane writes (almost) nothing."""
    out = sandbox.root / "lat.jsonl"
    args, env = latency_args(out, 500)
    pane = launch_tui(sandbox, IDLE_SCRIPT, extra_args=args, env=env)
    try:
        time.sleep(3)
        idle_from = time.time() * 1000
        time.sleep(4)
        idle = summarize(read_records(out), idle_from)
        assert idle.bytes_per_s < 200, f"idle pi writes {idle.bytes_per_s:.0f} B/s"
        typed_from = time.time() * 1000
        for _ in range(8):
            pane.type_text("x")
            time.sleep(0.2)
        time.sleep(1.5)
        typed = summarize(read_records(out), typed_from)
        assert len(typed.input_to_paint_ms) >= 4, typed
        assert typed.input_p95_ms < 500, typed
    finally:
        pane.kill()
