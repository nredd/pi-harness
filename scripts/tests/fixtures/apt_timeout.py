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


def main() -> int:
    """Run the fixture command with the timeout subset used by the apt scripts.

    Returns:
        int: The command status, 124 on timeout, or 137 when escalated to SIGKILL.
    """
    option, grace = sys.argv[1].split("=", 1)
    assert option == "--kill-after"
    seconds = float(sys.argv[2])
    process = subprocess.Popen(sys.argv[3:], start_new_session=True)
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


sys.exit(main())
