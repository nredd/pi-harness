"""Every transcript entry settles as one line; only entries with hidden detail toggle.

The checks are generic over the screen. Settled tools with no additional detail keep a blank
(two-space) gutter, remain one line on click and ignore the global expansion shortcut.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

import pytest

from harness.interactive import submit
from harness.transcript import (
    EXPANDED,
    collapsed_entries,
    entry_key,
    one_line_violations,
    transcript_region,
)

if TYPE_CHECKING:
    from collections.abc import Callable

    from harness.sandbox import Sandbox
    from harness.tmux import TmuxPane

pytestmark = pytest.mark.tui

WIDTH, HEIGHT = 140, 90
PROMPT = r"^\s*go\s*$"
FINAL = "ALL ROWS DONE"
# Unmarked rows the script itself produces: its final text, and the reply to any follow-up turn
# a subagent notice triggers. Assistant prose carries the `│` rule.
ALLOWED_TEXT = [rf"^│ {FINAL}$", r"^│ DONE$"]
# The kitchen sink's todo overlay sits above the editor, so its region ends at the last reply.
LAST_ROW = "|".join(ALLOWED_TEXT)


def tool(name: str, **args: Any) -> dict[str, Any]:
    """One faux step calling one tool.

    Parameters:
        name (str): tool name.
        **args (Any): tool arguments.

    Returns:
        dict[str, Any]: faux step.
    """
    return {"tools": [{"name": name, "args": args}]}


PLAN_ROWS: dict[str, Any] = {
    "providers": {
        "faux": {
            "models": ["main"],
            "steps": [
                tool(
                    "plan_mode_question",
                    questions=[
                        {
                            "id": "scope",
                            "header": "Scope",
                            "question": "How wide?",
                            "options": [
                                {"label": "Narrow", "description": "Smallest diff."},
                                {"label": "Wide", "description": "Everything."},
                            ],
                        }
                    ],
                ),
                tool("plan_mode_complete", plan="# Tiny plan\n\n- Do the narrow thing.\n"),
                {"text": FINAL},
            ],
        }
    }
}


def assert_one_line_everywhere(rows: list[str], last_pattern: str | None = LAST_ROW) -> list[str]:
    """Assert the transcript invariant and return the collapsed entry keys.

    Parameters:
        rows (list[str]): settled plain rows.
        last_pattern (str | None): regex ending the region; `None` runs it to the editor.

    Returns:
        list[str]: entry keys in screen order.
    """
    start, end = transcript_region(rows, PROMPT, last_pattern)
    problems = one_line_violations(rows, start, end, ALLOWED_TEXT)
    assert not problems, "\n".join(problems) + "\n--- screen\n" + "\n".join(rows)
    return [entry.key for entry in collapsed_entries(rows, start, end)]


def expanded_headers(rows: list[str], last_pattern: str | None = LAST_ROW) -> list[int]:
    """Return the `▾` rows inside the transcript, ignoring widgets above the editor.

    Parameters:
        rows (list[str]): plain screen rows.
        last_pattern (str | None): regex ending the region; `None` runs it to the editor.

    Returns:
        list[int]: row indexes of expanded entries.
    """
    start, end = transcript_region(rows, PROMPT, last_pattern)
    return [index for index in range(start, end) if rows[index].startswith(EXPANDED)]


def assert_each_entry_toggles(pane: TmuxPane, keys: list[str], last_pattern: str | None = LAST_ROW) -> None:
    """Click every collapsed entry open, check it expanded, click its header closed.

    Parameters:
        pane (TmuxPane): settled pane.
        keys (list[str]): entry keys from `assert_one_line_everywhere`.
        last_pattern (str | None): regex ending the region; `None` runs it to the editor.
    """
    for occurrence, key in enumerate(keys):
        rows = pane.rows()
        start, end = transcript_region(rows, PROMPT, last_pattern)
        row = collapsed_entries(rows, start, end)[occurrence].row
        pane.click(6, row)
        expanded_rows = pane.wait_stable(quiet_s=0.5, timeout_s=10)
        headers = expanded_headers(expanded_rows, last_pattern)
        screen = "\n".join(expanded_rows)
        assert len(headers) == 1, f"clicking {key!r} did not expand exactly one entry:\n{screen}"
        expanded_key = entry_key(expanded_rows[headers[0]])
        # Collapsed calls may inline their args; the expanded header can show fewer.
        assert key.startswith(expanded_key) or expanded_key.startswith(key), (
            f"expanded {expanded_key!r}, not {key!r}"
        )
        pane.click(6, headers[0])
        collapsed_rows = pane.wait_stable(quiet_s=0.5, timeout_s=10)
        assert not expanded_headers(collapsed_rows, last_pattern), (
            f"{key!r} did not collapse again:\n" + "\n".join(collapsed_rows)
        )


def test_plan_mode_rows_are_one_line_and_collapsible(tui: Callable[..., TmuxPane], sandbox: Sandbox) -> None:
    """Both Plan tools and the `/plan show` message settle as one line each and toggle."""
    pane = tui(PLAN_ROWS, width=WIDTH, height=HEIGHT)
    submit(pane, "/plan start")
    pane.wait_stable(quiet_s=1, timeout_s=20)
    submit(pane, "go")
    pane.wait_for(r"Narrow", timeout_s=30)
    pane.send_keys("Enter")
    # Stay in Plan mode on the ready-plan chooser: Escape keeps the plan.
    pane.wait_for(r"(?i)tiny plan", timeout_s=30)
    pane.wait_stable(quiet_s=1, timeout_s=20)
    pane.send_keys("Escape")
    pane.wait_stable(quiet_s=2, timeout_s=30)
    # `/plan show` posts the plan as a `proposed-plan` message; it must collapse like a tool row.
    submit(pane, "/plan show")
    pane.wait_for(r"Proposed Plan", timeout_s=30)
    rows = pane.wait_stable(quiet_s=2, timeout_s=30)

    keys = assert_one_line_everywhere(rows, None)
    screen = "\n".join(rows)
    assert re.search(r"^▸ .*Scope → Narrow", screen, re.MULTILINE), screen
    assert re.search(r"^▸ .*Tiny plan · plan proposed", screen, re.MULTILINE), screen
    assert re.search(r"^▸ Proposed Plan · Tiny plan", screen, re.MULTILINE), screen
    assert_each_entry_toggles(pane, keys, None)
