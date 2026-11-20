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


def block(
    heading: str, path: str | None = None, mutate: tuple[str, str] | None = None, **variables: str
) -> subprocess.CompletedProcess[str]:
    """Run the shell block shipped under `heading` in the skill, with its documented variables set."""
    text = SKILL.read_text(encoding="utf-8")
    marker = f"#### {heading}\n"
    assert marker in text, f"`{marker.strip()}` heading missing from {SKILL}; update the test with the skill"
    fence = text.split(marker, 1)[1].split("```sh\n", 1)
    assert len(fence) == 2, f"no `sh` block under `{heading}`"
    assert "\n```" in fence[1], f"unterminated `sh` block under `{heading}`"
    script = fence[1].split("\n```", 1)[0]
    if mutate:
        assert mutate[0] in script, f"`{mutate[0]}` not in the `{heading}` block"
        script = script.replace(*mutate)
    return subprocess.run(
        ["/bin/sh", "-c", script],
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


FIELDS = "headRefName,headRepository,headRepositoryOwner,headRefOid,state"
PR_FIELDS = FIELDS.split(",")


def stub_gh(tmp_path: Path, script: str) -> str:
    """Install a `gh` running `script` and return a PATH that finds it first."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    stub = bin_dir / "gh"
    stub.write_text(f"#!/bin/sh\n{script}\n")
    stub.chmod(0o755)
    return f"{bin_dir}{os.pathsep}{os.environ['PATH']}"


def strict_gh(payload: dict[str, object]) -> str:
    """A `gh` that prints `payload` only when called with `--repo acme/widgets` and every PR field."""
    return f"""repo= fields= prev=
for arg; do
  [ "$prev" = --repo ] && repo=$arg
  [ "$prev" = --json ] && fields=$arg
  prev=$arg
done
[ "$repo" = acme/widgets ] || {{ echo "bad --repo: $repo" >&2; exit 2; }}
for need in {" ".join(PR_FIELDS)}; do
  case ",$fields," in *",$need,"*) ;; *) echo "missing --json field $need" >&2; exit 2 ;; esac
done
cat <<'JSON'
{json.dumps(payload)}
JSON"""


def identity(
    tmp_path: Path,
    linked: tuple[Path, Path],
    *,
    url: str = "https://github.com/acme/widgets.git",
    mutate: tuple[str, str] | None = None,
    script: str | None = None,
    overrides: dict[str, object] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run the shipped identity block for a worktree whose branch is `merged` from `acme/widgets`."""
    repo, worktree = linked
    git(repo, "remote", "add", "origin", url)
    payload: dict[str, object] = {
        "state": "MERGED",
        "headRefName": "merged",
        "headRefOid": git(worktree, "rev-parse", "HEAD").strip(),
        "headRepository": {"name": "widgets"},
        "headRepositoryOwner": {"login": "acme"},
    } | (overrides or {})
    payload = {key: value for key, value in payload.items() if value is not None}
    return block(
        "PR identity check",
        path=stub_gh(tmp_path, script or strict_gh(payload)),
        mutate=mutate,
        pr="7",
        base_repo="acme/widgets",
        worktree=str(worktree),
        remote="origin",
    )


@pytest.mark.parametrize(
    "url",
    [
        "https://github.com/acme/widgets.git",
        "git@github.com:acme/widgets.git",
        "ssh://git@github.com:22/acme/widgets",
    ],
    ids=["https", "scp", "ssh-port"],
)
def test_matching_pr_identity_proceeds(tmp_path: Path, linked: tuple[Path, Path], url: str) -> None:
    """A merged PR from this branch, host, owner, repository and commit passes."""
    result = identity(tmp_path, linked, url=url)
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
    result = identity(tmp_path, linked, overrides=override)
    assert result.returncode != 0
    assert "keep: PR identity mismatch" in result.stderr
    assert linked[1].is_dir()


def test_push_remote_on_another_host_keeps(tmp_path: Path, linked: tuple[Path, Path]) -> None:
    """Same owner and repository on a different host is a different repository."""
    result = identity(tmp_path, linked, url="https://git.example.invalid/acme/widgets.git")
    assert result.returncode != 0
    assert "keep: PR identity mismatch" in result.stderr
    assert "git.example.invalid" in result.stderr


@pytest.mark.parametrize("field", PR_FIELDS)
def test_dropping_a_shipped_json_field_is_caught(
    tmp_path: Path, linked: tuple[Path, Path], field: str
) -> None:
    """A `--json` list missing a field fails the strict `gh`, so the original defect cannot return."""
    kept = ",".join(name for name in PR_FIELDS if name != field)
    result = identity(tmp_path, linked, mutate=(f'"{FIELDS}"', f'"{kept}"'))
    assert result.returncode != 0
    assert f"missing --json field {field}" in result.stderr


def test_gh_failure_keeps(tmp_path: Path, linked: tuple[Path, Path]) -> None:
    """A failing `gh` is unknown, never a pass."""
    result = identity(
        tmp_path, linked, url="git@github.com:acme/widgets.git", script="echo 'HTTP 502' >&2\nexit 1"
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


def test_hidden_worktree_with_empty_admin_gitdir_is_kept(linked: tuple[Path, Path]) -> None:
    """`git worktree list` omits a worktree whose admin `gitdir` is empty, but prune still deletes it."""
    repo, worktree = linked
    git(worktree, "update-ref", "refs/worktree/x", "HEAD")
    (admin,) = (repo / ".git/worktrees").iterdir()
    assert (admin / "refs/worktree/x").is_file()
    (admin / "gitdir").write_bytes(b"")
    assert (worktree / ".git").is_file()

    listing = git(repo, "worktree", "list", "--porcelain", "-z")
    assert "linked worktree" not in listing
    dry = subprocess.run(
        ["git", "-C", str(repo), "worktree", "prune", "--dry-run", "--verbose"],
        env=git_env(),
        text=True,
        capture_output=True,
        check=True,
    )
    assert "Removing worktrees/linked-worktree: invalid gitdir file" in dry.stdout + dry.stderr

    # The previous guard looked only at the list: nothing prunable, every listed `.git` present.
    assert "prunable" not in listing
    assert all(
        Path(line.removeprefix("worktree ")).exists()
        for line in listing.split("\0")
        if line.startswith("worktree ")
    )
    guard = prune_guard(repo)
    assert guard.returncode != 0
    assert "keep:" in guard.stderr
    assert admin.is_dir()

    git(repo, "worktree", "prune")
    assert not admin.exists()


def test_dot_git_file_pointing_at_another_admin_dir_is_kept(linked: tuple[Path, Path]) -> None:
    """Keep when the worktree's `.git` file names a different admin dir than the one registered for it."""
    repo, worktree = linked
    (worktree / ".git").write_text(f"gitdir: {repo}/.git/worktrees/other\n", encoding="utf-8")
    assert git(repo, "worktree", "list", "--porcelain", "-z").count("prunable") == 0
    guard = prune_guard(repo)
    assert guard.returncode != 0
    assert "no matching `.git` file" in guard.stderr
