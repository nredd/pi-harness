"""Install the released core into a private prefix using the tap formula's npm/resource steps.

No tap is read at runtime. The copied recipe installs the coding-agent tgz globally, replaces
its nested pi-tui with the release tgz, and prunes foreign native prebuilds.

`--verify-root-overrides` gates the root `package.json` overrides the same way before any
`npm ci`: this module and `harness.paths` are standard library only, so it runs under a bare
`PYTHONPATH=integration python3 -m harness.release` with no `uv sync`.

References:
- https://github.com/nredd/homebrew-tap/blob/main/Formula/pi-coding-agent.rb
- https://github.com/nredd/pi/releases
- https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import logging
import os
import platform
import re
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path
from types import MappingProxyType
from urllib.request import urlopen

from harness.paths import GH_BIN, GIT_BIN, NPM_BIN, REPO_ROOT

LOGGER = logging.getLogger(__name__)
TAG = re.compile(r"^v(?P<version>\d+\.\d+\.\d+)-nredd\.\d+$")
SHA256_HEX = re.compile(r"[0-9a-f]{64}")
SRI_SHA512 = re.compile(r"sha512-[A-Za-z0-9+/]{86}==")
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
ATTESTATION_WORKFLOW = "nredd/pi/.github/workflows/fork-release.yml"
RELEASE_URL_PREFIX = "https://github.com/nredd/pi/releases/download/"
ROOT_OVERRIDE_SCOPE = "@earendil-works/"


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
    return f"{RELEASE_URL_PREFIX}{tag}/{name}"


def release_package_urls(tag: str) -> dict[str, str]:
    """Return the asset URL of every `RELEASE_PACKAGES` tarball at a core tag.

    Parameters:
        tag (str): core fork release tag.

    Returns:
        dict[str, str]: package (e.g. `pi-tui`) -> release asset URL.

    Raises:
        ValueError: `tag` is not a core fork release tag.
    """
    match = TAG.fullmatch(tag)
    if match is None:
        raise ValueError(f"Not a core fork release tag: '{tag}'")
    return {
        package: release_asset_url(tag, f"earendil-works-{package}-{match['version']}.tgz")
        for package in RELEASE_PACKAGES
    }


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
        raise RuntimeError(
            f"Core release provenance verification failed for '{path}': {_error_tail(error)}"
        ) from error


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


def download_verified_asset(url: str, tag: str, checksums: dict[str, str], destination: Path) -> Path:
    """Download one release asset, then require its recorded sha256 and, for new tags, provenance.

    Parameters:
        url (str): canonical release URL.
        tag (str): exact core tag the URL belongs to.
        checksums (dict[str, str]): the tag's recorded assets.
        destination (Path): file to write.

    Returns:
        Path: `destination`, whose bytes are verified.

    Raises:
        ValueError: no recorded checksum or the bytes disagree.
        RuntimeError: a non-legacy asset lacks the required provenance.
        FileNotFoundError: a non-legacy asset needs `gh`, which is unavailable.
    """
    with urlopen(url, timeout=120) as response:
        destination.write_bytes(response.read())
    verify_asset(destination, url, checksums)
    if tag not in LEGACY_RELEASE_TAGS:
        verify_provenance(destination, tag)
    return destination


def _npm_integrity(path: Path) -> str:
    """Return the npm SRI string (`sha512-<base64>`) of a file's bytes.

    Parameters:
        path (Path): file to digest.

    Returns:
        str: SRI integrity value as written in `package-lock.json`.
    """
    return "sha512-" + base64.b64encode(hashlib.sha512(path.read_bytes()).digest()).decode("ascii")


def _read_json_object(path: Path) -> dict[str, object]:
    """Read a JSON file that must hold an object.

    Parameters:
        path (Path): `package.json` or `package-lock.json`.

    Returns:
        dict[str, object]: parsed object.

    Raises:
        ValueError: unreadable, invalid JSON, or not an object.
    """
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Could not read JSON from '{path}': {error}") from error
    if not isinstance(data, dict):
        raise ValueError(f"Expected a JSON object in '{path}'")
    return data


def _root_override_pins(manifest: dict[str, object]) -> dict[str, tuple[str, str]]:
    """Parse the four required core overrides into exact `(tag, url)` pins.

    Parameters:
        manifest (dict[str, object]): root `package.json`.

    Returns:
        dict[str, tuple[str, str]]: package name -> (release tag, asset URL), in `RELEASE_PACKAGES` order.

    Raises:
        ValueError: a core override is missing, extra, not a plain release URL, or names a foreign asset.
    """
    overrides = manifest.get("overrides")
    if not isinstance(overrides, dict):
        raise ValueError("Root `package.json` has no `overrides` object")
    expected = [f"{ROOT_OVERRIDE_SCOPE}{package}" for package in RELEASE_PACKAGES]
    scoped = sorted(name for name in overrides if name.startswith(ROOT_OVERRIDE_SCOPE))
    if scoped != sorted(expected):
        raise ValueError(
            f"Root `{ROOT_OVERRIDE_SCOPE}*` overrides must be exactly {expected}, found {scoped}"
        )
    pins: dict[str, tuple[str, str]] = {}
    for package, name in zip(RELEASE_PACKAGES, expected, strict=True):
        url = overrides[name]
        if not isinstance(url, str) or not url.startswith(RELEASE_URL_PREFIX):
            raise ValueError(f"Override '{name}' must be a `{RELEASE_URL_PREFIX}` URL, found '{url}'")
        tag = url.removeprefix(RELEASE_URL_PREFIX).partition("/")[0]
        if TAG.fullmatch(tag) is None or url != release_package_urls(tag)[package]:
            raise ValueError(
                f"Override '{name}' is not the canonical '{package}' asset of a core tag: '{url}'"
            )
        pins[name] = (tag, url)
    return pins


def _locked_integrity(packages: dict[str, object], name: str, url: str) -> str:
    """Return the lockfile sha512 SRI of one override, requiring the lock to resolve exactly `url`.

    Parameters:
        packages (dict[str, object]): the lockfile's `packages` object.
        name (str): overridden package name.
        url (str): the override URL.

    Returns:
        str: the lockfile `integrity` value.

    Raises:
        ValueError: nested copies, a missing entry, a different `resolved`, or non-sha512 integrity.
    """
    nested = [path for path in packages if path.endswith(f"/node_modules/{name}")]
    if nested:
        raise ValueError(f"Nested lock entries {nested} bypass the override for '{name}'")
    entry = packages.get(f"node_modules/{name}")
    if not isinstance(entry, dict):
        raise ValueError(f"Lockfile has no `packages` entry for 'node_modules/{name}'")
    if entry.get("resolved") != url:
        raise ValueError(f"Lockfile `resolved` for '{name}' is '{entry.get('resolved')}', expected '{url}'")
    integrity = entry.get("integrity")
    if not isinstance(integrity, str) or not SRI_SHA512.fullmatch(integrity):
        raise ValueError(f"Lockfile `integrity` for '{name}' is not sha512 SRI: '{integrity}'")
    return integrity


def verify_root_overrides(root: Path) -> None:
    """Verify every root core override against the lockfile and the recorded release, before `npm ci`.

    For each of the four `@earendil-works` overrides: the lockfile `resolved` equals the override
    URL, its `integrity` is sha512 SRI, the downloaded tarball matches the tag's recorded sha256
    (frozen `LEGACY_CHECKSUMS` for legacy tags, a published `SHA256SUMS` covering all of
    `RELEASE_PACKAGES` otherwise) and the lockfile sha512, and non-legacy tags also pass
    `verify_provenance` at the exact tag. Tags come only from `package.json`, never a Gitlink.

    Parameters:
        root (Path): repository root holding `package.json` and `package-lock.json`.

    Raises:
        ValueError: any override, lock entry, checksum or integrity disagrees.
        RuntimeError: provenance verification or a download failed.
        FileNotFoundError: a non-legacy tag needs `gh`, which is unavailable.
    """
    pins = _root_override_pins(_read_json_object(root / "package.json"))
    packages = _read_json_object(root / "package-lock.json").get("packages")
    if not isinstance(packages, dict):
        raise ValueError(f"Lockfile '{root / 'package-lock.json'}' has no `packages` metadata")
    integrities = {name: _locked_integrity(packages, name, url) for name, (_tag, url) in pins.items()}
    checksums_by_tag: dict[str, dict[str, str]] = {}
    with tempfile.TemporaryDirectory(prefix="root-overrides-") as scratch:
        for name, (tag, url) in pins.items():
            if tag not in checksums_by_tag:
                checksums_by_tag[tag] = release_checksums(tag)
                missing = [u for u in release_package_urls(tag).values() if u not in checksums_by_tag[tag]]
                if missing and tag not in LEGACY_RELEASE_TAGS:
                    raise ValueError(f"Release '{tag}' does not publish checksums for {missing}")
            asset = Path(scratch) / name.removeprefix(ROOT_OVERRIDE_SCOPE)
            download_verified_asset(url, tag, checksums_by_tag[tag], asset)
            actual = _npm_integrity(asset)
            if actual != integrities[name]:
                raise ValueError(
                    f"Lockfile `integrity` mismatch for '{name}': '{actual}', expected '{integrities[name]}'"
                )
            LOGGER.info(f"Root override '{name}' verified at '{tag}'")


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


def fetch_release(tag: str, prefix: Path) -> Path:
    """Verify every consumed release asset, then install into a new private prefix, never the live one.

    New tags must publish all of `RELEASE_PACKAGES`. Legacy tags are verified for exactly the assets
    in `LEGACY_CHECKSUMS`. Only coding-agent and tui are installed; `pi-agent-core` and `pi-ai` are
    verified because pi-harness's root overrides consume them.

    Parameters:
        tag (str): released core tag.
        prefix (Path): empty installation prefix.

    Returns:
        Path: private pi executable.

    Raises:
        ValueError: invalid tag, nonempty prefix, or missing/mismatched recorded checksums.
        RuntimeError: provenance or npm installation failed.
        FileNotFoundError: npm is unavailable.
    """
    release_package_urls(tag)
    if prefix.exists() and any(prefix.iterdir()):
        raise ValueError(f"Release prefix must be empty: '{prefix}'")
    checksums = release_checksums(tag)
    urls = list(release_package_urls(tag).values())
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
        assets.append(download_verified_asset(url, tag, checksums, asset))
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
    """Fetch a supplied tag or Gitlink tag, or verify the root overrides before `npm ci`."""
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0] if __doc__ else None)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--tag")
    source.add_argument("--gitlink", type=Path)
    source.add_argument(
        "--verify-root-overrides",
        action="store_true",
        help="verify the root `package.json` core overrides against the lockfile and release",
    )
    parser.add_argument("--prefix", type=Path, help="empty install prefix (with --tag or --gitlink)")
    parser.add_argument(
        "--root", type=Path, default=REPO_ROOT.parent, help="repository root for --verify-root-overrides"
    )
    args = parser.parse_args()
    if args.verify_root_overrides:
        if args.prefix is not None:
            parser.error("`--prefix` does not apply to `--verify-root-overrides`")
        try:
            verify_root_overrides(args.root.resolve())
        except (ValueError, RuntimeError, OSError) as error:
            raise SystemExit(f"Root core override verification failed: {error}") from error
        return
    if args.prefix is None:
        parser.error("`--prefix` is required with `--tag` or `--gitlink`")
    tag = args.tag or gitlink_tag(args.gitlink.resolve())
    fetch_release(tag, args.prefix.resolve())


if __name__ == "__main__":
    main()
