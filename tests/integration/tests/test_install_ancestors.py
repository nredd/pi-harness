"""Deterministic syscall-boundary regressions for installer ancestor substitutions.

References:
- https://github.com/nredd/pi-harness/issues/157
"""

from __future__ import annotations

import errno
import json
import os
import shutil
from pathlib import Path
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any, cast

import pytest

from harness import install, install_paths, runtime_lock
from harness.install import (
    InstallError,
    Journal,
    Layout,
    Plan,
    RollbackError,
    UnsupportedError,
    Verified,
    journaled_path,
    locked,
    rollback,
    stage,
    write_atomic,
)
from harness.install_paths import AnchoredStore
from tests.test_install import Harness, real_snapshot, seed_existing, tree

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator


@pytest.fixture
def anchors() -> Iterator[AnchoredStore]:
    """Hold a transaction's parents for the whole test, as the installer lock does.

    Yields:
        AnchoredStore: descriptors closed at teardown.
    """
    with AnchoredStore() as store:
        yield store


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


def test_record_save_does_not_follow_swapped_agent(tmp_path: Path, anchors: AnchoredStore) -> None:
    """A swap between the write-ahead record and save cannot back up victim content."""
    layout = layout_at(tmp_path)
    target = layout.agent_dir / "settings.json"
    target.write_text("original")
    victim = tmp_path / "victim"
    victim.mkdir()
    (victim / target.name).write_text("victim")
    journal = Journal(layout, layout.backups / "run", anchors=anchors)
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
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, anchors: AnchoredStore
) -> None:
    """The actual backup-to-live syscall uses the previously opened target parent."""
    layout = layout_at(tmp_path)
    target = layout.agent_dir / "settings.json"
    target.write_text("original")
    journal = Journal(layout, layout.backups / "run", anchors=anchors)
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
        """Inject the replacement immediately before the restore syscall.

        Parameters:
            src (str | Path): rename source operand.
            dst (str | Path): rename destination operand.
            kwargs (int): source and destination directory descriptors.

        Returns:
            None: the injected swap and anchored rename complete.

        Raises:
            OSError: fixture setup or the underlying rename fails.
        """
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
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, parent_kind: str, anchors: AnchoredStore
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
    journal = Journal(layout, layout.backups / "run", anchors=anchors)
    original = os.replace
    swapped = False

    def swap(src: str | Path, dst: str | Path, **kwargs: int) -> None:
        """Substitute the ancestor after both descriptors were selected.

        Parameters:
            src (str | Path): rename source operand.
            dst (str | Path): rename destination operand.
            kwargs (int): source and destination directory descriptors.

        Returns:
            None: the injected swap and anchored rename complete.

        Raises:
            OSError: fixture setup or the underlying rename fails.
        """
        nonlocal swapped
        if Path(src).name == target.name and kwargs.get("dst_dir_fd") == journal.backup_fd:
            swapped = True
            parent.rename(held)
            parent.symlink_to(victim)
        original(src, dst, **kwargs)

    monkeypatch.setattr(os, "replace", swap)
    backup_path = journal.backups / journaled_path(layout, target)[0]

    def save() -> None:
        """Run the transaction with the syscall-boundary swap armed.

        Returns:
            None: the original is saved unless the swapped namespace is detected.

        Raises:
            OSError: the injected ancestor swap is detected.
        """
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
        """Replace the directory after the temporary was fully written.

        Parameters:
            src (str | Path): atomic replacement source operand.
            dst (str | Path): atomic replacement destination operand.
            kwargs (int): source and destination directory descriptors.

        Returns:
            None: the injected swap and anchored rename complete.

        Raises:
            OSError: fixture setup or the underlying rename fails.
        """
        parent.rename(held)
        parent.symlink_to(victim)
        original(src, dst, **kwargs)

    monkeypatch.setattr(os, "replace", swap)
    with pytest.raises(OSError, match="changed during"):
        write_atomic(parent / "state", "new")
    assert not list(victim.iterdir())
    assert (held / "state").read_text() == "new"


@pytest.mark.parametrize("path", [Path("relative/agent"), Path("/tmp/store/../agent")])
def test_anchor_refuses_noncanonical_path(path: Path) -> None:
    """Relative or `..` spellings are refused before any descriptor is opened."""
    with install_paths.AnchoredStore() as anchors:
        with pytest.raises(ValueError, match=r"is not canonical and absolute"):
            anchors.directory(path)
        assert anchors.directories == {}


def test_tree_removal_refuses_without_symlink_safe_rmtree(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A platform whose `rmtree` follows symlinks refuses tree removal and keeps the tree."""
    tree = tmp_path / "tree"
    tree.mkdir()
    (tree / "payload").write_text("kept")
    monkeypatch.setattr(install_paths, "RMTREE_SAFE", False)
    with (
        install_paths.AnchoredStore() as anchors,
        pytest.raises(OSError, match=r"^Descriptor-relative tree removal is unavailable$"),
    ):
        anchors.remove(tree)
    assert (tree / "payload").read_text() == "kept"


def test_rollback_refuses_unanchorable_parent_and_keeps_journal(tmp_path: Path) -> None:
    """A symlinked agent ancestor cannot be anchored, so recovery refuses and keeps the journal."""
    real = tmp_path / "real"
    (real / "agent").mkdir(parents=True)
    (tmp_path / "link").symlink_to(real)
    layout = Layout(tmp_path / "store", tmp_path / "link" / "agent", tmp_path / "bin")
    layout.root.mkdir()
    layout.bin_dir.mkdir()
    layout.journal.write_text("{}")
    with pytest.raises(RollbackError, match=r"^Could not anchor interrupted install parents: ") as caught:
        rollback(layout)
    cause = caught.value.__cause__
    assert isinstance(cause, OSError)
    assert cause.errno in {errno.ELOOP, errno.ENOTDIR}
    assert str(caught.value).endswith(f"journal kept at '{layout.journal}'")
    assert layout.journal.read_text() == "{}"


def replay_fixture(monkeypatch: pytest.MonkeyPatch, swap: Any, *, audit: Any = None) -> Verified:
    """Replace authenticated npm replay with a pathname writer that runs `swap` afterwards.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): module patcher.
        swap (Any): callable receiving the replay root once its bytes are written.
        audit (Any): callable receiving the replay root after the checkpoint, modeling the audit
            read; `None` reads nothing.

    Returns:
        Verified: real snapshot with an empty modeled archive inventory.
    """

    def replay(
        graph: object,
        root: Path,
        scratch: Path,
        npm: str,
        archives: object,
        *,
        checkpoint: Callable[[], None],
    ) -> None:
        """Write like npm does, by pathname, inject the swap, then run the caller's checkpoint.

        Parameters:
            graph (object): ignored modeled graph.
            root (Path): staged npm prefix.
            scratch (Path): ignored npm scratch.
            npm (str): ignored npm path.
            archives (object): ignored archive inventory.
            checkpoint (Callable[[], None]): caller's identity check before the audit.

        Returns:
            None: the modeled replay, the injected swap and the checkpoint completed.
        """
        root.mkdir(parents=True, exist_ok=True)
        (root / "node_modules" / ".bin").mkdir(parents=True)
        (root / "package.json").write_text("{}")
        swap(root)
        checkpoint()
        if audit is not None:
            audit(root)

    monkeypatch.setattr(install, "require_runtime", lambda verified: SimpleNamespace(runtime=None))
    monkeypatch.setattr(install, "selected_graphs", lambda runtime: {"core": None, "agent": None})
    monkeypatch.setattr(install, "install_graph", replay)
    monkeypatch.setattr(install, "installed_identities", lambda *args: [])
    return Verified(real_snapshot(), [], {}, archives={"core": {}, "agent": {}})


def substitute(directory: Path, held: Path, *, link: bool) -> None:
    """Move a staged directory aside and plant a symlink or a forged real directory.

    Parameters:
        directory (Path): staged directory to substitute.
        held (Path): where the genuine directory is kept.
        link (bool): plant a symlink to a victim rather than an unverified real directory.

    Returns:
        None: `directory` now names the substitute.
    """
    directory.rename(held)
    victim = held.with_name(f"{held.name}-victim")
    victim.mkdir()
    if link:
        directory.symlink_to(victim)
    else:
        directory.mkdir()
        (directory / "forged").write_text("unverified")


def test_core_launcher_is_not_created_through_swapped_prefix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A staged core swapped after replay never receives the `bin/pi` launcher."""
    layout = layout_at(tmp_path)
    staging = layout.root / "staging" / "run"
    held = tmp_path / "held-core"
    verified = replay_fixture(monkeypatch, lambda root: substitute(root, held, link=True))
    with (
        install_paths.AnchoredStore() as anchors,
        pytest.raises(InstallError, match=r"changed during the operation"),
    ):
        stage(layout, verified, Plan(install_core=True), staging, anchors=anchors)
    assert not (tmp_path / "held-core-victim" / "bin").exists()
    assert not (held / "bin").exists()


def test_core_launcher_is_created_through_held_prefix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without a swap, the launcher is created relative to the prefix held since its creation."""
    layout = layout_at(tmp_path)
    staging = layout.root / "staging" / "run"
    verified = replay_fixture(monkeypatch, lambda root: None)
    with install_paths.AnchoredStore() as anchors:
        assert stage(layout, verified, Plan(install_core=True), staging, anchors=anchors) is None
        assert staging / "core" / "bin" in anchors.directories
    assert (staging / "core" / "bin" / "pi").readlink() == Path("../node_modules/.bin/pi")
    assert (staging / "core" / install.CORE_MARKER).is_file()


@pytest.mark.parametrize("point", ["replay", "verification"])
def test_staged_agent_is_anchored_from_creation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, point: str
) -> None:
    """An unverified real directory swapped in after creation is never adopted as the agent."""
    layout = layout_at(tmp_path)
    staging = layout.root / "staging" / "run"
    agent, held = staging / "agent", tmp_path / "held-agent"
    swapped: list[Path] = []

    def swap(*args: object) -> None:
        """Substitute the staged agent at the parametrized point.

        Parameters:
            args (object): ignored replay or verification operands.

        Returns:
            None: the staged agent was substituted once.
        """
        substitute(agent, held, link=False)
        swapped.append(agent)

    verified = replay_fixture(monkeypatch, swap if point == "replay" else lambda root: None)
    monkeypatch.setattr(
        install, "verify_owned_integrity", swap if point == "verification" else lambda *a: None
    )
    # Replay-time swaps surface through the wrapped replay failure, verification-time ones raw.
    expected = InstallError if point == "replay" else OSError
    with (
        install_paths.AnchoredStore() as anchors,
        pytest.raises(expected, match=r"Install directory '.*/agent' changed during the operation"),
    ):
        stage(layout, verified, Plan(install_packages=True), staging, anchors=anchors)
    assert swapped == [agent]
    assert (agent / "forged").read_text() == "unverified"
    assert (held / "npm" / "package.json").read_text() == "{}"


def test_rollback_refuses_missing_live_parent(tmp_path: Path, anchors: AnchoredStore) -> None:
    """Recovery never invents a live parent the interrupted switch did not journal."""
    layout = layout_at(tmp_path)
    target = layout.agent_dir / "settings.json"
    target.write_text("original")
    journal = Journal(layout, layout.backups / "run", anchors=anchors)
    with journal.open_backups():
        backup = journal.record(target, target.name)
        assert backup is not None
        journal.save(target, backup)
    layout.agent_dir.rmdir()
    with pytest.raises(RollbackError, match=r"^Could not restore an interrupted install: .*No such file"):
        rollback(layout)
    assert not layout.agent_dir.exists()
    assert (layout.backups / "run" / backup.relative_to(layout.backups / "run")).read_text() == "original"
    assert layout.journal.exists()


def test_locked_refuses_parent_swapped_while_held(tmp_path: Path) -> None:
    """A live parent replaced during the locked body is reported once the body returns."""
    layout = layout_at(tmp_path)
    with (
        pytest.raises(InstallError, match=r"^Install directory changed while locked: .*agent"),
        locked(layout),
    ):
        substitute(layout.agent_dir, tmp_path / "held-agent", link=False)
    assert (tmp_path / "held-agent").is_dir()


def test_locked_refuses_non_file_lock(tmp_path: Path) -> None:
    """A lock path that is not a regular file is refused before it is opened."""
    layout = layout_at(tmp_path)
    (layout.root / "lock").mkdir()
    with (
        pytest.raises(UnsupportedError, match=r"^Lock '.*/lock' is a directory; move it aside"),
        locked(layout),
    ):
        pytest.fail("the body must not run")


def test_locked_refuses_unopenable_lock(tmp_path: Path) -> None:
    """A lock that cannot be created in the held root refuses without changing anything."""
    layout = layout_at(tmp_path)
    layout.root.chmod(0o500)
    try:
        with (
            pytest.raises(
                UnsupportedError, match=r"^Cannot safely open lock '.*/lock'; nothing changed: .*Permission"
            ),
            locked(layout),
        ):
            pytest.fail("the body must not run")
    finally:
        layout.root.chmod(0o700)
    assert not (layout.root / "lock").exists()


def test_locked_keeps_body_errors_unrelabeled(tmp_path: Path) -> None:
    """Only the post-body namespace check is reported as a changed install directory."""
    layout = layout_at(tmp_path)
    with pytest.raises(FileNotFoundError, match=r"^body failure$"), locked(layout):
        raise FileNotFoundError("body failure")


def test_rename_refuses_missing_target_parent(tmp_path: Path) -> None:
    """A rename never creates its destination parent; callers create journaled parents explicitly."""
    source, missing = tmp_path / "source", tmp_path / "missing"
    source.write_text("kept")
    with install_paths.AnchoredStore() as anchors, pytest.raises(FileNotFoundError):
        anchors.rename(source, missing / "target")
    assert not missing.exists()
    assert source.read_text() == "kept"


def restore(directory: Path, held: Path) -> None:
    """Undo `substitute`, so a later identity check sees the genuine directory again.

    Parameters:
        directory (Path): staged directory currently naming the substitute.
        held (Path): where `substitute` kept the genuine directory.

    Returns:
        None: `directory` names the genuine directory again.
    """
    if directory.is_symlink():
        directory.unlink()
    else:
        shutil.rmtree(directory)
    held.rename(directory)


def test_core_launcher_lands_in_held_prefix_after_check(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A prefix swapped between the post-replay check and `bin` creation still gets the launcher."""
    layout = layout_at(tmp_path)
    staging = layout.root / "staging" / "run"
    prefix, held = staging / "core", tmp_path / "held-core"
    verified = replay_fixture(monkeypatch, lambda root: None)
    original = os.mkdir
    swapped: list[Path] = []

    def swap(path: str | Path, mode: int = 0o777, *, dir_fd: int | None = None) -> None:
        """Substitute the prefix immediately before the launcher directory is created.

        Parameters:
            path (str | Path): directory to create.
            mode (int): permission bits.
            dir_fd (int | None): parent descriptor, when descriptor-relative.

        Returns:
            None: the injected swap and the original mkdir completed.
        """
        if Path(path).name == "bin" and not swapped:
            substitute(prefix, held, link=True)
            swapped.append(prefix)
        original(path, mode, dir_fd=dir_fd)

    monkeypatch.setattr(os, "mkdir", swap)
    with (
        install_paths.AnchoredStore() as anchors,
        pytest.raises(InstallError, match=r"Install directory '.*/core' changed during the operation"),
    ):
        stage(layout, verified, Plan(install_core=True), staging, anchors=anchors)
    assert swapped == [prefix]
    assert (held / "bin" / "pi").readlink() == Path("../node_modules/.bin/pi")
    assert not (tmp_path / "held-core-victim" / "bin").exists()


@pytest.mark.parametrize("kind", ["core", "agent"])
def test_replay_audit_reads_only_the_held_prefix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    """A swap present while `audit_install` reads is refused even if it is undone afterwards."""
    layout = layout_at(tmp_path)
    staging = layout.root / "staging" / "run"
    staged = staging / kind
    held = tmp_path / f"held-{kind}"
    audited: list[bool] = []

    def npm(npm: str, args: list[str], root: Path, env: dict[str, str]) -> None:
        """Model npm, substituting the staged tree once `ci` has run.

        Parameters:
            npm (str): ignored npm path.
            args (list[str]): npm arguments.
            root (Path): staged npm prefix.
            env (dict[str, str]): ignored environment.

        Returns:
            None: the staged tree is substituted after `ci`.
        """
        if args[0] == "ci":
            substitute(staged, held, link=False)

    def audit(graph: object, root: Path, archives: object) -> None:
        """Read the prefix by pathname, then undo the swap before the next check.

        Parameters:
            graph (object): ignored modeled graph.
            root (Path): staged npm prefix.
            archives (object): ignored archive inventory.

        Returns:
            None: the read happened and the swap was undone.
        """
        audited.append((staged / "forged").exists())
        restore(staged, held)

    graph = SimpleNamespace(manifest={}, lock={"packages": {}})
    monkeypatch.setattr(install, "require_runtime", lambda verified: SimpleNamespace(runtime=None))
    monkeypatch.setattr(install, "selected_graphs", lambda runtime: {"core": graph, "agent": graph})
    monkeypatch.setattr(install, "installed_identities", lambda *args: [])
    monkeypatch.setattr(install, "verify_owned_integrity", lambda *args: None)
    monkeypatch.setattr(runtime_lock, "run_npm", npm)
    monkeypatch.setattr(runtime_lock, "audit_install", audit)
    verified = Verified(real_snapshot(), [], {}, archives={"core": {}, "agent": {}})
    plan = Plan(install_core=kind == "core", install_packages=kind == "agent")
    with (
        install_paths.AnchoredStore() as anchors,
        pytest.raises(InstallError, match=rf"Install directory '.*/{kind}' changed during the operation"),
    ):
        stage(layout, verified, plan, staging, anchors=anchors)
    assert audited == []
    assert (held / ("npm" if kind == "agent" else ".") / "package.json").is_file()


def test_owned_integrity_reads_only_the_held_agent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A swap present while `verify_owned_integrity` reads is refused even if undone afterwards."""
    layout = layout_at(tmp_path)
    staging = layout.root / "staging" / "run"
    agent, held = staging / "agent", tmp_path / "held-agent"
    verified = replay_fixture(monkeypatch, lambda root: None)
    read: list[bool] = []

    def identities(*args: object) -> list[dict[str, str]]:
        """Read the staged manifests, then substitute the agent tree.

        Parameters:
            args (object): ignored identity operands.

        Returns:
            list[dict[str, str]]: no modeled identities.
        """
        substitute(agent, held, link=False)
        return []

    def integrity(*args: object) -> None:
        """Read the lockfile by pathname, then undo the swap before the final check.

        Parameters:
            args (object): ignored integrity operands.

        Returns:
            None: the read happened and the swap was undone.
        """
        read.append((agent / "forged").exists())
        restore(agent, held)

    monkeypatch.setattr(install, "installed_identities", identities)
    monkeypatch.setattr(install, "verify_owned_integrity", integrity)
    with (
        install_paths.AnchoredStore() as anchors,
        pytest.raises(OSError, match=r"Install directory '.*/agent' changed during the operation"),
    ):
        stage(layout, verified, Plan(install_packages=True), staging, anchors=anchors)
    assert read == []


@pytest.mark.parametrize("error", [OSError("injected"), ValueError("injected"), RuntimeError("injected")])
def test_staging_failure_reports_unchanged_live_install(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, error: Exception
) -> None:
    """Every staging failure is reported as such and leaves the live install as it was."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    before = tree(harness.layout.agent_dir)

    def fail(*args: object, **kwargs: object) -> None:
        """Fail staging after the per-run directory exists.

        Parameters:
            args (object): ignored staging operands.
            kwargs (object): ignored staging options.

        Raises:
            Exception: the parametrized staging failure.
        """
        raise error

    monkeypatch.setattr(install, "stage", fail)
    with pytest.raises(InstallError, match=r"^Staging failed; the live install was not changed: injected$"):
        harness.run(yes=True)
    assert tree(harness.layout.agent_dir) == before
    assert list((harness.layout.root / "staging").iterdir()) == []
    assert not harness.layout.journal.exists()


def test_staging_cleanup_failure_keeps_the_staging_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failed staging cleanup is attached to, never substituted for, the staging failure."""
    harness = Harness(tmp_path, monkeypatch)
    seed_existing(harness.home)
    original = install.remove

    def fail(*args: object, **kwargs: object) -> None:
        """Fail staging.

        Parameters:
            args (object): ignored staging operands.
            kwargs (object): ignored staging options.

        Raises:
            OSError: always.
        """
        raise OSError("injected")

    def stuck(path: Path, *, anchors: install_paths.AnchoredStore | None = None) -> None:
        """Refuse to remove the per-run staging directory only.

        Parameters:
            path (Path): entry to remove.
            anchors (install_paths.AnchoredStore | None): forwarded anchors.

        Raises:
            OSError: `path` is the per-run staging directory.
        """
        if path.parent.name == "staging":
            raise OSError("cleanup refused")
        original(path, anchors=anchors)

    monkeypatch.setattr(install, "stage", fail)
    monkeypatch.setattr(install, "remove", stuck)
    with pytest.raises(
        InstallError,
        match=r"^Staging failed; the live install was not changed: injected\n"
        r"Staging directory '.*/staging/[0-9a-f]{32}' was not removed: cleanup refused$",
    ):
        harness.run(yes=True)


def test_installed_identities_read_only_the_held_agent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A swap after the audit is refused before `installed_identities` reads, even if undone after."""
    layout = layout_at(tmp_path)
    staging = layout.root / "staging" / "run"
    agent, held = staging / "agent", tmp_path / "held-agent"
    verified = replay_fixture(
        monkeypatch, lambda root: None, audit=lambda root: substitute(agent, held, link=False)
    )
    read: list[bool] = []

    def identities(*args: object) -> list[dict[str, str]]:
        """Read the staged manifests by pathname, then undo the swap before the next check.

        Parameters:
            args (object): ignored identity operands.

        Returns:
            list[dict[str, str]]: no modeled identities.
        """
        read.append((agent / "forged").exists())
        restore(agent, held)
        return []

    monkeypatch.setattr(install, "installed_identities", identities)
    monkeypatch.setattr(install, "verify_owned_integrity", lambda *args: None)
    with (
        AnchoredStore() as anchors,
        pytest.raises(OSError, match=r"Install directory '.*/agent' changed during the operation"),
    ):
        stage(layout, verified, Plan(install_packages=True), staging, anchors=anchors)
    assert read == []


@pytest.mark.parametrize("parent", ["agent", "core"])
def test_commit_refuses_swapped_held_parent_and_keeps_journal(
    tmp_path: Path, anchors: AnchoredStore, parent: str
) -> None:
    """Commit checks every held parent, not just the journal's, and keeps the journal on a swap."""
    layout = layout_at(tmp_path)
    journal = Journal(layout, layout.backups / "run", anchors=anchors)
    with journal.open_backups():
        journal.persist()
    swapped = {"agent": layout.agent_dir, "core": layout.root / "core"}[parent]
    substitute(swapped, tmp_path / f"held-{parent}", link=False)
    with pytest.raises(OSError, match=rf"Install directory '.*/{parent}' changed during the operation"):
        journal.commit()
    assert json.loads(layout.journal.read_text()) == {"backups": str(journal.backups), "steps": []}


def test_install_graph_runs_checkpoint_before_audit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`install_graph` itself orders the caller's checkpoint between replay and the pathname audit."""
    events: list[str] = []
    monkeypatch.setattr(runtime_lock, "run_npm", lambda npm, args, root, env: events.append(args[0]))
    monkeypatch.setattr(runtime_lock, "audit_install", lambda *args: events.append("audit"))
    graph = SimpleNamespace(manifest={}, lock={"packages": {}})
    runtime_lock.install_graph(
        cast("runtime_lock.NpmGraph", graph),
        tmp_path / "prefix",
        tmp_path / "scratch",
        "/not-invoked/npm",
        {},
        checkpoint=lambda: events.append("checkpoint"),
    )
    assert events == ["ci", "checkpoint", "audit"]
