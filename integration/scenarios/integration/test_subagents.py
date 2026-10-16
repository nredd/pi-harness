"""pi-subagents end to end: spawn, fetch, steer, notices, model choice, nesting, turn caps.

Every child runs on its own faux provider, so which provider answered proves which model a
spawn resolved to, and a child's scripted reply is the only way its text can reach the parent.

References:
- pi-subagents fork: https://github.com/nredd/pi-subagents
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import pytest

from harness.headless import RunResult, ToolOutcome, content_text, run_headless
from harness.sandbox import enable_faux_models

if TYPE_CHECKING:
    from collections.abc import Callable

    from harness.sandbox import Sandbox

pytestmark = pytest.mark.integration

NOTICE_TYPE = "subagent-notification"
PARENT = "faux/main"
CHILD = "kid/child"


def call(name: str, **args: Any) -> dict[str, Any]:
    """One tool call inside a faux step.

    Parameters:
        name (str): tool name.
        **args (Any): tool arguments.

    Returns:
        dict[str, Any]: faux tool call.
    """
    return {"name": name, "args": args}


def tool(name: str, **args: Any) -> dict[str, Any]:
    """A faux step calling one tool.

    Parameters:
        name (str): tool name.
        **args (Any): tool arguments.

    Returns:
        dict[str, Any]: faux step.
    """
    return {"tools": [call(name, **args)]}


def spawn(
    description: str, *, model: str | None = CHILD, background: bool = True, **extra: Any
) -> dict[str, Any]:
    """An `Agent` call inside a faux step.

    Parameters:
        description (str): agent description, unique per scenario.
        model (str | None): `model` parameter; `None` omits it.
        background (bool): `run_in_background`.
        **extra (Any): further `Agent` parameters, e.g. `subagent_type`, `max_turns`.

    Returns:
        dict[str, Any]: faux tool call.
    """
    args: dict[str, Any] = {
        "subagent_type": "general-purpose",
        "description": description,
        "prompt": "work",
        "run_in_background": background,
    }
    if model is not None:
        args["model"] = model
    return call("Agent", **(args | extra))


def script(parent: list[dict[str, Any]], **children: list[dict[str, Any]]) -> dict[str, Any]:
    """Build a faux script: the parent on `faux/main`, each child provider serving model `child`.

    Parameters:
        parent (list[dict[str, Any]]): parent steps.
        **children (list[dict[str, Any]]): provider name -> its steps.

    Returns:
        dict[str, Any]: `HARNESS_SCRIPT` payload.
    """
    providers = {"faux": {"models": ["main"], "steps": parent}}
    providers |= {name: {"models": ["child"], "steps": steps} for name, steps in children.items()}
    return {"providers": providers}


def outcomes(result: RunResult, name: str) -> list[ToolOutcome]:
    """Return the settled outcomes of one tool, in order.

    Parameters:
        result (RunResult): headless run.
        name (str): tool name.

    Returns:
        list[ToolOutcome]: matching outcomes.
    """
    return [outcome for outcome in result.tool_outcomes() if outcome.name == name]


def event_index(result: RunResult, predicate: Callable[[dict[str, Any]], bool]) -> list[int]:
    """Return the positions of events matching `predicate` in the stream.

    Parameters:
        result (RunResult): headless run.
        predicate (Callable[[dict[str, Any]], bool]): test applied to each event.

    Returns:
        list[int]: event indexes.
    """
    return [index for index, event in enumerate(result.events) if predicate(event)]


def is_notice(event: dict[str, Any]) -> bool:
    """Whether an event is the `message_end` of a subagent completion notice.

    Parameters:
        event (dict[str, Any]): JSON event.

    Returns:
        bool: True for a finished `subagent-notification` custom message.
    """
    message = event.get("message") or {}
    return event.get("type") == "message_end" and message.get("customType") == NOTICE_TYPE


def notices(result: RunResult) -> list[str]:
    """Return the text of every delivered completion notice.

    Parameters:
        result (RunResult): headless run.

    Returns:
        list[str]: notice contents in order.
    """
    return [
        content_text(result.events[index]["message"].get("content"))
        for index in event_index(result, is_notice)
    ]


def run_ok(
    sandbox: Sandbox, payload: dict[str, Any], models: list[str], env: dict[str, str] | None = None
) -> RunResult:
    """Enable the faux models, run one `go` prompt, and require a clean exit.

    Parameters:
        sandbox (Sandbox): sandbox to run in.
        payload (dict[str, Any]): faux script.
        models (list[str]): `provider/id` entries to enable alongside the parent.
        env (dict[str, str] | None): extra environment for pi.

    Returns:
        RunResult: the run.
    """
    enable_faux_models(sandbox, [PARENT, *models])
    result = run_headless(sandbox, payload, ["go"], env=env)
    assert result.returncode == 0, result.transcript()
    return result


def test_background_spawn_and_fetch(sandbox: Sandbox) -> None:
    """A background child's text comes back through `get_subagent_result` once it finished."""
    result = run_ok(
        sandbox,
        script(
            [
                {"tools": [spawn("fetched")]},
                tool("bash", command="sleep 1"),
                tool("get_subagent_result", agent_id="{{agentId}}"),
                {"text": "PARENT DONE"},
            ],
            kid=[{"delayMs": 200, "text": "CHILD RESULT 2a"}],
        ),
        [CHILD],
    )
    (spawned,) = outcomes(result, "Agent")
    assert "Agent started in background." in spawned.text, result.transcript()
    (fetched,) = outcomes(result, "get_subagent_result")
    assert "Status: completed" in fetched.text, result.transcript()
    assert "CHILD RESULT 2a" in fetched.text, result.transcript()


def test_steer_running_child(sandbox: Sandbox) -> None:
    """A steer sent while the child is mid-tool reaches its next turn and changes its answer."""
    result = run_ok(
        sandbox,
        script(
            [
                {"tools": [spawn("steered")]},
                tool("bash", command="sleep 1"),
                tool("steer_subagent", agent_id="{{agentId}}", message="PIVOT 3x"),
                tool("get_subagent_result", agent_id="{{agentId}}", wait=True),
                {"text": "PARENT DONE"},
            ],
            kid=[{"delayMs": 2000, "tools": [call("bash", command="echo first")]}, {"echoUsers": True}],
        ),
        [CHILD],
    )
    (steered,) = outcomes(result, "steer_subagent")
    assert "Steering message sent to agent" in steered.text, result.transcript()
    (fetched,) = outcomes(result, "get_subagent_result")
    assert "USERS work | PIVOT 3x" in fetched.text, result.transcript()


def test_steer_queued_child(sandbox: Sandbox) -> None:
    """With `maxConcurrent: 1`, a steer sent to the queued second child is accepted and delivered."""
    sandbox.patch_json("subagents.json", {"maxConcurrent": 1})
    result = run_ok(
        sandbox,
        script(
            [
                {"tools": [spawn("blocker", model="kida/child"), spawn("queued", model="kidb/child")]},
                tool("steer_subagent", agent_id="{{agentId}}", message="PIVOT 4q"),
                tool("get_subagent_result", agent_id="{{agentId}}", wait=True),
                {"text": "PARENT DONE"},
            ],
            kida=[{"delayMs": 1500, "text": "BLOCKER DONE"}],
            kidb=[{"echoUsers": True}],
        ),
        ["kida/child", "kidb/child"],
    )
    spawned = outcomes(result, "Agent")
    assert "queued" in spawned[1].text.lower(), result.transcript()
    (steered,) = outcomes(result, "steer_subagent")
    assert not steered.is_error, result.transcript()
    assert "not running" not in steered.text, steered.text
    (fetched,) = outcomes(result, "get_subagent_result")
    assert "PIVOT 4q" in fetched.text, result.transcript()


def test_evicted_agent_answers_with_tombstone(sandbox: Sandbox) -> None:
    """After eviction `get_subagent_result` says 'completed, evicted after N min; transcript: ...'."""
    # A consumed TTL of 0 evicts on the next sweep, which then runs every second.
    result = run_ok(
        sandbox,
        script(
            [
                {"tools": [spawn("evicted")]},
                tool("get_subagent_result", agent_id="{{agentId}}", wait=True),
                tool("bash", command="sleep 2"),
                tool("get_subagent_result", agent_id="{{agentId}}"),
                {"text": "PARENT DONE"},
            ],
            kid=[{"text": "CHILD RESULT 5"}],
        ),
        [CHILD],
        env={"PI_SUBAGENTS_CONSUMED_TTL_MIN": "0"},
    )
    late = outcomes(result, "get_subagent_result")[-1]
    assert "completed, evicted after" in late.text, late.text
    assert "transcript: " in late.text, late.text
    assert "Agent not found" not in late.text, late.text


def test_notices_wait_for_the_turn_and_coalesce(sandbox: Sandbox) -> None:
    """Two children that finish while the parent sleeps arrive after its tool batch, as ONE notice."""
    # `async` join, so the outbox, not the same-turn group join, is what coalesces them.
    sandbox.patch_json("subagents.json", {"defaultJoinMode": "async"})
    result = run_ok(
        sandbox,
        script(
            [
                {"tools": [spawn("alpha", model="kida/child"), spawn("beta", model="kidb/child")]},
                tool("bash", command="sleep 3; echo SLEPT"),
                {"echoLast": True},
            ],
            kida=[{"delayMs": 200, "text": "ALPHA RESULT 6"}],
            kidb=[{"delayMs": 400, "text": "BETA RESULT 6"}],
        ),
        ["kida/child", "kidb/child"],
    )
    delivered = notices(result)
    assert len(delivered) == 1, f"expected one coalesced notice, got {len(delivered)}\n{result.transcript()}"
    assert "2 background tasks finished." in delivered[0], delivered[0]
    assert "ALPHA RESULT 6" in delivered[0], delivered[0]
    assert "BETA RESULT 6" in delivered[0], delivered[0]
    # v0.22: a busy parent gets the held notice at the `turn_end` after the tool batch (never
    # mid-batch), before its next model call.
    (bash_done,) = event_index(
        result, lambda event: event.get("type") == "tool_execution_end" and event.get("toolName") == "bash"
    )
    batch_end = next(
        i for i in event_index(result, lambda event: event.get("type") == "turn_end") if i > bash_done
    )
    (notice_at,) = event_index(result, is_notice)
    assert notice_at > batch_end, f"notice delivered mid-batch\n{result.transcript()}"
    # The next provider request carries the one notice with both results: `echoLast` replies with
    # the last non-assistant message that request received, so no extra turn is needed.
    (echo,) = [text for text in result.assistant_texts() if text.startswith("ECHO ")]
    assert "ALPHA RESULT 6" in echo, f"{echo}\n{result.transcript()}"
    assert "BETA RESULT 6" in echo, f"{echo}\n{result.transcript()}"
    assert "2 background tasks finished." in echo, echo
    assert result.assistant_texts()[-1] == echo, result.transcript()


def test_early_fetch_suppresses_notice(sandbox: Sandbox) -> None:
    """A result fetched with `wait` before the child finished is never announced again."""
    result = run_ok(
        sandbox,
        script(
            [
                {"tools": [spawn("waited")]},
                tool("get_subagent_result", agent_id="{{agentId}}", wait=True),
                tool("bash", command="sleep 1"),
                {"text": "PARENT DONE"},
            ],
            kid=[{"delayMs": 800, "text": "CHILD RESULT 7"}],
        ),
        [CHILD],
    )
    (fetched,) = outcomes(result, "get_subagent_result")
    assert "CHILD RESULT 7" in fetched.text, result.transcript()
    assert not notices(result), result.transcript()
    assert result.assistant_texts()[-1] == "PARENT DONE", result.transcript()


FUZZY_ENABLED = {
    "fopus46": "claude-opus-4-6",
    "fopus5": "claude-opus-5",
    "fopus55": "claude-opus-5-5",
    "fsonnet5": "claude-sonnet-5",
    "fsonnet55": "claude-sonnet-5-5",
    "fgpt6": "gpt-6-sol",
    "fgpt61": "gpt-6.1-sol",
}
# Registered but not enabled: newer than every enabled sibling, so picking one means the
# resolver ignored `enabledModels`.
FUZZY_DISABLED = {"fopus6": "claude-opus-6", "fsonnet6": "claude-sonnet-6", "fgpt62": "gpt-6.2-sol"}


def test_fuzzy_model_picks_newest_enabled(sandbox: Sandbox) -> None:
    """`opus` / `sonnet` / `gpt-6` resolve to the newest ENABLED version, skipping a newer disabled one."""
    providers: dict[str, Any] = {
        "faux": {
            "models": ["main"],
            "steps": [
                {"tools": [spawn("opus", model="opus", background=False)]},
                {"tools": [spawn("sonnet", model="sonnet", background=False)]},
                {"tools": [spawn("gpt", model="gpt-6", background=False)]},
                {"text": "PARENT DONE"},
            ],
        }
    }
    for provider, model in (FUZZY_ENABLED | FUZZY_DISABLED).items():
        providers[provider] = {"models": [model], "steps": [{"text": f"ANSWERED BY {provider}/{model}"}]}
    # Replace, not append: the rendered list enables real `anthropic/claude-opus-5-5` etc.,
    # which would tie with the faux ids on version.
    sandbox.patch_json(
        "settings.json",
        {"enabledModels": [PARENT, *(f"{provider}/{model}" for provider, model in FUZZY_ENABLED.items())]},
    )
    result = run_headless(sandbox, {"providers": providers}, ["go"])
    assert result.returncode == 0, result.transcript()
    answers = [outcome.text for outcome in outcomes(result, "Agent")]
    assert len(answers) == 3, result.transcript()
    assert "ANSWERED BY fopus55/claude-opus-5-5" in answers[0], answers[0]
    assert "ANSWERED BY fsonnet55/claude-sonnet-5-5" in answers[1], answers[1]
    assert "ANSWERED BY fgpt61/gpt-6.1-sol" in answers[2], answers[2]


PINNED_AGENT = """---
name: {name}
description: Harness agent pinned to a model
model: pfile/child
tools: read
---

Answer.
"""


def answered_by(provider: str) -> list[dict[str, Any]]:
    """Steps for a precedence provider: every answer names the provider.

    Parameters:
        provider (str): provider name.

    Returns:
        list[dict[str, Any]]: faux steps.
    """
    return [{"text": f"ANSWERED BY {provider}"}] * 3


def precedence_run(
    sandbox: Sandbox,
    agent_models: dict[str, str] | None,
    calls: list[dict[str, Any]],
    inherits: frozenset[str] = frozenset(),
) -> list[str]:
    """Run foreground `Agent` calls with `agentModels` set to exactly `agent_models`.

    Parameters:
        sandbox (Sandbox): sandbox to run in.
        agent_models (dict[str, str] | None): the whole `agentModels` value; `None` removes it.
        calls (list[dict[str, Any]]): `Agent` calls, one per parent step.
        inherits (frozenset[str]): descriptions of the calls whose child runs on the parent's
            model, so the parent's own queue answers it next.

    Returns:
        list[str]: each `Agent` result text, in call order.
    """
    for name in ("pinned", "pinned-star"):
        path = sandbox.agent_dir / "agents" / f"{name}.md"
        path.write_text(PINNED_AGENT.format(name=name))
    subagents_path = sandbox.agent_dir / "subagents.json"
    cfg = json.loads(subagents_path.read_text())
    cfg.pop("agentModels", None)
    if agent_models is not None:
        cfg["agentModels"] = agent_models
    subagents_path.write_text(json.dumps(cfg, indent=2))
    # The parent's own queue also answers a child that inherits `faux/main`.
    parent_steps: list[dict[str, Any]] = []
    for agent_call in calls:
        parent_steps.append({"tools": [agent_call]})
        if agent_call["args"]["description"] in inherits:
            parent_steps.append({"text": "ANSWERED BY faux"})
    parent_steps.append({"text": "PARENT DONE"})
    providers = ("pparam", "ptype", "pstar", "pfile")
    result = run_ok(
        sandbox,
        script(parent_steps, **{provider: answered_by(provider) for provider in providers}),
        [f"{provider}/child" for provider in providers],
    )
    answers = [outcome.text for outcome in outcomes(result, "Agent")]
    assert len(answers) == len(calls), result.transcript()
    return answers


def test_agent_models_precedence(sandbox: Sandbox) -> None:
    """param > `agentModels[type]` > `agentModels["*"]` > agent file `model:` > parent."""
    with_map = precedence_run(
        sandbox,
        {"pinned": "ptype/child", "*": "pstar/child"},
        [
            spawn("param", model="pparam/child", background=False, subagent_type="pinned"),
            spawn("type", model=None, background=False, subagent_type="pinned"),
            spawn("star", model=None, background=False, subagent_type="pinned-star"),
        ],
    )
    assert "ANSWERED BY pparam" in with_map[0], with_map[0]
    assert "ANSWERED BY ptype" in with_map[1], with_map[1]
    assert "ANSWERED BY pstar" in with_map[2], with_map[2]
    without_map = precedence_run(
        sandbox,
        None,
        [
            spawn("file", model=None, background=False, subagent_type="pinned"),
            spawn("parent", model=None, background=False),
        ],
        inherits=frozenset({"parent"}),
    )
    assert "ANSWERED BY pfile" in without_map[0], without_map[0]
    assert "ANSWERED BY faux" in without_map[1], without_map[1]


def nested_run(sandbox: Sandbox, child_calls: list[dict[str, Any]]) -> str:
    """Have a foreground child make `child_calls` in one message, then report their results.

    The child first calls `search_tools`, as a model would, so deferred tools such as
    `workflow` are in its active set when the calls go out.

    Parameters:
        sandbox (Sandbox): sandbox to run in.
        child_calls (list[dict[str, Any]]): calls the child makes.

    Returns:
        str: the parent's `Agent` result, carrying the child's `REPORT`.
    """
    # Nesting is off at the rendered depth 1; depth 2 gives the child its own `Agent`.
    sandbox.patch_json("subagents.json", {"maxSubagentDepth": 2})
    result = run_ok(
        sandbox,
        script(
            [{"tools": [spawn("nester", background=False)]}, {"text": "PARENT DONE"}],
            kid=[tool("search_tools", query="workflow"), {"tools": child_calls}, {"report": True}],
        ),
        [CHILD],
    )
    (agent,) = outcomes(result, "Agent")
    assert "REPORT" in agent.text, result.transcript()
    return agent.text


def test_subagent_workflow_and_background_agent_are_denied(sandbox: Sandbox) -> None:
    """Inside a subagent, `workflow` and a background `Agent` fail with the reason, not silently."""
    report = nested_run(
        sandbox,
        [
            call("workflow", script="export const meta = { name: 'x', description: 'x' }"),
            call(
                "Agent",
                subagent_type="general-purpose",
                description="inner",
                prompt="x",
                run_in_background=True,
            ),
        ],
    )
    assert "Workflows are not available inside a subagent" in report, report
    assert "Background agents are not available inside a subagent" in report, report


def test_subagent_workflow_tool_is_denied_with_reason(sandbox: Sandbox) -> None:
    """Inside a subagent, `SubagentWorkflow` fails with the 'not available inside a subagent' reason."""
    report = nested_run(
        sandbox, [call("SubagentWorkflow", script="export const meta = { name: 'x', description: 'x' }")]
    )
    assert "Workflows are not available inside a subagent" in report, report


def test_turn_cap_ends_with_full_report(sandbox: Sandbox) -> None:
    """A child looping on tools past `max_turns` is forced into a tool-less report turn."""
    result = run_ok(
        sandbox,
        script(
            [{"tools": [spawn("looper", background=False, max_turns=2)]}, {"text": "PARENT DONE"}],
            kid=[
                {
                    "whileTools": True,
                    "text": "Now let me check one more thing",
                    "tools": [call("bash", command="echo loop")],
                },
                {"text": "FINAL REPORT 11: every finding, with paths"},
            ],
        ),
        [CHILD],
    )
    (agent,) = outcomes(result, "Agent")
    assert "FINAL REPORT 11" in agent.text, result.transcript()
    assert "Now let me check" not in agent.text, agent.text
    assert "aborted" not in agent.text, agent.text
