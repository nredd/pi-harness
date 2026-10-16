"""The rpiv-todo widget scrolls by mouse wheel over every todo; `ops` fills and closes it in two calls."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

import pytest

from harness.interactive import submit
from harness.tmux import find_row

if TYPE_CHECKING:
    from collections.abc import Callable

    from harness.tmux import TmuxPane

pytestmark = pytest.mark.tui

DONE = "TODOS DONE"
COUNT = 28
CLOSED = 3
SCRIPT: dict[str, Any] = {
    "providers": {
        "faux": {
            "models": ["main"],
            "steps": [
                {
                    "tools": [
                        {
                            "name": "todo",
                            "args": {
                                "ops": [
                                    {"action": "create", "subject": f"Item {n:02d}"}
                                    for n in range(1, COUNT + 1)
                                ]
                            },
                        }
                    ]
                },
                {
                    "tools": [
                        {
                            "name": "todo",
                            "args": {
                                "ops": [
                                    {
                                        "action": "update",
                                        "id": n,
                                        "status": "completed",
                                        "evidence": f"proof {n}",
                                    }
                                    for n in range(1, CLOSED + 1)
                                ]
                            },
                        }
                    ]
                },
                {"text": DONE},
            ],
        }
    }
}
HEADING = rf"^\s*▾ [●○] Todos \({CLOSED} done, {COUNT - CLOSED} open\)"
BELOW = r"└─ ↓ (\d+) below"


def test_wheel_scrolls_every_todo(tui: Callable[..., TmuxPane]) -> None:
    """Two `ops` calls build 28 todos and close 3; the heading sums, and the wheel reaches the last row."""
    pane = tui(SCRIPT, height=40)
    submit(pane, "go")
    pane.wait_for(DONE, timeout_s=60)
    screen = pane.wait_for(HEADING, timeout_s=10)
    assert "Item 01" in screen
    assert f"Item {COUNT:02d}" not in screen, f"last todo visible before scrolling:\n{screen}"
    hidden = re.search(BELOW, screen)
    assert hidden, f"no '↓ N below' hint:\n{screen}"

    row = find_row(pane.rows(), HEADING) + 3
    for _ in range(COUNT):
        pane.wheel(10, row, down=True)
    screen = pane.wait_for(rf"└─ .*Item {COUNT:02d}", timeout_s=10)
    assert "below" not in screen, f"'below' hint left at the end of the list:\n{screen}"
    assert re.search(r"├─ ↑ \d+ above", screen), f"no '↑ N above' hint:\n{screen}"
