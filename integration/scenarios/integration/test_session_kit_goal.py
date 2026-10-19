"""Remaining `/goal` scheduled-child scenario, pending an injectable subagent scheduler clock.

Real pi, faux providers, the installed fleet (pi-plan-mode, rpiv-todo, pi-subagents,
pi-deferred-context-engine, ...) plus the kit selected from sandbox package settings.
`HARNESS_LOCAL=pi-session-kit` overrides that package without loading a second copy.
Print mode disposes the session when a command returns, so `/goal <objective>` only
records the goal there and the NEXT prompt is the first goal turn (a TUI kicks off by itself).

References:
- pi-session-kit: https://github.com/nredd/pi-session-kit
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from harness.headless import RunResult, run_headless
from harness.sandbox import Sandbox, enable_faux_models
from harness.session_kit import kit_args

pytestmark = pytest.mark.integration

GOAL_ENTRY = "session-kit:goal"
NUDGE_TYPE = "session-kit:goal-nudge"
TOOL = "goal_update"
NOTICE_TYPE = "subagent-notification"
EVIDENCE = "uv run pytest tests: 12 passed"
CHILD = "kid/child"


def tool(name: str, **args: Any) -> dict[str, Any]:
    """A faux step calling one tool.

    Parameters:
        name (str): tool name.
        **args (Any): tool arguments.

    Returns:
        dict[str, Any]: faux step.
    """
    return {"tools": [{"name": name, "args": args}]}


def complete(evidence: str = EVIDENCE) -> dict[str, Any]:
    """A faux step calling `goal_update` complete.

    Parameters:
        evidence (str): proof.

    Returns:
        dict[str, Any]: faux step.
    """
    return tool(TOOL, status="complete", evidence=evidence)


def run(box: Sandbox, steps: list[dict[str, Any]], prompts: list[str], **extra: Any) -> RunResult:
    """One headless run with the kit loaded.

    Parameters:
        box (Sandbox): sandbox.
        steps (list[dict[str, Any]]): parent faux steps.
        prompts (list[str]): prompts and commands in order.
        **extra (Any): further `run_headless` keywords; `providers` adds faux providers.

    Returns:
        RunResult: the run.
    """
    providers = {"faux": {"models": ["main"], "steps": steps}} | extra.pop("providers", {})
    extra_args = [*kit_args(box), *extra.pop("extra_args", [])]
    result = run_headless(box, {"providers": providers}, prompts, extra_args=extra_args, **extra)
    assert result.returncode == 0, result.transcript()
    return result


def entries(box: Sandbox) -> list[dict[str, Any]]:
    """Every session entry the sandbox wrote, oldest file first.

    Parameters:
        box (Sandbox): sandbox of the run.

    Returns:
        list[dict[str, Any]]: parsed jsonl lines.
    """
    return [
        json.loads(line)
        for path in sorted((box.agent_dir / "sessions").rglob("*.jsonl"))
        for line in path.read_text().splitlines()
        if line.strip()
    ]


def goal_states(box: Sandbox) -> list[dict[str, Any] | None]:
    """The persisted goal after every change, in order.

    Parameters:
        box (Sandbox): sandbox of the run.

    Returns:
        list[dict[str, Any] | None]: `goal` of each `session-kit:goal` entry.
    """
    return [e["data"]["goal"] for e in entries(box) if e.get("customType") == GOAL_ENTRY]


def nudges(box: Sandbox) -> list[dict[str, Any]]:
    """Persisted goal nudge messages.

    Parameters:
        box (Sandbox): sandbox of the run.

    Returns:
        list[dict[str, Any]]: `custom_message` entries.
    """
    return [e for e in entries(box) if e.get("customType") == NUDGE_TYPE]


# --- subagents ---------------------------------------------------------------------------------


def with_child(box: Sandbox, steps: list[dict[str, Any]]) -> dict[str, Any]:
    """Enable the child faux model and return the `providers` extra for `run`.

    Parameters:
        box (Sandbox): sandbox to enable the models in.
        steps (list[dict[str, Any]]): child steps.

    Returns:
        dict[str, Any]: `providers` keyword for `run`.
    """
    enable_faux_models(box, ["faux/main", CHILD])
    return {"kid": {"models": ["child"], "steps": steps}}


def agent(description: str, **extra: Any) -> dict[str, Any]:
    """A faux step spawning one `general-purpose` child on the child model.

    Parameters:
        description (str): agent description.
        **extra (Any): further `Agent` arguments (`run_in_background`, `schedule`, ...).

    Returns:
        dict[str, Any]: faux step.
    """
    args = {"subagent_type": "general-purpose", "description": description, "prompt": "work", "model": CHILD}
    return tool("Agent", **(args | extra))


def order(box: Sandbox) -> list[str]:
    """Persisted custom message types in transcript order (notices, nudges).

    Parameters:
        box (Sandbox): sandbox of the run.

    Returns:
        list[str]: `customType` of every `custom_message` entry.
    """
    return [e["customType"] for e in entries(box) if e.get("type") == "custom_message"]


def test_scheduled_subagent_notice_is_delivered_before_any_nudge(sandbox: Sandbox) -> None:
    """A scheduled child fires mid-turn; same notice ordering and isolation as a background one."""
    result = run(
        sandbox,
        [
            agent("scheduled child", schedule="+2s"),
            tool("bash", command="/bin/sleep 5"),
            {"text": "waiting"},
            {"text": "after notice"},
            complete(),
            {"text": "end"},
        ],
        ["/goal watch the schedule --turns 10", "go"],
        providers=with_child(sandbox, [{"listTools": True}]),
    )
    kinds = order(sandbox)
    assert kinds.count(NOTICE_TYPE) == 1, f"{kinds}\n{result.transcript()}"
    assert kinds.index(NOTICE_TYPE) < kinds.index(NUDGE_TYPE), f"nudge ran ahead of the notice: {kinds}"
    notice = next(e for e in entries(sandbox) if e.get("customType") == NOTICE_TYPE)
    assert TOOL not in str(notice["content"]), notice["content"]
