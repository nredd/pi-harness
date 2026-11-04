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
import re
import runpy
import shutil
import sys
import tarfile
from pathlib import Path
from typing import Any

import pytest

from harness import install, runtime_lock
from harness.promotion import load_promoted_snapshot
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
from harness.stack import Stack, source_string

ROOT = Path(__file__).parents[2]
TOP = "issue169-top"
LEAF = "issue169-leaf"


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


@pytest.mark.parametrize("mode", ["install", "plan", "noop"])
def test_verified_archives_survive_orchestration_until_consumed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mode: str
) -> None:
    """Keep actual verified archives alive across verification, planning, staging and health checks.

    Parameters:
        tmp_path (Path): private orchestration and native npm roots.
        monkeypatch (pytest.MonkeyPatch): fixture transport and transaction seams.
        mode (str): fresh native replay, plan-only consumption or no-op installed-byte audit.

    Returns:
        None: archives exist during real native consumption and disappear after orchestration returns.

    Raises:
        AssertionError: archive lifetime or the selected orchestration path is wrong.
    """
    graph, responses = fixture_graph()
    fixture = ROOT / "integration/tests/fixtures/stack-snapshot-24889f7.json"
    snapshot = load_promoted_snapshot(fixture.read_bytes(), "24889f7896be7157bf9077a41465a3b29620879f")
    layout = install.Layout(tmp_path / "state", tmp_path / "agent", tmp_path / "bin")
    paths: dict[str, Path] = {}
    prefix = tmp_path / "native-prefix"
    consumed: list[str] = []
    monkeypatch.setattr(runtime_lock, "fetch_bytes", responses.__getitem__)
    monkeypatch.setattr(install, "verify_snapshot", lambda *args, **kwargs: snapshot)

    def verify(snapshot: Any, node: str, workdir: Path, **kwargs: Any) -> install.Verified:
        """Retain real fixture archives in the installer's actual temporary verification directory.

        Parameters:
            snapshot (Any): synthetic authenticated snapshot fixture.
            node (str): unused prerequisite executable.
            workdir (Path): real orchestration-owned temporary directory.
            **kwargs (Any): selected verifier options.

        Returns:
            install.Verified: real verified tarball paths, not mocked archive storage.
        """
        paths.update(acquire(graph, workdir / "archives"))
        return install.Verified(
            snapshot,
            [source_string(package) for package in snapshot.stack.sources],
            {},
            archives={"agent": paths},
        )

    def plan(*args: Any, **kwargs: Any) -> install.Plan:
        """Consume real archives while planning, including the plan-only path.

        Parameters:
            *args (Any): production planner arguments.
            **kwargs (Any): production planner options.

        Returns:
            install.Plan: a controlled fresh-install or no-op transaction plan.

        Raises:
            AssertionError: orchestration deleted authenticated archives before planning.
        """
        assert all(path.is_file() for path in paths.values())
        consumed.append("plan")
        if mode == "noop":
            install_graph(graph, prefix, tmp_path / "native-cache", native_npm(), paths)
        return install.Plan(creates=[] if mode == "noop" else ["native fixture"])

    def apply(*args: Any, **kwargs: Any) -> tuple[Path, str]:
        """Run the real offline native staging/byte-audit boundary after verification returns.

        Parameters:
            *args (Any): production transaction arguments.
            **kwargs (Any): selected prerequisite options.

        Returns:
            tuple[Path, str]: controlled transaction receipt after actual native graph replay.
        """
        install_graph(graph, prefix, tmp_path / "native-cache", native_npm(), paths)
        consumed.append("stage")
        return tmp_path / "no-backup", "fixture"

    def checked(*args: Any) -> str:
        """Audit actual installed fixture bytes while authenticated archives remain alive.

        Parameters:
            *args (Any): installed executable health-check arguments.

        Returns:
            str: controlled version after the real archive byte audit.
        """
        audit_install(graph, prefix, paths)
        consumed.append("health")
        return "fixture"

    monkeypatch.setattr(install, "verify_release", verify)
    monkeypatch.setattr(install, "plan_install", plan)
    monkeypatch.setattr(install, "apply", apply)
    monkeypatch.setattr(install, "checked_version", checked)
    opts = install.Options(snapshot.source_sha, True, mode == "plan", None)
    assert (
        install.run_preflighted(
            opts, {}, None, layout, {"node": "/fixture/node"}, missing_before_lock=frozenset()
        )
        == install.ExitCode.OK
    )
    assert consumed == {"install": ["plan", "stage"], "plan": ["plan"], "noop": ["plan", "health"]}[mode]
    assert paths
    assert all(not path.exists() for path in paths.values())


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
        """Refuse any metadata lookup, including same-version re-resolution.

        Parameters:
            url (str): selected authenticated tarball URL.

        Returns:
            bytes: original fixture bytes.

        Raises:
            KeyError: a metadata or other unselected URL was requested.
        """
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
        """Inject a lost cache write without changing native npm ci's offline behavior.

        Parameters:
            npm (str): selected native executable.
            args (list[str]): native npm operation.
            root (Path): private install prefix.
            env (dict[str, str]): isolated child environment.

        Returns:
            None: cache writes are omitted; other commands execute normally.

        Raises:
            RuntimeLockError: native offline replay cannot find the omitted objects.
        """
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


STACK = ROOT / "integration/stacks/personal.json"


def selected_stack() -> Stack:
    """Load the authoritative selected stack the source runtime locks are bound to.

    Returns:
        Stack: validated personal stack.
    """
    return Stack.model_validate_json(STACK.read_bytes())


def source_locks() -> dict[str, Any]:
    """Return an editable copy of the reviewed source runtime locks.

    Returns:
        dict[str, Any]: raw source lock document.
    """
    return json.loads((ROOT / runtime_lock.SOURCE_LOCK).read_bytes())


def tarball(path: Path, members: list[tuple[tarfile.TarInfo, bytes | None]]) -> Path:
    """Write an uncompressed tarball with exact member headers, including hostile ones.

    Parameters:
        path (Path): destination archive.
        members (list[tuple[tarfile.TarInfo, bytes | None]]): headers and optional regular-file data.

    Returns:
        Path: the written archive.
    """
    with tarfile.open(path, mode="w") as archive:
        for info, data in members:
            if data is not None:
                info.size = len(data)
            archive.addfile(info, io.BytesIO(data) if data is not None else None)
    return path


def member(name: str, kind: bytes = tarfile.REGTYPE, linkname: str = "") -> tarfile.TarInfo:
    """Build one tar header of a given kind.

    Parameters:
        name (str): member path.
        kind (bytes): tar member type.
        linkname (str): symbolic link target.

    Returns:
        tarfile.TarInfo: header.
    """
    info = tarfile.TarInfo(name)
    info.type = kind
    info.linkname = linkname
    info.mode = 0o755 if kind == tarfile.DIRTYPE else 0o644
    return info


def fake_package_lock(calls: list[tuple[list[str], Path, dict[str, str]]]) -> Any:
    """Build an injected npm runner that writes a native v3 lock for the written root manifest.

    Parameters:
        calls (list[tuple[list[str], Path, dict[str, str]]]): recorded npm invocations.

    Returns:
        Any: `run_npm` replacement; no npm executable or network is used.
    """

    def run(npm: str, args: list[str], root: Path, env: dict[str, str]) -> None:
        """Resolve each root dependency to a pinned registry or core release entry.

        Parameters:
            npm (str): selected executable, unused.
            args (list[str]): native npm arguments.
            root (Path): generation root holding `package.json`.
            env (dict[str, str]): isolated npm environment.

        Returns:
            None: `package-lock.json` was written.
        """
        calls.append((args, root, env))
        dependencies = json.loads((root / "package.json").read_bytes())["dependencies"]
        entries: dict[str, Any] = {"": {"name": root.name, "version": "1.0.0", "dependencies": dependencies}}
        for name, spec in dependencies.items():
            core = spec.startswith("https:")
            entries[f"node_modules/{name}"] = {
                "version": "1.3.0" if core else spec,
                "resolved": spec if core else f"https://registry.npmjs.org/{name}/-/x-{spec}.tgz",
                "integrity": integrity(name.encode()),
            }
        lock = {"name": root.name, "version": "1.0.0", "lockfileVersion": 3, "packages": entries}
        (root / "package-lock.json").write_text(json.dumps(lock))

    return run


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        ("lockfile-version", "lockfileVersion` 3"),
        ("no-packages", "requires `packages` and its root entry"),
        ("manifest-field", "Runtime root manifest contains unsupported fields"),
        ("missing-root", f"Runtime lock is missing root '{TOP}'"),
        ("no-version", f"Runtime lock entry 'node_modules/{TOP}' has no exact version"),
        ("host", f"Runtime lock entry 'node_modules/{TOP}' has an unsupported tarball host"),
        ("query", f"Runtime lock entry 'node_modules/{TOP}' has URL query/fragment data"),
    ],
)
def test_graph_shape_refusals_name_the_violation(mutation: str, message: str) -> None:
    """Each native graph shape refusal fails with its own diagnostic."""
    graph, _ = fixture_graph()
    document = copy.deepcopy(graph.model_dump())
    lock, entry = document["lock"], document["lock"]["packages"][f"node_modules/{TOP}"]
    if mutation == "lockfile-version":
        lock["lockfileVersion"] = 2
    elif mutation == "no-packages":
        lock["packages"] = []
    elif mutation == "manifest-field":
        document["manifest"]["scripts"] = {"postinstall": "true"}
    elif mutation == "missing-root":
        del lock["packages"][f"node_modules/{TOP}"]
    elif mutation == "no-version":
        entry["version"] = ""
    elif mutation == "host":
        entry["resolved"] = "https://example.com/top.tgz"
    else:
        entry["resolved"] += "?token=x"
    with pytest.raises(ValueError, match=re.escape(message)):
        NpmGraph.model_validate(document)


def test_bundled_entry_inherits_its_authenticated_parent() -> None:
    """A bundled child needs no URL/SRI of its own when its parent is in the graph."""
    graph, _ = fixture_graph()
    document = copy.deepcopy(graph.model_dump())
    document["lock"]["packages"][f"node_modules/{TOP}/node_modules/bundled"] = {
        "version": "1.0.0",
        "inBundle": True,
    }
    assert NpmGraph.model_validate(document).lock["packages"][f"node_modules/{TOP}/node_modules/bundled"]


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        ("platform", "Runtime locks must cover exactly darwin-arm64 and linux-x64"),
        ("root", "Each runtime platform must contain exactly core and agent graphs"),
    ],
)
def test_runtime_locks_require_both_platforms_and_roots(mutation: str, message: str) -> None:
    """A missing platform or installation root is refused at parse time."""
    document = source_locks()
    if mutation == "platform":
        del document["platforms"]["linux-x64"]
    else:
        del document["platforms"]["linux-x64"]["agent"]
    with pytest.raises(ValueError, match=re.escape(message)):
        RuntimeLocks.model_validate(document)


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        ("manifest", "Runtime 'core' root differs from the selected stack"),
        ("identity", "Runtime root lock identity differs for 'pi-web-access'"),
    ],
)
def test_bind_refuses_roots_that_differ_from_the_stack(mutation: str, message: str) -> None:
    """A valid graph whose root manifest or root lock entry drifted from the stack cannot bind."""
    document = source_locks()
    graphs = document["platforms"]["darwin-arm64"]
    if mutation == "manifest":
        graphs["core"]["manifest"]["version"] = "2.0.0"
    else:
        graphs["agent"]["lock"]["packages"]["node_modules/pi-web-access"]["version"] = "9.9.9"
    runtime = RuntimeLocks.model_validate(document)
    with pytest.raises(RuntimeLockError, match=re.escape(message)):
        runtime.bind(selected_stack())


def test_root_manifest_refuses_local_sources_and_unknown_roots() -> None:
    """Only exact npm stack sources and the two known roots derive an install manifest."""
    local = Stack.model_validate(
        json.loads(STACK.read_bytes()) | {"sources": ["./local-extension"], "disabled_extensions": {}}
    )
    with pytest.raises(RuntimeLockError, match="support exact npm stack sources only"):
        root_manifest(local, "agent")
    with pytest.raises(RuntimeLockError, match="Unknown runtime root 'tools'"):
        root_manifest(selected_stack(), "tools")


def test_run_npm_requires_the_absolute_selected_executable(tmp_path: Path) -> None:
    """A PATH-relative npm name is refused before any process starts."""
    with pytest.raises(RuntimeLockError, match="absolute preflight-selected executable"):
        runtime_lock.run_npm("npm", ["--version"], tmp_path, {})


def test_core_tarballs_require_the_separately_authenticated_release_digest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Core release bytes need the stack's SHA-256 evidence in addition to the lock SRI."""
    url = "https://github.com/nredd/pi/releases/download/v1.3.0-nredd.8/core-1.3.0.tgz"
    contents = package_bytes("core")
    graph = NpmGraph(
        manifest={"name": "core", "version": "1.0.0", "dependencies": {"core": url}},
        lock={
            "lockfileVersion": 3,
            "packages": {
                "": {"dependencies": {"core": url}},
                "node_modules/core": {"version": "1.3.0", "resolved": url, "integrity": integrity(contents)},
            },
        },
    )
    monkeypatch.setattr(runtime_lock, "fetch_bytes", {url: contents}.__getitem__)
    for checksums in (None, {url: "0" * 64}):
        with pytest.raises(RuntimeLockError, match="differs from authenticated core release"):
            acquire(graph, tmp_path / "refused", checksums)
    assert not list((tmp_path / "refused").iterdir())
    archives = acquire(graph, tmp_path / "archives", {url: hashlib.sha256(contents).hexdigest()})
    assert archives["node_modules/core"].read_bytes() == contents


@pytest.mark.parametrize(
    ("members", "message"),
    [
        ([(member("package/../escape"), b"x")], "unsafe member path"),
        ([(member("package/a"), b"x"), (member("package/a"), b"y")], "ambiguous extraction paths"),
        ([(member("package/a"), b"x"), (member("other/b"), b"y")], "ambiguous extraction paths"),
        ([(member("package/fifo", tarfile.FIFOTYPE), None)], "unsupported member kind"),
        ([(member("package/link", tarfile.SYMTYPE, "../../etc/passwd"), None)], "escaping symbolic link"),
        ([(member("package/link", tarfile.SYMTYPE, "/etc/passwd"), None)], "escaping symbolic link"),
    ],
)
def test_validate_archive_refuses_unsafe_extraction_envelopes(
    tmp_path: Path, members: list[tuple[tarfile.TarInfo, bytes | None]], message: str
) -> None:
    """Hostile member names, kinds and links are refused before native npm extraction."""
    with pytest.raises(RuntimeLockError, match=message):
        runtime_lock.validate_archive(tarball(tmp_path / "hostile.tar", members))


def test_validate_archive_bounds_expansion_and_requires_a_tarball(tmp_path: Path) -> None:
    """A declared oversize member and non-archive bytes are both refused."""
    huge = member("package/huge")
    huge.size = 600 * 1024**2
    (tmp_path / "huge.tar").write_bytes(huge.tobuf(format=tarfile.PAX_FORMAT))
    with pytest.raises(RuntimeLockError, match="exceeds extraction limits"):
        runtime_lock.validate_archive(tmp_path / "huge.tar")
    (tmp_path / "text.tgz").write_bytes(b"not an archive")
    with pytest.raises(RuntimeLockError, match="not a readable npm archive"):
        runtime_lock.validate_archive(tmp_path / "text.tgz")
    internal: list[tuple[tarfile.TarInfo, bytes | None]] = [
        (member("package/index.js"), b"x"),
        (member("package/alias", tarfile.SYMTYPE, "index.js"), None),
    ]
    runtime_lock.validate_archive(tarball(tmp_path / "internal.tar", internal))


def installed_package(tmp_path: Path) -> tuple[Path, Path]:
    """Create an archive with a directory, file and link, plus its matching installed tree.

    Parameters:
        tmp_path (Path): private fixture root.

    Returns:
        tuple[Path, Path]: archive and installed package directory.
    """
    archive = tarball(
        tmp_path / "package.tar",
        [
            (member("package/lib", tarfile.DIRTYPE), None),
            (member("package/lib/index.js"), b"original"),
            (member("package/alias.js", tarfile.SYMTYPE, "lib/index.js"), None),
        ],
    )
    destination = tmp_path / "installed"
    (destination / "lib").mkdir(parents=True)
    (destination / "lib/index.js").write_bytes(b"original")
    (destination / "alias.js").symlink_to("lib/index.js")
    return archive, destination


def test_audit_archive_accepts_matching_directories_files_and_links(tmp_path: Path) -> None:
    """Directories are skipped; files and links join the expected installed inventory."""
    archive, destination = installed_package(tmp_path)
    expected: set[Path] = set()
    runtime_lock.audit_archive(archive, destination, expected)
    assert expected == {destination / "lib/index.js", destination / "alias.js"}


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        ("path", "unsupported member path"),
        ("prefix", "multiple extraction prefixes"),
        ("ancestor", "linked ancestor"),
        ("link", "Installed runtime link differs: 'alias.js'"),
        ("kind", "unsupported entry kind"),
    ],
)
def test_audit_archive_refuses_installed_tree_drift(tmp_path: Path, mutation: str, message: str) -> None:
    """Hostile archive layouts and installed link drift fail the installed-byte audit."""
    archive, destination = installed_package(tmp_path)
    if mutation == "path":
        archive = tarball(tmp_path / "path.tar", [(member("package/../escape"), b"x")])
    elif mutation == "prefix":
        archive = tarball(
            tmp_path / "prefix.tar",
            [(member("package/lib", tarfile.DIRTYPE), None), (member("other/a"), b"x")],
        )
    elif mutation == "ancestor":
        real = destination.rename(tmp_path / "real")
        destination.symlink_to(real)
    elif mutation == "link":
        (destination / "alias.js").unlink()
        (destination / "alias.js").symlink_to("lib")
    else:
        archive = tarball(tmp_path / "fifo.tar", [(member("package/fifo", tarfile.FIFOTYPE), None)])
    with pytest.raises(RuntimeLockError, match=re.escape(message)):
        runtime_lock.audit_archive(archive, destination, set())


@pytest.mark.parametrize(
    ("bins", "expected"),
    [
        ("cli.js", {TOP: "cli.js"}),
        (["cli.js"], "unsupported bin declaration"),
        ({"fixture-top": 1}, "bin mapping must contain strings"),
    ],
)
def test_native_bin_targets_follow_the_installed_manifest(tmp_path: Path, bins: Any, expected: Any) -> None:
    """A string bin maps to the package name; lists and non-string targets are refused."""
    graph, _ = fixture_graph()
    package = tmp_path / "node_modules" / TOP
    package.mkdir(parents=True)
    (package / "package.json").write_text(json.dumps({"name": TOP, "bin": bins}))
    if isinstance(expected, str):
        with pytest.raises(RuntimeLockError, match=expected):
            runtime_lock.native_bin_targets(graph, tmp_path)
        return
    assert runtime_lock.native_bin_targets(graph, tmp_path) == {
        tmp_path / "node_modules/.bin" / name: {(package / target).resolve()}
        for name, target in expected.items()
    }


def test_audit_install_requires_the_complete_archive_inventory(tmp_path: Path) -> None:
    """An archive map that omits a graph package is refused before any byte comparison."""
    graph, _ = fixture_graph()
    with pytest.raises(RuntimeLockError, match="archive inventory differs from the complete lock graph"):
        audit_install(graph, tmp_path, {})


def test_audit_install_allows_an_absent_optional_package(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """npm may skip an optional package for this platform; its absence is not drift."""
    graph, responses = fixture_graph()
    monkeypatch.setattr(runtime_lock, "fetch_bytes", responses.__getitem__)
    archives = acquire(graph, tmp_path / "archives")
    root = tmp_path / "root"
    install_graph(graph, root, tmp_path / "scratch", native_npm(), archives)
    shutil.rmtree(root / "node_modules" / LEAF)
    with pytest.raises(RuntimeLockError, match="Installed runtime file is absent"):
        audit_install(graph, root, archives)
    document = copy.deepcopy(graph.model_dump())
    document["lock"]["packages"][f"node_modules/{LEAF}"]["optional"] = True
    audit_install(NpmGraph.model_validate(document), root, archives)


def test_install_graph_requires_an_empty_root(tmp_path: Path) -> None:
    """A populated staging prefix is refused before any archive or npm work."""
    graph, _ = fixture_graph()
    (tmp_path / "root").mkdir()
    (tmp_path / "root" / "stale").write_text("stale")
    with pytest.raises(RuntimeLockError, match="install root must be empty"):
        install_graph(graph, tmp_path / "root", tmp_path / "scratch", "/fixture/npm", {})


def test_selected_graphs_refuses_an_unsupported_platform(monkeypatch: pytest.MonkeyPatch) -> None:
    """Only darwin-arm64 and linux-x64 select a graph."""
    runtime = RuntimeLocks.model_validate(source_locks())
    monkeypatch.setattr(runtime_lock.platform, "system", lambda: "Linux")
    monkeypatch.setattr(runtime_lock.platform, "machine", lambda: "riscv64")
    with pytest.raises(RuntimeLockError, match="No authenticated runtime graph for this platform"):
        runtime_lock.selected_graphs(runtime)
    monkeypatch.setattr(runtime_lock.platform, "machine", lambda: "x86_64")
    assert runtime_lock.selected_graphs(runtime) is runtime.platforms["linux-x64"]


def test_generate_writes_bound_locks_for_both_platforms(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Generation resolves each root per target OS/CPU in private npm config and binds the stack."""
    calls: list[tuple[list[str], Path, dict[str, str]]] = []
    monkeypatch.setattr(runtime_lock, "run_npm", fake_package_lock(calls))
    stack = selected_stack()
    runtime = runtime_lock.generate(stack, "/fixture/npm", tmp_path)
    runtime.bind(stack)
    assert [(root.relative_to(tmp_path).as_posix(), args[-2:]) for args, root, _ in calls] == [
        ("darwin-arm64/core", ["--os=darwin", "--cpu=arm64"]),
        ("darwin-arm64/agent", ["--os=darwin", "--cpu=arm64"]),
        ("linux-x64/core", ["--os=linux", "--cpu=x64"]),
        ("linux-x64/agent", ["--os=linux", "--cpu=x64"]),
    ]
    assert all("--package-lock-only" in args and "--ignore-scripts" in args for args, _, _ in calls)
    assert {env["npm_config_userconfig"] for _, _, env in calls} == {str(tmp_path / "npm" / "user.npmrc")}


def replay_seams(
    monkeypatch: pytest.MonkeyPatch, script: str | None
) -> tuple[list[tuple[str, dict[str, str] | None]], list[str]]:
    """Inject acquisition and native replay; optionally install a fixture `pi` executable.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): module seams.
        script (str | None): `pi` shell body written into the core prefix, or None for none.

    Returns:
        tuple[list[tuple[str, dict[str, str] | None]], list[str]]: acquisitions and installed roots.
    """
    acquired: list[tuple[str, dict[str, str] | None]] = []
    installed: list[str] = []

    def acquire_fixture(
        graph: NpmGraph, scratch: Path, checksums: dict[str, str] | None = None
    ) -> dict[str, Path]:
        """Record acquisition without any network fetch.

        Parameters:
            graph (NpmGraph): selected graph.
            scratch (Path): archive directory.
            checksums (dict[str, str] | None): core release digests.

        Returns:
            dict[str, Path]: a marker archive inventory.
        """
        acquired.append((scratch.parent.name, checksums))
        return {"marker": scratch / graph.manifest["name"]}

    def install_fixture(
        graph: NpmGraph, root: Path, scratch: Path, npm: str, archives: dict[str, Path]
    ) -> None:
        """Record replay and, for core, write the fixture `pi` executable.

        Parameters:
            graph (NpmGraph): selected graph.
            root (Path): staged prefix.
            scratch (Path): private npm directory.
            npm (str): selected executable.
            archives (dict[str, Path]): acquired inventory.

        Returns:
            None: the fixture prefix exists.
        """
        assert archives == {"marker": root.parent / "archives" / graph.manifest["name"]}
        installed.append(f"{root.parent.name}:{npm}")
        if root.parent.name == "core" and script is not None:
            executable = root / "node_modules/.bin/pi"
            executable.parent.mkdir(parents=True)
            executable.write_text(f"#!/bin/sh\n{script}\n")
            executable.chmod(0o755)

    monkeypatch.setattr(runtime_lock, "acquire", acquire_fixture)
    monkeypatch.setattr(runtime_lock, "install_graph", install_fixture)
    return acquired, installed


def test_replay_source_audits_both_roots_then_smokes_core(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Both graphs are acquired with core digests and installed before the isolated version check."""
    stack = selected_stack()
    acquired, installed = replay_seams(monkeypatch, 'echo "fixture $PI_TELEMETRY $PI_SKIP_VERSION_CHECK"')
    caplog.set_level("INFO", logger=runtime_lock.LOGGER.name)
    runtime_lock.replay_source(RuntimeLocks.model_validate(source_locks()), stack, tmp_path, "/fixture/npm")
    urls = runtime_lock.release_package_urls(stack.core.tag)
    digests = {
        urls[name]: stack.core.integrity[urls[name].rsplit("/", 1)[-1]]
        for name in ("pi-coding-agent", "pi-tui")
    }
    assert acquired == [("core", digests), ("agent", digests)]
    assert installed == ["core:/fixture/npm", "agent:/fixture/npm"]
    assert "byte audits passed: fixture 0 1" in caplog.text


@pytest.mark.parametrize(("script", "message"), [(None, "No such file"), ("exit 3", "exit status 3")])
def test_replay_source_refuses_a_runtime_that_cannot_start(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, script: str | None, message: str
) -> None:
    """A missing or failing audited executable is a replay failure, not a pass."""
    replay_seams(monkeypatch, script)
    with pytest.raises(RuntimeLockError, match=f"Verified source runtime could not start: .*{message}"):
        runtime_lock.replay_source(
            RuntimeLocks.model_validate(source_locks()), selected_stack(), tmp_path, "/fixture/npm"
        )


def test_replay_source_binds_before_any_acquisition(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Locks for a different stack are refused before any tarball is fetched."""
    acquired, installed = replay_seams(monkeypatch, None)
    other = Stack.model_validate(json.loads(STACK.read_bytes()) | {"name": "other"})
    with pytest.raises(RuntimeLockError, match="do not match the selected canonical stack"):
        runtime_lock.replay_source(
            RuntimeLocks.model_validate(source_locks()), other, tmp_path, "/fixture/npm"
        )
    assert (acquired, installed) == ([], [])


def test_main_generates_reviewed_locks(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`--output` writes source locks bound to the given stack using the selected absolute npm."""
    calls: list[tuple[list[str], Path, dict[str, str]]] = []
    monkeypatch.setattr(runtime_lock, "run_npm", fake_package_lock(calls))
    monkeypatch.setattr(runtime_lock.shutil, "which", lambda name: "/fixture/npm" if name == "npm" else None)
    output = tmp_path / "runtime-locks.json"
    monkeypatch.setattr(sys, "argv", ["runtime_lock", "--stack", str(STACK), "--output", str(output)])
    runtime_lock.main()
    RuntimeLocks.model_validate_json(output.read_bytes()).bind(selected_stack())
    assert output.read_text().endswith("}\n")
    assert len(calls) == 4
    assert all(not root.exists() for _, root, _ in calls)


def test_main_replays_an_existing_source_lock(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`--replay` hands the parsed lock, stack and a private scratch directory to the replay."""
    seen: list[tuple[RuntimeLocks, Stack, Path, str]] = []

    def replay(runtime: RuntimeLocks, stack: Stack, scratch: Path, npm: str) -> None:
        """Record the replay inputs while the scratch directory exists.

        Parameters:
            runtime (RuntimeLocks): parsed source lock.
            stack (Stack): parsed stack.
            scratch (Path): private replay directory.
            npm (str): selected executable.

        Returns:
            None: replay recorded.
        """
        assert scratch.is_dir()
        assert scratch.name.startswith("runtime-lock-")
        seen.append((runtime, stack, scratch, npm))

    monkeypatch.setattr(runtime_lock, "replay_source", replay)
    monkeypatch.setattr(runtime_lock.shutil, "which", lambda name: "/fixture/npm")
    lock = ROOT / runtime_lock.SOURCE_LOCK
    monkeypatch.setattr(sys, "argv", ["runtime_lock", "--stack", str(STACK), "--replay", str(lock)])
    runtime_lock.main()
    [(runtime, stack, scratch, npm)] = seen
    assert runtime == RuntimeLocks.model_validate(source_locks())
    assert stack == selected_stack()
    assert npm == "/fixture/npm"
    assert not scratch.exists()


def test_main_requires_npm(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    """Without npm on PATH the CLI exits with a usage error before reading inputs."""
    monkeypatch.setattr(runtime_lock.shutil, "which", lambda name: None)
    monkeypatch.setattr(
        sys, "argv", ["runtime_lock", "--stack", "/missing.json", "--output", "/missing-out.json"]
    )
    with pytest.raises(SystemExit) as exit_info:
        runtime_lock.main()
    assert exit_info.value.code == 2
    assert "npm is required" in capsys.readouterr().err


def test_module_entrypoint_requires_a_mode(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """`python -m harness.runtime_lock` without `--output`/`--replay` is a usage error."""
    monkeypatch.setattr(sys, "argv", ["runtime_lock", "--stack", str(STACK)])
    monkeypatch.delitem(sys.modules, "harness.runtime_lock")
    with pytest.raises(SystemExit) as exit_info:
        runpy.run_module("harness.runtime_lock", run_name="__main__")
    assert exit_info.value.code == 2
    assert "one of the arguments --output --replay is required" in capsys.readouterr().err
