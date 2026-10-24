"""Offline subprocess regressions for the real installer acceptance's marker wait.

References:
- https://docs.python.org/3/library/selectors.html
"""

from __future__ import annotations

import os
import selectors
import signal
import subprocess
import sys
import time
from contextlib import suppress
from typing import TYPE_CHECKING

import pytest

from harness.install import remove
from scenarios.installer import test_installer as installer
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


def test_cleanup_keeps_leader_unreaped_until_group_quiescence(monkeypatch: pytest.MonkeyPatch) -> None:
    """A zombie leader reserves the numeric PGID until the final owned-group signal."""
    process = subprocess.Popen(
        [sys.executable, "-c", "print('MARKER',flush=True); import time; time.sleep(60)"],
        stdout=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    wait = process.wait
    checks = 0

    def live_members(pgid: int, timeout: float) -> bool:
        """Force a second signal after the leader exits, without reaping it."""
        nonlocal checks
        assert pgid == process.pid
        assert timeout > 0
        checks += 1
        return checks == 1

    def owned_wait(timeout: float | None = None) -> int:
        """Reject any reap before all scoped signalling has finished."""
        assert checks >= 2, "Leader reaped before group quiescence"
        return wait(timeout=timeout)

    def no_poll() -> int | None:
        """Polling is also a waitpid and would release the ownership anchor."""
        pytest.fail("Leader polled before group quiescence")

    try:
        with monkeypatch.context() as patch:
            patch.setattr(installer, "group_has_live_members", live_members)
            patch.setattr(process, "wait", owned_wait)
            patch.setattr(process, "poll", no_poll)
            kill_at_marker(process, "MARKER", 3)
        assert checks == 2
        assert process.returncode == -signal.SIGKILL
    finally:
        # This fixture has no descendants; the direct child is still owned until wait.
        process.kill()
        wait(timeout=3)


@pytest.mark.parametrize("failure", ["permission", "process-table", "reap"])
def test_cleanup_preserves_marker_and_cleanup_errors(monkeypatch: pytest.MonkeyPatch, failure: str) -> None:
    """A cleanup failure reports both errors, with the marker failure first."""
    process = subprocess.Popen(
        [sys.executable, "-c", "print('no marker')"],
        stdout=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    error = PermissionError("live group denied") if failure == "permission" else OSError(failure)
    wait = process.wait

    def failed_reap(timeout: float | None = None) -> int:
        """Retain a final reap diagnostic without leaving the fixture alive."""
        wait(timeout=timeout)
        raise error

    def denied(pgid: int, sig: int) -> None:
        """Inject a live-group permission failure without signalling another group."""
        assert pgid == process.pid
        assert sig == signal.SIGKILL
        raise error

    def live_members(pgid: int, timeout: float) -> bool:
        """Inject a process-table failure or an observable live member."""
        assert pgid == process.pid
        assert timeout > 0
        if failure == "process-table":
            raise error
        return failure == "permission"

    try:
        with monkeypatch.context() as patch:
            patch.setattr(installer, "group_has_live_members", live_members)
            if failure == "reap":
                patch.setattr(process, "wait", failed_reap)
            if failure == "permission":
                patch.setattr(os, "killpg", denied)
            with pytest.raises(BaseExceptionGroup) as caught:
                kill_at_marker(process, "MARKER", 3)
        primary, cleanup = caught.value.exceptions
        assert isinstance(primary, AssertionError)
        assert "Child exited" in str(primary)
        assert cleanup is error
        assert process.returncode is not None
        assert process.stdout is not None
        assert process.stdout.closed
    finally:
        process.kill()
        process.wait(timeout=3)


def test_group_cleanup_deadline_is_shared_and_reaps(monkeypatch: pytest.MonkeyPatch) -> None:
    """A persistently live snapshot fails closed without extending the cleanup deadline."""
    process = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(60)"],
        stdout=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    started = time.monotonic()
    killpg = os.killpg
    signalled = False

    def signal_once(pgid: int, sig: int) -> None:
        """Kill the fixture, then model successful delivery despite a stale live snapshot."""
        nonlocal signalled
        if not signalled:
            killpg(pgid, sig)
            signalled = True

    try:
        monkeypatch.setattr(os, "killpg", signal_once)
        monkeypatch.setattr(installer, "group_has_live_members", lambda pgid, timeout: True)
        with pytest.raises(AssertionError, match="survived cleanup"):
            installer.cleanup_group(process, timeout=0.1)
        assert time.monotonic() - started < 3
        assert process.returncode == -signal.SIGKILL
        assert process.stdout is not None
        assert process.stdout.closed
    finally:
        process.kill()
        process.wait(timeout=3)


def read_ack(descriptor: int, timeout: float) -> bytes:
    """Read a bounded writer acknowledgement, or EOF once every writer has exited."""
    with selectors.DefaultSelector() as selector:
        selector.register(descriptor, selectors.EVENT_READ)
        assert selector.select(timeout), "Writer pipe did not quiesce within its hard lifetime"
        return os.read(descriptor, 4096)


def fork_writer_trial(staging: Path) -> None:
    """Run one race in an external supervisor; cleanup does not trust the tested helper.

    EOF releases blocked writers even on assertion failure. Their independent
    leader/per-fork alarms also bound writer startup and broken-helper paths. No fallback
    signals a potentially recycled numeric PID/PGID. Pipe EOF proves every writer
    closed its descriptor before this supervisor reaps its direct child.
    """
    staging.mkdir(parents=True)
    request_read, request_write = os.pipe()
    ack_read, ack_write = os.pipe()
    process: subprocess.Popen[str] | None = None
    script = (
        "import signal; signal.alarm(8); import os,pathlib; print('MARKER',flush=True)\n"
        "for _ in range(32):\n"
        " if os.fork() == 0:\n"
        "  signal.alarm(8)\n"
        f"  if os.read({request_read},1):\n"
        f"   pathlib.Path({str(staging / 'surviving-writer')!r}).touch()\n"
        f"   os.write({ack_write},f'writer pid={{os.getpid()}} pgid={{os.getpgrp()}}'.encode())\n"
        "  os._exit(0)\n"
        "signal.pause()\n"
    )
    try:
        process = subprocess.Popen(
            [sys.executable, "-c", script],
            stdout=subprocess.PIPE,
            text=True,
            start_new_session=True,
            pass_fds=(request_read, ack_write),
        )
    finally:
        os.close(request_read)
        os.close(ack_write)
        if process is None:
            os.close(request_write)
            os.close(ack_read)
    try:
        kill_at_marker(process, "MARKER", 3)
        with suppress(BrokenPipeError):
            os.write(request_write, b"x")
        response = read_ack(ack_read, 3)
        assert not response, f"Concurrent staging {response.decode()} survived group cleanup"
        remove(staging.parent.parent.parent)
        assert not staging.exists()
    finally:
        os.close(request_write)
        try:
            deadline = time.monotonic() + 10
            while read_ack(ack_read, max(deadline - time.monotonic(), 0)):
                assert time.monotonic() < deadline, "Writers exceeded their hard lifetime"
        finally:
            os.close(ack_read)
            try:
                process.wait(timeout=10)
            finally:
                assert process.stdout is not None
                process.stdout.close()


def test_marker_cleanup_quiesces_children_forked_during_group_signal(tmp_path: Path) -> None:
    """An externally bounded race requests a real write only AFTER cleanup returns."""
    for attempt in range(16):
        staging = tmp_path / str(attempt) / "agent" / "npm" / "node_modules"
        supervisor = (
            "import pathlib,runpy; "
            f"runpy.run_path({__file__!r})['fork_writer_trial'](pathlib.Path({str(staging)!r}))"
        )
        result = subprocess.run(
            [sys.executable, "-c", supervisor], capture_output=True, text=True, timeout=25, check=False
        )
        assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize("signal_once", [False, True])
def test_writer_supervisor_bounds_broken_helper(tmp_path: Path, signal_once: bool) -> None:
    """Both pre-signal failure and the original one-signal bug leave no live writers."""
    supervisor = (
        "import os,pathlib,runpy,signal; "
        f"ns=runpy.run_path({__file__!r})\n"
        "def broken(process,marker,timeout):\n"
        + (
            " process.stdout.readline(); os.killpg(process.pid,signal.SIGKILL); process.wait(timeout=3)\n"
            if signal_once
            else ""
        )
        + " raise RuntimeError('injected helper failure')\n"
        "ns['fork_writer_trial'].__globals__['kill_at_marker']=broken\n"
        "try:\n"
        f" ns['fork_writer_trial'](pathlib.Path({str(tmp_path / 'staging')!r}))\n"
        "except RuntimeError as error:\n"
        " assert str(error)=='injected helper failure'\n"
        "else:\n"
        " raise AssertionError('helper did not fail')\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", supervisor], capture_output=True, text=True, timeout=25, check=False
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_writer_supervisor_closes_pipes_when_spawn_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failed exec cannot bypass pipe cleanup or leave a startup child behind."""
    pipe = os.pipe
    descriptors: list[int] = []

    def tracked_pipe() -> tuple[int, int]:
        """Record the descriptors whose ownership transfers to the supervisor."""
        pair = pipe()
        descriptors.extend(pair)
        return pair

    def failed_spawn(*args: object, **kwargs: object) -> subprocess.Popen[str]:
        """Model Popen's failed-exec path, which already reaps its startup child."""
        raise OSError("injected exec failure")

    monkeypatch.setattr(os, "pipe", tracked_pipe)
    monkeypatch.setattr(subprocess, "Popen", failed_spawn)
    with pytest.raises(OSError, match="injected exec failure"):
        fork_writer_trial(tmp_path / "staging")
    assert len(descriptors) == 4
    for descriptor in descriptors:
        with pytest.raises(OSError, match="Bad file descriptor"):
            os.fstat(descriptor)


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
