"""A failed first-frame wait must not leak test-owned tmux servers or their children.

References:
- tmux(1): https://man.openbsd.org/tmux.1
"""

from __future__ import annotations

from typing import TYPE_CHECKING
from unittest.mock import MagicMock

import pytest

from harness import interactive
from harness.sandbox import Sandbox

if TYPE_CHECKING:
    from pathlib import Path


@pytest.mark.parametrize("operation", ["start", "wait_for"])
def test_failed_launch_kills_private_server(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    """Ownership begins at construction, even if the launcher never returns the pane."""
    box = MagicMock(spec=Sandbox)
    box.root = tmp_path
    box.workdir = tmp_path
    box.env.return_value = {}
    pane = MagicMock()
    error = RuntimeError("launch failed")
    getattr(pane, operation).side_effect = error
    monkeypatch.setattr(interactive, "pi_command", MagicMock(return_value=["pi"]))
    monkeypatch.setattr(interactive, "TmuxPane", MagicMock(return_value=pane))
    monkeypatch.setattr(interactive.tempfile, "mkdtemp", MagicMock(return_value=str(tmp_path)))
    with pytest.raises(RuntimeError, match="launch failed") as caught:
        interactive.launch_tui(box, {})
    assert caught.value is error
    pane.kill.assert_called_once()
