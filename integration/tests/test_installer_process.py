"""Offline subprocess regressions for the real installer acceptance's marker wait.

References:
- https://docs.python.org/3/library/selectors.html
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from typing import TYPE_CHECKING

import pytest

from scenarios.installer.test_installer import kill_at_marker

if TYPE_CHECKING:
    from pathlib import Path


@pytest.mark.parametrize(
    ("script", "message"),
    [
        ("import time; time.sleep(60)", "Timed out"),
        ("import sys,time; sys.stdout.write('partial'); sys.stdout.flush(); time.sleep(60)", "Timed out"),
        ("print('no marker')", "Child exited"),
        ("import os,time;\nwhile True: os.write(1, b'x' * 65536)", "exceeded one MiB"),
    ],
)
def test_marker_failures_are_bounded_and_reaped(script: str, message: str) -> None:
    """Silent, partial-line, EOF and flooding children cannot hang marker detection."""
    process = subprocess.Popen(
        [sys.executable, "-c", script], stdout=subprocess.PIPE, text=True, start_new_session=True
    )
    started = time.monotonic()
    with pytest.raises(AssertionError, match=message):
        kill_at_marker(process, "MARKER", 0.5)
    assert time.monotonic() - started < 5
    assert process.returncode is not None
    assert process.stdout is not None
    assert process.stdout.closed


@pytest.mark.parametrize("leader_exits", [False, True])
def test_marker_wait_kills_descendants_even_after_leader_exit(tmp_path: Path, leader_exits: bool) -> None:
    """A descendant retaining stdout is killed on success and on marker timeout."""
    pidfile = tmp_path / "descendant"
    child = "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"
    script = (
        "import pathlib,subprocess,sys,time; "
        f"child = subprocess.Popen([sys.executable, '-c', {child!r}]); "
        f"pathlib.Path({str(pidfile)!r}).write_text(str(child.pid)); "
        + ("sys.exit(0)" if leader_exits else "print('MARKER', flush=True); time.sleep(60)")
    )
    process = subprocess.Popen(
        [sys.executable, "-c", script], stdout=subprocess.PIPE, text=True, start_new_session=True
    )
    if leader_exits:
        with pytest.raises(AssertionError, match="Timed out"):
            kill_at_marker(process, "MARKER", 1)
    else:
        assert "MARKER" in kill_at_marker(process, "MARKER", 3)
        assert process.returncode == -signal.SIGKILL
    assert process.returncode is not None
    pid = int(pidfile.read_text())
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.01)
    else:
        pytest.fail(f"Descendant '{pid}' survived group cleanup")
