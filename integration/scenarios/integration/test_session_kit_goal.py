"""pi-session-kit `/goal` end to end: continuation, evidence, budgets, tools, Plan mode, subagents.

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

from harness.headless import RunResult, ToolOutcome, run_headless
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


def outcomes(result: RunResult, name: str) -> list[ToolOutcome]:
    """Settled outcomes of one tool.

    Parameters:
        result (RunResult): run.
        name (str): tool name.

    Returns:
        list[ToolOutcome]: matching outcomes in order.
    """
    return [o for o in result.tool_outcomes() if o.name == name]


def offered(text: str) -> list[str]:
    """Parse a faux `TOOLS a,b,c` reply.

    Parameters:
        text (str): assistant text.

    Returns:
        list[str]: tool names.
    """
    assert text.startswith("TOOLS "), text
    return text.removeprefix("TOOLS ").split(",")


def spoken(result: RunResult) -> list[str]:
    """Assistant text turns, without the tool-call-only messages.

    Parameters:
        result (RunResult): run.

    Returns:
        list[str]: texts.
    """
    return [t for t in result.assistant_texts() if t and not t.startswith("<call")]


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


def test_foreground_subagent_is_not_nudged_and_not_counted(sandbox: Sandbox) -> None:
    """A foreground child has no goal tool, gets no nudge, and its turns never spend the parent's cap."""
    child = [tool("bash", command="echo one"), tool("bash", command="echo two"), {"listTools": True}]
    result = run(
        sandbox,
        [
            agent("fg child", run_in_background=False),
            {"text": "p2"},
            {"text": "p3"},
            {"text": "SHOULD NOT RUN"},
        ],
        ["/goal cap test --turns 3", "go"],
        providers=with_child(sandbox, child),
    )
    (spawned,) = outcomes(result, "Agent")
    assert spawned.text.count("TOOLS ") == 1, spawned.text
    assert TOOL not in spawned.text, f"child was offered {TOOL}: {spawned.text}"
    # three parent turns exactly (spawn, p2, p3), though the child took three of its own; the spawn
    # turn continues on its tool result, so only the settle after p2 is nudged
    assert "SHOULD NOT RUN" not in result.assistant_texts(), result.transcript()
    assert len(nudges(sandbox)) == 1, order(sandbox)
    final = goal_states(sandbox)[-1]
    assert final is not None
    assert (final["status"], final["turns"]) == ("budget", 3), final


def test_background_subagent_notice_is_delivered_before_any_nudge(sandbox: Sandbox) -> None:
    """The goal waits for a background child; its notice is never delayed, swallowed or run behind a nudge."""
    result = run(
        sandbox,
        [
            agent("bg child", run_in_background=True),
            tool("bash", command="/bin/sleep 3"),
            {"text": "waiting"},
            {"text": "after notice"},
            complete(),
            {"text": "end"},
        ],
        ["/goal watch the child --turns 10", "go"],
        providers=with_child(sandbox, [{"delayMs": 1200, "listTools": True}]),
    )
    kinds = order(sandbox)
    assert kinds.count(NOTICE_TYPE) == 1, kinds
    assert kinds.index(NOTICE_TYPE) < kinds.index(NUDGE_TYPE), f"nudge ran ahead of the notice: {kinds}"
    notice = next(e for e in entries(sandbox) if e.get("customType") == NOTICE_TYPE)
    assert "TOOLS " in str(notice["content"]), notice["content"]
    assert TOOL not in str(notice["content"]), notice["content"]
    assert spoken(result)[:3] == ["waiting", "after notice", "end"] or "after notice" in spoken(result), (
        result.transcript()
    )
    final = goal_states(sandbox)[-1]
    assert final is not None, final
    assert final["status"] == "complete", final


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


# --- rpiv-todo ---------------------------------------------------------------------------------

PLAN = "# Ship widgets\n\n## Work\n- Add the `alpha` module\n- Wire `beta` into the CLI\n"


def test_todo_reminder_and_goal_nudge_share_one_continuation(sandbox: Sandbox) -> None:
    """A prior todo continuation suppresses the goal nudge; one next request retains the evidence gate."""
    steps = [
        tool("plan_mode_complete", plan=PLAN),
        {"text": "implementing"},
        {"text": "reminded"},  # the implementation run's own settle reminder, before any goal exists
        {"text": "turn A"},
        {"echoUsers": True},
        tool("todo", action="update", id=1, status="completed"),
        complete(),
        {"text": "end"},
    ]
    result = run(
        sandbox, steps, ["/plan start", "plan it", "/plan implement", "/goal finish it --turns 10", "go"]
    )
    users = next(t for t in result.assistant_texts() if t.startswith("USERS "))
    assert "Plan check:" in users, users
    assert "[goal 1/10 turns]" not in users, users
    # The echoed context is exactly the request after turn A, driven by the todo reminder,
    # not a second goal continuation. Later goal nudges are allowed once that handler yields.
    texts = spoken(result)
    turn_a = texts.index("turn A")
    assert texts[turn_a + 1] == users, texts
    branch = entries(sandbox)
    turn_a_entry = next(
        i
        for i, entry in enumerate(branch)
        if entry.get("type") == "message"
        and entry.get("message", {}).get("role") == "assistant"
        and any(block.get("text") == "turn A" for block in entry["message"].get("content", []))
    )
    next_assistant = next(
        i
        for i in range(turn_a_entry + 1, len(branch))
        if branch[i].get("message", {}).get("role") == "assistant"
    )
    between = branch[turn_a_entry + 1 : next_assistant]
    assert sum(entry.get("customType") == "rpiv-todo-plan-reminder" for entry in between) == 1, between
    assert not any(entry.get("customType") == NUDGE_TYPE for entry in between), between
    todo_outcomes = outcomes(result, "todo")
    assert "evidence required" in todo_outcomes[-1].text, todo_outcomes[-1]
    final = goal_states(sandbox)[-1]
    assert final is not None, final
    assert final["status"] == "complete", final


# --- Plan mode ---------------------------------------------------------------------------------


def test_goal_is_refused_in_plan_mode(sandbox: Sandbox) -> None:
    """`/goal <objective>` while Plan mode is on records nothing, and nothing nudges."""
    result = run(
        sandbox,
        [{"text": "planning"}, {"text": "SHOULD NOT RUN"}],
        ["/plan start", "/goal ship it", "plan it"],
    )
    assert "SHOULD NOT RUN" not in result.assistant_texts(), result.transcript()
    assert goal_states(sandbox) == []
    assert nudges(sandbox) == []


def test_plan_mode_idle_excursion_pauses_until_explicit_resume(sandbox: Sandbox) -> None:
    """An idle `/plan start` then `/plan exit` pauses the goal before the next prompt can nudge."""
    result = run(
        sandbox,
        [{"text": "after plan"}, {"text": "resumed"}, complete(), {"text": "end"}],
        ["/goal ship it", "/plan start", "/plan exit", "next", "/goal resume", "go"],
    )
    assert len(nudges(sandbox)) == 1, result.transcript()
    states = [(s["status"], s.get("reason")) for s in goal_states(sandbox) if s]
    assert states[:2] == [("active", None), ("paused", "plan mode")], states
    assert states[-1][0] == "complete", states


def test_plan_mode_pauses_blocks_the_tool_and_resume_waits_for_exit(sandbox: Sandbox) -> None:
    """Entering Plan mode pauses; the tool is not offered or callable; resume works only after leaving."""
    steps = [
        {"listTools": True},
        complete(),
        {"text": "plan turn done"},
        {"text": "resumed work"},
        complete(),
        {"text": "end"},
    ]
    result = run(
        sandbox,
        steps,
        [
            "/goal ship it --turns 10",
            "/plan start",
            "plan it",
            "plan again",
            "/goal resume",
            "/plan exit",
            "/goal resume",
            "go",
        ],
    )
    texts = result.assistant_texts()
    assert TOOL not in offered(texts[0]), texts[0]
    (denied, proven) = outcomes(result, TOOL)
    assert denied.is_error, denied
    assert not proven.is_error, proven
    statuses = [(s["status"], s.get("reason")) for s in goal_states(sandbox) if s]
    assert statuses[0] == ("active", None), statuses
    assert statuses[1] == ("paused", "plan mode"), statuses
    # the refused `/goal resume` inside Plan mode wrote nothing: next is the real resume
    assert statuses[2] == ("active", None), statuses
    assert statuses[-1][0] == "complete", statuses
    assert len(nudges(sandbox)) == 1, "no nudge in Plan mode; exactly one after leaving it"
