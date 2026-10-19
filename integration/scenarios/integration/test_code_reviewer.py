"""The configured `code-reviewer` can inspect a diff but cannot mutate its workspace.

References:
- pi-subagents: https://github.com/nredd/pi-subagents
- Configured agent: ~/.pi/agent/agents/code-reviewer.md (rendered from chezmoi)
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest

from harness.git_fixture import make_git_fixture
from harness.headless import run_headless
from harness.sandbox import enable_faux_models
from scenarios.integration.test_subagents import outcomes, script, spawn

if TYPE_CHECKING:
    from harness.sandbox import Sandbox

pytestmark = pytest.mark.integration

READ_TOOLS = {"git_diff", "git_show", "git_log", "git_status", "read", "grep", "find"}
MUTATION_TOOLS = {
    "edit",
    "write",
    "bash",
    "git_commit",
    "git_worktree_add",
    "git_worktree_remove",
    "git_worktree_prune",
}


def review(sandbox: Sandbox, steps: list[dict[str, Any]]) -> str:
    """Spawn the real rendered agent with only its model overridden to a faux provider.

    Parameters:
        sandbox (Sandbox): isolated home containing the unmodified configured agent.
        steps (list[dict[str, Any]]): child's scripted model responses.

    Returns:
        str: foreground child's final answer.
    """
    agent = sandbox.agent_dir / "agents" / "code-reviewer.md"
    assert agent.is_file(), f"Configured agent missing: '{agent}'"
    enable_faux_models(sandbox, ["faux/main", "kid/child"])
    result = run_headless(
        sandbox,
        script(
            [{"tools": [spawn("review", background=False, subagent_type="code-reviewer")]}, {"text": "DONE"}],
            kid=steps,
        ),
        ["review the change"],
    )
    assert result.returncode == 0, result.transcript()
    (agent_result,) = outcomes(result, "Agent")
    assert not agent_result.is_error, result.transcript()
    _, separator, answer = agent_result.text.partition("\n\n")
    assert separator, agent_result.text
    return answer


def test_configured_reviewer_tool_surface(sandbox: Sandbox) -> None:
    """Actual configured reviewer exposes all seven reads and none of the mutation tools."""
    answer = review(sandbox, [{"listTools": True}])
    assert answer.startswith("TOOLS "), answer
    offered = set(answer.removeprefix("TOOLS ").strip().split(","))
    assert offered >= READ_TOOLS, answer
    assert not offered & MUTATION_TOOLS, answer


def test_configured_reviewer_executes_reads(sandbox: Sandbox) -> None:
    """Every permitted tool runs through the child's pipeline against real fixture files/git."""
    repo, _ = make_git_fixture(sandbox.workdir)
    calls = [
        {"name": "git_diff", "args": {"cwd": str(repo)}},
        {"name": "git_show", "args": {"cwd": str(repo), "rev": "HEAD"}},
        {"name": "git_log", "args": {"cwd": str(repo)}},
        {"name": "git_status", "args": {"cwd": str(repo)}},
        {"name": "read", "args": {"path": str(repo / "a.txt")}},
        {"name": "grep", "args": {"pattern": "two", "path": str(repo / "a.txt")}},
        {"name": "find", "args": {"pattern": "a.txt", "path": str(repo)}},
    ]
    # Report each result separately so each tool's success marker is unambiguous.
    for tool_call, expected in zip(
        calls, ["+two", "Initial", "Initial", "main", "one", "two", "a.txt"], strict=True
    ):
        answer = review(sandbox, [{"tools": [tool_call]}, {"report": True}])
        assert answer.startswith("REPORT\n"), answer
        assert expected in answer, f"{tool_call['name']}: {answer}"
        assert "not found" not in answer.lower(), answer


def test_configured_reviewer_rejects_mutations(sandbox: Sandbox) -> None:
    """Explicit mutation calls fail as unavailable, including write leaving its target intact."""
    target = sandbox.workdir / "protected.txt"
    original = b"REVIEWER MUST NOT CHANGE THIS\n"
    target.write_bytes(original)
    calls = [
        {"name": "write", "args": {"path": str(target), "content": "CORRUPTED\n"}},
        {"name": "edit", "args": {"path": str(target), "oldText": original.decode(), "newText": "CORRUPTED"}},
        {"name": "bash", "args": {"command": f"printf CORRUPTED > {target}"}},
        {"name": "git_commit", "args": {"subject": "Corrupt fixture", "paths": [str(target)], "push": False}},
        {"name": "git_worktree_add", "args": {"branch": "reviewer-mutation"}},
        {"name": "git_worktree_remove", "args": {"path": str(sandbox.workdir), "force": True}},
        {"name": "git_worktree_prune", "args": {"dry_run": False}},
    ]
    for tool_call in calls:
        answer = review(sandbox, [{"tools": [tool_call]}, {"report": True}])
        assert f"Tool {tool_call['name']} not found" in answer, answer
        assert target.read_bytes() == original, f"{tool_call['name']} changed '{target}'"
