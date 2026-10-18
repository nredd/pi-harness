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

GIT = "git"


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


def test_schema_rejects_bad_input() -> None:
    """Strict output schema rejects an invalid schema version and unknown field."""
    with pytest.raises(ValidationError):
        rm.ReleaseManifest.model_validate({"schema_version": 2, "unexpected": True})
