"""A git clone with one of every working-tree state, for scenarios that need a real diff to review."""

from __future__ import annotations

import subprocess
from typing import TYPE_CHECKING

from harness.paths import GIT_BIN

if TYPE_CHECKING:
    from pathlib import Path

GIT_IDENTITY = [
    "-c",
    "user.name=h",
    "-c",
    "user.email=h@h",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "init.defaultBranch=main",
]


def git(cwd: Path, *args: str) -> str:
    """Run git in `cwd` with a fixed identity and no signing.

    Parameters:
        cwd (Path): repository directory.
        *args (str): git arguments.

    Returns:
        str: stdout.
    """
    return subprocess.check_output([GIT_BIN, *GIT_IDENTITY, *args], cwd=cwd, text=True)


def make_git_fixture(root: Path) -> tuple[Path, Path]:
    """Create a clone with a bare remote and one of every working-tree state.

    Parameters:
        root (Path): directory to create under.

    Returns:
        tuple[Path, Path]: (repo, bare remote).
    """
    remote = root / "remote.git"
    repo = root / "repo"
    subprocess.check_call([GIT_BIN, "init", "-q", "--bare", "-b", "main", str(remote)])
    subprocess.check_call([GIT_BIN, *GIT_IDENTITY, "clone", "-q", str(remote), str(repo)])
    for key, value in (("user.name", "h"), ("user.email", "h@h"), ("commit.gpgsign", "false")):
        git(repo, "config", key, value)
    (repo / "a.txt").write_text("one\n")
    (repo / "b.txt").write_text("b\n")
    (repo / "old.txt").write_text("same\n")
    git(repo, "add", "a.txt", "b.txt", "old.txt")
    git(repo, "commit", "-q", "-m", "Initial")
    git(repo, "push", "-q", "-u", "origin", "main")
    (repo / "a.txt").write_text("one\ntwo\n")
    (repo / "c.txt").write_text("c\n")
    (repo / "spaced name.txt").write_text("n\n")
    git(repo, "mv", "old.txt", "renamed.txt")
    git(repo, "add", "c.txt")
    return repo, remote
