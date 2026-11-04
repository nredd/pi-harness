"""`TmuxPane` against a real private tmux server running the stub `pi` TUI.

Deadline paths use an injected `FakeClock`, so no assertion depends on wall time or host load.

References:
- tmux(1): https://man.openbsd.org/tmux.1
"""

from __future__ import annotations

import os
import shutil
import tempfile
from itertools import count
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

from harness import interactive, tmux
from harness.tmux import (
    BUTTON_LEFT,
    MODIFIER_ALT,
    WHEEL_DOWN,
    WHEEL_UP,
    TmuxPane,
    TmuxTimeoutError,
    find_row,
    reap_stale_servers,
)
from scenarios.test_stack import wait_dead
from tests.stub_pi import EARLY_EXIT, stub_pi_command
from tests.stub_pi_session import (
    FakeClock,
    assert_exits,
    kill_and_prove_gone,
    process_alive,
    stub_sandbox,
    stub_tui,
    tmux_query,
)

if TYPE_CHECKING:
    from collections.abc import Iterator

    from harness.sandbox import Sandbox

SETTLE_S = 0.3


@pytest.fixture
def box(tmp_path: Path) -> Sandbox:
    """Bare sandbox for one stub session.

    Parameters:
        tmp_path (Path): test scratch.

    Returns:
        Sandbox: fresh home.
    """
    return stub_sandbox(tmp_path)


@pytest.fixture
def pane(monkeypatch: pytest.MonkeyPatch, box: Sandbox) -> Iterator[TmuxPane]:
    """A launched stub pane, torn down with a leak check.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): test patcher.
        box (Sandbox): pi home.

    Yields:
        TmuxPane: pane with its first frame drawn.
    """
    with stub_tui(monkeypatch, box, name="pane", width=80, height=12) as live:
        yield live


def test_start_writes_config_and_launches_in_sandbox(pane: TmuxPane, box: Sandbox) -> None:
    """The private config is on disk and the stub got the pane's size and wrapper env."""
    assert pane.socket.with_suffix(".conf").read_text() == tmux.TMUX_CONF
    rows = pane.rows()
    assert len(rows) == 12
    assert find_row(rows, r"stub pi model main 80x12") == 0
    assert "stub pi model main" in pane.capture()
    assert pane.is_alive()
    assert (box.root / "pane.stderr").is_file()


def test_styled_capture_keeps_escape_sequences(pane: TmuxPane) -> None:
    """`styled=True` is `capture-pane -e`: the footer keeps its SGR bold, the plain view does not."""
    styled = pane.capture(styled=True)
    assert "\x1b[1mmain" in styled
    assert "\x1b[" not in pane.capture()
    assert "stub pi model main 80x12" in tmux.strip_ansi(styled)


def test_type_text_and_send_keys_submit_a_line(pane: TmuxPane) -> None:
    """Literal text then the Enter key name arrive as one submitted line."""
    pane.type_text("hello stub")
    pane.send_keys("Enter")
    screen = pane.wait_for(r"^> hello stub$")
    assert find_row(screen.split("\n"), r"^> hello stub$") > find_row(screen.split("\n"), "stub pi")


def test_submit_closes_autocomplete_before_enter(pane: TmuxPane) -> None:
    """A slash command gets Escape before Enter; the stub drops the Escape byte."""
    interactive.submit(pane, "/model")
    interactive.submit(pane, "plain")
    pane.wait_for(r"^> plain$")
    rows = pane.wait_stable(quiet_s=SETTLE_S)
    first = find_row(rows, r"^> /model$")
    assert rows[first + 1] == "> plain"


def test_mouse_reports_reach_the_application(pane: TmuxPane) -> None:
    """`click`, `drag` and `wheel` deliver SGR reports with one-based coordinates."""
    pane.click(2, 1)
    pane.wait_for(r"mouse b=0 x=3 y=2 m")
    pane.drag((0, 0), (4, 3))
    pane.wait_for(r"mouse b=0 x=5 y=4 m")
    pane.wheel(1, 1, down=False, alt=True)
    pane.wheel(1, 1)
    screen = pane.wait_for(rf"mouse b={WHEEL_DOWN} x=2 y=2 M")
    reports = [row for row in screen.split("\n") if row.startswith("mouse")]
    assert reports == [
        f"mouse b={BUTTON_LEFT} x=3 y=2 M",
        f"mouse b={BUTTON_LEFT} x=3 y=2 m",
        f"mouse b={BUTTON_LEFT} x=1 y=1 M",
        f"mouse b={BUTTON_LEFT | 32} x=5 y=4 M",
        f"mouse b={BUTTON_LEFT} x=5 y=4 m",
        f"mouse b={WHEEL_UP | MODIFIER_ALT} x=2 y=2 M",
        f"mouse b={WHEEL_DOWN} x=2 y=2 M",
    ]


def test_write_raw_delivers_bytes_verbatim(pane: TmuxPane) -> None:
    """Hex-encoded bytes, including a newline, reach the application unchanged."""
    pane.write_raw(b"raw\n")
    pane.wait_for(r"^> raw$")


def test_resize_reaches_the_application(pane: TmuxPane) -> None:
    """The window and the application's terminal both take the new size."""
    pane.resize(60, 8)
    assert (pane.width, pane.height) == (60, 8)
    pane.wait_for(r"stub pi model main 60x8")
    assert len(pane.rows()) == 8


def test_wait_for_absent_returns_once_gone(pane: TmuxPane) -> None:
    """`absent=True` is satisfied by a pattern that is not on screen."""
    assert "stub pi" in pane.wait_for(r"never shown", absent=True)


def test_wait_for_timeout_carries_last_capture(pane: TmuxPane, monkeypatch: pytest.MonkeyPatch) -> None:
    """A pattern that never appears raises `TmuxTimeoutError` with the real last screen."""
    clock = FakeClock()
    monkeypatch.setattr(tmux, "time", clock)
    with pytest.raises(TmuxTimeoutError, match=r"waiting for /never shown/ to appear") as caught:
        pane.wait_for("never shown", timeout_s=1.0)
    assert "stub pi model main" in caught.value.capture
    assert "--- last capture ---\nstub pi model main" in str(caught.value)
    assert clock.sleeps == [tmux.POLL_INTERVAL_S] * len(clock.sleeps)
    assert clock.now >= 1.0


def test_wait_for_absent_timeout_names_disappear(pane: TmuxPane, monkeypatch: pytest.MonkeyPatch) -> None:
    """Waiting for an ever-present pattern to vanish reports `disappear`."""
    monkeypatch.setattr(tmux, "time", FakeClock())
    with pytest.raises(TmuxTimeoutError, match="to disappear"):
        pane.wait_for("stub pi", timeout_s=0.5, absent=True)


def test_wait_stable_times_out_on_a_changing_screen(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """A screen that changes on every poll never settles; the error keeps the last capture."""
    frames = count()
    pane = TmuxPane(tmp_path / "unused.sock", "changing")
    monkeypatch.setattr(pane, "capture", lambda: f"frame {next(frames)}")
    clock = FakeClock()
    monkeypatch.setattr(tmux, "time", clock)
    with pytest.raises(TmuxTimeoutError, match=r"never settled for 1.0s within 2.0s") as caught:
        pane.wait_stable(quiet_s=1.0, timeout_s=2.0)
    assert caught.value.capture == f"frame {len(clock.sleeps)}"


def test_quit_leaves_a_dead_pane_for_capture(pane: TmuxPane, box: Sandbox) -> None:
    """The stub's own exit keeps the pane (remain-on-exit) and records the wrapper status."""
    assert pane.is_alive()
    pane.type_text("quit")
    pane.send_keys("Enter")
    assert wait_dead(pane) == EARLY_EXIT
    assert pane.exit_status_path == box.root / "pane.exit"
    assert len(pane.rows()) == 12


def test_tmux_failure_names_the_command(tmp_path: Path) -> None:
    """A client error (no server on the socket) surfaces as `RuntimeError`, and liveness is False."""
    pane = TmuxPane(tmp_path / "absent.sock", "absent")
    with pytest.raises(RuntimeError, match=r"`tmux capture-pane -p` failed"):
        pane.capture()
    assert not pane.is_alive()


def test_exit_evidence_needs_a_marker_path(tmp_path: Path) -> None:
    """Without an exit marker there is nothing to record and no tmux query is made."""
    pane = TmuxPane(tmp_path / "absent.sock", "absent")
    pane.save_exit_evidence()
    assert list(tmp_path.iterdir()) == []


def test_find_row_reports_every_row_on_a_miss() -> None:
    """A miss lists the rows it searched."""
    with pytest.raises(AssertionError, match=r"No row matches /x/:\na\nb"):
        find_row(["a", "b"], "x")


def test_reap_stale_servers_kills_only_old_private_servers(tmp_path: Path, box: Sandbox) -> None:
    """An old `pih-*` dir's server is asked to exit; a fresh one and a dangling entry are left."""
    root = Path(tempfile.mkdtemp(prefix="pih-root-", dir=interactive.SOCKET_ROOT))
    stale = root / "pih-stale"
    old = TmuxPane(stale / "old.sock", "old")
    try:
        stale.mkdir()
        old.start([*stub_pi_command()], box.workdir, box.env())
        old.wait_for("stub pi")
        fresh = root / "pih-fresh"
        fresh.mkdir()
        (root / "pih-dangling").symlink_to(tmp_path / "missing")
        os.utime(stale, (0, 0))
        server_pid = int(tmux_query(old, "#{pid}"))
        assert process_alive(server_pid)
        assert reap_stale_servers(root, max_age_s=3600) == [stale]
        assert not stale.exists()
        assert fresh.is_dir()
        assert_exits(server_pid)
    finally:
        # Only this test's own server, by its own socket; a no-op once the reaper ran.
        old.kill()
        shutil.rmtree(root, ignore_errors=True)


def test_kill_and_prove_gone_detects_the_server(monkeypatch: pytest.MonkeyPatch, box: Sandbox) -> None:
    """The leak check itself is not vacuous: it sees the server before teardown."""
    with stub_tui(monkeypatch, box, name="leak") as live:
        kill_and_prove_gone(live)
        assert not live.socket.parent.exists()
