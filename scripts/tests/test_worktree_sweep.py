"""Run the shipping skill's read-only scan against disposable linked worktrees.

References:
    https://git-scm.com/docs/git-worktree
    https://git-scm.com/docs/git-check-attr
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

SKILL = Path(__file__).resolve().parents[2] / "packages/preset/skills/get-it-merged/SKILL.md"


def git(repo: Path, *args: str) -> str:
    """Run real Git in the named disposable repository."""
    return subprocess.check_output(["git", "-C", str(repo), *args], text=True, timeout=30)


@pytest.fixture
def linked(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    """Create a branch already at its upstream tip, isolated from ambient Git config."""
    for name in os.environ:
        if name.startswith("GIT_"):
            monkeypatch.delenv(name)
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", os.devnull)
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "--template=", "-b", "main")
    git(repo, "config", "user.name", "Fixture")
    git(repo, "config", "user.email", "fixture@example.invalid")
    git(repo, "commit", "--allow-empty", "-m", "Base")
    worktree = tmp_path / "linked worktree"
    git(repo, "worktree", "add", "-b", "merged", str(worktree))
    git(worktree, "branch", "--set-upstream-to=main")
    return repo, worktree


def scan(worktree: Path) -> subprocess.CompletedProcess[str]:
    """Execute the exact shell block shipped to operators, without any removal step."""
    section = SKILL.read_text(encoding="utf-8").split("#### Shared ref, reflog and filter checks\n", 1)[1]
    script = section.split("```sh\n", 1)[1].split("\n```", 1)[0]
    return subprocess.run(
        ["/bin/sh", "-c", "worktree=$1\n" + script, "sweep", str(worktree)],
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
    )


def assert_looks_clean(worktree: Path) -> None:
    """Establish that the old HEAD, status and index checks would not detect the loss."""
    assert git(worktree, "rev-parse", "HEAD") == git(worktree, "rev-parse", "@{u}")
    assert git(worktree, "status", "--porcelain", "--ignored", "--untracked-files=all") == ""
    assert all(line.startswith("H ") for line in git(worktree, "ls-files", "-v").splitlines())


@pytest.mark.parametrize("preserve", [False, True], ids=["reflog-only", "shared-ref"])
def test_detached_commit_in_head_reflog(linked: tuple[Path, Path], preserve: bool) -> None:
    """Retain an unanchored detached commit; allow an operator to anchor it and retry."""
    repo, worktree = linked
    git(worktree, "switch", "--detach")
    git(worktree, "commit", "--allow-empty", "-m", "Detached work")
    detached = git(worktree, "rev-parse", "HEAD").strip()
    git(worktree, "switch", "merged")
    assert_looks_clean(worktree)
    assert detached in git(worktree, "reflog", "show", "--format=%H", "HEAD").splitlines()
    assert detached not in git(worktree, "rev-list", "--all").splitlines()

    if preserve:
        git(repo, "branch", "saved", detached)
    result = scan(worktree)
    if preserve:
        assert (result.returncode, result.stdout, result.stderr) == (0, "", "")
    else:
        assert result.returncode != 0
        assert f"keep: HEAD reflog commits outside refs: [b'{detached}']" in result.stderr
    assert worktree.is_dir()

    # Reproduce the old fallback on purpose, only inside the disposable repository.
    git(repo, "worktree", "remove", str(worktree))
    assert not worktree.exists()
    assert (detached in git(repo, "rev-list", "--all", "--reflog").splitlines()) == preserve


@pytest.mark.parametrize("namespace", ["worktree", "bisect", "rewritten"])
def test_local_ref_blocks_even_when_its_commit_is_already_shared(
    linked: tuple[Path, Path], namespace: str
) -> None:
    """Keep the local ref name even when there is no reflog-only commit to protect."""
    repo, worktree = linked
    ref = f"refs/{namespace}/sweep-fixture"
    git(worktree, "update-ref", ref, "HEAD")
    assert git(repo, "for-each-ref", ref) == ""
    assert_looks_clean(worktree)

    result = scan(worktree)
    assert result.returncode != 0
    assert "keep: worktree-local refs:" in result.stderr
    assert ref in result.stderr
    assert git(worktree, "rev-parse", ref) == git(worktree, "rev-parse", "HEAD")


def test_clean_filter_hides_raw_bytes_on_unusual_path(linked: tuple[Path, Path]) -> None:
    """Keep bytes that a real clean filter strips, even on a path with whitespace."""
    repo, worktree = linked
    git(repo, "config", "filter.strip.clean", "sed 's/^scratch$/tracked/'")
    git(repo, "config", "filter.strip.smudge", "cat")
    git(repo, "config", "filter.strip.required", "true")
    name = "-note with\nspace.txt"
    (worktree / ".gitattributes").write_text("*.txt filter=strip\n", encoding="utf-8")
    path = worktree / name
    path.write_bytes(b"tracked\n")
    git(worktree, "add", "--", ".gitattributes", name)
    git(worktree, "commit", "-m", "Track filtered file")
    git(repo, "merge", "--ff-only", "merged")
    raw = b"scratch\n"
    path.write_bytes(raw)
    assert git(worktree, "show", f":{name}") == "tracked\n"
    assert git(worktree, "-c", "filter.strip.clean=cat", "status", "--porcelain").startswith(" M ")
    assert_looks_clean(worktree)

    result = scan(worktree)
    assert result.returncode != 0
    assert "keep: filter attributes on tracked paths:" in result.stderr
    assert repr(os.fsencode(name)) in result.stderr
    assert "scratch" not in result.stderr
    assert path.read_bytes() == raw

    # The old fallback deletes the raw bytes despite status being empty.
    git(repo, "worktree", "remove", str(worktree))
    assert not path.exists()
