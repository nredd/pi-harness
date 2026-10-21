"""Promotion snapshot serialization and fail-closed successor tests.

References:
- https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from pathlib import Path

import pytest
from pydantic import ValidationError

from harness.promotion import GateEvidence, StackSnapshot, build_snapshot, stack_bytes, verify_successor

CORE = {
    "tag": "v1.3.0-nredd.7",
    "integrity": {"earendil-works-pi-coding-agent-1.3.0.tgz": "0" * 64},
}
GATES = {
    "required_checks": ["owned (ubuntu-24.04)"],
    "stack_run_ids": [123],
    "owned_packages": ["@nredd/pi-preset"],
    "core_verified": True,
}


def write_stack(path: Path, **overrides: Any) -> None:
    """Write a minimal authoritative stack document.

    Parameters:
        path (Path): stack output path.
        **overrides (Any): stack fields to replace.

    Returns:
        None.
    """
    document = {
        "schema_version": 1,
        "name": "personal",
        "core": CORE,
        "sources": ["npm:@nredd/pi-preset@0.2.0"],
    } | overrides
    path.write_text(json.dumps(document))


def snapshot(tmp_path: Path, source_sha: str = "a" * 40) -> StackSnapshot:
    """Build one valid snapshot fixture.

    Parameters:
        tmp_path (Path): private fixture directory.
        source_sha (str): candidate main commit.

    Returns:
        StackSnapshot: valid snapshot.
    """
    path = tmp_path / "personal.json"
    write_stack(path)
    return build_snapshot(path, source_sha, GateEvidence.model_validate(GATES))


def test_snapshot_binds_sorted_canonical_stack_bytes(tmp_path: Path) -> None:
    """Use one compact sorted representation for snapshot digesting."""
    item = snapshot(tmp_path)
    canonical = stack_bytes(item.stack)
    assert item.stack_sha256 == canonical.sha256
    assert (
        canonical.contents
        == json.dumps(item.stack.model_dump(mode="json"), sort_keys=True, separators=(",", ":")).encode()
    )
    assert StackSnapshot.model_validate_json(item.model_dump_json()) == item


@pytest.mark.parametrize(
    "change",
    [
        {"schema_version": 2},
        {"source_sha": "A" * 40},
        {"source_sha": "a" * 39},
        {"stack_sha256": "0" * 64},
        {"stack": {"schema_version": 1, "name": "local", "core": CORE, "sources": ["./pkg"]}},
        {"gates": {**GATES, "stack_run_ids": [1, 1]}},
        {"gates": {**GATES, "owned_packages": ["pi-preset"]}},
        {"gates": {**GATES, "core_verified": False}},
    ],
)
def test_snapshot_rejects_tampering(tmp_path: Path, change: dict[str, Any]) -> None:
    """Reject altered schema, digest, personal stack, and gate evidence."""
    item = snapshot(tmp_path)
    document = item.model_dump(mode="json") | change
    with pytest.raises(ValidationError):
        StackSnapshot.model_validate(document)


def test_successor_accepts_seed_and_descendant(tmp_path: Path) -> None:
    """Allow the initial promotion and a Git-descendant candidate."""
    stable = snapshot(tmp_path, "a" * 40)
    candidate = snapshot(tmp_path, "b" * 40)
    verify_successor(stable, None, False)
    verify_successor(candidate, stable, True)


@pytest.mark.parametrize(
    ("source_sha", "descends", "message"),
    [
        ("a" * 40, True, "already"),
        ("b" * 40, False, "does not descend"),
    ],
)
def test_successor_rejects_stale_or_rollback_candidate(
    tmp_path: Path, source_sha: str, descends: bool, message: str
) -> None:
    """Require a new source SHA descended from the current stable source."""
    stable = snapshot(tmp_path, "a" * 40)
    with pytest.raises(ValueError, match=message):
        verify_successor(snapshot(tmp_path, source_sha), stable, descends)
