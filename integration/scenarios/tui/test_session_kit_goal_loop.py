"""pi-session-kit `/loop` and `/goal` in real TUI panes: ticks, caps, suspension, isolation.

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


def ticks(count: int = 30, **step: Any) -> list[dict[str, Any]]:
    """Faux steps answering `tick 1` .. `tick N`, each with the same extra step keys.

    Parameters:
        count (int): number of steps.
        **step (Any): extra step keys, e.g. `delayMs`.

    Returns:
        list[dict[str, Any]]: faux steps.
    """
    return [{"text": f"tick {i}"} | step for i in range(1, count + 1)]


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


def count(pane: TmuxPane, pattern: str) -> int:
    """How many times a regex-free marker shows on the current screen.

    Parameters:
        pane (TmuxPane): pane to read.
        pattern (str): literal text.

    Returns:
        int: occurrences in the visible capture.
    """
    return pane.capture().count(pattern)


def test_loop_stops_itself_at_the_run_cap(pane_for: Callable[[dict[str, Any]], TmuxPane]) -> None:
    """`--max 2`: exactly two re-sends, then the loop says so and nothing more arrives."""
    pane = pane_for(script(ticks()))
    submit(pane, "/loop 30s ping --max 2")
    pane.wait_for(r"loop 1 finished: 2 runs", timeout_s=30)
    pane.wait_for(r"tick 2", timeout_s=15)
    pane.wait_stable(quiet_s=3.5, timeout_s=20)
    assert count(pane, "tick 3") == 0, pane.capture()
    submit(pane, "/loop list")
    pane.wait_for(r"no loops", timeout_s=10)


def test_loop_stop_ends_ticks(pane_for: Callable[[dict[str, Any]], TmuxPane]) -> None:
    """`/loop stop` cancels the timer: no further message after it."""
    pane = pane_for(script(ticks()))
    submit(pane, "/loop 30s ping")
    pane.wait_for(r"tick 1", timeout_s=30)
    submit(pane, "/loop stop 1")
    pane.wait_for(r"stopped 1", timeout_s=10)
    pane.wait_stable(quiet_s=1.5, timeout_s=20)
    seen = [n for n in range(2, 31) if f"tick {n}" in pane.capture()]
    time.sleep(3.5)
    after = [n for n in range(2, 31) if f"tick {n}" in pane.capture()]
    assert after == seen, f"a stopped loop kept ticking: {seen} -> {after}"
    submit(pane, "/loop list")
    pane.wait_for(r"no loops", timeout_s=10)


def test_busy_ticks_are_skipped_not_queued(pane_for: Callable[[dict[str, Any]], TmuxPane]) -> None:
    """A tick that finds the agent mid-turn counts as skipped, never as a run, and never queues."""
    pane = pane_for(script(ticks(delayMs=3_000)))
    submit(pane, "/loop 30s slow")
    pane.wait_for(r"loop 1: every 30s", timeout_s=15)
    pane.wait_for(r"tick 1", timeout_s=30)
    submit(pane, "/loop list")
    listing = pane.wait_for(r"1: every 30s, \d+/50 runs, [1-9]\d* skipped", timeout_s=10)
    assert "slow" in listing
    submit(pane, "/loop stop all")
    pane.wait_for(r"stopped 1", timeout_s=10)


def test_loop_is_suspended_in_plan_mode(pane_for: Callable[[dict[str, Any]], TmuxPane]) -> None:
    """In Plan mode ticks skip without spending runs; leaving it lets the loop run again."""
    pane = pane_for(script(ticks()))
    submit(pane, "/plan start")
    pane.wait_for(r"Plan mode enabled", timeout_s=15)
    submit(pane, "/loop 30s ping --max 5")
    pane.wait_for(r"loop 1: every 30s", timeout_s=15)
    time.sleep(3.5)
    submit(pane, "/loop list")
    pane.wait_for(r"1: every 30s, 0/5 runs, [1-9]\d* skipped", timeout_s=10)
    assert count(pane, "tick 1") == 0, pane.capture()
    submit(pane, "/plan exit")
    pane.wait_for(r"tick 1", timeout_s=30)
    submit(pane, "/loop stop all")


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


def test_two_panes_in_one_cwd_keep_independent_goals_and_loops(
    pane_for: Callable[[dict[str, Any]], TmuxPane],
) -> None:
    """Same cwd, two processes: pane A owns a goal, pane B owns a loop; neither sees the other's."""
    a = pane_for(script([{"delayMs": 1_500, "text": f"A turn {i}"} for i in range(1, 30)]))
    b = pane_for(script(ticks()))
    submit(a, "/goal alpha work --turns 50")
    a.wait_for(r"A turn 2", timeout_s=30)
    submit(b, "/loop 30s beta --max 3")
    b.wait_for(r"tick 1", timeout_s=30)

    submit(b, "/goal status")
    b.wait_for(r"no goal\.", timeout_s=10)
    submit(a, "/loop list")
    a.wait_for(r"no loops", timeout_s=10)
    assert "alpha work" not in b.capture(), b.capture()
    assert "beta" not in a.capture(), a.capture()

    # B's loop is not held back by A's goal, and A's goal runs on with B busy
    b.wait_for(r"loop 1 finished: 3 runs", timeout_s=30)
    submit(a, "/goal pause")
    a.wait_for(r"goal paused", timeout_s=10)
    submit(b, "/goal status")
    b.wait_for(r"no goal\.", timeout_s=10)
