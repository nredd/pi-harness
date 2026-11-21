"""Store measured-main coverage as data on a dedicated Git ref.

References:
    https://docs.github.com/en/rest/git/refs
    https://docs.github.com/en/rest/git/trees
    https://github.com/nredd/pi-harness/issues/1001
"""

from __future__ import annotations

import base64
import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol
from urllib.error import HTTPError

from coverage_provenance_record import (
    COVERAGE_HOSTS,
    SEMANTICS_FIELD,
    SHA,
    counter_semantics,
    decode_json,
    object_value,
    text_value,
)
from coverage_report import COUNTERS, HOSTS, Counters, Evidence, Signal, Summary

REF = "refs/heads/coverage-data"
REF_API = "git/ref/heads/coverage-data"
FILENAME = "snapshot.json"
MAX_BYTES = 256 * 1024
MAX_AGE = timedelta(days=90)
COUNTER_KEYS = frozenset(key for metric in COUNTERS for key in (metric, f"uncovered_{metric}"))


class Transport(Protocol):
    """Repository-scoped JSON API used to read and atomically update the data branch."""

    @property
    def repository(self) -> str:
        """Return the repository this transport addresses.

        Parameters:
            None.
        Returns:
            str: Repository name.
        Raises:
            None.
        """
        ...

    def request(self, path: str, method: str = "GET", body: dict[str, Any] | None = None) -> Any:
        """Send a bounded repository request.

        Parameters:
            path (str): Repository-relative route.
            method (str): HTTP verb.
            body (dict[str, Any] | None): Optional JSON payload.
        Returns:
            Any: Decoded response.
        Raises:
            OSError: GitHub request failed.
        """
        ...


def git_sha(value: object) -> str:
    """Validate a Git object name before placing it in a route or write payload.

    Parameters:
        value (object): Candidate Git object name.
    Returns:
        str: Lowercase SHA.
    Raises:
        ValueError: Invalid SHA.
    """
    sha = text_value(value)
    if not SHA.fullmatch(sha):
        raise ValueError("Invalid Git object name")
    return sha


def positive_id(value: object) -> int:
    """Require a positive bounded GitHub identifier or ordinal, never a boolean.

    Parameters:
        value (object): Candidate identifier.
    Returns:
        int: Positive bounded integer.
    Raises:
        ValueError: Invalid identifier.
    """
    if type(value) is not int or not 0 < value < 10**20:
        raise ValueError("Invalid GitHub identifier")
    return value


def timestamp(value: object) -> datetime:
    """Decode GitHub's canonical UTC timestamp, at second resolution.

    Parameters:
        value (object): Candidate timestamp.
    Returns:
        datetime: Measurement time in UTC.
    Raises:
        ValueError: Invalid timestamp.
    """
    text = text_value(value)
    when = datetime.fromisoformat(text)
    if when.isoformat(timespec="seconds").replace("+00:00", "Z") != text or when.tzinfo != UTC:
        raise ValueError("Invalid GitHub timestamp")
    return when


@dataclass(frozen=True)
class Snapshot:
    """Validated snapshot metadata and the package-level evidence needed for deltas."""

    sha: str
    run_id: int
    order: tuple[int, int]
    measured_at: datetime
    evidence: tuple[Evidence, ...]

    @classmethod
    def parse(cls, raw: bytes, repository: str) -> Snapshot:
        """Validate bounded data before using it for either ordering or deltas.

        Parameters:
            raw (bytes): Stored JSON bytes.
            repository (str): Expected repository.
        Returns:
            Snapshot: Validated identity and measurements.
        Raises:
            ValueError: Malformed snapshot.
        """
        if len(raw) > MAX_BYTES:
            raise ValueError("Coverage snapshot exceeds byte limit")
        data = decode_json(raw)
        if (
            data.keys() != {"schema", "repository", "sha", "run", "number", "attempt", "measured_at", "hosts"}
            or type(data["schema"]) is not int
            or data["schema"] != 1
            or data["repository"] != repository
        ):
            raise ValueError("Invalid coverage snapshot identity")
        cells = object_value(data["hosts"])
        if cells.keys() != COVERAGE_HOSTS.keys():
            raise ValueError("Unexpected snapshot hosts")
        return cls(
            git_sha(data["sha"]),
            positive_id(data["run"]),
            (positive_id(data["number"]), positive_id(data["attempt"])),
            timestamp(data["measured_at"]),
            tuple(snapshot_cell(host, cell) for host, cell in cells.items()),
        )


def snapshot_cell(host: str, value: object) -> Evidence:
    """Decode counters and producer semantics without accepting paths, reasons or links.

    Parameters:
        host (str): Snapshot host label.
        value (object): Stored host counters and plan.
    Returns:
        Evidence: Parsed package-level evidence.
    Raises:
        ValueError: Invalid counters or signal.
    """
    signals, packages = [], {}
    payload = object_value(value)
    fingerprint = counter_semantics(payload)
    if payload.keys() not in ({"signals"}, {SEMANTICS_FIELD, "signals"}):
        raise ValueError("Unexpected snapshot host fields")
    for name, raw in object_value(payload["signals"]).items():
        entry = object_value(raw)
        if entry.keys() != {"enforcement", "state", "semantics", "counters"}:
            raise ValueError("Unexpected snapshot signal fields")
        signal = Signal.parse(name, entry | {"reason": ""})
        counters = object_value(entry["counters"])
        if not counters.keys() <= COUNTER_KEYS:
            raise ValueError("Unexpected snapshot metric")
        if counters:
            if signal.state != "planned":
                raise ValueError("Unexpected counters for a skipped snapshot signal")
            packages[name] = Counters.parse(counters)
        elif signal.state == "planned" and signal.enforcement == "enforced":
            raise ValueError("Missing enforced snapshot counters")
        signals.append(signal)
    if not packages:
        raise ValueError("Empty snapshot host")
    return Evidence(
        host,
        "available",
        tuple(signals),
        Summary(HOSTS[host][1], False, packages, {}, (), {}, (), counter_semantics=fingerprint),
    )


def encode_cell(cell: Evidence) -> dict[str, object]:
    """Project only planned signals and measured package counters onto the snapshot.

    Parameters:
        cell (Evidence): Validated main host evidence.
    Returns:
        dict[str, object]: Signal plan and counters.
    Raises:
        ValueError: Evidence was incomplete.
    """
    summary = cell.summary
    if summary is None or summary.errors or summary.measurement_only or summary.trimmed_from is not None:
        raise ValueError("Incomplete main coverage evidence")
    projection = {}
    for signal in cell.plan:
        counters = summary.packages.get(signal.name)
        projection[signal.name] = {
            "enforcement": signal.enforcement,
            "state": signal.state,
            "semantics": signal.semantics,
            "counters": {
                key: value
                for metric, total, uncovered in (() if counters is None else counters.values)
                for key, value in ((metric, total), (f"uncovered_{metric}", uncovered))
            },
        }
    if summary.counter_semantics is None:
        raise ValueError("Missing snapshot counter semantics")
    return {SEMANTICS_FIELD: summary.counter_semantics, "signals": projection}


def read_tip(api: Transport) -> str | None:
    """Read the exact data ref; only a missing ref permits initialization.

    Parameters:
        api (Transport): Repository transport.
    Returns:
        str | None: Fixed ref tip, if it exists.
    Raises:
        ValueError: Unexpected ref or tip.
    """
    try:
        ref = api.request(REF_API)
    except HTTPError as error:
        if error.code != 404:
            raise
        error.close()
        return None
    if ref["ref"] != REF or ref["object"]["type"] != "commit":
        raise ValueError("Unexpected coverage data ref")
    return git_sha(ref["object"]["sha"])


@dataclass(frozen=True)
class BranchState:
    """The observed commit and its root tree, with optional parsed snapshot data."""

    tip: str
    tree: str
    snapshot: Snapshot | None


def read_snapshot(api: Transport, tip: str) -> BranchState:
    """Read a fixed regular file at the pinned data commit, never a checked-out tree.

    Parameters:
        api (Transport): Repository transport.
        tip (str): Validated snapshot commit SHA.
    Returns:
        BranchState: The pinned commit and tree, with a snapshot if present.
    Raises:
        ValueError: Malformed Git entry or snapshot.
    """
    commit = api.request(f"git/commits/{tip}")
    tree_sha = git_sha(commit["tree"]["sha"])
    tree = api.request(f"git/trees/{tree_sha}")
    entries = [entry for entry in tree["tree"] if entry["path"] == FILENAME]
    if tree["sha"] != tree_sha or tree["truncated"] is not False or len(entries) > 1:
        raise ValueError("Invalid or ambiguous snapshot tree")
    if not entries:
        return BranchState(tip, tree_sha, None)
    entry = entries[0]
    size = positive_id(entry["size"])
    if entry["mode"] != "100644" or entry["type"] != "blob" or size > MAX_BYTES:
        raise ValueError("Invalid snapshot tree entry")
    blob = api.request(f"git/blobs/{git_sha(entry['sha'])}")
    if blob["encoding"] != "base64" or blob["sha"] != entry["sha"] or blob["size"] != size:
        raise ValueError("Invalid snapshot blob")
    encoded = blob["content"].replace("\n", "")
    if len(encoded) != ((size + 2) // 3) * 4:
        raise ValueError("Invalid encoded snapshot size")
    raw = base64.b64decode(encoded, validate=True)
    if len(raw) != size:
        raise ValueError("Invalid decoded snapshot size")
    return BranchState(tip, tree_sha, Snapshot.parse(raw, api.repository))


def baseline(api: Transport, now: datetime) -> Snapshot | None:
    """Treat an absent, expired or invalid baseline as unavailable without blocking the PR comment.

    Parameters:
        api (Transport): Read-only snapshot transport.
        now (datetime): Reader time in UTC.
    Returns:
        Snapshot | None: Fresh measurements and producing run identity, if available.
    Raises:
        None.
    """
    try:
        tip = read_tip(api)
        if tip is None:
            return None
        snapshot = read_snapshot(api, tip).snapshot
    except (KeyError, OSError, TypeError, ValueError):
        return None
    return (
        snapshot if snapshot is not None and timedelta(0) <= now - snapshot.measured_at <= MAX_AGE else None
    )


def write_snapshot(
    api: Transport,
    branch: BranchState | None,
    payload: dict[str, Any],
    still_current: Callable[[], bool],
) -> bool:
    """Commit only data, then advance the ref without force or create it exactly once.

    Parameters:
        api (Transport): Snapshot writer transport.
        branch (BranchState | None): Observed commit and tree, or no existing ref.
        payload (dict[str, Any]): Candidate snapshot JSON.
        still_current (Callable[[], bool]): Recheck run identity immediately before mutating the ref.
    Returns:
        bool: Whether the ref advanced, or false on a rejected ref mutation.
    Raises:
        ValueError: Invalid snapshot or changed attempt.
        HTTPError: Git API failure other than a 409 or 422 on the final ref mutation.
    """
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n"
    Snapshot.parse(raw.encode(), api.repository)
    overlay = {"base_tree": branch.tree} if branch is not None else {}
    tree = api.request(
        "git/trees",
        "POST",
        overlay | {"tree": [{"path": FILENAME, "type": "blob", "mode": "100644", "content": raw}]},
    )
    commit = api.request(
        "git/commits",
        "POST",
        {
            "message": "Record measured main coverage",
            "tree": git_sha(tree["sha"]),
            "parents": [branch.tip] if branch is not None else [],
        },
    )
    sha = git_sha(commit["sha"])
    if not still_current():
        raise ValueError("Main attempt changed during publication")
    try:
        if branch is None:
            api.request("git/refs", "POST", {"ref": REF, "sha": sha})
        else:
            api.request("git/refs/heads/coverage-data", "PATCH", {"sha": sha, "force": False})
    except HTTPError as error:
        if error.code not in {409, 422}:
            raise
        error.close()
        return False
    return True
