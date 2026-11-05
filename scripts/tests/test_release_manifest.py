"""Test release manifest generation against real disposable Git repositories.

References:
    https://git-scm.com/docs/git-update-index
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import release_manifest as rm

GIT = str(rm.locate_git())


def git(repo: Path, *args: str) -> str:
    """Run Git in a disposable repository.

    Parameters:
        repo (Path): Repository worktree.
        *args (str): Arguments after `git -C <repo>`.

    Returns:
        str: Stripped standard output.
    """
    done = subprocess.run([GIT, "-C", str(repo), *args], capture_output=True, text=True, check=True)
    return done.stdout.strip()


def init_repo(path: Path) -> Path:
    """Initialize a disposable repository with an unsigned identity.

    Parameters:
        path (Path): New repository worktree.

    Returns:
        Path: Initialized repository.
    """
    path.mkdir(parents=True)
    git(path, "init", "-q", "-b", "main")
    git(path, "config", "user.email", "release-manifest@example.invalid")
    git(path, "config", "user.name", "Release Manifest")
    git(path, "config", "commit.gpgsign", "false")
    git(path, "config", "tag.gpgSign", "false")
    return path


def write_packages(repo: Path) -> None:
    """Write the four minimal owned package manifests.

    Parameters:
        repo (Path): Parent repository.

    Returns:
        None: Files are created under `packages/`.
    """
    for directory in rm.OWNED_PACKAGE_DIRECTORIES:
        manifest = repo / "packages" / directory / "package.json"
        manifest.parent.mkdir(parents=True)
        manifest.write_text(
            f'{{"name":"@nredd/pi-{directory}","version":"1.0.0","private":true}}\n',
            encoding="utf-8",
        )


def make_repo(tmp_path: Path) -> Path:
    """Create a parent repository with a tagged, initialized fake Gitlink.

    Parameters:
        tmp_path (Path): Pytest temporary directory.

    Returns:
        Path: Clean parent repository whose fake submodule resolves an exact local tag.
    """
    source = init_repo(tmp_path / "source")
    (source / "source.txt").write_text("source\n", encoding="utf-8")
    git(source, "add", "source.txt")
    git(source, "commit", "-q", "-m", "source")
    git(source, "tag", "v0.1.0")
    commit = git(source, "rev-parse", "HEAD")

    parent = init_repo(tmp_path / "parent")
    write_packages(parent)
    (parent / "package-lock.json").write_text('{"lockfileVersion":3}\n', encoding="utf-8")
    (parent / "integration").mkdir()
    (parent / "integration" / "uv.lock").write_text("version = 1\n", encoding="utf-8")
    (parent / ".gitmodules").write_text(
        f'[submodule "forks/fake"]\n\tpath = forks/fake\n\turl = {source}\n',
        encoding="utf-8",
    )
    subprocess.run([GIT, "clone", "-q", str(source), str(parent / "forks" / "fake")], check=True)
    git(parent, "update-index", "--add", "--cacheinfo", f"160000,{commit},forks/fake")
    git(parent, "add", ".gitmodules", "packages", "package-lock.json", "integration/uv.lock")
    git(parent, "commit", "-q", "-m", "parent")
    git(parent, "submodule", "update", "--init", "--quiet", "forks/fake")
    return parent


def test_clean_refusal_and_allow_dirty(tmp_path: Path) -> None:
    """A dirty parent is refused unless the manifest explicitly records it."""
    repo = make_repo(tmp_path)
    clean = rm.build_manifest(repo, "clean", {}, {}, {})
    assert clean.release.dirty is False
    assert clean.forks[0].tag == "v0.1.0"

    (repo / "dirty.txt").write_text("dirty\n", encoding="utf-8")
    with pytest.raises(rm.ManifestError, match="worktree is dirty"):
        rm.build_manifest(repo, "dirty", {}, {}, {})
    dirty = rm.build_manifest(repo, "dirty", {}, {}, {}, allow_dirty=True)
    assert dirty.release.dirty is True


def test_artifact_hash_and_evidence(tmp_path: Path) -> None:
    """Artifacts are byte-hashed and repeated evidence pairs reach the schema."""
    repo = make_repo(tmp_path)
    artifact = tmp_path / "candidate.bin"
    artifact.write_bytes(b"release artifact\n")
    manifest = rm.build_manifest(
        repo,
        "artifact",
        {"candidate": str(artifact)},
        {"candidate": "https://example.invalid/candidate.bin"},
        {"gate": "logs/gate.log", "review": "https://example.invalid/review"},
        created_at="2026-10-17T00:00:00Z",
    )
    assert manifest.artifacts == [
        rm.Artifact(
            name="candidate",
            basename="candidate.bin",
            size=artifact.stat().st_size,
            sha256=hashlib.sha256(artifact.read_bytes()).hexdigest(),
            url="https://example.invalid/candidate.bin",
        )
    ]
    assert manifest.evidence == {"gate": "logs/gate.log", "review": "https://example.invalid/review"}


def test_moved_submodule_records_the_indexed_gitlink(tmp_path: Path) -> None:
    """A fork checked out past its Gitlink (`+` status) is identified by the INDEXED commit."""
    repo = make_repo(tmp_path)
    fork = repo / "forks" / "fake"
    for key, value in (
        ("user.email", "x@example.invalid"),
        ("user.name", "X"),
        ("commit.gpgsign", "false"),
        ("tag.gpgSign", "false"),
    ):
        git(fork, "config", key, value)
    pinned = git(fork, "rev-parse", "HEAD")
    (fork / "later.txt").write_text("later\n", encoding="utf-8")
    git(fork, "add", "later.txt")
    git(fork, "commit", "-q", "-m", "later")
    git(fork, "tag", "v0.2.0")
    assert git(repo, "submodule", "status").startswith("+")

    manifest = rm.build_manifest(repo, "moved", {}, {}, {}, allow_dirty=True)
    assert manifest.forks[0].commit == pinned
    assert manifest.forks[0].tag == "v0.1.0"


def test_absent_private_is_publishable_and_non_boolean_is_rejected(tmp_path: Path) -> None:
    """A manifest without `private` records `false`; a string `private` is malformed."""
    repo = make_repo(tmp_path)
    manifest_path = repo / "packages" / rm.OWNED_PACKAGE_DIRECTORIES[0] / "package.json"
    manifest_path.write_text('{"name":"@nredd/pi-x","version":"1.0.0"}\n', encoding="utf-8")
    git(repo, "commit", "-q", "-am", "publishable")
    manifest = rm.build_manifest(repo, "publishable", {}, {}, {})
    assert manifest.owned_packages[0].private is False
    manifest_path.write_text('{"name":"@nredd/pi-x","version":"1.0.0","private":"yes"}\n', encoding="utf-8")
    git(repo, "commit", "-q", "-am", "malformed")
    with pytest.raises(rm.ManifestError, match="non-boolean `private`"):
        rm.build_manifest(repo, "malformed", {}, {}, {})


def test_invalid_package_manifest_is_a_manifest_error(tmp_path: Path) -> None:
    """An empty owned package version surfaces as `ManifestError`, not a raw `ValidationError`."""
    repo = make_repo(tmp_path)
    broken = repo / "packages" / rm.OWNED_PACKAGE_DIRECTORIES[0] / "package.json"
    broken.write_text('{"name":"@nredd/pi-broken","version":"","private":true}\n', encoding="utf-8")
    git(repo, "commit", "-q", "-am", "break")
    with pytest.raises(rm.ManifestError, match="failed validation"):
        rm.build_manifest(repo, "broken", {}, {}, {})


def test_malformed_pairs_missing_artifact_and_git_failure(tmp_path: Path) -> None:
    """Bad `NAME=VALUE` input, a missing artifact file and a non-repository all fail loudly."""
    with pytest.raises(rm.ManifestError, match="must be NAME=VALUE"):
        rm.parse_pairs(["novalue"], "--evidence")
    with pytest.raises(rm.ManifestError, match="repeats name"):
        rm.parse_pairs(["a=1", "a=2"], "--evidence")
    repo = make_repo(tmp_path)
    with pytest.raises(rm.ManifestError, match="not a regular file"):
        rm.build_manifest(repo, "missing", {"gone": str(tmp_path / "gone.bin")}, {}, {})
    not_a_repo = tmp_path / "plain"
    not_a_repo.mkdir()
    with pytest.raises(rm.ManifestError, match="failed"):
        rm.build_manifest(not_a_repo, "plain", {}, {}, {})


def valid_manifest(tmp_path: Path) -> dict[str, object]:
    """Produce a valid manifest document to mutate in schema tests.

    Parameters:
        tmp_path (Path): Pytest temporary directory.

    Returns:
        dict[str, object]: JSON-compatible manifest that validates as-is.
    """
    return rm.build_manifest(make_repo(tmp_path), "valid", {}, {}, {}).model_dump()


@pytest.mark.parametrize(
    "mutation",
    [
        {"schema_version": 2},
        {"unexpected": True},
        {"release": {"id": "", "created_at": "2026-10-17T00:00:00Z", "commit": "0" * 40, "dirty": False}},
        {"forks": [{"path": "forks/x", "commit": "nothex", "remote_url": "u", "initialized": False}]},
    ],
)
def test_schema_rejects_each_constraint(tmp_path: Path, mutation: dict[str, object]) -> None:
    """Starting from a valid document, each constraint rejects on its own."""
    document = valid_manifest(tmp_path)
    rm.ReleaseManifest.model_validate(document)
    with pytest.raises(ValidationError):
        rm.ReleaseManifest.model_validate({**document, **mutation})


def stub_git_output(monkeypatch: pytest.MonkeyPatch, command: tuple[str, ...], stdout: str) -> None:
    """Replace one Git command's output with a line real Git never emits, keeping every other call real.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): Restores `run_git` after the test.
        command (tuple[str, ...]): Exact Git arguments to intercept.
        stdout (str): Replacement standard output.

    Returns:
        None: `rm.run_git` is patched for the test.
    """
    real = rm.run_git

    def run_git(repo_root: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        if args == command:
            return subprocess.CompletedProcess([GIT, *args], 0, stdout, "")
        return real(repo_root, *args, check=check)

    monkeypatch.setattr(rm, "run_git", run_git)


def test_git_must_be_on_path_and_startable(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A missing or unstartable Git executable is a `ManifestError`, not a raw OS error."""
    rm.locate_git.cache_clear()
    monkeypatch.setenv("PATH", str(tmp_path))
    try:
        with pytest.raises(rm.ManifestError, match="`git` not found on PATH"):
            rm.locate_git()
    finally:
        rm.locate_git.cache_clear()
    monkeypatch.setattr(rm, "locate_git", lambda: tmp_path / "missing-git")
    with pytest.raises(rm.ManifestError, match="could not start"):
        rm.run_git(tmp_path, "status")


def test_sha256_refuses_a_directory(tmp_path: Path) -> None:
    """Only regular files are hashed."""
    with pytest.raises(rm.ManifestError, match="Path is not a regular file"):
        rm.sha256_file(tmp_path)


def test_repository_without_gitmodules_has_no_forks(tmp_path: Path) -> None:
    """A parent without `.gitmodules` records no Gitlinks rather than failing."""
    repo = make_repo(tmp_path)
    git(repo, "rm", "-q", "--cached", "forks/fake")
    git(repo, "rm", "-q", ".gitmodules")
    git(repo, "commit", "-q", "-m", "drop fork")
    shutil.rmtree(repo / "forks")
    assert rm.build_manifest(repo, "no-forks", {}, {}, {}).forks == []


def test_untagged_fork_commit_records_no_tag(tmp_path: Path) -> None:
    """An initialized fork whose indexed commit has no exact local tag records `tag: null`."""
    repo = make_repo(tmp_path)
    git(repo / "forks" / "fake", "tag", "-d", "v0.1.0")
    assert rm.build_manifest(repo, "untagged", {}, {}, {}).forks[0].tag is None


@pytest.mark.parametrize(
    ("gitmodules", "message"),
    [
        ('[submodule "a"]\n\tpath\n', "Malformed `.gitmodules` entry: 'submodule.a.path'"),
        ('[submodule "a"]\n\tpath = forks/a\n', "requires both `path` and `url`"),
        (
            '[submodule "a"]\n\tpath = forks/a\n\turl = u\n[submodule "b"]\n\tpath = forks/a\n\turl = u\n',
            "Duplicate `.gitmodules` path 'forks/a'",
        ),
    ],
)
def test_malformed_gitmodules_are_refused(tmp_path: Path, gitmodules: str, message: str) -> None:
    """Incomplete, valueless or duplicate `.gitmodules` declarations fail loudly."""
    repo = init_repo(tmp_path / "repo")
    (repo / ".gitmodules").write_text(gitmodules, encoding="utf-8")
    with pytest.raises(rm.ManifestError, match=re.escape(message)):
        rm.submodule_urls(repo)


@pytest.mark.parametrize(
    ("command", "stdout", "message"),
    [
        (("submodule", "status"), "garbage\n", "Malformed `git submodule status` entry: 'garbage'"),
        (("submodule", "status"), f" {'1' * 40} forks/other\n", "Gitlink 'forks/other' has no URL"),
        (("ls-files", "-s"), "", "reports 'forks/fake' but the index has no Gitlink for it"),
        (("ls-files", "-s"), "160000 short 0\tforks/fake\n", "Malformed index Gitlink entry"),
    ],
)
def test_inconsistent_git_output_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, command: tuple[str, ...], stdout: str, message: str
) -> None:
    """Status and index output that disagree with `.gitmodules` or each other fail closed."""
    repo = make_repo(tmp_path)
    stub_git_output(monkeypatch, command, stdout)
    with pytest.raises(rm.ManifestError, match=message):
        rm.gitlinks(repo)


@pytest.mark.parametrize(
    ("content", "message"),
    [
        (None, "Cannot read package manifest"),
        ("{", "Cannot read package manifest"),
        ('{"version":"1.0.0"}', "needs string `name` and `version`"),
    ],
)
def test_unreadable_or_incomplete_package_manifest_is_refused(
    tmp_path: Path, content: str | None, message: str
) -> None:
    """A missing, non-JSON or nameless owned package manifest fails loudly."""
    repo = make_repo(tmp_path)
    path = repo / "packages" / rm.OWNED_PACKAGE_DIRECTORIES[0] / "package.json"
    if content is None:
        path.unlink()
    else:
        path.write_text(content, encoding="utf-8")
    with pytest.raises(rm.ManifestError, match=message):
        rm.owned_packages(repo)


@pytest.mark.parametrize(
    ("content", "message"),
    [("{", "Cannot read root lockfile"), ('{"lockfileVersion":"3"}', "needs integer `lockfileVersion`")],
)
def test_malformed_root_lockfile_is_refused(tmp_path: Path, content: str, message: str) -> None:
    """A non-JSON root lockfile or a non-integer `lockfileVersion` fails loudly."""
    (tmp_path / "package-lock.json").write_text(content, encoding="utf-8")
    with pytest.raises(rm.ManifestError, match=message):
        rm.third_party_identity(tmp_path)


def test_artifact_url_requires_an_artifact() -> None:
    """A URL for an undeclared artifact is refused before any hashing."""
    with pytest.raises(rm.ManifestError, match="`--artifact-url` has no matching `--artifact`: ghost"):
        rm.artifacts({}, {"ghost": "https://example.invalid/ghost"})


def test_main_writes_the_default_output_and_refuses_dirty_trees(tmp_path: Path) -> None:
    """`main` writes `releases/<id>.json` for a clean tree and exits 1 on a dirty one."""
    repo = make_repo(tmp_path)
    artifact = tmp_path / "candidate.bin"
    artifact.write_bytes(b"candidate\n")
    argv = [
        "cli",
        "--repo-root",
        str(repo),
        "--artifact",
        f"candidate={artifact}",
        "--artifact-url",
        "candidate=https://example.invalid/candidate.bin",
        "--evidence",
        "gate=green",
    ]
    assert rm.main(argv) == 0
    written = json.loads((repo / "releases" / "cli.json").read_text(encoding="utf-8"))
    assert written["release"]["id"] == "cli"
    assert written["evidence"] == {"gate": "green"}
    assert written["artifacts"][0]["url"] == "https://example.invalid/candidate.bin"
    assert rm.main(["dirty", "--repo-root", str(repo)]) == 1
    output = tmp_path / "out" / "dirty.json"
    assert rm.main(["dirty", "--repo-root", str(repo), "--allow-dirty", "--output", str(output)]) == 0
    assert json.loads(output.read_text(encoding="utf-8"))["release"]["dirty"] is True


def test_main_rejects_malformed_pairs(tmp_path: Path) -> None:
    """A malformed `NAME=VALUE` option exits 1 before Git is consulted."""
    assert rm.main(["bad", "--repo-root", str(tmp_path), "--evidence", "novalue"]) == 1


def test_script_entry_point_exits_with_main_status(tmp_path: Path) -> None:
    """Running the module as a script exits with `main`'s status code."""
    done = subprocess.run(
        [sys.executable, str(Path(rm.__file__)), "plain", "--repo-root", str(tmp_path)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert done.returncode == 1
    assert "FAILED:" in done.stderr
