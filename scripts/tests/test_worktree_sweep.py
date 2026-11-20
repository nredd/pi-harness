"""Run the shipping skill's read-only scan against disposable linked worktrees.

References:
    https://git-scm.com/docs/git-worktree
    https://git-scm.com/docs/git-check-attr
"""

from __future__ import annotations

import fnmatch
import json
import os
import subprocess
from pathlib import Path

import pytest

SKILL = Path(__file__).resolve().parents[2] / "packages/preset/skills/get-it-merged/SKILL.md"


def git_env() -> dict[str, str]:
    """Prevent ambient Git routing and global config from affecting fixtures."""
    keys = os.environ.keys() - fnmatch.filter(os.environ, "GIT_*")
    return {key: os.environ[key] for key in keys} | {
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
    }


def git(repo: Path, *args: str) -> str:
    """Run real Git in the named disposable repository."""
    return subprocess.check_output(["git", "-C", str(repo), *args], env=git_env(), text=True, timeout=30)


@pytest.fixture
def linked(tmp_path: Path) -> tuple[Path, Path]:
    """Create a branch already at its upstream tip, isolated from ambient Git config."""
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


def block(heading: str, path: str | None = None, **variables: str) -> subprocess.CompletedProcess[str]:
    """Run the shell block shipped under `heading` in the skill, with its documented variables set."""
    text = SKILL.read_text(encoding="utf-8")
    marker = f"#### {heading}\n"
    assert marker in text, f"`{marker.strip()}` heading missing from {SKILL}; update the test with the skill"
    fence = text.split(marker, 1)[1].split("```sh\n", 1)
    assert len(fence) == 2, f"no `sh` block under `{heading}`"
    assert "\n```" in fence[1], f"unterminated `sh` block under `{heading}`"
    return subprocess.run(
        ["/bin/sh", "-c", fence[1].split("\n```", 1)[0]],
        env=git_env() | ({"PATH": path} if path else {}) | variables,
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
    )


def scan(worktree: Path) -> subprocess.CompletedProcess[str]:
    """Execute the shipped ref, reflog and filter scan, without any removal step."""
    return block("Ref, reflog and filter scan", worktree=str(worktree))


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


def prune_guard(repo: Path) -> subprocess.CompletedProcess[str]:
    """Run the shipped prune guard against `repo`."""
    return block("Prune guard", repo=str(repo))


def registered(repo: Path) -> bool:
    """Whether Git still has admin data for the linked worktree."""
    return any((repo / ".git/worktrees").glob("*/HEAD"))


def test_unmounted_worktree_is_kept_and_unguarded_prune_loses_it(linked: tuple[Path, Path]) -> None:
    """Refuse to prune when a registered worktree directory vanished, as with an unmounted volume."""
    repo, worktree = linked
    assert prune_guard(repo).returncode == 0
    git(worktree, "update-ref", "refs/worktree/saved", "HEAD")
    worktree.rename(repo.parent / "unmounted")

    listing = git(repo, "worktree", "list", "--porcelain", "-z").split("\0")
    assert any(field.startswith("worktree ") and field.endswith("linked worktree") for field in listing)
    assert "prunable gitdir file points to non-existent location" in listing
    guard = prune_guard(repo)
    assert guard.returncode != 0
    assert "keep: Git reports" in guard.stderr
    dry = subprocess.run(
        ["git", "-C", str(repo), "worktree", "prune", "--dry-run", "--verbose"],
        env=git_env(),
        text=True,
        capture_output=True,
        check=True,
    )
    assert (
        "Removing worktrees/linked-worktree: gitdir file points to non-existent location"
        in dry.stderr + dry.stdout
    )
    assert registered(repo)

    # The loss the guard prevents: an unguarded prune deletes the admin dir with its local refs and reflog.
    git(repo, "worktree", "prune")
    assert not registered(repo)
    assert git(repo, "for-each-ref", "refs/worktree") == ""


def test_directory_without_dot_git_passes_test_d_but_not_the_guard(linked: tuple[Path, Path]) -> None:
    """Reproduce a surviving directory with no `.git` file, which `test -d` cannot see."""
    repo, worktree = linked
    (worktree / ".git").unlink()
    assert subprocess.run(["/bin/sh", "-c", 'test -d "$1"', "sh", str(worktree)], check=False).returncode == 0
    listing = git(repo, "worktree", "list", "--porcelain", "-z")
    assert "prunable gitdir file points to non-existent location" in listing

    guard = prune_guard(repo)
    assert guard.returncode != 0
    assert "keep: Git reports" in guard.stderr
    assert registered(repo)


def test_guard_rejects_unreadable_dot_git_without_a_prunable_record(linked: tuple[Path, Path]) -> None:
    """Keep when `.git` is absent even if Git has no prunable record for it (e.g. a locked worktree)."""
    repo, worktree = linked
    git(repo, "worktree", "lock", str(worktree))
    (worktree / ".git").unlink()
    guard = prune_guard(repo)
    assert guard.returncode != 0
    assert "keep:" in guard.stderr


def stub_gh(tmp_path: Path, payload: dict[str, object]) -> str:
    """Create a `gh` that prints `payload` and return a PATH that finds it first."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    stub = bin_dir / "gh"
    stub.write_text(f"#!/bin/sh\ncat <<'JSON'\n{json.dumps(payload)}\nJSON\n")
    stub.chmod(0o755)
    return f"{bin_dir}{os.pathsep}{os.environ['PATH']}"


def identity(
    tmp_path: Path, linked: tuple[Path, Path], **overrides: object
) -> subprocess.CompletedProcess[str]:
    """Run the shipped identity block for a worktree whose branch is `merged` from `acme/widgets`."""
    repo, worktree = linked
    git(repo, "remote", "add", "origin", "https://github.com/acme/widgets.git")
    payload: dict[str, object] = {
        "state": "MERGED",
        "headRefName": "merged",
        "headRefOid": git(worktree, "rev-parse", "HEAD").strip(),
        "headRepository": {"name": "widgets"},
        "headRepositoryOwner": {"login": "acme"},
    } | overrides
    payload = {key: value for key, value in payload.items() if value is not None}
    return block(
        "PR identity check",
        path=stub_gh(tmp_path, payload),
        pr="7",
        base_repo="acme/widgets",
        worktree=str(worktree),
        remote="origin",
    )


def test_matching_pr_identity_proceeds(tmp_path: Path, linked: tuple[Path, Path]) -> None:
    """A merged PR from this branch, owner, repository and commit passes."""
    result = identity(tmp_path, linked)
    assert (result.returncode, result.stdout, result.stderr) == (0, "", "")


@pytest.mark.parametrize(
    "override",
    [
        {"headRefName": "someone-elses-branch"},
        {"headRepositoryOwner": {"login": "fork-owner"}},
        {"headRepository": {"name": "other-repo"}},
        {"state": "OPEN"},
        {"headRefOid": "0" * 40},
        {"headRefName": None},
        {"headRepositoryOwner": None},
        {"headRepository": None},
        {"headRefOid": None},
    ],
    ids=["branch", "owner", "repo", "state", "oid", "no-branch", "no-owner", "no-repo", "no-oid"],
)
def test_mismatched_or_missing_pr_identity_keeps(
    tmp_path: Path, linked: tuple[Path, Path], override: dict[str, object]
) -> None:
    """Any wrong or absent identity field keeps the worktree."""
    result = identity(tmp_path, linked, **override)
    assert result.returncode != 0
    assert "keep: PR identity mismatch" in result.stderr
    assert linked[1].is_dir()


def test_gh_failure_keeps(tmp_path: Path, linked: tuple[Path, Path]) -> None:
    """A failing `gh` is unknown, never a pass."""
    repo, worktree = linked
    git(repo, "remote", "add", "origin", "git@github.com:acme/widgets.git")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "gh").write_text("#!/bin/sh\necho 'HTTP 502' >&2\nexit 1\n")
    (bin_dir / "gh").chmod(0o755)
    result = block(
        "PR identity check",
        path=f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        pr="7",
        base_repo="acme/widgets",
        worktree=str(worktree),
        remote="origin",
    )
    assert result.returncode != 0
    assert "keep: gh failed" in result.stderr


def test_missing_skill_heading_fails_clearly() -> None:
    """A reformatted skill gives an actionable failure, not an IndexError."""
    with pytest.raises(AssertionError, match="heading missing"):
        block("No such heading")


def test_prunable_record_alone_keeps(linked: tuple[Path, Path]) -> None:
    """Keep when `.git` exists but the admin dir's `gitdir` points nowhere, so Git reports it prunable."""
    repo, worktree = linked
    (gitdir,) = (repo / ".git/worktrees").glob("*/gitdir")
    gitdir.write_text(f"{worktree}-moved/.git\n", encoding="utf-8")
    assert (worktree / ".git").exists()
    assert "prunable gitdir file points to non-existent location" in git(
        repo, "worktree", "list", "--porcelain"
    )
    guard = prune_guard(repo)
    assert guard.returncode != 0
    assert "keep: Git reports" in guard.stderr
