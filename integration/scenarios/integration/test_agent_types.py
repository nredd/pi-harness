"""The configured specialist agents expose exactly their documented tool surfaces.

Each agent file is the real one rendered from chezmoi; only the model is overridden to a faux
provider, so this checks frontmatter scoping (`tools:`, `extensions:`, `disallowed_tools:`), not
prompts.

References:
- pi-subagents tool scoping: https://github.com/nredd/pi-subagents#tool--extension-scoping
- Configured agents: ~/.pi/agent/agents/{architect,critic,debugger,researcher,verifier}.md
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest

from harness.headless import run_headless
from harness.sandbox import enable_faux_models
from scenarios.integration.test_subagents import outcomes, script, spawn

if TYPE_CHECKING:
    from harness.sandbox import Sandbox

pytestmark = pytest.mark.integration

READS = {"read", "grep", "find"}
GIT_READS = {"git_diff", "git_show", "git_log", "git_status"}
WORKTREE_MUTATIONS = {"git_worktree_add", "git_worktree_remove", "git_worktree_prune"}
MUTATIONS = {"edit", "write", "bash", "git_commit"} | WORKTREE_MUTATIONS
WEB = {"web_search", "fetch_content", "source_check", "get_search_content"}

# agent type -> (tools that must be offered, tools that must not be)
SURFACES: dict[str, tuple[set[str], set[str]]] = {
    "architect": (READS | GIT_READS, MUTATIONS | WEB),
    "critic": (READS | GIT_READS | {"py_test", "cargo_test"}, MUTATIONS | WEB),
    "researcher": (READS | WEB, MUTATIONS | GIT_READS),
    "verifier": (READS | {"bash", "git_status", "git_log", "git_diff"}, MUTATIONS - {"bash"}),
    "debugger": (
        READS | {"edit", "write", "bash"},
        {"git_commit", "git_worktree_remove", "git_worktree_prune", "memory_write", "scratchpad"},
    ),
}


def ask(sandbox: Sandbox, agent_type: str, steps: list[dict[str, Any]]) -> str:
    """Spawn the real rendered agent in the foreground with a faux child model.

    Parameters:
        sandbox (Sandbox): isolated home containing the unmodified configured agents.
        agent_type (str): `subagent_type` to spawn.
        steps (list[dict[str, Any]]): child's scripted model responses.

    Returns:
        str: foreground child's final answer.
    """
    agent = sandbox.agent_dir / "agents" / f"{agent_type}.md"
    assert agent.is_file(), f"Configured agent missing: '{agent}'"
    enable_faux_models(sandbox, ["faux/main", "kid/child"])
    result = run_headless(
        sandbox,
        script(
            [{"tools": [spawn(agent_type, background=False, subagent_type=agent_type)]}, {"text": "DONE"}],
            kid=steps,
        ),
        [f"run {agent_type}"],
    )
    assert result.returncode == 0, result.transcript()
    (agent_result,) = outcomes(result, "Agent")
    assert not agent_result.is_error, result.transcript()
    _, separator, answer = agent_result.text.partition("\n\n")
    assert separator, agent_result.text
    return answer


@pytest.mark.parametrize("agent_type", sorted(SURFACES))
def test_agent_tool_surface(sandbox: Sandbox, agent_type: str) -> None:
    """Each specialist is offered its required tools and none of its forbidden ones."""
    required, forbidden = SURFACES[agent_type]
    answer = ask(sandbox, agent_type, [{"listTools": True}])
    assert answer.startswith("TOOLS "), answer
    offered = set(answer.removeprefix("TOOLS ").strip().split(","))
    assert offered >= required, f"{agent_type} missing {sorted(required - offered)}: {answer}"
    assert not offered & forbidden, f"{agent_type} offered {sorted(offered & forbidden)}: {answer}"


@pytest.mark.parametrize("agent_type", ["architect", "critic", "researcher"])
def test_read_only_agent_rejects_write(sandbox: Sandbox, agent_type: str) -> None:
    """An explicit `write` from a read-only specialist fails as unavailable and leaves the file."""
    target = sandbox.workdir / "protected.txt"
    original = b"MUST NOT CHANGE\n"
    target.write_bytes(original)
    call = {"name": "write", "args": {"path": str(target), "content": "CORRUPTED\n"}}
    answer = ask(sandbox, agent_type, [{"tools": [call]}, {"report": True}])
    assert "Tool write not found" in answer, answer
    assert target.read_bytes() == original


def test_debugger_cannot_commit(sandbox: Sandbox) -> None:
    """`disallowed_tools` holds even though `git_commit` is always-active for full agents."""
    call = {"name": "git_commit", "args": {"subject": "Sneak", "paths": ["x"], "push": False}}
    answer = ask(sandbox, "debugger", [{"tools": [call]}, {"report": True}])
    assert "Tool git_commit not found" in answer, answer
