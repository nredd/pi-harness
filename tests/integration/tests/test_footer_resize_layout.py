"""Check the resize capability probe against both supported preset layouts.

References:
- https://github.com/nredd/pi-harness/issues/876
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

import pytest

from scenarios.tui.test_footer_resize import preset_shows_resets

if TYPE_CHECKING:
    from pathlib import Path


@pytest.mark.parametrize(
    ("entry", "directory", "source", "expected"),
    [
        ("./src/index.ts", "src", "export function formatResetAt() {}", True),
        ("./extensions/expanded-footer.ts", "lib", "export function formatResetAt() {}", True),
        ("./extensions/expanded-footer.ts", "lib", "export function formatQuotaRow() {}", False),
    ],
)
def test_preset_reset_capability_follows_installed_entry(
    tmp_path: Path, entry: str, directory: str, source: str, expected: bool
) -> None:
    """Read the installed layout, not another version's helper.

    Parameters:
        tmp_path (Path): Disposable installed package.
        entry (str): Declared Pi entry.
        directory (str): Helper directory for that entry.
        source (str): Installed helper contents.
        expected (bool): Whether reset labels are supported.
    """
    (tmp_path / "package.json").write_text(json.dumps({"pi": {"extensions": [entry]}}))
    (tmp_path / directory).mkdir()
    (tmp_path / directory / "footer-quota.ts").write_text(source)
    assert preset_shows_resets(tmp_path) is expected


def test_preset_reset_capability_refuses_unknown_entry(tmp_path: Path) -> None:
    """Unknown layouts fail instead of silently inspecting the old helper.

    Parameters:
        tmp_path (Path): Disposable installed package.
    """
    (tmp_path / "package.json").write_text(json.dumps({"pi": {"extensions": ["./other.ts"]}}))
    with pytest.raises(AssertionError):
        preset_shows_resets(tmp_path)
