"""Offline sandboxes retain Pi's cached public helper binaries without sharing writes.

References:
- Pi helper discovery: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/utils/tools-manager.ts
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from harness import sandbox

if TYPE_CHECKING:
    from pathlib import Path


@pytest.mark.parametrize("name", ["fd", "rg", "fd.exe", "rg.exe"])
def test_cached_helper_is_copied_not_linked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str
) -> None:
    """Retain cached helper bytes and executable mode without sharing mutable live state.

    Parameters:
        tmp_path (Path): isolated test directory.
        monkeypatch (pytest.MonkeyPatch): replace the live agent directory.
        name (str): one supported cached helper filename.
    """
    live = tmp_path / "live"
    binaries = live / "bin"
    binaries.mkdir(parents=True)
    helper = binaries / name
    helper.write_bytes(b"public helper fixture")
    helper.chmod(0o755)
    (binaries / "private-file").write_text("do not copy")
    template = tmp_path / "template"
    (template / ".pi" / "agent").mkdir(parents=True)
    monkeypatch.setattr(sandbox, "LIVE_AGENT_DIR", live)

    box = sandbox.build_sandbox(tmp_path / "box", template)
    copied = box.agent_dir / "bin" / name
    assert copied.is_file()
    assert not copied.is_symlink()
    assert copied.read_bytes() == helper.read_bytes()
    assert copied.stat().st_mode == helper.stat().st_mode
    assert not (copied.parent / "private-file").exists()
    copied.write_bytes(b"sandbox replacement")
    assert helper.read_bytes() == b"public helper fixture"


def test_absent_helpers_remain_absent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Machines without cached helpers still use Pi's ordinary system-PATH discovery.

    Parameters:
        tmp_path (Path): isolated test directory.
        monkeypatch (pytest.MonkeyPatch): replace the live agent directory.
    """
    template = tmp_path / "template"
    (template / ".pi" / "agent").mkdir(parents=True)
    monkeypatch.setattr(sandbox, "LIVE_AGENT_DIR", tmp_path / "missing")
    box = sandbox.build_sandbox(tmp_path / "box", template)
    assert not (box.agent_dir / "bin").exists()
