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


def hang_with_capture() -> None:
    """Leave a grandchild outside the timeout group holding apt's stdout and stderr."""
    ready = int(os.environ["APT_FIXTURE_READY_FD"])
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    os.write(sys.stdout.fileno(), b"apt stdout\n")
    os.write(sys.stderr.fileno(), b"apt stderr\n")
    if os.fork() == 0:
        os.setsid()
        Path(os.environ["APT_FIXTURE_CHILD_PID"]).write_text(str(os.getpid()))
        os.write(ready, b"1")
        os.close(ready)
        signal.pause()
        os._exit(0)
    os.close(ready)
    signal.pause()


def replay() -> None:
    """Run real tee after timeout, surfacing a would-block read instead of hanging pytest."""
    gate = int(os.environ["APT_FIXTURE_REPLAY_FD"])
    assert os.read(gate, 1) == b"1"
    os.set_blocking(sys.stdin.fileno(), False)
    os.execv("/usr/bin/tee", ["tee", *sys.argv[2:]])


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
        # EOF also releases the wait if the command failed before forking.
        os.read(reader, 1)
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


if sys.argv[1] == "hang-with-capture":
    hang_with_capture()
    sys.exit(0)
if sys.argv[1] == "replay":
    replay()
    sys.exit(0)
try:
    status = main()
finally:
    if (gate := os.environ.get("APT_FIXTURE_SIGNAL_FD")) is not None:
        os.write(int(gate), b"1")
sys.exit(status)
