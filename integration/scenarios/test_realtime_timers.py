"""Real wall-clock `/loop` tick on the selected runtime, no timer scaling (#14).

The compiled Bun standalone once failed real-time `/loop` ticks and footer quota polls. In-process
tests (`packages/session-kit/test/loop.test.ts` with a fake clock) never run the runtime's own
timers, so this drives the installed stack in a real terminal: the loop's `setInterval` must fire
once on the runtime behind `PI_BIN` (Node bundle or `--runtime bun-standalone`).

References:
- https://github.com/nredd/pi-harness/blob/main/packages/session-kit/src/loop/index.ts
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING

import pytest

from harness.interactive import submit

if TYPE_CHECKING:
    from collections.abc import Callable

    from harness.sandbox import Sandbox
    from harness.tmux import TmuxPane

LOGGER = logging.getLogger(__name__)
pytestmark = [pytest.mark.stack, pytest.mark.tui]
# `/loop` refuses anything under 30s, so one tick needs a real 30s interval.
INTERVAL_S = 30
TICK_REPLY = "LOOP-TICK-REPLY-7f3a"
# The tick is the only prompt that ever reaches the provider, so its reply proves the timer fired.
# Bound: interval plus startup-to-submit slack; the wait is event driven and returns on the reply.
TICK_TIMEOUT_S = INTERVAL_S + 10


def test_loop_tick_fires_on_real_timers(sandbox: Sandbox, tui: Callable[..., TmuxPane]) -> None:
    """`/loop 30s` registers, ticks once in real time, and stops.

    Parameters:
        sandbox (Sandbox): private installed stack with its declared session kit.
        tui (Callable[..., TmuxPane]): actual terminal launcher for that sandbox.
    """
    pane = tui({"providers": {"faux": {"models": ["main"], "steps": [{"text": TICK_REPLY}]}}})
    submit(pane, f"/loop {INTERVAL_S}s ping")
    pane.wait_for(rf"loop \d+: every {INTERVAL_S}s", timeout_s=10)
    assert TICK_REPLY not in pane.capture(), "Provider was called before the first interval"
    started = time.monotonic()
    pane.wait_for(TICK_REPLY, timeout_s=TICK_TIMEOUT_S)
    elapsed = time.monotonic() - started
    LOGGER.info("loop tick after %.1fs of a %ss interval", elapsed, INTERVAL_S)
    assert elapsed >= INTERVAL_S - 5, "Tick arrived long before the interval"
    submit(pane, "/loop stop all")
    pane.wait_for(r"stopped \d+")
