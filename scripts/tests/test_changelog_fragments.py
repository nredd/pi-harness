"""Exercise fragment validation and folding through disposable package trees.

References:
    https://github.com/nredd/pi-harness/issues/932
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import changelog_fragments

CHANGELOG = "# Changelog\n\n## [Unreleased]\n\n### Fixed\n- Legacy.\n\n## [1.0.0]\n\n- Released.\n"
BULLET = "- New fix ([#932](https://github.com/nredd/pi-harness/issues/932)).\n"


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """Create a package with a changelog and one valid fragment.

    Parameters:
        tmp_path (Path): Disposable root.

    Returns:
        Path: Populated repository root.
    """
    package = tmp_path / "packages/subagents"
    changes = package / "changes"
    changes.mkdir(parents=True)
    (package / "CHANGELOG.md").write_text(CHANGELOG)
    (changes / "932.fixed.md").write_text(BULLET)
    return tmp_path


def test_fold_is_explicit_preserves_history_and_is_idempotent(repo: Path) -> None:
    """Validate without mutation, fold once, then safely repeat on the consumed tree.

    Parameters:
        repo (Path): Disposable package tree.

    Returns:
        None: Assert exact history preservation and idempotence.
    """
    package = repo / "packages/subagents"
    changelog = package / "CHANGELOG.md"
    fragment = package / "changes/932.fixed.md"
    changelog_fragments.run(repo, fold=False)
    assert changelog.read_text() == CHANGELOG
    assert fragment.exists()
    changelog_fragments.run(repo, fold=True)
    expected = CHANGELOG.replace("- Legacy.\n", "- Legacy.\n" + BULLET)
    assert changelog.read_text() == expected
    assert not fragment.exists()
    changelog_fragments.run(repo, fold=True)
    assert changelog.read_text() == expected
    (package / "changes").rmdir()
    changelog_fragments.run(repo, fold=False)


@pytest.mark.parametrize(
    "name",
    [
        "0.fixed.md",
        "01.fixed.md",
        "-1.fixed.md",
        "932.unknown.md",
        "933.Fixed.md",
        "932.fixed.md.bak",
        "932.md",
        "\uff19\uff13\uff12.fixed.md",
        "README.md",
        "a.json",
        ".hidden",
        "nested",
    ],
)
def test_invalid_entries_refuse_without_mutation(repo: Path, name: str) -> None:
    """Require every entry to use the one closed filename grammar.

    Parameters:
        repo (Path): Disposable package tree.
        name (str): Invalid entry name.

    Returns:
        None: Assert refusal without any input mutation.
    """
    package = repo / "packages/subagents"
    invalid = package / "changes" / name
    invalid.write_text(BULLET)
    with pytest.raises(ValueError, match="Invalid fragment path"):
        changelog_fragments.run(repo, fold=True)
    assert (package / "CHANGELOG.md").read_text() == CHANGELOG
    assert invalid.exists()
    assert (package / "changes/932.fixed.md").exists()
    assert not (package / ".changelog-fold.lock").exists()


@pytest.mark.parametrize(
    "payload",
    [
        "",
        "- \n",
        BULLET.rstrip(),
        BULLET + "\n",
        " " + BULLET,
        BULLET + "- Second.\n",
        BULLET.replace("New fix", "New\tfix"),
        BULLET.replace("New fix", "New\u0085fix"),
        BULLET.replace("New fix", "New\u2028fix"),
        BULLET.replace("New fix", "New\u2029fix"),
        BULLET.replace("New fix", "New\u007ffix"),
        BULLET.replace("New fix", "New\x00fix"),
        BULLET.replace(".\n", ". \n"),
        BULLET.replace("issues/932", "pull/932"),
        BULLET.replace("932", "931"),
        BULLET.replace("\n", "\r\n"),
        "---\ncategory: fixed\n---\n" + BULLET,
    ],
)
def test_payload_is_one_attributed_exact_bullet(repo: Path, payload: str) -> None:
    """Reject frontmatter, extra lines, controls and missing/mismatched issue links.

    Parameters:
        repo (Path): Disposable package tree.
        payload (str): Invalid fragment payload.

    Returns:
        None: Assert rejected bytes remain intact.
    """
    target = repo / "packages/subagents/changes/932.fixed.md"
    target.write_bytes(payload.encode())
    with pytest.raises(ValueError, match="Expected one exact bullet"):
        changelog_fragments.run(repo, fold=True)
    assert target.read_bytes() == payload.encode()
    assert (repo / "packages/subagents/CHANGELOG.md").read_text() == CHANGELOG


@pytest.mark.parametrize(
    "relative",
    [
        "packages",
        "packages/subagents",
        "packages/subagents/changes",
        "packages/subagents/CHANGELOG.md",
        "packages/subagents/changes/932.fixed.md",
        "packages/subagents/.changelog-fold.lock",
    ],
)
def test_symlinks_are_refused(repo: Path, relative: str, tmp_path: Path) -> None:
    """Reject a linked ancestor, directory, changelog, fragment or lock.

    Parameters:
        repo (Path): Disposable package tree.
        relative (str): Component to replace with a symlink.
        tmp_path (Path): Temporary directory holding the link destination.

    Returns:
        None: Assert symlink refusal.
    """
    path = repo / relative
    outside = tmp_path / "outside"
    if path.exists():
        path.rename(outside)
    else:
        outside.mkdir()
    path.symlink_to(outside)
    with pytest.raises(ValueError, match=r"symlink|Invalid fragment path"):
        changelog_fragments.run(repo, fold=True)


def test_nonregular_duplicate_and_invalid_utf8_fragments(repo: Path) -> None:
    """Reject directories, duplicate exact bullets and undecodable source data.

    Parameters:
        repo (Path): Disposable package tree.

    Returns:
        None: Assert each invalid input is rejected.
    """
    changes = repo / "packages/subagents/changes"
    directory = changes / "933.fixed.md"
    directory.mkdir()
    with pytest.raises(ValueError, match="Invalid fragment path"):
        changelog_fragments.run(repo, fold=False)
    directory.rmdir()
    duplicate = BULLET.replace(".\n", " ([#933](https://github.com/nredd/pi-harness/issues/933)).\n")
    (changes / "932.fixed.md").write_text(duplicate)
    (changes / "933.fixed.md").write_text(duplicate)
    with pytest.raises(ValueError, match="Duplicate fragment bullet"):
        changelog_fragments.run(repo, fold=True)
    (changes / "933.fixed.md").write_bytes(b"\xff")
    with pytest.raises(UnicodeDecodeError):
        changelog_fragments.run(repo, fold=False)


@pytest.mark.parametrize(
    "text",
    [
        "# Empty\n",
        "## [1.0.0]\n\n## [Unreleased]\n",
        "## [Unreleased]\n## [Unreleased]\n",
        "## [Unreleased]\n### Unknown\n",
        "## [Unreleased]\n### fixed\n",
        "## [Unreleased]\n- Orphan.\n",
        "## [Unreleased]\n### Fixed\n- Duplicate.\n- Duplicate.\n",
        "## [Unreleased]\n### Fixed\n- Unterminated",
        "## [Unreleased]\nBad data\n",
        "## [Unreleased]\n### Added\n" + BULLET,
    ],
)
def test_ambiguous_changelog_refuses_without_deleting(repo: Path, text: str) -> None:
    """Refuse malformed headings, bullets, categories and conflicting retry data.

    Parameters:
        repo (Path): Disposable package tree.
        text (str): Malformed changelog bytes decoded as text.

    Returns:
        None: Assert the changelog and fragment remain intact.
    """
    package = repo / "packages/subagents"
    target = package / "CHANGELOG.md"
    target.write_text(text)
    with pytest.raises(ValueError, match=r"Expected|Invalid|Ambiguous|Malformed|conflicts"):
        changelog_fragments.run(repo, fold=True)
    assert target.read_text() == text
    assert (package / "changes/932.fixed.md").read_text() == BULLET


def test_order_empty_categories_blockquote_and_no_released_section(repo: Path) -> None:
    """Sort issues, retain warnings/repeated headings and add missing categories.

    Parameters:
        repo (Path): Disposable package tree.

    Returns:
        None: Assert literal ordered output, including empty/repeated legacy categories.
    """
    package = repo / "packages/subagents"
    changes = package / "changes"
    (changes / "932.fixed.md").unlink()
    for number, category in [(20, "fixed"), (3, "fixed"), (4, "added"), (5, "changed")]:
        (changes / f"{number}.{category}.md").write_text(BULLET.replace("932", str(number)))
    original = "## [Unreleased]\n\n### Changed\n\n> Legacy warning.\n\n### Changed\n\n"
    (package / "CHANGELOG.md").write_text(original)
    changelog_fragments.run(repo, fold=True)
    assert (package / "CHANGELOG.md").read_text() == (
        original
        + "\n### Added\n"
        + BULLET.replace("932", "4")
        + "\n"
        + "\n### Fixed\n"
        + BULLET.replace("932", "3")
        + BULLET.replace("932", "20")
        + "\n"
    ).replace("### Changed\n\n\n### Added", "### Changed\n" + BULLET.replace("932", "5") + "\n\n### Added")


@pytest.mark.parametrize("boundary", ["replace", "delete"])
def test_interrupted_fold_keeps_inputs_or_is_restart_safe(
    repo: Path, monkeypatch: pytest.MonkeyPatch, boundary: str
) -> None:
    """Inject filesystem failures before replacement and during consumption.

    Parameters:
        repo (Path): Disposable package tree.
        monkeypatch (pytest.MonkeyPatch): Filesystem boundary fault injection.
        boundary (str): Replacement or deletion boundary to fail.

    Returns:
        None: Assert retry preserves and consumes each exact bullet once.
    """
    package = repo / "packages/subagents"
    original_replace = Path.replace
    original_unlink = Path.unlink

    def fail_replace(source: Path, target: Path) -> None:
        """Fail the atomic replacement boundary.

        Parameters:
            source (Path): Temporary replacement file.
            target (Path): Changelog destination.

        Returns:
            None: Never returns normally.

        Raises:
            OSError: Simulated replacement refusal.
        """
        raise OSError("replacement refused")

    def fail_delete(path: Path, *, missing_ok: bool = False) -> None:
        """Fail fragment consumption, not temporary cleanup.

        Parameters:
            path (Path): File to remove.
            missing_ok (bool): Permit absent temporary files.

        Returns:
            None: Remove temporary files normally.

        Raises:
            OSError: Simulated fragment deletion refusal.
        """
        if path.name == "932.fixed.md":
            raise OSError("deletion refused")
        original_unlink(path, missing_ok=missing_ok)

    if boundary == "replace":
        monkeypatch.setattr(Path, "replace", fail_replace)
    else:
        monkeypatch.setattr(Path, "unlink", fail_delete)
    with pytest.raises(OSError, match="refused"):
        changelog_fragments.run(repo, fold=True)
    assert (package / "changes/932.fixed.md").exists()
    assert not list(package.glob(".changelog-*"))
    if boundary == "replace":
        assert (package / "CHANGELOG.md").read_text() == CHANGELOG
    monkeypatch.setattr(Path, "replace", original_replace)
    monkeypatch.setattr(Path, "unlink", original_unlink)
    changelog_fragments.run(repo, fold=True)
    assert (package / "CHANGELOG.md").read_text() == CHANGELOG.replace("- Legacy.\n", "- Legacy.\n" + BULLET)


def test_existing_lock_and_missing_inputs_fail_closed(repo: Path) -> None:
    """Refuse existing locks and absent required inputs.

    Parameters:
        repo (Path): Disposable package tree.

    Returns:
        None: Assert refusal and lock cleanup without stealing an existing lock.
    """
    package = repo / "packages/subagents"
    lock = package / ".changelog-fold.lock"
    lock.mkdir()
    with pytest.raises(FileExistsError):
        changelog_fragments.run(repo, fold=True)
    assert lock.is_dir()
    lock.rmdir()
    (package / "CHANGELOG.md").unlink()
    with pytest.raises(FileNotFoundError):
        changelog_fragments.run(repo, fold=True)
    assert not lock.exists()


def test_real_cli_success_and_failure(repo: Path) -> None:
    """Exercise stdlib CLI success, explicit folding and error exit status.

    Parameters:
        repo (Path): Disposable package tree.

    Returns:
        None: Assert actual CLI success and failure exits.
    """
    cmd = [sys.executable, str(Path(changelog_fragments.__file__)), "--repo", str(repo)]
    checked = subprocess.run(cmd, capture_output=True, text=True, check=False)
    assert checked.returncode == 0, checked.stderr
    folded = subprocess.run([*cmd, "--fold"], capture_output=True, text=True, check=False)
    assert folded.returncode == 0, folded.stderr
    (repo / "packages/subagents/CHANGELOG.md").write_text("invalid")
    refused = subprocess.run(cmd, capture_output=True, text=True, check=False)
    assert refused.returncode == 1
    assert "Cannot process changelog fragments" in refused.stderr
