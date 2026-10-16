"""A subagent on a virtual (router) model shows `(routing)` first, then the physical model that answered."""

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

FLEET_CHILD = r"^\s+[●○] general-purpose\s+probe child"
ROUTING = FLEET_CHILD + r".*\bvroute default \(routing\) · thinking: "
PHYSICAL = FLEET_CHILD + r".*\bphysical · thinking: "
CHILD_SECONDS = 45


def script() -> dict[str, Any]:
    """Main spawns a background child on `vroute/default`, which routes to `fauxphys/physical`.

    The child's first call opens silent (routing, no response yet), then answers with a tool call
    so one assistant message completes, then opens silent again while the row is read.

    Returns:
        dict[str, Any]: faux script.
    """
    agent_args = {
        "subagent_type": "general-purpose",
        "description": "probe child",
        "prompt": "work",
        "run_in_background": True,
        "model": "vroute/default",
    }
    return {
        "providers": {
            "faux": {
                "models": ["main"],
                "steps": [{"tools": [{"name": "Agent", "args": agent_args}]}, {"text": "SPAWNED"}],
            },
            "fauxphys": {
                "models": ["physical"],
                "steps": [
                    {"openMs": 8_000, "tools": [{"name": "bash", "args": {"command": "true"}}]},
                    {"openMs": CHILD_SECONDS * 1000, "text": "CHILD DONE"},
                ],
            },
            "vroute": {"models": [], "virtual": [{"id": "default", "to": "fauxphys/physical"}]},
        }
    }


def test_row_follows_the_router_to_the_physical_model(tui: Callable[..., TmuxPane], sandbox: Sandbox) -> None:
    """`(routing)` before any response; after one, the physical model plus its thinking level."""
    enable_faux_models(sandbox, ["faux/main", "fauxphys/physical", "vroute/default"])
    pane = tui(script())
    submit(pane, "go")
    pane.wait_for("SPAWNED", timeout_s=30)
    pane.wait_for(ROUTING, timeout_s=10)
    pane.wait_for(PHYSICAL, timeout_s=40)
