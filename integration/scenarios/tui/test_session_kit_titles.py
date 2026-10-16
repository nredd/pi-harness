"""Auto-titles in real tmux TUI sessions, using a separate faux preferred title model.

References:
- pi-session-kit: https://github.com/nredd/pi-session-kit
- ~/code/pi-session-kit/src/titles/index.ts: TUI-only title generation and name guard
"""

from __future__ import annotations

import json
import time
from typing import TYPE_CHECKING, Any

import pytest

from harness.interactive import submit
from harness.sandbox import enable_faux_models
from harness.session_kit import kit_args

if TYPE_CHECKING:
    from collections.abc import Callable

    from harness.sandbox import Sandbox
    from harness.tmux import TmuxPane

pytestmark = pytest.mark.tui

AUTO_TITLE = "Inspect Reviewer Capabilities"
MANUAL_TITLE = "My Manual Review Name"


def names(sandbox: Sandbox) -> list[str]:
    """Read persisted name changes from the real session JSONL files.

    Parameters:
        sandbox (Sandbox): TUI's isolated home.

    Returns:
        list[str]: names in session-info entries, ordered within each file.
    """
    return [
        entry["name"]
        for path in sorted((sandbox.agent_dir / "sessions").rglob("*.jsonl"))
        for line in path.read_text().splitlines()
        if line.strip() and (entry := json.loads(line)).get("type") == "session_info" and "name" in entry
    ]


@pytest.mark.parametrize("manual_name", [None, MANUAL_TITLE], ids=["unnamed", "manual-name-wins"])
def test_tui_auto_title_respects_manual_name(
    sandbox: Sandbox, tui: Callable[..., TmuxPane], manual_name: str | None
) -> None:
    """An unnamed real TUI gets the preferred model's title; an explicit name is never replaced."""
    sandbox.patch_json("pi-session-kit.json", {"titles": {"enabled": True, "model": "titlefaux/preferred"}})
    enable_faux_models(sandbox, ["faux/main", "titlefaux/preferred"])
    payload: dict[str, Any] = {
        "providers": {
            "faux": {
                "models": ["main"],
                "steps": [{"text": "REVIEW TURN FINISHED"}, {"text": "SECOND TURN FINISHED"}],
            },
            "titlefaux": {"models": ["preferred"], "steps": [{"text": AUTO_TITLE}]},
        }
    }
    pane = tui(payload, extra_args=kit_args(sandbox))
    assert names(sandbox) == [], names(sandbox)
    if manual_name is not None:
        submit(pane, f"/name {manual_name}")
        pane.wait_for(manual_name)
        # Core keeps the pre-first-prompt name in memory until the session is persisted.
    submit(pane, "Inspect the code-reviewer capabilities")
    pane.wait_for("REVIEW TURN FINISHED")
    expected = manual_name or AUTO_TITLE
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline and expected not in names(sandbox):
        time.sleep(0.05)
    assert names(sandbox) == [expected], pane.capture()
    # Check the real UI as well as persistence, not a headless simulation of `ctx.mode`.
    submit(pane, "/name")
    pane.wait_for(expected)
    submit(pane, "Continue reviewing")
    pane.wait_for("SECOND TURN FINISHED")
    pane.wait_stable(quiet_s=1)
    assert names(sandbox) == [expected], names(sandbox)
    assert pane.is_alive(), pane.capture()
