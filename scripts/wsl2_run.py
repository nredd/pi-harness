"""Shared guest execution boundary: run one host-generated CI step inside the WSL guest checkout.

GitHub control files stay Windows-visible; builds, caches, dependencies and tests remain on the Linux
filesystem. `wsl2_shell.ps1` starts `wsl2_run.sh`, a compatibility bootstrap, which execs this file so
`python-scripts` measures it. Standard library only: it runs on the guest's system `python3` (3.12).

Inputs (a missing one is a failure, never a default):
    HOME: the guest user's home; the checkout is `$HOME/pi-harness-ci`.
    WSL_STEP_SCRIPT: the generated step, possibly CRLF; it is copied, never modified.
    WSL_STEP_DIRECTORY: step working directory relative to the checkout.

The first ordinary-step failure status is retained in `$RUNNER_TEMP/first-failure`, including adapter
preflight failures and a SIGTERM (e.g. from `timeout`), which exits 143 after cleanup.

References:
    https://docs.github.com/actions/writing-workflows/workflow-syntax-for-github-actions#jobsjob_idstepsshell
    https://learn.microsoft.com/windows/wsl/basic-commands#run-a-specific-linux-distribution
"""

from __future__ import annotations

import contextlib
import os
import signal
import subprocess
import sys
import tempfile
from collections.abc import Mapping
from pathlib import Path

from wsl2_exec import Runner, run_command, terminate


class GuestError(Exception):
    """A refusal or preflight failure; its message is the whole diagnostic."""


def _require(env: Mapping[str, str], name: str) -> str:
    """Return a required environment value.

    Parameters:
        env (Mapping[str, str]): The adapter environment.
        name (str): Variable name.

    Returns:
        str: The value, possibly empty.

    Raises:
        GuestError: When the variable is unset.
    """
    try:
        return env[name]
    except KeyError as exc:
        raise GuestError(f"wsl2-run: `{name}` is not set") from exc


def _step_directory(worktree: Path, requested: str) -> None:
    """Enter the step directory, refusing anything that resolves outside the checkout.

    Parameters:
        worktree (Path): Physical (symlink-free) guest checkout.
        requested (str): `WSL_STEP_DIRECTORY`, relative to the checkout.

    Raises:
        GuestError: When the directory is unavailable or `..` or a symlink escapes the checkout.
    """
    try:
        os.chdir(worktree / requested)
    except OSError as exc:
        raise GuestError("Step directory escapes guest checkout or is unavailable") from exc
    if not Path.cwd().is_relative_to(worktree):
        raise GuestError("Step directory escapes guest checkout")


def _run_step(generated: bytes, env: dict[str, str], run: Runner) -> int:
    """Run the step from a private copy under Bash, removing the copy on every exit including SIGTERM.

    Parameters:
        generated (bytes): The step with CR stripped.
        env (dict[str, str]): The step's complete environment.
        run (Runner): `subprocess.run`-compatible callable.

    Returns:
        int: The step's status (128 plus the signal number when it died by a signal).
    """
    descriptor, name = tempfile.mkstemp(prefix="step.", dir=env["RUNNER_TEMP"])
    step = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(generated)
        return run_command(["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", name], run, env=env)[0]
    finally:
        with contextlib.suppress(OSError):
            step.unlink(missing_ok=True)


def _execute(env: dict[str, str], run: Runner) -> int:
    """Check the preconditions, then run the step under Bash exactly as GitHub's native shell would.

    Parameters:
        env (dict[str, str]): The adapter environment; becomes the step's environment.
        run (Runner): `subprocess.run`-compatible callable.

    Returns:
        int: The step's status (128 plus the signal number when it died by a signal).

    Raises:
        GuestError: When a precondition fails.
    """
    runner_temp = env["RUNNER_TEMP"]
    if run_command(["id", "-u"], run, capture=True)[1].strip() == "0":
        raise GuestError("WSL gates require an unprivileged Linux user")
    receipt = Path(runner_temp, "tool-path")
    if not receipt.is_file() or not receipt.stat().st_size:
        raise GuestError(f"wsl2-run: `tool-path` receipt '{receipt}' is missing or empty")
    env["PATH"] = receipt.read_text(encoding="utf-8", errors="surrogateescape").rstrip("\n")
    checkout = Path(env["HOME"], "pi-harness-ci")
    env["GITHUB_WORKSPACE"] = str(checkout)
    # Resolve physical paths so '..', nested traversal and symlinks cannot escape.
    _step_directory(checkout.resolve(), _require(env, "WSL_STEP_DIRECTORY"))
    # Do not modify the host-generated step; CRLF is possible even with an LF checkout.
    generated = Path(_require(env, "WSL_STEP_SCRIPT")).read_bytes().replace(b"\r", b"")
    status = _run_step(generated, env, run)
    if status:
        sys.stderr.write(f"wsl2-run: guest-step failed with status {status}\n")
    return status


def _retain(status: int, runner_temp: str) -> None:
    """Keep the first failure status; recording it is best effort and never masks the real status.

    Parameters:
        status (int): The adapter's exit status.
        runner_temp (str): Guest `RUNNER_TEMP`.
    """
    first = Path(runner_temp, "first-failure")
    with contextlib.suppress(OSError):
        if status and not first.is_file():
            first.write_text(f"{status}\n", encoding="utf-8")


def main(run: Runner = subprocess.run, environ: Mapping[str, str] | None = None) -> int:
    """Run the host-generated step in the guest checkout, retaining the first failure status.

    Parameters:
        run (Runner): `subprocess.run`-compatible callable, injected by tests.
        environ (Mapping[str, str] | None): Adapter environment; defaults to `os.environ`.

    Returns:
        int: 0 when the step passed, else its status (1 for a refusal or preflight failure). SIGTERM exits 143
            after the first-failure record and step cleanup, like the old Bash `trap ... EXIT`.

    Raises:
        SystemExit: On SIGTERM, with status 143, after cleanup.
    """
    signal.signal(signal.SIGTERM, terminate)
    env = dict(os.environ if environ is None else environ)
    try:
        env["RUNNER_TEMP"] = f"{_require(env, 'HOME')}/pi-harness-ci/.ci-temp"
    except GuestError as exc:
        sys.stderr.write(f"{exc}\n")
        return 1
    status = 1
    try:
        status = _execute(env, run)
    except GuestError as exc:
        sys.stderr.write(f"{exc}\n")
    except OSError as exc:
        sys.stderr.write(f"wsl2-run: {exc}\n")
    except SystemExit as exc:
        status = int(exc.code or 0)
        raise
    finally:
        _retain(status, env["RUNNER_TEMP"])
    return status


if __name__ == "__main__":
    sys.exit(main())
