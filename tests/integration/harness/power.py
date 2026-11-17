"""Keep macOS awake while pytest owns detached TUI children.

Dark wake permits work but repeatedly suspends the host, contaminating latency and startup
measurements. Assertions are process-scoped, never changes to persistent power settings.

References:
- caffeinate(8): https://keith.github.io/xcode-man-pages/caffeinate.8.html
"""

from __future__ import annotations

import os
import subprocess
import sys
from contextlib import contextmanager
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterator

CAFFEINATE = "/usr/bin/caffeinate"
STOP_TIMEOUT_S = 5


@contextmanager
def keep_awake() -> Iterator[None]:
    """Hold wake assertions for this scope on macOS; no-op on other hosts.

    `-w` releases assertions even if pytest is killed before its finalizers run. `-u` promotes
    an existing dark wake, while `-d`, `-i`, and `-s` prevent returning to idle sleep on AC.

    Yields:
        None: tests may launch their children.

    Raises:
        OSError: the native assertion helper cannot be launched.
    """
    if sys.platform != "darwin":
        yield
        return
    process = subprocess.Popen(
        [CAFFEINATE, "-disu", "-w", str(os.getpid())],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        yield
    finally:
        process.terminate()
        try:
            process.wait(timeout=STOP_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=STOP_TIMEOUT_S)
