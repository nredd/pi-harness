"""Shared helpers for driving the harness against `tests/stub_pi.py` on a private tmux server.

Every pane runs on its own `-S` socket in a fresh `pih-*` dir (`harness.interactive.SOCKET_ROOT`,
short enough for macOS socket paths). Teardown proves the server existed, then
that it is gone, without signalling anything itself: `TmuxPane.kill` asks the private server
to exit and the server hangs up its own pane.
"""

from __future__ import annotations

import subprocess
from contextlib import contextmanager
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from harness import interactive
from harness.paths import TMUX_BIN
from harness.sandbox import build_sandbox
from tests.stub_pi import stub_pi_command

if TYPE_CHECKING:
    from collections.abc import Iterator, Sequence
    from pathlib import Path

    import pytest

    from harness.sandbox import Sandbox
    from harness.tmux import TmuxPane

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


def assert_server_gone(socket: Path) -> None:
    """Assert, synchronously, that no tmux server answers on `socket` and its dir is gone.

    `TmuxPane.kill` returns after `kill-server` and removes the socket dir, so `ls` fails at
    once; nothing here waits on a wall clock for a pid to exit.

    Parameters:
        socket (Path): private socket that had a live server.

    Raises:
        AssertionError: a server still answers, or the socket dir survived.
    """
    after = subprocess.run([TMUX_BIN, "-S", str(socket), "ls"], capture_output=True, check=False)
    assert after.returncode != 0, after.stdout
    assert not socket.parent.exists()


@dataclass(frozen=True)
class PaneSnapshot:
    """What a pane looked like before teardown: the proof that the leak check is not vacuous."""

    socket: Path
    name: str
    listing: subprocess.CompletedProcess[str]
    server_was_alive: bool


def snapshot(pane: TmuxPane) -> PaneSnapshot:
    """Record the pane's server listing and liveness before it is killed.

    Parameters:
        pane (TmuxPane): pane on a private server this test started.

    Returns:
        PaneSnapshot: pre-teardown evidence.
    """
    listing = subprocess.run(
        [TMUX_BIN, "-S", str(pane.socket), "ls"], capture_output=True, text=True, check=False
    )
    server_pid = int(tmux_query(pane, "#{pid}"))
    return PaneSnapshot(pane.socket, pane.name, listing, process_alive(server_pid))


def kill_all_and_prove_gone(panes: Sequence[TmuxPane]) -> None:
    """Snapshot every pane, kill every pane, then prove each existed before and is gone after.

    Every pane is killed before any assertion runs, so one failed proof cannot leak the
    other panes' servers.

    Parameters:
        panes (Sequence[TmuxPane]): panes on private servers this test started.
    """
    snapshots: list[PaneSnapshot] = []
    try:
        for pane in panes:
            snapshots.append(snapshot(pane))
    finally:
        for pane in panes:
            pane.kill()
    for before in snapshots:
        assert before.listing.returncode == 0, before.listing.stderr
        assert before.name in before.listing.stdout
        assert before.server_was_alive
        assert_server_gone(before.socket)


def kill_and_prove_gone(pane: TmuxPane) -> None:
    """Tear one pane down and prove its server existed before and is gone after.

    Parameters:
        pane (TmuxPane): pane on a private server this test started.
    """
    kill_all_and_prove_gone([pane])


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
