"""Failure evidence survives teardown without copying credentials or changing verdicts.

References:
- https://github.com/nredd/pi-harness/pull/155
- https://github.com/nredd/pi-harness/pull/178
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock

import pytest

import conftest
from harness import rpc, tmux
from harness.sandbox import build_sandbox
from harness.tmux import TmuxPane
from scenarios import test_startup as startup

if TYPE_CHECKING:
    from pathlib import Path

RAW_STDERR = b"native panic\r\n\xffraw-tail\n"


def test_pane_records_status_before_killing_server(tmp_path: Path) -> None:
    """Record native state and the wrapper marker before destroying either owner."""
    socket_dir = tmp_path / "socket"
    socket_dir.mkdir()
    status = tmp_path / "pi.exit"
    status.write_text("134\n")
    pane = TmuxPane(socket_dir / "pi.sock", "pi", exit_status_path=status)
    query = MagicMock(return_value="pid=42 dead=1 status=134 signal=\n")
    pane._tmux = query
    pane.kill()
    report = json.loads((tmp_path / "pi.pane.json").read_text())
    assert report["exit_status"] == "134\n"
    assert report["exit_status_path"] == str(status)
    assert "status=134" in report["tmux"]
    assert query.call_args_list[0].args[0] == "display-message"
    assert query.call_args_list[-1].args == ("kill-server",)
    assert not socket_dir.exists()


TABLE = """\
    1     0     1 Ss   10-00:00:01 /sbin/launchd
  100     1   100 Ss      00:30 sh -c wrapper
  101   100   100 S+      00:29 bun pi --no-approve
  102   101   100 Z       00:28 (qmd)
  200     1   200 Ss      00:30 unrelated 100
garbage line
"""


def test_process_subtree_selects_root_and_descendants_only() -> None:
    """A live hung child is visible; unrelated rows, malformed rows and a gone root are not."""
    tree = tmux.process_subtree(TABLE, 100).splitlines()
    assert [line.split()[0] for line in tree] == ["100", "101", "102"]
    assert "Z" in tree[2]
    assert tmux.process_subtree(TABLE, 999) == ""


def test_read_process_table_sees_this_process() -> None:
    """The real `ps` call lists the test process with all six columns."""
    row = next(line for line in tmux.read_process_table().splitlines() if line.split()[0] == str(os.getpid()))
    assert len(row.split(None, 5)) == 6


def test_pane_records_process_tree(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The report carries the pane's subtree, taken before teardown."""
    monkeypatch.setattr(tmux, "read_process_table", MagicMock(return_value=TABLE))
    pane = TmuxPane(tmp_path / "socket/pi.sock", "pi", exit_status_path=tmp_path / "pi.exit")
    pane._tmux = MagicMock(return_value="pid=100 dead=0 status= signal=\n")
    pane.kill()
    report = json.loads((tmp_path / "pi.pane.json").read_text())
    assert [line.split()[0] for line in report["process_tree"].splitlines()] == ["100", "101", "102"]
    assert report["process_tree_error"] is None


@pytest.mark.parametrize("failure", [FileNotFoundError("ps"), subprocess.TimeoutExpired("ps", 10)])
def test_process_table_failure_is_recorded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: Exception
) -> None:
    """An unreadable process table is evidence, never a replacement exception."""
    monkeypatch.setattr(tmux, "read_process_table", MagicMock(side_effect=failure))
    pane = TmuxPane(tmp_path / "socket/pi.sock", "pi", exit_status_path=tmp_path / "pi.exit")
    pane._tmux = MagicMock(return_value="pid=100 dead=0")
    pane.kill()
    report = json.loads((tmp_path / "pi.pane.json").read_text())
    assert report["process_tree"] is None
    assert "ps" in report["process_tree_error"]


def test_gone_pane_has_no_pid_for_process_tree(tmp_path: Path) -> None:
    """Without a pane PID the report says so instead of guessing a tree."""
    pane = TmuxPane(tmp_path / "socket/pi.sock", "pi", exit_status_path=tmp_path / "pi.exit")
    pane._tmux = MagicMock(side_effect=RuntimeError("no server running"))
    pane.kill()
    report = json.loads((tmp_path / "pi.pane.json").read_text())
    assert report["process_tree_error"] == "No pane PID"


def test_gone_pane_still_records_missing_marker(tmp_path: Path) -> None:
    """A missing server is evidence, not a replacement exception during cleanup."""
    pane = TmuxPane(tmp_path / "socket/pi.sock", "pi", exit_status_path=tmp_path / "pi.exit")
    pane._tmux = MagicMock(side_effect=RuntimeError("no server running"))
    pane.kill()
    report = json.loads((tmp_path / "pi.pane.json").read_text())
    assert report["exit_status"] is None
    assert "no server running" in report["tmux_error"]


def test_artifact_allowlist_preserves_exit_evidence_not_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Add named exit artifacts without allowing arbitrary JSON or recursive HOME copies."""
    box = build_sandbox(tmp_path / "box")
    destination = tmp_path / "saved"
    destination.mkdir()
    monkeypatch.setattr(conftest, "artifact_dir", lambda _: destination)
    for name in ("pi.exit", "pi.pane.json", "startup-rpc.stderr"):
        (box.root / name).write_bytes(RAW_STDERR)
    (box.root / "private.json").write_text("DO-NOT-COPY")
    (box.agent_dir / "auth.json").write_text("DO-NOT-COPY")
    conftest.save_sandbox_artifacts(box, "fake-case")
    assert {path.name for path in destination.iterdir()} == {"pi.exit", "pi.pane.json", "startup-rpc.stderr"}
    assert (destination / "startup-rpc.stderr").read_bytes() == RAW_STDERR


@pytest.mark.parametrize(("timed_out", "exit_code"), [(False, 17), (False, 0), (True, 17)])
def test_startup_process_preserves_raw_stderr_and_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, timed_out: bool, exit_code: int
) -> None:
    """Exercise the original scenario's abnormal exit/timeout path, not a substitute runner."""
    box = build_sandbox(tmp_path / "box")
    child = tmp_path / "child.py"
    child.write_text(
        "import os,time\n"
        f"print({startup.MESSAGE!r},flush=True)\n"
        f"os.write(2, {RAW_STDERR!r})\n"
        + ("time.sleep(60)\n" if timed_out else f"raise SystemExit({exit_code})\n")
    )
    monkeypatch.setattr(startup, "pi_command", lambda: [sys.executable, str(child)])
    run = subprocess.run
    codes: list[int] = []

    def short_run(args: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        """Shorten only the synthetic child's deadline, never the production scenario."""
        kwargs["timeout"] = 0.5
        result = run(args, **kwargs)
        codes.append(result.returncode)
        return result

    monkeypatch.setattr(startup.subprocess, "run", short_run)
    if timed_out:
        with pytest.raises(subprocess.TimeoutExpired):
            startup.test_fatal_startup_modes(box, "rpc", "session_start", False)
    elif exit_code:
        with pytest.raises(AssertionError, match="native panic"):
            startup.test_fatal_startup_modes(box, "rpc", "session_start", False)
        assert codes == [17]
    else:
        # Mutation control: changing only exit 17 -> 0 must remove the primary failure.
        startup.test_fatal_startup_modes(box, "rpc", "session_start", False)
        assert codes == [0]
    assert (box.root / "startup-rpc.stderr").read_bytes() == RAW_STDERR


@pytest.mark.parametrize("timed_out", [False, True])
def test_rpc_driver_preserves_raw_stderr_on_timeout_or_eof(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, timed_out: bool
) -> None:
    """Concurrent stderr draining retains original bytes even when receive fails."""
    box = build_sandbox(tmp_path / "box")
    child = tmp_path / "child.py"
    child.write_text(
        "import os,time\n"
        f"os.write(2, {RAW_STDERR!r})\n" + ("time.sleep(60)\n" if timed_out else "raise SystemExit(17)\n")
    )
    monkeypatch.setattr(rpc, "pi_command", lambda: [sys.executable, str(child)])
    process = rpc.RpcProcess(box, {})
    message = "deadline" if timed_out else "exited"
    try:
        with pytest.raises(AssertionError, match=message):
            process.receive(lambda _: False, timeout_s=0.5)
    finally:
        process.process.kill()
        process.__exit__(AssertionError, AssertionError("original failure"), None)
    assert process.stderr_path.read_bytes() == RAW_STDERR


def test_rpc_eof_timeout_carries_child_stderr(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A session that ignores EOF reports its own stderr (e.g. a Bun crash banner), not just argv."""
    box = build_sandbox(tmp_path / "box")
    child = tmp_path / "child.py"
    child.write_text(
        f"import os,sys,time\nos.write(2, {RAW_STDERR!r})\nsys.stdin.readline()\ntime.sleep(60)\n"
    )
    monkeypatch.setattr(rpc, "pi_command", lambda: [sys.executable, str(child)])
    monkeypatch.setattr(rpc, "EOF_EXIT_TIMEOUT_S", 0.5)
    process = rpc.RpcProcess(box, {})
    process.send({"type": "get_state"})
    with pytest.raises(TimeoutError, match="native panic"):
        process.__exit__(None, None, None)
    assert process.process.returncode is not None
    assert process.stderr_path.read_bytes() == RAW_STDERR
