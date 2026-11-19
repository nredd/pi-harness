"""Bound WSL fixture subprocesses without requiring GNU coreutils on macOS.

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
    """Run the fixture command with the timeout subset used by WSL scripts.

    Returns:
        int: The command status, or 124 when the deadline expires.
    """
    seconds = float(sys.argv[2])
    process = subprocess.Popen(sys.argv[3:], start_new_session=True)
    try:
        return process.wait(timeout=seconds)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        return 124


if __name__ == "__main__":
    sys.exit(main())
