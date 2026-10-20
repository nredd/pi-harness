"""Test CI changed-path classification against real disposable Git repositories."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ci_paths

GIT = "git"


def git(repo: Path, *args: str) -> str:
    """Run Git in a disposable repository.

    Parameters:
        repo: Repository to operate in.
        args: Git arguments after `-C <repo>`.

    Returns:
        Stripped standard output.
    """
    completed = subprocess.run([GIT, "-C", str(repo), *args], check=True, capture_output=True, text=True)
    return completed.stdout.strip()


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """Create a real repository with an initial commit.

    Parameters:
        tmp_path: Pytest temporary directory.

    Returns:
        Initialized repository.
    """
    git(tmp_path, "init", "-q", "-b", "main")
    git(tmp_path, "config", "user.email", "t@example.invalid")
    git(tmp_path, "config", "user.name", "t")
    git(tmp_path, "config", "commit.gpgsign", "false")
    (tmp_path / "tracked.txt").write_text("initial\n", encoding="utf-8")
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-q", "-m", "initial")
    return tmp_path


def classify_change(repo: Path, files: dict[str, str]) -> ci_paths.ChangeClassification:
    """Commit changed files and classify the resulting real Git diff.

    Parameters:
        repo: Disposable repository.
        files: Relative paths and contents to commit.

    Returns:
        CI classification for the new commit.
    """
    base = git(repo, "rev-parse", "HEAD")
    for relative, content in files.items():
        target = repo / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "change")
    return ci_paths.classify(repo, base, "HEAD")


@pytest.mark.parametrize(
    "path",
    [
        "docs/ci.md",
        "CONTRIBUTING.md",
        "PLAN.md",
        "packages/dev-tools/README.md",
        "packages/session-kit/CHANGELOG.md",
    ],
)
def test_classify_accepts_documentation_paths(repo: Path, path: str) -> None:
    """Classify the explicitly allowed documentation path families as docs-only."""
    result = classify_change(repo, {path: "documentation\n"})
    assert result.docs_only
    assert result.paths == (path,)


@pytest.mark.parametrize(
    "path",
    [
        "README.md",
        "packages/preset/README.md",
        ".github/workflows/ci.yml",
        "package-lock.json",
        "forks/pi",
        "integration/README.md",
        "scripts/ci_paths.py",
        "releases/example.json",
        "packages/session-kit/docs/stats-snapshots.md",
    ],
)
def test_classify_rejects_code_and_tested_documentation(repo: Path, path: str) -> None:
    """Classify workflow, runtime, identity, and test-read documentation as code."""
    result = classify_change(repo, {path: "input\n"})
    assert not result.docs_only
    assert result.paths == (path,)


def test_classify_rejects_mixed_changes(repo: Path) -> None:
    """Require every changed file to be an allowed documentation path."""
    result = classify_change(repo, {"docs/ci.md": "docs\n", "packages/dev-tools/src/index.ts": "code\n"})
    assert not result.docs_only
    assert result.paths == ("docs/ci.md", "packages/dev-tools/src/index.ts")


def test_classify_rejects_empty_diff(repo: Path) -> None:
    """Do not bypass CI if Git reports no changed paths."""
    head = git(repo, "rev-parse", "HEAD")
    result = ci_paths.classify(repo, head, head)
    assert not result.docs_only
    assert result.paths == ()


def test_write_github_output_preserves_changed_file_list(tmp_path: Path) -> None:
    """Publish boolean and newline-delimited paths through Actions output syntax."""
    output = tmp_path / "output"
    ci_paths.write_github_output(
        output,
        ci_paths.ChangeClassification(paths=("docs/ci.md", "PLAN.md"), docs_only=True),
    )
    contents = output.read_text(encoding="utf-8")
    assert "docs_only=true\n" in contents
    assert "docs/ci.md\nPLAN.md\n" in contents
