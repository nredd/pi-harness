"""The subagent conversation viewer: opened from the fleet by keyboard, scrolled by the wheel
(Alt scrolls further), closed by clicking the footer's `Esc close`.

The wheel step is pinned with `fullscreenWheelScrollLines`, so one notch is exactly
`WHEEL_LINES` and an Alt notch is the host's 5x of it.
"""

from __future__ import annotations

import re
import time
from typing import TYPE_CHECKING, Any

import pytest

from harness.interactive import submit
from harness.sandbox import enable_faux_models

if TYPE_CHECKING:
    from collections.abc import Callable

    from harness.sandbox import Sandbox
    from harness.tmux import TmuxPane

pytestmark = pytest.mark.tui

WIDTH, HEIGHT = 120, 40
WHEEL_LINES = 3
ALT_MULTIPLIER = 5
PROMPT_LINES = 200
# Each prompt line is a list item, so it renders as its own row in raw and markdown modes.
CHILD_PROMPT = "\n".join(f"- L{n:03d}" for n in range(1, PROMPT_LINES + 1))
FLEET_CHILD = r"^\s+[●○] general-purpose\s+viewer child"
FLEET_HINT = r"↓ to manage"
FLEET_ACTIVE_HINT = r"enter view"
VIEWER_HINT = r"↑↓ scroll · PgUp/PgDn or Shift\+↑↓ · Esc close"
CLOSE_LABEL = "Esc close"
NUMBERED = re.compile(r"\bL(\d{3})\b")
SCROLL_TIMEOUT_S = 5.0
# The viewer redraws its running clock every second, so the screen is never quiet; wait for
# the content instead.
OPEN_SETTLE_S = 1.0


def spawn_script() -> dict[str, Any]:
    """Main spawns one background child with a long prompt; the child stays busy.

    Returns:
        dict[str, Any]: faux script.
    """
    agent_args = {
        "subagent_type": "general-purpose",
        "description": "viewer child",
        "prompt": CHILD_PROMPT,
        "run_in_background": True,
        "model": "fauxchild/child",
    }
    return {
        "providers": {
            "faux": {
                "models": ["main"],
                "steps": [{"tools": [{"name": "Agent", "args": agent_args}]}, {"text": "SPAWNED"}],
            },
            "fauxchild": {"models": ["child"], "steps": [{"delayMs": 120_000, "text": "CHILD DONE"}]},
        }
    }


def first_visible_line(rows: list[str]) -> int:
    """Return the lowest prompt line number on screen.

    Parameters:
        rows (list[str]): plain rows of the open viewer.

    Returns:
        int: smallest `Lnnn` visible.

    Raises:
        AssertionError: no prompt line is visible.
    """
    numbers = [int(match) for row in rows for match in NUMBERED.findall(row)]
    assert numbers, "no prompt line visible in the viewer:\n" + "\n".join(rows)
    return min(numbers)


def find_close_label(rows: list[str]) -> tuple[int, int]:
    """Locate the footer's `Esc close` label.

    Parameters:
        rows (list[str]): plain rows of the open viewer.

    Returns:
        tuple[int, int]: zero-based (row, column) of the label's middle cell.

    Raises:
        AssertionError: the label is not on screen.
    """
    for row_index in range(len(rows) - 1, -1, -1):
        column = rows[row_index].find(CLOSE_LABEL)
        if column >= 0:
            return row_index, column + len(CLOSE_LABEL) // 2
    raise AssertionError("no `Esc close` footer label:\n" + "\n".join(rows))


def wait_first_line(pane: TmuxPane, expected: int, what: str) -> None:
    """Poll until the viewer's top prompt line is `expected`; its clock keeps the screen moving.

    Parameters:
        pane (TmuxPane): pane with the viewer open.
        expected (int): prompt line number that must be first.
        what (str): action being checked, for the failure message.

    Raises:
        AssertionError: the top line never became `expected`.
    """
    deadline = time.monotonic() + SCROLL_TIMEOUT_S
    seen = first_visible_line(pane.rows())
    while seen != expected and time.monotonic() < deadline:
        time.sleep(0.1)
        seen = first_visible_line(pane.rows())
    assert seen == expected, f"{what}: top line is L{seen:03d}, expected L{expected:03d}\n" + pane.capture()


def test_viewer_wheel_and_click_footer_close(tui: Callable[..., TmuxPane], sandbox: Sandbox) -> None:
    """Fleet ↓↓ Enter opens the viewer; wheel moves 3 lines, Alt+wheel 15; footer `Esc close` closes it."""
    enable_faux_models(sandbox, ["faux/main", "fauxchild/child"])
    sandbox.patch_json("settings.json", {"fullscreenWheelScrollLines": WHEEL_LINES})
    pane = tui(spawn_script(), width=WIDTH, height=HEIGHT)
    submit(pane, "go")
    pane.wait_for("SPAWNED", timeout_s=30)
    pane.wait_for(FLEET_CHILD, timeout_s=10)
    pane.wait_for(FLEET_HINT, timeout_s=5)

    # The fleet hint's keyboard path: ↓ into the list (on `main`), ↓ to the child, Enter.
    pane.send_keys("Down")
    pane.wait_for(FLEET_ACTIVE_HINT, timeout_s=5)
    pane.send_keys("Down")
    pane.send_keys("Enter")
    screen = pane.wait_for(VIEWER_HINT, timeout_s=10)
    assert "PgUp/PgDn" in screen
    pane.wait_for(r"L200", timeout_s=10)
    time.sleep(OPEN_SETTLE_S)
    start = first_visible_line(pane.rows())
    assert start > WHEEL_LINES * (ALT_MULTIPLIER + 1), "viewer opened too near the top to wheel up"

    center = (WIDTH // 2, HEIGHT // 2)
    pane.wheel(*center, down=False)
    wait_first_line(pane, start - WHEEL_LINES, "wheel up")
    pane.wheel(*center, down=False, alt=True)
    wait_first_line(pane, start - WHEEL_LINES * (ALT_MULTIPLIER + 1), "Alt+wheel up")
    pane.wheel(*center, down=True)
    wait_first_line(pane, start - WHEEL_LINES * ALT_MULTIPLIER, "wheel down")

    # Fullscreen observer has no backdrop margin: the footer's `Esc close` is the clickable close.
    close_row, close_col = find_close_label(pane.rows())
    pane.click(close_col, close_row)
    pane.wait_for(VIEWER_HINT, timeout_s=5, absent=True)
    pane.wait_for(FLEET_CHILD, timeout_s=5)
