"""The running subagent fleet survives Plan mode's widget resets."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest

from harness.interactive import submit
from harness.sandbox import enable_faux_models

if TYPE_CHECKING:
    from collections.abc import Callable

    from harness.sandbox import Sandbox
    from harness.tmux import TmuxPane

pytestmark = pytest.mark.tui

FLEET_MAIN = r"^\s+[●○] main\s*$"
FLEET_CHILD = r"^\s+[●○] general-purpose\s+probe child"
CHILD_SECONDS = 45


def spawn_script() -> dict[str, Any]:
    """Main model spawns one slow background child, then replies `SPAWNED`.

    The child's call opens at once and stays silent (`openMs`), like a model that is thinking.

    Returns:
        dict[str, Any]: faux script.
    """
    agent_args = {
        "subagent_type": "general-purpose",
        "description": "probe child",
        "prompt": "work",
        "run_in_background": True,
        "model": "fauxchild/child",
    }
    return {
        "providers": {
            "faux": {
                "models": ["main"],
                "steps": [{"tools": [{"name": "Agent", "args": agent_args}]}, {"text": "SPAWNED"}],
            },
            "fauxchild": {
                "models": ["child"],
                "steps": [{"openMs": CHILD_SECONDS * 1000, "text": "CHILD DONE"}],
            },
        }
    }


@pytest.fixture
def spawned(tui: Callable[..., TmuxPane], sandbox: Sandbox) -> TmuxPane:
    """A pane with one running background child visible in the fleet.

    Parameters:
        tui (Callable[..., TmuxPane]): pane launcher fixture.
        sandbox (Sandbox): sandbox the pane runs in.

    Returns:
        TmuxPane: pane after the fleet appeared.
    """
    enable_faux_models(sandbox, ["faux/main", "fauxchild/child"])
    pane = tui(spawn_script())
    submit(pane, "go")
    pane.wait_for("SPAWNED", timeout_s=30)
    pane.wait_for(FLEET_CHILD, timeout_s=10)
    pane.wait_for(FLEET_MAIN, timeout_s=1)
    return pane


def test_fleet_survives_plan_mode_round_trip(spawned: TmuxPane) -> None:
    """Entering and leaving Plan mode resets widgets too."""
    submit(spawned, "/plan start")
    spawned.wait_for(r"(?i)plan", timeout_s=15)
    submit(spawned, "/plan exit")
    spawned.wait_for(FLEET_CHILD, timeout_s=10)
