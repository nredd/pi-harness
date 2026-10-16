"""Each role in the transcript is framed: assistant prose carries a `│` rule, collapsed thinking
rows summarize their first sentence, entries within a turn are separated by a dashed `┄` rule with
no blank line, and every user turn after the first opens with a solid `─` rule.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

import pytest

from harness.interactive import submit
from harness.sandbox import enable_faux_models

if TYPE_CHECKING:
    from collections.abc import Callable

    from harness.sandbox import Sandbox
    from harness.tmux import TmuxPane

pytestmark = pytest.mark.tui

WIDTH, HEIGHT = 120, 50
FIRST_PROSE = "PROSE ONE"
SECOND_PROSE = "PROSE TWO"
THINKING = "Check the notes first. Then answer."
ENTRY_RULE_ROW = "┄" * WIDTH
BOLD_SGR = re.compile(r"\x1b\[(?:[0-9]+;)*1(?:;[0-9]+)*m")

FRAMING: dict[str, Any] = {
    "providers": {
        "faux": {
            "models": ["main"],
            "steps": [
                {"thinking": THINKING, "text": f"{FIRST_PROSE}\n\nsecond paragraph"},
                {"text": SECOND_PROSE},
            ],
        }
    }
}


def test_thinking_summary_renders_bold_markdown(tui: Callable[..., TmuxPane], sandbox: Sandbox) -> None:
    """Collapsed thinking renders the headline as bold rather than exposing literal Markdown."""
    enable_faux_models(sandbox, ["faux/main"])
    script = {
        "providers": {
            "faux": {
                "models": ["main"],
                "steps": [{"thinking": "**Evaluating commit strategy**\nThen verify.", "text": FIRST_PROSE}],
            }
        }
    }
    pane = tui(script, width=WIDTH, height=HEIGHT)
    submit(pane, "first")
    pane.wait_for(FIRST_PROSE, timeout_s=30)
    rows = pane.wait_stable(quiet_s=1, timeout_s=20)
    summary = next(row for row in rows if row.startswith("▸ Thinking"))
    assert summary == "▸ Thinking · Evaluating commit strategy", summary
    styled = next(
        row for row in pane.capture(styled=True).splitlines() if "Evaluating commit strategy" in row
    )
    assert BOLD_SGR.search(styled), repr(styled)
    assert "**" not in styled, repr(styled)


def test_roles_are_framed(tui: Callable[..., TmuxPane], sandbox: Sandbox) -> None:
    """Prose is ruled, thinking is summarized, and the second turn opens with a rule."""
    enable_faux_models(sandbox, ["faux/main"])
    pane = tui(FRAMING, width=WIDTH, height=HEIGHT)
    submit(pane, "first")
    pane.wait_for(FIRST_PROSE, timeout_s=30)
    submit(pane, "second")
    pane.wait_for(SECOND_PROSE, timeout_s=30)
    rows = pane.wait_stable(quiet_s=1, timeout_s=20)
    screen = "\n".join(rows)

    assert re.search(rf"^│ {FIRST_PROSE}$", screen, re.MULTILINE), screen
    assert re.search(r"^│ second paragraph$", screen, re.MULTILINE), screen
    assert re.search(rf"^│ {SECOND_PROSE}$", screen, re.MULTILINE), screen
    assert re.search(r"^▸ Thinking · Check the notes first\.$", screen, re.MULTILINE), screen

    # Thinking row, dashed rule, prose: one separator row and no blank between entries.
    thinking = next(index for index, row in enumerate(rows) if row.startswith("▸ Thinking"))
    assert rows[thinking + 1] == ENTRY_RULE_ROW, screen
    assert rows[thinking + 2] == f"│ {FIRST_PROSE}", screen

    first = next(index for index, row in enumerate(rows) if re.fullmatch(r"\s*first\s*", row))
    second = next(index for index, row in enumerate(rows) if re.fullmatch(r"\s*second\s*", row))
    rule = "─" * WIDTH
    rules = [index for index, row in enumerate(rows) if row == rule and index < second]
    assert rules, screen
    assert first < rules[-1] < second, screen
    assert not [index for index in rules if index < first], screen
