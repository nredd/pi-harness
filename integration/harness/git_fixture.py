"""Run git with a fixed throwaway identity, for scenarios that need a real repository.

References:
    https://git-scm.com/docs/git (`-c <name>=<value>`)
"""

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
        str: stdout and stderr, merged so a failure carries git's diagnostics.
    """
    return subprocess.check_output(
        [GIT_BIN, *GIT_IDENTITY, *args], cwd=cwd, text=True, stderr=subprocess.STDOUT
    )
