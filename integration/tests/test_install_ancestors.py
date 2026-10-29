"""Deterministic syscall-boundary regressions for installer ancestor substitutions.

References:
- https://github.com/nredd/pi-harness/issues/157
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from harness.install import Journal, Layout, RollbackError, journaled_path, rollback, write_atomic


def layout_at(path: Path) -> Layout:
    """Create canonical, disjoint roots for a transaction fixture.

    Parameters:
        path (Path): disposable fixture root.

    Returns:
        Layout: initialized installer paths.
    """
    layout = Layout(path / "store", path / "agent", path / "bin")
    for directory in (layout.root, layout.agent_dir, layout.bin_dir):
        directory.mkdir()
    return layout


def test_record_save_does_not_follow_swapped_agent(tmp_path: Path) -> None:
    """A swap between the write-ahead record and save cannot back up victim content."""
    layout = layout_at(tmp_path)
    target = layout.agent_dir / "settings.json"
    target.write_text("original")
    victim = tmp_path / "victim"
    victim.mkdir()
    (victim / target.name).write_text("victim")
    journal = Journal(layout, layout.backups / "run")
    with journal.open_backups():
        backup = journal.record(target, target.name)
        assert backup is not None
        layout.agent_dir.rename(tmp_path / "held-agent")
        layout.agent_dir.symlink_to(victim)
        try:
            with pytest.raises(OSError, match="changed during"):
                journal.save(target, backup)
        finally:
            layout.agent_dir.unlink()
            (tmp_path / "held-agent").rename(layout.agent_dir)
    assert (victim / target.name).read_text() == "victim"
    assert target.read_text() == "original"


def test_restore_rename_does_not_follow_swapped_parent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The actual backup-to-live syscall uses the previously opened target parent."""
    layout = layout_at(tmp_path)
    target = layout.agent_dir / "settings.json"
    target.write_text("original")
    journal = Journal(layout, layout.backups / "run")
    with journal.open_backups():
        backup = journal.record(target, target.name)
        assert backup is not None
        journal.save(target, backup)
    victim = tmp_path / "victim"
    victim.mkdir()
    (victim / target.name).write_text("victim")
    original = os.replace
    swapped = False

    def swap(src: str | Path, dst: str | Path, **kwargs: int) -> None:
        """Inject the replacement immediately before the restore syscall."""
        nonlocal swapped
        if Path(src).name == target.name and kwargs.get("src_dir_fd") is not None and not swapped:
            swapped = True
            layout.agent_dir.rename(tmp_path / "held-agent")
            layout.agent_dir.symlink_to(victim)
        original(src, dst, **kwargs)

    monkeypatch.setattr(os, "replace", swap)
    with pytest.raises(RollbackError):
        rollback(layout)
    assert swapped
    assert (victim / target.name).read_text() == "victim"
    assert (tmp_path / "held-agent" / target.name).read_text() == "original"
    assert layout.journal.exists()


@pytest.mark.parametrize("parent_kind", ["agent", "bin", "core", "state", "ancestor"])
def test_save_syscall_anchors_both_parents(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, parent_kind: str
) -> None:
    """A swap at the actual save syscall cannot select a substituted source tree."""
    namespace = tmp_path / "namespace"
    namespace.mkdir()
    layout = layout_at(namespace)
    (layout.root / "core").mkdir()
    target = {
        "agent": layout.agent_dir / "settings.json",
        "bin": layout.link,
        "core": layout.core("v1.3.0-nredd.8"),
        "state": layout.state,
        "ancestor": layout.agent_dir / "settings.json",
    }[parent_kind]
    if parent_kind == "core":
        target.mkdir()
        (target / "payload").write_text("original")
    else:
        target.write_text("original")
    parent = namespace if parent_kind == "ancestor" else target.parent
    victim, held = tmp_path / "victim", tmp_path / "held"
    victim.mkdir()
    victim_target = victim / target.relative_to(parent)
    victim_target.parent.mkdir(parents=True, exist_ok=True)
    if parent_kind == "core":
        victim_target.mkdir()
        (victim_target / "payload").write_text("victim")
    else:
        victim_target.write_text("victim")
    journal = Journal(layout, layout.backups / "run")
    original = os.replace
    swapped = False

    def swap(src: str | Path, dst: str | Path, **kwargs: int) -> None:
        """Substitute the ancestor after both descriptors were selected."""
        nonlocal swapped
        if Path(src).name == target.name and kwargs.get("dst_dir_fd") == journal.backup_fd:
            swapped = True
            parent.rename(held)
            parent.symlink_to(victim)
        original(src, dst, **kwargs)

    monkeypatch.setattr(os, "replace", swap)
    backup_path = journal.backups / journaled_path(layout, target)[0]

    def save() -> None:
        """Run the transaction with the syscall-boundary swap armed."""
        with journal.open_backups():
            backup = journal.record(target, backup_path.name)
            assert backup is not None
            journal.save(target, backup)

    with pytest.raises(OSError, match="changed during"):
        save()
    assert swapped
    payload = victim_target / "payload" if parent_kind == "core" else victim_target
    assert payload.read_text() == "victim"
    saved = held / backup_path.relative_to(parent) if backup_path.is_relative_to(parent) else backup_path
    payload = saved / "payload" if parent_kind == "core" else saved
    assert payload.read_text() == "original"


def test_atomic_parent_swap_cannot_redirect_write(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A parent substituted at atomic replace never receives the new file."""
    parent, held, victim = tmp_path / "parent", tmp_path / "held", tmp_path / "victim"
    parent.mkdir()
    victim.mkdir()
    original = os.replace

    def swap(src: str | Path, dst: str | Path, **kwargs: int) -> None:
        """Replace the directory after the temporary was fully written."""
        parent.rename(held)
        parent.symlink_to(victim)
        original(src, dst, **kwargs)

    monkeypatch.setattr(os, "replace", swap)
    with pytest.raises(OSError, match="changed during"):
        write_atomic(parent / "state", "new")
    assert not list(victim.iterdir())
    assert (held / "state").read_text() == "new"
