"""Startup and time-to-first-token benchmarks with faux providers."""

from __future__ import annotations

import time
from typing import TYPE_CHECKING

import pytest

from harness.bench import check_against_baseline, measure
from harness.headless import run_headless
from harness.interactive import FIRST_FRAME_PATTERN, launch_tui

if TYPE_CHECKING:
    from harness.sandbox import Sandbox

pytestmark = pytest.mark.bench

ECHO_SCRIPT = {"providers": {"faux": {"models": ["main"], "steps": [{"text": "OK"}]}}}


def test_cold_startup_to_first_frame(sandbox: Sandbox) -> None:
    """Launch to the first drawn footer, interactive."""

    def sample() -> float:
        started = time.monotonic()
        pane = launch_tui(sandbox, ECHO_SCRIPT, name=f"bench{time.monotonic_ns()}", wait_pattern=None)
        try:
            pane.wait_for(FIRST_FRAME_PATTERN, timeout_s=60)
            return time.monotonic() - started
        finally:
            pane.kill()

    check_against_baseline("startup_first_frame_s", measure(sample))


def test_time_to_first_token(sandbox: Sandbox) -> None:
    """Process start to the first streamed assistant update, headless."""

    def sample() -> float:
        result = run_headless(sandbox, ECHO_SCRIPT, ["hi"], persist_session=False)
        assert "message_update" in result.first_event_s, result.transcript()
        return result.first_event_s["message_update"]

    check_against_baseline("ttft_s", measure(sample))
