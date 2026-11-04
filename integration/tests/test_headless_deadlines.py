"""Pipe/deadline infrastructure tests use only tiny Python children, never Pi or scenarios.

References:
- https://docs.python.org/3/library/subprocess.html#subprocess.Popen
"""

from __future__ import annotations

import errno
import os
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
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


def leader_is_unreaped(pid: int) -> bool:
    """Report whether `pid` is still this process's unreaped child, without reaping it.

    Parameters:
        pid (int): child process id.

    Returns:
        bool: the leader still anchors its process group number.
    """
    try:
        os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    except ChildProcessError:
        return False
    return True


@dataclass
class GroupSeams:
    """What the injected `killpg` and listing saw.

    Attributes:
        signalled (list[tuple[int, int]]): `(pgid, signal)` calls.
        anchored (list[bool]): per call, whether the leader was still unreaped.
        on_main (list[bool]): per call, whether the main thread sent it.
        listed (list[int]): listed groups.
    """

    signalled: list[tuple[int, int]] = field(default_factory=list)
    anchored: list[bool] = field(default_factory=list)
    on_main: list[bool] = field(default_factory=list)
    listed: list[int] = field(default_factory=list)


def record_owned_group(
    monkeypatch: pytest.MonkeyPatch,
    process: subprocess.Popen[str],
    *,
    deny: bool = True,
    listing: bool | Exception = False,
) -> GroupSeams:
    """Inject `killpg` and the process-table listing for one owned group, never signalling anything.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): installs the recording seams.
        process (subprocess.Popen[str]): the owned session leader; any other group fails the test.
        deny (bool): answer `EPERM` like an unreaped Darwin session instead of delivering.
        listing (bool | Exception): injected liveness, or the listing failure to raise.

    Returns:
        GroupSeams: what was signalled and listed.
    """
    seams = GroupSeams()

    def recorded(pgid: int, sig: int) -> None:
        """Record the owned-group signal and its anchoring, then refuse or pretend delivery.

        Parameters:
            pgid (int): process group to signal.
            sig (int): signal to send.

        Raises:
            PermissionError: when `deny` is set.
        """
        assert pgid == process.pid
        seams.signalled.append((pgid, sig))
        seams.anchored.append(leader_is_unreaped(pgid))
        seams.on_main.append(threading.current_thread() is threading.main_thread())
        if deny:
            raise PermissionError(1, "Operation not permitted")

    def listed(pgid: int, timeout: float) -> bool:
        """Record the owned-group listing and return or raise the injected verdict.

        Parameters:
            pgid (int): process group to list.
            timeout (float): listing bound.

        Returns:
            bool: the injected liveness.

        Raises:
            Exception: the injected listing failure.
        """
        assert pgid == process.pid
        assert timeout > 0
        seams.listed.append(pgid)
        if isinstance(listing, Exception):
            raise listing
        return listing

    monkeypatch.setattr(os, "killpg", recorded)
    monkeypatch.setattr(process_group, "group_has_live_members", listed)
    return seams


@pytest.fixture
def thread_deaths(monkeypatch: pytest.MonkeyPatch) -> list[BaseException | None]:
    """Collect exceptions that escape any thread instead of letting them vanish.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): replaces `threading.excepthook`.

    Returns:
        list[BaseException | None]: escaped exceptions.
    """
    died: list[BaseException | None] = []
    monkeypatch.setattr(threading, "excepthook", lambda args: died.append(args.exc_value))
    return died


LISTING_FAILURES = [
    subprocess.TimeoutExpired(["/bin/ps"], 5),
    subprocess.CalledProcessError(1, ["/bin/ps"]),
    FileNotFoundError(2, "No such file or directory", "/bin/ps"),
]


@pytest.mark.parametrize("pipe", ["stdout", "stderr"])
def test_overflow_reader_survives_a_zombie_only_group(
    monkeypatch: pytest.MonkeyPatch, thread_deaths: list[BaseException | None], pipe: str
) -> None:
    """An `EPERM` from an exited, unreaped leader's group must not kill the overflowing reader (#357).

    Parameters:
        monkeypatch (pytest.MonkeyPatch): small output limit and recording seams.
        thread_deaths (list[BaseException | None]): escaped thread exceptions.
        pipe (str): stdout or stderr to overflow.
    """
    monkeypatch.setattr(headless, "MAX_OUTPUT_BYTES", 4096)
    process = spawn_session(f'import sys; sys.{pipe}.write("x"*8192)')
    try:
        seams = record_owned_group(monkeypatch, process)
        with pytest.raises(RuntimeError, match="output bytes"):
            headless.collect_json_process(process, ["overflow"], time.monotonic(), 10)
        assert thread_deaths == []
        assert seams.signalled == [(process.pid, signal.SIGKILL)]
        assert seams.anchored == [True]
        assert seams.on_main == [True]
        assert seams.listed == [process.pid]
        assert process.returncode == 0
    finally:
        process.communicate(timeout=10)


@pytest.mark.parametrize("failure", LISTING_FAILURES, ids=type)
@pytest.mark.parametrize("pipe", ["stdout", "stderr"])
def test_overflow_with_a_failed_listing_surfaces_the_eperm(
    monkeypatch: pytest.MonkeyPatch, thread_deaths: list[BaseException | None], pipe: str, failure: Exception
) -> None:
    """A listing that cannot explain the `EPERM` never counts the group as gone and never dies in a reader.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): small output limit and recording seams.
        thread_deaths (list[BaseException | None]): escaped thread exceptions.
        pipe (str): stdout or stderr to overflow.
        failure (Exception): injected `/bin/ps` failure.
    """
    monkeypatch.setattr(headless, "MAX_OUTPUT_BYTES", 4096)
    process = spawn_session(f'import sys; sys.{pipe}.write("x"*8192)')
    try:
        seams = record_owned_group(monkeypatch, process, listing=failure)
        with pytest.raises(PermissionError) as caught:
            headless.collect_json_process(process, ["overflow"], time.monotonic(), 10)
        assert caught.value.__cause__ is failure
        assert thread_deaths == []
        assert seams.signalled == [(process.pid, signal.SIGKILL)]
        assert seams.anchored == [True]
        assert seams.on_main == [True]
    finally:
        process.communicate(timeout=10)


def test_deadline_kill_survives_a_zombie_only_group(monkeypatch: pytest.MonkeyPatch) -> None:
    """The deadline path still reports a timeout, not the `EPERM`, for a zombie-only group (#357).

    Parameters:
        monkeypatch (pytest.MonkeyPatch): recording seams.
    """
    process = spawn_session("import time; time.sleep(0.5)")
    try:
        seams = record_owned_group(monkeypatch, process)
        with pytest.raises(TimeoutError, match="deadline"):
            headless.collect_json_process(process, ["silent"], time.monotonic(), 0.1)
        assert seams.signalled == [(process.pid, signal.SIGKILL)]
        assert seams.anchored == [True]
        assert seams.listed == [process.pid]
    finally:
        process.communicate(timeout=10)


@pytest.mark.parametrize("failure", LISTING_FAILURES, ids=type)
def test_deadline_with_a_failed_listing_surfaces_the_eperm(
    monkeypatch: pytest.MonkeyPatch, failure: Exception
) -> None:
    """At the deadline, an unexplained `EPERM` surfaces chained to the listing failure.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): recording seams.
        failure (Exception): injected `/bin/ps` failure.
    """
    process = spawn_session("import time; time.sleep(0.5)")
    try:
        seams = record_owned_group(monkeypatch, process, listing=failure)
        with pytest.raises(PermissionError) as caught:
            headless.collect_json_process(process, ["silent"], time.monotonic(), 0.1)
        assert caught.value.__cause__ is failure
        assert seams.signalled == [(process.pid, signal.SIGKILL)]
    finally:
        process.communicate(timeout=10)


def test_inherited_pipe_kill_keeps_the_leader_as_pgid_anchor(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The reader-outlives-leader kill fires while the leader is unreaped, so its PGID cannot be reused.

    The leader exits at once; a descendant in its own session keeps stdout open past the deadline, then
    exits by itself. The recording `killpg` pretends delivery and signals nothing.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): recording seams.
        tmp_path (Path): descendant readiness marker.
    """
    ready = tmp_path / "ready"
    holder = f"import pathlib,time; pathlib.Path({str(ready)!r}).touch(); time.sleep(1)"
    leader = (
        "import subprocess,sys,time\n"
        f"subprocess.Popen([sys.executable,'-c',{holder!r}],start_new_session=True)\n"
        f"while not __import__('os').path.exists({str(ready)!r}): time.sleep(0.01)\n"
    )
    process = spawn_session(leader)
    try:
        seams = record_owned_group(monkeypatch, process, deny=False)
        with pytest.raises(TimeoutError, match="deadline"):
            headless.collect_json_process(process, ["inherited"], time.monotonic(), 0.3)
        assert ready.exists()
        assert seams.signalled == [(process.pid, signal.SIGKILL)]
        assert seams.anchored == [True]
        assert process.returncode == 0
    finally:
        process.communicate(timeout=10)


def spawn_pipe_holder(tmp_path: Path, hold_s: float) -> tuple[subprocess.Popen[str], Path]:
    """Start a leader whose descendant, in its own session, holds stdout until released or `hold_s`.

    The leader exits once the holder is ready. The holder exits by itself when the test creates
    the release file, so cleanup never needs a signal.

    Parameters:
        tmp_path (Path): readiness and release markers.
        hold_s (float): longest the holder keeps the pipe open.

    Returns:
        tuple[subprocess.Popen[str], Path]: the leader and the release file.
    """
    ready = tmp_path / "ready"
    release = tmp_path / "release"
    holder = (
        f"import pathlib,time; pathlib.Path({str(ready)!r}).touch(); end = time.monotonic() + {hold_s}\n"
        f"while time.monotonic() < end and not pathlib.Path({str(release)!r}).exists(): time.sleep(0.02)\n"
    )
    leader = (
        "import os,subprocess,sys,time\n"
        f"subprocess.Popen([sys.executable,'-c',{holder!r}],start_new_session=True)\n"
        f"while not os.path.exists({str(ready)!r}): time.sleep(0.01)\n"
    )
    return spawn_session(leader), release


def test_pipes_held_past_the_join_are_reported(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """A holder outside the group that outlives the post-kill join is an error, after the reap.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): recording seams.
        tmp_path (Path): holder markers.
    """
    process, release = spawn_pipe_holder(tmp_path, 30)
    try:
        seams = record_owned_group(monkeypatch, process, deny=False)
        with pytest.raises(RuntimeError, match="inherited output pipes"):
            headless.collect_json_process(process, ["held"], time.monotonic(), 0.3)
        assert seams.signalled == [(process.pid, signal.SIGKILL)]
        assert seams.anchored == [True]
        assert process.returncode == 0
    finally:
        release.touch()
        process.communicate(timeout=10)


def test_a_failed_leader_watch_surfaces_at_once(
    monkeypatch: pytest.MonkeyPatch, thread_deaths: list[BaseException | None]
) -> None:
    """A watcher `waitid` failure wakes the main thread and surfaces, instead of a late `TimeoutError`.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): a `waitid` that fails only off the main thread.
        thread_deaths (list[BaseException | None]): escaped thread exceptions.
    """
    failure = OSError(errno.EINVAL, "Invalid argument")
    waitid = os.waitid

    def failing(idtype: int, ident: int, options: int) -> os.waitid_result | None:
        """Fail the watcher thread's wait; the main thread keeps the real call.

        Parameters:
            idtype (int): id type.
            ident (int): process id.
            options (int): wait options.

        Returns:
            os.waitid_result | None: the real result on the main thread.

        Raises:
            OSError: always, off the main thread.
        """
        if threading.current_thread() is not threading.main_thread():
            raise failure
        return waitid(idtype, ident, options)

    process = spawn_session("import time; time.sleep(30)")
    try:
        seams = record_owned_group(monkeypatch, process, deny=False)
        monkeypatch.setattr(os, "waitid", failing)
        started = time.monotonic()
        with pytest.raises(OSError, match="Invalid argument") as caught:
            headless.collect_json_process(process, ["watch"], time.monotonic(), 5)
        assert caught.value is failure
        assert time.monotonic() - started < 3
        assert thread_deaths == []
        assert seams.signalled == []
    finally:
        process.kill()
        process.communicate(timeout=10)


def test_late_overflow_after_leader_exit_still_kills_once(monkeypatch: pytest.MonkeyPatch) -> None:
    """A descendant that overflows after its leader exited still gets its group killed, once.

    The recording `killpg` pretends delivery; the descendant writes and exits by itself.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): small output limit and recording seams.
    """
    monkeypatch.setattr(headless, "MAX_OUTPUT_BYTES", 4096)
    writer = 'import sys,time; time.sleep(0.2); sys.stdout.write("x"*8192)'
    process = spawn_session(f"import subprocess,sys; subprocess.Popen([sys.executable,'-c',{writer!r}])")
    try:
        seams = record_owned_group(monkeypatch, process, deny=False)
        with pytest.raises(RuntimeError, match="output bytes"):
            headless.collect_json_process(process, ["late"], time.monotonic(), 10)
        assert seams.signalled == [(process.pid, signal.SIGKILL)]
        assert seams.anchored == [True]
        assert seams.on_main == [True]
    finally:
        process.communicate(timeout=10)


def test_kill_owned_group_refuses_the_own_and_broadcast_groups(monkeypatch: pytest.MonkeyPatch) -> None:
    """pgid 0 and 1 are rejected before any syscall.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): a `killpg` that must not run.
    """

    def forbidden(pgid: int, sig: int) -> None:
        """Fail if any signal is attempted.

        Parameters:
            pgid (int): process group to signal.
            sig (int): signal to send.

        Raises:
            AssertionError: always.
        """
        raise AssertionError(f"killpg({pgid}, {sig})")

    monkeypatch.setattr(os, "killpg", forbidden)
    for pgid in (0, 1):
        with pytest.raises(ValueError, match="Refusing"):
            process_group.kill_owned_group(pgid, 5)


def test_permission_denied_with_a_live_member_still_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    """`EPERM` with a live member is a real permission failure and surfaces.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): recording seams.
    """
    process = spawn_session("pass")
    try:
        seams = record_owned_group(monkeypatch, process, listing=True)
        with pytest.raises(PermissionError) as caught:
            process_group.kill_owned_group(process.pid, 5)
        assert caught.value.__cause__ is None
        assert seams.signalled == [(process.pid, signal.SIGKILL)]
        assert seams.listed == [process.pid]
    finally:
        process.communicate(timeout=10)


@pytest.mark.parametrize(("deny", "gone"), [(False, False), (True, True)])
def test_kill_owned_group_reports_whether_the_group_is_gone(
    monkeypatch: pytest.MonkeyPatch, deny: bool, gone: bool
) -> None:
    """Delivery leaves the group possibly present; a zombie-only `EPERM` means gone.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): recording seams.
        deny (bool): answer `EPERM`.
        gone (bool): expected verdict.
    """
    process = spawn_session("pass")
    try:
        seams = record_owned_group(monkeypatch, process, deny=deny)
        assert process_group.kill_owned_group(process.pid, 5) is gone
        assert seams.listed == ([process.pid] if deny else [])
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
        monkeypatch.setattr(process_group, "group_has_live_members", unexpected)
        assert process_group.kill_owned_group(process.pid, 5)
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
        # Darwin refuses a zombie-only group (gone); Linux delivers to the zombie (signalled).
        assert process_group.kill_owned_group(process.pid, 5) is (sys.platform == "darwin")
    finally:
        process.kill()
        process.communicate(timeout=10)
