"""`Agent` worktree isolation of a repo the session was not started in.

pi runs from a plain directory and names the target repo through the `Agent` tool's `cwd`.
Before that parameter the worktree always came from the session cwd, so this failed with a bare
"not a git repo" and no way to say which repo was meant.
"""

from __future__ import annotations

import re
import subprocess
from typing import TYPE_CHECKING, Any

import pytest

from harness.headless import ToolOutcome, run_headless
from harness.paths import GIT_BIN
from harness.sandbox import enable_faux_models

if TYPE_CHECKING:
    from pathlib import Path

    from harness.headless import RunResult
    from harness.sandbox import Sandbox

pytestmark = pytest.mark.integration

CHILD_FILE = "AGENT.txt"
CHILD_DONE = "CHILD DONE"
BRANCH = re.compile(r"Changes saved to branch `(pi-agent-[^`]+)`")


def git(repo: Path, *args: str) -> str:
    """Run git in `repo` and return its stripped stdout.

    Parameters:
        repo (Path): working directory.
        *args (str): git arguments.

    Returns:
        str: stdout without surrounding whitespace.
    """
    return subprocess.check_output([GIT_BIN, "-C", str(repo), *args], text=True).strip()


def init_repo(path: Path) -> None:
    """Create a repo with a committed `pkg/` subdirectory.

    Identity and signing live in the repo config: the sandbox `$HOME` has no gitconfig, and the
    worktree cleanup commit inherits the main repo's config.

    Parameters:
        path (Path): directory to create.
    """
    (path / "pkg").mkdir(parents=True)
    (path / "pkg" / "index.ts").write_text("export {};\n")
    git(path.parent, "init", "-q", str(path))
    for key, value in (("user.name", "h"), ("user.email", "h@h"), ("commit.gpgsign", "false")):
        git(path, "config", key, value)
    git(path, "add", "-A")
    git(path, "commit", "-q", "-m", "init")


def spawn_script(agent_args: dict[str, Any]) -> dict[str, Any]:
    """Parent spawns one foreground child that writes `CHILD_FILE`, then reports the tool result.

    Parameters:
        agent_args (dict[str, Any]): extra `Agent` arguments, e.g. `isolation` and `cwd`.

    Returns:
        dict[str, Any]: faux script.
    """
    args = {
        "subagent_type": "general-purpose",
        "description": "isolated write",
        "prompt": "write the file",
        "run_in_background": False,
        "model": "fauxchild/child",
        **agent_args,
    }
    return {
        "providers": {
            "faux": {
                "models": ["main"],
                "steps": [{"tools": [{"name": "Agent", "args": args}]}, {"report": True}],
            },
            "fauxchild": {
                "models": ["child"],
                "steps": [
                    {"tools": [{"name": "write", "args": {"path": CHILD_FILE, "content": "isolated\n"}}]},
                    {"text": CHILD_DONE},
                ],
            },
        }
    }


def agent_outcome(result: RunResult) -> ToolOutcome:
    """Return the single settled `Agent` call of a run.

    Parameters:
        result (RunResult): headless run.

    Returns:
        ToolOutcome: the `Agent` outcome.
    """
    outcomes = [outcome for outcome in result.tool_outcomes() if outcome.name == "Agent"]
    assert len(outcomes) == 1, result.transcript()
    return outcomes[0]


def test_worktree_from_named_repo(sandbox: Sandbox) -> None:
    """`cwd: "~/code/target/pkg"` isolates that repo; the session dir and main checkout stay clean."""
    enable_faux_models(sandbox, ["faux/main", "fauxchild/child"])
    repo = sandbox.home / "code" / "target"
    init_repo(repo)
    with pytest.raises(subprocess.CalledProcessError):
        git(sandbox.workdir, "rev-parse", "--is-inside-work-tree")

    result = run_headless(
        sandbox, spawn_script({"isolation": "worktree", "cwd": "~/code/target/pkg"}), ["delegate"]
    )

    outcome = agent_outcome(result)
    assert not outcome.is_error, result.transcript()
    assert CHILD_DONE in outcome.text, result.transcript()
    assert f"in `{repo.resolve()}`" in outcome.text, outcome.text
    branch_match = BRANCH.search(outcome.text)
    assert branch_match, outcome.text
    branch = branch_match.group(1)
    # The parent got the result back.
    assert any(CHILD_DONE in text for text in result.assistant_texts()), result.transcript()

    # The child's write landed on a branch of THAT repo, at the subdirectory it named.
    assert f"pkg/{CHILD_FILE}" in git(repo, "ls-tree", "-r", "--name-only", branch).splitlines()
    # Main checkout and session dir untouched; the copy is gone.
    assert git(repo, "status", "--porcelain") == ""
    assert not (repo / "pkg" / CHILD_FILE).exists()
    assert not (sandbox.workdir / CHILD_FILE).exists()
    assert len(git(repo, "worktree", "list").splitlines()) == 1


def test_worktree_failure_names_directory(sandbox: Sandbox) -> None:
    """Without `cwd`, a non-repo session dir fails the call naming that dir and the `cwd` fix."""
    enable_faux_models(sandbox, ["faux/main", "fauxchild/child"])

    result = run_headless(sandbox, spawn_script({"isolation": "worktree"}), ["delegate"])

    outcome = agent_outcome(result)
    assert outcome.is_error, result.transcript()
    assert f"{sandbox.workdir} is not inside a git repository" in outcome.text, outcome.text
    assert "pass its path as the `Agent` tool's `cwd`" in outcome.text, outcome.text
    assert not (sandbox.workdir / CHILD_FILE).exists()
