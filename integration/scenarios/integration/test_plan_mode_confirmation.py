"""RPC confirmation answers drive Plan mode's canonical replacement gate.

References:
- pi RPC extension UI: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-extension-ui.md
- pi-plan-mode fork: https://github.com/nredd/pi-plan-mode
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import pytest

from harness.headless import RunResult, run_headless
from harness.paths import FAUX_EXTENSION
from harness.rpc import Rpc, rpc
from scenarios.integration.test_plan_mode_gate import GATE_ERROR, complete, tool

if TYPE_CHECKING:
    from harness.sandbox import Sandbox

pytestmark = pytest.mark.integration

CONFIRMATION = {
    "mode": "reproposal_confirmation",
    "questions": [
        {
            "id": "confirm",
            "header": "Confirm",
            "question": "Submit the revised plan?",
            "options": [
                {"label": "ignored", "description": "The canonical mode replaces this."},
                {"label": "also ignored", "description": "The canonical mode replaces this."},
            ],
        }
    ],
}


def prepare_declined_session(sandbox: Sandbox) -> tuple[RunResult, str]:
    """Persist a real Plan-mode session with one declined proposal.

    Parameters:
        sandbox (Sandbox): isolated Pi home.

    Returns:
        tuple[RunResult, str]: decline run and its session path.
    """
    result = run_headless(
        sandbox,
        {"providers": {"faux": {"models": ["main"], "steps": [complete("First"), {"text": "declined"}]}}},
        ["/plan start", "propose", "no"],
    )
    assert result.returncode == 0, result.transcript()
    (session,) = list((sandbox.agent_dir / "sessions").rglob("*.jsonl"))
    return result, str(session)


def answer_select(client: Rpc, request: dict[str, Any], value: str | None) -> None:
    """Answer or cancel one real RPC select request.

    Parameters:
        client (Rpc): live Pi RPC client.
        request (dict[str, Any]): select request emitted by Pi.
        value (str | None): selected canonical label, or `None` to cancel.
    """
    assert request.get("method") == "select", request
    assert client.process.stdin is not None
    response = {"type": "extension_ui_response", "id": request["id"]}
    response |= {"cancelled": True} if value is None else {"value": value}
    client.process.stdin.write(json.dumps(response) + "\n")
    client.process.stdin.flush()


def tool_outcomes(client: Rpc, name: str) -> list[dict[str, Any]]:
    """Return settled RPC tool events for one named tool.

    Parameters:
        client (Rpc): client whose events have reached settlement.
        name (str): tool name.

    Returns:
        list[dict[str, Any]]: matching tool end events.
    """
    return [
        event
        for event in client.events
        if event.get("type") == "tool_execution_end" and event.get("toolName") == name
    ]


def run_confirmation(sandbox: Sandbox, answer: str | None) -> Rpc:
    """Run one canonical confirmation choice against a real persisted decline.

    Parameters:
        sandbox (Sandbox): isolated Pi home.
        answer (str | None): canonical answer, or cancellation.

    Returns:
        Rpc: settled client event log. The process is already stopped by the context manager.
    """
    _, session = prepare_declined_session(sandbox)
    script = sandbox.root / "confirmation.json"
    script.write_text(
        json.dumps(
            {
                "providers": {
                    "faux": {
                        "models": ["main"],
                        "steps": [
                            tool("plan_mode_question", **CONFIRMATION),
                            complete("Replacement"),
                        ],
                    }
                }
            }
        )
    )
    with rpc(
        sandbox,
        ["-e", str(FAUX_EXTENSION), "--session", session],
        "faux/main",
        {"HARNESS_SCRIPT": str(script)},
    ) as client:
        client.command("ask before replacing")
        request = client.wait(
            lambda event: event.get("type") == "extension_ui_request" and event.get("method") == "select"
        )
        options = request.get("options")
        assert isinstance(options, list), request
        assert len(options) == 3, request
        assert options[0].startswith("1. Re-propose now"), request
        assert options[1].startswith("2. Not yet"), request
        selected = None if answer is None else next(option for option in options if answer in option)
        answer_select(client, request, selected)
        if answer == "Re-propose now":
            ready = client.wait(
                lambda event: (
                    event.get("type") == "extension_ui_request"
                    and event.get("title") == "Proposed plan ready"
                )
            )
            answer_select(client, ready, "Stay in Plan mode")
        client.wait(lambda event: event.get("type") == "agent_settled")
        return client


def test_reproposal_confirmation_affirmative_allows_one_completion(sandbox: Sandbox) -> None:
    """The canonical affirmative answer permits exactly the next replacement completion."""
    client = run_confirmation(sandbox, "Re-propose now")
    completions = tool_outcomes(client, "plan_mode_complete")
    assert len(completions) == 1, client.events
    assert not completions[0].get("isError"), completions[0]
    question = tool_outcomes(client, "plan_mode_question")
    assert len(question) == 1, question
    assert not question[0].get("isError"), question
    assert "reproposal_confirmation" in str(question[0].get("result")), question[0]
    assert GATE_ERROR not in str(client.events), client.events


@pytest.mark.parametrize("answer", ["Not yet", None], ids=["not-yet", "cancelled"])
def test_reproposal_confirmation_nonaffirmative_keeps_completion_blocked(
    sandbox: Sandbox, answer: str | None
) -> None:
    """Not yet and cancellation do not grant the stale proposal permission."""
    client = run_confirmation(sandbox, answer)
    (completion,) = tool_outcomes(client, "plan_mode_complete")
    assert completion.get("isError"), completion
    assert GATE_ERROR in str(completion.get("result")), completion
