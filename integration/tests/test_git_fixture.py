"""The scenario `git` helper against a real git binary in a private repository.

References:
- https://git-scm.com/docs/git
- https://git-scm.com/docs/git-log#_pretty_formats
"""

from __future__ import annotations

import subprocess
from typing import TYPE_CHECKING

import pytest

from harness.git_fixture import git

if TYPE_CHECKING:
    from pathlib import Path


@pytest.fixture
def isolated_git(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Keep the owner's global/system git config (signing, hooks, identity) out of the repository.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): private git environment.
        tmp_path (Path): private repository root.

    Returns:
        Path: an empty directory to initialize.
    """
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "no-global-config"))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path))
    repo = tmp_path / "repo"
    repo.mkdir()
    return repo


def test_git_commits_on_main_with_the_fixed_unsigned_identity(isolated_git: Path) -> None:
    """A repository built only through `git` has `main`, the throwaway identity and no signature.

    Parameters:
        isolated_git (Path): empty repository directory.
    """
    repo = isolated_git
    git(repo, "init", "-q")
    (repo / "a.txt").write_text("one\n")
    git(repo, "add", "a.txt")
    assert git(repo, "commit", "-q", "-m", "Initial") == ""
    assert git(repo, "branch", "--show-current") == "main\n"
    assert git(repo, "log", "--format=%an <%ae>|%cn <%ce>|%G?|%s") == "h <h@h>|h <h@h>|N|Initial\n"
    assert git(repo, "show", "--format=", "--name-status", "HEAD") == "A\ta.txt\n"
    assert git(repo, "status", "--porcelain") == ""


def test_git_failure_carries_the_diagnostic(isolated_git: Path) -> None:
    """A failing command raises with git's stderr merged into the captured output.

    Parameters:
        isolated_git (Path): empty repository directory.
    """
    git(isolated_git, "init", "-q")
    with pytest.raises(subprocess.CalledProcessError) as failure:
        git(isolated_git, "rev-parse", "--verify", "refs/heads/missing")
    assert failure.value.returncode != 0
    assert "fatal: Needed a single revision" in failure.value.output
