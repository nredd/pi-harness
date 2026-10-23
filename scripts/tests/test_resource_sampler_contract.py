"""Independent compiled-library packaging, without weakening extension contracts.

References:
    https://nodejs.org/api/packages.html#package-entry-points
"""

from __future__ import annotations

import json
import os
import select
import subprocess
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


NEGATIVE_CONTROL = "hostile child does not expose the secret through the 0.1.0 name source"
SILENT = "setInterval(() => {}, 1000);"
READY = "console.log('ready'); setInterval(() => {}, 1000);"


@pytest.mark.parametrize(
    ("probe", "failure", "status"),
    [
        # Only the deliberately never-ready child gets a short deadline; the rest keep the shipped one.
        pytest.param(
            pc.resource_sampler_probe(SILENT, ready_ms=300),
            "hostile child not ready within 300 ms",
            "SIGTERM",
            id="silent",
        ),
        pytest.param(
            pc.resource_sampler_probe("process.exit(3);"),
            "hostile child exited before readiness",
            "3",
            id="exits",
        ),
        pytest.param(
            pc.resource_sampler_probe(READY, disguise=False),
            NEGATIVE_CONTROL,
            "SIGTERM",
            id="negative-control",
        ),
        # Installs its handler before `ready`, so SIGTERM is really ignored and only SIGKILL reaps it.
        pytest.param(
            pc.resource_sampler_probe(f"process.on('SIGTERM', () => {{}}); {READY}", disguise=False),
            NEGATIVE_CONTROL,
            "SIGKILL",
            id="ignores-sigterm",
        ),
    ],
)
def test_library_probe_reaps_child_when_setup_fails(
    tmp_path: Path, probe: str, failure: str, status: str
) -> None:
    """Run the real probe with a broken child: it must fail for that reason and still reap the child.

    The failures happen before the probe imports the library, so no installed package is needed.
    `hostile child reaped` is printed only after Node observed that exact child's exit status, so a
    reused PID cannot make it pass.

    Parameters:
        tmp_path (Path): Empty working directory without the library installed.
        probe (str): Probe program around a broken child.
        failure (str): Expected setup failure.
        status (str): Expected exit code or terminating signal of the reaped child.
    """
    result = subprocess.run(
        [str(pc.locate_tools().node), "--input-type=module", "-e", probe],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode != 0
    assert failure in result.stderr
    assert f"hostile child reaped: {status}\n" in result.stderr


def test_probe_timeout_kills_its_whole_process_group(tmp_path: Path) -> None:
    """Time out the real probe while its child waits for readiness: no grandchild may survive.

    The child holds the only writer of a FIFO and never prints `ready`, so the probe outlives the
    `run` deadline. EOF on the FIFO after `run` returns proves every writer exited, without a
    reusable PID probe; the first byte proves the child really opened it.

    Parameters:
        tmp_path (Path): Probe working directory holding the FIFO.
    """
    fifo = tmp_path / "alive.fifo"
    os.mkfifo(fifo)
    child = f"const fs = require('node:fs'); fs.writeSync(fs.openSync('alive.fifo', 'w'), 'x'); {SILENT}"
    probe = pc.resource_sampler_probe(child, ready_ms=60_000)
    reader = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK)
    try:
        with pytest.raises(pc.ContractError, match="timed out after 2s"):
            pc.run(
                [pc.locate_tools().node, "--input-type=module", "-e", probe],
                env={"PATH": "/usr/bin:/bin"},
                cwd=tmp_path,
                timeout=2,
                own_group=True,
            )
        assert select.select([reader], [], [], 5)[0], "child never wrote to the FIFO"
        assert os.read(reader, 1) == b"x"
        assert select.select([reader], [], [], 5)[0], "grandchild still holds the FIFO 5s after the timeout"
        assert os.read(reader, 1) == b""
    finally:
        os.close(reader)


def test_library_probe_rejects_non_positive_readiness() -> None:
    """Reject a readiness bound that could never be met before building the program."""
    with pytest.raises(ValueError, match="ready_ms"):
        pc.resource_sampler_probe(ready_ms=0)
