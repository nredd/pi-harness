"""Test the package-contract tooling against real npm tarballs and a real HTTP provider.

The Pi-driven scenarios need stock Pi and run through `make check-package-contracts`; these tests
cover the audits and the scripted provider with real inputs and the failure paths that gate relies on.

References:
    https://docs.npmjs.com/cli/v11/commands/npm-pack
"""

from __future__ import annotations

import io
import json
import shutil
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import faux_provider as fp
import npm_release as nr
import package_contracts as pc
import stock_package_contract as spc

DEV_TOOLS = pc.CONTRACTS[0]
# The real published identity, as the repository lockfile pins it for dev-tools; never an invented hash.
SAMPLER_LOCK = json.loads((pc.REPO_ROOT / "package-lock.json").read_text())["packages"][
    "packages/dev-tools/node_modules/@nredd/pi-resource-sampler"
]
RESOURCE_EVIDENCE: dict[str, object] = {
    "resource_ranking": "rss",
    "resource_sampler_integrity": SAMPLER_LOCK["integrity"],
    "resource_failure_path": "process_limit 51 refused",
}
ROOT_LICENSE = (pc.REPO_ROOT / "LICENSE").read_bytes()


def make_tarball(path: Path, files: dict[str, bytes]) -> Path:
    """Write an npm-shaped tarball (`package/` prefix).

    Parameters:
        path (Path): Destination.
        files (dict[str, bytes]): Paths relative to the package root and their content.

    Returns:
        Path: `path`.
    """
    with tarfile.open(path, "w:gz") as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(f"package/{name}")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return path


@pytest.fixture
def sandbox(tmp_path: Path) -> pc.Sandbox:
    """Sandbox with real tools under a temporary root.

    Parameters:
        tmp_path (Path): Pytest temporary directory.

    Returns:
        pc.Sandbox: Scrubbed environment.
    """
    return pc.Sandbox(tmp_path / "sandbox", pc.locate_tools())


@pytest.mark.parametrize(
    "contract",
    [*pc.CONTRACTS, pc.PRESET_CONTRACT, pc.COMPUTER_USE_CONTRACT, pc.SUBAGENTS_CONTRACT],
    ids=lambda c: c.directory,
)
def test_supplied_tarball_is_never_repacked(
    tmp_path: Path,
    sandbox: pc.Sandbox,
    monkeypatch: pytest.MonkeyPatch,
    contract: pc.PackageContract,
) -> None:
    """Existing tarballs retain exactly the npm-reported identity without consulting workspace sources.

    Parameters:
        tmp_path (Path): Artifact destination.
        sandbox (Sandbox): Scrubbed real tools.
        monkeypatch (pytest.MonkeyPatch): Forbids any second pack invocation.
        contract (PackageContract): Selected package.

    Returns:
        None: Supplied tarball identity remains unchanged without repacking.
    """
    artifact = pc.pack(contract, tmp_path, sandbox)
    before = artifact.path.read_bytes()

    def forbid_pack(*_args: object) -> pc.PackedArtifact:
        """Refuse a rebuild of bytes that already passed verification.

        Parameters:
            *_args (object): Unexpected pack arguments.

        Returns:
            PackedArtifact: Never returned; any invocation fails the test.
        """
        pytest.fail("Supplied candidate was repacked")

    monkeypatch.setattr(pc, "pack", forbid_pack)
    supplied = pc.parse_tarballs([f"{contract.directory}={artifact.path}"], [contract])
    selected = pc.select_artifact(contract, tmp_path / "unused", sandbox, supplied)
    assert selected == artifact
    assert artifact.path.read_bytes() == before


def test_stock_gate_audits_and_installs_supplied_bytes(
    tmp_path: Path,
    sandbox: pc.Sandbox,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Exercise real stock-gate audit/install/report plumbing, replacing only the Pi boundary.

    Parameters:
        tmp_path (Path): Scratch directory.
        sandbox (Sandbox): Real packing tools.
        monkeypatch (pytest.MonkeyPatch): Forbids repacking and substitutes stock Pi setup/scenario.

    Returns:
        None: The stock gate audits and installs the supplied candidate.
    """
    artifact = pc.pack(DEV_TOOLS, tmp_path, sandbox)

    def forbid(*_args: object) -> pc.PackedArtifact:
        """The stock gate must not rebuild the candidate.

        Parameters:
            *_args (object): Unexpected pack arguments.

        Returns:
            PackedArtifact: Never returned; any invocation fails the test.
        """
        pytest.fail("Candidate was repacked")

    def exercise(ctx: pc.Context) -> pc.DevToolsEvidence:
        """Check the installed artifact instead of starting Pi.

        Parameters:
            ctx (Context): Installed candidate and stock-gate context.

        Returns:
            DevToolsEvidence: Synthetic scenario evidence after byte comparison.
        """
        assert ctx.artifact == artifact
        assert (ctx.installed / "src/index.ts").read_bytes() == pc.read_member(artifact.path, "src/index.ts")
        return {
            "tool": "git_status",
            "untracked": ["fixture"],
            "failure_path": "Pi boundary substituted",
            "resource_ranking": "rss",
            "resource_sampler_integrity": SAMPLER_LOCK["integrity"],
            "resource_failure_path": "process_limit 51 refused",
        }

    monkeypatch.setattr(pc, "pack", forbid)
    monkeypatch.setattr(pc, "ensure_stock_pi", lambda *_: tmp_path / "never-run-pi")
    monkeypatch.setitem(pc.SCENARIOS, "dev-tools", exercise)
    work = tmp_path / "gate"
    work.mkdir()
    report = pc.run_gate(work, tmp_path / "stock", ["dev-tools"], {"dev-tools": artifact.path})
    assert report.packages[DEV_TOOLS.name].integrity == artifact.integrity
    assert not list((work / "tarballs").iterdir())


@pytest.mark.parametrize("case", ["missing", "broken", "identity", "filename", "manifest"])
def test_load_tarball_refuses_invalid_candidate(tmp_path: Path, case: str) -> None:
    """Missing, corrupt and misidentified archives fail before installation or Pi invocation.

    Parameters:
        tmp_path (Path): Disposable destination.
        case (str): Invalid input shape.

    Returns:
        None: Invalid supplied tarballs are refused.
    """
    path = tmp_path / "nredd-pi-dev-tools-1.0.0.tgz"
    if case == "broken":
        path.write_bytes(b"not a tarball")
    elif case != "missing":
        name = "other" if case == "identity" else DEV_TOOLS.name
        files = {"package.json": json.dumps({"name": name, "version": "1.0.0"}).encode()}
        make_tarball(path, {} if case == "manifest" else files)
        if case == "filename":
            path = path.rename(tmp_path / "wrong.tgz")
    with pytest.raises(pc.ContractError):
        pc.load_tarball(DEV_TOOLS, path)


@pytest.mark.parametrize("kind", [tarfile.SYMTYPE, tarfile.LNKTYPE], ids=["symlink", "hardlink"])
def test_load_tarball_rejects_special_members(tmp_path: Path, kind: bytes) -> None:
    """Audited tarballs cannot hide files behind links.

    Parameters:
        tmp_path (Path): Disposable destination.
        kind (bytes): Tar member type to inject.
    """
    path = tmp_path / "nredd-pi-dev-tools-1.0.0.tgz"
    with tarfile.open(path, "w:gz") as tar:
        data = json.dumps({"name": DEV_TOOLS.name, "version": "1.0.0"}).encode()
        manifest = tarfile.TarInfo("package/package.json")
        manifest.size = len(data)
        tar.addfile(manifest, io.BytesIO(data))
        member = tarfile.TarInfo("package/linked")
        member.type = kind
        member.linkname = "package/package.json"
        tar.addfile(member)
    with pytest.raises(pc.ContractError, match="non-regular member"):
        pc.load_tarball(DEV_TOOLS, path)


@pytest.mark.parametrize(
    "pairs",
    [
        ["no-equals"],
        ["unknown=/tmp/no"],
        ["dev-tools="],
        ["dev-tools=FILE", "dev-tools=FILE"],
    ],
)
def test_tarball_pairs_refuse_bad_selection(tmp_path: Path, pairs: list[str]) -> None:
    """Malformed, unknown and duplicate selections fail closed.

    Parameters:
        tmp_path (Path): Fixture directory.
        pairs (list[str]): Invalid option list.

    Returns:
        None: Invalid tarball selections are refused.
    """
    path = make_tarball(
        tmp_path / "nredd-pi-dev-tools-1.0.0.tgz",
        {
            "package.json": json.dumps({"name": DEV_TOOLS.name, "version": "1.0.0"}).encode(),
        },
    )
    with pytest.raises(pc.ContractError):
        pc.parse_tarballs([value.replace("FILE", str(path)) for value in pairs], pc.CONTRACTS)


def test_audit_gate_packs_audits_and_installs_the_preset(tmp_path: Path) -> None:
    """The preset has no stock behavior; its packed bytes still pass the full audit and a clean install.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
    """
    evidence = pc.run_audit_gate(tmp_path, pc.PRESET_CONTRACT)
    assert evidence["name"] == "@nredd/pi-preset"
    assert "agents/code-reviewer.md" in evidence["files"]  # ty: ignore[unsupported-operator]


def test_audit_gate_rejects_a_tarball_missing_required_files(tmp_path: Path) -> None:
    """A supplied preset tarball that lacks contract files fails the audit instead of installing.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
    """
    manifest = b'{"name": "@nredd/pi-preset", "version": "0.0.1"}'
    tarball = tmp_path / "nredd-pi-preset-0.0.1.tgz"
    with tarfile.open(tarball, "w:gz") as tar:
        info = tarfile.TarInfo("package/package.json")
        info.size = len(manifest)
        tar.addfile(info, io.BytesIO(manifest))
    work = tmp_path / "work"
    work.mkdir()
    with pytest.raises(pc.ContractError, match="Tarball audit failed"):
        pc.run_audit_gate(work, pc.PRESET_CONTRACT, {pc.PRESET_CONTRACT.directory: tarball})


def test_audit_gate_propagates_an_install_alone_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A clean-install failure is never swallowed by the audit gate.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
        monkeypatch (pytest.MonkeyPatch): Replaces `install_alone` with a failing double.
    """

    def boom(*_args: object, **_kwargs: object) -> None:
        """Fail like a broken install.

        Raises:
            ContractError: Always.
        """
        raise pc.ContractError("install exploded")

    monkeypatch.setattr(pc, "install_alone", boom)
    with pytest.raises(pc.ContractError, match="install exploded"):
        pc.run_audit_gate(tmp_path, pc.PRESET_CONTRACT)


def test_main_audit_preset_writes_the_report(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`--audit-preset --report` writes the evidence and returns 0; a failed gate returns 1.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
        monkeypatch (pytest.MonkeyPatch): Replaces `run_audit_gate` with a double.
    """
    monkeypatch.setattr(pc, "run_audit_gate", lambda _work, _contract: {"name": "@nredd/pi-preset"})
    report = tmp_path / "out-preset.json"
    assert pc.main(["--audit-preset", "--report", str(report)]) == 0
    assert json.loads(report.read_text()) == {"name": "@nredd/pi-preset"}

    def fail(_work: Path, _contract: pc.PackageContract) -> dict[str, object]:
        """Fail the audit.

        Raises:
            ContractError: Always.
        """
        raise pc.ContractError("audit failed")

    monkeypatch.setattr(pc, "run_audit_gate", fail)
    failed = tmp_path / "failed.json"
    assert pc.main(["--audit-preset", "--report", str(failed)]) == 1
    assert not failed.exists()


def test_sandbox_env_is_scrubbed(sandbox: pc.Sandbox, monkeypatch: pytest.MonkeyPatch) -> None:
    """No ambient credential or config location may leak into child processes.

    Parameters:
        sandbox (pc.Sandbox): Sandbox under test.
        monkeypatch (pytest.MonkeyPatch): Injects ambient secrets.
    """
    monkeypatch.setenv("ANTHROPIC_API_KEY", "secret")
    monkeypatch.setenv("OPENAI_API_KEY", "secret")
    monkeypatch.setenv("NODE_OPTIONS", "--require=/tmp/evil.js")
    monkeypatch.setenv("PI_PACKAGE_DIR", "/live")
    env = sandbox.env()
    assert not {k for k in env if k.endswith("_API_KEY")}
    assert env["HOME"].startswith(str(sandbox.root))
    assert env["PI_CODING_AGENT_DIR"] == str(sandbox.agent_dir)
    assert env["PI_OFFLINE"] == "1"
    assert env["HTTPS_PROXY"] == pc.DEAD_PROXY
    assert "127.0.0.1" in env["NO_PROXY"]
    state_keys = ("HOME", "TMPDIR", "TMP", "TEMP", "CODEX_HOME", "npm_config_cache", "PI_CODING_AGENT_DIR")
    state_keys += tuple(k for k in env if k.startswith("XDG_"))
    assert all(Path(env[k]).is_relative_to(sandbox.root) for k in state_keys)
    assert set(env) <= {
        *state_keys,
        "PATH",
        "LANG",
        "PI_OFFLINE",
        "PI_SKIP_VERSION_CHECK",
        "PI_TELEMETRY",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_NOSYSTEM",
        "npm_config_userconfig",
        "npm_config_globalconfig",
        "npm_config_update_notifier",
    }


def test_run_rejects_relative_executable(tmp_path: Path) -> None:
    """Commands resolve through absolute paths only.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
    """
    with pytest.raises(ValueError, match="absolute path"):
        pc.run(["node", "--version"], env={}, cwd=tmp_path, timeout=5)


def test_run_reports_nonzero_exit(tmp_path: Path) -> None:
    """A failing child surfaces its streams.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
    """
    with pytest.raises(pc.ContractError, match="exited 3"):
        pc.run([Path("/bin/sh"), "-c", "echo boom >&2; exit 3"], env={}, cwd=tmp_path, timeout=5)


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ('import { a } from "node:fs";', ["node:fs"]),
        ('import type { T } from "@earendil-works/pi-ai";', ["@earendil-works/pi-ai"]),
        ('import {\n  a,\n  b,\n} from "./x.ts";', ["./x.ts"]),
        ('export * from "../y.js";', ["../y.js"]),
        ('import "side-effect";', ["side-effect"]),
        ('const m = await import("lazy");', ["lazy"]),
        ('const r = require("cjs");', ["cjs"]),
        ("const m = await import(`@nredd/pi-session-kit`);", ["@nredd/pi-session-kit"]),
        ('import fs = require("fs-eq");', ["fs-eq"]),
        ('type T = import("typed").T;', ["typed"]),
        ('// "ssh itself failed", which also exits 255.\nconst s = "from \\"x\\"";', []),
        ('// import x from "@nredd/pi-session-kit";\nconst s = \'require("@nredd/x")\';', []),
    ],
)
def test_scan_imports(source: str, expected: list[str]) -> None:
    """Static, dynamic, and CommonJS imports are found; comments and strings are not.

    Parameters:
        source (str): JS or TS text.
        expected (list[str]): Specifiers that must be found.
    """
    found = pc.scan_imports({"src/a.ts": source}, pc.locate_executable("node"))["src/a.ts"]
    assert found.specifiers == expected
    assert found.diagnostics == []


def test_scan_imports_batches_files() -> None:
    """One helper run answers for every file, keyed by the original path."""
    found = pc.scan_imports(
        {"src/a.ts": 'import "a";', "dist/b.mjs": 'import("b");'}, pc.locate_executable("node")
    )
    assert {name: imports.specifiers for name, imports in found.items()} == {
        "src/a.ts": ["a"],
        "dist/b.mjs": ["b"],
    }


@pytest.mark.parametrize("name", ["../escape.ts", "/abs.ts", ""])
def test_scan_imports_rejects_unsafe_paths(name: str) -> None:
    """Tarball paths that could leave the scratch directory never reach the helper.

    Parameters:
        name (str): Hostile path.
    """
    with pytest.raises(pc.ContractError, match="Unsafe source path"):
        pc.scan_imports({name: ""}, pc.locate_executable("node"))


@pytest.mark.parametrize(
    "source",
    [
        "const m = import(`@nredd/${name}`);",
        'const m = import("@nredd/" + name);',
        "const m = import(name);",
        "const m = require(name);",
        "const m = require(`@nredd/${name}`);",
        "const m = cond ? import(a) : import(b);",
        "type T = import(`@nredd/${name}`).T;",
    ],
)
def test_audit_imports_rejects_computed_specifiers(source: str) -> None:
    """A specifier the gate cannot read is a violation with a file:line:col location, never skipped.

    Parameters:
        source (str): JS or TS text with a non-literal specifier.
    """
    problems = pc.audit_imports("src/a.ts", source, ["src/a.ts"])
    assert problems
    assert all(p.startswith("src/a.ts:") and "not a string literal" in p for p in problems), problems


@pytest.mark.parametrize(
    "source",
    [
        "const m = await import(`@nredd/pi-session-kit`);",
        'const m = await import("@nredd/pi-session-kit");',
        'const m = require("@nredd/pi-session-kit");',
        'export * from "@nredd/pi-session-kit";',
        'type T = import("@nredd/pi-session-kit").T;',
    ],
)
def test_audit_imports_rejects_sibling_in_every_form(source: str) -> None:
    """Sibling plugin imports are caught in unexercised, non-static branches too.

    Parameters:
        source (str): JS or TS text importing the sibling.
    """
    problems = pc.audit_imports("src/a.ts", source, ["src/a.ts"])
    assert len(problems) == 1
    assert "sibling plugin" in problems[0]


def test_repository_lock_pins_the_published_sampler_for_dev_tools() -> None:
    """The workspace lock entry is the registry release at the contract's exact version."""
    assert SAMPLER_LOCK["version"] == pc.RESOURCE_SAMPLER_VERSION
    assert SAMPLER_LOCK["resolved"] == (
        f"https://registry.npmjs.org/@nredd/pi-resource-sampler/-/pi-resource-sampler-{pc.RESOURCE_SAMPLER_VERSION}.tgz"
    )


def sampler_install(tmp_path: Path, entry: Mapping[str, object], *, link: bool = False) -> Path:
    """Lay out `<project>/node_modules` with the plugin, the sampler and a lockfile entry.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
        entry (Mapping[str, object]): Lock entry for the sampler.
        link (bool): Make the sampler a symlink, as a workspace link would be.

    Returns:
        Path: The installed plugin directory.
    """
    project = tmp_path / "project"
    installed = project / "node_modules" / "@nredd" / "pi-dev-tools"
    installed.mkdir(parents=True)
    sampler = project / "node_modules" / "@nredd" / "pi-resource-sampler"
    if link:
        (tmp_path / "workspace").mkdir()
        sampler.symlink_to(tmp_path / "workspace")
    else:
        sampler.mkdir()
    lock = {"packages": {"node_modules/@nredd/pi-resource-sampler": entry}}
    (project / "package-lock.json").write_text(json.dumps(lock))
    return installed


PUBLISHED = pc.PublishedDist(tarball=SAMPLER_LOCK["resolved"], integrity=SAMPLER_LOCK["integrity"])
LOCKED = {
    "version": pc.RESOURCE_SAMPLER_VERSION,
    "resolved": PUBLISHED.tarball,
    "integrity": PUBLISHED.integrity,
}


def test_installed_sampler_matches_published_registry_metadata(tmp_path: Path) -> None:
    """The exact published tarball URL and integrity are accepted."""
    assert pc.installed_sampler_integrity(sampler_install(tmp_path, LOCKED), PUBLISHED) == PUBLISHED.integrity


# Shaped like a real integrity but not the published one: the check compares values, not shape.
OTHER_INTEGRITY = "sha512-" + "A" * 86 + "=="


@pytest.mark.parametrize(
    ("entry", "link", "message"),
    [
        (LOCKED, True, "not a real installed directory"),
        (LOCKED | {"version": "0.1.1"}, False, "not exactly '0.1.0'"),
        (LOCKED | {"integrity": OTHER_INTEGRITY}, False, "differs from the published"),
        ({k: v for k, v in LOCKED.items() if k != "integrity"}, False, "differs from the published"),
        (LOCKED | {"resolved": "file:../resource-sampler"}, False, "not the published"),
        ({k: v for k, v in LOCKED.items() if k != "resolved"}, False, "resolved from <missing>"),
        (
            LOCKED | {"resolved": "https://mirror.example/@nredd/pi-resource-sampler/-/x.tgz"},
            False,
            "resolved from https://mirror.example/",
        ),
    ],
    ids=["linked", "version", "integrity", "no-integrity", "file", "no-resolved", "mirror"],
)
def test_installed_sampler_rejects_other_bytes_or_origin(
    tmp_path: Path, entry: Mapping[str, object], *, link: bool, message: str
) -> None:
    """Any other version, origin, integrity or a link is refused, not merely a null integrity.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
        entry (Mapping[str, object]): Lock entry for the sampler.
        link (bool): Install the sampler as a symlink.
        message (str): Expected error fragment.
    """
    with pytest.raises(pc.ContractError, match=message):
        pc.installed_sampler_integrity(sampler_install(tmp_path, entry, link=link), PUBLISHED)


def test_installed_sampler_errors_never_echo_registry_credentials(tmp_path: Path) -> None:
    """A credentialed or tokenized resolved URL is reported without userinfo or query."""
    secret = "https://user:hunter2@registry.example:8443/s/-/s.tgz?token=abc#frag"
    installed = sampler_install(tmp_path, LOCKED | {"resolved": secret})
    with pytest.raises(pc.ContractError) as raised:
        pc.installed_sampler_integrity(installed, PUBLISHED)
    assert "hunter2" not in str(raised.value)
    assert "token" not in str(raised.value)
    assert "https://registry.example:8443/s/-/s.tgz" in str(raised.value)


@pytest.mark.parametrize(
    ("url", "redacted"),
    [
        (None, "<missing>"),
        ("", "<missing>"),
        ("https://u:p@host/a?b=c#d", "https://host/a"),
        ("https://host:99999/a", "<unparseable>"),
    ],
)
def test_redact_url(url: str | None, redacted: str) -> None:
    """Userinfo, query and fragment never survive.

    Parameters:
        url (str | None): Input URL.
        redacted (str): Expected output.
    """
    assert pc.redact_url(url) == redacted


def test_published_sampler_dist_queries_the_exact_release_without_credentials(
    monkeypatch: pytest.MonkeyPatch, sandbox: pc.Sandbox, tmp_path: Path
) -> None:
    """The registry is asked for exactly the pinned version through the scrubbed environment."""
    seen: dict[str, Any] = {}

    def fake_run(cmd: list[Any], *, env: dict[str, str], cwd: Path, timeout: int) -> Any:
        """Record the query and return registry-shaped JSON.

        Parameters:
            cmd (list[Any]): Argument vector.
            env (dict[str, str]): Child environment.
            cwd (Path): Working directory.
            timeout (int): Seconds.

        Returns:
            Any: Completed process stand-in.
        """
        seen.update(cmd=[str(part) for part in cmd], env=env)
        stdout = json.dumps({"tarball": PUBLISHED.tarball, "integrity": PUBLISHED.integrity, "fileCount": 9})
        return type("Done", (), {"stdout": stdout})()

    monkeypatch.setattr(pc, "run", fake_run)
    assert pc.published_sampler_dist(sandbox, tmp_path) == PUBLISHED
    assert seen["cmd"][1:] == [
        "view",
        f"@nredd/pi-resource-sampler@{pc.RESOURCE_SAMPLER_VERSION}",
        "dist",
        "--json",
    ]
    assert not any("TOKEN" in key or "AUTH" in key for key in seen["env"])
    assert seen["env"]["HTTPS_PROXY"] == ""


def test_published_sampler_dist_rejects_malformed_metadata(
    monkeypatch: pytest.MonkeyPatch, sandbox: pc.Sandbox, tmp_path: Path
) -> None:
    """A response without a real integrity fails closed."""
    done = type("Done", (), {"stdout": json.dumps({"tarball": PUBLISHED.tarball, "integrity": "sha1-x"})})()
    monkeypatch.setattr(pc, "run", lambda *_args, **_kwargs: done)
    with pytest.raises(pc.ContractError, match="malformed"):
        pc.published_sampler_dist(sandbox, tmp_path)


def test_dev_tools_pins_the_published_sampler_exactly() -> None:
    """The only sibling allowance is an exact published library version, never a range or link."""
    assert dict(DEV_TOOLS.runtime_dependencies) == {"@nredd/pi-resource-sampler": "0.1.0"}
    assert pc.RESOURCE_SAMPLER_CONTRACT.library
    assert {pc.RESOURCE_SAMPLER_CONTRACT.name} == pc.SHARED_LIBRARIES
    manifest = json.loads((pc.REPO_ROOT / "packages" / "dev-tools" / "package.json").read_text())
    assert manifest["dependencies"] == dict(DEV_TOOLS.runtime_dependencies)


@pytest.mark.parametrize(
    ("specifier", "dependencies", "path", "library", "allowed"),
    [
        ("@nredd/pi-resource-sampler", ["@nredd/pi-resource-sampler"], "src/a.ts", False, True),
        ("@nredd/pi-resource-sampler", [], "src/a.ts", False, False),
        (
            "@nredd/pi-resource-sampler/dist/collect.js",
            ["@nredd/pi-resource-sampler"],
            "src/a.ts",
            False,
            False,
        ),
        ("@nredd/pi-session-kit", ["@nredd/pi-session-kit"], "src/a.ts", False, False),
        ("@nredd/pi-resource-sampler", ["@nredd/pi-resource-sampler"], "dist/index.js", True, False),
        ("@nredd/pi-resource-sampler", ["@nredd/pi-resource-sampler"], pc.STATS_ARTIFACT, False, False),
    ],
    ids=["declared-library", "undeclared", "deep-import", "declared-plugin", "from-library", "standalone"],
)
def test_sibling_library_import_needs_an_exact_declared_dependency(
    specifier: str, dependencies: list[str], path: str, *, library: bool, allowed: bool
) -> None:
    """Only a plugin source file may import a published sibling library it declares.

    Parameters:
        specifier (str): Imported module.
        dependencies (list[str]): Declared runtime dependency names.
        path (str): Importing packed file.
        library (bool): Audit the file as part of a library contract.
        allowed (bool): Whether the import is acceptable.
    """
    found = pc.FileImports(specifiers=[specifier], diagnostics=[])
    problems = pc.classify_imports(
        path, found, [path], dependencies, frozenset({pc.STATS_ARTIFACT}), library=library
    )
    assert (problems == []) is allowed, problems


def test_audit_imports_ignores_import_text_in_comments_and_strings() -> None:
    """Text that merely looks like an import is not one."""
    source = (
        '// import x from "@nredd/pi-session-kit";\n'
        '/* require("@nredd/pi-session-kit") */\n'
        "const s = `import('@nredd/pi-session-kit')`;\n"
        'import { ok } from "node:fs";\n'
    )
    assert pc.audit_imports("src/a.ts", source, ["src/a.ts"]) == []


def test_audit_imports_rejects_computed_import_equals() -> None:
    """`import x = require(<expression>)` is not valid syntax, so it is rejected as a syntax error."""
    problems = pc.audit_imports("src/a.ts", 'import x = require("a" + b);', ["src/a.ts"])
    assert any("syntax error" in p for p in problems), problems


def test_audit_imports_reports_syntax_errors() -> None:
    """A file that does not parse cannot be trusted to list every import."""
    problems = pc.audit_imports("src/a.ts", 'import "node:fs";\nconst = ;\n', ["src/a.ts"])
    assert any(p.startswith("src/a.ts:2:") and "syntax error" in p for p in problems), problems


@pytest.mark.parametrize(
    ("path", "source", "needle"),
    [
        ("src/a.ts", 'import x from "@nredd/pi-session-kit";', "sibling plugin"),
        ("src/a.ts", 'import x from "left-pad";', "neither a Node builtin nor a host module"),
        ("src/a.ts", 'import x from "fs";', "neither a Node builtin nor a host module"),
        ("src/a.ts", 'import x from "../../outside.ts";', "leaves the package"),
        ("src/a.ts", 'import x from "./missing.ts";', "leaves the package or is missing"),
        ("dist/cli.mjs", 'import x from "typebox";', "standalone artifact"),
        ("dist/cli.mjs", 'import x from "../src/b.ts";', "standalone artifact"),
        ("dist/cli.mjs", 'import x from "./cli.mjs";', "standalone artifact"),
        ("dist/cli.mjs", 'export * from "../src/b.ts";', "standalone artifact"),
    ],
)
def test_audit_imports_rejects(path: str, source: str, needle: str) -> None:
    """Sibling, third-party, escaping, and non-standalone imports are all violations.

    Parameters:
        path (str): Packed file path.
        source (str): File text.
        needle (str): Substring the violation must contain.
    """
    problems = pc.audit_imports(
        path,
        source,
        ["src/a.ts", "src/b.ts", "dist/cli.mjs"],
        standalone_artifacts=("dist/cli.mjs",),
    )
    assert len(problems) == 1
    assert needle in problems[0]


def test_audit_imports_accepts_host_builtin_and_js_to_ts() -> None:
    """Host modules (including subpaths), builtins, and `.js` specifiers resolving to `.ts` pass."""
    source = (
        'import { Type } from "typebox";\n'
        'import { x } from "@earendil-works/pi-coding-agent/hooks";\n'
        'import { spawn } from "node:child_process";\n'
        'import { y } from "./b.js";\n'
    )
    assert pc.audit_imports("src/a.ts", source, ["src/a.ts", "src/b.ts"]) == []


def test_audit_files_flags_leaks_and_gaps() -> None:
    """Fixtures, tests, dev config and missing required files are all reported."""
    files = ["README.md", "package.json", "src/index.ts", "test/a.test.ts", "biome.json", "src/x.test.snap"]
    problems = pc.audit_files(DEV_TOOLS, files)
    assert "missing required file 'LICENSE'" in problems
    assert "unexpected file 'test/a.test.ts'" in problems
    assert "unexpected file 'biome.json'" in problems
    assert "unexpected file 'src/x.test.snap'" in problems


def test_audit_license(tmp_path: Path) -> None:
    """Missing and divergent licenses fail; the identical one passes.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
    """
    good = make_tarball(tmp_path / "good.tgz", {"LICENSE": ROOT_LICENSE})
    changed = make_tarball(tmp_path / "changed.tgz", {"LICENSE": ROOT_LICENSE + b"x"})
    absent = make_tarball(tmp_path / "absent.tgz", {"package.json": b"{}"})
    assert pc.audit_license(good, ROOT_LICENSE) == []
    assert "differs" in pc.audit_license(changed, ROOT_LICENSE)[0]
    assert "no 'LICENSE'" in pc.audit_license(absent, ROOT_LICENSE)[0]


def good_manifest() -> dict[str, object]:
    """A manifest satisfying every `dev-tools` rule.

    Returns:
        dict[str, object]: Parsed manifest.
    """
    return {
        "name": "@nredd/pi-dev-tools",
        "publishConfig": {"access": "public"},
        "license": "MIT",
        "dependencies": dict(DEV_TOOLS.runtime_dependencies),
        "peerDependencies": {"@earendil-works/pi-coding-agent": "*", "typebox": "*"},
        "pi": {"extensions": ["./src/index.ts"]},
    }


def test_audit_manifest_rejects_missing_publish_config() -> None:
    """A manifest with no `publishConfig` at all is not publishable."""
    manifest = good_manifest()
    del manifest["publishConfig"]
    problems = pc.audit_manifest(DEV_TOOLS, manifest, ["src/index.ts"])
    assert any("`publishConfig.access` must be `public`" in problem for problem in problems), problems


def test_audit_manifest_accepts_good() -> None:
    """The reference manifest has no findings."""
    assert pc.audit_manifest(DEV_TOOLS, good_manifest(), ["src/index.ts"]) == []


@pytest.mark.parametrize(
    ("mutation", "needle"),
    [
        ({"private": True}, "`private` must be absent or `false`"),
        ({"publishConfig": {"access": "restricted"}}, "`publishConfig.access` must be `public`"),
        ({"publishConfig": {}}, "`publishConfig.access` must be `public`"),
        ({"license": "ISC"}, "`license`"),
        ({"dependencies": {"typebox": "1.0.0"}}, "not a declared runtime dependency"),
        ({"dependencies": {"@nredd/pi-resource-sampler": "^0.1.0"}}, "must use the range '0.1.0'"),
        ({"dependencies": {"@nredd/pi-resource-sampler": "workspace:*"}}, "must use the range '0.1.0'"),
        (
            {"dependencies": {"@nredd/pi-resource-sampler": "file:../resource-sampler"}},
            "must use the range '0.1.0'",
        ),
        ({"dependencies": {}}, "declared runtime dependency '@nredd/pi-resource-sampler' is missing"),
        ({"optionalDependencies": {"@nredd/pi-session-kit": "*"}}, "`optionalDependencies`"),
        ({"peerDependencies": {"@nredd/pi-session-kit": "*"}}, "not a host module"),
        ({"peerDependencies": {"typebox": ">=1"}}, "must use the range '*'"),
        ({"pi": {"extensions": []}}, "`pi.extensions` is empty"),
        ({"pi": {"extensions": ["./src/missing.ts"]}}, "not in the tarball"),
        ({"name": "@nredd/other"}, "expected '@nredd/pi-dev-tools'"),
    ],
)
def test_audit_manifest_rejects(mutation: dict[str, object], needle: str) -> None:
    """Each independence or publication-safety rule is enforced.

    Parameters:
        mutation (dict[str, object]): Fields overriding the good manifest.
        needle (str): Substring a violation must contain.
    """
    problems = pc.audit_manifest(DEV_TOOLS, good_manifest() | mutation, ["src/index.ts"])
    assert any(needle in problem for problem in problems), problems


def test_audit_manifest_accepts_false_private() -> None:
    """An explicit false `private` value remains publishable."""
    assert pc.audit_manifest(DEV_TOOLS, good_manifest() | {"private": False}, ["src/index.ts"]) == []


@pytest.mark.parametrize(
    ("mutation", "field"),
    [
        ({"peerDependencies": []}, "peerDependencies"),
        ({"peerDependencies": "typebox"}, "peerDependencies"),
        ({"peerDependencies": {"typebox": 1}}, "peerDependencies.typebox"),
        ({"peerDependencies": None}, "peerDependencies"),
        ({"pi": None}, "pi"),
        ({"pi": "src/index.ts"}, "pi"),
        ({"pi": []}, "pi"),
        ({"pi": {"extensions": "./src/index.ts"}}, "pi.extensions"),
        ({"pi": {"extensions": [1]}}, "pi.extensions.0"),
        ({"pi": {"extensions": None}}, "pi.extensions"),
        ({"dependencies": []}, "dependencies"),
        ({"optionalDependencies": "x"}, "optionalDependencies"),
        ({"bundledDependencies": "yes"}, "bundledDependencies.list[str]"),
        ({"bundleDependencies": {"a": 1}}, "bundleDependencies.list[str]"),
        ({"private": "true"}, "private"),
        ({"private": None}, "private"),
        ({"publishConfig": "public"}, "publishConfig"),
        ({"publishConfig": {"access": True}}, "publishConfig.access"),
        ({"license": 1}, "license"),
        ({"name": 5}, "name"),
    ],
)
def test_audit_manifest_rejects_malformed_fields(mutation: dict[str, object], field: str) -> None:
    """A malformed audited field is a clear diagnostic, never a silent pass or a crash.

    Parameters:
        mutation (dict[str, object]): Malformed fields overriding the good manifest.
        field (str): Dotted field path the diagnostic must name.
    """
    problems = pc.audit_manifest(DEV_TOOLS, good_manifest() | mutation, ["src/index.ts"])
    assert any(f"`{field}`" in problem and "malformed" in problem for problem in problems), problems


@pytest.mark.parametrize("manifest", [[], "x", None, 3])
def test_audit_manifest_rejects_non_object(manifest: object) -> None:
    """A manifest that is not a JSON object is reported, not crashed on.

    Parameters:
        manifest (object): Non-object JSON value.
    """
    problems = pc.audit_manifest(DEV_TOOLS, manifest, ["src/index.ts"])
    assert any("malformed" in problem for problem in problems), problems


def test_audit_manifest_ignores_unaudited_npm_metadata() -> None:
    """Unknown or unaudited npm fields of any shape are explicitly ignored."""
    extra = {"scripts": 1, "keywords": "x", "files": {"a": 1}, "repository": [], "x-custom": None}
    assert pc.audit_manifest(DEV_TOOLS, good_manifest() | extra, ["src/index.ts"]) == []
    assert pc.audit_manifest(DEV_TOOLS, good_manifest() | {"bundledDependencies": []}, ["src/index.ts"]) == []
    assert any(
        "bundledDependencies" in p
        for p in pc.audit_manifest(
            DEV_TOOLS, good_manifest() | {"bundledDependencies": True}, ["src/index.ts"]
        )
    )


def test_audit_tarball_reports_unparseable_manifest(tmp_path: Path) -> None:
    """Invalid JSON in the packed manifest is a violation, not a traceback.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
    """
    tarball = make_tarball(tmp_path / "bad.tgz", {"LICENSE": ROOT_LICENSE, "package.json": b"{nope"})
    artifact = pc.PackedArtifact(
        DEV_TOOLS, tarball, "1.0.0", "sha512-x", "0" * 40, 1, ("LICENSE", "package.json")
    )
    problems = pc.audit_tarball(artifact, ROOT_LICENSE)
    assert any("`package.json` is not valid JSON" in problem for problem in problems), problems


@pytest.mark.parametrize(
    "contract",
    [*pc.CONTRACTS, pc.PRESET_CONTRACT, pc.COMPUTER_USE_CONTRACT, pc.SUBAGENTS_CONTRACT],
    ids=lambda c: c.directory,
)
def test_real_workspace_tarballs_pass_audit(
    contract: pc.PackageContract, tmp_path: Path, sandbox: pc.Sandbox
) -> None:
    """The real `npm pack` output of every workspace package satisfies the static audit.

    Parameters:
        contract (pc.PackageContract): Package to pack.
        tmp_path (Path): Pytest temporary directory.
        sandbox (pc.Sandbox): Scrubbed environment.
    """
    artifact = pc.pack(contract, tmp_path, sandbox)
    assert pc.audit_tarball(artifact, ROOT_LICENSE) == []
    assert (
        artifact.version
        == json.loads((pc.REPO_ROOT / "packages" / contract.directory / "package.json").read_text())[
            "version"
        ]
    )
    assert artifact.integrity.startswith("sha512-")


def test_pack_without_allowlist_is_rejected(tmp_path: Path, sandbox: pc.Sandbox) -> None:
    """The original leak: no `files` allowlist and no license ships tests and dev config.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
        sandbox (pc.Sandbox): Scrubbed environment.
    """
    source = tmp_path / "dev-tools"
    shutil.copytree(
        pc.REPO_ROOT / "packages" / "dev-tools",
        source,
        ignore=shutil.ignore_patterns("node_modules", "LICENSE"),
    )
    manifest = json.loads((source / "package.json").read_text())
    del manifest["files"]
    (source / "package.json").write_text(json.dumps(manifest))
    (tmp_path / "out").mkdir()
    artifact = pc.pack(DEV_TOOLS, tmp_path / "out", sandbox, source)
    problems = pc.audit_tarball(artifact, ROOT_LICENSE)
    assert "missing required file 'LICENSE'" in problems
    assert any("unexpected file 'test/" in p for p in problems)
    assert "unexpected file 'biome.json'" in problems
    assert "unexpected file 'tsconfig.json'" in problems


def test_install_alone_has_no_host_copy(tmp_path: Path, sandbox: pc.Sandbox) -> None:
    """A real tarball installs by itself: no host module, no lockfile extras.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
        sandbox (pc.Sandbox): Scrubbed environment.
    """
    artifact = pc.pack(DEV_TOOLS, tmp_path, sandbox)
    installed = pc.install_alone(artifact, sandbox, tmp_path / "project")
    assert (installed / "src" / "index.ts").is_file()
    assert not (tmp_path / "project" / "node_modules" / "@earendil-works").exists()
    assert not (tmp_path / "project" / "node_modules" / "typebox").exists()


def test_install_alone_rejects_extra_lockfile_package(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Dependency-free packages reject any extra install closure member.

    Parameters:
        tmp_path (Path): Temporary installation root.
        monkeypatch (pytest.MonkeyPatch): Subprocess substitution.
    """
    artifact = pc.PackedArtifact(DEV_TOOLS, tmp_path / "package.tgz", "1.0.0", "sha512-x", "0" * 40, 1, ())

    def fake_run(_cmd: list[object], *, cwd: Path, **_kwargs: object) -> None:
        """Write an install with an unrelated package.

        Parameters:
            _cmd (list[object]): Ignored subprocess command.
            cwd (Path): Consumer project root.
            **_kwargs (object): Ignored subprocess keyword arguments.
        """
        for name in ("@nredd/pi-dev-tools", "left-pad"):
            (cwd / "node_modules" / name).mkdir(parents=True, exist_ok=True)
        (cwd / "package-lock.json").write_text(
            json.dumps(
                {
                    "packages": {
                        "": {},
                        "node_modules/@nredd/pi-dev-tools": {"dependencies": {"left-pad": "1.0.0"}},
                        "node_modules/left-pad": {},
                    }
                }
            )
        )

    monkeypatch.setattr(pc, "run", fake_run)
    with pytest.raises(pc.ContractError, match="dependencies differ"):
        pc.install_alone(artifact, pc.Sandbox(tmp_path / "sandbox", pc.locate_tools()), tmp_path / "project")


def test_parse_events() -> None:
    """Strict JSONL framing: blank lines skipped, junk and non-objects rejected."""
    assert pc.parse_events('{"a": 1}\n\n{"b": 2}\n') == ({"a": 1}, {"b": 2})
    with pytest.raises(pc.ContractError, match="Non-JSON"):
        pc.parse_events("not json\n")
    with pytest.raises(pc.ContractError, match="Non-object"):
        pc.parse_events("[1]\n")


def test_pirun_helpers() -> None:
    """Tool results and assistant messages are extracted from event streams."""
    events = (
        {
            "type": "tool_execution_end",
            "toolName": "t",
            "result": {"content": [{"type": "text", "text": "hi"}]},
        },
        {"type": "tool_execution_end", "toolName": "u", "result": {"content": []}},
        {"type": "message_end", "message": {"role": "assistant", "model": "m"}},
        {"type": "message_end", "message": {"role": "user"}},
    )
    result = pc.PiRun(0, events, "", "")
    assert [pc.tool_text(r) for r in result.tool_results("t")] == ["hi"]
    assert result.assistant_messages() == [{"role": "assistant", "model": "m"}]


def test_require_tools_flags_missing_and_sibling() -> None:
    """The package's own tools must be declared and a sibling's must not be."""
    result = pc.PiRun(0, (), "", "")
    siblings = tuple(c for c in pc.CONTRACTS if c is not DEV_TOOLS)
    pc.require_tools(
        result, DEV_TOOLS, siblings, [fp.RecordedRequest("m", ("system",), ("read", "git_status"))]
    )
    with pytest.raises(pc.ContractError, match="declared"):
        pc.require_tools(result, DEV_TOOLS, siblings, [fp.RecordedRequest("m", ("system",), ("read",))])
    with pytest.raises(pc.ContractError, match="sibling tools"):
        pc.require_tools(
            result,
            DEV_TOOLS,
            siblings,
            [fp.RecordedRequest("m", ("system",), ("git_status", "monitor_start"))],
        )
    with pytest.raises(pc.ContractError, match="no request"):
        pc.require_tools(result, DEV_TOOLS, siblings, [])


def post(url: str, body: dict[str, object], path: str = "/chat/completions") -> str:
    """POST JSON to the provider and return the SSE body.

    Parameters:
        url (str): Provider base URL.
        body (dict[str, object]): Chat-completions request.
        path (str): Path under the base URL.

    Returns:
        str: Decoded response.
    """
    request = urllib.request.Request(
        f"{url}{path}",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return response.read().decode()


def test_faux_provider_replays_script_and_records_requests() -> None:
    """Turns are chosen by assistant-message count; the last repeats; requests are recorded."""
    tool = {"type": "function", "function": {"name": "git_status"}}
    with fp.FauxProvider([fp.ToolStep("git_status", {"a": 1}), fp.TextStep("done")]) as provider:
        first = post(provider.base_url, {"model": "m", "messages": [{"role": "user"}], "tools": [tool]})
        second = post(
            provider.base_url,
            {
                "model": "m",
                "messages": [{"role": "user"}, {"role": "assistant"}, {"role": "tool"}],
                "tools": [tool],
            },
        )
        third = post(provider.base_url, {"model": "m", "messages": [{"role": "assistant"}] * 5})
    assert '"name": "git_status"' in first
    assert '\\"a\\": 1' in first
    assert '"finish_reason": "tool_calls"' in first
    assert '"content": "done"' in second
    assert second.endswith("data: [DONE]\n\n")
    assert '"content": "done"' in third
    assert [r.model for r in provider.requests] == ["m", "m", "m"]
    assert provider.requests[0].tools == ("git_status",)
    assert provider.requests[1].roles == ("user", "assistant", "tool")


def test_faux_provider_rejects_empty_script_and_unknown_path() -> None:
    """An empty script is a caller bug; other paths 404."""
    with pytest.raises(ValueError, match="at least one step"):
        fp.FauxProvider([])
    with fp.FauxProvider([fp.TextStep("x")]) as provider, pytest.raises(urllib.error.HTTPError) as info:
        post(provider.base_url, {}, "/nope")
    assert info.value.code == 404


def test_models_json_registers_provider() -> None:
    """The rendered `models.json` carries a dummy key and the requested models."""
    document = json.loads(fp.models_json("http://127.0.0.1:1/v1", "local", ["m", "n"]))
    provider = document["providers"]["local"]
    assert provider["api"] == "openai-completions"
    assert provider["apiKey"] == fp.PROVIDER_API_KEY
    assert [m["id"] for m in provider["models"]] == ["m", "n"]


def test_main_refuses_nonempty_work_dir(tmp_path: Path) -> None:
    """A reused scratch directory is a usage error, reported before any work.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
    """
    (tmp_path / "stale").write_text("x")
    assert pc.main(["--work-dir", str(tmp_path)]) == 2


INTEGRITY = "sha512-" + "A" * 86 + "=="


PINNED = {
    "package": pc.STOCK_PI_PACKAGE,
    "version": pc.STOCK_PI_VERSION,
    "integrity": pc.STOCK_PI_INTEGRITY,
}
GOOD_ENTRY: dict[str, object] = {
    "version": "0.3.0",
    "tarball": "nredd-pi-dev-tools-0.3.0.tgz",
    "integrity": INTEGRITY,
    "shasum": "a" * 40,
    "size": 1234,
    "files": ["LICENSE", "package.json"],
    "evidence": {
        "tool": "git_status",
        "untracked": ["untracked.txt"],
        "failure_path": "not a repo",
        **RESOURCE_EVIDENCE,
    },
}


def good_report(packages: dict[str, object] | None = None) -> dict[str, object]:
    """Build a report that satisfies every schema rule.

    Parameters:
        packages (dict[str, object] | None): Package entries; defaults to the dev-tools entry.

    Returns:
        dict[str, object]: Raw report as `run_gate` assembles it.
    """
    return {
        "stock_pi": PINNED,
        "node": "v26.12.0",
        "npm": "11.20.0",
        "license_sha256": "b" * 64,
        "packages": packages or {"@nredd/pi-dev-tools": GOOD_ENTRY},
    }


def with_entry(**changes: object) -> dict[str, object]:
    """Return `good_report()` with fields of the dev-tools package entry replaced.

    Parameters:
        **changes (object): Entry fields to replace.

    Returns:
        dict[str, object]: Raw report.
    """
    return good_report({"@nredd/pi-dev-tools": GOOD_ENTRY | changes})


def test_validate_report_accepts_good_and_round_trips() -> None:
    """A well-formed report keeps its meaning and key order through serialization."""
    report = pc.validate_report(good_report())
    assert json.loads(pc.serialize_report(report)) == good_report()
    assert list(json.loads(pc.serialize_report(report))) == list(good_report())


def test_validate_report_accepts_every_scenario_evidence() -> None:
    """Each package takes only its own evidence shape."""
    packages: dict[str, object] = {
        "@nredd/pi-dev-tools": GOOD_ENTRY,
        "@nredd/pi-session-kit": GOOD_ENTRY
        | {
            "tarball": "nredd-pi-session-kit-0.3.0.tgz",
            "evidence": {"tools": ["monitor_start", "monitor_read"], "monitor_line": "x", "stats_shards": 1},
        },
        "@nredd/pi-subscription-router": GOOD_ENTRY
        | {
            "tarball": "nredd-pi-subscription-router-0.3.0.tgz",
            "evidence": {"virtual_model": "router/default", "dispatched": "local/m"},
        },
    }
    assert len(pc.validate_report(good_report(packages)).packages) == 3


@pytest.mark.parametrize(
    ("raw", "needle"),
    [
        (with_entry(integrity="sha512-short"), "integrity"),
        (with_entry(integrity="sha1-" + "A" * 27), "integrity"),
        (with_entry(shasum="XYZ"), "shasum"),
        (with_entry(size=0), "size"),
        (with_entry(version="latest"), "version"),
        (with_entry(tarball="../evil.tgz"), "tarball"),
        (with_entry(tarball="nredd-pi-dev-tools-9.9.9.tgz"), "is not"),
        (with_entry(files=[]), "files"),
        (with_entry(files=["a", "a"]), "duplicate files"),
        (
            with_entry(
                evidence={"tool": "git_status", "untracked": [], "failure_path": "x", **RESOURCE_EVIDENCE}
            ),
            "untracked",
        ),
        (
            with_entry(
                evidence={"tool": "git_status", "untracked": ["a"], "failure_path": "", **RESOURCE_EVIDENCE}
            ),
            "failure_path",
        ),
        (
            with_entry(
                evidence={
                    "tool": "git_status",
                    "untracked": ["a"],
                    "failure_path": "x",
                    **RESOURCE_EVIDENCE,
                    "extra": 1,
                }
            ),
            "extra",
        ),
        (with_entry(evidence={"tool": "monitor_start"}), "evidence"),
        (
            with_entry(evidence={"virtual_model": "router/default", "dispatched": "local/m"}),
            "evidence",
        ),
    ],
)
def test_validate_report_rejects_malformed_identity_and_evidence(raw: dict[str, object], needle: str) -> None:
    """Bad artifact identity or evidence shapes fail at the serialization boundary.

    Parameters:
        raw (dict[str, object]): Report with one malformed field.
        needle (str): Substring the error must contain.
    """
    with pytest.raises(pc.ContractError, match="Report failed validation") as excinfo:
        pc.validate_report(raw)
    assert needle in str(excinfo.value)


@pytest.mark.parametrize(
    "changes",
    [
        {"node": "latest"},
        {"license_sha256": "abc"},
        {"packages": {}},
        {"unexpected": 1},
        {"stock_pi": PINNED | {"version": "1.3.1"}},
        {"stock_pi": PINNED | {"integrity": INTEGRITY}},
        {"packages": {"@nredd/pi-unknown": GOOD_ENTRY}},
    ],
)
def test_validate_report_rejects_malformed_top_level(changes: dict[str, object]) -> None:
    """Top-level identity, pins and package names are enforced.

    Parameters:
        changes (dict[str, object]): Top-level fields to corrupt.
    """
    with pytest.raises(pc.ContractError, match="Report failed validation"):
        pc.validate_report(good_report() | changes)


def test_evidence_typed_dicts_match_models() -> None:
    """The scenario return shapes and the validated models describe the same fields."""
    pairs = {
        pc.DevToolsEvidence: pc.DevToolsEvidenceModel,
        pc.SessionKitEvidence: pc.SessionKitEvidenceModel,
        pc.RouterEvidence: pc.RouterEvidenceModel,
    }
    for shape, model in pairs.items():
        assert set(shape.__annotations__) == set(model.model_fields)


def test_pack_rejects_digest_mismatch(tmp_path: Path, sandbox: pc.Sandbox) -> None:
    """`npm pack` identity that disagrees with the tarball bytes is rejected.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
        sandbox (pc.Sandbox): Scrubbed environment.
    """
    tarball = make_tarball(
        tmp_path / "fixture.tgz", {"package.json": json.dumps({"name": "x", "version": "1.0.0"}).encode()}
    )
    payload = tmp_path / "payload.json"
    payload.write_text(
        json.dumps(
            [
                {
                    "filename": "x-1.0.0.tgz",
                    "integrity": INTEGRITY,
                    "shasum": "a" * 40,
                    "files": [{"path": "package.json"}],
                }
            ]
        )
    )
    fake_npm = tmp_path / "npm"
    fake_npm.write_text(f'#!/bin/sh\ncp "{tarball}" "$5/x-1.0.0.tgz"\ncat "{payload}"\n')
    fake_npm.chmod(0o755)
    liar = pc.Sandbox(tmp_path / "liar", pc.Tools(sandbox.tools.node, fake_npm, sandbox.tools.git))
    (tmp_path / "out").mkdir()
    with pytest.raises(pc.ContractError, match="disagrees with the tarball bytes"):
        pc.pack(DEV_TOOLS, tmp_path / "out", liar, tmp_path)


def test_npm_pack_entry_rejects_malformed_identity() -> None:
    """Malformed `npm pack --json` identity never becomes an artifact."""
    with pytest.raises(ValidationError):
        pc.NpmPackEntry.model_validate({"filename": "x.tgz", "integrity": "nope", "shasum": "a", "files": []})


# --- stats protocol boundaries --------------------------------------------------------------------

MACHINE_ID = "123e4567-e89b-42d3-a456-426614174000"
MONTH = "2026-09"
SHARD_HASH = "a" * 64


def good_stats_manifest() -> dict[str, object]:
    """A manifest matching `docs/stats-snapshots.md`.

    Returns:
        dict[str, object]: Parsed manifest.
    """
    return {
        "version": 1,
        "machineId": MACHINE_ID,
        "label": "Pi machine",
        "exportedAt": 1_790_000_000_000,
        "shards": [{"month": MONTH, "file": f"{MONTH}-{SHARD_HASH}.json", "sha256": SHARD_HASH, "bytes": 10}],
    }


def test_stats_manifest_accepts_documented_shape() -> None:
    """The documented manifest validates and `parse_stats_json` round-trips it."""
    parsed = pc.parse_stats_json(pc.StatsManifest, json.dumps(good_stats_manifest()), "manifest")
    assert parsed.machineId == MACHINE_ID
    assert len(parsed.shards) == 1


@pytest.mark.parametrize(
    "mutation",
    [
        {"shards": MONTH},
        {"shards": "abc"},
        {"shards": {"a": 1}},
        {"shards": [MONTH]},
        {"shards": None},
        {"version": 2},
        {"version": True},
        {"version": "1"},
        {"machineId": "nope"},
        {"machineId": MACHINE_ID.upper()},
        {"label": ""},
        {"label": "x" * 1025},
        {"label": 3},
        {"exportedAt": 0},
        {"exportedAt": "1"},
        {"exportedAt": 1.5},
        {"extra": 1},
    ],
)
def test_stats_manifest_rejects_malformed(mutation: dict[str, object]) -> None:
    """Malformed manifest field types and values fail with a `ContractError`.

    Parameters:
        mutation (dict[str, object]): Fields overriding the good manifest.
    """
    with pytest.raises(pc.ContractError, match="Malformed stats manifest"):
        pc.parse_stats_json(pc.StatsManifest, json.dumps(good_stats_manifest() | mutation), "manifest")


@pytest.mark.parametrize(
    "ref",
    [
        {"month": "2026-13", "file": f"2026-13-{SHARD_HASH}.json", "sha256": SHARD_HASH, "bytes": 1},
        {"month": MONTH, "file": "other.json", "sha256": SHARD_HASH, "bytes": 1},
        {"month": MONTH, "file": f"{MONTH}-{SHARD_HASH}.json", "sha256": "A" * 64, "bytes": 1},
        {"month": MONTH, "file": f"{MONTH}-{SHARD_HASH}.json", "sha256": SHARD_HASH, "bytes": -1},
        {"month": MONTH, "file": f"{MONTH}-{SHARD_HASH}.json", "sha256": SHARD_HASH, "bytes": "1"},
        {
            "month": MONTH,
            "file": f"{MONTH}-{SHARD_HASH}.json",
            "sha256": SHARD_HASH,
            "bytes": 128 * 1024**2 + 1,
        },
        {"month": MONTH, "file": f"{MONTH}-{SHARD_HASH}.json", "sha256": SHARD_HASH},
        {"month": MONTH, "file": f"../{MONTH}-{SHARD_HASH}.json", "sha256": SHARD_HASH, "bytes": 1},
    ],
)
def test_stats_manifest_rejects_malformed_shard_reference(ref: dict[str, object]) -> None:
    """Shard references enforce month, file/hash identity, and byte bounds.

    Parameters:
        ref (dict[str, object]): Malformed shard reference.
    """
    raw = json.dumps(good_stats_manifest() | {"shards": [ref]})
    with pytest.raises(pc.ContractError, match="Malformed stats manifest"):
        pc.parse_stats_json(pc.StatsManifest, raw, "manifest")


def test_stats_manifest_rejects_duplicate_months() -> None:
    """Each manifest references exactly one shard per month."""
    ref = {"month": MONTH, "file": f"{MONTH}-{SHARD_HASH}.json", "sha256": SHARD_HASH, "bytes": 10}
    raw = json.dumps(good_stats_manifest() | {"shards": [ref, ref]})
    with pytest.raises(pc.ContractError, match="duplicate month"):
        pc.parse_stats_json(pc.StatsManifest, raw, "manifest")


@pytest.mark.parametrize("raw", ["", "not json", "[]", "null", '"x"', "1"])
def test_stats_json_rejects_non_objects(raw: str) -> None:
    """Non-object and unparseable stdout is a `ContractError`.

    Parameters:
        raw (str): Raw stdout text.
    """
    with pytest.raises(pc.ContractError, match="Malformed stats export"):
        pc.parse_stats_json(pc.StatsExportResult, raw, "export")


@pytest.mark.parametrize(
    "raw",
    [
        {"machineId": MACHINE_ID},
        {"machineId": MACHINE_ID, "snapshotDir": ""},
        {"machineId": MACHINE_ID, "snapshotDir": 1},
        {"machineId": "x", "snapshotDir": "/a"},
        {"machineId": MACHINE_ID, "snapshotDir": "/a", "extra": 1},
    ],
)
def test_stats_export_result_rejects_malformed(raw: dict[str, object]) -> None:
    """The export response keeps exactly `machineId` and `snapshotDir`.

    Parameters:
        raw (dict[str, object]): Malformed response.
    """
    with pytest.raises(pc.ContractError, match="Malformed stats export"):
        pc.parse_stats_json(pc.StatsExportResult, json.dumps(raw), "export")


GOOD_IMPORT = {"imported": 1, "retained": 0, "problems": [], "importedAt": 1_790_000_000_000}


def test_stats_import_result_accepts_documented_shape() -> None:
    """The documented import response validates."""
    parsed = pc.parse_stats_json(pc.StatsImportResult, json.dumps(GOOD_IMPORT), "import")
    assert (parsed.imported, parsed.retained, parsed.problems) == (1, 0, [])


@pytest.mark.parametrize(
    "mutation",
    [
        {"imported": "1"},
        {"imported": True},
        {"imported": 1.5},
        {"imported": -1},
        {"retained": "0"},
        {"problems": "none"},
        {"problems": [1]},
        {"problems": None},
        {"importedAt": "x"},
        {"importedAt": -1},
        {"extra": 1},
    ],
)
def test_stats_import_result_rejects_malformed(mutation: dict[str, object]) -> None:
    """String counts, non-list problems and other type confusion are rejected.

    Parameters:
        mutation (dict[str, object]): Fields overriding the good response.
    """
    with pytest.raises(pc.ContractError, match="Malformed stats import"):
        pc.parse_stats_json(pc.StatsImportResult, json.dumps(GOOD_IMPORT | mutation), "import")


def test_stats_import_result_missing_field() -> None:
    """A response lacking a field fails instead of defaulting."""
    raw = {k: v for k, v in GOOD_IMPORT.items() if k != "problems"}
    with pytest.raises(pc.ContractError, match="Malformed stats import"):
        pc.parse_stats_json(pc.StatsImportResult, json.dumps(raw), "import")


def write_stats_session(agent_dir: Path) -> None:
    """Write one real-format Pi session with a single assistant usage record.

    Parameters:
        agent_dir (Path): Agent directory receiving `sessions/`.
    """
    path = agent_dir / "sessions" / "project" / "s.jsonl"
    path.parent.mkdir(parents=True)
    header = {
        "type": "session",
        "version": 3,
        "id": "fixture-session",
        "timestamp": "2026-09-30T12:00:00.000Z",
    }
    usage = {
        "input": 5,
        "output": 2,
        "cacheRead": 0,
        "cacheWrite": 0,
        "totalTokens": 7,
        "cost": {"total": 0.01},
    }
    assistant = {
        "type": "message",
        "id": "entry-1",
        "timestamp": "2026-09-30T12:00:01.000Z",
        "message": {
            "role": "assistant",
            "content": [{"type": "text", "text": "hi"}],
            "api": "x",
            "provider": "local",
            "model": "m",
            "usage": usage,
            "stopReason": "stop",
            "timestamp": 1_790_000_001_000,
        },
    }
    path.write_text("\n".join(json.dumps(line) for line in (header, assistant)) + "\n")


DIST_ARTIFACT = pc.REPO_ROOT / "packages" / "session-kit" / "dist" / "pi-stats-export.mjs"


def test_standalone_stats_artifact_over_real_fixture_session(tmp_path: Path, sandbox: pc.Sandbox) -> None:
    """The exact built bytes export and import a real-format session from an isolated directory.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
        sandbox (pc.Sandbox): Scrubbed environment.
    """
    write_stats_session(sandbox.agent_dir)
    copied = tmp_path / "standalone" / "pi-stats-export.mjs"
    copied.parent.mkdir()
    copied.write_bytes(DIST_ARTIFACT.read_bytes())
    result = pc.run(
        [
            sandbox.tools.node,
            copied,
            "export",
            "--agent-dir",
            sandbox.agent_dir,
            "--output",
            tmp_path / "out",
        ],
        env=sandbox.env(),
        cwd=tmp_path,
        timeout=60,
    )
    exported = pc.parse_stats_json(pc.StatsExportResult, result.stdout, "export")
    manifest = pc.inspect_stats_snapshot(Path(exported.snapshotDir), exported.machineId, [])
    assert len(manifest.shards) == 1
    assert [p.name for p in copied.parent.iterdir()] == ["pi-stats-export.mjs"]


def test_standalone_stats_artifact_cannot_reach_package_siblings(tmp_path: Path, sandbox: pc.Sandbox) -> None:
    """A relative import into the package passes in place but fails in the isolated copy.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
        sandbox (pc.Sandbox): Scrubbed environment.
    """
    package = tmp_path / "package"
    (package / "src").mkdir(parents=True)
    (package / "dist").mkdir()
    (package / "src" / "index.ts").write_text("export const x = 1;\n")
    tampered = b'import "../src/index.ts";\n' + DIST_ARTIFACT.read_bytes()
    (package / "dist" / "pi-stats-export.mjs").write_bytes(tampered)
    write_stats_session(sandbox.agent_dir)
    in_place = pc.run(
        [
            sandbox.tools.node,
            package / "dist" / "pi-stats-export.mjs",
            "export",
            "--agent-dir",
            sandbox.agent_dir,
            "--output",
            tmp_path / "out",
        ],
        env=sandbox.env(),
        cwd=tmp_path,
        timeout=60,
        check=False,
    )
    assert in_place.returncode == 0, in_place.stderr
    with pytest.raises(pc.ContractError, match="exited"):
        pc.exercise_stats_artifact(sandbox.tools.node, tampered, sandbox.agent_dir, tmp_path / "work")


def test_tool_text_rejects_malformed_result() -> None:
    """Malformed Pi tool results are a `ContractError`, not a `KeyError`."""
    with pytest.raises(pc.ContractError, match="Malformed tool result"):
        pc.tool_text({"toolName": "t", "result": {"content": "oops"}})
    with pytest.raises(pc.ContractError, match="Malformed tool result"):
        pc.tool_text({"toolName": "t"})


def test_read_lockfile_rejects_malformed(tmp_path: Path) -> None:
    """A lockfile that is not the npm shape is a `ContractError`.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
    """
    path = tmp_path / "package-lock.json"
    for text in ("{nope", "[]", '{"packages": []}', '{"packages": {"": {"version": 1}}}', "{}"):
        path.write_text(text)
        with pytest.raises(pc.ContractError, match="lockfile"):
            pc.read_lockfile(path)
    path.write_text('{"packages": {"": {}, "node_modules/x": {"version": "1.0.0", "other": []}}}')
    assert set(pc.read_lockfile(path).packages) == {"", "node_modules/x"}


@pytest.mark.parametrize(
    "body",
    [
        b"not json",
        b"[]",
        b"null",
        b'{"model": "m", "messages": {}}',
        b'{"model": "m", "messages": [null]}',
        b'{"model": "m", "messages": [{"role": 1}]}',
        b'{"model": "m", "tools": [{}]}',
        b'{"model": "m", "tools": [{"function": null}]}',
        b'{"model": "m", "tools": "x"}',
        b'{"messages": []}',
        b'{"model": 3}',
    ],
)
def test_faux_provider_answers_malformed_request_with_400(body: bytes) -> None:
    """Malformed consumed request shapes get an HTTP diagnostic and are never recorded.

    Parameters:
        body (bytes): Raw request body.
    """
    with fp.FauxProvider([fp.TextStep("x")]) as provider:
        request = urllib.request.Request(f"{provider.base_url}/chat/completions", data=body, method="POST")
        with pytest.raises(urllib.error.HTTPError) as info:
            urllib.request.urlopen(request, timeout=10)
        assert info.value.code == 400
        assert "malformed chat request" in info.value.reason
        assert provider.requests == []


def test_faux_provider_rejects_bad_content_length() -> None:
    """A non-numeric `Content-Length` is a 400, not a dropped connection."""
    with fp.FauxProvider([fp.TextStep("x")]) as provider:
        request = urllib.request.Request(
            f"{provider.base_url}/chat/completions", data=b"{}", headers={"content-length": "abc"}
        )
        with pytest.raises(urllib.error.HTTPError) as info:
            urllib.request.urlopen(request, timeout=10)
        assert info.value.code == 400


@pytest.mark.parametrize(
    "event",
    [
        {"type": "message_end", "message": None},
        {"type": "message_end", "message": []},
        {"type": "message_end"},
        {"type": "message_end", "message": {"role": 1}},
        {"type": "message_end", "message": {"role": "assistant", "provider": 3}},
    ],
)
def test_assistant_messages_rejects_malformed_events(event: dict[str, object]) -> None:
    """A `message_end` without an object message is a diagnostic, not an `AttributeError`.

    Parameters:
        event (dict[str, object]): Malformed event.
    """
    with pytest.raises(pc.ContractError, match="Malformed `message_end`"):
        pc.PiRun(0, (event,), "", "").assistant_messages()


def test_single_tool_result_and_is_error() -> None:
    """Exactly one tool record is required and `isError` must be a real boolean."""
    ok = {"type": "tool_execution_end", "toolName": "t", "isError": False, "result": {"content": []}}
    run = pc.PiRun(0, (ok,), "", "")
    assert run.single_tool_result("t") is ok
    assert pc.tool_is_error(ok) is False
    with pytest.raises(pc.ContractError, match="exactly one `u`"):
        run.single_tool_result("u")
    with pytest.raises(pc.ContractError, match="exactly one `t`"):
        pc.PiRun(0, (ok, ok), "", "").single_tool_result("t")
    for bad in ({"toolName": "t"}, {"toolName": "t", "isError": "false"}, {"toolName": "t", "isError": None}):
        with pytest.raises(pc.ContractError, match="Malformed tool result"):
            pc.tool_is_error(bad)


def preset_manifest() -> dict[str, object]:
    """A manifest satisfying the preset contract, including its multi-license expression.

    Returns:
        dict[str, object]: Parsed manifest.
    """
    return good_manifest() | {
        "name": "@nredd/pi-preset",
        "dependencies": {},
        "license": "MIT AND Apache-2.0 AND CC-BY-SA-4.0",
        "peerDependencies": {"@earendil-works/pi-coding-agent": "*", "@earendil-works/pi-tui": "*"},
        "pi": {"extensions": ["./extensions/expanded-footer.ts"]},
    }


def test_preset_contract_accounts_for_separately_licensed_assets() -> None:
    """The preset must declare the full license expression; plugins stay MIT-only."""
    files = ["extensions/expanded-footer.ts"]
    assert pc.audit_manifest(pc.PRESET_CONTRACT, preset_manifest(), files) == []
    mit_only = pc.audit_manifest(pc.PRESET_CONTRACT, preset_manifest() | {"license": "MIT"}, files)
    assert any("MIT AND Apache-2.0 AND CC-BY-SA-4.0" in problem for problem in mit_only), mit_only
    leaked = pc.audit_manifest(DEV_TOOLS, good_manifest() | {"license": preset_manifest()["license"]}, files)
    assert any("`license` must be 'MIT'" in problem for problem in leaked), leaked


def subagents_manifest() -> dict[str, Any]:
    """Return the real workspace manifest, which the contract must accept as published.

    Returns:
        dict[str, Any]: Parsed `packages/subagents/package.json`.
    """
    return json.loads((pc.REPO_ROOT / "packages" / "subagents" / "package.json").read_text())


def test_subagents_contract_declares_its_runtime_dependencies_and_peer_floor() -> None:
    """Real dependencies and the fork's `>=1.1.0` peer floor are explicit allowances, not silent."""
    files = ["src/index.ts"]
    contract = pc.SUBAGENTS_CONTRACT
    assert pc.audit_manifest(contract, subagents_manifest(), files) == []
    # The plugin default still rejects the same manifest: the allowance is per contract.
    plugin = pc.audit_manifest(DEV_TOOLS, subagents_manifest() | {"name": DEV_TOOLS.name}, files)
    assert any("dependency 'croner' is not a declared" in problem for problem in plugin), plugin
    assert any("peer '@earendil-works/pi-ai' must use the range '*'" in problem for problem in plugin), plugin
    manifest = subagents_manifest()
    undeclared = pc.audit_manifest(
        contract, manifest | {"dependencies": {**manifest["dependencies"], "left-pad": "^1.0.0"}}, files
    )
    assert any("dependency 'left-pad' is not a declared" in problem for problem in undeclared), undeclared
    drifted = pc.audit_manifest(contract, manifest | {"dependencies": {"croner": "^9.0.0"}}, files)
    assert any("'croner' must use the range '^10.0.1'" in problem for problem in drifted), drifted
    assert any("runtime dependency 'nanoid' is missing" in problem for problem in drifted), drifted
    star = {**manifest["peerDependencies"], "@earendil-works/pi-tui": "*"}
    loose = pc.audit_manifest(contract, manifest | {"peerDependencies": star}, files)
    assert any("must use the range '>=1.1.0'" in problem for problem in loose), loose


def test_declared_dependencies_may_be_imported_and_nothing_else() -> None:
    """The import audit admits a contract's declared dependencies, and only those."""
    found = pc.FileImports(specifiers=["croner", "nanoid", "left-pad", "croner/sub"], diagnostics=[])
    problems = pc.classify_imports(
        "src/a.ts", found, ["src/a.ts"], [name for name, _ in pc.SUBAGENTS_CONTRACT.runtime_dependencies]
    )
    assert len(problems) == 1, problems
    assert "left-pad" in problems[0]
    assert len(pc.classify_imports("src/a.ts", found, ["src/a.ts"])) == 4


def licensed_artifact(
    tmp_path: Path, contract: pc.PackageContract, license_bytes: bytes
) -> pc.PackedArtifact:
    """Build a tarball whose only content of interest is its `LICENSE`.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
        contract (pc.PackageContract): Contract the artifact claims.
        license_bytes (bytes): Packed `LICENSE`.

    Returns:
        pc.PackedArtifact: Artifact over that tarball.
    """
    tarball = make_tarball(tmp_path / "pkg.tgz", {"LICENSE": license_bytes, "package.json": b"{}"})
    return pc.PackedArtifact(contract, tarball, "1.0.0", "sha512-x", "0" * 40, 1, ("LICENSE", "package.json"))


def test_audit_tarball_license_source_follows_own_license(tmp_path: Path) -> None:
    """`own_license` swaps the expected `LICENSE` to the workspace's; a plugin still wants the root one.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
    """
    own = (pc.REPO_ROOT / "packages" / "subagents" / "LICENSE").read_bytes()
    assert own != ROOT_LICENSE
    assert b"tintinweb" in own
    with_root = licensed_artifact(tmp_path, pc.SUBAGENTS_CONTRACT, ROOT_LICENSE)
    assert any("differs from the expected" in p for p in pc.audit_tarball(with_root, ROOT_LICENSE))
    with_own = licensed_artifact(tmp_path, pc.SUBAGENTS_CONTRACT, own)
    assert not any("`LICENSE`" in p for p in pc.audit_tarball(with_own, ROOT_LICENSE))
    plugin_own = licensed_artifact(tmp_path, DEV_TOOLS, own)
    assert any("differs from the expected" in p for p in pc.audit_tarball(plugin_own, ROOT_LICENSE))
    plugin_root = licensed_artifact(tmp_path, DEV_TOOLS, ROOT_LICENSE)
    assert not any("`LICENSE`" in p for p in pc.audit_tarball(plugin_root, ROOT_LICENSE))


def test_subagents_pack_matches_contract(tmp_path: Path, sandbox: pc.Sandbox) -> None:
    """`npm pack` of the workspace ships exactly what the contract enumerates, nothing more.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
        sandbox (pc.Sandbox): Scrubbed environment.
    """
    contract = pc.SUBAGENTS_CONTRACT
    artifact = pc.pack(contract, tmp_path, sandbox)
    assert set(contract.required) <= set(artifact.files)
    assert pc.audit_files(contract, artifact.files) == []
    source = pc.REPO_ROOT / "packages" / "subagents"
    on_disk = {path.relative_to(source).as_posix() for path in (source / "src").rglob("*") if path.is_file()}
    assert {name for name in artifact.files if name.startswith("src/")} == on_disk
    assert set(artifact.files) - on_disk == {"LICENSE", "README.md", "package.json"}
    assert not any(name.startswith(("test/", "docs/", "examples/", "media/")) for name in artifact.files)


def test_subagents_is_a_registry_dependent_contract_outside_the_hermetic_set() -> None:
    """The hermetic `CONTRACTS` target must not try to install it offline; the release gate does."""
    assert pc.SUBAGENTS_CONTRACT not in pc.CONTRACTS
    assert "subagents" not in pc.SCENARIOS


def test_preset_is_not_a_standalone_plugin_contract() -> None:
    """The standalone gate keeps exactly its three plugins; the preset is consumed by the fork gate."""
    assert [c.directory for c in pc.CONTRACTS] == ["dev-tools", "session-kit", "subscription-router"]
    assert pc.PRESET_CONTRACT not in pc.CONTRACTS
    assert set(pc.SCENARIOS) == {c.directory for c in pc.CONTRACTS}


@pytest.mark.parametrize(
    "files",
    [
        ["LICENSE", "package.json", "README.md"],
        list(pc.PRESET_CONTRACT.required[:-1]),
    ],
)
def test_preset_audit_requires_notice_and_license_texts(files: list[str]) -> None:
    """Dropping `NOTICE.md`, a license text or a theme is a missing-file violation.

    Parameters:
        files (list[str]): File list lacking required content.
    """
    problems = pc.audit_files(pc.PRESET_CONTRACT, files)
    assert any("missing required file" in problem for problem in problems), problems


def test_preset_audit_rejects_unlisted_files() -> None:
    """Tests, fixtures and config do not ship in the preset tarball."""
    problems = pc.audit_files(pc.PRESET_CONTRACT, [*pc.PRESET_CONTRACT.required, "test/x.ts", "biome.json"])
    assert "unexpected file 'test/x.ts'" in problems
    assert "unexpected file 'biome.json'" in problems


def chat(role: str, text: str | list[dict[str, object]] | None) -> dict[str, object]:
    """Build one chat message.

    Parameters:
        role (str): Message role.
        text (str | list[dict[str, object]] | None): Content, a list of parts, or `None`.

    Returns:
        dict[str, object]: Message.
    """
    return {"role": role, "content": text}


def test_faux_routes_pick_a_script_by_user_marker_and_index_it_independently() -> None:
    """A marked conversation gets its own script and turn indexing; others keep the default."""
    routes = [fp.Route("MARK-A", [fp.TextStep("route a")]), fp.Route("MARK-B", [fp.TextStep("route b")])]
    tool = {"type": "function", "function": {"name": "git_log"}}
    with fp.FauxProvider([fp.ToolStep("Agent"), fp.TextStep("parent done")], routes) as provider:
        parent_first = post(
            provider.base_url,
            {"model": "m", "messages": [chat("system", "S"), chat("user", "go")], "tools": []},
        )
        child = post(
            provider.base_url,
            {
                "model": "m",
                "messages": [
                    chat("system", "child system"),
                    chat("user", [{"type": "text", "text": "MARK-B x"}]),
                ],
                "tools": [tool],
            },
        )
        parent_second = post(
            provider.base_url,
            {
                "model": "m",
                "messages": [
                    chat("system", "S"),
                    chat("user", "go"),
                    chat("assistant", None),
                    chat("tool", "tool output that says MARK-A"),
                ],
            },
        )
    assert '"name": "Agent"' in parent_first
    assert '"content": "route b"' in child
    assert '"content": "parent done"' in parent_second
    first, second, third = provider.requests
    assert (first.route, second.route, third.route) == (None, "MARK-B", None)
    assert second.tools == ("git_log",)
    assert second.system == "child system"
    assert third.roles == ("system", "user", "assistant", "tool")


def test_faux_records_tool_results_in_order() -> None:
    """`tool` messages (string or parts) are recorded as text, in order, for later assertions."""
    with fp.FauxProvider([fp.TextStep("x")]) as provider:
        post(
            provider.base_url,
            {
                "model": "m",
                "messages": [
                    chat("user", "hi"),
                    chat("tool", "first"),
                    chat("tool", [{"type": "text", "text": "sec"}, {"type": "text", "text": "ond"}]),
                    chat("assistant", None),
                ],
            },
        )
    assert provider.requests[0].tool_results == ("first", "second")


def test_faux_routes_ignore_markers_outside_user_messages() -> None:
    """Only user text selects a route: tool output and assistant text echoing it must not."""
    with fp.FauxProvider([fp.TextStep("default")], [fp.Route("MARK", [fp.TextStep("routed")])]) as provider:
        body = post(
            provider.base_url,
            {"model": "m", "messages": [chat("user", "hi"), chat("assistant", "MARK"), chat("tool", "MARK")]},
        )
    assert '"content": "default"' in body
    assert provider.requests[0].route is None


def test_faux_routes_first_matching_route_wins() -> None:
    """With two markers present, routes are tried in the order given."""
    routes = [fp.Route("ONE", [fp.TextStep("one")]), fp.Route("TWO", [fp.TextStep("two")])]
    with fp.FauxProvider([fp.TextStep("default")], routes) as provider:
        body = post(provider.base_url, {"model": "m", "messages": [chat("user", "TWO then ONE")]})
    assert '"content": "one"' in body


def test_faux_routes_reject_bad_definitions() -> None:
    """Empty markers, empty scripts and duplicate markers are caller bugs."""
    with pytest.raises(ValueError, match="marker"):
        fp.Route("", [fp.TextStep("x")])
    with pytest.raises(ValueError, match="at least one step"):
        fp.Route("M", [])
    with pytest.raises(ValueError, match="duplicate route markers"):
        fp.FauxProvider(
            [fp.TextStep("x")], [fp.Route("M", [fp.TextStep("a")]), fp.Route("M", [fp.TextStep("b")])]
        )


@pytest.mark.parametrize(
    "content",
    [5, {"text": "x"}, [5], [{"text": 3}], [None]],
)
def test_faux_provider_rejects_malformed_message_content(content: object) -> None:
    """Newly consumed `messages[].content` is validated: a mistyped value is a 400, never recorded.

    Parameters:
        content (object): Malformed content value.
    """
    body = json.dumps({"model": "m", "messages": [{"role": "user", "content": content}]}).encode()
    with fp.FauxProvider([fp.TextStep("x")]) as provider:
        request = urllib.request.Request(f"{provider.base_url}/chat/completions", data=body, method="POST")
        with pytest.raises(urllib.error.HTTPError) as info:
            urllib.request.urlopen(request, timeout=10)
        assert info.value.code == 400
        assert provider.requests == []


def test_faux_provider_records_system_and_developer_text() -> None:
    """The recorded `system` text joins `system` and `developer` messages in order."""
    with fp.FauxProvider([fp.TextStep("x")]) as provider:
        post(
            provider.base_url,
            {
                "model": "m",
                "messages": [chat("developer", "D"), chat("system", [{"type": "text", "text": "S"}])],
            },
        )
    assert provider.requests[0].system == "D\nS"


def test_contracts_are_hashable() -> None:
    """Dependency allowances are tuples, so every contract can key a set or dict."""
    assert len({*pc.CONTRACTS, pc.PRESET_CONTRACT, pc.COMPUTER_USE_CONTRACT, pc.SUBAGENTS_CONTRACT}) == 6


# --- scenario_subagents and the registry branch of install_alone ------------------------------------

ALL_SUBAGENT_TOOLS = sorted(pc.SUBAGENTS_CONTRACT.exposes_tools)


class StubProvider:
    """Stand-in for `FauxProvider` that records nothing and reports fixed requests."""

    def __init__(self, tools: list[str]) -> None:
        """Record one fake model request offering `tools`, or none.

        Parameters:
            tools (list[str]): tool names the fake request offers; empty means no request.
        """
        self.requests = [fp.RecordedRequest("m", ("user",), tuple(tools), "", route=None)] if tools else []

    def __enter__(self) -> StubProvider:
        """Enter the context like `FauxProvider`.

        Returns:
            StubProvider: this stub.
        """
        return self

    def __exit__(self, *exc: object) -> None:
        """Exit the context like `FauxProvider`, suppressing nothing.

        Parameters:
            *exc (object): exception type, value and traceback, ignored.
        """


def agent_record(text: str, *, is_error: bool = False) -> dict[str, Any]:
    """Build a `tool_execution_end` event for `Agent`.

    Parameters:
        text (str): Result text.
        is_error (bool): Mark the result as an error.

    Returns:
        dict[str, Any]: The event.
    """
    return {
        "type": "tool_execution_end",
        "toolName": "Agent",
        "isError": is_error,
        "result": {"content": [{"type": "text", "text": text}]},
    }


def run_subagents_scenario(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    tools: list[str],
    result: pc.PiRun,
) -> pc.SubagentsEvidence:
    """Run `scenario_subagents` against a faked Pi and provider.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
        monkeypatch (pytest.MonkeyPatch): Patches `run_pi` and the context's provider.
        tools (list[str]): Tools the parent request declares.
        result (pc.PiRun): What the faked `pi` run returns.

    Returns:
        pc.SubagentsEvidence: The scenario's evidence.
    """
    monkeypatch.setattr(pc, "run_pi", lambda *args, **kwargs: result)
    root = Path(tempfile.mkdtemp(dir=tmp_path))
    ctx = pc.Context(
        Path("pi"),
        pc.Sandbox(root / "sandbox", pc.locate_tools()),
        root / "installed",
        pc.PackedArtifact(pc.SUBAGENTS_CONTRACT, root / "x.tgz", "1.0.0", "sha512-x", "0" * 40, 1, ()),
        root / "work",
        (),
    )
    ctx.work.mkdir()
    monkeypatch.setattr(pc.Context, "provider_session", lambda self, script, routes=(): StubProvider(tools))
    return pc.scenario_subagents(ctx)


def good_run(text: str = pc.SUBAGENTS_CHILD_TEXT) -> pc.PiRun:
    """Return a clean faked Pi run whose `Agent` call answered `text`.

    Parameters:
        text (str): the child agent's answer.

    Returns:
        pc.PiRun: exit 0 with one `Agent` tool record.
    """
    return pc.PiRun(0, (agent_record(text),), "", "")


def test_scenario_subagents_passes_with_every_tool_and_an_agent_answer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Happy path: evidence names the tools and the child's answer."""
    evidence = run_subagents_scenario(tmp_path, monkeypatch, tools=ALL_SUBAGENT_TOOLS, result=good_run())
    assert evidence == {"tools": ALL_SUBAGENT_TOOLS, "child_text": pc.SUBAGENTS_CHILD_TEXT}


def test_scenario_subagents_names_the_missing_tool_and_tools_seen(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A tool absent from the first request fails with the missing name and what was seen."""
    seen = [t for t in ALL_SUBAGENT_TOOLS if t != "SubagentWorkflow"]
    with pytest.raises(pc.ContractError, match="SubagentWorkflow") as excinfo:
        run_subagents_scenario(tmp_path, monkeypatch, tools=seen, result=good_run())
    assert "Agent" in str(excinfo.value)
    assert "tools not offered" in str(excinfo.value)


def test_scenario_subagents_reports_load_failure_with_stderr_tail(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failing load (e.g. an unresolved dependency) surfaces the exit code and stderr."""
    broken = pc.PiRun(1, (), "", "Error: Cannot find module 'croner'")
    with pytest.raises(pc.ContractError, match="pi exited 1") as excinfo:
        run_subagents_scenario(tmp_path, monkeypatch, tools=ALL_SUBAGENT_TOOLS, result=broken)
    assert "Cannot find module 'croner'" in str(excinfo.value)


def test_scenario_subagents_rejects_missing_request_and_bad_agent_result(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No request, an erroring `Agent`, and a result without the child's answer all fail."""
    with pytest.raises(pc.ContractError, match="received no request"):
        run_subagents_scenario(tmp_path, monkeypatch, tools=[], result=good_run())
    errored = pc.PiRun(0, (agent_record("boom", is_error=True),), "", "")
    with pytest.raises(pc.ContractError, match="`Agent` failed"):
        run_subagents_scenario(tmp_path, monkeypatch, tools=ALL_SUBAGENT_TOOLS, result=errored)
    with pytest.raises(pc.ContractError, match="lacks the child's answer"):
        run_subagents_scenario(tmp_path, monkeypatch, tools=ALL_SUBAGENT_TOOLS, result=good_run("other"))


CU_ALL_TOOLS = sorted(pc.COMPUTER_USE_CONTRACT.exposes_tools)
CU_NON_DARWIN_TOOLS = sorted(pc.COMPUTER_USE_CONTRACT.exposes_tools - pc.COMPUTER_USE_DESKTOP_TOOLS)
CU_CPU = {"arm64": 0x0100000C, "x64": 0x01000007}


def macho(cpu: int, magic: bytes = pc.MACHO_MAGIC_64) -> bytes:
    """Build a minimal Mach-O header plus padding.

    Parameters:
        cpu (int): `cputype`.
        magic (bytes): Four magic bytes.

    Returns:
        bytes: Header bytes.
    """
    return magic + cpu.to_bytes(4, "little") + b"\0" * 16


CU_SWIFT = ("agent_cursor.swift", "agent_cursor_motion.swift", "bridge.swift")
CU_SETUP_SCRIPT = (
    'const helperSourcePaths = ["agent_cursor.swift", "agent_cursor_motion.swift", "bridge.swift"]\n'
    "\t.map(f);\n"
)
CU_BUILD_SCRIPT = (
    'const macosSourcePaths = [\n\t"agent_cursor.swift",\n\t"agent_cursor_motion.swift",\n'
    '\t"bridge.swift",\n].map(f);\n'
)


def helper_tarball(
    path: Path,
    *,
    overrides: dict[str, tuple[bytes, int]] | None = None,
    drop: str | None = None,
    omit_source: str | None = None,
    setup_script: str | None = None,
    build_script: str | None = None,
) -> Path:
    """Write a tarball holding both macOS helpers, optionally broken.

    Parameters:
        path (Path): Destination.
        overrides (dict[str, tuple[bytes, int]] | None): `arch -> (content, mode)` replacements.
        drop (str | None): Arch whose helper is omitted.
        omit_source (str | None): Swift source left out of the tarball.
        setup_script (str | None): Replacement `setup-helper.mjs` text.
        build_script (str | None): Replacement `build-native.mjs` text.

    Returns:
        Path: `path`.
    """
    entries = {arch: (macho(cpu), 0o755) for arch, cpu in CU_CPU.items()} | (overrides or {})
    members = {
        "scripts/setup-helper.mjs": (setup_script or CU_SETUP_SCRIPT).encode(),
        "scripts/build-native.mjs": (build_script or CU_BUILD_SCRIPT).encode(),
        **{f"native/macos/{name}": b"// swift\n" for name in CU_SWIFT if name != omit_source},
    }
    with tarfile.open(path, "w:gz") as tar:
        for arch, (data, mode) in entries.items():
            if arch == drop:
                continue
            info = tarfile.TarInfo(f"package/prebuilt/macos/{arch}/bridge")
            info.size, info.mode = len(data), mode
            tar.addfile(info, io.BytesIO(data))
        for name, data in members.items():
            info = tarfile.TarInfo(f"package/{name}")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return path


def run_computer_use_scenario(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    platform: str,
    tools: list[str],
    result: pc.PiRun | None = None,
    tarball: Path | None = None,
    siblings: tuple[pc.PackageContract, ...] = (),
) -> pc.ComputerUseEvidence:
    """Run `scenario_computer_use` against a faked Pi, provider and host platform.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
        monkeypatch (pytest.MonkeyPatch): Patches `run_pi`, `host_platform` and the provider.
        platform (str): Simulated `sys.platform`.
        tools (list[str]): Tools the parent request declares.
        result (pc.PiRun | None): Faked `pi` run; defaults to a clean one.
        tarball (Path | None): Packed tarball; defaults to a valid helper pair.
        siblings (tuple[pc.PackageContract, ...]): Sibling contracts.

    Returns:
        pc.ComputerUseEvidence: The scenario's evidence.
    """
    monkeypatch.setattr(pc, "run_pi", lambda *args, **kwargs: result or pc.PiRun(0, (), "", ""))
    monkeypatch.setattr(pc, "host_platform", lambda: platform)
    root = Path(tempfile.mkdtemp(dir=tmp_path))
    packed = tarball or helper_tarball(root / "x.tgz")
    ctx = pc.Context(
        Path("pi"),
        pc.Sandbox(root / "sandbox", pc.locate_tools()),
        root / "installed",
        pc.PackedArtifact(pc.COMPUTER_USE_CONTRACT, packed, "1.0.0", "sha512-x", "0" * 40, 1, ()),
        root / "work",
        siblings,
    )
    ctx.work.mkdir()
    monkeypatch.setattr(pc.Context, "provider_session", lambda self, script, routes=(): StubProvider(tools))
    return pc.scenario_computer_use(ctx)


def test_scenario_computer_use_expects_all_13_tools_on_darwin(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Darwin requires the 13-tool set and records platform, helpers and both NOT RUN items."""
    evidence = run_computer_use_scenario(tmp_path, monkeypatch, platform="darwin", tools=CU_ALL_TOOLS)
    assert evidence["platform"] == "darwin"
    assert evidence["tools"] == CU_ALL_TOOLS
    assert len(evidence["tools"]) == 13
    assert evidence["helpers"]["arm64"] == "Mach-O arm64 cputype 0x100000c mode 0755"
    assert evidence["helpers"]["x64"] == "Mach-O x64 cputype 0x1000007 mode 0755"
    assert evidence["postinstall"] == "NOT RUN"
    assert evidence["native_desktop"] == "NOT RUN"


def test_scenario_computer_use_expects_exactly_11_tools_off_darwin(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Linux requires the 11-tool set, and the desktop tools must NOT be offered there."""
    evidence = run_computer_use_scenario(tmp_path, monkeypatch, platform="linux", tools=CU_NON_DARWIN_TOOLS)
    assert evidence["platform"] == "linux"
    assert evidence["tools"] == CU_NON_DARWIN_TOOLS
    assert len(evidence["tools"]) == 11
    with pytest.raises(pc.ContractError, match=r"must not offer.*desktop_input"):
        run_computer_use_scenario(tmp_path, monkeypatch, platform="linux", tools=CU_ALL_TOOLS)


def test_scenario_computer_use_names_the_missing_tool(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Darwin without `desktop_input` fails naming it; Linux without `act_ui` fails naming it."""
    with pytest.raises(pc.ContractError, match=r"tools not offered.*desktop_input"):
        run_computer_use_scenario(
            tmp_path, monkeypatch, platform="darwin", tools=[t for t in CU_ALL_TOOLS if t != "desktop_input"]
        )
    with pytest.raises(pc.ContractError, match=r"tools not offered.*act_ui"):
        run_computer_use_scenario(
            tmp_path, monkeypatch, platform="linux", tools=[t for t in CU_NON_DARWIN_TOOLS if t != "act_ui"]
        )


def test_scenario_computer_use_reports_load_failure_with_stderr_tail(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failing load surfaces the exit code, the platform and the stderr tail."""
    broken = pc.PiRun(1, (), "", "Error: Cannot find module 'typebox'")
    with pytest.raises(pc.ContractError, match="pi exited 1") as excinfo:
        run_computer_use_scenario(
            tmp_path, monkeypatch, platform="linux", tools=CU_NON_DARWIN_TOOLS, result=broken
        )
    assert "Cannot find module 'typebox'" in str(excinfo.value)
    assert "(linux)" in str(excinfo.value)


def test_scenario_computer_use_rejects_sibling_tools_and_no_request(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A sibling's tool in the request fails, and so does a provider that saw no request."""
    with pytest.raises(pc.ContractError, match=r"sibling tools present.*git_status"):
        run_computer_use_scenario(
            tmp_path,
            monkeypatch,
            platform="linux",
            tools=[*CU_NON_DARWIN_TOOLS, "git_status"],
            siblings=(DEV_TOOLS,),
        )
    with pytest.raises(pc.ContractError, match="received no request"):
        run_computer_use_scenario(tmp_path, monkeypatch, platform="linux", tools=[])


@pytest.mark.parametrize(
    ("overrides", "drop", "message"),
    [
        ({"arm64": (macho(CU_CPU["x64"]), 0o755)}, None, "arm64/bridge has cputype 0x1000007"),
        ({"x64": (macho(CU_CPU["arm64"]), 0o755)}, None, "x64/bridge has cputype 0x100000c"),
        ({"arm64": (macho(CU_CPU["arm64"]), 0o644)}, None, "mode 0644, expected 0755"),
        ({"x64": (macho(CU_CPU["x64"]), 0o775)}, None, "mode 0775, expected 0755"),
        ({"x64": (b"#!/bin/sh\n" + b"\0" * 12, 0o755)}, None, "not a 64-bit little-endian Mach-O"),
        (
            {"arm64": (macho(CU_CPU["arm64"], b"\xca\xfe\xba\xbe"), 0o755)},
            None,
            "not a 64-bit little-endian Mach-O.*cafebabe",
        ),
        ({}, "x64", "has no 'prebuilt/macos/x64/bridge'"),
    ],
)
def test_scenario_computer_use_rejects_bad_helpers(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    overrides: dict[str, tuple[bytes, int]],
    drop: str | None,
    message: str,
) -> None:
    """Wrong arch, wrong mode, non-Mach-O, fat and missing helpers each fail with a specific message."""
    tarball = helper_tarball(tmp_path / "bad.tgz", overrides=overrides, drop=drop)
    with pytest.raises(pc.ContractError, match=message):
        run_computer_use_scenario(
            tmp_path, monkeypatch, platform="darwin", tools=CU_ALL_TOOLS, tarball=tarball
        )


def test_computer_use_expected_tools_split_by_platform() -> None:
    """Only darwin includes the two desktop tools."""
    assert pc.computer_use_expected_tools("darwin") == pc.COMPUTER_USE_CONTRACT.exposes_tools
    assert pc.computer_use_expected_tools("win32") == pc.computer_use_expected_tools("linux")
    assert not pc.computer_use_expected_tools("linux") & pc.COMPUTER_USE_DESKTOP_TOOLS


def test_shared_runner_report_records_computer_use_not_run(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Success writes `--report` and prints the same JSON, both recording `postinstall` NOT RUN."""
    evidence = {
        "platform": "linux",
        "tools": ["find_roots"],
        "helpers": {"arm64": "Mach-O arm64", "x64": "Mach-O x64"},
        "helper_sources": ["native/macos/bridge.swift"],
        "postinstall": "NOT RUN",
        "postinstall_reason": "ignore-scripts",
        "native_desktop": "NOT RUN",
        "native_desktop_reason": "no desktop",
    }
    entry = GOOD_ENTRY | {"tarball": "nredd-pi-computer-use-0.3.0.tgz", "evidence": evidence}
    report = pc.validate_report(good_report({"@nredd/pi-computer-use": entry}))
    monkeypatch.setattr(nr, "run_stock_contract", lambda *args, **kwargs: report)
    path = tmp_path / "report.json"
    assert (
        spc.main(
            ["--package", "@nredd/pi-computer-use", "--stock-prefix", str(tmp_path), "--report", str(path)]
        )
        == 0
    )
    written = json.loads(path.read_text())
    assert written == json.loads(capsys.readouterr().out)
    assert written["packages"]["@nredd/pi-computer-use"]["evidence"]["postinstall"] == "NOT RUN"


def cu_report() -> pc.ContractReport:
    """Build a computer-use-shaped report whose evidence records two NOT RUN items.

    Returns:
        pc.ContractReport: Validated report.
    """
    evidence = {
        "platform": "linux",
        "tools": ["find_roots"],
        "helpers": {"arm64": "Mach-O arm64", "x64": "Mach-O x64"},
        "helper_sources": ["native/macos/bridge.swift"],
        "postinstall": "NOT RUN",
        "postinstall_reason": "ignore-scripts",
        "native_desktop": "NOT RUN",
        "native_desktop_reason": "no desktop",
    }
    entry = GOOD_ENTRY | {"tarball": "nredd-pi-computer-use-0.3.0.tgz", "evidence": evidence}
    return pc.validate_report(good_report({"@nredd/pi-computer-use": entry}))


def test_shared_runner_logs_not_run_items(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """NOT RUN evidence is disclosed in the success log with its reasons."""
    monkeypatch.setattr(nr, "run_stock_contract", lambda *args, **kwargs: cu_report())
    with caplog.at_level("INFO"):
        assert spc.main(["--package", "@nredd/pi-computer-use", "--stock-prefix", str(tmp_path)]) == 0
    assert (
        "computer-use package contract: passed; NOT RUN: postinstall (ignore-scripts), "
        "native_desktop (no desktop)"
    ) in caplog.text


def test_shared_runner_plain_pass_without_not_run(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Evidence without NOT RUN entries logs a plain pass."""
    report = pc.validate_report(good_report())
    name = next(iter(report.packages))
    monkeypatch.setattr(nr, "run_stock_contract", lambda *args, **kwargs: report)
    with caplog.at_level("INFO"):
        assert spc.main(["--package", name, "--stock-prefix", str(tmp_path)]) == 0
    assert "package contract: passed" in caplog.text
    assert "NOT RUN" not in caplog.text


def test_computer_use_make_help_discloses_not_run() -> None:
    """The Makefile help line for the computer-use gate says what is NOT RUN."""
    lines = (pc.REPO_ROOT / "Makefile").read_text().splitlines()
    (line,) = (item for item in lines if item.startswith("check-computer-use-package-contract:"))
    assert "NOT RUN" in line


@pytest.mark.parametrize("error", [pc.ContractError("bad"), nr.ReleaseError("bad")])
def test_shared_runner_failure_exits_one_without_report(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, error: Exception
) -> None:
    """A contract or release error exits 1 and writes no report."""

    def fail(*args: object, **kwargs: object) -> pc.ContractReport:
        raise error

    monkeypatch.setattr(nr, "run_stock_contract", fail)
    path = tmp_path / "report.json"
    argv = ["--package", "@nredd/pi-computer-use", "--stock-prefix", str(tmp_path), "--report", str(path)]
    assert spc.main(argv) == 1
    assert not path.exists()


def test_shared_runner_unknown_package_exits_before_packing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """An undeclared package exits 1 without running the stock contract."""

    def boom(*args: object, **kwargs: object) -> pc.ContractReport:
        raise AssertionError("must not pack")

    monkeypatch.setattr(nr, "run_stock_contract", boom)
    assert spc.main(["--package", "@nredd/nope", "--stock-prefix", str(tmp_path)]) == 1


def test_audit_files_computer_use_exact_payload() -> None:
    """The pinned 45 paths pass; stray, missing and duplicated paths are each reported."""
    packed = list(pc.COMPUTER_USE_CONTRACT.packed_files)
    assert len(packed) == 45
    assert pc.audit_files(pc.COMPUTER_USE_CONTRACT, [*packed]) == []
    assert pc.audit_files(pc.COMPUTER_USE_CONTRACT, [*packed, "src/stray.ts"])
    missing = pc.audit_files(pc.COMPUTER_USE_CONTRACT, [name for name in packed if name != "src/view.ts"])
    assert any("src/view.ts" in problem for problem in missing)
    duplicated = pc.audit_files(pc.COMPUTER_USE_CONTRACT, [*packed, "src/view.ts"])
    assert any("listed 2 times" in problem for problem in duplicated)


def test_scenario_computer_use_rejects_unpacked_helper_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A source the packed build scripts compile but the tarball lacks fails by name."""
    tarball = helper_tarball(tmp_path / "bad.tgz", omit_source="agent_cursor_motion.swift")
    with pytest.raises(pc.ContractError, match=r"no 'native/macos/agent_cursor_motion\.swift'"):
        run_computer_use_scenario(
            tmp_path, monkeypatch, platform="darwin", tools=CU_ALL_TOOLS, tarball=tarball
        )


def test_scenario_computer_use_rejects_script_without_source_list(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A packed script whose source list cannot be found is a contract error, not a silent pass."""
    tarball = helper_tarball(tmp_path / "bad.tgz", setup_script="// no list\n")
    with pytest.raises(pc.ContractError, match="has no 'helperSourcePaths' helper source list"):
        run_computer_use_scenario(
            tmp_path, monkeypatch, platform="darwin", tools=CU_ALL_TOOLS, tarball=tarball
        )


def test_scenario_computer_use_parses_mixed_quote_helper_sources(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Every literal Swift source, including single-quoted entries, is verified in the tarball."""
    setup_script = (
        "const helperSourcePaths = ['agent_cursor.swift', \"agent_cursor_motion.swift\", 'bridge.swift']\n"
        ".map(f);\n"
    )
    tarball = helper_tarball(tmp_path / "mixed.tgz", setup_script=setup_script)
    evidence = run_computer_use_scenario(
        tmp_path, monkeypatch, platform="darwin", tools=CU_ALL_TOOLS, tarball=tarball
    )
    assert evidence["helper_sources"] == [f"native/macos/{name}" for name in CU_SWIFT]


@pytest.mark.parametrize(
    ("setup_script", "build_script", "message"),
    [
        ('const helperSourcePaths = ["bridge.swift", extra]\n.map(f);\n', None, "unsupported token"),
        ('const macosSourcePaths = ["bridge.swift"]\n.map(f);\n', None, "helperSourcePaths"),
        (None, 'const helperSourcePaths = ["bridge.swift"]\n.map(f);\n', "macosSourcePaths"),
    ],
    ids=["expression", "setup-wrong-variable", "build-wrong-variable"],
)
def test_scenario_computer_use_rejects_unsupported_or_wrong_helper_source_declaration(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    setup_script: str | None,
    build_script: str | None,
    message: str,
) -> None:
    """Only each script's complete expected literal source list is accepted."""
    tarball = helper_tarball(tmp_path / "bad.tgz", setup_script=setup_script, build_script=build_script)
    with pytest.raises(pc.ContractError, match=message):
        run_computer_use_scenario(
            tmp_path, monkeypatch, platform="darwin", tools=CU_ALL_TOOLS, tarball=tarball
        )


def stub_npm_install(
    monkeypatch: pytest.MonkeyPatch, modules: list[str], calls: list[list[str]], envs: list[dict[str, str]]
) -> None:
    """Replace `run` with an `npm install` that materializes `modules` and a matching lockfile.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): Patches `pc.run`.
        modules (list[str]): `node_modules` entries to create, e.g. `@nredd/pi-dev-tools`.
        calls (list[list[str]]): Receives each argument vector.
        envs (list[dict[str, str]]): Receives each environment.
    """

    real_run = pc.run

    def fake_run(cmd: Any, *, env: dict[str, str], cwd: Path, **kwargs: Any) -> Any:
        """Record the npm call and lay out `node_modules` plus a lockfile for `modules`.

        `node` (the real semver range check) passes through.

        Parameters:
            cmd (Any): npm argv.
            env (dict[str, str]): subprocess environment.
            cwd (Path): install directory.
            **kwargs (Any): other `run` options.

        Returns:
            Any: The real result for `node`, else `None`.
        """
        if Path(cmd[0]).name == "node":
            return real_run(cmd, env=env, cwd=cwd, **kwargs)
        calls.append([str(part) for part in cmd])
        envs.append(env)
        packages: dict[str, object] = {"": {}}
        versions = {name: spec.lstrip("^") for name, spec in pc.SUBAGENTS_CONTRACT.runtime_dependencies}
        for module in modules:
            dependencies = (
                dict(pc.SUBAGENTS_CONTRACT.runtime_dependencies)
                if module == pc.SUBAGENTS_CONTRACT.name
                else {}
            )
            (cwd / "node_modules" / module).mkdir(parents=True)
            (cwd / "node_modules" / module / "package.json").write_text(
                json.dumps(
                    {"name": module, "version": versions.get(module, "1.0.0"), "dependencies": dependencies}
                )
            )
            packages[f"node_modules/{module}"] = {"dependencies": dependencies}
        (cwd / "package-lock.json").write_text(json.dumps({"packages": packages}))
        return None

    monkeypatch.setattr(pc, "run", fake_run)


@pytest.mark.parametrize(
    ("contract", "modules", "offline"),
    [
        (pc.SUBAGENTS_CONTRACT, ["@nredd/pi-subagents", "croner", "nanoid"], False),
        (pc.CONTRACTS[2], ["@nredd/pi-subscription-router"], True),
    ],
    ids=["registry", "offline"],
)
def test_install_alone_offline_flag_follows_runtime_dependencies(
    tmp_path: Path,
    sandbox: pc.Sandbox,
    monkeypatch: pytest.MonkeyPatch,
    *,
    contract: pc.PackageContract,
    modules: list[str],
    offline: bool,
) -> None:
    """Only a contract with declared runtime dependencies may touch the registry."""
    calls: list[list[str]] = []
    envs: list[dict[str, str]] = []
    stub_npm_install(monkeypatch, modules, calls, envs)
    artifact = pc.PackedArtifact(contract, tmp_path / "x.tgz", "1.0.0", "sha512-x", "0" * 40, 1, ())
    installed = pc.install_alone(artifact, sandbox, tmp_path / "project")
    assert installed == tmp_path / "project" / "node_modules" / contract.name
    assert ("--offline" in calls[0]) is offline
    assert (envs[0].get("HTTP_PROXY") == "") is (not offline)


def test_install_alone_rejects_an_undeclared_module(
    tmp_path: Path, sandbox: pc.Sandbox, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A module that is not a declared dependency fails the install even on the registry branch."""
    stub_npm_install(monkeypatch, ["@nredd/pi-subagents", "croner", "nanoid", "left-pad"], [], [])
    artifact = pc.PackedArtifact(
        pc.SUBAGENTS_CONTRACT, tmp_path / "x.tgz", "1.0.0", "sha512-x", "0" * 40, 1, ()
    )
    with pytest.raises(pc.ContractError, match="lockfile paths differ"):
        pc.install_alone(artifact, sandbox, tmp_path / "project")


def plan_mode_files(chunk: str = "AAAAAAA1", ui: str = "BBBBBBB2") -> list[str]:
    """Return a conforming Plan-mode tarball listing with the given chunk hashes.

    Parameters:
        chunk (str): Hash of the shared chunk.
        ui (str): Hash of the interactive UI chunk.

    Returns:
        list[str]: Packed paths.
    """
    return [
        *pc.PLAN_MODE_CONTRACT.packed_files,
        f"dist/chunks/chunk-{chunk}.ts",
        f"dist/chunks/chunk-{chunk}.ts.map",
        f"dist/chunks/interactive-ui-{ui}.ts",
        f"dist/chunks/interactive-ui-{ui}.ts.map",
    ]


def test_audit_files_accepts_rebuilt_chunk_hashes() -> None:
    """Any 8-character hash passes: a rebuild is fine."""
    assert pc.audit_files(pc.PLAN_MODE_CONTRACT, plan_mode_files()) == []
    assert pc.audit_files(pc.PLAN_MODE_CONTRACT, plan_mode_files("Z9Z9Z9Z9", "0A0A0A0A")) == []


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda f: [n for n in f if not n.startswith("dist/chunks/chunk-")], "expected 1 packed file"),
        (lambda f: [*f, "dist/chunks/chunk-CCCCCCC3.ts"], "expected 1 packed file"),
        (lambda f: [*f, "dist/chunks/x.ts"], "'dist/chunks/x.ts' is not in the"),
        (lambda f: [n for n in f if n != "src/state.ts"], "'src/state.ts' required by"),
        (lambda f: [*f, "src/state.ts"], "'src/state.ts' is listed 2 times"),
        (lambda f: [*f, f[-1]], "is listed 2 times"),
        (lambda f: [n for n in f if n != "dist/chunks/chunk-AAAAAAA1.ts"], "has no 'dist/chunks/chunk-"),
        (lambda f: [n.replace("AAAAAAA1", "SHORT") for n in f], "expected 1 packed file"),
    ],
    ids=["count-0", "count-2", "stray", "missing", "dup-fixed", "dup-pattern", "map-unpaired", "hash-width"],
)
def test_audit_files_rejects_plan_mode_payload_drift(
    mutate: Callable[[list[str]], list[str]], message: str
) -> None:
    """Each packed-payload violation is reported.

    Parameters:
        mutate (Callable[[list[str]], list[str]]): Edits a conforming listing.
        message (str): Expected problem fragment.
    """
    problems = pc.audit_files(pc.PLAN_MODE_CONTRACT, mutate(plan_mode_files()))
    assert any(message in problem for problem in problems), problems


def test_audit_chunk_graph_requires_reachability_from_index() -> None:
    """A hash-shaped but unreferenced chunk is an orphan; reachable ones pass, transitively."""
    files = plan_mode_files()
    imports = {
        "dist/index.ts": pc.FileImports(
            specifiers=["./chunks/chunk-AAAAAAA1.ts", "./chunks/interactive-ui-BBBBBBB2.ts"], diagnostics=[]
        ),
        "dist/chunks/interactive-ui-BBBBBBB2.ts": pc.FileImports(
            specifiers=["./chunk-AAAAAAA1.ts"], diagnostics=[]
        ),
    }
    assert pc.audit_chunk_graph(pc.PLAN_MODE_CONTRACT, files, imports) == []
    orphan = {
        "dist/index.ts": imports["dist/index.ts"].model_copy(
            update={"specifiers": ["./chunks/chunk-AAAAAAA1.ts"]}
        )
    }
    problems = pc.audit_chunk_graph(pc.PLAN_MODE_CONTRACT, files, orphan)
    assert problems == [
        "packed chunk 'dist/chunks/interactive-ui-BBBBBBB2.ts' is not reachable from 'dist/index.ts' "
        "by relative imports"
    ]
    transitive = {
        **imports,
        "dist/index.ts": orphan["dist/index.ts"].model_copy(
            update={"specifiers": ["./chunks/interactive-ui-BBBBBBB2.ts"]}
        ),
    }
    assert pc.audit_chunk_graph(pc.PLAN_MODE_CONTRACT, files, transitive) == []
    through_non_chunk = {
        "dist/index.ts": pc.FileImports(specifiers=["./loader.ts"], diagnostics=[]),
        "dist/loader.ts": pc.FileImports(specifiers=["./chunks/chunk-AAAAAAA1.ts"], diagnostics=[]),
        "dist/chunks/chunk-AAAAAAA1.ts": pc.FileImports(
            specifiers=["./interactive-ui-BBBBBBB2.ts"], diagnostics=[]
        ),
    }
    assert pc.audit_chunk_graph(pc.PLAN_MODE_CONTRACT, [*files, "dist/loader.ts"], through_non_chunk) == []
