"""A click on the rpiv-todo `Todos` heading collapses its list; another click brings it back."""

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
SUBJECTS = ("Alpha task", "Bravo task")
SCRIPT: dict[str, Any] = {
    "providers": {
        "faux": {
            "models": ["main"],
            "steps": [
                *(
                    {"tools": [{"name": "todo", "args": {"action": "create", "subject": s}}]}
                    for s in SUBJECTS
                ),
                {"text": DONE},
            ],
        }
    }
}
EXPANDED_HEADING = r"^\s*▾ [●○] Todos \(2 open\)"
COLLAPSED_HEADING = r"^\s*▸ [●○] Todos \(2 open\)"
TASK_ROW = r"[├└]─ .*{subject}"
EXPAND_HINT = r"└─ .*(to expand|collapsed)"


def assert_tasks_listed(screen: str, *, listed: bool) -> None:
    """Assert every task row is (or is not) under the heading.

    Parameters:
        screen (str): plain capture.
        listed (bool): whether the rows must be present.
    """
    for subject in SUBJECTS:
        found = re.search(TASK_ROW.format(subject=subject), screen) is not None
        assert found == listed, f"task {subject!r} listed={found}, expected {listed}:\n{screen}"


def test_heading_click_toggles_the_list(tui: Callable[..., TmuxPane]) -> None:
    """Heading click -> `▸`, tasks hidden, expand hint shown; click again -> `▾` and tasks back."""
    pane = tui(SCRIPT)
    submit(pane, "go")
    pane.wait_for(DONE, timeout_s=60)
    screen = pane.wait_for(EXPANDED_HEADING, timeout_s=10)
    assert_tasks_listed(screen, listed=True)

    heading = find_row(pane.rows(), EXPANDED_HEADING)
    pane.click(6, heading)
    screen = pane.wait_for(COLLAPSED_HEADING, timeout_s=5)
    assert_tasks_listed(screen, listed=False)
    assert re.search(EXPAND_HINT, screen), f"collapsed heading has no expand hint:\n{screen}"

    pane.click(6, find_row(pane.rows(), COLLAPSED_HEADING))
    screen = pane.wait_for(EXPANDED_HEADING, timeout_s=5)
    assert_tasks_listed(screen, listed=True)
