"""Single-load session-kit selection without chezmoi or a real pi process.

References:
- https://github.com/nredd/pi-session-kit
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING
from unittest.mock import Mock

import pytest

from harness import session_kit
from harness.sandbox import Sandbox

if TYPE_CHECKING:
    from pathlib import Path

PIN = "git:github.com/nredd/pi-session-kit@v0.1.0"


@pytest.fixture
def box(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Sandbox:
    """Create standalone sandbox settings, without inherited local overrides."""
    monkeypatch.delenv("HARNESS_LOCAL", raising=False)
    agent = tmp_path / "agent"
    agent.mkdir()
    return Sandbox(tmp_path, tmp_path / "home", agent, tmp_path / "work")


def checkout(path: Path) -> Path:
    """Create a minimal kit entry point and return its checkout root."""
    (path / "src").mkdir(parents=True)
    (path / "src" / "index.ts").write_text("export default () => {};\n")
    return path


@pytest.mark.parametrize("package", [PIN, {"source": PIN, "extensions": ["src/index.ts"]}])
def test_configured_pin_has_no_explicit_duplicate(box: Sandbox, package: object) -> None:
    """Configured strings and filtered objects load via packages, never `-e`."""
    box.patch_json("settings.json", {"packages": ["npm:other", package]})
    original = box.settings_path.read_text()
    assert session_kit.kit_args(box) == []
    assert box.settings_path.read_text() == original


@pytest.mark.parametrize("explicit", [False, True])
@pytest.mark.parametrize("object_form", [False, True])
def test_local_override_replaces_package_once(
    box: Sandbox, monkeypatch: pytest.MonkeyPatch, explicit: bool, object_form: bool
) -> None:
    """Local overrides preserve package filters and other settings without a second load."""
    local = checkout(box.root / "local")
    monkeypatch.setenv("HARNESS_LOCAL", f"pi-session-kit={local}")
    package = {"source": PIN, "extensions": ["src/index.ts"]} if object_form else PIN
    box.patch_json("settings.json", {"packages": ["npm:other", package], "theme": "dark"})
    args = session_kit.kit_args(box, explicit=explicit)
    assert args == (["-e", str(local / "src" / "index.ts")] if explicit else [])
    expected = {"source": str(local), "extensions": ["src/index.ts"]} if object_form else str(local)
    assert box.settings() == {"packages": ["npm:other", expected], "theme": "dark"}
    assert session_kit.kit_args(box, explicit=explicit) == args


@pytest.mark.parametrize("explicit", [False, True])
def test_explicit_fixture_uses_selected_pin(
    box: Sandbox, monkeypatch: pytest.MonkeyPatch, explicit: bool
) -> None:
    """No-extensions fixtures resolve the installed pin, not the default local checkout."""
    installed = checkout(box.root / "installed")
    resolve = Mock(return_value=installed)
    monkeypatch.setattr(session_kit, "pinned_checkout", resolve)
    box.patch_json("settings.json", {"packages": [PIN]})
    assert session_kit.kit_args(box, explicit=explicit) == (
        ["-e", str(installed / "src" / "index.ts")] if explicit else []
    )
    if explicit:
        resolve.assert_called_once_with("pi-session-kit", [PIN])
    else:
        resolve.assert_not_called()


@pytest.mark.parametrize("override", [False, True])
def test_no_package_falls_back_to_checkout(
    box: Sandbox, monkeypatch: pytest.MonkeyPatch, override: bool
) -> None:
    """Pre-pin sandboxes use one checkout entry, honoring a local override."""
    monkeypatch.setattr(session_kit, "CODE_DIR", box.root)
    local = checkout(box.root / ("override" if override else "pi-session-kit"))
    if override:
        monkeypatch.setenv("HARNESS_LOCAL", f"pi-session-kit={local}")
    assert session_kit.kit_args(box) == ["-e", str(local / "src" / "index.ts")]
    assert box.settings() == {}


def test_missing_checkout_fails_not_skips(box: Sandbox, monkeypatch: pytest.MonkeyPatch) -> None:
    """Missing pre-pin source is a real failure and does not mutate settings."""
    monkeypatch.setattr(session_kit, "CODE_DIR", box.root)
    with pytest.raises(FileNotFoundError, match="entry point"):
        session_kit.kit_args(box)
    assert box.settings() == {}


def test_missing_override_does_not_patch_pin(box: Sandbox, monkeypatch: pytest.MonkeyPatch) -> None:
    """Validate the override before changing sandbox packages."""
    monkeypatch.setenv("HARNESS_LOCAL", f"pi-session-kit={box.root / 'missing'}")
    box.patch_json("settings.json", {"packages": [PIN]})
    with pytest.raises(FileNotFoundError, match="entry point"):
        session_kit.kit_args(box)
    assert json.loads(box.settings_path.read_text()) == {"packages": [PIN]}
