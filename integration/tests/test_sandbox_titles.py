"""Offline sandbox defaults must not dispatch auto-title calls to real providers.

References:
- https://github.com/nredd/pi-session-kit
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

import pytest

from harness import sandbox

if TYPE_CHECKING:
    from pathlib import Path


@pytest.mark.parametrize("existing", [False, True])
def test_sandbox_disables_titles_preserving_module_cfg(tmp_path: Path, existing: bool) -> None:
    """Handle absent cfg and deep-merge only the title enable flag in existing cfg."""
    template = tmp_path / "template"
    agent = template / ".pi" / "agent"
    agent.mkdir(parents=True)
    cfg = {
        "titles": {"enabled": True, "model": "anthropic/never-call", "maxWords": 5},
        "goal": {"enabled": False},
        "rules": {"enabled": True},
        "monitor": {"enabled": False},
    }
    source = agent / "pi-session-kit.json"
    if existing:
        source.write_text(json.dumps(cfg))
    box = sandbox.build_sandbox(tmp_path / "box", template)
    actual = json.loads((box.agent_dir / "pi-session-kit.json").read_text())
    expected = (
        sandbox.deep_merge(cfg, {"titles": {"enabled": False}})
        if existing
        else {"titles": {"enabled": False}}
    )
    assert actual == expected
    if existing:
        assert json.loads(source.read_text()) == cfg
    else:
        assert not source.exists()
