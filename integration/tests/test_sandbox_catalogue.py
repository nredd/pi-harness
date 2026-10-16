"""Verify offline sandboxes copy public catalogue metadata without sharing mutable state.

References:
    - https://pi.dev/models
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from harness import sandbox

if TYPE_CHECKING:
    from pathlib import Path

    import pytest


def test_catalogue_is_copied_not_linked(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Retain newer model IDs offline without exposing credentials or mutating the live cache.

    Parameters:
        tmp_path (Path): isolated test root.
        monkeypatch (pytest.MonkeyPatch): patch the live agent directory.
    """
    live = tmp_path / "live"
    live.mkdir()
    catalogue = live / "models-store.json"
    catalogue.write_text(json.dumps({"anthropic": {"models": [{"id": "claude-haiku-5-5"}]}}))
    (live / "auth.json").write_text("PRIVATE")
    template = tmp_path / "template"
    (template / ".pi" / "agent").mkdir(parents=True)
    monkeypatch.setattr(sandbox, "LIVE_AGENT_DIR", live)
    box = sandbox.build_sandbox(tmp_path / "box", template)
    copied = box.agent_dir / "models-store.json"
    assert copied.read_text() == catalogue.read_text()
    assert not copied.is_symlink()
    copied.write_text("{}")
    assert "claude-haiku-5-5" in catalogue.read_text()
    assert "PRIVATE" not in (box.agent_dir / "auth.json").read_text()


def test_missing_catalogue_uses_bundled_models(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep startup valid on machines without a cached catalogue.

    Parameters:
        tmp_path (Path): isolated test root.
        monkeypatch (pytest.MonkeyPatch): patch the live agent directory.
    """
    template = tmp_path / "template"
    (template / ".pi" / "agent").mkdir(parents=True)
    monkeypatch.setattr(sandbox, "LIVE_AGENT_DIR", tmp_path / "missing")
    box = sandbox.build_sandbox(tmp_path / "box", template)
    assert not (box.agent_dir / "models-store.json").exists()
