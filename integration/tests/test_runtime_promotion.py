"""Supplemental runtime graph authentication and immutable publication contracts.

References:
- https://cli.github.com/manual/gh_attestation_verify
- https://github.com/nredd/pi-harness/issues/169
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from harness import install, promotion_verify, publish_gate, runtime_lock
from harness.install import VerificationError
from harness.promotion import (
    CoreEvidence,
    GateEvidence,
    OwnedPackageEvidence,
    StackSnapshot,
    stack_bytes,
)
from harness.runtime_lock import DependencyGraph, RuntimeLocks
from harness.stack import Stack, source_string

ROOT = Path(__file__).parents[2]
SHA = "a" * 40


def inputs() -> tuple[StackSnapshot, DependencyGraph]:
    """Build synthetic promotion evidence from actual source-selected runtime graph identities."""
    stack = Stack.model_validate_json((ROOT / "integration/stacks/personal.json").read_bytes())
    runtime = RuntimeLocks.model_validate_json((ROOT / runtime_lock.SOURCE_LOCK).read_bytes())
    entries = runtime.platforms["darwin-arm64"]["agent"].lock["packages"]
    owned = []
    for package in stack.sources:
        source = source_string(package)
        if source.startswith("npm:@nredd/"):
            tag = source.removeprefix("npm:")
            name = tag.rsplit("@", 1)[0]
            owned.append(
                OwnedPackageEvidence(package=tag, integrity=entries[f"node_modules/{name}"]["integrity"])
            )
    snapshot = StackSnapshot(
        schema_version=1,
        source_sha=SHA,
        stack_sha256=stack_bytes(stack).sha256,
        stack=stack,
        gates=GateEvidence(
            required_checks=["fixture"],
            stack_run_ids=[1],
            owned_packages=owned,
            core=CoreEvidence(tag=stack.core.tag, integrity=stack.core.integrity),
        ),
    )
    return snapshot, DependencyGraph(schema_version=1, source_sha=SHA, runtime=runtime)


def test_supplemental_graph_is_attested_before_any_registry_bytes_are_acquired(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The installer independently authenticates exact graph bytes before interpreting registry URLs."""
    snapshot, graph = inputs()
    contents = graph.model_dump_json().encode()
    events: list[str] = []

    def download(url: str, destination: Path) -> Path:
        """Provide the exact supplemental asset, never a registry-generated lock."""
        assert url.endswith(f"stack/{SHA}/dependency-graph.json")
        destination.write_bytes(contents)
        events.append("download")
        return destination

    def attest(path: Path, repo: str, workflow: str, ref: str, **kwargs: Any) -> None:
        """Check the fixed existing promotion identity, not an identity supplied by the graph."""
        assert path.read_bytes() == contents
        assert repo == "nredd/pi-harness"
        assert workflow == "nredd/pi-harness/.github/workflows/promote-stack.yml"
        assert ref == "refs/heads/main"
        assert kwargs["gh_bin"] == "/fixture/gh"
        events.append("attest")

    def acquire(*args: Any) -> dict[str, Path]:
        """Refuse an acquisition ordered before the existing attestation verifier."""
        assert events[-1] in {"attest", "acquire"}
        events.append("acquire")
        return {}

    monkeypatch.setattr(install, "download", download)
    monkeypatch.setattr(install, "verify_public_attestation", attest)
    monkeypatch.setattr(install, "acquire", acquire)
    verified, archives = install.verify_runtime(snapshot, tmp_path, {}, gh_bin="/fixture/gh")
    assert verified == graph
    assert set(archives) == {"core", "agent"}
    assert events == ["download", "attest", "acquire", "acquire"]


@pytest.mark.parametrize("mutation", ["metadata", "source", "stack", "signer", "missing"])
def test_replaced_or_unbound_graphs_fail_before_registry_or_npm(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mutation: str
) -> None:
    """Coherent same-channel graph/SRI replacement cannot inherit the original promotion's identity."""
    snapshot, graph = inputs()
    document = graph.model_dump()
    if mutation == "metadata":
        entry = document["runtime"]["platforms"]["darwin-arm64"]["agent"]["lock"]["packages"][
            "node_modules/pi-memory"
        ]
        entry["integrity"] = "sha512-" + "A" * 86 + "=="
    elif mutation == "source":
        document["source_sha"] = "b" * 40
    elif mutation == "stack":
        document["runtime"]["stack_sha256"] = "0" * 64
    changed = json.dumps(document).encode()
    golden = graph.model_dump_json().encode()
    acquired: list[str] = []

    def download(url: str, destination: Path) -> Path:
        """Model missing legacy evidence or downloaded attacker-controlled bytes."""
        if mutation == "missing":
            raise VerificationError("dependency-graph.json HTTP 404 Not Found")
        destination.write_bytes(changed)
        return destination

    def attest(path: Path, *args: Any, **kwargs: Any) -> None:
        """The local verifier stands in only for the existing cryptographic identity check."""
        if mutation in {"metadata", "signer"}:
            assert path.read_bytes() != golden or mutation == "signer"
            raise RuntimeError("Existing promotion attestation rejected modified bytes or foreign signer/ref")

    monkeypatch.setattr(install, "download", download)
    monkeypatch.setattr(install, "verify_public_attestation", attest)
    monkeypatch.setattr(install, "acquire", lambda *args: acquired.append("unsafe"))
    with pytest.raises(VerificationError, match="Authenticated runtime dependency graph required"):
        install.verify_runtime(snapshot, tmp_path, {})
    assert acquired == []
    assert not list(tmp_path.rglob("node_modules"))


def test_installer_cannot_stage_legacy_verified_snapshot_without_a_runtime_graph(tmp_path: Path) -> None:
    """An evidence-only v1 snapshot is never enough to enter the old pi-install path."""
    snapshot, _ = inputs()
    verified = install.Verified(snapshot, [source_string(p) for p in snapshot.stack.sources], {})
    with pytest.raises(VerificationError, match="legacy install refused"):
        install.install_packages(verified, "/not-invoked/npm", tmp_path)
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("missing", [True, False])
def test_existing_promotion_must_retain_the_exact_supplemental_asset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, missing: bool
) -> None:
    """Resume refuses both old evidence-only releases and changed authenticated runtime graphs."""
    snapshot = tmp_path / "snapshot"
    graph = tmp_path / "graph"
    snapshot.write_bytes(b"snapshot")
    graph.write_bytes(b"frozen graph")
    monkeypatch.setattr(publish_gate, "_tag_refs", lambda *args: [{"object": {"sha": SHA, "type": "commit"}}])
    assets = [{"name": "stack-snapshot.json"}] + ([] if missing else [{"name": "dependency-graph.json"}])
    monkeypatch.setattr(publish_gate, "_json", lambda *args: {"assets": assets})

    def command(*args: str) -> None:
        """Download deterministic existing assets through the publication CLI seam."""
        destination = tmp_path / "existing"
        destination.mkdir(exist_ok=True)
        (destination / "stack-snapshot.json").write_bytes(b"snapshot")
        (destination / "dependency-graph.json").write_bytes(b"changed graph")

    monkeypatch.setattr(publish_gate, "_command", command)
    with pytest.raises((publish_gate.PublishError, ValueError), match=r"legacy promotions|differs"):
        publish_gate.prepare_release("nredd/pi-harness", SHA, snapshot, tmp_path / "existing", graph)


def test_workflow_attests_publishes_and_checks_both_assets() -> None:
    """The unchanged strict v1 snapshot and new strict graph have independent identity verification."""
    workflow = (ROOT / ".github/workflows/promote-stack.yml").read_text()
    assert "--dependency-graph promotion/dependency-graph.json" in workflow
    assert "gh attestation verify existing/dependency-graph.json" in workflow
    assert "promotion/stack-snapshot.json promotion/dependency-graph.json" in workflow
    assert (
        "subject-path: |\n            promotion/stack-snapshot.json\n"
        "            promotion/dependency-graph.json" in workflow
    )
    assert (
        runtime_lock.SOURCE_LOCK in Path(promotion_verify.__file__).read_text()
        or "SOURCE_LOCK" in Path(promotion_verify.__file__).read_text()
    )
