"""Adversarial publication and I/O failures cannot change the primary scenario outcome.

References:
- https://github.com/nredd/pi-harness/pull/194
"""

from __future__ import annotations

import io
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock

import pytest

import conftest
from harness import rpc
from harness.credentials import require_safe_diagnostic
from harness.sandbox import build_sandbox
from harness.tmux import PaneExitEvidence, TmuxPane
from scenarios.test_stack import wait_dead

if TYPE_CHECKING:
    from collections.abc import Callable


def fail_with_cleanup(cleanup: Callable[[], None]) -> None:
    """Raise the primary scenario failure, then run best-effort diagnostic cleanup.

    Parameters:
        cleanup (Callable[[], None]): capture/teardown invoked under the primary exception.
    """
    try:
        raise AssertionError("PRIMARY")
    finally:
        cleanup()


@pytest.mark.parametrize(
    "name",
    [
        "pi.exit",
        "pi.pane.json",
        "pi.stderr",
        "pi.txt",
        "script-pi.json",
        "event.jsonl",
        "sessions/history.jsonl",
    ],
)
@pytest.mark.parametrize("kind", ["signature", "url", "proxy"])
def test_every_candidate_is_scanned_before_atomic_publication(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str, kind: str
) -> None:
    """Even the last unsafe candidate removes stale evidence and publishes no partial tree."""
    box = build_sandbox(tmp_path / "box")
    destination = tmp_path / "uploads/case"
    destination.mkdir(parents=True)
    (destination / "stale.txt").write_text("stale")
    monkeypatch.setattr(conftest, "artifact_dir", lambda _: destination)
    (box.root / "aaa-safe.stderr").write_bytes(b"safe\r\n\xff")
    scan = conftest.require_safe_diagnostic

    def scan_before_publication(data: bytes) -> None:
        """Every candidate remains outside the upload tree until all scans succeed."""
        assert not destination.exists()
        scan(data)

    monkeypatch.setattr(conftest, "require_safe_diagnostic", scan_before_publication)
    payloads = {
        "signature": b"sk-" + b"S" * 40,
        "url": b"https://user:password@example.invalid/path",
        "proxy": b"known-password-ONLY",
    }
    monkeypatch.setenv("HTTPS_PROXY", "http://user:known-password-ONLY@example.invalid")
    source = (box.agent_dir if name.startswith("sessions/") else box.root) / name
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(payloads[kind])
    conftest.save_sandbox_artifacts(box, "case")
    assert not destination.exists()
    assert not list(tmp_path.glob("evidence-*"))


def test_publication_write_failure_preserves_primary_exception(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Capture refusal stays best effort and never becomes the scenario exception."""
    box = build_sandbox(tmp_path / "box")
    (box.root / "pi.stderr").write_bytes(b"safe")
    destination = tmp_path / "uploads/case"
    monkeypatch.setattr(conftest, "artifact_dir", lambda _: destination)
    monkeypatch.setattr(Path, "write_bytes", MagicMock(side_effect=OSError("disk full")))
    with pytest.raises(AssertionError, match="PRIMARY"):
        fail_with_cleanup(lambda: conftest.save_sandbox_artifacts(box, "case"))
    assert not destination.exists()


def test_shared_scanner_preserves_safe_non_utf8_and_reuses_release_policy() -> None:
    """Byte-exact diagnostics are allowed; URL/proxy and token policies are shared."""
    require_safe_diagnostic(b"panic\r\n\xfftail")
    with pytest.raises(ValueError, match="shared credential policy"):
        require_safe_diagnostic(b"Bearer " + b"A" * 32)


@pytest.mark.parametrize("failure", [FileNotFoundError("missing tmux"), RuntimeError("gone"), OSError("I/O")])
def test_tmux_query_failure_cannot_prevent_teardown(tmp_path: Path, failure: Exception) -> None:
    """Missing executable/server/I/O failure still attempts kill and removes the socket tree."""
    socket = tmp_path / "socket"
    socket.mkdir()
    pane = TmuxPane(socket / "pi.sock", "pi", exit_status_path=tmp_path / "pi.exit")
    calls = MagicMock(side_effect=[failure, failure])
    pane._tmux = calls
    with pytest.raises(AssertionError, match="PRIMARY"):
        fail_with_cleanup(pane.kill)
    assert calls.call_args_list[-1].args == ("kill-server",)
    assert not socket.exists()
    report = PaneExitEvidence.model_validate_json((tmp_path / "pi.pane.json").read_bytes())
    assert report.tmux_error


def test_invalid_utf8_marker_is_reported_not_swallowed_or_treated_as_status(tmp_path: Path) -> None:
    """The original marker stays raw and invalid; report validation is explicit."""
    socket = tmp_path / "socket"
    socket.mkdir()
    marker = tmp_path / "pi.exit"
    marker.write_bytes(b"\xff")
    pane = TmuxPane(socket / "pi.sock", "pi", exit_status_path=marker)
    pane._tmux = MagicMock(return_value="1")

    def invalid_marker_failure() -> None:
        """Retain the real invalid-marker verdict while still executing teardown."""
        try:
            wait_dead(pane)
        finally:
            pane.kill()

    with pytest.raises(UnicodeDecodeError):
        invalid_marker_failure()
    report = PaneExitEvidence.model_validate_json((tmp_path / "pi.pane.json").read_bytes())
    assert report.exit_status is None
    assert report.exit_status_error
    assert marker.read_bytes() == b"\xff"
    assert not socket.exists()


@pytest.mark.parametrize("operation", ["open", "write", "flush"])
def test_rpc_evidence_writer_failure_keeps_draining_and_child_exit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    """Drain more than a pipe buffer even if evidence I/O fails; retain bounded diagnostics."""
    box = build_sandbox(tmp_path / "box")
    child = tmp_path / "child.py"
    child.write_text("import os\nos.write(2,b'X'*262144+b'FINAL-DIAGNOSTIC')\nraise SystemExit(17)\n")
    monkeypatch.setattr(rpc, "pi_command", lambda: [sys.executable, str(child)])
    original_open = Path.open

    class FailingWriter(io.BytesIO):
        """Inject only evidence writer failures, not the child's stderr pipe."""

        def write(self, data: Any) -> int:
            if operation == "write":
                raise OSError("disk full")
            return super().write(data)

        def flush(self) -> None:
            if operation == "flush":
                raise OSError("disk full")
            super().flush()

    def open_evidence(path: Path, *args: Any, **kwargs: Any) -> Any:
        """Keep all other fixture and pipe operations real."""
        if path.suffix == ".stderr":
            if operation == "open":
                raise OSError("disk full")
            return FailingWriter()
        return original_open(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", open_evidence)
    process = rpc.RpcProcess(box, {})
    try:
        assert process.process.wait(timeout=5) == 17
        for reader in process.readers:
            reader.join(timeout=5)
            assert not reader.is_alive()
        assert "".join(process.stderr).endswith("FINAL-DIAGNOSTIC")
        assert len("".join(process.stderr)) <= rpc.MAX_OUTPUT
        with pytest.raises(AssertionError, match="RPC exited before expected event"):
            process.receive(lambda _: False, timeout_s=1)
    finally:
        process.process.kill()
        process.__exit__(AssertionError, AssertionError("PRIMARY"), None)
