"""Authenticate and replay native npm runtime locks without executing package code.

The owner selects initial registry bytes when updating the source lock. Promotion
attests that selection; it does not establish upstream publisher identity for
third-party packages. Consumers trust the promotion, not current registry metadata.

References:
- https://docs.npmjs.com/cli/v11/commands/npm-ci
- https://docs.npmjs.com/cli/v11/commands/npm-cache
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
from pathlib import Path, PurePosixPath
from typing import IO, Any, Literal, Self
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, model_validator

from harness.release import (
    child_environment,
    detached_exception,
    fetch_bytes,
    redact_diagnostic,
    release_package_urls,
)
from harness.stack import Stack, canonical_stack_bytes, source_string

LOGGER = logging.getLogger(__name__)
ASSET = "dependency-graph.json"
SOURCE_LOCK = "integration/stacks/runtime-locks.json"
SRI = re.compile(r"sha512-[A-Za-z0-9+/]{86}==")
NODE_KEY = re.compile(
    r"(?:node_modules/(?:@[a-z0-9._-]+/)?[a-z0-9._-]+/)*"
    r"node_modules/(?:@[a-z0-9._-]+/)?[a-z0-9._-]+"
)
PLATFORMS = {"darwin-arm64", "linux-x64"}
STRICT = ConfigDict(extra="forbid", strict=True, frozen=True)
TIMEOUT = 600


class RuntimeLockError(ValueError):
    """An authenticated graph or its downloaded/installed bytes disagree."""


class NpmGraph(BaseModel):
    model_config = STRICT
    manifest: dict[str, Any] = Field(description="Exact npm root package.json")
    lock: dict[str, Any] = Field(description="Native npm v3 lock including optional packages")

    @model_validator(mode="after")
    def validate_graph(self) -> Self:
        """Refuse unpinned roots, unsupported sources and unauthenticated entries.

        Returns:
            Self: the validated native npm graph.

        Raises:
            RuntimeLockError: graph shape or package authentication metadata is unsupported.
        """
        if self.lock.get("lockfileVersion") != 3:
            raise RuntimeLockError("Runtime lock must use native npm `lockfileVersion` 3")
        entries = self.lock.get("packages")
        if not isinstance(entries, dict) or not isinstance(entries.get(""), dict):
            raise RuntimeLockError("Runtime lock requires `packages` and its root entry")
        root = entries[""]
        if root.get("dependencies") != self.manifest.get("dependencies"):
            raise RuntimeLockError("Runtime lock root dependencies differ from its manifest")
        if set(self.manifest) - {"name", "version", "private", "dependencies", "overrides"}:
            raise RuntimeLockError("Runtime root manifest contains unsupported fields")
        for key, entry in entries.items():
            if key:
                validate_entry(key, entry, entries)
        for name in self.manifest.get("dependencies", {}):
            if f"node_modules/{name}" not in entries:
                raise RuntimeLockError(f"Runtime lock is missing root '{name}'")
        return self


class RuntimeLocks(BaseModel):
    model_config = STRICT
    schema_version: Literal[1] = Field(description="Runtime lock format version")
    stack_sha256: str = Field(pattern=r"^[0-9a-f]{64}$", description="Canonical selected stack digest")
    platforms: dict[str, dict[str, NpmGraph]] = Field(description="Supported platform -> core/agent graphs")

    @model_validator(mode="after")
    def validate_platforms(self) -> Self:
        """Require both supported platforms and both installation roots.

        Returns:
            Self: the validated source-selected runtime graph set.

        Raises:
            RuntimeLockError: a platform or root is missing or unexpected.
        """
        if set(self.platforms) != PLATFORMS:
            raise RuntimeLockError("Runtime locks must cover exactly darwin-arm64 and linux-x64")
        if any(set(graphs) != {"core", "agent"} for graphs in self.platforms.values()):
            raise RuntimeLockError("Each runtime platform must contain exactly core and agent graphs")
        return self

    def bind(self, stack: Stack) -> None:
        """Require the graphs' roots and digest to equal the exact selected stack.

        Parameters:
            stack (Stack): authoritative selected stack.

        Returns:
            None: graph roots and canonical digest match the selection.

        Raises:
            RuntimeLockError: a stack digest, root manifest or exact dependency differs.
        """
        if self.stack_sha256 != hashlib.sha256(canonical_stack_bytes(stack)).hexdigest():
            raise RuntimeLockError("Runtime locks do not match the selected canonical stack")
        for graphs in self.platforms.values():
            for kind, graph in graphs.items():
                if graph.manifest != root_manifest(stack, kind):
                    raise RuntimeLockError(f"Runtime '{kind}' root differs from the selected stack")
                for name, spec in graph.manifest["dependencies"].items():
                    entry = graph.lock["packages"][f"node_modules/{name}"]
                    field = "resolved" if spec.startswith("https:") else "version"
                    if entry.get(field) != spec:
                        raise RuntimeLockError(f"Runtime root lock identity differs for '{name}'")


class DependencyGraph(BaseModel):
    model_config = STRICT
    schema_version: Literal[1] = Field(description="Supplemental asset format version")
    source_sha: str = Field(pattern=r"^[0-9a-f]{40}$", description="Exact promoted source commit")
    runtime: RuntimeLocks = Field(description="Source-selected complete runtime locks")


def validate_entry(key: str, entry: Any, entries: dict[str, Any]) -> None:
    """Validate native lock package identity, source and standard SRI metadata.

    Parameters:
        key (str): native node_modules package key.
        entry (Any): raw native npm package record.
        entries (dict[str, Any]): complete graph, including bundled parents.

    Returns:
        None: the entry has a supported authenticated extraction source.

    Raises:
        RuntimeLockError: a package is linked, unversioned or lacks supported URL/SRI evidence.
    """
    if NODE_KEY.fullmatch(key) is None or not isinstance(entry, dict) or entry.get("link"):
        raise RuntimeLockError(f"Unsupported runtime lock entry '{key}'")
    if not isinstance(entry.get("version"), str) or not entry["version"]:
        raise RuntimeLockError(f"Runtime lock entry '{key}' has no exact version")
    if entry.get("inBundle") is True:
        parent = key.rsplit("/node_modules/", 1)[0]
        if parent == key or parent not in entries:
            raise RuntimeLockError(f"Bundled runtime entry '{key}' has no authenticated parent")
        return
    url, integrity = entry.get("resolved"), entry.get("integrity")
    if not isinstance(url, str) or not isinstance(integrity, str) or SRI.fullmatch(integrity) is None:
        raise RuntimeLockError(f"Runtime lock entry '{key}' requires a URL and SHA-512 SRI")
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in {None, 443}:
        raise RuntimeLockError(f"Runtime lock entry '{key}' has an unsupported tarball URL")
    if parsed.hostname != "registry.npmjs.org" and not (
        parsed.hostname == "github.com" and parsed.path.startswith("/nredd/pi/releases/download/")
    ):
        raise RuntimeLockError(f"Runtime lock entry '{key}' has an unsupported tarball host")
    if parsed.query or parsed.fragment:
        raise RuntimeLockError(f"Runtime lock entry '{key}' has URL query/fragment data")


def root_manifest(stack: Stack, kind: str) -> dict[str, Any]:
    """Derive exact install roots without another editable package selection.

    Parameters:
        stack (Stack): authoritative exact stack selection.
        kind (str): core or agent installation root.

    Returns:
        dict[str, Any]: native npm manifest with exact roots and core resource override.

    Raises:
        RuntimeLockError: the root kind or selected source is unsupported.
    """
    if kind == "core":
        urls = release_package_urls(stack.core.tag)
        dependencies = {"@earendil-works/pi-coding-agent": urls["pi-coding-agent"]}
        overrides = {"@earendil-works/pi-tui": urls["pi-tui"]}
    elif kind == "agent":
        dependencies = {}
        for package in stack.sources:
            source = source_string(package)
            if not source.startswith("npm:"):
                raise RuntimeLockError("Authenticated runtime installs support exact npm stack sources only")
            name, version = source.removeprefix("npm:").rsplit("@", 1)
            dependencies[name] = version
        overrides = {}
    else:
        raise RuntimeLockError(f"Unknown runtime root '{kind}'")
    return {
        "name": f"pi-stack-{kind}-runtime",
        "version": "1.0.0",
        "private": True,
        "dependencies": dependencies,
        **({"overrides": overrides} if overrides else {}),
    }


def npm_env(root: Path) -> dict[str, str]:
    """Build private config/cache paths; never inherit registry configuration or credentials.

    Parameters:
        root (Path): private npm configuration/cache directory.

    Returns:
        dict[str, str]: shared child environment with installer-owned no-script npm policy.

    Raises:
        OSError: private configuration cannot be created.
    """
    root.mkdir(parents=True, exist_ok=True)
    for name in ("user.npmrc", "global.npmrc"):
        (root / name).touch()
    (root / "home").mkdir(exist_ok=True)
    return child_environment(
        os.environ,
        overrides={
            "HOME": str(root / "home"),
            "npm_config_userconfig": str(root / "user.npmrc"),
            "npm_config_globalconfig": str(root / "global.npmrc"),
            "npm_config_cache": str(root / "cache"),
            "npm_config_registry": "https://registry.npmjs.org/",
            "npm_config_ignore_scripts": "true",
            "npm_config_audit": "false",
            "npm_config_fund": "false",
        },
    )


def run_npm(npm: str, args: list[str], root: Path, env: dict[str, str]) -> None:
    """Run only the selected native npm executable with bounded, sanitized failures.

    Parameters:
        npm (str): absolute preflight-selected executable.
        args (list[str]): installer-owned native npm arguments.
        root (Path): private working directory.
        env (dict[str, str]): installer-owned environment overrides from npm_env.

    Returns:
        None: native npm completed successfully.

    Raises:
        RuntimeLockError: executable selection or native npm execution failed.
    """
    if not Path(npm).is_absolute():
        raise RuntimeLockError("Runtime npm requires the absolute preflight-selected executable")
    try:
        subprocess.check_output(
            [npm, *args],
            cwd=root,
            env=child_environment(os.environ, overrides=env),
            text=True,
            stderr=subprocess.STDOUT,
            timeout=TIMEOUT,
        )
    except (OSError, subprocess.SubprocessError) as error:
        output = getattr(error, "output", None)
        detail = redact_diagnostic(output)[-4000:] if output is not None else str(error)
        failure = detached_exception(RuntimeLockError(f"Runtime npm operation failed: {detail}"), error)
    else:
        return
    raise failure from failure.__cause__


def check_sri(contents: bytes, integrity: str) -> None:
    """Compare exact downloaded bytes with authenticated standard npm SHA-512 SRI.

    Parameters:
        contents (bytes): actual tarball bytes, not registry metadata.
        integrity (str): standard SRI from the independently authenticated graph.

    Returns:
        None: the tarball matches the selected bytes.

    Raises:
        RuntimeLockError: the tarball was replaced or truncated.
    """
    actual = "sha512-" + base64.b64encode(hashlib.sha512(contents).digest()).decode("ascii")
    if actual != integrity:
        raise RuntimeLockError("Runtime tarball bytes do not match authenticated npm SRI")


def acquire(graph: NpmGraph, scratch: Path, core_checksums: dict[str, str] | None = None) -> dict[str, Path]:
    """Verify every graph tarball before passing any bytes to native npm.

    Parameters:
        graph (NpmGraph): independently authenticated native npm graph.
        scratch (Path): private archive destination.
        core_checksums (dict[str, str] | None): separately authenticated core URL/SHA-256 evidence.

    Returns:
        dict[str, Path]: complete non-bundled lock-key-to-verified-archive inventory.

    Raises:
        OSError: a tarball cannot be fetched or written.
        RuntimeLockError: bytes, core identity or archive layout fail verification.
    """
    scratch.mkdir(parents=True, exist_ok=True)
    archives: dict[str, Path] = {}
    by_integrity: dict[str, Path] = {}
    for key, entry in graph.lock["packages"].items():
        if not key or entry.get("inBundle"):
            continue
        integrity = entry["integrity"]
        archive = by_integrity.get(integrity)
        if archive is None:
            contents = fetch_bytes(entry["resolved"])
            check_sri(contents, integrity)
            if urlsplit(entry["resolved"]).hostname == "github.com":
                expected = (core_checksums or {}).get(entry["resolved"])
                if expected is None or hashlib.sha256(contents).hexdigest() != expected:
                    raise RuntimeLockError("Runtime core tarball differs from authenticated core release")
            archive = scratch / f"{len(by_integrity)}.tgz"
            archive.write_bytes(contents)
            validate_archive(archive)
            by_integrity[integrity] = archive
        archives[key] = archive
    return archives


def validate_archive(archive: Path) -> None:
    """Bound and validate npm's strip-one extraction envelope before native cache/extraction.

    Parameters:
        archive (Path): SRI-verified tarball.

    Returns:
        None: member names, kinds, links and expansion fit the supported envelope.

    Raises:
        OSError: the archive cannot be read.
        RuntimeLockError: parsing, layout or extraction bounds fail.
    """
    total = 0
    names: set[str] = set()
    top: str | None = None
    try:
        with tarfile.open(archive) as package:
            for member in package:
                parts = PurePosixPath(member.name).parts
                if not parts or ".." in parts or member.name.startswith("/"):
                    raise RuntimeLockError("Runtime tarball has an unsafe member path")
                if member.name in names or (top is not None and parts[0] != top):
                    raise RuntimeLockError("Runtime tarball has ambiguous extraction paths")
                names.add(member.name)
                top = parts[0]
                total += member.size
                if len(names) > 100_000 or total > 512 * 1024**2:
                    raise RuntimeLockError("Runtime tarball exceeds extraction limits")
                if not (member.isfile() or member.isdir() or member.issym()):
                    raise RuntimeLockError("Runtime tarball has an unsupported member kind")
                if member.issym():
                    link = PurePosixPath(member.linkname)
                    if link.is_absolute() or ".." in link.parts:
                        raise RuntimeLockError("Runtime tarball has an escaping symbolic link")
    except tarfile.TarError as error:
        raise RuntimeLockError(f"Runtime tarball is not a readable npm archive: {error}") from error


def stream_digest(stream: IO[bytes]) -> bytes:
    """Hash tar/file streams with bounded reads rather than loading members in memory.

    Parameters:
        stream (IO[bytes]): authenticated archive member or installed regular file.

    Returns:
        bytes: standard SHA-512 digest of the stream.

    Raises:
        OSError: the stream cannot be read.
    """
    digest = hashlib.sha512()
    while chunk := stream.read(1024 * 1024):
        digest.update(chunk)
    return digest.digest()


def audit_archive(archive: Path, destination: Path, expected: set[Path]) -> None:
    """Compare installed regular-file bytes and links with their verified npm archive.

    Parameters:
        archive (Path): previously verified, bounded npm tarball.
        destination (Path): installed package directory for this exact lock key.
        expected (set[Path]): accumulated authenticated installed-file inventory.

    Returns:
        None: every installed archive member has its selected bytes or link target.

    Raises:
        OSError: a local archive/file cannot be read.
        RuntimeLockError: installed content, ancestor kinds or archive layout differ.
    """
    with tarfile.open(archive) as package:
        top: str | None = None
        for member in package:
            parts = PurePosixPath(member.name).parts
            if not parts or ".." in parts or member.name.startswith("/"):
                raise RuntimeLockError("Runtime tarball has an unsupported member path")
            # npm/pacote strips one component; historical registry archives also
            # use package-name/version prefixes rather than the modern `package/`.
            if top is not None and parts[0] != top:
                raise RuntimeLockError("Runtime tarball has multiple extraction prefixes")
            top = parts[0]
            target = destination.joinpath(*parts[1:])
            if destination.is_symlink() or any(parent.is_symlink() for parent in target.parents):
                raise RuntimeLockError("Installed runtime contains a linked ancestor")
            if member.isdir():
                continue
            expected.add(target)
            if member.issym():
                if not target.is_symlink() or str(target.readlink()) != member.linkname:
                    raise RuntimeLockError(f"Installed runtime link differs: '{target.name}'")
            elif member.isfile():
                source = package.extractfile(member)
                if source is None or target.is_symlink() or not target.is_file():
                    raise RuntimeLockError(f"Installed runtime file is absent or linked: '{target.name}'")
                with target.open("rb") as installed:
                    if stream_digest(source) != stream_digest(installed):
                        raise RuntimeLockError(f"Installed runtime bytes differ: '{target.name}'")
            else:
                raise RuntimeLockError("Runtime tarball contains an unsupported entry kind")


def native_bin_targets(graph: NpmGraph, root: Path) -> dict[Path, set[Path]]:
    """Derive npm-generated bin links from already byte-audited package manifests.

    Parameters:
        graph (NpmGraph): complete authenticated native graph.
        root (Path): byte-audited installation prefix.

    Returns:
        dict[Path, set[Path]]: permitted bin names and signed package file targets.

    Raises:
        OSError | ValueError: an installed authenticated manifest cannot be read.
    """
    targets: dict[Path, set[Path]] = {}
    for key in graph.lock["packages"]:
        if not key or not (root / key).exists():
            continue
        package = root / key
        manifest = json.loads((package / "package.json").read_bytes())
        bins = manifest.get("bin", {})
        if isinstance(bins, str):
            bins = {key.rsplit("/", 1)[-1]: bins}
        if not isinstance(bins, dict):
            raise RuntimeLockError("Authenticated package has an unsupported bin declaration")
        modules = package.parent.parent if package.parent.name.startswith("@") else package.parent
        for name, target in bins.items():
            if not isinstance(name, str) or not isinstance(target, str):
                raise RuntimeLockError("Authenticated package bin mapping must contain strings")
            link = modules / ".bin" / name
            targets.setdefault(link, set()).add((package / target).resolve())
    return targets


def audit_install(graph: NpmGraph, root: Path, archives: dict[str, Path]) -> None:
    """Audit actual bytes before executable use, not merely generated lock metadata.

    Parameters:
        graph (NpmGraph): authenticated complete runtime graph.
        root (Path): staged or existing npm prefix.
        archives (dict[str, Path]): complete authenticated archive inventory.

    Returns:
        None: all installed bytes and non-directory inventory match authenticated archives.

    Raises:
        OSError: an installed entry cannot be read.
        RuntimeLockError: any required archive, installed byte or inventory entry differs.
    """
    required = {key for key, entry in graph.lock["packages"].items() if key and not entry.get("inBundle")}
    if set(archives) != required:
        raise RuntimeLockError("Authenticated archive inventory differs from the complete lock graph")
    expected: set[Path] = set()
    for key, archive in archives.items():
        destination = root / key
        if not destination.exists() and graph.lock["packages"][key].get("optional") is True:
            continue
        audit_archive(archive, destination, expected)
    bins = native_bin_targets(graph, root)
    for link, targets in bins.items():
        if not link.is_symlink() or link.resolve() not in targets or link.resolve() not in expected:
            raise RuntimeLockError(
                "Installed runtime bin link is missing or differs from authenticated manifest"
            )
    modules = root / "node_modules"
    for path in modules.rglob("*"):
        if path.is_dir() and not path.is_symlink():
            continue
        if path == modules / ".package-lock.json":
            continue
        if path.parent.name == ".bin" and path.is_symlink():
            target = path.resolve()
            if target in expected and target in bins.get(path, set()):
                continue
        if path not in expected:
            raise RuntimeLockError(f"Unexpected installed runtime entry '{path.relative_to(root)}'")


def install_graph(graph: NpmGraph, root: Path, scratch: Path, npm: str, archives: dict[str, Path]) -> None:
    """Replay one authenticated graph offline with scripts disabled, then audit all bytes.

    Parameters:
        graph (NpmGraph): independently authenticated complete native lock.
        root (Path): empty staged npm prefix.
        scratch (Path): private native npm config/cache directory.
        npm (str): absolute preflight-selected native npm executable.
        archives (dict[str, Path]): previously verified complete tarball inventory.

    Returns:
        None: native offline replay and installed-byte audit both passed.

    Raises:
        OSError: staged files cannot be created/read.
        RuntimeLockError: root, archive bytes, cache, offline replay or installed bytes fail.
    """
    if root.exists() and any(root.iterdir()):
        raise RuntimeLockError("Runtime install root must be empty")
    # Recheck immediately before importing local archives into npm's private cache.
    for key, archive in archives.items():
        check_sri(archive.read_bytes(), graph.lock["packages"][key]["integrity"])
        validate_archive(archive)
    env = npm_env(scratch) | {"npm_config_offline": "true"}
    root.mkdir(parents=True, exist_ok=True)
    (root / "package.json").write_text(json.dumps(graph.manifest))
    (root / "package-lock.json").write_text(json.dumps(graph.lock))
    for archive in dict.fromkeys(archives.values()):
        run_npm(npm, ["cache", "add", str(archive), "--offline", "--ignore-scripts"], root, env)
    run_npm(npm, ["ci", "--offline", "--ignore-scripts", "--include=optional", "--include=peer"], root, env)
    audit_install(graph, root, archives)


def selected_graphs(runtime: RuntimeLocks) -> dict[str, NpmGraph]:
    """Select only a supported physical platform; admission remains installer-owned.

    Parameters:
        runtime (RuntimeLocks): authenticated source-selected graphs for both targets.

    Returns:
        dict[str, NpmGraph]: core/agent graphs for this native target.

    Raises:
        RuntimeLockError: this OS/architecture has no supported graph.
    """
    key = {("Darwin", "arm64"): "darwin-arm64", ("Linux", "x86_64"): "linux-x64"}.get(
        (platform.system(), platform.machine())
    )
    if key is None:
        raise RuntimeLockError("No authenticated runtime graph for this platform")
    return runtime.platforms[key]


def generate(stack: Stack, npm: str, scratch: Path) -> RuntimeLocks:
    """Select initial dependency bytes explicitly; no publisher identity assurance is implied.

    Parameters:
        stack (Stack): exact authoritative stack.
        npm (str): absolute selected native npm executable.
        scratch (Path): private lock generation/config directory.

    Returns:
        RuntimeLocks: source-reviewable complete locks bound to the canonical stack digest.

    Raises:
        OSError: generated manifests/locks cannot be written/read.
        ValueError: native npm output or stack roots are unsupported.
    """
    graphs: dict[str, dict[str, NpmGraph]] = {}
    for target in sorted(PLATFORMS):
        os_, cpu = target.split("-", 1)
        graphs[target] = {}
        for kind in ("core", "agent"):
            root = scratch / target / kind
            root.mkdir(parents=True)
            manifest = root_manifest(stack, kind)
            (root / "package.json").write_text(json.dumps(manifest))
            run_npm(
                npm,
                [
                    "install",
                    "--package-lock-only",
                    "--ignore-scripts",
                    "--include=optional",
                    "--include=peer",
                    "--min-release-age=0",
                    f"--os={os_}",
                    f"--cpu={cpu}",
                ],
                root,
                npm_env(scratch / "npm"),
            )
            graphs[target][kind] = NpmGraph(
                manifest=manifest, lock=json.loads((root / "package-lock.json").read_bytes())
            )
    return RuntimeLocks(
        schema_version=1,
        stack_sha256=hashlib.sha256(canonical_stack_bytes(stack)).hexdigest(),
        platforms=graphs,
    )


def replay_source(runtime: RuntimeLocks, stack: Stack, scratch: Path, npm: str) -> None:
    """CI-only real-input replay of source-selected locks before their first promotion.

    This is source-lock compatibility evidence, NOT verification of a published graph attestation.
    No package code runs until both complete graphs have passed their installed-byte audits.

    Parameters:
        runtime (RuntimeLocks): reviewed source-selected graphs.
        stack (Stack): authoritative stack selection.
        scratch (Path): private native replay directory.
        npm (str): absolute selected native npm executable.

    Returns:
        None: both graph audits and the isolated version smoke check pass.

    Raises:
        OSError | ValueError: binding, acquisition, native replay or byte auditing fails.
        RuntimeLockError: the authenticated source runtime cannot start.
    """
    runtime.bind(stack)
    checksums = {
        url: stack.core.integrity[url.rsplit("/", 1)[-1]]
        for url in release_package_urls(stack.core.tag).values()
        if url.rsplit("/", 1)[-1] in stack.core.integrity
    }
    graphs = selected_graphs(runtime)
    archives = {
        kind: acquire(graph, scratch / kind / "archives", checksums) for kind, graph in graphs.items()
    }
    for kind, graph in graphs.items():
        install_graph(graph, scratch / kind / "prefix", scratch / kind / "npm", npm, archives[kind])
    executable = scratch / "core" / "prefix" / "node_modules" / ".bin" / "pi"
    env = npm_env(scratch / "smoke") | {
        "PI_CODING_AGENT_DIR": str(scratch / "agent"),
        "PI_SKIP_VERSION_CHECK": "1",
        "PI_TELEMETRY": "0",
    }
    try:
        version = subprocess.check_output(
            [str(executable), "--version"],
            cwd=scratch,
            env=child_environment(os.environ, overrides=env),
            text=True,
            stderr=subprocess.STDOUT,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as error:
        failure = detached_exception(
            RuntimeLockError(f"Verified source runtime could not start: {error}"), error
        )
    else:
        LOGGER.info(f"Source-selected offline runtime replay and byte audits passed: {version.strip()}")
        return
    raise failure from failure.__cause__


def main() -> None:
    """Generate initial reviewed locks, or explicitly replay them for native CI compatibility.

    Returns:
        None: selected source locks were written or replayed successfully.

    Raises:
        SystemExit: arguments or native npm selection are invalid.
        OSError | ValueError: stack inputs, generation or native replay fail.
    """
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--stack", type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--output", type=Path)
    mode.add_argument("--replay", type=Path, help="CI-only native replay of an existing source lock")
    args = parser.parse_args()
    npm = shutil.which("npm")
    if npm is None:
        parser.error("npm is required")
    stack = Stack.model_validate_json(args.stack.read_bytes())
    with tempfile.TemporaryDirectory(prefix="runtime-lock-") as temporary:
        scratch = Path(temporary).resolve()
        if args.replay is not None:
            replay_source(
                RuntimeLocks.model_validate_json(args.replay.read_bytes()),
                stack,
                scratch,
                str(Path(npm).absolute()),
            )
            return
        runtime = generate(stack, str(Path(npm).absolute()), scratch)
    args.output.write_text(runtime.model_dump_json(indent=2) + "\n")


if __name__ == "__main__":
    main()
