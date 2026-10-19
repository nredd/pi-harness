"""Pipe/deadline infrastructure tests use only tiny Python children, never Pi or scenarios.

References:
- https://docs.python.org/3/library/subprocess.html#subprocess.Popen
"""

from __future__ import annotations

import sys
from typing import TYPE_CHECKING

import pytest

from harness import headless
from harness.sandbox import build_sandbox

if TYPE_CHECKING:
    from pathlib import Path


def test_both_pipes_are_drained_without_a_deadlock(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Drain stderr exceeding pipe capacity while still decoding stdout events.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): replace Pi with a Python pipe writer.
        tmp_path (Path): isolated sandbox root.
    """
    program = 'import sys; sys.stderr.write("e"*200000); print(\'{"type":"ready"}\'); sys.stderr.flush()'
    monkeypatch.setattr(headless, "pi_command", lambda: [sys.executable, "-c", program])
    result = headless.run_headless(build_sandbox(tmp_path / "box"), {}, [], timeout_s=10)
    assert result.returncode == 0
    assert len(result.stderr) == 200000
    assert len(result.of_type("ready")) == 1


def test_silent_stdout_still_has_a_hard_deadline(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Enforce a wall-clock deadline even when stdout never becomes readable.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): substitute a silent Python child.
        tmp_path (Path): isolated sandbox root.
    """
    monkeypatch.setattr(headless, "pi_command", lambda: [sys.executable, "-c", "import time; time.sleep(30)"])
    with pytest.raises(TimeoutError, match="deadline"):
        headless.run_headless(build_sandbox(tmp_path / "box"), {}, [], timeout_s=0.1)


def test_exited_leader_cannot_leave_a_pipe_reader_hung(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Reap descendants holding inherited pipes after their leader exits.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): substitute a Python child spawning a descendant.
        tmp_path (Path): isolated sandbox root.
    """
    program = 'import subprocess,sys; subprocess.Popen([sys.executable,"-c","import time; time.sleep(30)"])'
    monkeypatch.setattr(headless, "pi_command", lambda: [sys.executable, "-c", program])
    with pytest.raises(TimeoutError, match="deadline"):
        headless.run_headless(build_sandbox(tmp_path / "box"), {}, [], timeout_s=0.1)


@pytest.mark.parametrize("pipe", ["stdout", "stderr"])
def test_output_is_bounded(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, pipe: str) -> None:
    """Refuse either output stream exceeding the capture budget.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): substitute a Python writer and small output limit.
        tmp_path (Path): isolated sandbox root.
        pipe (str): stdout or stderr to overflow.
    """
    monkeypatch.setattr(headless, "MAX_OUTPUT_BYTES", 4096)
    monkeypatch.setattr(
        headless, "pi_command", lambda: [sys.executable, "-c", f'import sys; sys.{pipe}.write("x"*8192)']
    )
    with pytest.raises(RuntimeError, match="output bytes"):
        headless.run_headless(build_sandbox(tmp_path / "box"), {}, [], timeout_s=10)
