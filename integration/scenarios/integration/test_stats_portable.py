"""Work-profile producers export with Node alone, without personal Pi packages.

References:
- https://github.com/nredd/pi-session-kit
- https://github.com/nredd/pi-subscription-router/blob/main/docs/reset-aware-stats-plan.md
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING

import pytest

from harness.stats import PRIVATE_SENTINEL, export_machine, hourly_entries, import_machines, write_history

if TYPE_CHECKING:
    from pathlib import Path

pytestmark = pytest.mark.integration


def test_work_producer_needs_no_pi_packages_or_credentials(
    portable_stats_artifact: Path, tmp_path: Path
) -> None:
    """Copy the managed artifact to a clean work home; repeat exports/imports stay stable and private."""
    home = tmp_path / "work-home"
    agent_dir = home / ".pi" / "agent"
    history = write_history(agent_dir, hourly_entries(datetime.now(UTC)))
    output = tmp_path / "shared"
    first = export_machine(portable_stats_artifact, home, agent_dir, output)
    second = export_machine(portable_stats_artifact, home, agent_dir, output)
    assert second == first
    assert not (agent_dir / "auth.json").exists()
    assert not (agent_dir / "settings.json").exists()
    assert not (agent_dir / "git").exists()
    assert not (agent_dir / "npm").exists()
    assert not list(home.rglob("node_modules"))
    shards = [
        path for path in first.snapshot_dir.rglob("*") if path.is_file() and path.name != "manifest.json"
    ]
    assert shards, "The exporter must write month shards, not just a manifest"
    exported = "\n".join(path.read_text() for path in [first.snapshot_dir / "manifest.json", *shards])
    for forbidden in (
        PRIVATE_SENTINEL,
        str(home),
        str(history),
        "--private-source-path--",
        '"content"',
        '"cwd"',
    ):
        assert forbidden not in exported, f"Private field exported: {forbidden!r}"
    viewer_home = tmp_path / "work-viewer"
    viewer = viewer_home / ".pi" / "agent"
    viewer.mkdir(parents=True)
    import_machines(portable_stats_artifact, viewer_home, viewer, output)
    import_machines(portable_stats_artifact, viewer_home, viewer, output)
    assert not (viewer / "auth.json").exists()
    assert not (viewer / "git").exists()
    assert not (viewer / "npm").exists()
    # Prove it isn't a no-op: importing into an empty viewer creates persistent cache data.
    assert any(path.is_file() for path in viewer.rglob("*"))
