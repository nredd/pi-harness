"""The scenario `git` helper against a real git binary in a private repository.

References:
- https://git-scm.com/docs/git
- https://git-scm.com/docs/git-log#_pretty_formats
"""

from __future__ import annotations

import os
import subprocess
from typing import TYPE_CHECKING

import pytest

from harness.git_fixture import git

if TYPE_CHECKING:
    from pathlib import Path


@pytest.fixture
def isolated_git(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Run with no inherited `GIT_*` (repo selection, config) and no owner global/system config.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): private git environment.
        tmp_path (Path): private repository root.

    Returns:
        Path: an empty directory to initialize.
    """
    for name in [name for name in os.environ if name.startswith("GIT_")]:
        monkeypatch.delenv(name)
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


def test_git_ignores_an_inherited_repository_selection(
    isolated_git: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Inherited `GIT_DIR`/`GIT_INDEX_FILE` (e.g. from a hook) never redirect the helper to another repo.

    Parameters:
        isolated_git (Path): empty repository directory.
        tmp_path (Path): private decoy repository root.
        monkeypatch (pytest.MonkeyPatch): decoy selection variables, as a git hook exports them.
    """
    decoy = tmp_path / "decoy"
    decoy.mkdir()
    subprocess.run(["git", "init", "-q", str(decoy)], check=True, capture_output=True)
    monkeypatch.setenv("GIT_DIR", str(decoy / ".git"))
    monkeypatch.setenv("GIT_INDEX_FILE", str(decoy / ".git" / "index"))
    repo = isolated_git
    git(repo, "init", "-q")
    (repo / "a.txt").write_text("one\n")
    git(repo, "add", "a.txt")
    git(repo, "commit", "-q", "-m", "Initial")
    assert (repo / ".git" / "HEAD").is_file()
    assert git(repo, "rev-parse", "--absolute-git-dir") == f"{(repo / '.git').resolve()}\n"
    assert git(repo, "log", "--format=%s") == "Initial\n"
    monkeypatch.delenv("GIT_DIR")
    monkeypatch.delenv("GIT_INDEX_FILE")
    decoy_log = subprocess.run(
        ["git", "-C", str(decoy), "rev-parse", "--verify", "HEAD"], capture_output=True, check=False
    )
    assert decoy_log.returncode != 0
    assert not (decoy / ".git" / "index").exists()
