"""Real wall-clock `/loop` tick and footer usage poll on the selected runtime, no timer scaling (#14).

The compiled Bun standalone once failed real-time `/loop` ticks and footer quota polls. In-process
tests (`packages/session-kit/test/loop.test.ts` with a fake clock) never run the runtime's own
timers, so this drives the installed stack in a real terminal: the loop's `setInterval` must fire
once on the runtime behind `PI_BIN` (Node bundle or `--runtime bun-standalone`).

References:
- https://github.com/nredd/pi-harness/blob/main/packages/session-kit/src/loop/index.ts
"""

from __future__ import annotations

import json
import logging
import time
from typing import TYPE_CHECKING

import pytest

from harness.interactive import submit
from harness.quota import USAGE_FIXTURE_EXTENSION, fixture_env, install_usage_fixture

if TYPE_CHECKING:
    from collections.abc import Callable

    from harness.quota import UsageFixture
    from harness.sandbox import Sandbox
    from harness.tmux import TmuxPane

LOGGER = logging.getLogger(__name__)
pytestmark = [pytest.mark.stack, pytest.mark.tui]
# `/loop` refuses anything under 30s, so one tick needs a real 30s interval.
INTERVAL_S = 30
# The footer's `POLL_INTERVAL_MS` in `packages/preset/lib/footer-quota.ts`.
POLL_INTERVAL_S = 60
STATUS = "STATUS-LINE-OK"
TICK_REPLY = "LOOP-TICK-REPLY-7f3a"
# The tick is the only prompt that ever reaches the provider, so its reply proves the timer fired.
# Bound: the interval, which runs from registration, plus 10 s over the measured 30.0-30.1 s tick.
# The wait is event driven and returns on the reply.
TICK_TIMEOUT_S = INTERVAL_S + 10
# Registration and stop notices are immediate; this only caps a dead command.
NOTICE_TIMEOUT_S = 10
# Lower bound: a tick far before the interval means the timer was not the interval's.
EARLY_SLACK_S = 5


def test_loop_tick_fires_on_real_timers(sandbox: Sandbox, tui: Callable[..., TmuxPane]) -> None:
    """`/loop 30s` registers, ticks once in real time, and stops.

    Parameters:
        sandbox (Sandbox): private installed stack with its declared session kit.
        tui (Callable[..., TmuxPane]): actual terminal launcher for that sandbox.
    """
    pane = tui({"providers": {"faux": {"models": ["main"], "steps": [{"text": TICK_REPLY}]}}})
    submit(pane, f"/loop {INTERVAL_S}s ping")
    pane.wait_for(rf"loop \d+: every {INTERVAL_S}s", timeout_s=NOTICE_TIMEOUT_S)
    assert TICK_REPLY not in pane.capture(), "Provider was called before the first interval"
    started = time.monotonic()
    pane.wait_for(TICK_REPLY, timeout_s=TICK_TIMEOUT_S)
    elapsed = time.monotonic() - started
    LOGGER.info("loop tick after %.1fs of a %ss interval", elapsed, INTERVAL_S)
    assert elapsed >= INTERVAL_S - EARLY_SLACK_S, "Tick arrived long before the interval"
    submit(pane, "/loop stop all")
    pane.wait_for(r"stopped \d+", timeout_s=NOTICE_TIMEOUT_S)


def test_footer_usage_poll_repeats_on_real_timers(sandbox: Sandbox, tui: Callable[..., TmuxPane]) -> None:
    """The footer's usage poll repeats at its real 60 s interval, read from the fixture's request log.

    Parameters:
        sandbox (Sandbox): private installed stack with its declared preset.
        tui (Callable[..., TmuxPane]): actual terminal launcher for that sandbox.
    """
    usage = install_usage_fixture(sandbox)
    usage.set(anthropic=(20, 40), codex=(30, 50))
    tui(
        {"providers": {"faux": {"models": ["main"], "steps": []}}},
        extra_args=["-e", str(USAGE_FIXTURE_EXTENSION)],
        env=fixture_env(usage),
        wait_pattern=STATUS,
    )
    first = wait_for_requests(usage, 1, timeout_s=15)[0]
    # Event driven: returns as soon as the second request lands; the bound only caps a dead timer.
    second = wait_for_requests(usage, 2, timeout_s=POLL_INTERVAL_S + 15)[1]
    gap = (second - first) / 1000
    LOGGER.info("footer usage poll gap %.1fs of a %ss interval", gap, POLL_INTERVAL_S)
    assert POLL_INTERVAL_S - EARLY_SLACK_S <= gap <= POLL_INTERVAL_S + 10, (
        f"Poll gap {gap:.1f}s, expected ~{POLL_INTERVAL_S}s"
    )


def wait_for_requests(usage: UsageFixture, count: int, *, timeout_s: float) -> list[int]:
    """Poll the usage request log until it holds `count` requests.

    Parameters:
        usage (UsageFixture): fixture whose log is read.
        count (int): requests to wait for.
        timeout_s (float): give up after this long.

    Returns:
        list[int]: epoch-millisecond timestamps of every request so far.

    Raises:
        AssertionError: fewer than `count` requests arrived in time.
    """
    deadline = time.monotonic() + timeout_s
    stamps: list[int] = []
    while time.monotonic() < deadline:
        if usage.log_path.exists():
            stamps = [json.loads(line)["t"] for line in usage.log_path.read_text().splitlines()]
            if len(stamps) >= count:
                return stamps
        time.sleep(0.25)
    raise AssertionError(f"Only {len(stamps)} of {count} usage requests in {timeout_s}s")
