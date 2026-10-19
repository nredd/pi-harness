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

from harness.paths import GIT_BIN, REPO_ROOT

LOGGER = logging.getLogger(__name__)
TAG = re.compile(r"^v(?P<version>\d+\.\d+\.\d+)-nredd\.\d+$")


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
    """Collect recorded release asset identities, refusing contradictory manifests.

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
            if not re.fullmatch(r"[0-9a-f]{64}", digest) or (url in checksums and checksums[url] != digest):
                raise ValueError(f"Conflicting or invalid checksum for '{url}' in '{path}'")
            checksums[url] = digest
    if not checksums:
        raise ValueError(f"No recorded release checksums for '{tag}' in '{manifests}'")
    return checksums


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
    checksums = manifest_checksums(tag, manifests)
    version = match["version"]
    urls = [
        f"https://github.com/nredd/pi/releases/download/{tag}/earendil-works-{package}-{version}.tgz"
        for package in ("pi-coding-agent", "pi-tui")
    ]
    for url in urls:
        if url not in checksums:
            raise ValueError(f"No recorded release checksum for '{url}'")
    npm = shutil.which("npm")
    if npm is None:
        raise FileNotFoundError("Release installation requires `npm`")
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
        assets.append(asset)
    try:
        subprocess.check_output(
            [
                npm,
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
    except subprocess.CalledProcessError as error:
        raise RuntimeError(f"Core release npm installation failed: {error.output[-6000:]}") from error
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
