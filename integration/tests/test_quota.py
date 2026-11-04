"""Usage-fixture state, sandbox patching and pane environment for the quota-footer scenario; no Pi process.

References:
- https://github.com/nredd/pi-subscription-router
- https://github.com/nredd/pi-harness/blob/main/integration/providers/usage_fixture.ts
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

import pytest

from harness import quota
from harness.sandbox import Sandbox, build_sandbox

if TYPE_CHECKING:
    from pathlib import Path


def installed_package(root: Path, name: str) -> str:
    """Create a local package with a real manifest and return its path source.

    Parameters:
        root (Path): directory holding the package.
        name (str): manifest `name`.

    Returns:
        str: absolute path source, as `pi install` records a local package.
    """
    directory = root / name.rsplit("/", 1)[-1]
    directory.mkdir(parents=True)
    (directory / "package.json").write_text(json.dumps({"name": name, "version": "1.0.0"}))
    return str(directory)


def stacked_box(tmp_path: Path) -> tuple[Sandbox, list[object]]:
    """Build a sandbox whose settings declare the router between two other packages.

    Parameters:
        tmp_path (Path): private sandbox and package roots.

    Returns:
        tuple[Sandbox, list[object]]: the sandbox and its declared `packages`, in order.
    """
    box = build_sandbox(tmp_path / "box")
    packages: list[object] = [
        installed_package(tmp_path / "pkgs", "@nredd/pi-preset"),
        {"source": installed_package(tmp_path / "pkgs", "@nredd/pi-subscription-router"), "autoload": True},
        {"source": installed_package(tmp_path / "pkgs", "pi-session-kit")},
    ]
    box.patch_json("settings.json", {"packages": packages, "quietStartup": True})
    return box, packages


def test_snapshot_carries_the_router_contract_for_each_provider() -> None:
    """Every window has the reported span and reset; `expiresAt` is an hour out."""
    assert quota.snapshot("anthropic", (20, 40.5), now_ms=1_000) == {
        "provider": "anthropic",
        "status": "available",
        "windows": [
            {
                "name": "five_hour",
                "usedPercent": 20,
                "scope": "provider",
                "resetAt": 3_601_000,
                "durationMs": 18_000_000,
                "spanSource": "reported",
            },
            {
                "name": "seven_day",
                "usedPercent": 40.5,
                "scope": "provider",
                "resetAt": 3_601_000,
                "durationMs": 604_800_000,
                "spanSource": "reported",
            },
        ],
        "retrievedAt": 1_000,
        "expiresAt": 1_000 + quota.FRESH_FOR_MS,
    }
    codex = quota.snapshot("openai-codex", None, status="stale", now_ms=5)
    assert (codex["windows"], codex["status"]) == ([], "stale")


def test_snapshot_defaults_to_the_wall_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    """An omitted `now_ms` reads `time.time` once, in milliseconds.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): fixed clock.
    """
    monkeypatch.setattr(quota.time, "time", lambda: 1_700_000_000.25)
    built = quota.snapshot("openai-codex", (1, 2))
    assert built["retrievedAt"] == 1_700_000_000_250
    assert [window["name"] for window in built["windows"]] == ["5h", "7d"]


def test_snapshot_refuses_a_provider_the_router_does_not_collect() -> None:
    """Unknown providers fail loudly instead of producing a window-less snapshot."""
    with pytest.raises(ValueError, match="Unknown provider: 'gemini'"):
        quota.snapshot("gemini", (1, 2), now_ms=0)


def test_set_rewrites_state_and_omits_missing_providers(tmp_path: Path) -> None:
    """Each `set` replaces the whole state file the TypeScript fixture re-reads.

    Parameters:
        tmp_path (Path): private state and log files.
    """
    fixture = quota.UsageFixture(tmp_path / "state.json", tmp_path / "log.jsonl")
    fixture.set(anthropic=(20, 40), codex=(30, 50))
    state = json.loads(fixture.state_path.read_text())
    assert (state["mode"], state["blocks"]) == ("ok", [])
    assert [(s["provider"], s["status"]) for s in state["snapshots"]] == [
        ("anthropic", "available"),
        ("openai-codex", "available"),
    ]
    assert [w["usedPercent"] for w in state["snapshots"][1]["windows"]] == [30, 50]
    fixture.set(codex=(90, 95), mode="error", statuses=("available", "unavailable"))
    state = json.loads(fixture.state_path.read_text())
    assert state["mode"] == "error"
    assert [(s["provider"], s["status"]) for s in state["snapshots"]] == [("openai-codex", "unavailable")]
    fixture.set()
    assert json.loads(fixture.state_path.read_text()) == {"mode": "ok", "snapshots": [], "blocks": []}
    assert not fixture.log_path.exists()


def test_install_removes_only_the_router_and_seeds_empty_state(tmp_path: Path) -> None:
    """The router package goes (it would race the fixture); every other entry and setting stays.

    Parameters:
        tmp_path (Path): private sandbox and package roots.
    """
    box, packages = stacked_box(tmp_path)
    fixture = quota.install_usage_fixture(box)
    assert fixture == quota.UsageFixture(box.root / "usage-state.json", box.root / "usage-requests.jsonl")
    assert json.loads(fixture.state_path.read_text()) == {"mode": "ok", "snapshots": [], "blocks": []}
    settings = box.settings()
    assert settings["packages"] == [packages[0], packages[2]]
    assert settings["quietStartup"] is True
    assert settings["retry"] == {"enabled": False}


def test_install_can_keep_the_router(tmp_path: Path) -> None:
    """`keep_router` seeds state without rewriting settings.

    Parameters:
        tmp_path (Path): private sandbox and package roots.
    """
    box, _ = stacked_box(tmp_path)
    before = box.settings_path.read_bytes()
    fixture = quota.install_usage_fixture(box, keep_router=True)
    assert fixture.state_path.is_file()
    assert box.settings_path.read_bytes() == before


def test_install_refuses_a_stack_without_the_router(tmp_path: Path) -> None:
    """A stack that never declared the router is a fixture error, not a silent no-op.

    Parameters:
        tmp_path (Path): private sandbox and package roots.
    """
    box = build_sandbox(tmp_path / "box")
    box.patch_json("settings.json", {"packages": [installed_package(tmp_path / "pkgs", "pi-session-kit")]})
    before = box.settings_path.read_bytes()
    with pytest.raises(LookupError, match="'pi-subscription-router' is not declared"):
        quota.install_usage_fixture(box)
    assert box.settings_path.read_bytes() == before


def test_fixture_env_points_the_fixture_at_state_log_and_timers(tmp_path: Path) -> None:
    """State/log variables follow the fixture; the timer preload is opt-in.

    Parameters:
        tmp_path (Path): private state and log locations.
    """
    fixture = quota.UsageFixture(tmp_path / "state.json", tmp_path / "log.jsonl")
    files = {"HARNESS_USAGE_STATE": str(fixture.state_path), "HARNESS_USAGE_LOG": str(fixture.log_path)}
    assert quota.fixture_env(fixture) == files
    assert quota.fixture_env(fixture, {}) == files
    timers = {
        "HARNESS_TIMER_MAP": json.dumps({"60000": 1500, "12000": 800}),
        "NODE_OPTIONS": f"--import {quota.FAST_TIMERS_PRELOAD}",
    }
    assert quota.fixture_env(fixture, quota.FAST_TIMERS) == files | timers
    assert quota.fixture_env(None, quota.FAST_TIMERS) == timers
    assert quota.fixture_env(None) == {}
