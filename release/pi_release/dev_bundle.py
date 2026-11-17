"""Build a non-release bundle from an owned checkout and its core Gitlink.

References:
- https://github.com/nredd/pi-harness/issues/888
- https://docs.npmjs.com/cli/commands/npm-pack
"""

from __future__ import annotations

import argparse
import json
import logging
import shutil
import subprocess
import tarfile
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

LOGGER = logging.getLogger(__name__)
CORE_PACKAGES = ("coding-agent", "tui", "agent", "ai")
PRESET_FILTERS = {"extensions/expanded-footer.ts": "src/index.ts"}


class PackedPackage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tarball: str = Field(description="Tarball path relative to bundle root")
    extensions: list[str] = Field(description="Validated pi.extensions paths relative to package root")
    filter_mapping: dict[str, str] = Field(
        default_factory=dict, description="Legacy extension filter aliases"
    )


class Bundle(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: int = Field(default=1, description="Manifest format version")
    source_sha: str = Field(description="Harness checkout HEAD")
    core_sha: str = Field(description="Verified core Gitlink commit")
    packages: dict[str, PackedPackage] = Field(description="Owned and core package tarballs")
    core_bin: str = Field(description="Runnable core CLI relative to bundle root")


def run(cwd: Path, *args: str) -> str:
    """Run a checked argv command with an absolute executable.

    Parameters:
        cwd (Path): working directory.
        args (str): executable and arguments.
    Returns:
        str: combined command output.
    Raises:
        FileNotFoundError: required executable is unavailable.
        subprocess.CalledProcessError: command failed.
    """
    executable = shutil.which(args[0])
    if executable is None:
        raise FileNotFoundError(f"Required executable unavailable: '{args[0]}'")
    return subprocess.check_output([executable, *args[1:]], cwd=cwd, text=True, stderr=subprocess.STDOUT)


def relative_entry(entry: str) -> str:
    """Validate a package-relative resource path.

    Parameters:
        entry (str): resource path.
    Returns:
        str: normalized POSIX path.
    Raises:
        ValueError: unsafe or empty path.
    """
    path = PurePosixPath(entry)
    if not entry or path.is_absolute() or ".." in path.parts or str(path) == "." or "\\" in entry:
        raise ValueError(f"Unsafe package entry: '{entry}'")
    return str(path)


def pack_package(package: Path, output: Path) -> PackedPackage:
    """Pack and audit the shipped manifest, never a dry-run file list.

    Parameters:
        package (Path): package source directory.
        output (Path): existing output directory.
    Returns:
        PackedPackage: validated tarball metadata.
    Raises:
        ValueError: declared extension is missing, unsafe or malformed.
    """
    packed = json.loads(
        run(package, "npm", "pack", "--ignore-scripts", "--json", "--pack-destination", str(output))
    )
    tarball = relative_entry(packed[0]["filename"])
    with tarfile.open(output / tarball) as archive:
        member = archive.extractfile("package/package.json")
        if member is None:
            raise ValueError("Packed `package.json` is not a file")
        manifest = json.load(member)
        entries = manifest.get("pi", {}).get("extensions", [])
        if not isinstance(entries, list) or any(not isinstance(entry, str) for entry in entries):
            raise ValueError("Packed `pi.extensions` must be an array of strings")
        files = {item.name for item in archive.getmembers() if item.isfile()}
        extensions = [relative_entry(entry) for entry in entries]
        for entry in extensions:
            if f"package/{entry}" not in files and f"package/{entry}/index.ts" not in files:
                raise ValueError(f"Packed `pi.extensions` entry absent: '{entry}'")
    mapping = PRESET_FILTERS if manifest["name"] == "@nredd/pi-preset" else {}
    if any(entry not in extensions for entry in mapping.values()):
        raise ValueError("Preset filter mapping does not resolve to a packed extension")
    return PackedPackage(tarball=tarball, extensions=extensions, filter_mapping=mapping)


def build_core(core: Path, scratch: Path) -> None:
    """Restore released model data and build offline, matching `Fork release`.

    Parameters:
        core (Path): initialized core checkout.
        scratch (Path): temporary artifact directory.
    """
    run(core, "npm", "ci", "--ignore-scripts")
    version = json.loads((core / "packages/ai/package.json").read_text())["version"]
    data_dir = scratch / "model-data"
    data_dir.mkdir()
    packed = json.loads(
        run(
            core,
            "npm",
            "pack",
            f"@earendil-works/pi-ai@{version}",
            "--ignore-scripts",
            "--json",
            "--pack-destination",
            str(data_dir),
        )
    )
    with tarfile.open(data_dir / packed[0]["filename"]) as archive:
        archive.extractall(data_dir, filter="data")
    target = core / "packages/ai/src/providers/data"
    shutil.rmtree(target, ignore_errors=True)
    shutil.copytree(data_dir / "package/dist/providers/data", target)
    run(core, "npm", "run", "build:offline")


def build_bundle(root: Path, output: Path) -> Bundle:
    """Build atomically; a failure never leaves an apparently usable bundle.

    Parameters:
        root (Path): initialized harness checkout, dependencies installed.
        output (Path): new bundle directory, outside the checkout.
    Returns:
        Bundle: persisted consumer manifest.
    Raises:
        ValueError: checkout, Gitlink or output is invalid.
        FileExistsError: output already exists.
    """
    root, output = root.resolve(), output.resolve()
    if output.exists():
        raise FileExistsError(f"Bundle destination exists: '{output}'")
    if output.is_relative_to(root):
        raise ValueError("Bundle destination must be outside the source checkout")
    core = root / "forks/pi"
    gitlink = run(root, "git", "ls-tree", "HEAD", "forks/pi").split()
    if len(gitlink) != 4 or gitlink[0] != "160000":
        raise ValueError("Missing `forks/pi` Gitlink")
    core_sha = run(core, "git", "rev-parse", "HEAD").strip()
    if core_sha != gitlink[2] or run(core, "git", "status", "--porcelain").strip():
        raise ValueError("Core checkout must be clean and match the Gitlink")
    owned = sorted((root / "packages").glob("*/package.json"))
    manifests: list[tuple[Path, dict[str, Any]]] = [
        (path.parent, json.loads(path.read_text())) for path in owned
    ]
    manifests = [(path, data) for path, data in manifests if data["name"].startswith("@nredd/")]
    if not manifests:
        raise ValueError("No owned packages found")
    output.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix=".dev-bundle-", dir=output.parent) as scratch:
        staging = Path(scratch) / "bundle"
        staging.mkdir()
        run(root, "npm", "run", "build")
        build_core(core, Path(scratch))
        packages = {data["name"]: pack_package(path, staging) for path, data in manifests}
        core_deps: dict[str, str] = {}
        for name in CORE_PACKAGES:
            path = core / "packages" / name
            data = json.loads((path / "package.json").read_text())
            record = pack_package(path, staging)
            packages[data["name"]] = record
            core_deps[data["name"]] = f"file:../{record.tarball}"
        runtime = staging / "core"
        runtime.mkdir()
        (runtime / "package.json").write_text(
            json.dumps({"private": True, "dependencies": core_deps, "overrides": core_deps})
        )
        run(runtime, "npm", "install", "--ignore-scripts", "--no-audit", "--no-fund")
        cli = "core/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
        if not (staging / cli).is_file():
            raise ValueError("Installed core CLI is missing")
        bundle = Bundle(
            source_sha=run(root, "git", "rev-parse", "HEAD").strip(),
            core_sha=core_sha,
            packages=packages,
            core_bin=cli,
        )
        (staging / "manifest.json").write_text(bundle.model_dump_json(indent=2) + "\n")
        staging.rename(output)
    return bundle


def main(argv: list[str] | None = None) -> int:
    """Build a development bundle without changing settings or install state.

    Parameters:
        argv (list[str] | None): command-line arguments.
    Returns:
        int: zero on success, one on a build or validation failure.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    try:
        build_bundle(args.root, args.output)
    except (OSError, ValueError, subprocess.CalledProcessError, tarfile.TarError) as exc:
        LOGGER.error(f"Dev bundle failed: {exc}")
        return 1
    LOGGER.info(f"Dev bundle ready: '{args.output.resolve() / 'manifest.json'}'")
    return 0
