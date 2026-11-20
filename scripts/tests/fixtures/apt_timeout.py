"""Enforce apt fixture subprocess deadlines without requiring GNU coreutils.

References:
    https://www.gnu.org/software/coreutils/manual/html_node/timeout-invocation.html
"""

from __future__ import annotations

import contextlib
import os
import signal
import subprocess
import sys
from pathlib import Path


def hold_capture() -> None:
    """Start a detached holder of the hung command's stdout and stderr."""
    holder = subprocess.Popen(["/bin/sleep", "86400"], start_new_session=True)
    Path(os.environ["APT_FIXTURE_CHILD_PID"]).write_text(str(holder.pid))


def replay() -> int:
    """Run real tee after timeout, surfacing a would-block read instead of hanging pytest."""
    gate = int(os.environ["APT_FIXTURE_REPLAY_FD"])
    assert os.read(gate, 1) == b"1"
    os.set_blocking(sys.stdin.fileno(), False)
    return subprocess.call(["/usr/bin/tee", *sys.argv[2:]])


def start_command() -> subprocess.Popen[bytes]:
    """Start apt and wait for the optional hung command to arm its descendant."""
    argv = sys.argv[3:]
    if "APT_FIXTURE_CHILD_PID" not in os.environ:
        return subprocess.Popen(argv, start_new_session=True)
    reader, writer = os.pipe()
    try:
        try:
            process = subprocess.Popen(
                argv,
                start_new_session=True,
                pass_fds=(writer,),
                env=os.environ | {"APT_FIXTURE_READY_FD": str(writer)},
            )
        finally:
            os.close(writer)
        # Only the command inherits the writer. It closes it after setup, or on failure.
        assert os.read(reader, 1) == b""
    finally:
        os.close(reader)
    return process


def main() -> int:
    """Run the fixture command with the timeout subset used by the apt scripts.

    Returns:
        int: The command status, 124 on timeout, or 137 when escalated to SIGKILL.
    """
    option, grace = sys.argv[1].split("=", 1)
    assert option == "--kill-after"
    seconds = float(sys.argv[2])
    process = start_command()
    try:
        return process.wait(timeout=seconds)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=float(grace))
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            return 137
        return 124


if sys.argv[1] == "hold-capture":
    hold_capture()
    sys.exit(0)
if sys.argv[1] == "replay":
    sys.exit(replay())
try:
    status = main()
finally:
    if (gate := os.environ.get("APT_FIXTURE_SIGNAL_FD")) is not None:
        os.write(int(gate), b"1")
sys.exit(status)
