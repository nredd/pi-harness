"""Run git with a fixed throwaway identity, for scenarios that need a real repository.

References:
    https://git-scm.com/docs/git (`-c <name>=<value>`, ENVIRONMENT VARIABLES)
"""

from __future__ import annotations

import os
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


def git_env() -> dict[str, str]:
    """Return the caller's environment without any inherited `GIT_*` and without user/system config.

    A hook or a parent git exports `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_WORK_TREE` and friends; inherited,
    they would point every fixture command at THAT repository instead of `cwd`.

    Returns:
        dict[str, str]: child environment for `git`.
    """
    scrubbed = {name: value for name, value in os.environ.items() if not name.startswith("GIT_")}
    return scrubbed | {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}


def git(cwd: Path, *args: str) -> str:
    """Run git in `cwd` with a fixed identity, no signing, and no inherited repository or config.

    Parameters:
        cwd (Path): repository directory.
        *args (str): git arguments.

    Returns:
        str: stdout and stderr, merged so a failure carries git's diagnostics.
    """
    return subprocess.check_output(
        [GIT_BIN, *GIT_IDENTITY, *args], cwd=cwd, env=git_env(), text=True, stderr=subprocess.STDOUT
    )
