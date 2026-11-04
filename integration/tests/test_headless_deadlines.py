"""Pipe/deadline infrastructure tests use only tiny Python children, never Pi or scenarios.

References:
- https://docs.python.org/3/library/subprocess.html#subprocess.Popen
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
from typing import TYPE_CHECKING

import pytest

from harness import headless, process_group
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


def spawn_session(program: str) -> subprocess.Popen[str]:
    """Start a tiny Python child as its own session leader, as `run_headless` does.

    Parameters:
        program (str): Python source for the child.

    Returns:
        subprocess.Popen[str]: unreaped child with captured pipes.
    """
    return subprocess.Popen(
        [sys.executable, "-c", program],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL,
        text=True,
        start_new_session=True,
    )


def deny_owned_group(
    monkeypatch: pytest.MonkeyPatch, process: subprocess.Popen[str], *, live: bool
) -> tuple[list[tuple[int, int]], list[int]]:
    """Inject a macOS `EPERM` from `killpg` and a process-table verdict, never signalling anything.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): installs the recording seams.
        process (subprocess.Popen[str]): the owned session leader; any other group fails the test.
        live (bool): whether the injected listing shows a live member.

    Returns:
        tuple[list[tuple[int, int]], list[int]]: recorded `(pgid, signal)` calls and listed groups.
    """
    signalled: list[tuple[int, int]] = []
    listed: list[int] = []

    def denied(pgid: int, sig: int) -> None:
        """Record the owned-group signal and refuse it like an unreaped Darwin session.

        Parameters:
            pgid (int): process group to signal.
            sig (int): signal to send.

        Raises:
            PermissionError: always, as Darwin answers a zombie-only group.
        """
        assert pgid == process.pid
        signalled.append((pgid, sig))
        raise PermissionError(1, "Operation not permitted")

    def listing(pgid: int, timeout: float) -> bool:
        """Record the owned-group listing and return the injected verdict.

        Parameters:
            pgid (int): process group to list.
            timeout (float): listing bound.

        Returns:
            bool: the injected liveness.
        """
        assert pgid == process.pid
        assert timeout > 0
        listed.append(pgid)
        return live

    monkeypatch.setattr(os, "killpg", denied)
    monkeypatch.setattr(headless, "group_has_live_members", listing)
    return signalled, listed


@pytest.mark.parametrize("pipe", ["stdout", "stderr"])
def test_overflow_reader_survives_a_zombie_only_group(monkeypatch: pytest.MonkeyPatch, pipe: str) -> None:
    """An `EPERM` from an exited, unreaped leader's group must not kill the overflowing reader (#357).

    Parameters:
        monkeypatch (pytest.MonkeyPatch): small output limit, recording `killpg`, thread hook.
        pipe (str): stdout or stderr to overflow.
    """
    monkeypatch.setattr(headless, "MAX_OUTPUT_BYTES", 4096)
    died: list[BaseException | None] = []
    monkeypatch.setattr(threading, "excepthook", lambda args: died.append(args.exc_value))
    process = spawn_session(f'import sys; sys.{pipe}.write("x"*8192)')
    try:
        signalled, listed = deny_owned_group(monkeypatch, process, live=False)
        with pytest.raises(RuntimeError, match="output bytes"):
            headless.collect_json_process(process, ["overflow"], time.monotonic(), 10)
        assert died == []
        assert signalled == [(process.pid, signal.SIGKILL)]
        assert listed == [process.pid]
    finally:
        process.wait(timeout=10)


def test_deadline_kill_survives_a_zombie_only_group(monkeypatch: pytest.MonkeyPatch) -> None:
    """The deadline path still reports a timeout, not the `EPERM`, for a zombie-only group (#357).

    Parameters:
        monkeypatch (pytest.MonkeyPatch): recording `killpg` and listing seams.
    """
    process = spawn_session("import time; time.sleep(0.5)")
    try:
        signalled, listed = deny_owned_group(monkeypatch, process, live=False)
        with pytest.raises(TimeoutError, match="deadline"):
            headless.collect_json_process(process, ["silent"], time.monotonic(), 0.1)
        assert signalled == [(process.pid, signal.SIGKILL)]
        assert listed == [process.pid]
    finally:
        process.wait(timeout=10)


def test_permission_denied_with_a_live_member_still_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    """`EPERM` with a live member is a real permission failure and surfaces.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): recording `killpg` and listing seams.
    """
    process = spawn_session("pass")
    try:
        signalled, listed = deny_owned_group(monkeypatch, process, live=True)
        with pytest.raises(PermissionError):
            headless.kill_process_group(process.pid)
        assert signalled == [(process.pid, signal.SIGKILL)]
        assert listed == [process.pid]
    finally:
        process.communicate(timeout=10)


def test_vanished_group_needs_no_listing(monkeypatch: pytest.MonkeyPatch) -> None:
    """`ESRCH` already proves the group is gone, so no `/bin/ps` listing runs.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): recording `killpg` and a listing that must not run.
    """
    process = spawn_session("pass")
    signalled: list[tuple[int, int]] = []

    def vanished(pgid: int, sig: int) -> None:
        """Record the owned-group signal and answer as a reaped group.

        Parameters:
            pgid (int): process group to signal.
            sig (int): signal to send.

        Raises:
            ProcessLookupError: always.
        """
        assert pgid == process.pid
        signalled.append((pgid, sig))
        raise ProcessLookupError(3, "No such process")

    def unexpected(pgid: int, timeout: float) -> bool:
        """Fail if `ESRCH` is ever second-guessed.

        Parameters:
            pgid (int): process group to list.
            timeout (float): listing bound.

        Returns:
            bool: never returned.

        Raises:
            AssertionError: always.
        """
        raise AssertionError(f"listed {pgid} within {timeout}s after ESRCH")

    try:
        monkeypatch.setattr(os, "killpg", vanished)
        monkeypatch.setattr(headless, "group_has_live_members", unexpected)
        headless.kill_process_group(process.pid)
        assert signalled == [(process.pid, signal.SIGKILL)]
    finally:
        process.communicate(timeout=10)


def test_real_zombie_only_group_is_not_live_and_kill_tolerates_it() -> None:
    """A real, owned, exited but unreaped session leader lists as not live and is killed quietly.

    Only this test's own child group is ever signalled.
    """
    process = spawn_session("import time; time.sleep(30)")
    try:
        assert process.pid > 1
        assert process_group.group_has_live_members(process.pid, 5)
        process.kill()
        os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOWAIT)
        assert process.returncode is None
        assert not process_group.group_has_live_members(process.pid, 5)
        headless.kill_process_group(process.pid)
    finally:
        process.kill()
        process.communicate(timeout=10)
