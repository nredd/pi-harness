"""Build and validate coverage producer sidecars independently of presentation.

References:
    https://docs.github.com/en/actions/reference/workflows-and-actions/variables
    https://github.com/nredd/pi-harness/issues/1093
"""

from __future__ import annotations

import json
import math
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, TypedDict, TypeGuard

MAX_JSON_BYTES = 4 * 1024 * 1024
MAX_PROVENANCE_BYTES = 4096
PROVENANCE_MEMBER = "coverage/provenance.json"
CI_EVENTS = {"pull_request", "push", "workflow_dispatch"}
MAX_INT_DIGITS = 20
FORBIDDEN_CATEGORIES = frozenset({"Cc", "Cf", "Cs", "Co", "Zl", "Zp"})
SHA = re.compile(r"[0-9a-f]{40}\Z")
SAFE_REPOSITORY = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")


ProducerJob = Literal["owned-ubuntu", "owned-macos", "owned-shards-ubuntu", "owned-shards-macos"]
COVERAGE_HOSTS: dict[str, tuple[ProducerJob, ProducerJob]] = {
    "ubuntu-24.04": ("owned-ubuntu", "owned-shards-ubuntu"),
    "macos-14": ("owned-macos", "owned-shards-macos"),
}
PRODUCER_JOBS = frozenset(job for pair in COVERAGE_HOSTS.values() for job in pair)


class ProvenanceRecord(TypedDict):
    """Exact JSON schema of a coverage producer sidecar."""

    run_id: int
    run_attempt: int
    job: ProducerJob
    cell: str
    tested_sha: str
    pr_head_sha: str | None
    event_name: str
    workflow_ref: str


def is_producer_job(job: str) -> TypeGuard[ProducerJob]:
    """Check whether a runtime job key is a coverage producer.

    Parameters:
        job (str): GitHub runtime job key.
    Returns:
        TypeGuard[ProducerJob]: Whether the key is in the producer map.
    Raises:
        None.
    """
    return job in PRODUCER_JOBS


def producer_job(host: str, *, shard: bool) -> ProducerJob:
    """Look up the GitHub job key for a known coverage host.

    Parameters:
        host (str): Host suffix of a fan-in artifact.
        shard (bool): Whether to select the shard job instead of the fan-in.
    Returns:
        ProducerJob: The job key used in CI.
    Raises:
        KeyError: The host has no coverage producer.
    """
    return COVERAGE_HOSTS[host][1 if shard else 0]


def producer_job_for_cell(cell: str, *, shard: bool) -> ProducerJob:
    """Resolve a fan-in artifact name to its fan-in or shard job.

    Parameters:
        cell (str): The fan-in artifact name, e.g. `coverage-ubuntu-24.04`.
        shard (bool): Whether to select the shard job instead of the fan-in.
    Returns:
        ProducerJob: The job key used in CI.
    Raises:
        KeyError: The artifact host has no coverage producer.
    """
    return producer_job(cell.removeprefix("coverage-"), shard=shard)


def object_value(value: object) -> dict[str, object]:
    """Require a JSON object with string keys.

    Parameters:
        value (object): Decoded JSON value.
    Returns:
        dict[str, object]: Validated object.
    Raises:
        ValueError: The value is not an object.
    """
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise ValueError("Expected a JSON object")
    return value


def text_value(value: object) -> str:
    """Require bounded text without control, format, separator, private or surrogate characters.

    Parameters:
        value (object): Untrusted JSON value.
    Returns:
        str: Validated text.
    Raises:
        ValueError: Text is malformed or too large.
    """
    if (
        not isinstance(value, str)
        or len(value) > 8192
        or any(unicodedata.category(c) in FORBIDDEN_CATEGORIES for c in value)
    ):
        raise ValueError("Expected bounded text without control or format characters")
    return value


def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    """Reject duplicate JSON keys instead of silently accepting the last.

    Parameters:
        pairs (list[tuple[str, object]]): Object entries from the JSON decoder.
    Returns:
        dict[str, object]: Unique entries.
    Raises:
        ValueError: A key occurs more than once.
    """
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON key: '{key}'")
        result[key] = value
    return result


def reject_constant(token: str) -> object:
    """Refuse the non-finite tokens Python's JSON decoder accepts by default.

    Parameters:
        token (str): `NaN`, `Infinity` or `-Infinity`.
    Returns:
        object: Never returns.
    Raises:
        ValueError: Always.
    """
    raise ValueError(f"Non-finite JSON number: '{token}'")


def parse_int(token: str) -> int:
    """Parse a JSON integer with our own length bound, before `int()` and any interpreter limit.

    Parameters:
        token (str): Decimal integer token.
    Returns:
        int: The value.
    Raises:
        ValueError: The literal is longer than `MAX_INT_DIGITS` characters.
    """
    if len(token) > MAX_INT_DIGITS:
        raise ValueError("Integer literal too long")
    return int(token)


def parse_float(token: str) -> float:
    """Parse a JSON float, refusing overflow to infinity.

    Parameters:
        token (str): Decimal float token.
    Returns:
        float: Finite value.
    Raises:
        ValueError: The value is not finite.
    """
    value = float(token)
    if not math.isfinite(value):
        raise ValueError(f"Non-finite JSON number: '{token}'")
    return value


def decode_json(data: bytes) -> dict[str, object]:
    """Decode bounded JSON with no duplicate keys.

    Parameters:
        data (bytes): UTF-8 JSON document.
    Returns:
        dict[str, object]: Decoded object.
    Raises:
        ValueError: Encoding, size or JSON structure is invalid.
    """
    if len(data) > MAX_JSON_BYTES:
        raise ValueError("JSON byte limit exceeded")
    try:
        return object_value(
            json.loads(
                data,
                object_pairs_hook=unique_object,
                parse_constant=reject_constant,
                parse_float=parse_float,
                parse_int=parse_int,
            )
        )
    except (ValueError, RecursionError) as error:
        raise ValueError(f"Cannot decode JSON: '{error}'") from error


def decode_record(data: bytes) -> dict[str, object]:
    """Read small producer records through the same strict JSON boundary as summaries.

    Parameters:
        data (bytes): Untrusted producer record.
    Returns:
        dict[str, object]: Decoded record.
    Raises:
        ValueError: The record is too large or malformed.
    """
    if len(data) > MAX_PROVENANCE_BYTES:
        raise ValueError("Coverage provenance byte limit exceeded")
    return decode_json(data)


def read_record(path: Path) -> dict[str, object]:
    """Read a bounded regular sidecar from an already-unpacked artifact.

    Parameters:
        path (Path): Exact sidecar location.
    Returns:
        dict[str, object]: Decoded record.
    Raises:
        ValueError: The sidecar is missing, unsafe or malformed.
        OSError: The sidecar cannot be read.
    """
    if path.is_symlink() or not path.is_file():
        raise ValueError("Missing or non-regular coverage provenance")
    with path.open("rb") as stream:
        return decode_record(stream.read(MAX_PROVENANCE_BYTES + 1))


def validate_record(record: dict[str, object], expected: ProvenanceRecord) -> None:
    """Require exact fields, JSON types and values, with no identity inferred from artifact metadata.

    Parameters:
        record (dict[str, object]): Untrusted producer record.
        expected (ProvenanceRecord): Record built from trusted run and producer identities.
    Returns:
        None: All fields agree.
    Raises:
        ValueError: The record lacks a field, has a wrong type or disagrees with the trusted identity.
    """
    if record.keys() != expected.keys() or any(
        type(record[key]) is not type(value) or record[key] != value for key, value in expected.items()
    ):
        raise ValueError("Coverage provenance does not match the expected run and producer")


@dataclass(frozen=True)
class Provenance:
    """Authenticated run identity, never accepted from accounting artifacts."""

    repository: str
    head_sha: str | None
    tested_sha: str
    run_id: int
    attempt: int
    event_name: str
    workflow_ref: str

    def __post_init__(self) -> None:
        """Reject malformed caller-provided provenance.

        Raises:
            ValueError: Repository, SHA, run or attempt is invalid.

        Parameters:
            None.

        Returns:
            None: The boundary contract is satisfied.
        """
        if (
            not SAFE_REPOSITORY.fullmatch(self.repository)
            or (self.head_sha is not None and not SHA.fullmatch(self.head_sha))
            or (self.event_name == "pull_request") != (self.head_sha is not None)
            or self.event_name not in CI_EVENTS
            or not text_value(self.workflow_ref).startswith(
                f"{self.repository}/.github/workflows/ci.yml@refs/"
            )
            or not SHA.fullmatch(self.tested_sha)
            or type(self.run_id) is not int
            or self.run_id <= 0
            or type(self.attempt) is not int
            or self.attempt <= 0
        ):
            raise ValueError("Invalid run provenance")

    def record(self, job: ProducerJob, cell: str) -> ProvenanceRecord:
        """Build the identity that a single coverage producer must write.

        Parameters:
            job (ProducerJob): GitHub job key, shared across cells of a matrix.
            cell (str): CI matrix cell, identified by its declared artifact name.
        Returns:
            ProvenanceRecord: Exact sidecar schema, including a null PR head outside PR events.
        Raises:
            None.
        """
        return {
            "run_id": self.run_id,
            "run_attempt": self.attempt,
            "job": job,
            "cell": cell,
            "tested_sha": self.tested_sha,
            "pr_head_sha": self.head_sha,
            "event_name": self.event_name,
            "workflow_ref": self.workflow_ref,
        }
