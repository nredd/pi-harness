"""Unit tests for `harness.pinned`: scenarios resolve repos from the chezmoi pins."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from harness import pinned

if TYPE_CHECKING:
    from pathlib import Path

PACKAGES: list[object] = ["git:github.com/nredd/pi-subagents@v1.0.0", {"source": "npm:something"}]


def test_override_wins_without_touching_pins(tmp_path: Path) -> None:
    assert pinned.pinned_checkout("pi-subagents", [], {"pi-subagents": tmp_path}) == tmp_path


def test_unpinned_repo_is_an_error() -> None:
    with pytest.raises(LookupError, match="not a pinned git package"):
        pinned.pinned_checkout("other", PACKAGES)


def test_installed_checkout_on_the_pin_is_used(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    installed = tmp_path / "git" / "github.com" / "nredd" / "pi-subagents"
    installed.mkdir(parents=True)
    monkeypatch.setattr(pinned, "LIVE_AGENT_DIR", tmp_path)
    monkeypatch.setattr(pinned, "checkout_matches_ref", lambda *_: (True, ""))
    assert pinned.pinned_checkout("pi-subagents", PACKAGES) == installed


def test_drifted_install_falls_back_to_a_pinned_clone(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    installed = tmp_path / "git" / "github.com" / "nredd" / "pi-subagents"
    installed.mkdir(parents=True)
    cloned = tmp_path / "clone"
    monkeypatch.setattr(pinned, "LIVE_AGENT_DIR", tmp_path)
    monkeypatch.setattr(pinned, "checkout_matches_ref", lambda *_: (False, "drift"))
    monkeypatch.setattr(pinned, "clone_at_pin", lambda pin: cloned if pin.ref == "v1.0.0" else installed)
    assert pinned.pinned_checkout("pi-subagents", PACKAGES) == cloned
