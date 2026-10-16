"""Test fork bootstrap against real disposable Git repositories.

References:
    https://git-scm.com/docs/git-submodule
"""

from __future__ import annotations

import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import bootstrap_forks as bf

GIT = bf.GIT


def git(repo: Path, *args: str) -> str:
    """Run git in `repo` and return stripped stdout."""
    done = subprocess.run([GIT, "-C", str(repo), *args], capture_output=True, text=True, check=True)
    return done.stdout.strip()


def init_repo(path: Path) -> Path:
    """Create a repository with one commit."""
    path.mkdir(parents=True)
    git(path, "init", "-q", "-b", "main")
    git(path, "config", "user.email", "t@example.invalid")
    git(path, "config", "user.name", "t")
    git(path, "config", "commit.gpgsign", "false")
    (path / "tracked.txt").write_text("one\n")
    git(path, "add", ".")
    git(path, "commit", "-q", "-m", "init")
    return path


def commit_file(repo: Path, name: str, text: str) -> str:
    """Commit a file change and return the new HEAD."""
    (repo / name).write_text(text)
    git(repo, "add", name)
    git(repo, "commit", "-q", "-m", f"change {name}")
    return git(repo, "rev-parse", "HEAD")


@pytest.fixture(autouse=True)
def allow_file_protocol(monkeypatch: pytest.MonkeyPatch) -> None:
    """Allow `file://` submodule clones for the child git processes."""
    monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
    monkeypatch.setenv("GIT_CONFIG_KEY_0", "protocol.file.allow")
    monkeypatch.setenv("GIT_CONFIG_VALUE_0", "always")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", "/dev/null")
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")


@dataclass(frozen=True)
class World:
    """A parent clone whose submodules start uninitialized."""

    upstreams: dict[str, Path]
    parent_origin: Path
    parent: Path


def make_world(tmp_path: Path, names: tuple[str, ...] = ("forks/alpha", "forks/beta")) -> World:
    """Build upstream repos, a parent that records them as gitlinks, and a fresh clone of the parent."""
    upstreams = {name: init_repo(tmp_path / "up" / name.replace("/", "_")) for name in names}
    origin = init_repo(tmp_path / "origin")
    for name, up in upstreams.items():
        git(origin, "submodule", "add", "-q", str(up), name)
    git(origin, "commit", "-q", "-m", "add forks")
    parent = tmp_path / "clone"
    subprocess.run([GIT, "clone", "-q", str(origin), str(parent)], check=True, capture_output=True)
    git(parent, "config", "user.email", "t@example.invalid")
    git(parent, "config", "user.name", "t")
    return World(upstreams, origin, parent)


def init_all(world: World) -> None:
    """Initialize every submodule via the tool under test."""
    assert bf.main(["--repo", str(world.parent)]) == bf.EXIT_OK


def bump_gitlink(world: World, name: str) -> str:
    """Advance one upstream and the parent's gitlink in the clone; return the new commit."""
    new = commit_file(world.upstreams[name], "tracked.txt", "two\n")
    sub = world.parent / name
    git(sub, "fetch", "-q", "origin")
    git(sub, "checkout", "-q", new)
    git(world.parent, "add", name)
    git(world.parent, "commit", "-q", "-m", "bump")
    git(sub, "checkout", "-q", git(sub, "rev-parse", "HEAD~1"))  # back to the old HEAD, as a stale checkout
    return new


def test_initializes_clean_checkout_at_gitlinks(tmp_path: Path) -> None:
    """Uninitialized submodules are cloned and checked out at the recorded commits."""
    world = make_world(tmp_path)
    assert not (world.parent / "forks/alpha/tracked.txt").exists()
    init_all(world)
    for name, up in world.upstreams.items():
        assert git(world.parent / name, "rev-parse", "HEAD") == git(up, "rev-parse", "HEAD")


def test_discovers_arbitrary_gitlinks_not_a_pin_list(tmp_path: Path) -> None:
    """Names come from the index, so any layout works."""
    world = make_world(tmp_path, ("deps/x", "vendor/y/z"))
    assert [p.relative_to(world.parent).as_posix() for p in bf.gitlink_paths(world.parent)] == [
        "deps/x",
        "vendor/y/z",
    ]
    init_all(world)
    assert (world.parent / "vendor/y/z/tracked.txt").is_file()


def test_idempotent_on_clean_initialized_checkouts(tmp_path: Path) -> None:
    """A second run on clean checkouts succeeds and changes nothing."""
    world = make_world(tmp_path)
    init_all(world)
    before = git(world.parent / "forks/alpha", "rev-parse", "HEAD")
    init_all(world)
    assert git(world.parent / "forks/alpha", "rev-parse", "HEAD") == before


def _dirty_tracked(sub: Path) -> str:
    """Create an unstaged tracked-file edit and return its relative path."""
    (sub / "tracked.txt").write_text("local edit\n")
    return "tracked.txt"


def _dirty_staged(sub: Path) -> str:
    """Create a staged addition and return its relative path."""
    (sub / "staged.txt").write_text("staged work\n")
    git(sub, "add", "staged.txt")
    return "staged.txt"


def _dirty_untracked(sub: Path) -> str:
    """Create an untracked nested file and return its relative path."""
    (sub / "deep").mkdir()
    (sub / "deep" / "new.txt").write_text("untracked work\n")
    return "deep/new.txt"


@pytest.mark.parametrize("make_dirt", [_dirty_tracked, _dirty_staged, _dirty_untracked])
def test_dirty_fork_refuses_and_preserves_everything(
    tmp_path: Path,
    make_dirt: Callable[[Path], str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Dirt in one fork aborts before ANY fork changes, even with a pending gitlink bump."""
    world = make_world(tmp_path)
    init_all(world)
    # Stale `beta` checkout plus a recorded newer gitlink: an update would move its HEAD.
    new_beta = bump_gitlink(world, "forks/beta")
    alpha, beta = world.parent / "forks/alpha", world.parent / "forks/beta"
    rel = make_dirt(alpha)
    content = (alpha / rel).read_text()
    heads = {p: git(p, "rev-parse", "HEAD") for p in (alpha, beta)}
    assert heads[beta] != new_beta

    assert bf.main(["--repo", str(world.parent)]) == bf.EXIT_DIRTY

    assert {p: git(p, "rev-parse", "HEAD") for p in (alpha, beta)} == heads
    assert (alpha / rel).read_text() == content
    assert "forks/alpha" in caplog.text


def test_dirty_fork_leaves_uninitialized_sibling_untouched(tmp_path: Path) -> None:
    """A not-yet-initialized fork is not cloned when another fork is dirty."""
    world = make_world(tmp_path)
    git(world.parent, "submodule", "update", "--init", "forks/alpha")
    (world.parent / "forks/alpha/tracked.txt").write_text("local edit\n")
    assert bf.main(["--repo", str(world.parent)]) == bf.EXIT_DIRTY
    assert not (world.parent / "forks/beta/tracked.txt").exists()
    assert (world.parent / "forks/alpha/tracked.txt").read_text() == "local edit\n"


def test_nested_submodule_dirt_is_detected(tmp_path: Path) -> None:
    """Initialized submodules inside a fork are preflighted too."""
    world = make_world(tmp_path, ("forks/alpha",))
    inner = init_repo(tmp_path / "inner")
    alpha_up = world.upstreams["forks/alpha"]
    git(alpha_up, "submodule", "add", "-q", str(inner), "third_party/inner")
    git(alpha_up, "commit", "-q", "-m", "nest")
    git(world.parent, "submodule", "update", "--init", "-q")
    git(world.parent / "forks/alpha", "fetch", "-q", "origin")
    git(world.parent / "forks/alpha", "checkout", "-q", "origin/main")
    git(world.parent / "forks/alpha", "submodule", "update", "--init", "-q")
    git(world.parent, "add", "forks/alpha")
    git(world.parent, "commit", "-q", "-m", "track nested")
    nested = world.parent / "forks/alpha/third_party/inner"
    (nested / "scratch.txt").write_text("keep me\n")
    head = git(nested, "rev-parse", "HEAD")

    dirt = bf.find_dirt(world.parent)
    assert any(d.path == nested for d in dirt)
    assert bf.main(["--repo", str(world.parent)]) == bf.EXIT_DIRTY
    assert (nested / "scratch.txt").read_text() == "keep me\n"
    assert git(nested, "rev-parse", "HEAD") == head


def test_nonempty_uninitialized_directory_refused(tmp_path: Path) -> None:
    """Stray files where a fork would be cloned are never overwritten."""
    world = make_world(tmp_path)
    stray = world.parent / "forks/beta"
    stray.mkdir(parents=True, exist_ok=True)
    (stray / "mine.txt").write_text("mine\n")
    assert bf.main(["--repo", str(world.parent)]) == bf.EXIT_DIRTY
    assert (stray / "mine.txt").read_text() == "mine\n"
    assert not (world.parent / "forks/alpha/tracked.txt").exists()


@pytest.mark.parametrize("symlink", [False, True])
def test_invalid_submodule_path_refuses_before_any_update(tmp_path: Path, symlink: bool) -> None:
    """A file or symlink at a gitlink never redirects bootstrap outside its checkout."""
    world = make_world(tmp_path)
    path = world.parent / "forks/beta"
    path.rmdir()
    upstream = world.upstreams["forks/beta"]
    before = git(upstream, "rev-parse", "HEAD")
    if symlink:
        path.symlink_to(upstream, target_is_directory=True)
    else:
        path.write_text("keep this file\n")

    assert bf.main(["--repo", str(world.parent)]) == bf.EXIT_DIRTY
    assert git(upstream, "rev-parse", "HEAD") == before
    assert not (world.parent / "forks/alpha/tracked.txt").exists()
    if symlink:
        assert path.is_symlink()
    else:
        assert path.read_text() == "keep this file\n"


def test_clean_stale_fork_is_updated_to_gitlink(tmp_path: Path) -> None:
    """With a clean tree, the update moves HEAD to the recorded gitlink."""
    world = make_world(tmp_path)
    init_all(world)
    new_beta = bump_gitlink(world, "forks/beta")
    init_all(world)
    assert git(world.parent / "forks/beta", "rev-parse", "HEAD") == new_beta


def test_check_only_never_updates(tmp_path: Path) -> None:
    """`--check` preflights but leaves uninitialized forks alone."""
    world = make_world(tmp_path)
    assert bf.main(["--repo", str(world.parent), "--check"]) == bf.EXIT_OK
    assert not (world.parent / "forks/alpha/tracked.txt").exists()


def test_no_submodules_is_a_noop(tmp_path: Path) -> None:
    """A repository without gitlinks succeeds."""
    repo = init_repo(tmp_path / "plain")
    assert bf.main(["--repo", str(repo)]) == bf.EXIT_OK


def test_not_a_repository_is_an_error(tmp_path: Path) -> None:
    """Bad input exits 2, distinct from a dirty refusal."""
    plain = tmp_path / "nogit"
    plain.mkdir()
    assert bf.main(["--repo", str(plain)]) == bf.EXIT_ERROR
    assert bf.main(["--repo", str(tmp_path / "missing")]) == bf.EXIT_ERROR
