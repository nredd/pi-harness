"""Exercise the public PTY lifecycle with real offline child processes.

References:
- https://docs.python.org/3/library/pty.html
"""

from __future__ import annotations

import errno
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from harness import pty_driver
from harness.pty_driver import Child, PtyFleet


def child(tmp_path: Path, code: str) -> Child:
    """Build a credential-free child specification."""
    return Child((sys.executable, "-u", "-c", code), tmp_path, {"TERM": "xterm"})


def test_aggregate_cap_and_fairness(tmp_path: Path) -> None:
    """One aggregate budget, not a separate budget for each child."""
    spec = child(tmp_path, "import os\nwhile True: os.write(1, b'x'*4096)")
    with PtyFleet([spec] * 4) as fleet:
        sample = fleet.drain(0.4, bytes_per_s=16000)
        assert 0 < sum(sample.delivered) <= sample.elapsed_s * 16000 + 1
        assert all(count > 0 for count in sample.delivered)
        assert sample.bytes_per_s > 0
        assert max(sample.delivered) - min(sample.delivered) <= 1024
    assert all(proc.poll() is not None for proc in fleet.children)
    for fd in fleet.masters:
        with pytest.raises(OSError, match="Bad file descriptor"):
            os.fstat(fd)


def test_interactive_input_and_readiness(tmp_path: Path) -> None:
    """Real PTY input reaches the child and the output readiness seam."""
    code = "import sys,time\nprint('ready',flush=True)\nprint(input(),flush=True)\ntime.sleep(30)"
    with PtyFleet([child(tmp_path, code)]) as fleet:
        fleet.wait_for(b"ready", timeout_s=5)
        fleet.send(0, b"hello\n")
        fleet.wait_for(b"hello", timeout_s=5)
        assert fleet.drain(0.02).elapsed_s > 0
    fleet.close()
    with pytest.raises(RuntimeError, match="not active"):
        fleet.drain(0.01)
    with pytest.raises(RuntimeError, match="twice"):
        fleet.__enter__()


@pytest.mark.parametrize("value", [0, -1, float("nan"), float("inf")])
def test_invalid_window_and_rate(tmp_path: Path, value: float) -> None:
    """Invalid limits fail before measurement instead of hanging or yielding zeros."""
    with PtyFleet([child(tmp_path, "import time; time.sleep(30)")]) as fleet:
        with pytest.raises(ValueError, match="finite positive"):
            fleet.drain(value)
        with pytest.raises(ValueError, match="finite positive"):
            fleet.drain(0.01, bytes_per_s=value)
        with pytest.raises(ValueError, match="finite positive"):
            fleet.wait_for(b"ready", timeout_s=value)
        with pytest.raises(ValueError, match="finite positive"):
            fleet.send(0, b"x", timeout_s=value)


def test_missing_output_and_exited_child(tmp_path: Path) -> None:
    """Silence times out, while early exit fails even if output had been delivered."""
    with PtyFleet([child(tmp_path, "import time; time.sleep(30)")]) as fleet:
        with pytest.raises(TimeoutError, match="startup"):
            fleet.wait_for(b"ready", timeout_s=0.05)
        for marker in (b"", b"x" * 65537):
            with pytest.raises(ValueError, match="nonempty bounded"):
                fleet.wait_for(marker)
    with PtyFleet([child(tmp_path, "pass")]) as fleet:
        time.sleep(0.2)
        with pytest.raises(RuntimeError, match=r"exited|closed"):
            fleet.drain(1)


def test_partial_start_and_cancellation_cleanup(tmp_path: Path) -> None:
    """A later spawn failure and caller cancellation both release earlier acquisitions."""
    good = child(tmp_path, "import time; time.sleep(30)")
    bad = Child(("/no/such/executable",), tmp_path, {})
    fleet = PtyFleet([good, bad])
    with pytest.raises(FileNotFoundError):
        fleet.__enter__()
    assert all(proc.poll() is not None for proc in fleet.children)
    assert fleet.closed
    fleet = PtyFleet([good])

    def cancel(_active: PtyFleet) -> None:
        """Model a caller cancellation at a poll boundary."""
        raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt), fleet:
        fleet.drain(1, tick=cancel)
    assert all(proc.poll() is not None for proc in fleet.children)


@pytest.mark.parametrize("specs", [[], [Child((), Path("/tmp"), {})], [Child(("python",), Path("/tmp"), {})]])
def test_invalid_commands(specs: list[Child]) -> None:
    """Refuse implicit executables and empty fleets before acquiring resources."""
    with pytest.raises(ValueError, match="absolute executable"):
        PtyFleet(specs)


def test_inactive_and_backed_up_input(tmp_path: Path) -> None:
    """Unentered fleets refuse work and unread child input has a finite deadline."""
    code = "import tty,time; tty.setraw(0); print('ready',flush=True); time.sleep(30)"
    fleet = PtyFleet([child(tmp_path, code)])
    with pytest.raises(RuntimeError, match="not active"):
        fleet.drain(0.01)
    with fleet:
        fleet.wait_for(b"ready", timeout_s=5)
        with pytest.raises(RuntimeError, match="twice"):
            fleet.__enter__()
        with pytest.raises(TimeoutError, match="input stalled"):
            fleet.send(0, b"x" * 1000000, timeout_s=0.05)


@pytest.mark.parametrize(
    "failure", [BlockingIOError(), OSError(errno.EIO, "closed"), OSError(errno.EBADF, "bad fd"), None]
)
def test_output_kernel_races(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: OSError | None
) -> None:
    """Refuse EOF/EIO, preserve unrelated errors, tolerate a readiness race."""
    original = os.read
    with PtyFleet([child(tmp_path, "import os\nwhile True: os.write(1,b'x'*4096)")]) as fleet:
        fleet.wait_for(b"x", timeout_s=5)

        def read_once(fd: int, size: int) -> bytes:
            """Inject a single kernel outcome at the public drain seam."""
            monkeypatch.setattr(os, "read", original)
            if failure is None:
                return b""
            raise failure

        monkeypatch.setattr(os, "read", read_once)
        if isinstance(failure, BlockingIOError):
            assert sum(fleet.drain(0.05).delivered) > 0
        elif failure is None or failure.errno == errno.EIO:
            with pytest.raises(RuntimeError, match="closed output"):
                fleet.drain(0.05)
        else:
            with pytest.raises(OSError, match="bad fd"):
                fleet.drain(0.05)


def test_input_readiness_race(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Retry a transient input EAGAIN without dropping input."""
    original = os.write
    with PtyFleet([child(tmp_path, "import time; print('ready',flush=True); time.sleep(30)")]) as fleet:
        fleet.wait_for(b"ready", timeout_s=5)

        def write_once(_fd: int, _data: bytes) -> int:
            """Model readiness consumed between select and write."""
            monkeypatch.setattr(os, "write", original)
            raise BlockingIOError

        monkeypatch.setattr(os, "write", write_once)
        fleet.send(0, b"hello\n")


@pytest.mark.parametrize("failure", ["signal", "wait"])
def test_cleanup_errors_do_not_abandon_other_children(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
) -> None:
    """Attempt every group and close every master even when one cleanup operation fails."""
    spec = child(tmp_path, "import time; time.sleep(30)")
    fleet = PtyFleet([spec, spec]).__enter__()
    original_kill = pty_driver.kill_owned_group
    original_wait = fleet.children[0].wait

    def kill(pgid: int, timeout: float) -> bool:
        """Kill the real test child, then inject a reported refusal for one group."""
        result = original_kill(pgid, timeout)
        if pgid == fleet.children[0].pid:
            raise PermissionError("signal refused")
        return result

    def wait(timeout: float) -> int:
        """Model a bounded reaping failure after the real kill."""
        raise subprocess.TimeoutExpired("test-child", timeout)

    if failure == "signal":
        monkeypatch.setattr(pty_driver, "kill_owned_group", kill)
        expected = PermissionError
    else:
        monkeypatch.setattr(fleet.children[0], "wait", wait)
        expected = subprocess.TimeoutExpired
    with pytest.raises(expected):
        fleet.close()
    original_wait(timeout=2)
    assert fleet.children[1].returncode is not None
    for fd in fleet.masters:
        with pytest.raises(OSError, match="Bad file descriptor"):
            os.fstat(fd)
