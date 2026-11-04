"""Shared helpers for driving the harness against `tests/stub_pi.py` on a private tmux server.

Every pane runs on its own `-S` socket in a fresh `pih-*` dir (`harness.interactive.SOCKET_ROOT`,
short enough for macOS socket paths). Teardown proves the server and the stub existed, then
that both are gone, without signalling anything itself: `TmuxPane.kill` asks the private server
to exit and the server hangs up its own pane.
"""

from __future__ import annotations

import subprocess
import time
from contextlib import contextmanager
from typing import TYPE_CHECKING, Any

from harness import interactive
from harness.paths import TMUX_BIN
from harness.sandbox import build_sandbox
from tests.stub_pi import stub_pi_command

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    import pytest

    from harness.sandbox import Sandbox
    from harness.tmux import TmuxPane

# Bounds the wait for a daemonized tmux server to be reaped by init after `kill-server`.
EXIT_WAIT_S = 10.0
EXIT_POLL_S = 0.05
IDLE_SCRIPT: dict[str, Any] = {"providers": {"faux": {"models": ["main"], "steps": []}}}


class FakeClock:
    """Injected `time` stand-in: `sleep` advances `monotonic` instead of waiting."""

    def __init__(self) -> None:
        """Start at zero with no recorded sleeps."""
        self.now = 0.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        """Return the fake monotonic time.

        Returns:
            float: seconds since construction, advanced only by `sleep`.
        """
        return self.now

    def sleep(self, seconds: float) -> None:
        """Advance the clock without blocking.

        Parameters:
            seconds (float): requested delay.
        """
        self.sleeps.append(seconds)
        self.now += seconds


def use_stub_pi(monkeypatch: pytest.MonkeyPatch) -> None:
    """Point `launch_tui` at the stub instead of `PI_BIN`.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): test patcher.
    """
    monkeypatch.setattr(interactive, "pi_command", stub_pi_command)


def tmux_query(pane: TmuxPane, fmt: str) -> str:
    """Read one tmux format value from the pane's private server.

    Parameters:
        pane (TmuxPane): live pane.
        fmt (str): tmux format, e.g. `#{pid}`.

    Returns:
        str: stripped value.
    """
    return pane._tmux("display-message", "-p", "-t", pane.name, fmt).strip()


def process_alive(pid: int) -> bool:
    """Report whether `pid` is a live, non-zombie process (read only `ps`, never a signal).

    Parameters:
        pid (int): process id.

    Returns:
        bool: True while the process runs.
    """
    result = subprocess.run(
        ["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True, check=False
    )
    state = result.stdout.strip()
    return bool(state) and not state.startswith("Z")


def assert_exits(pid: int) -> None:
    """Wait a bounded time for a process this test started to finish exiting.

    Parameters:
        pid (int): process id proven alive earlier.

    Raises:
        AssertionError: still alive after `EXIT_WAIT_S`.
    """
    deadline = time.monotonic() + EXIT_WAIT_S
    while process_alive(pid):
        if time.monotonic() > deadline:
            raise AssertionError(f"Process '{pid}' outlived its private tmux server")
        time.sleep(EXIT_POLL_S)


def kill_and_prove_gone(pane: TmuxPane) -> None:
    """Tear the pane down and prove its server and stub existed before and are gone after.

    Parameters:
        pane (TmuxPane): pane on a private server this test started.
    """
    try:
        listing = subprocess.run(
            [TMUX_BIN, "-S", str(pane.socket), "ls"], capture_output=True, text=True, check=False
        )
        server_pid = int(tmux_query(pane, "#{pid}"))
        # A pane whose process already exited has no PID left to watch.
        pane_pid = tmux_query(pane, "#{?pane_dead,,#{pane_pid}}")
        server_was_alive = process_alive(server_pid)
    finally:
        pane.kill()
    assert listing.returncode == 0, listing.stderr
    assert pane.name in listing.stdout
    assert server_was_alive
    after = subprocess.run([TMUX_BIN, "-S", str(pane.socket), "ls"], capture_output=True, check=False)
    assert after.returncode != 0
    assert not pane.socket.parent.exists()
    assert_exits(server_pid)
    if pane_pid:
        assert_exits(int(pane_pid))


def stub_sandbox(tmp_path: Path, name: str = "box") -> Sandbox:
    """Build a bare sandbox (no installed stack) for stub sessions.

    Parameters:
        tmp_path (Path): test scratch.
        name (str): sandbox dir name.

    Returns:
        Sandbox: fresh home.
    """
    return build_sandbox(tmp_path / name)


@contextmanager
def stub_tui(monkeypatch: pytest.MonkeyPatch, box: Sandbox, **kwargs: Any) -> Iterator[TmuxPane]:
    """Launch the stub TUI through `launch_tui`, then prove teardown leaves nothing behind.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): test patcher.
        box (Sandbox): pi home.
        **kwargs (Any): `launch_tui` keyword arguments.

    Yields:
        TmuxPane: pane whose first frame (`main` footer) is drawn.
    """
    use_stub_pi(monkeypatch)
    pane = interactive.launch_tui(box, kwargs.pop("script", IDLE_SCRIPT), **kwargs)
    try:
        yield pane
    finally:
        if pane.socket.parent.exists():
            kill_and_prove_gone(pane)
