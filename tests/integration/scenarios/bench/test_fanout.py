"""Wall time of an 8-agent fan-out: one assistant turn calls `Agent` eight times on faux children.

The metric runs from the first `tool_execution_start` to `agent_settled`, so process startup
and shutdown stay out of it. Every child answers after `CHILD_DELAY_MS`, so a serialized
fan-out costs at least eight delays; the run must come in under that before its time is
compared to the baseline.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest

from harness.bench import check_against_baseline, measure
from harness.headless import run_headless
from harness.sandbox import enable_faux_models

if TYPE_CHECKING:
    from harness.sandbox import Sandbox

pytestmark = pytest.mark.bench

AGENTS = 8
CHILD_DELAY_MS = 2000
CHILD_REPLY = "CHILD DONE"


def fanout_script() -> dict[str, Any]:
    """Main fans out `AGENTS` foreground children in one turn, then says `FANNED`.

    Returns:
        dict[str, Any]: faux script.
    """
    calls = [
        {
            "name": "Agent",
            "args": {
                "subagent_type": "general-purpose",
                "description": f"fan child {index}",
                "prompt": "work",
                "run_in_background": False,
                "model": "fauxchild/child",
            },
        }
        for index in range(AGENTS)
    ]
    return {
        "providers": {
            "faux": {"models": ["main"], "steps": [{"tools": calls}, {"text": "FANNED"}]},
            "fauxchild": {
                "models": ["child"],
                "steps": [{"delayMs": CHILD_DELAY_MS, "text": CHILD_REPLY} for _ in range(AGENTS)],
            },
        }
    }


def test_eight_agent_fanout_wall_time(sandbox: Sandbox) -> None:
    """All eight children report, concurrently, and the run's wall time holds its baseline."""
    enable_faux_models(sandbox, ["faux/main", "fauxchild/child"])
    serialized_s = AGENTS * CHILD_DELAY_MS / 1000

    def sample() -> float:
        result = run_headless(sandbox, fanout_script(), ["go"], persist_session=False)
        agents = [outcome for outcome in result.tool_outcomes() if outcome.name == "Agent"]
        assert len(agents) == AGENTS, result.transcript()
        failed = [outcome.text for outcome in agents if outcome.is_error or CHILD_REPLY not in outcome.text]
        assert not failed, "children did not report:\n" + "\n".join(failed) + "\n" + result.transcript()
        assert "FANNED" in result.assistant_texts()[-1], result.transcript()
        fanout_s = result.first_event_s["agent_settled"] - result.first_event_s["tool_execution_start"]
        assert fanout_s < serialized_s, f"fan-out took {fanout_s:.1f}s: it ran serially"
        return fanout_s

    check_against_baseline("fanout_8_wall_s", measure(sample))
