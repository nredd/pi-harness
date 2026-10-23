"""Independent compiled-library packaging, without weakening extension contracts.

References:
    https://nodejs.org/api/packages.html#package-entry-points
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import package_contracts as pc
import release_descriptors as rd


def manifest() -> dict[str, object]:
    """Return the actual library's public manifest for mutation tests.

    Returns:
        dict[str, object]: Parsed package metadata.
    """
    return json.loads((pc.REPO_ROOT / "packages/resource-sampler/package.json").read_text())


def test_library_manifest_and_descriptor() -> None:
    """Require exact ESM exports, no Pi peers, and the isolated runtime probe."""
    contract = pc.RESOURCE_SAMPLER_CONTRACT
    assert pc.audit_manifest(contract, manifest(), contract.required) == []
    descriptor = rd.descriptor_for(contract.name)
    assert descriptor is not None
    assert descriptor.contract.library
    assert descriptor.contract_gates == ("audit",)
    assert descriptor.contract.node_probe
    assert descriptor.stock_gate is None


@pytest.mark.parametrize(
    "mutation",
    [
        {"pi": {"extensions": []}},
        {"peerDependencies": {"@earendil-works/pi-tui": "*"}},
        {"dependencies": {"@nredd/pi-session-kit": "*"}},
        {"exports": {".": "./src/index.ts"}},
        {"types": "./src/index.ts"},
        {"type": "commonjs"},
        {"files": ["dist", "src", "LICENSE", "README.md"]},
    ],
)
def test_library_manifest_rejects_bad_boundaries(mutation: dict[str, object]) -> None:
    """Reject host coupling, source loading, unpinned payloads and wrong entrypoints."""
    contract = pc.RESOURCE_SAMPLER_CONTRACT
    assert pc.audit_manifest(contract, manifest() | mutation, contract.required)


def test_extension_still_requires_pi_entrypoint() -> None:
    """A library exemption must not weaken ordinary extension entrypoint validation."""
    contract = pc.CONTRACTS[0]
    problems = pc.audit_manifest(contract, manifest() | {"name": contract.name}, contract.required)
    assert "`pi.extensions` is empty" in problems


def test_library_imports_and_payload_are_exact() -> None:
    """Allow relative ESM but never host imports or extra/missing compiled files."""
    contract = pc.RESOURCE_SAMPLER_CONTRACT
    files = list(contract.required)
    assert pc.audit_files(contract, files) == []
    assert pc.audit_files(contract, [*files, "dist/unexpected.js"])
    assert pc.audit_files(contract, files[:-1])
    allowed = pc.FileImports(specifiers=["node:os", "./types.js"], diagnostics=[])
    assert pc.classify_imports("dist/index.js", allowed, files, library=True) == []
    for specifier in ["@earendil-works/pi-tui", "@nredd/pi-dev-tools", "../../outside.js"]:
        found = pc.FileImports(specifiers=[specifier], diagnostics=[])
        assert pc.classify_imports("dist/index.js", found, files, library=True)


def test_library_probe_runs_on_installed_bytes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Assert the audit gate actually invokes the descriptor probe after isolated install."""
    calls: list[dict[str, object]] = []
    tools = pc.locate_tools()
    contract = pc.RESOURCE_SAMPLER_CONTRACT
    artifact = pc.PackedArtifact(
        contract=contract,
        path=tmp_path / "library.tgz",
        version="0.1.0",
        integrity="sha512-" + "A" * 86 + "==",
        shasum="0" * 40,
        size=1,
        files=contract.required,
    )
    monkeypatch.setattr(pc, "select_artifact", lambda *_args: artifact)
    monkeypatch.setattr(pc, "audit_tarball", lambda *_args: [])
    monkeypatch.setattr(pc, "install_alone", lambda *_args: calls.append({"kind": "install"}))
    monkeypatch.setattr(pc, "run", lambda argv, **kwargs: calls.append({"argv": argv, **kwargs}))
    pc.run_audit_gate(tmp_path, contract)
    assert calls[0] == {"kind": "install"}
    assert calls[1]["argv"] == [tools.node, "--input-type=module", "-e", contract.node_probe]
    assert calls[1]["cwd"] == tmp_path / "install"


def session_kit() -> pc.PackageContract:
    """Return the session-kit contract, the only declared consumer of the shared sampler.

    Returns:
        pc.PackageContract: Session-kit packaging contract.
    """
    return next(c for c in pc.CONTRACTS if c.name == "@nredd/pi-session-kit")


def test_session_kit_declares_the_exact_published_sampler() -> None:
    """The consumer pins one exact registry release, never a range, workspace or file spec."""
    contract = session_kit()
    assert contract.runtime_dependencies == (("@nredd/pi-resource-sampler", pc.RESOURCE_SAMPLER_VERSION),)
    actual = json.loads((pc.REPO_ROOT / "packages/session-kit/package.json").read_text())
    assert actual["dependencies"] == {"@nredd/pi-resource-sampler": pc.RESOURCE_SAMPLER_VERSION}
    files = list(contract.required)
    assert pc.audit_manifest(contract, actual, files) == []
    for spec in ["^0.1.0", "workspace:*", "file:../resource-sampler", "0.0.0-bootstrap.0"]:
        mutated = actual | {"dependencies": {"@nredd/pi-resource-sampler": spec}}
        assert pc.audit_manifest(contract, mutated, files), spec


def test_only_declared_shared_library_is_an_allowed_sibling_import() -> None:
    """A declared shared library is importable; plugins, subpaths and undeclared use stay banned."""
    files = ["src/a.ts"]
    declared = ["@nredd/pi-resource-sampler"]

    def problems(spec: str, dependencies: list[str]) -> list[str]:
        found = pc.FileImports(specifiers=[spec], diagnostics=[])
        return pc.classify_imports("src/a.ts", found, files, dependencies)

    assert problems("@nredd/pi-resource-sampler", declared) == []
    assert problems("@nredd/pi-resource-sampler", [])
    assert problems("@nredd/pi-resource-sampler/dist/collect.js", declared)
    assert problems("@nredd/pi-dev-tools", ["@nredd/pi-dev-tools"])
    standalone = pc.classify_imports(
        "dist/x.mjs",
        pc.FileImports(specifiers=["@nredd/pi-resource-sampler"], diagnostics=[]),
        ["dist/x.mjs"],
        declared,
        standalone_artifacts=["dist/x.mjs"],
    )
    assert standalone
