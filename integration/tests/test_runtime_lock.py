"""Authenticated runtime graph, native npm offline and byte-substitution regressions.

References:
- https://docs.npmjs.com/cli/v11/commands/npm-ci
- https://github.com/nredd/pi-harness/issues/169
"""

from __future__ import annotations

import base64
import copy
import hashlib
import io
import json
import shutil
import tarfile
from pathlib import Path
from typing import Any

import pytest

from harness import runtime_lock
from harness.runtime_lock import (
    DependencyGraph,
    NpmGraph,
    RuntimeLockError,
    RuntimeLocks,
    acquire,
    audit_install,
    install_graph,
    root_manifest,
)
from harness.stack import Stack

ROOT = Path(__file__).parents[2]
TOP = "issue169-top"
LEAF = "issue169-leaf"


def package_bytes(name: str, payload: str = "original") -> bytes:
    """Create harmless fixture lifecycle code that must never run during staging."""
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
    """Return standard npm SRI for fixture tarball bytes."""
    return "sha512-" + base64.b64encode(hashlib.sha512(contents).digest()).decode()


def fixture_graph() -> tuple[NpmGraph, dict[str, bytes]]:
    """Freeze original top-level and transitive bytes independently of the fetch seam."""
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
    """Require the installed native npm; no toolchain installation or fallback."""
    npm = shutil.which("npm")
    assert npm is not None, "native npm is required for runtime-lock offline fixture tests"
    return str(Path(npm).absolute())


def test_source_runtime_locks_match_the_selected_stack() -> None:
    """Every selected platform/root is explicit, strict and bound to canonical stack bytes."""
    stack = Stack.model_validate_json((ROOT / "integration/stacks/personal.json").read_bytes())
    runtime = RuntimeLocks.model_validate_json((ROOT / runtime_lock.SOURCE_LOCK).read_bytes())
    runtime.bind(stack)
    assert set(runtime.platforms) == {"darwin-arm64", "linux-x64"}
    for graphs in runtime.platforms.values():
        assert all(graph.manifest == root_manifest(stack, kind) for kind, graph in graphs.items())


@pytest.mark.parametrize("target", [TOP, LEAF])
def test_substituted_tarballs_fail_before_any_npm_or_package_execution(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, target: str
) -> None:
    """Same-name/version changed top-level and transitive bytes cannot adopt transport SRI."""
    graph, responses = fixture_graph()
    url = graph.lock["packages"][f"node_modules/{target}"]["resolved"]
    responses[url] = package_bytes(target, "substituted")
    monkeypatch.setattr(runtime_lock, "fetch_bytes", responses.__getitem__)
    calls: list[str] = []
    monkeypatch.setattr(runtime_lock, "run_npm", lambda *args: calls.append("npm"))
    with pytest.raises(RuntimeLockError, match="authenticated npm SRI"):
        acquire(graph, tmp_path / "archives")
    assert calls == []
    assert not list(tmp_path.rglob("executed"))


def test_metadata_substitution_cannot_reselect_the_frozen_graph(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No live registry metadata is consulted when replaying authenticated native locks."""
    graph, responses = fixture_graph()
    requests: list[str] = []

    def fetch(url: str) -> bytes:
        """Refuse any metadata lookup, including same-version re-resolution."""
        requests.append(url)
        return responses[url]

    monkeypatch.setattr(runtime_lock, "fetch_bytes", fetch)
    archives = acquire(graph, tmp_path / "archives")
    root = tmp_path / "root"
    install_graph(graph, root, tmp_path / "scratch", native_npm(), archives)
    assert set(requests) == set(responses)
    assert all(url.endswith(".tgz") for url in requests)
    assert (root / "node_modules" / TOP / "index.js").read_text() == "original"
    assert not list(tmp_path.rglob("executed"))
    audit_install(graph, root, archives)


def test_native_offline_cache_miss_fails_closed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A missing verified cache object never permits online npm re-resolution."""
    graph, responses = fixture_graph()
    monkeypatch.setattr(runtime_lock, "fetch_bytes", responses.__getitem__)
    archives = acquire(graph, tmp_path / "archives")
    run = runtime_lock.run_npm
    commands: list[list[str]] = []

    def omit_cache(npm: str, args: list[str], root: Path, env: dict[str, str]) -> None:
        """Inject a lost cache write without changing native npm ci's offline behavior."""
        commands.append(args)
        if args[0] != "cache":
            run(npm, args, root, env)

    monkeypatch.setattr(runtime_lock, "run_npm", omit_cache)
    with pytest.raises(RuntimeLockError, match="npm operation failed"):
        install_graph(graph, tmp_path / "root", tmp_path / "scratch", native_npm(), archives)
    assert any(args[0] == "ci" and "--offline" in args for args in commands)
    assert not list(tmp_path.rglob("executed"))


def test_changed_local_archive_is_rechecked_before_cache_import(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A previously downloaded archive cannot change unnoticed before native npm consumes it."""
    graph, responses = fixture_graph()
    monkeypatch.setattr(runtime_lock, "fetch_bytes", responses.__getitem__)
    archives = acquire(graph, tmp_path / "archives")
    archives[f"node_modules/{TOP}"].write_bytes(package_bytes(TOP, "changed"))
    with pytest.raises(RuntimeLockError, match="authenticated npm SRI"):
        install_graph(graph, tmp_path / "root", tmp_path / "scratch", native_npm(), archives)


@pytest.mark.parametrize("mutation", ["changed", "extra", "symlink", "bin-name", "bin-target", "bin-missing"])
def test_installed_bytes_are_audited_not_just_lock_metadata(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mutation: str
) -> None:
    """Installed byte corruption, unexpected code and linked files fail with unchanged locks."""
    graph, responses = fixture_graph()
    monkeypatch.setattr(runtime_lock, "fetch_bytes", responses.__getitem__)
    archives = acquire(graph, tmp_path / "archives")
    root = tmp_path / "root"
    install_graph(graph, root, tmp_path / "scratch", native_npm(), archives)
    target = root / "node_modules" / TOP / "index.js"
    if mutation == "changed":
        target.write_text("changed")
    elif mutation == "extra":
        target.with_name("unexpected.js").write_text("extra")
    elif mutation == "symlink":
        target.unlink()
        target.symlink_to(root / "package.json")
    elif mutation == "bin-name":
        (root / "node_modules" / ".bin" / "injected").symlink_to(target)
    else:
        link = root / "node_modules" / ".bin" / "fixture-top"
        link.unlink()
        if mutation != "bin-missing":
            link.symlink_to(root / "node_modules" / LEAF / "index.js")
    with pytest.raises(RuntimeLockError, match=r"runtime (bytes|entry|file|bin)"):
        audit_install(graph, root, archives)


@pytest.mark.parametrize("mutation", ["link", "git", "file", "integrity", "bundle", "root"])
def test_unsupported_or_unbound_lock_entries_are_refused(mutation: str) -> None:
    """Native lock source escape hatches never bypass required independent integrity."""
    graph, _ = fixture_graph()
    document = copy.deepcopy(graph.model_dump())
    entry = document["lock"]["packages"][f"node_modules/{TOP}"]
    if mutation == "link":
        entry["link"] = True
    elif mutation in {"git", "file"}:
        entry["resolved"] = "git+https://github.com/example/untrusted" if mutation == "git" else "file:/tmp/x"
    elif mutation == "integrity":
        del entry["integrity"]
    elif mutation == "bundle":
        entry["inBundle"] = True
    else:
        document["lock"]["packages"][""]["dependencies"] = {}
    with pytest.raises(ValueError, match=r"runtime|Runtime|Bundled"):
        NpmGraph.model_validate(document)


def test_supplemental_asset_does_not_accept_extra_fields_or_other_versions() -> None:
    """Evidence-only snapshots are unchanged; the new mandatory graph is separately strict."""
    runtime = json.loads((ROOT / runtime_lock.SOURCE_LOCK).read_bytes())
    valid = {"schema_version": 1, "source_sha": "a" * 40, "runtime": runtime}
    assert DependencyGraph.model_validate(valid)
    for invalid in (valid | {"extra": True}, valid | {"schema_version": 2}, {"schema_version": 1}):
        with pytest.raises(ValueError, match=r"Extra inputs|Input should be|Field required"):
            DependencyGraph.model_validate(invalid)
