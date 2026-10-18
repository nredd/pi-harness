"""Generate a schema-versioned release manifest from repository identities.

The manifest is generated from Gitlinks and package manifests, never from hand-edited fork pins.
`--profile` is deliberately absent: profiles do not exist yet. Runtime-tree archives and third-party
resolution locks are also outside this first, minimal manifest slice.

References:
    https://git-scm.com/docs/git-submodule
    https://git-scm.com/docs/gitmodules
    https://docs.pydantic.dev/latest/concepts/models/
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import re
import shutil
import subprocess
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from functools import cache
from pathlib import Path
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError

LOGGER = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[1]
OWNED_PACKAGE_DIRECTORIES = (
    "dev-tools",
    "session-kit",
    "subscription-router",
    "preset",
)
STRICT_MODEL = ConfigDict(extra="forbid", frozen=True, strict=True)
Sha256Hex = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
GitCommit = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{40}$")]
ReleaseId = Annotated[str, StringConstraints(min_length=1)]


class ManifestError(RuntimeError):
    """The release manifest could not be generated from the repository state."""


SUBMODULE_STATUS = re.compile(r"(?P<state>[- +U])(?P<commit>[0-9a-f]{40}) (?P<path>[^ ]+)(?: .*)?")
INDEX_GITLINK = re.compile(r"160000 (?P<commit>[0-9a-f]{40}) \d+\t(?P<path>.+)")


class ReleaseInfo(BaseModel):
    model_config = STRICT_MODEL
    id: ReleaseId = Field(description="Immutable release identity supplied by the caller")
    created_at: str = Field(description="UTC ISO-8601 creation time")
    commit: GitCommit = Field(description="Full monorepo Git commit")
    dirty: bool = Field(description="Whether `--allow-dirty` permitted a dirty source tree")


class ForkIdentity(BaseModel):
    model_config = STRICT_MODEL
    path: str = Field(min_length=1, description="Gitlink path relative to the monorepo root")
    commit: GitCommit = Field(description="Gitlink commit")
    remote_url: str = Field(min_length=1, description="URL from `.gitmodules`")
    initialized: bool = Field(description="Whether the submodule has its own initialized Git directory")
    tag: str | None = Field(default=None, description="Exact local tag at `commit`, when available")
    fetched_tag_object: str | None = Field(
        default=None, description="Fetched tag object; always null because this generator does not fetch"
    )


class OwnedPackage(BaseModel):
    model_config = STRICT_MODEL
    name: str = Field(min_length=1, description="npm package name")
    version: str = Field(min_length=1, description="Package version from `package.json`")
    private: bool = Field(description="`private` from `package.json`; `false` when absent, as npm reads it")
    tarball_sha256: str | None = Field(default=None, description="Packed tarball digest; not computed here")


class LockedFile(BaseModel):
    model_config = STRICT_MODEL
    path: str = Field(min_length=1, description="Path relative to the monorepo root")
    sha256: Sha256Hex = Field(description="SHA-256 of the exact file bytes")


class ThirdPartyIdentity(BaseModel):
    model_config = STRICT_MODEL
    package_lock_lockfile_version: int | None = Field(
        default=None, description="Root `package-lock.json` lockfileVersion, if the file exists"
    )
    files: list[LockedFile] = Field(description="Existing lockfiles and their SHA-256 digests")


class Artifact(BaseModel):
    model_config = STRICT_MODEL
    name: str = Field(min_length=1, description="Caller-defined artifact name")
    basename: str = Field(min_length=1, description="Artifact file name without its source directory")
    size: int = Field(ge=0, description="Exact artifact size in bytes")
    sha256: Sha256Hex = Field(description="SHA-256 of the exact artifact bytes")
    url: str | None = Field(default=None, description="Immutable published URL, if available")


class ReleaseManifest(BaseModel):
    model_config = STRICT_MODEL
    schema_version: int = Field(ge=1, le=1, description="Manifest schema version, exactly 1")
    release: ReleaseInfo = Field(description="Release source identity")
    forks: list[ForkIdentity] = Field(description="Every Gitlink reported by `git submodule status`")
    owned_packages: list[OwnedPackage] = Field(description="The four owned package manifests")
    third_party: ThirdPartyIdentity = Field(description="Existing repository lockfile identities")
    artifacts: list[Artifact] = Field(description="Explicitly supplied release artifacts")
    evidence: dict[str, str] = Field(description="Free-form release verification evidence")


@cache
def locate_git() -> Path:
    """Resolve the Git executable once per process to an absolute, symlink-free path.

    Returns:
        Path: Absolute path of `git`.

    Raises:
        ManifestError: If Git is not on `PATH`.
    """
    located = shutil.which("git")
    if located is None:
        raise ManifestError("`git` not found on PATH")
    return Path(located).resolve()


def run_git(repo_root: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    """Run one Git command against a repository without a shell.

    Parameters:
        repo_root (Path): Repository worktree.
        *args (str): Arguments after `git -C <repo_root>`.
        check (bool): Raise on a nonzero Git exit status.

    Returns:
        subprocess.CompletedProcess[str]: Captured Git output.

    Raises:
        ManifestError: If Git is missing or cannot execute successfully when `check` is set.
    """
    argv = [str(locate_git()), "-C", str(repo_root), *args]
    try:
        return subprocess.run(argv, capture_output=True, text=True, check=check)
    except subprocess.CalledProcessError as e:
        raise ManifestError(f"`{' '.join(argv)}` failed: {e.stderr.strip()}") from e
    except OSError as e:
        raise ManifestError(f"`{' '.join(argv)}` could not start: {e}") from e


def sha256_file(path: Path) -> str:
    """Hash one regular file in streaming chunks.

    Parameters:
        path (Path): Existing file to hash.

    Returns:
        str: Lowercase SHA-256 digest.

    Raises:
        ManifestError: If `path` is not a regular file.
    """
    if not path.is_file():
        raise ManifestError(f"Path is not a regular file: '{path}'")
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def parse_pairs(values: Sequence[str], option: str) -> dict[str, str]:
    """Parse repeated `NAME=VALUE` command-line arguments.

    Parameters:
        values (Sequence[str]): Raw repeated option values.
        option (str): Option spelling for diagnostics.

    Returns:
        dict[str, str]: Pair mapping in command-line order.

    Raises:
        ManifestError: If a value is malformed or repeats a name.
    """
    pairs: dict[str, str] = {}
    for value in values:
        name, separator, item = value.partition("=")
        if not separator or not name or not item:
            raise ManifestError(f"`{option}` must be NAME=VALUE, got '{value}'")
        if name in pairs:
            raise ManifestError(f"`{option}` repeats name '{name}'")
        pairs[name] = item
    return pairs


def submodule_urls(repo_root: Path) -> dict[str, str]:
    """Read Gitlink paths and URLs from `.gitmodules`.

    Parameters:
        repo_root (Path): Monorepo root.

    Returns:
        dict[str, str]: URL by submodule path.

    Raises:
        ManifestError: If `.gitmodules` declares an incomplete or duplicate path.
    """
    gitmodules = repo_root / ".gitmodules"
    if not gitmodules.is_file():
        return {}
    done = run_git(
        repo_root, "config", "--file", str(gitmodules), "--get-regexp", r"^submodule\..*\.(path|url)$"
    )
    fields: dict[str, dict[str, str]] = {}
    for line in done.stdout.splitlines():
        key, separator, value = line.partition(" ")
        if not separator:
            raise ManifestError(f"Malformed `.gitmodules` entry: '{line}'")
        prefix, field = key.rsplit(".", 1)
        fields.setdefault(prefix, {})[field] = value
    urls: dict[str, str] = {}
    for values in fields.values():
        path = values.get("path")
        url = values.get("url")
        if not path or not url:
            raise ManifestError("Each `.gitmodules` submodule requires both `path` and `url`")
        if path in urls:
            raise ManifestError(f"Duplicate `.gitmodules` path '{path}'")
        urls[path] = url
    return urls


def gitlinks(repo_root: Path) -> list[ForkIdentity]:
    """Describe every Gitlink that `git submodule status` reports.

    Parameters:
        repo_root (Path): Monorepo root.

    Returns:
        list[ForkIdentity]: Gitlink identities in Git's status order.

    Raises:
        ManifestError: If Git status or `.gitmodules` data is malformed.
    """
    urls = submodule_urls(repo_root)
    indexed = indexed_gitlinks(repo_root)
    done = run_git(repo_root, "submodule", "status")
    forks: list[ForkIdentity] = []
    for line in done.stdout.splitlines():
        if not line:
            continue
        match = SUBMODULE_STATUS.fullmatch(line)
        if match is None:
            raise ManifestError(f"Malformed `git submodule status` entry: '{line}'")
        state = match.group("state")
        path = match.group("path")
        if path not in urls:
            raise ManifestError(f"Gitlink '{path}' has no URL in `.gitmodules`")
        if path not in indexed:
            raise ManifestError(
                f"`git submodule status` reports '{path}' but the index has no Gitlink for it"
            )
        # The identity is the INDEXED Gitlink. A `+` entry carries the checkout's HEAD instead,
        # which is a different commit when the fork was moved by hand (allowed only with
        # `--allow-dirty`); recording that would misidentify the selected source.
        commit = indexed[path]
        checkout = repo_root / path
        initialized = state[0] != "-" and (checkout / ".git").exists()
        tag = exact_tag(checkout, commit) if initialized else None
        forks.append(
            ForkIdentity(
                path=path,
                commit=commit,
                remote_url=urls[path],
                initialized=initialized,
                tag=tag,
                fetched_tag_object=None,
            )
        )
    return forks


def indexed_gitlinks(repo_root: Path) -> dict[str, str]:
    """Read every Gitlink (mode 160000) from the monorepo index.

    Parameters:
        repo_root (Path): Monorepo root.

    Returns:
        dict[str, str]: Gitlink path -> commit, from `git ls-files -s`.

    Raises:
        ManifestError: If an index line cannot be parsed.
    """
    done = run_git(repo_root, "ls-files", "-s")
    links: dict[str, str] = {}
    for line in done.stdout.splitlines():
        if not line.startswith("160000 "):
            continue
        match = INDEX_GITLINK.fullmatch(line)
        if match is None:
            raise ManifestError(f"Malformed index Gitlink entry: '{line}'")
        links[match.group("path")] = match.group("commit")
    return links


def exact_tag(checkout: Path, commit: str) -> str | None:
    """Return an exact local tag for one commit of a submodule checkout, if Git has one.

    Parameters:
        checkout (Path): Initialized submodule checkout.
        commit (str): The indexed Gitlink commit to describe (not the checkout's HEAD).

    Returns:
        str | None: Exact tag name, or `None` when no local exact tag points at `commit`.
    """
    try:
        done = run_git(checkout, "describe", "--tags", "--exact-match", commit)
    except ManifestError:
        return None
    return done.stdout.strip() or None


def owned_packages(repo_root: Path) -> list[OwnedPackage]:
    """Read the selected owned package manifests.

    Parameters:
        repo_root (Path): Monorepo root.

    Returns:
        list[OwnedPackage]: Package identities in the declared package order.

    Raises:
        ManifestError: If a manifest is unreadable or lacks required strict fields.
    """
    packages: list[OwnedPackage] = []
    for directory in OWNED_PACKAGE_DIRECTORIES:
        path = repo_root / "packages" / directory / "package.json"
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            raise ManifestError(f"Cannot read package manifest '{path}': {e}") from e
        if (
            not isinstance(raw, dict)
            or type(raw.get("name")) is not str
            or type(raw.get("version")) is not str
        ):
            raise ManifestError(f"Package manifest '{path}' needs string `name` and `version`")
        # npm treats a missing `private` as publishable; only an explicit non-boolean is malformed.
        private = raw.get("private", False)
        if type(private) is not bool:
            raise ManifestError(f"Package manifest '{path}' has a non-boolean `private`")
        packages.append(
            OwnedPackage(name=raw["name"], version=raw["version"], private=private, tarball_sha256=None)
        )
    return packages


def third_party_identity(repo_root: Path) -> ThirdPartyIdentity:
    """Record existing root and integration resolution lockfiles.

    Parameters:
        repo_root (Path): Monorepo root.

    Returns:
        ThirdPartyIdentity: Root npm lock schema and digests of existing lockfiles.

    Raises:
        ManifestError: If an existing root npm lockfile lacks an integer `lockfileVersion`.
    """
    files: list[LockedFile] = []
    lockfile_version: int | None = None
    for relative in (Path("package-lock.json"), Path("integration/uv.lock")):
        path = repo_root / relative
        if path.is_file():
            files.append(LockedFile(path=relative.as_posix(), sha256=sha256_file(path)))
    package_lock = repo_root / "package-lock.json"
    if package_lock.is_file():
        try:
            raw = json.loads(package_lock.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            raise ManifestError(f"Cannot read root lockfile '{package_lock}': {e}") from e
        value = raw.get("lockfileVersion") if isinstance(raw, dict) else None
        if type(value) is not int:
            raise ManifestError(f"Root lockfile '{package_lock}' needs integer `lockfileVersion`")
        lockfile_version = value
    return ThirdPartyIdentity(package_lock_lockfile_version=lockfile_version, files=files)


def artifacts(specifications: Mapping[str, str], urls: Mapping[str, str]) -> list[Artifact]:
    """Hash explicit artifact paths and join optional immutable URLs.

    Parameters:
        specifications (Mapping[str, str]): Artifact name to source path.
        urls (Mapping[str, str]): Artifact name to published URL.

    Returns:
        list[Artifact]: Artifact identities in command-line order.

    Raises:
        ManifestError: If a URL lacks an artifact or an artifact path is invalid.
    """
    unknown = sorted(set(urls) - set(specifications))
    if unknown:
        raise ManifestError(f"`--artifact-url` has no matching `--artifact`: {', '.join(unknown)}")
    result: list[Artifact] = []
    for name, raw_path in specifications.items():
        path = Path(raw_path).expanduser().resolve()
        if not path.is_file():
            raise ManifestError(f"Artifact is not a regular file: '{path}'")
        result.append(
            Artifact(
                name=name,
                basename=path.name,
                size=path.stat().st_size,
                sha256=sha256_file(path),
                url=urls.get(name),
            )
        )
    return result


def build_manifest(
    repo_root: Path,
    release_id: str,
    artifact_specs: Mapping[str, str],
    artifact_urls: Mapping[str, str],
    evidence: Mapping[str, str],
    *,
    allow_dirty: bool = False,
    created_at: str | None = None,
) -> ReleaseManifest:
    """Generate and validate one release manifest.

    Parameters:
        repo_root (Path): Monorepo root.
        release_id (str): Immutable caller-selected release id.
        artifact_specs (Mapping[str, str]): Artifact name to local source path.
        artifact_urls (Mapping[str, str]): Artifact name to immutable URL.
        evidence (Mapping[str, str]): Free-form release evidence.
        allow_dirty (bool): Permit and record a dirty monorepo worktree.
        created_at (str | None): UTC ISO timestamp for tests; current UTC time when omitted.

    Returns:
        ReleaseManifest: Fully validated schema version 1 manifest.

    Raises:
        ManifestError: If source identity cannot be established or the tree is dirty without permission.
    """
    repo_root = repo_root.resolve()
    status = run_git(repo_root, "status", "--porcelain").stdout
    dirty = bool(status.strip())
    if dirty and not allow_dirty:
        raise ManifestError("Monorepo worktree is dirty; commit changes or pass `--allow-dirty`")
    commit = run_git(repo_root, "rev-parse", "HEAD").stdout.strip()
    timestamp = created_at or datetime.now(UTC).isoformat().replace("+00:00", "Z")
    try:
        raw = {
            "schema_version": 1,
            "release": {"id": release_id, "created_at": timestamp, "commit": commit, "dirty": dirty},
            "forks": [fork.model_dump() for fork in gitlinks(repo_root)],
            "owned_packages": [package.model_dump() for package in owned_packages(repo_root)],
            "third_party": third_party_identity(repo_root).model_dump(),
            "artifacts": [artifact.model_dump() for artifact in artifacts(artifact_specs, artifact_urls)],
            "evidence": dict(evidence),
        }
        return ReleaseManifest.model_validate(raw)
    except ValidationError as e:
        # Nested models validate while `raw` is built; an empty package version is a manifest
        # failure too, not a stack trace.
        raise ManifestError(f"Release manifest failed validation: {e}") from e


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    """Parse generator options.

    Parameters:
        argv (Sequence[str] | None): Arguments, or `None` for `sys.argv`.

    Returns:
        argparse.Namespace: Parsed options.
    """
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    parser.add_argument("release_id", help="Immutable release id, e.g. 2026-10-17-startup-trust")
    parser.add_argument("--repo-root", type=Path, default=REPO_ROOT, help="Monorepo root")
    parser.add_argument("--output", type=Path, help="Output path; default: releases/<release-id>.json")
    parser.add_argument("--allow-dirty", action="store_true", help="Record instead of refusing a dirty tree")
    parser.add_argument(
        "--artifact", action="append", default=[], metavar="NAME=PATH", help="Release artifact"
    )
    parser.add_argument(
        "--artifact-url", action="append", default=[], metavar="NAME=URL", help="Immutable artifact URL"
    )
    parser.add_argument(
        "--evidence", action="append", default=[], metavar="KEY=VALUE", help="Release evidence"
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    """Generate a manifest and write it atomically enough for a local release workflow.

    Parameters:
        argv (Sequence[str] | None): Arguments, or `None` for `sys.argv`.

    Returns:
        int: 0 on success, 1 for repository/input failures.
    """
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    args = parse_args(argv)
    try:
        artifact_specs = parse_pairs(args.artifact, "--artifact")
        artifact_urls = parse_pairs(args.artifact_url, "--artifact-url")
        evidence = parse_pairs(args.evidence, "--evidence")
        output = args.output or args.repo_root / "releases" / f"{args.release_id}.json"
        manifest = build_manifest(
            args.repo_root,
            args.release_id,
            artifact_specs,
            artifact_urls,
            evidence,
            allow_dirty=args.allow_dirty,
        )
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(manifest.model_dump_json(indent=2) + "\n", encoding="utf-8")
    except ManifestError as e:
        LOGGER.error(f"FAILED: {e}")
        return 1
    LOGGER.info(f"release manifest: wrote '{output}'")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
