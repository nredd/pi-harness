"""Synthetic native exit/timeout proofs for pre-teardown evidence, without a Pi build.

References:
- https://github.com/nredd/pi-harness/pull/155
"""

from __future__ import annotations

import json
import sys
from typing import TYPE_CHECKING

import pytest

import conftest
from harness import interactive
from harness.sandbox import build_sandbox
from harness.tmux import TmuxTimeoutError
from scenarios.test_stack import wait_dead

if TYPE_CHECKING:
    from pathlib import Path

pytestmark = pytest.mark.tui
RAW_STDERR = b"synthetic-native-crash\r\n\xffraw-tail\n"


@pytest.mark.parametrize("aborts", [False, True], ids=["timeout", "abort"])
def test_real_pane_preserves_original_failure_and_exit_evidence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, aborts: bool
) -> None:
    """Run the actual shell wrapper and capture before killing a live or aborted child."""
    box = build_sandbox(tmp_path / "box")
    child = tmp_path / "child.py"
    child.write_text(
        "import os,time\n"
        f"os.write(2, {RAW_STDERR!r})\n"
        "print('READY',flush=True)\n" + ("os.abort()\n" if aborts else "time.sleep(60)\n")
    )
    monkeypatch.setattr(interactive, "pi_command", lambda: [sys.executable, str(child)])
    pane = interactive.launch_tui(box, {}, wait_pattern=None)
    try:
        if aborts:
            assert wait_dead(pane) == 134
        else:
            pane.wait_for("READY", timeout_s=5)
            with pytest.raises(TmuxTimeoutError, match="Timed out"):
                pane.wait_for("NEVER-PRESENT", timeout_s=0.2)
    finally:
        pane.kill()
    report_path = box.root / "pi.pane.json"
    report = json.loads(report_path.read_text())
    assert f"dead={int(aborts)}" in report["tmux"]
    assert report["exit_status"] == ("134\n" if aborts else None)
    assert (box.root / "pi.stderr").read_bytes() == RAW_STDERR
    # Snapshot is not overwritten by a second cleanup against a now-dead server.
    original = report_path.read_bytes()
    pane.kill()
    assert report_path.read_bytes() == original
    destination = tmp_path / "artifacts"
    destination.mkdir()
    monkeypatch.setattr(conftest, "artifact_dir", lambda _: destination)
    conftest.save_sandbox_artifacts(box, "synthetic")
    assert (destination / "pi.pane.json").read_bytes() == original
    assert (destination / "pi.stderr").read_bytes() == RAW_STDERR
    if aborts:
        assert (destination / "pi.exit").read_text() == "134\n"
