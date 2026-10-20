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
from pathlib import Path
from urllib.request import urlopen

from harness.paths import GH_BIN, GIT_BIN, NPM_BIN, REPO_ROOT

LOGGER = logging.getLogger(__name__)
TAG = re.compile(r"^v(?P<version>\d+\.\d+\.\d+)-nredd\.\d+$")
SHA256_HEX = re.compile(r"[0-9a-f]{64}")
CODING_AGENT_TARBALL = "earendil-works-pi-coding-agent-1.3.0.tgz"
TUI_TARBALL = "earendil-works-pi-tui-1.3.0.tgz"
LEGACY_CHECKSUMS = {
    "v1.3.0-nredd.3": {
        CODING_AGENT_TARBALL: "753efe6fcb54da651e1dc02f6cc56dda029d55e5a40f833bdf9308dae88babd5",
        TUI_TARBALL: "ccd8f2d2aa8e99fed96394cc5ade43c13597bcdd2472552dab5957d038a5afbd",
    },
    "v1.3.0-nredd.4": {
        CODING_AGENT_TARBALL: "0042ebdca83a8cf92f406f097ec5f05dd131c859761c954e3f2feae0fef3cf87",
        TUI_TARBALL: "ccd8f2d2aa8e99fed96394cc5ade43c13597bcdd2472552dab5957d038a5afbd",
    },
    "v1.3.0-nredd.5": {
        CODING_AGENT_TARBALL: "84f1c4b5075efca538a8f7b65334dba8dff265525d7b1f1f69bb0c1d677ac644",
        TUI_TARBALL: "dd8ac6c221bfd8e76fcc5b93418ba8feffd63dd705bde814aea6d4b1b46938e0",
    },
    "v1.3.0-nredd.6": {
        CODING_AGENT_TARBALL: "0c1b9549cfed58c19f03b642cb259bf52f83beb1a339f154e5616c9b28c939b8",
        TUI_TARBALL: "dd8ac6c221bfd8e76fcc5b93418ba8feffd63dd705bde814aea6d4b1b46938e0",
    },
    "v1.3.0-nredd.7": {
        CODING_AGENT_TARBALL: "16479a0cb393c7820d8b1fbcdc5c941ceb5a271dc64ecb4b8be6574df3a2e617",
        TUI_TARBALL: "dd8ac6c221bfd8e76fcc5b93418ba8feffd63dd705bde814aea6d4b1b46938e0",
    },
}
LEGACY_RELEASE_TAGS = frozenset(LEGACY_CHECKSUMS)
ATTESTATION_WORKFLOW = "nredd/pi/.github/workflows/fork-release.yml"


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


def manifest_checksums(tag: str, manifests: Path) -> dict[str, str]:
    """Collect release asset identities, skipping explicit artifact-free source snapshots.

    Parameters:
        tag (str): requested core tag.
        manifests (Path): repository release manifests.

    Returns:
        dict[str, str]: nonempty asset URL -> sha256 mapping.

    Raises:
        ValueError: no recorded checksums, or this tag's manifest is incomplete or contradictory.
    """
    checksums: dict[str, str] = {}
    prefix = f"https://github.com/nredd/pi/releases/download/{tag}/"
    for path in sorted(manifests.glob("*.json")):
        doc = json.loads(path.read_text())
        # Gitlink-only manifests record source provenance, not a new core asset release.
        if doc.get("artifacts") == []:
            continue
        matches = any(
            fork.get("path") == "forks/pi" and fork.get("tag") == tag for fork in doc.get("forks", [])
        )
        assets = [asset for asset in doc.get("artifacts", []) if str(asset.get("url", "")).startswith(prefix)]
        if not matches and not assets:
            continue
        if not assets:
            raise ValueError(f"Manifest '{path}' names '{tag}' but records no release assets")
        for asset in assets:
            url, digest = asset["url"], asset["sha256"]
            if not SHA256_HEX.fullmatch(digest) or (url in checksums and checksums[url] != digest):
                raise ValueError(f"Conflicting or invalid checksum for '{url}' in '{path}'")
            checksums[url] = digest
    if not checksums:
        raise ValueError(f"No recorded release checksums for '{tag}' in '{manifests}'")
    return checksums


def release_checksums(tag: str, manifests: Path) -> dict[str, str]:
    """Read a release checksum file, preserving named pre-attestation releases.

    Parameters:
        tag (str): requested core tag.
        manifests (Path): repository release manifests holding legacy identities.

    Returns:
        dict[str, str]: release asset URL -> sha256 mapping.

    Raises:
        ValueError: malformed, incomplete, or unrecognized release identities.
    """
    base = f"https://github.com/nredd/pi/releases/download/{tag}/"
    if tag in LEGACY_RELEASE_TAGS:
        return {f"{base}{name}": digest for name, digest in LEGACY_CHECKSUMS[tag].items()}
    try:
        with urlopen(f"{base}SHA256SUMS", timeout=120) as response:
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
        url = f"{base}{name}"
        if url in checksums:
            raise ValueError(f"Duplicate release checksum for '{url}'")
        checksums[url] = digest
    if not checksums:
        raise ValueError(f"No release checksums for '{tag}'")
    return checksums


def verify_provenance(path: Path, tag: str) -> None:
    """Require GitHub provenance from the dedicated core-release workflow.

    Parameters:
        path (Path): downloaded release artifact.
        tag (str): exact core tag bound to the source ref.

    Raises:
        FileNotFoundError: GitHub CLI is unavailable.
        RuntimeError: the artifact lacks the required provenance identity.
    """
    if not Path(GH_BIN).is_file():
        raise FileNotFoundError(f"Core release verification requires `gh` at '{GH_BIN}'")
    try:
        subprocess.check_output(
            [
                GH_BIN,
                "attestation",
                "verify",
                str(path),
                "--repo",
                "nredd/pi",
                "--signer-workflow",
                ATTESTATION_WORKFLOW,
                "--source-ref",
                f"refs/tags/{tag}",
                "--deny-self-hosted-runners",
            ],
            text=True,
            stderr=subprocess.STDOUT,
            timeout=120,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        output = getattr(error, "output", "") or ""
        raise RuntimeError(
            f"Core release provenance verification failed for '{path}': {output[-6000:]}"
        ) from error


def verify_asset(path: Path, url: str, checksums: dict[str, str]) -> None:
    """Require downloaded bytes to match a recorded manifest identity.

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
    LOGGER.info(f"Release asset '{url}' sha256={actual} manifest=verified")


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


def fetch_release(tag: str, prefix: Path, manifests: Path) -> Path:
    """Install two exact release assets into a new private prefix, never the live installation.

    Parameters:
        tag (str): released core tag.
        prefix (Path): empty installation prefix.
        manifests (Path): explicit manifest directory.

    Returns:
        Path: private pi executable.

    Raises:
        ValueError: invalid tag, nonempty prefix, or missing/mismatched recorded checksums.
        FileNotFoundError: npm is unavailable.
    """
    match = TAG.fullmatch(tag)
    if match is None:
        raise ValueError(f"Not a core fork release tag: '{tag}'")
    if prefix.exists() and any(prefix.iterdir()):
        raise ValueError(f"Release prefix must be empty: '{prefix}'")
    checksums = release_checksums(tag, manifests)
    version = match["version"]
    urls = [
        f"https://github.com/nredd/pi/releases/download/{tag}/earendil-works-{package}-{version}.tgz"
        for package in ("pi-coding-agent", "pi-tui")
    ]
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
            verify_provenance(asset, tag)
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
        output = getattr(error, "output", "") or ""
        raise RuntimeError(f"Core release npm installation failed: {output[-6000:]}") from error
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
    parser.add_argument("--manifests", type=Path, default=REPO_ROOT.parent / "releases")
    args = parser.parse_args()
    tag = args.tag or gitlink_tag(args.gitlink.resolve())
    fetch_release(tag, args.prefix.resolve(), args.manifests.resolve())


if __name__ == "__main__":
    main()
