"""Shared native npm fixtures: a two-package graph with lifecycle scripts that must never run.

Imported by `test_runtime_lock.py` and `test_install.py`, so neither test module imports the other.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import platform
import shutil
import tarfile
from pathlib import Path
from typing import TYPE_CHECKING, Any

from harness import install
from harness.runtime_lock import NpmGraph

if TYPE_CHECKING:
    import pytest

TOP = "issue169-top"
LEAF = "issue169-leaf"


def model_supported_platform(
    monkeypatch: pytest.MonkeyPatch, system: str = "Linux", machine: str = "x86_64"
) -> None:
    """Select a logical platform for synthetic transaction/graph fixtures, not native acceptance.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): test-scoped overrides of `platform.system`,
            `platform.machine` and `install.is_wsl`, global for the test's duration.
        system (str): modeled `platform.system()`; defaults to Linux.
        machine (str): modeled `platform.machine()`; defaults to x86_64.

    Returns:
        None: the modeled platform is active until the patch scope ends.
    """
    monkeypatch.setattr(platform, "system", lambda: system)
    monkeypatch.setattr(platform, "machine", lambda: machine)
    monkeypatch.setattr(install, "is_wsl", lambda: False)


def package_bytes(name: str, payload: str = "original") -> bytes:
    """Create harmless fixture lifecycle code that must never run during staging.

    Parameters:
        name (str): synthetic package identity.
        payload (str): package file contents used for substitution tests.

    Returns:
        bytes: complete native npm tarball fixture.

    Raises:
        tarfile.TarError: fixture tar creation fails.
    """
    manifest: dict[str, Any] = {
        "name": name,
        "version": "1.0.0",
        "scripts": {"postinstall": "node -e \"require('node:fs').writeFileSync('executed','bad')\""},
    }
    if name == TOP:
        manifest["dependencies"] = {LEAF: "1.0.0"}
        manifest["bin"] = {"fixture-top": "index.js"}
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for filename, contents in {"package.json": json.dumps(manifest), "index.js": payload}.items():
            info = tarfile.TarInfo(f"package/{filename}")
            data = contents.encode()
            info.size = len(data)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(data))
    return output.getvalue()


def integrity(contents: bytes) -> str:
    """Return standard npm SRI for fixture tarball bytes.

    Parameters:
        contents (bytes): complete fixture tarball.

    Returns:
        str: standard SHA-512 npm SRI.
    """
    return "sha512-" + base64.b64encode(hashlib.sha512(contents).digest()).decode()


def fixture_graph() -> tuple[NpmGraph, dict[str, bytes]]:
    """Freeze original top-level and transitive bytes independently of the fetch seam.

    Returns:
        tuple[NpmGraph, dict[str, bytes]]: authenticated fixture graph and original URL responses.

    Raises:
        ValueError: native graph fixture validation fails.
    """
    bodies = {name: package_bytes(name) for name in (TOP, LEAF)}
    manifest = {"name": "fixture", "version": "1.0.0", "private": True, "dependencies": {TOP: "1.0.0"}}
    entries: dict[str, Any] = {"": {"name": "fixture", "version": "1.0.0", "dependencies": {TOP: "1.0.0"}}}
    for name, contents in bodies.items():
        entries[f"node_modules/{name}"] = {
            "version": "1.0.0",
            "resolved": f"https://registry.npmjs.org/{name}/-/{name}-1.0.0.tgz",
            "integrity": integrity(contents),
            "hasInstallScript": True,
            **({"dependencies": {LEAF: "1.0.0"}, "bin": {"fixture-top": "index.js"}} if name == TOP else {}),
        }
    graph = NpmGraph(
        manifest=manifest,
        lock={"name": "fixture", "version": "1.0.0", "lockfileVersion": 3, "packages": entries},
    )
    return graph, {
        entry["resolved"]: bodies[key.removeprefix("node_modules/")] for key, entry in entries.items() if key
    }


def native_npm() -> str:
    """Require the installed native npm; no toolchain installation or fallback.

    Returns:
        str: absolute native npm executable path.

    Raises:
        AssertionError: native npm is unavailable.
    """
    npm = shutil.which("npm")
    assert npm is not None, "native npm is required for runtime-lock offline fixture tests"
    return str(Path(npm).absolute())
