"""Unit tests for the quota-footer helpers (no pi process)."""

from __future__ import annotations

import json
import shutil
import subprocess
from typing import TYPE_CHECKING

import pytest

from harness.paths import chezmoi_source
from harness.quota import (
    UsageFixture,
    fixture_env,
    parse_quota_row,
    read_request_log,
    sgr_by_percent,
    snapshot,
    values,
)

if TYPE_CHECKING:
    from pathlib import Path


def test_footer_typescript_unit_suite() -> None:
    """Run the actual footer helpers and fake-clock lifecycle tests as part of every harness gate."""
    node = shutil.which("node")
    assert node is not None, "Node is required for footer tests"
    suite = chezmoi_source() / "tests" / "footer-quota.test.mjs"
    assert suite.is_file(), f"Footer unit suite is missing: '{suite}'"
    result = subprocess.run(
        [node, "--test", str(suite)], capture_output=True, text=True, timeout=30, check=False
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_snapshot_shape_and_unknown_provider() -> None:
    """Snapshots carry the router's window names; unknown providers are rejected."""
    snap = snapshot("anthropic", (10, 20), status="stale")
    assert [w["name"] for w in snap["windows"]] == ["five_hour", "seven_day"]
    assert snap["status"] == "stale"
    assert snapshot("openai-codex", None)["windows"] == []
    with pytest.raises(ValueError, match="Unknown provider"):
        snapshot("nope", (1, 2))


def test_fixture_state_omits_missing_providers(tmp_path: Path) -> None:
    """A `None` provider is absent from `snapshots`; the log reader tolerates absence."""
    fixture = UsageFixture(tmp_path / "state.json", tmp_path / "log.jsonl")
    fixture.set(anthropic=(10, 20), mode="hang")
    state = json.loads(fixture.state_path.read_text())
    assert state["mode"] == "hang"
    assert [s["provider"] for s in state["snapshots"]] == ["anthropic"]
    assert fixture.requests() == []
    fixture.log_path.write_text('{"t": 1, "refresh": true}\n\n{"t": 2}\n')
    assert read_request_log(fixture.log_path) == [{"t": 1, "refresh": True}, {"t": 2}]


def test_fixture_env_scales_timers_only_when_asked(tmp_path: Path) -> None:
    """Without a timer map there is no preload."""
    fixture = UsageFixture(tmp_path / "s.json", tmp_path / "l.jsonl")
    assert "NODE_OPTIONS" not in fixture_env(fixture)
    env = fixture_env(fixture, {60_000: 1500})
    assert json.loads(env["HARNESS_TIMER_MAP"]) == {"60000": 1500}
    assert "fast_timers.mjs" in env["NODE_OPTIONS"]


def test_parse_full_and_compact_rows() -> None:
    """Both tiers parse into provider -> values; missing data reads `--`."""
    full = parse_quota_row("x\nQuota left: Anthropic 5h 80% weekly 60% | OpenAI 5h -- weekly --  \n")
    assert full is not None
    assert values(full, "anthropic") == ["80%", "60%"]
    assert values(full, "openai-codex") == ["--", "--"]
    compact = parse_quota_row("Left: Anth 5h 80% 7d 60% | OAI 5h 9% 7d 1%")
    assert compact is not None
    assert values(compact, "openai-codex") == ["9%", "1%"]
    assert parse_quota_row("in 10 out 5 ctx 1%") is None


def test_sgr_by_percent_tracks_style_in_effect() -> None:
    """A coloured value keeps its colour; the next plain one reads the reset."""
    line = "\x1b[2mQuota left: Anthropic 5h \x1b[31m4%\x1b[39m weekly 60%\x1b[0m"
    assert sgr_by_percent(line) == {4: "\x1b[31m", 60: "\x1b[39m"}
    assert sgr_by_percent("no row 5%") == {}
