"""Install the released core into a private prefix using the tap formula's npm/resource steps.

No tap is read at runtime. The copied recipe installs the coding-agent tgz globally, replaces
its nested pi-tui with the release tgz, and prunes foreign native prebuilds.

References:
- https://github.com/nredd/homebrew-tap/blob/main/Formula/pi-coding-agent.rb
- https://github.com/nredd/pi/releases
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import platform
import re
import shutil
import subprocess
import tarfile
from collections.abc import Callable, Mapping
from pathlib import Path
from types import MappingProxyType
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from harness.paths import GH_BIN, GIT_BIN, NPM_BIN

LOGGER = logging.getLogger(__name__)
TAG = re.compile(r"^v(?P<version>\d+\.\d+\.\d+)-nredd\.\d+$")
SHA256_HEX = re.compile(r"[0-9a-f]{64}")
CODING_AGENT_TARBALL = "earendil-works-pi-coding-agent-1.3.0.tgz"
TUI_TARBALL = "earendil-works-pi-tui-1.3.0.tgz"
AGENT_CORE_TARBALL = "earendil-works-pi-agent-core-1.3.0.tgz"
AI_TARBALL = "earendil-works-pi-ai-1.3.0.tgz"
LEGACY_CHECKSUMS = MappingProxyType(
    {
        "v1.3.0-nredd.3": MappingProxyType(
            {
                CODING_AGENT_TARBALL: "753efe6fcb54da651e1dc02f6cc56dda029d55e5a40f833bdf9308dae88babd5",
                TUI_TARBALL: "ccd8f2d2aa8e99fed96394cc5ade43c13597bcdd2472552dab5957d038a5afbd",
            }
        ),
        "v1.3.0-nredd.4": MappingProxyType(
            {
                CODING_AGENT_TARBALL: "0042ebdca83a8cf92f406f097ec5f05dd131c859761c954e3f2feae0fef3cf87",
                TUI_TARBALL: "ccd8f2d2aa8e99fed96394cc5ade43c13597bcdd2472552dab5957d038a5afbd",
                AGENT_CORE_TARBALL: "e08bbd6b348a00eb97250ebfa33a722c70323b55a2d1e6f5b446513fcb5dad35",
                AI_TARBALL: "1b7ed741d704e0e288056630c1abc1a71eaec83eac148689c1d9b152361085b7",
            }
        ),
        "v1.3.0-nredd.5": MappingProxyType(
            {
                CODING_AGENT_TARBALL: "84f1c4b5075efca538a8f7b65334dba8dff265525d7b1f1f69bb0c1d677ac644",
                TUI_TARBALL: "dd8ac6c221bfd8e76fcc5b93418ba8feffd63dd705bde814aea6d4b1b46938e0",
                AGENT_CORE_TARBALL: "e08bbd6b348a00eb97250ebfa33a722c70323b55a2d1e6f5b446513fcb5dad35",
                AI_TARBALL: "1b7ed741d704e0e288056630c1abc1a71eaec83eac148689c1d9b152361085b7",
            }
        ),
        "v1.3.0-nredd.6": MappingProxyType(
            {
                CODING_AGENT_TARBALL: "0c1b9549cfed58c19f03b642cb259bf52f83beb1a339f154e5616c9b28c939b8",
                TUI_TARBALL: "dd8ac6c221bfd8e76fcc5b93418ba8feffd63dd705bde814aea6d4b1b46938e0",
                AGENT_CORE_TARBALL: "e08bbd6b348a00eb97250ebfa33a722c70323b55a2d1e6f5b446513fcb5dad35",
                AI_TARBALL: "1b7ed741d704e0e288056630c1abc1a71eaec83eac148689c1d9b152361085b7",
            }
        ),
        "v1.3.0-nredd.7": MappingProxyType(
            {
                CODING_AGENT_TARBALL: "16479a0cb393c7820d8b1fbcdc5c941ceb5a271dc64ecb4b8be6574df3a2e617",
                TUI_TARBALL: "dd8ac6c221bfd8e76fcc5b93418ba8feffd63dd705bde814aea6d4b1b46938e0",
            }
        ),
    }
)
LEGACY_RELEASE_TAGS = frozenset(LEGACY_CHECKSUMS)
# Every asset the harness consumes, coding-agent and tui first: they are the ones npm installs.
RELEASE_PACKAGES = ("pi-coding-agent", "pi-tui", "pi-agent-core", "pi-ai")
CORE_REPO = "nredd/pi"
ATTESTATION_WORKFLOW = f"{CORE_REPO}/.github/workflows/fork-release.yml"
ATTESTATIONS_API = "https://api.github.com"
RATE_LIMIT_STATUSES = frozenset({403, 429})
# Every variable `gh` reads a GitHub token from; only `gh`'s login fallback may see them.
# https://cli.github.com/manual/gh_help_environment
GITHUB_TOKEN_VARIABLES = frozenset(
    {"GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"}
)
ProvenanceCheck = Callable[[Path, str], None]


class AttestationRateLimitedError(RuntimeError):
    """GitHub's anonymous API rate limit refused an attestation lookup."""


def without_github_tokens(env: Mapping[str, str]) -> dict[str, str]:
    """Return a child environment with every GitHub token variable removed.

    Parameters:
        env (Mapping[str, str]): environment to copy.

    Returns:
        dict[str, str]: `env` minus `GITHUB_TOKEN_VARIABLES`.
    """
    return {key: value for key, value in env.items() if key not in GITHUB_TOKEN_VARIABLES}


def gitlink_tag(directory: Path) -> str:
    """Require an exact release tag on the supplied Gitlink checkout.

    Parameters:
        directory (Path): initialized core fork.

    Returns:
        str: exact tag, never a nearest ancestor or installed-version guess.

    Raises:
        RuntimeError: the Gitlink is untagged.
    """
    try:
        return subprocess.check_output(
            [GIT_BIN, "-C", str(directory), "describe", "--tags", "--exact-match"],
            text=True,
            stderr=subprocess.STDOUT,
        ).strip()
    except subprocess.CalledProcessError as error:
        raise RuntimeError(
            f"Core Gitlink at '{directory}' is untagged; release it before gating pins: {error.output}"
        ) from error


def release_asset_url(tag: str, name: str) -> str:
    """Return the GitHub release download URL of one core fork asset.

    Parameters:
        tag (str): core fork release tag, e.g. `v1.3.0-nredd.7`.
        name (str): asset file name.

    Returns:
        str: download URL.
    """
    return f"https://github.com/nredd/pi/releases/download/{tag}/{name}"


def release_checksums(tag: str) -> dict[str, str]:
    """Read a release checksum file, preserving named pre-attestation releases.

    Parameters:
        tag (str): requested core tag.

    Returns:
        dict[str, str]: release asset URL -> sha256 mapping.

    Raises:
        ValueError: malformed, incomplete, or unrecognized release identities.
    """
    if tag in LEGACY_RELEASE_TAGS:
        return {release_asset_url(tag, name): digest for name, digest in LEGACY_CHECKSUMS[tag].items()}
    try:
        with urlopen(release_asset_url(tag, "SHA256SUMS"), timeout=120) as response:
            contents = response.read().decode("utf-8")
    except OSError as error:
        raise ValueError(f"Could not download release checksums for '{tag}'") from error
    checksums: dict[str, str] = {}
    for line in contents.splitlines():
        fields = line.split(maxsplit=1)
        if len(fields) != 2:
            raise ValueError(f"Malformed release checksum line for '{tag}': '{line}'")
        digest, name = fields
        if not SHA256_HEX.fullmatch(digest) or "/" in name or name.startswith("*"):
            raise ValueError(f"Invalid release checksum line for '{tag}': '{line}'")
        url = release_asset_url(tag, name)
        if url in checksums:
            raise ValueError(f"Duplicate release checksum for '{url}'")
        checksums[url] = digest
    if not checksums:
        raise ValueError(f"No release checksums for '{tag}'")
    return checksums


def _error_tail(error: subprocess.CalledProcessError | subprocess.TimeoutExpired) -> str:
    """Return the last 6000 characters of a failed subprocess's captured output.

    Parameters:
        error (subprocess.CalledProcessError | subprocess.TimeoutExpired): the failure; its
            `output` may be `str`, `bytes` or `None`.

    Returns:
        str: decoded output tail, empty when nothing was captured.
    """
    output = error.output or ""
    if isinstance(output, bytes):
        output = output.decode("utf-8", errors="replace")
    return output[-6000:]


def attestation_bundle(repo: str, path: Path, destination: Path) -> Path:
    """Download the public GitHub attestation bundles for one artifact digest, without credentials.

    The attestations API answers anonymously for public repositories, so a verifier needs no
    GitHub login and no token ever leaves the machine. The bundles are only inputs to
    `gh attestation verify --bundle`, which checks them; they are trusted for nothing else.

    Parameters:
        repo (str): `owner/name` that must have produced the attestation.
        path (Path): artifact whose SHA-256 selects the attestations.
        destination (Path): JSON Lines file to write, one Sigstore bundle per line.

    Returns:
        Path: `destination`.

    Raises:
        AttestationRateLimitedError: GitHub's anonymous rate limit refused the request.
        RuntimeError: the API could not be read, answered malformed JSON, or lists no attestation.
    """
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    url = f"{ATTESTATIONS_API}/repos/{repo}/attestations/sha256:{digest}"
    request = Request(url, headers={"Accept": "application/vnd.github+json"})
    try:
        with urlopen(request, timeout=120) as response:
            document = json.loads(response.read())
    except HTTPError as error:
        if error.code in RATE_LIMIT_STATUSES:
            raise AttestationRateLimitedError(
                f"Anonymous attestations API refused '{url}': {error}"
            ) from error
        raise RuntimeError(f"Could not read attestations for '{path.name}' from '{url}': {error}") from error
    except (OSError, ValueError) as error:
        raise RuntimeError(f"Could not read attestations for '{path.name}' from '{url}': {error}") from error
    attestations = document.get("attestations") if isinstance(document, dict) else None
    bundles = [item.get("bundle") for item in attestations or [] if isinstance(item, dict)]
    if not bundles or not all(isinstance(bundle, dict) for bundle in bundles):
        raise RuntimeError(f"No attestation bundle for '{path.name}' (sha256 '{digest}') in '{repo}'")
    destination.write_text("".join(json.dumps(bundle) + "\n" for bundle in bundles))
    return destination


def verify_attestation(
    path: Path, repo: str, signer_workflow: str, source_ref: str, bundle: Path | None = None
) -> None:
    """Require GitHub build provenance for one artifact from an exact repository, workflow and ref.

    Parameters:
        path (Path): artifact to verify.
        repo (str): `owner/name` the attestation must belong to.
        signer_workflow (str): `owner/name/.github/workflows/<file>` that must have signed it.
        source_ref (str): exact Git ref the signing run must have built.
        bundle (Path | None): local bundle file; absent, `gh` fetches with its own login.

    Raises:
        FileNotFoundError: GitHub CLI is unavailable.
        RuntimeError: the artifact lacks the required provenance identity.
    """
    if not Path(GH_BIN).is_file():
        raise FileNotFoundError(f"Attestation verification requires `gh` at '{GH_BIN}'")
    # A local bundle needs no GitHub API call, so `gh` gets a token only when it must fetch.
    env = without_github_tokens(os.environ) if bundle is not None else None
    try:
        subprocess.check_output(
            [
                GH_BIN,
                "attestation",
                "verify",
                str(path),
                *(["--bundle", str(bundle)] if bundle is not None else []),
                "--repo",
                repo,
                "--signer-workflow",
                signer_workflow,
                "--source-ref",
                source_ref,
                "--deny-self-hosted-runners",
            ],
            env=env,
            text=True,
            stderr=subprocess.STDOUT,
            timeout=120,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise RuntimeError(
            f"GitHub provenance verification failed for '{path}': {_error_tail(error)}"
        ) from error


def verify_public_attestation(path: Path, repo: str, signer_workflow: str, source_ref: str) -> None:
    """Verify provenance from the anonymous bundle, falling back to `gh`'s own login when rate-limited.

    The fallback lets `gh` fetch the attestation with whatever login it already has (`gh auth
    login` or `GH_TOKEN`); this module never reads a credential. Without one, the rate limit
    stays a verification failure.

    Parameters:
        path (Path): artifact to verify.
        repo (str): `owner/name` the attestation must belong to.
        signer_workflow (str): workflow that must have signed it.
        source_ref (str): exact Git ref the signing run must have built.

    Raises:
        FileNotFoundError: GitHub CLI is unavailable.
        RuntimeError: no bundle exists, or the artifact lacks the required provenance identity.
    """
    try:
        bundle: Path | None = attestation_bundle(repo, path, path.with_name(f"{path.name}.sigstore.jsonl"))
    except AttestationRateLimitedError as error:
        LOGGER.warning(f"{error}; retrying with `gh attestation verify` and gh's own login")
        bundle = None
    verify_attestation(path, repo, signer_workflow, source_ref, bundle)


def verify_provenance(path: Path, tag: str, bundle: Path | None = None) -> None:
    """Require GitHub provenance from the dedicated core-release workflow.

    Parameters:
        path (Path): downloaded release artifact.
        tag (str): exact core tag bound to the source ref.
        bundle (Path | None): local attestation bundle; absent, `gh` fetches with its own login.

    Raises:
        FileNotFoundError: GitHub CLI is unavailable.
        RuntimeError: the artifact lacks the required provenance identity.
    """
    verify_attestation(path, CORE_REPO, ATTESTATION_WORKFLOW, f"refs/tags/{tag}", bundle)


def verify_provenance_anonymously(path: Path, tag: str) -> None:
    """Verify core provenance from the public attestation bundle (see `verify_public_attestation`).

    Parameters:
        path (Path): downloaded release artifact.
        tag (str): exact core tag bound to the source ref.

    Raises:
        FileNotFoundError: GitHub CLI is unavailable.
        RuntimeError: no bundle exists or it does not prove the required identity.
    """
    verify_public_attestation(path, CORE_REPO, ATTESTATION_WORKFLOW, f"refs/tags/{tag}")


def verify_asset(path: Path, url: str, checksums: dict[str, str]) -> None:
    """Require downloaded bytes to match a recorded release identity.

    Parameters:
        path (Path): downloaded asset.
        url (str): canonical release URL.
        checksums (dict[str, str]): tag's recorded assets.

    Raises:
        ValueError: no recorded checksum for this asset or its bytes disagree.
    """
    if url not in checksums:
        raise ValueError(f"No recorded release checksum for '{url}'")
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if checksums[url] != actual:
        raise ValueError(
            f"Release checksum mismatch for '{url}': '{actual}', expected '{checksums.get(url)}'"
        )
    LOGGER.info(f"Release asset '{url}' sha256={actual}")


def prune_native(node_modules: Path, system: str, arch: str) -> None:
    """Keep only host-native prebuild directories, matching the formula.

    Parameters:
        node_modules (Path): coding-agent's nested dependencies.
        system (str): node OS name.
        arch (str): node architecture name.
    """
    for pattern, wanted in (
        ("koffi/build/koffi/*", f"{system}_{arch}"),
        ("@earendil-works/pi-tui/native/**/prebuilds/*", f"{system}-{arch}"),
    ):
        for directory in node_modules.glob(pattern):
            if directory.is_dir() and directory.name != wanted:
                shutil.rmtree(directory)


def release_tarballs(tag: str) -> list[str]:
    """Return the release tarball filenames of `RELEASE_PACKAGES` for one core tag, in order.

    Parameters:
        tag (str): core fork release tag.

    Returns:
        list[str]: filenames; the first two are the ones `fetch_release` installs.

    Raises:
        ValueError: not a core fork release tag.
    """
    match = TAG.fullmatch(tag)
    if match is None:
        raise ValueError(f"Not a core fork release tag: '{tag}'")
    return [f"earendil-works-{package}-{match['version']}.tgz" for package in RELEASE_PACKAGES]


def fetch_release(
    tag: str,
    prefix: Path,
    provenance: ProvenanceCheck | None = None,
    checksums: Mapping[str, str] | None = None,
) -> Path:
    """Verify every consumed release asset, then install into a new private prefix, never the live one.

    New tags must publish all of `RELEASE_PACKAGES`. Legacy tags are verified for exactly the assets
    in `LEGACY_CHECKSUMS`. Only coding-agent and tui are installed; `pi-agent-core` and `pi-ai` are
    verified because pi-harness's root overrides consume them.

    Parameters:
        tag (str): released core tag.
        prefix (Path): empty installation prefix.
        provenance (ProvenanceCheck | None): per-asset verifier taking the asset and tag;
            defaults to `verify_provenance` (the caller's `gh` login).
        checksums (Mapping[str, str] | None): release URL -> SHA-256 the downloaded bytes must
            match; defaults to `release_checksums(tag)`.

    Returns:
        Path: private pi executable.

    Raises:
        ValueError: invalid tag, nonempty prefix, or missing/mismatched recorded checksums.
        RuntimeError: provenance or npm installation failed.
        FileNotFoundError: npm is unavailable.
    """
    names = release_tarballs(tag)
    if prefix.exists() and any(prefix.iterdir()):
        raise ValueError(f"Release prefix must be empty: '{prefix}'")
    checksums = dict(release_checksums(tag) if checksums is None else checksums)
    urls = [release_asset_url(tag, name) for name in names]
    if tag in LEGACY_RELEASE_TAGS:
        urls = [url for url in urls if url in checksums]
    for url in urls:
        if url not in checksums:
            raise ValueError(f"No recorded release checksum for '{url}'")
    if not Path(NPM_BIN).is_file():
        raise FileNotFoundError(f"Release installation requires `npm` at '{NPM_BIN}'")
    prefix.mkdir(parents=True, exist_ok=True)
    home = prefix / "fetch-home"
    home.mkdir()
    for name in ("npmrc-user", "npmrc-global"):
        (prefix / name).touch()
    env = {
        "PATH": os.environ.get("PATH", os.defpath),
        "HOME": str(home),
        "npm_config_userconfig": str(prefix / "npmrc-user"),
        "npm_config_globalconfig": str(prefix / "npmrc-global"),
        "npm_config_cache": str(prefix / "npm-cache"),
        "PI_SKIP_VERSION_CHECK": "1",
    }
    assets = []
    for url in urls:
        asset = prefix / url.rsplit("/", 1)[1]
        with urlopen(url, timeout=120) as response:
            asset.write_bytes(response.read())
        verify_asset(asset, url, checksums)
        if tag not in LEGACY_RELEASE_TAGS:
            (provenance or verify_provenance)(asset, tag)
        assets.append(asset)
    try:
        subprocess.check_output(
            [
                NPM_BIN,
                "install",
                "--global",
                "--prefix",
                str(prefix),
                "--min-release-age=0",
                "--build-from-source",
                "--ignore-scripts",
                "--loglevel=silly",
                str(assets[0]),
            ],
            cwd=prefix,
            env=env,
            text=True,
            stderr=subprocess.STDOUT,
            timeout=600,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise RuntimeError(f"Core release npm installation failed: {_error_tail(error)}") from error
    modules = prefix / "lib/node_modules/@earendil-works/pi-coding-agent/node_modules"
    destination = modules / "@earendil-works/pi-tui"
    if destination.exists():
        shutil.rmtree(destination)
    unpack = prefix / "tui-resource"
    with tarfile.open(assets[1]) as archive:
        archive.extractall(unpack, filter="data")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(unpack / "package"), destination)
    system = "darwin" if platform.system() == "Darwin" else "linux"
    arch = "arm64" if platform.machine() in {"arm64", "aarch64"} else "x64"
    prune_native(modules, system, arch)
    binary = prefix / "bin/pi"
    LOGGER.info(f"Resolved binary '{binary}' from '{tag}'")
    return binary


def main() -> None:
    """Fetch a supplied tag or the exact initialized Gitlink tag."""
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0] if __doc__ else None)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--tag")
    source.add_argument("--gitlink", type=Path)
    parser.add_argument("--prefix", type=Path, required=True)
    args = parser.parse_args()
    tag = args.tag or gitlink_tag(args.gitlink.resolve())
    fetch_release(tag, args.prefix.resolve())


if __name__ == "__main__":
    main()
