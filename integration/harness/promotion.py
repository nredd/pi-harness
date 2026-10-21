"""Build and validate immutable promoted-stack snapshots.

References:
- https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds
- https://docs.github.com/rest/branches/branch-protection
"""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from harness.stack import Stack

SNAPSHOT_SCHEMA_VERSION = 1
SHA256_HEX_LENGTH = 64
GIT_SHA_LENGTH = 40


class GateEvidence(BaseModel):
    """The immutable gate facts selected by a promotion.

    Parameters:
        required_checks (list[str]): Configured branch-protection checks that passed.
        stack_run_ids (list[int]): Successful registry-byte assembled-stack workflow runs.
        owned_packages (list[str]): Owned npm subjects whose provenance was verified.
        core_verified (bool): Whether the core release verifier accepted every consumed asset.
    """

    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    required_checks: list[str] = Field(min_length=1)
    stack_run_ids: list[int] = Field(min_length=1)
    owned_packages: list[str] = Field(min_length=1)
    core_verified: Literal[True]

    @model_validator(mode="after")
    def validate_unique_evidence(self) -> Self:
        """Reject ambiguous or incomplete evidence identifiers.

        Returns:
            Self: validated evidence.

        Raises:
            ValueError: evidence is duplicated, blank, or names a non-owned package.
        """
        if len(self.required_checks) != len(set(self.required_checks)) or not all(
            check.strip() for check in self.required_checks
        ):
            raise ValueError("`required_checks` must contain unique nonempty names")
        if len(self.stack_run_ids) != len(set(self.stack_run_ids)) or any(
            run <= 0 for run in self.stack_run_ids
        ):
            raise ValueError("`stack_run_ids` must contain unique positive workflow run IDs")
        if len(self.owned_packages) != len(set(self.owned_packages)) or any(
            not package.startswith("@nredd/") for package in self.owned_packages
        ):
            raise ValueError("`owned_packages` must contain unique `@nredd/` package names")
        return self


class StackSnapshot(BaseModel):
    """A canonical personal stack and the gate facts authorizing its adoption.

    Parameters:
        schema_version (Literal[1]): Snapshot schema version.
        source_sha (str): Exact 40-character `main` commit selected for promotion.
        stack_sha256 (str): SHA-256 of canonical `stack` JSON bytes.
        stack (Stack): Canonical authoritative personal stack.
        gates (GateEvidence): Promotion verification evidence.
    """

    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    schema_version: Literal[1]
    source_sha: str = Field(pattern=rf"^[0-9a-f]{{{GIT_SHA_LENGTH}}}$")
    stack_sha256: str = Field(pattern=rf"^[0-9a-f]{{{SHA256_HEX_LENGTH}}}$")
    stack: Stack
    gates: GateEvidence

    @model_validator(mode="after")
    def validate_snapshot(self) -> Self:
        """Require canonical personal-stack bytes and their exact digest.

        Returns:
            Self: validated snapshot.

        Raises:
            ValueError: the stack is not personal or its digest differs.
        """
        if self.stack.name != "personal":
            raise ValueError("Promoted snapshots must contain the `personal` stack")
        if self.stack_sha256 != stack_bytes(self.stack).sha256:
            raise ValueError("`stack_sha256` does not match canonical `stack` bytes")
        return self


@dataclass(frozen=True)
class CanonicalStack:
    """Canonical serialized stack bytes and their SHA-256 digest."""

    contents: bytes
    sha256: str


def stack_bytes(stack: Stack) -> CanonicalStack:
    """Serialize a stack using the sole snapshot digest representation.

    Parameters:
        stack (Stack): validated authoritative stack.

    Returns:
        CanonicalStack: compact, sorted UTF-8 JSON and its SHA-256 digest.
    """
    contents = json.dumps(stack.model_dump(mode="json"), sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    )
    return CanonicalStack(contents, hashlib.sha256(contents).hexdigest())


def build_snapshot(stack_path: Path, source_sha: str, gates: GateEvidence) -> StackSnapshot:
    """Build a fail-closed promotion snapshot from the authoritative stack file.

    Parameters:
        stack_path (Path): `personal.json` at the selected source commit.
        source_sha (str): exact selected `main` commit SHA.
        gates (GateEvidence): already-collected external gate evidence.

    Returns:
        StackSnapshot: digest-bound immutable snapshot.

    Raises:
        ValueError: the stack is malformed, non-personal, or source SHA is invalid.
    """
    stack = Stack.model_validate_json(stack_path.read_bytes())
    canonical = stack_bytes(stack)
    return StackSnapshot(
        schema_version=SNAPSHOT_SCHEMA_VERSION,
        source_sha=source_sha,
        stack_sha256=canonical.sha256,
        stack=stack,
        gates=gates,
    )


def verify_successor(
    candidate: StackSnapshot, stable: StackSnapshot | None, descends_from_stable: bool
) -> None:
    """Refuse a stale, duplicate, or rollback promotion without explicit rollback mode.

    Parameters:
        candidate (StackSnapshot): requested new stable snapshot.
        stable (StackSnapshot | None): current stable snapshot, if initialized.
        descends_from_stable (bool): Git ancestry result for candidate versus stable source SHA.

    Returns:
        None.

    Raises:
        ValueError: the candidate is equal to, older than, or unrelated to stable.
    """
    if stable is None:
        return
    if candidate.source_sha == stable.source_sha:
        raise ValueError("Candidate already is the stable snapshot")
    if not descends_from_stable:
        raise ValueError("Candidate source SHA does not descend from stable source SHA")


def _main() -> None:
    """Build or verify a snapshot for the promotion workflow."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    subcommands = parser.add_subparsers(dest="command", required=True)
    build = subcommands.add_parser("build")
    build.add_argument("--stack", type=Path, required=True)
    build.add_argument("--source-sha", required=True)
    build.add_argument("--gates", type=Path, required=True)
    build.add_argument("--output", type=Path, required=True)
    verify = subcommands.add_parser("verify")
    verify.add_argument("--snapshot", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "verify":
        StackSnapshot.model_validate_json(args.snapshot.read_bytes())
        return
    gates = GateEvidence.model_validate_json(args.gates.read_bytes())
    snapshot = build_snapshot(args.stack, args.source_sha, gates)
    args.output.write_bytes(
        json.dumps(snapshot.model_dump(mode="json"), sort_keys=True, separators=(",", ":")).encode("utf-8")
    )


if __name__ == "__main__":
    _main()
