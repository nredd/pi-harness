"""Settled tool rows collapse to one line, and a click toggles them, in a real terminal."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

import pytest

from harness.interactive import submit
from harness.tmux import find_row
from harness.transcript import ENTRY_RULE

if TYPE_CHECKING:
    from collections.abc import Callable

    from harness.sandbox import Sandbox
    from harness.tmux import TmuxPane

pytestmark = pytest.mark.tui

DONE = "ALL TOOLS DONE"
SCRIPT: dict[str, Any] = {
    "providers": {
        "faux": {
            "models": ["main"],
            "steps": [
                {"tools": [{"name": "bash", "args": {"command": "printf 'a\\nb\\nc\\n'"}}]},
                {"tools": [{"name": "read", "args": {"path": "notes.txt"}}]},
                {
                    "tools": [
                        {
                            "name": "edit",
                            "args": {
                                "path": "notes.txt",
                                "edits": [
                                    {"oldText": "beta", "newText": "gamma"},
                                ],
                            },
                        }
                    ]
                },
                {"tools": [{"name": "write", "args": {"path": "new.txt", "content": "one\ntwo\n"}}]},
                {"text": DONE},
            ],
        }
    }
}
# Collapsed row regexes: call and summary share one line.
ROWS = {
    "bash": r"^▸ +\$ printf .*· 3 lines output",
    "read": r"^▸ +read notes\.txt",
    "edit": r"^▸ +edit notes\.txt · \+1 -1",
    "write": r"^▸ +write new\.txt · 2 lines",
}
SIZES = [(120, 40), (80, 24)]


def run_tools(tui: Callable[..., TmuxPane], sandbox: Sandbox, width: int, height: int) -> TmuxPane:
    """Launch pi, run the four-tool script, and wait for the final reply.

    Parameters:
        tui (Callable[..., TmuxPane]): pane launcher fixture.
        sandbox (Sandbox): sandbox the pane runs in.
        width (int): pane columns.
        height (int): pane rows.

    Returns:
        TmuxPane: pane showing the settled transcript.
    """
    (sandbox.workdir / "notes.txt").write_text("alpha\nbeta\n")
    pane = tui(SCRIPT, width=width, height=height)
    submit(pane, "go")
    pane.wait_for(DONE, timeout_s=60)
    return pane


@pytest.mark.parametrize(("width", "height"), SIZES)
def test_collapsed_rows_are_one_line(
    tui: Callable[..., TmuxPane], sandbox: Sandbox, width: int, height: int
) -> None:
    """Each collapsed tool row is one line followed by an entry rule, never output."""
    pane = run_tools(tui, sandbox, width, height)
    rows = pane.rows()
    for tool, pattern in ROWS.items():
        index = find_row(rows, pattern)
        follower = rows[index + 1] if index + 1 < len(rows) else ""
        assert ENTRY_RULE.match(follower.strip()), f"`{tool}` row spills onto a second line: {follower!r}"
        assert len(rows[index]) <= width
    screen = "\n".join(rows)
    assert not re.search(r"^\s*alpha\s*$", screen, re.MULTILINE), "collapsed read leaked file content"


def test_click_toggles_a_row(tui: Callable[..., TmuxPane], sandbox: Sandbox) -> None:
    """Clicking a collapsed row expands it; clicking its header collapses it; a drag does neither."""
    pane = run_tools(tui, sandbox, 120, 40)
    row = find_row(pane.rows(), ROWS["bash"])

    pane.click(6, row)
    pane.wait_for(r"^▾ +\$ printf", timeout_s=5)
    expanded = pane.rows()
    header = find_row(expanded, r"^▾ +\$ printf")
    assert any(line.strip() == "c" for line in expanded[header : header + 8]), "\n".join(expanded)

    pane.click(6, header)
    pane.wait_for(ROWS["bash"], timeout_s=5)

    collapsed_row = find_row(pane.rows(), ROWS["bash"])
    pane.drag((4, collapsed_row), (30, collapsed_row))
    pane.wait_for(r"^▾ +\$ printf", timeout_s=1.5, absent=True)
    assert re.search(ROWS["bash"], pane.rows()[collapsed_row]), "a drag toggled the row"
