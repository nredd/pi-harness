"""Test release manifest generation against real disposable Git repositories.

References:
    https://git-scm.com/docs/git-update-index
"""

from __future__ import annotations

import hashlib
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
