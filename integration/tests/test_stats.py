"""Validate stats fixtures and standalone CLI invocation without mocking kit accounting.

References:
- https://github.com/nredd/pi-session-kit
"""

from __future__ import annotations

import json
import os
import subprocess
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING
from unittest.mock import Mock

import pytest

from harness import stats

if TYPE_CHECKING:
    from pathlib import Path


@pytest.mark.parametrize("hour", [0, 1, 12, 23])
def test_hourly_fixture_is_exact_at_any_utc_hour(hour: int) -> None:
    """The fixture places calls inside both rolling windows even at midnight."""
    now = datetime(2026, 10, 13, hour, 3, tzinfo=UTC)
    entries = [json.loads(line) for line in stats.hourly_entries(now)]
    counted = [
        entry
        for entry in entries
        if entry["message"]["role"] == "assistant"
        and entry["message"]["provider"] in {"anthropic", "openai-codex"}
        and datetime.fromisoformat(entry["timestamp"]) <= now
    ]
    assert len(counted) == 6
    assert len({entry["id"] for entry in counted}) == 6
    for hours, expected, anthropic, codex in [(5, 78, 26, 52), (24, 260, 104, 156), (None, 546, 234, 312)]:
        calls = [
            entry
            for entry in counted
            if hours is None or datetime.fromisoformat(entry["timestamp"]) >= now - timedelta(hours=hours)
        ]
        assert sum(entry["message"]["usage"]["totalTokens"] for entry in calls) == expected
        for provider, total in [("anthropic", anthropic), ("openai-codex", codex)]:
            assert (
                sum(
                    entry["message"]["usage"]["totalTokens"]
                    for entry in calls
                    if entry["message"]["provider"] == provider
                )
                == total
            )


def test_portable_command_copies_only_artifact_and_strips_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Producer runs cannot inherit credentials, Node loaders or personal package discovery."""
    artifact = tmp_path / "managed.mjs"
    artifact.write_text("// standalone test placeholder\n")
    home = tmp_path / "clean-home"
    monkeypatch.setenv("HA_TOKEN", "not-a-real-token")
    monkeypatch.setenv("NODE_OPTIONS", "--import private-extension.mjs")
    monkeypatch.setenv("NODE_PATH", "/private/node_modules")
    monkeypatch.setattr(stats.shutil, "which", Mock(return_value="/absolute/node"))
    run = Mock(return_value='{"ok":true}\n')
    monkeypatch.setattr(stats.subprocess, "check_output", run)
    assert stats.portable_command(
        artifact, home, ["export", "--agent-dir", "/source", "--output", "/out"]
    ) == ('{"ok":true}\n')
    copied = home / stats.PORTABLE_ARTIFACT
    assert copied.read_bytes() == artifact.read_bytes()
    run.assert_called_once_with(
        ["/absolute/node", str(copied), "export", "--agent-dir", "/source", "--output", "/out"],
        cwd=home,
        env={"HOME": str(home), "PATH": os.defpath, "TZ": "UTC"},
        text=True,
        stderr=subprocess.STDOUT,
        timeout=30,
    )
    assert not (home / ".pi").exists()


def test_export_validates_public_cli_result(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The only JSON protocol mirrored by the helper is the approved stdout result."""
    machine_id = "00000000-0000-4000-8000-000000000001"
    output = tmp_path / "shared"
    snapshot = output / "machines" / machine_id
    snapshot.mkdir(parents=True)
    (snapshot / "manifest.json").write_text("{}")
    run = Mock(return_value=json.dumps({"machineId": machine_id, "snapshotDir": str(snapshot)}))
    monkeypatch.setattr(stats, "portable_command", run)
    result = stats.export_machine(tmp_path / "bundle", tmp_path / "home", tmp_path / "agent", output)
    assert result == stats.ExportedMachine(machine_id, snapshot.resolve())
    run.assert_called_once_with(
        tmp_path / "bundle",
        tmp_path / "home",
        ["export", "--agent-dir", str(tmp_path / "agent"), "--output", str(output)],
    )
    run.return_value = json.dumps({"machineId": machine_id, "snapshotDir": str(tmp_path / "elsewhere")})
    with pytest.raises(ValueError, match="snapshotDir"):
        stats.export_machine(tmp_path / "bundle", tmp_path / "home", tmp_path / "agent", output)
    run.return_value = json.dumps({"machineId": "not-a-uuid", "snapshotDir": str(snapshot)})
    with pytest.raises(ValueError, match="UUID"):
        stats.export_machine(tmp_path / "bundle", tmp_path / "home", tmp_path / "agent", output)


def test_shared_fixture_preserves_copies_and_distinct_equal_usage(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Copied events retain IDs, but equal-value remote calls have independent IDs."""
    exported = [
        stats.ExportedMachine(f"00000000-0000-4000-8000-{index:012}", tmp_path / str(index))
        for index in range(3)
    ]
    export = Mock(side_effect=exported)
    importer = Mock()
    monkeypatch.setattr(stats, "export_machine", export)
    monkeypatch.setattr(stats, "import_machines", importer)
    agent = tmp_path / "viewer"
    assert stats.seed_shared_stats(tmp_path / "artifact", tmp_path / "producers", agent) == tuple(exported)
    local = [json.loads(line) for line in next(agent.rglob("*.jsonl")).read_text().splitlines()][2:]
    for index in range(1, 3):
        source = tmp_path / "producers" / f"work-{index}" / ".pi" / "agent"
        remote = [json.loads(line) for line in next(source.rglob("*.jsonl")).read_text().splitlines()][2:]
        assert remote[:-1] == local
        assert remote[-1]["id"] != local[index - 1]["id"]
        assert remote[-1] | {"id": local[index - 1]["id"]} == local[index - 1]
    importer.assert_called_once_with(
        tmp_path / "artifact", tmp_path / "producers" / "import-cli", agent, tmp_path / "producers" / "shared"
    )


def test_invalid_history_inputs_fail_before_writing(tmp_path: Path) -> None:
    """Fixtures reject empty histories and naive reference times explicitly."""
    with pytest.raises(ValueError, match="at least one entry"):
        stats.write_history(tmp_path / "agent", [])
    with pytest.raises(ValueError, match="timezone-aware"):
        stats.hourly_entries(datetime(2026, 10, 13))
    assert not (tmp_path / "agent").exists()


def test_portable_missing_artifact_is_failure(tmp_path: Path) -> None:
    """Missing producer bundles are gate failures, not skips or kit-source fallbacks."""
    with pytest.raises(FileNotFoundError, match="artifact is missing"):
        stats.portable_command(tmp_path / "missing.mjs", tmp_path / "home", ["export"])
