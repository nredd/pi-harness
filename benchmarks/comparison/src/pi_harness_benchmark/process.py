"""Safe subprocess and filesystem helpers.

References:
- https://docs.python.org/3/library/subprocess.html
- https://docs.python.org/3/library/pathlib.html
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


class CommandError(RuntimeError):
    """A required local command failed."""


def executable(name: str) -> Path:
    """Resolve a required executable to an absolute path.

    Parameters:
        name (str): Executable basename.

    Returns:
        Path: Absolute executable path.

    Raises:
        FileNotFoundError: If the executable is unavailable.
    """
    if not name or "/" in name:
        msg = f"Executable name must be a basename: '{name}'"
        raise ValueError(msg)
    found = shutil.which(name)
    if found is None:
        msg = f"Required executable is not on PATH: '{name}'"
        raise FileNotFoundError(msg)
    return Path(found).resolve()


def output(args: list[str], *, cwd: Path | None = None) -> str:
    """Run a command and return combined text output.

    Parameters:
        args (list[str]): Absolute-binary argument vector.
        cwd (Path | None): Optional working directory.

    Returns:
        str: Combined stdout and stderr.

    Raises:
        ValueError: If the argument vector is empty or the binary is relative.
        CommandError: If the command exits unsuccessfully.
    """
    if not args:
        msg = "Command argument vector cannot be empty"
        raise ValueError(msg)
    if not Path(args[0]).is_absolute():
        msg = f"Command binary must be absolute: '{args[0]}'"
        raise ValueError(msg)
    try:
        return subprocess.check_output(
            args,
            cwd=cwd,
            text=True,
            stderr=subprocess.STDOUT,
        )
    except subprocess.CalledProcessError as exc:
        command_output = exc.output.strip()
        msg = f"Command failed with exit code {exc.returncode}: '{args[0]}'\n{command_output}"
        raise CommandError(msg) from exc
