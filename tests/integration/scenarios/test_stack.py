"""Declared package discovery, process modes and model-visible schemas at the assembled boundary.

References:
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import time
from typing import TYPE_CHECKING, Any

import pytest
from pi_release.stack import find_package, load_stack, source_string

from harness.golden import assert_golden
from harness.headless import run_headless
from harness.paths import FAUX_EXTENSION, REPO_ROOT, pi_command
from harness.rpc import RpcProcess

if TYPE_CHECKING:
    from collections.abc import Callable

    from harness.sandbox import Sandbox
    from harness.tmux import TmuxPane

pytestmark = pytest.mark.stack
SCRIPT: dict[str, Any] = {"providers": {"faux": {"models": ["main"], "steps": [{"text": "STACK-OK"}]}}}


def wait_dead(pane: TmuxPane) -> int:
    """Require a real TUI process to exit and expose its exit status.

    Parameters:
        pane (TmuxPane): private tmux pane.

    Returns:
        int: child's status.

    Raises:
        AssertionError: the process does not exit and record status before the deadline.
    """
    deadline = time.monotonic() + 30
    assert pane.exit_status_path is not None
    while time.monotonic() < deadline:
        if pane.exit_status_path.is_file() and not pane.is_alive():
            return int(pane.exit_status_path.read_text().strip())
        time.sleep(0.05)
    try:
        capture = pane.capture()
    except (RuntimeError, OSError, UnicodeError):
        capture = "Pane capture unavailable"
    raise AssertionError(f"TUI never reported its exit status: {capture}")


@pytest.mark.parametrize("mode", ["text", "json", "rpc", "tui"])
def test_extensions_load_without_warnings(sandbox: Sandbox, tui: Callable[..., TmuxPane], mode: str) -> None:
    """Actual package discovery is quiet in every CLI mode, with no GUI-helper side effects.

    Parameters:
        sandbox (Sandbox): private installed stack.
        tui (Callable[..., TmuxPane]): private terminal launcher.
        mode (str): real CLI output mode.
    """
    if mode == "json":
        result = run_headless(sandbox, SCRIPT, ["hi"], extra_args=["--no-approve"])
        assert result.returncode == 0, result.transcript()
        assert result.assistant_texts() == ["STACK-OK"], result.transcript()
        assert not result.stdout_noise
        assert not result.stderr.strip(), result.stderr
    elif mode == "text":
        script = sandbox.root / "text.json"
        script.write_text(json.dumps(SCRIPT))
        done = subprocess.run(
            [*pi_command(), "-e", str(FAUX_EXTENSION), "--model", "faux/main", "--no-approve", "-p", "hi"],
            cwd=sandbox.workdir,
            env=sandbox.env({"HARNESS_SCRIPT": str(script)}),
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        assert done.returncode == 0, done.stderr
        assert done.stdout.strip() == "STACK-OK"
        assert not done.stderr.strip(), done.stderr
    elif mode == "rpc":
        with RpcProcess(sandbox, SCRIPT) as rpc:
            rpc.send({"id": "state", "type": "get_state"})
            state = rpc.receive(lambda event: event.get("id") == "state")
            assert state["success"], state
            rpc.prompt()
        assert rpc.process.returncode == 0
        assert not "".join(rpc.stderr).strip()
    else:
        pane = tui(SCRIPT, extra_args=["--no-approve"])
        pane.send_keys("C-d")
        assert wait_dead(pane) == 0
        assert not (sandbox.root / "pi0.stderr").read_text().strip()
    assert not list((sandbox.home / "Applications").glob("*.app"))


def test_preset_resource_selection(sandbox: Sandbox) -> None:
    """Real discovery distinguishes footer-only personal from intentionally full local resources.

    Parameters:
        sandbox (Sandbox): actual installed selection; no local preset injection or source replacement.
    """
    name = (sandbox.agent_dir / "stack-name").read_text()
    preset = find_package("pi-preset", sandbox.settings()["packages"], sandbox.agent_dir)
    report = sandbox.root / "script-stack-resources.json"
    result = run_headless(
        sandbox,
        SCRIPT,
        ["hi"],
        extra_args=["--no-approve", "-e", str(REPO_ROOT / "probes/stack-resources.ts")],
        env={"HARNESS_RESOURCE_REPORT": str(report), "HARNESS_PRESET_ROOT": str(preset)},
    )
    assert result.returncode == 0, result.transcript()
    assert not result.stderr.strip(), result.stderr
    receipt = json.loads(report.read_text())
    expected = {"extensions": ["extensions/expanded-footer.ts"], "skills": [], "prompts": [], "themes": []}
    if name == "local":
        expected["extensions"] = ["src/index.ts"]
        expected["skills"] = [
            f"skills/{skill}/SKILL.md"
            for skill in ("code-review", "coding-like-redd", "get-it-merged", "ship-issue")
        ]
        expected["themes"] = ["themes/belafonte-day.json", "themes/tokyonight-storm.json"]
    else:
        assert name == "personal", name
        packages = sandbox.settings()["packages"]
        declared = load_stack(REPO_ROOT.parents[1] / "release" / "stacks" / f"{name}.json")
        assert len(packages) == len(declared.sources) == 13
        assert packages[0] == {"source": source_string(declared.sources[0]), **expected}
        assert json.loads((sandbox.agent_dir / "subagents.json").read_text())["packageAgents"] is False
    assert receipt["resources"] == expected
    description = receipt["agentParameters"]["properties"]["subagent_type"]["description"]
    available = re.search(r"Available types: (.*?)\.", description)
    assert available, description
    types = {value.strip() for value in available[1].split(",")}
    specialists = {
        "architect",
        "code-reviewer",
        "critic",
        "debugger",
        "principal-investigator",
        "researcher",
        "verifier",
    }
    if name == "personal":
        assert types == {"general-purpose", "Explore", "Plan"}, types
    else:
        assert specialists <= types, types


@pytest.mark.parametrize(
    ("agent_type", "without_web", "expected"),
    [
        ("Explore", False, {"read", "grep", "find", "ls"}),
        (
            "architect",
            False,
            {
                "read",
                "grep",
                "find",
                "git_log",
                "git_diff",
                "git_show",
                "git_status",
                "web_search",
                "fetch_content",
                "get_search_content",
                "source_check",
            },
        ),
        ("architect", True, {"read", "grep", "find", "git_log", "git_diff", "git_show", "git_status"}),
    ],
)
def test_runtime_agent_surfaces(
    sandbox: Sandbox, agent_type: str, without_web: bool, expected: set[str]
) -> None:
    """Replay the owned agent-file fixtures through the selected release binary and installed stack.

    Parameters:
        sandbox (Sandbox): explicit installed package set and private home.
        agent_type (str): shared Explore-shaped or architect-shaped fixture.
        without_web (bool): negative control removing directory-entry package admission.
        expected (set[str]): exact provider-visible child tools, excluding the refusal-only stand-in.
    """
    agents = sandbox.agent_dir / "agents"
    agents.mkdir(exist_ok=True)
    fixture = REPO_ROOT.parent / "inprocess/tests/fixtures/agents" / f"{agent_type}.md"
    shutil.copyfile(fixture, agents / fixture.name)
    if without_web:
        path = agents / fixture.name
        path.write_text(path.read_text().replace("[pi-dev-tools, pi-web-access]", "[pi-dev-tools]"))
    sandbox.patch_json("subagents.json", {"agentModels": {}, "modelTiers": {}, "maxSubagentDepth": 2})
    sandbox.patch_json("web-search.json", {"toolActivation": "eager", "allowBrowserCookies": False})
    script = {
        "providers": {
            "faux": {
                "models": ["main"],
                "steps": [
                    {
                        "tools": [
                            {
                                "name": "Agent",
                                "args": {
                                    "subagent_type": agent_type,
                                    "description": "surface proof",
                                    "prompt": "list tools",
                                    "model": "faux/main",
                                    "run_in_background": False,
                                },
                            }
                        ]
                    },
                    {"listTools": True},
                    {"text": "SURFACE-DONE"},
                ],
            }
        }
    }
    result = run_headless(sandbox, script, ["run surface proof"], extra_args=["--no-approve"])
    assert result.returncode == 0, result.transcript()
    outcomes = [outcome for outcome in result.tool_outcomes() if outcome.name == "Agent"]
    assert len(outcomes) == 1, result.transcript()
    outcome = outcomes[0]
    assert not outcome.is_error, outcome.text
    offered = re.search(r"TOOLS ([A-Za-z_0-9,]+)", outcome.text)
    assert offered, result.transcript()
    assert set(offered[1].split(",")) - {"SubagentWorkflow"} == expected


def test_tool_set(sandbox: Sandbox) -> None:
    """The stack's exact schema golden and deferred `monitor_*`/worktree promotion survive the real loader.

    Parameters:
        sandbox (Sandbox): private installed stack with explicit tool policy.
    """
    searches = [
        {"name": "search_tools", "args": {"query": query, "kind": "tool"}}
        for query in ("background monitor process watcher", "git worktree add remove")
    ]
    script = {
        "providers": {
            "faux": {
                "models": ["main"],
                "steps": [
                    {"listTools": True},
                    {"tools": searches},
                    {"listTools": True},
                ],
            }
        }
    }
    result = run_headless(sandbox, script, ["before", "promote"], extra_args=["--no-approve"])
    assert result.returncode == 0, result.transcript()
    texts = [text for text in result.assistant_texts() if text.startswith("TOOLS ")]
    assert len(texts) == 2, result.transcript()
    before, after = (set(text.removeprefix("TOOLS ").split(",")) for text in texts)
    name = (sandbox.agent_dir / "stack-name").read_text()
    assert_golden(f"{name}-tools.txt", "\n".join(sorted(before)) + "\n")
    promoted = {"monitor_start", "monitor_read", "monitor_stop", "git_worktree_add", "git_worktree_remove"}
    assert not before & promoted, before
    assert promoted <= after, after
    assert "git_worktree_list" in before
    found = [outcome for outcome in result.tool_outcomes() if outcome.name == "search_tools"]
    assert len(found) == 2, result.transcript()
    assert all(not outcome.is_error for outcome in found), found
    text = "\n".join(outcome.text for outcome in found)
    assert all(tool in text for tool in promoted), text
