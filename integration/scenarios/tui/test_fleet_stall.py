"""A child whose model call goes silent shows `thinking` in its fleet row, then `stalled?`.

pi-subagents hard-codes the threshold (`STALL_MS = 2 * 60_000` in `src/model-call.ts`); there is
no setting to shorten it, so this runs in real time and is marked `slow`. It stays in `make verify`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest

from harness.interactive import submit
from harness.sandbox import enable_faux_models

if TYPE_CHECKING:
    from collections.abc import Callable

    from harness.sandbox import Sandbox
    from harness.tmux import TmuxPane

pytestmark = [pytest.mark.tui, pytest.mark.slow]

STALL_S = 120
# The child stays silent well past the threshold so the test never races its reply.
CHILD_DELAY_S = STALL_S + 60
FLEET_CHILD = r"^\s+[●○] general-purpose\s+silent child"
THINKING = FLEET_CHILD + r".*thinking · \d+s"
STALLED = FLEET_CHILD + r".*stalled\? · 2m\d\ds"


def silent_child_script() -> dict[str, Any]:
    """Main spawns one background child whose only model call opens, then stays silent.

    `openMs` emits the stream's `start` at once, so the call is in flight while it is silent.

    Returns:
        dict[str, Any]: faux script.
    """
    agent_args = {
        "subagent_type": "general-purpose",
        "description": "silent child",
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
                "steps": [{"openMs": CHILD_DELAY_S * 1000, "text": "CHILD DONE"}],
            },
        }
    }


def test_silent_child_reads_thinking_then_stalled(tui: Callable[..., TmuxPane], sandbox: Sandbox) -> None:
    """`thinking · Ns` while under the threshold; `stalled? · 2mNNs` once past it."""
    enable_faux_models(sandbox, ["faux/main", "fauxchild/child"])
    pane = tui(silent_child_script())
    submit(pane, "go")
    pane.wait_for("SPAWNED", timeout_s=30)
    pane.wait_for(THINKING, timeout_s=15)
    pane.wait_for(STALLED, timeout_s=STALL_S + 30)
