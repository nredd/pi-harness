"""Plan mode's decline gate, headless: a reply to a ready plan blocks `plan_mode_complete`.

Headless has no UI, so `plan_mode_question` cancels with `ui_unavailable` and can never be
answered; `/plan finalize` is the only lift a print-mode run can reach.

References:
- pi-plan-mode fork: https://github.com/nredd/pi-plan-mode
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest

from harness.headless import RunResult, ToolOutcome, run_headless

if TYPE_CHECKING:
    from harness.sandbox import Sandbox

pytestmark = pytest.mark.integration

GATE_ERROR = "plan_mode_complete is blocked: explicit permission to submit a proposal is required"
# First prompt proposes a plan; the second is a reply while it awaits action (a decline), and
# the model tries to re-submit it unchanged.
DECLINE_PROMPTS = ["/plan start", "plan it", "no, change the scope"]


def tool(name: str, **args: Any) -> dict[str, Any]:
    """A faux step calling one tool.

    Parameters:
        name (str): tool name.
        **args (Any): tool arguments.

    Returns:
        dict[str, Any]: faux step.
    """
    return {"tools": [{"name": name, "args": args}]}


def complete(title: str) -> dict[str, Any]:
    """A faux step proposing a one-bullet plan.

    Parameters:
        title (str): plan heading, unique per proposal.

    Returns:
        dict[str, Any]: faux step.
    """
    return tool("plan_mode_complete", plan=f"# {title}\n\n- Do the {title} thing.\n")


DECLINE_STEPS = [complete("First"), complete("First"), {"text": "Restating the open threads."}]


def plan_outcomes(result: RunResult, name: str) -> list[ToolOutcome]:
    """Return the settled outcomes of one plan-mode tool, in order.

    Parameters:
        result (RunResult): headless run.
        name (str): tool name.

    Returns:
        list[ToolOutcome]: matching outcomes.
    """
    return [outcome for outcome in result.tool_outcomes() if outcome.name == name]


def run_plan(sandbox: Sandbox, steps: list[dict[str, Any]], prompts: list[str]) -> RunResult:
    """Run the plan prompts and require a clean exit.

    Parameters:
        sandbox (Sandbox): sandbox to run in.
        steps (list[dict[str, Any]]): faux parent steps.
        prompts (list[str]): prompts, slash commands included.

    Returns:
        RunResult: the run.
    """
    result = run_headless(sandbox, {"providers": {"faux": {"models": ["main"], "steps": steps}}}, prompts)
    assert result.returncode == 0, result.transcript()
    return result


def test_gate_error_forbids_plain_text_and_points_to_finalize(sandbox: Sandbox) -> None:
    """The gate error the model reads names the tool, rejects prose, and offers `/plan finalize`.

    Guards the built `dist/` against drifting from `src/`: a prose question never lifted the
    gate, which is what looped a long planning session.
    """
    result = run_plan(sandbox, DECLINE_STEPS, DECLINE_PROMPTS)
    blocked = plan_outcomes(result, "plan_mode_complete")[1]
    assert blocked.is_error, blocked.text
    for needle in (
        "reproposal_confirmation mode",
        "canonical Re-propose now choice",
        "plain-text replies do not unblock",
        "/plan finalize",
        "ui_unavailable",
    ):
        assert needle in blocked.text, (needle, blocked.text)
