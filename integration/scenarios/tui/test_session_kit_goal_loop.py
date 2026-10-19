"""Remaining goal/loop child-wait scenario, pending an injectable subagent outbox clock.

`/loop` needs a live, idle TUI (print mode disposes the session when the command returns), so the
loop scenarios run here. The 30s minimum interval is scaled to 1s with `providers/fast_timers.mjs`
(only timers of EXACTLY 30000 ms are touched), so a tick is about a second.

References:
- pi-session-kit: https://github.com/nredd/pi-session-kit
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any

import pytest

from harness.interactive import submit
from harness.quota import fixture_env
from harness.sandbox import enable_faux_models
from harness.session_kit import kit_args

if TYPE_CHECKING:
    from collections.abc import Callable

    from harness.sandbox import Sandbox
    from harness.tmux import TmuxPane

pytestmark = pytest.mark.tui

FAST = fixture_env(None, {30_000: 1_000})
CHILD = "kid/child"
EVIDENCE = "make test: 12 passed"


def script(steps: list[dict[str, Any]], **children: list[dict[str, Any]]) -> dict[str, Any]:
    """A faux script: the parent on `faux/main`, each child provider serving model `child`.

    Parameters:
        steps (list[dict[str, Any]]): parent steps.
        **children (list[dict[str, Any]]): provider name -> its steps.

    Returns:
        dict[str, Any]: `HARNESS_SCRIPT` payload.
    """
    providers: dict[str, Any] = {"faux": {"models": ["main"], "steps": steps}}
    providers |= {name: {"models": ["child"], "steps": kid} for name, kid in children.items()}
    return {"providers": providers}


@pytest.fixture
def pane_for(tui: Callable[..., TmuxPane], sandbox: Sandbox) -> Callable[[dict[str, Any]], TmuxPane]:
    """Launch a pane with the kit loaded and 1s loop ticks.

    Parameters:
        tui (Callable[..., TmuxPane]): pane launcher fixture.
        sandbox (Sandbox): isolated package settings.

    Returns:
        Callable[[dict[str, Any]], TmuxPane]: launcher taking a faux script.
    """

    def launch(payload: dict[str, Any]) -> TmuxPane:
        return tui(payload, extra_args=kit_args(sandbox), env=FAST)

    return launch


def test_no_tick_while_a_goal_waits_on_a_subagent(
    pane_for: Callable[[dict[str, Any]], TmuxPane], sandbox: Sandbox
) -> None:
    """An active goal that is idle (waiting for a background child) still owns the session.

    The goal skips its nudge until the child's notice is delivered, and the loop sends nothing in
    that gap. When the goal completes the loop ticks again.
    """
    enable_faux_models(sandbox, ["faux/main", CHILD])
    spawn = {
        "name": "Agent",
        "args": {
            "subagent_type": "general-purpose",
            "description": "slow child",
            "prompt": "work",
            "model": CHILD,
            "run_in_background": True,
        },
    }
    complete = {"name": "goal_update", "args": {"status": "complete", "evidence": EVIDENCE}}
    steps = [
        {"tools": [spawn]},
        {"text": "GOAL WAITING"},
        {"text": "AFTER NOTICE"},
        {"tools": [complete]},
        {"text": "GOAL END"},
    ]
    pane = pane_for(script(steps, kid=[{"delayMs": 8_000, "text": "CHILD RESULT"}]))
    submit(pane, "/loop 30s ping")
    pane.wait_for(r"loop 1: every 30s", timeout_s=15)
    submit(pane, "/goal watch the child")
    pane.wait_for(r"GOAL WAITING", timeout_s=30)
    time.sleep(3.5)
    submit(pane, "/loop list")
    pane.wait_for(r"1: every 30s, 0/50 runs, [1-9]\d* skipped", timeout_s=10)
    # the notice (not a nudge) is what wakes the parent, then the goal nudges and completes
    pane.wait_for(r"AFTER NOTICE", timeout_s=40)
    pane.wait_for(r"GOAL END", timeout_s=30)
    # goal complete -> the loop is free to tick: the scripted steps ran out, so a tick answers DONE
    pane.wait_for(r"\bDONE\b", timeout_s=30)
    submit(pane, "/loop stop all")
