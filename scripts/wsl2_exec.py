"""Shared process plumbing for the guest-side scripts that replaced inline Bash (#695).

`install_gh_linux.py`, `install_wsl_owned_tools.py` and `wsl2_run.py` run on the WSL guest's system `python3`
(3.12) before any uv environment exists, so this module is standard library only. Commands are resolved
through `PATH` on purpose: the CI fixtures stub them.

References:
    https://docs.python.org/3/library/subprocess.html
    https://www.gnu.org/software/bash/manual/html_node/Exit-Status.html
"""

from __future__ import annotations

import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from types import FrameType

Runner = Callable[..., subprocess.CompletedProcess[str]]


def terminate(signum: int, _frame: FrameType | None) -> None:
    """Turn a signal into `SystemExit(128 + signum)` so cleanup runs, like a Bash `trap ... EXIT`.

    Parameters:
        signum (int): The delivered signal number.
        _frame (FrameType | None): Interrupted frame, unused.

    Raises:
        SystemExit: Always, with the conventional shell status for death by signal (143 for SIGTERM).
    """
    raise SystemExit(128 + signum)


def run_command(
    cmd: Sequence[str],
    run: Runner,
    *,
    stdin: str | None = None,
    capture: bool = False,
    env: Mapping[str, str] | None = None,
) -> tuple[int, str]:
    """Run one command without raising on a non-zero exit.

    Parameters:
        cmd (Sequence[str]): Argument vector, resolved through `PATH` (the child's `env` when given).
        run (Runner): `subprocess.run`-compatible callable.
        stdin (str | None): Text fed to the command's standard input.
        capture (bool): Return standard output instead of passing it through.
        env (Mapping[str, str] | None): Complete child environment; `None` inherits the current one.

    Returns:
        tuple[int, str]: Exit status (127 when the command cannot be started, like a shell; 128 plus the
            signal number when it died by a signal) and captured standard output (empty unless `capture`).
    """
    try:
        completed = run(
            list(cmd),
            input=stdin,
            text=True,
            check=False,
            stdout=subprocess.PIPE if capture else None,
            env=None if env is None else dict(env),
        )
    except OSError as exc:
        sys.stderr.write(f"{cmd[0]}: {exc.strerror or exc}\n")
        return 127, ""
    status = completed.returncode
    return (128 - status if status < 0 else status), (completed.stdout if capture else "")
