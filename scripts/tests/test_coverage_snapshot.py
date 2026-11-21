"""Exercise main snapshot publication and the sticky reader with a recording API.

References:
    https://github.com/nredd/pi-harness/issues/1001
"""

from __future__ import annotations

import base64
import copy
import json
from datetime import UTC, datetime, timedelta
from email.message import Message
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from zipfile import ZipFile

import pytest
from coverage_publish_fixtures import (
    FINGERPRINT,
    FIXTURE,
    HEAD,
    POLICY,
    REPO,
    STAMP,
    UPLOAD,
    RecordingGitHub,
    run_data,
)

import coverage_publish as pub
import coverage_snapshot as snap
from coverage_provenance_record import SEMANTICS_FIELD, Provenance, producer_job

NOW = datetime(2026, 11, 21, tzinfo=UTC)
TIP = "c" * 40
BLOB = "d" * 40
TREE = "e" * 40
BASE_TREE = "f" * 40
SIBLING = {"path": "coverage.svg", "sha": "a" * 40, "size": 42, "type": "blob", "mode": "100644"}


def http_error(path: str, code: int) -> HTTPError:
    """Return a synthetic GitHub error with no network connection.

    Parameters:
        path (str): Request route.
        code (int): HTTP status.
    Returns:
        HTTPError: Recorded failure.
    Raises:
        None.
    """
    return HTTPError(path, code, "Recording transport", Message(), None)


class MainGitHub(pub.GitHub):
    """Simulate GitHub jobs, archives and atomic ref updates without making remote writes."""

    data: dict[str, Any]
    jobs: list[dict[str, Any]]
    artifacts: list[dict[str, Any]]
    writes: list[tuple[str, str, Any]]
    downloads: list[int]
    reads: list[str]
    raw: bytes
    race: str
    archive: str
    tree_entries: list[dict[str, Any]]
    proposed_siblings: list[dict[str, Any]]
    tree_metadata: dict[str, Any]
    blob: dict[str, Any]
    ref: dict[str, Any]
    policy: dict[str, Any]
    competing_order: int
    conflict_code: int
    conflicts: int
    root_tree: str

    def __init__(self) -> None:
        """Seed a completed main attempt with independent retained OS fixtures.

        Parameters:
            None.
        Returns:
            None.
        Raises:
            None.
        """
        super().__init__(REPO, "synthetic-token")
        self.data = run_data(
            event="push",
            head_branch="main",
            repository={"id": 92, "full_name": REPO},
            head_repository={"id": 92, "full_name": REPO},
            run_started_at=STAMP,
        )
        self.jobs, self.artifacts, self.writes, self.downloads, self.reads = [], [], [], [], []
        self.raw, self.race, self.archive = b"", "", ""
        self.tree_entries, self.proposed_siblings, self.blob, self.ref = [], [], {}, {}
        self.tree_metadata = {"sha": BASE_TREE, "truncated": False}
        self.competing_order, self.conflicts, self.root_tree = 6, 0, BASE_TREE
        self.conflict_code = 422
        self.policy = {
            "path": "coverage/policy.json",
            "type": "file",
            "encoding": "base64",
            "content": base64.b64encode(POLICY.read_bytes()).decode(),
        }
        for number, host in enumerate(pub.COVERAGE_HOSTS, start=1):
            self.jobs.append(
                {
                    "name": f"owned ({host})",
                    "conclusion": "success",
                    "steps": [
                        {"name": UPLOAD, "conclusion": "success", "started_at": STAMP, "completed_at": STAMP},
                    ],
                }
            )
            self.artifacts.append(
                {
                    "name": f"coverage-{host}",
                    "id": number,
                    "size_in_bytes": 1000,
                    "expired": False,
                    "created_at": STAMP,
                    "workflow_run": {
                        "id": 123,
                        "repository_id": 92,
                        "head_repository_id": 92,
                        "head_branch": "main",
                        "head_sha": HEAD,
                    },
                }
            )

    def seed_snapshot(self, raw: bytes) -> None:
        """Put a regular snapshot blob at an existing tip.

        Parameters:
            raw (bytes): Snapshot JSON.
        Returns:
            None.
        Raises:
            None.
        """
        self.ref.update(ref=snap.REF, object={"type": "commit", "sha": TIP})
        self.tree_entries[:] = [
            {"path": snap.FILENAME, "sha": BLOB, "size": len(raw), "type": "blob", "mode": "100644"}
        ]
        self.blob.update(sha=BLOB, size=len(raw), encoding="base64", content=base64.encodebytes(raw).decode())

    def request(self, path: str, method: str = "GET", body: dict[str, Any] | None = None) -> Any:
        """Check exact routes, retain the proposed tree and simulate competing writers.

        Parameters:
            path (str): API route.
            method (str): HTTP verb.
            body (dict[str, Any] | None): Write payload.
        Returns:
            Any: Recorded response.
        Raises:
            HTTPError: Missing ref or competing update.
        """
        if method == "GET":
            self.reads.append(path)
            if path == snap.REF_API:
                if not self.ref:
                    raise http_error(path, 404)
                return self.ref
            if path == "actions/runs/123":
                return self.data | ({"run_attempt": 3} if self.writes and self.race == "attempt" else {})
            return {
                f"git/commits/{self.ref.get('object', {}).get('sha')}": {"tree": {"sha": self.root_tree}},
                f"git/trees/{self.root_tree}": (self.tree_metadata | {"tree": self.tree_entries}),
                f"git/blobs/{BLOB}": self.blob,
                f"contents/coverage/policy.json?ref={HEAD}": self.policy,
            }[path]
        assert body is not None
        self.writes.append((path, method, body))
        if path == "git/trees":
            (entry,) = body["tree"]
            assert entry.keys() == {"path", "type", "mode", "content"}
            assert (entry["path"], entry["type"], entry["mode"]) == (snap.FILENAME, "blob", "100644")
            self.raw = entry["content"].encode()
            if "base_tree" in body:
                assert body["base_tree"] == self.root_tree
                self.proposed_siblings = [row for row in self.tree_entries if row["path"] != entry["path"]]
            else:
                self.proposed_siblings = []
            return {"sha": TREE}
        if path == "git/commits":
            assert body["tree"] == TREE
            return {"sha": HEAD}
        return self.mutate_ref(path, method, body)

    def mutate_ref(self, path: str, method: str, body: dict[str, Any]) -> dict[str, Any]:
        """Apply a proposed ref mutation or simulate a competing writer.

        Parameters:
            path (str): Ref API route.
            method (str): HTTP verb.
            body (dict[str, Any]): Proposed ref mutation.
        Returns:
            dict[str, Any]: Successful ref response.
        Raises:
            HTTPError: The proposed ref mutation was rejected.
        """
        if self.race == "ref":
            assert body.get("force") is not True
            raise http_error(path, self.conflict_code)
        if self.race == "first-publish":
            assert (path, method) == ("git/refs", "POST")
            assert not self.ref
            payload = json.loads(self.raw) | {"number": 8, "run": 456, "sha": BLOB}
            self.seed_snapshot(json.dumps(payload).encode())
            raise http_error(path, 409)
        if self.race == "forbidden":
            raise http_error(path, 403)
        if method == "PATCH":
            assert body["force"] is False
            if self.race == "unchanged":
                raise http_error(path, self.conflict_code)
            if self.race == "contended" or (self.race == "advance" and not self.conflicts):
                self.conflicts += 1
                payload = json.loads(self.raw) | {"number": self.competing_order}
                self.seed_snapshot(json.dumps(payload).encode())
                self.ref["object"]["sha"] = f"{100 + self.conflicts:040x}"
                self.root_tree = self.tree_metadata["sha"] = f"{self.conflicts:040x}"
                self.tree_entries.append(SIBLING)
                raise http_error(path, self.conflict_code)
            assert self.writes[-2][2]["parents"] == [self.ref["object"]["sha"]]
        self.seed_snapshot(self.raw)
        self.tree_entries.extend(self.proposed_siblings)
        return {}

    def pages(self, path: str, key: str | None = None, **params: str) -> list[Any]:
        """Provide only the triggering execution's jobs and artifacts.

        Parameters:
            path (str): API route.
            key (str | None): Response envelope key.
        Returns:
            list[Any]: Recorded jobs or artifacts.
        Raises:
            None.
        """
        return {
            ("actions/runs/123/attempts/2/jobs", "jobs"): self.jobs,
            ("actions/runs/123/artifacts", "artifacts"): self.artifacts,
        }[(path, str(key))]

    def download(self, artifact_id: int, destination: Path) -> None:
        """Wrap real counters in a synthetic main provenance fixture archive, with optional corruption.

        Parameters:
            artifact_id (int): Download identifier.
            destination (Path): Private ZIP path.
        Returns:
            None.
        Raises:
            None.
        """
        self.downloads.append(artifact_id)
        host = tuple(pub.COVERAGE_HOSTS)[artifact_id - 1]
        assert destination.name == f"coverage-{host}.zip"
        fixture = FIXTURE.with_name(f"coverage-{host}.json")
        summary = json.loads(fixture.read_text())
        summary.pop("rows_trimmed", None)
        # The historical macOS fixture predates removal of the benchmark package.
        summary["packages"].pop("python-benchmarks/primary", None)
        summary["signals"].pop("python-benchmarks/primary", None)
        # The retained figures intentionally omit file rows. Keep them self-consistent for live-shaped replay.
        summary["files"] = [
            dict(
                counters,
                package=name.split("/")[0],
                signal=name.split("/")[1],
                file="src/example",
                os=summary["os"],
            )
            for name, counters in summary["packages"].items()
        ]
        provenance = Provenance(
            REPO,
            None,
            HEAD,
            123,
            1 if self.archive == "attempt" else 2,
            "push",
            f"{REPO}/{pub.WORKFLOW}@refs/heads/main",
        )
        semantics = {} if self.archive == "legacy" else {SEMANTICS_FIELD: FINGERPRINT}
        receipt_semantics = {
            "mismatch": {SEMANTICS_FIELD: "f" * 64},
            "malformed": {SEMANTICS_FIELD: "invalid"},
        }.get(self.archive, semantics)
        with ZipFile(destination, "w") as archive:
            archive.writestr("coverage/summary.json", json.dumps(summary | semantics))
            archive.writestr(
                "coverage/provenance.json",
                json.dumps(
                    dict(provenance.record(producer_job(host, shard=False), f"coverage-{host}"))
                    | receipt_semantics
                ),
            )
            if self.archive == "path":
                archive.writestr("../snapshot.json", "{}")


@pytest.mark.parametrize(
    ("case", "expected"),
    [
        ("match", "lines -1, functions +0, branches +0, statements +0"),
        ("pr-missing", "not comparable: missing instrumentation fingerprint"),
        ("main-missing", "not comparable: missing instrumentation fingerprint"),
        ("changed", "not comparable: instrumentation fingerprints differ"),
        ("counters", "not comparable: supported counter sets differ"),
    ],
)
def test_publish_and_consume_snapshot(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    case: str,
    expected: str,
) -> None:
    """Round-trip a two-host baseline and render independent signed deltas in the PR comment.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): Scoped reader and clock overrides.
        tmp_path (Path): Step summary output directory.
        case (str): Compatibility case to render.
        expected (str): Exact measured-main cell.
    Returns:
        None.
    Raises:
        None.
    """
    api = MainGitHub()
    pub.publish_snapshot(api, api.data, NOW)
    assert api.downloads == [1, 2]
    assert api.writes[1][2]["parents"] == []
    assert api.writes[-1] == ("git/refs", "POST", {"ref": snap.REF, "sha": HEAD})
    data = json.loads(api.raw)
    assert (data["repository"], data["sha"], data["run"], data["number"], data["attempt"]) == (
        REPO,
        HEAD,
        123,
        7,
        2,
    )
    assert data["measured_at"] == STAMP
    baseline = snap.baseline(api, NOW)
    assert baseline is not None
    assert {cell.host for cell in baseline.evidence} == set(pub.COVERAGE_HOSTS)
    assert snap.baseline(api, NOW + snap.MAX_AGE) is None
    assert snap.baseline(api, NOW - timedelta(days=2)) is None
    data.update(sha=BLOB, run=321)
    ubuntu = data["hosts"]["ubuntu-24.04"]
    counters = ubuntu["signals"]["dev-tools/primary"]["counters"]
    counters["uncovered_lines"] = 1
    if case == "main-missing":
        del ubuntu[SEMANTICS_FIELD]
    if case == "counters":
        del counters["statements"], counters["uncovered_statements"]
    api.seed_snapshot(json.dumps(data).encode())
    pr = RecordingGitHub()
    pr.fingerprint = {"pr-missing": None, "changed": "f" * 64}.get(case, FINGERPRINT)
    original = RecordingGitHub.request

    def request(self: RecordingGitHub, path: str, *args: Any) -> Any:
        """Forward only snapshot reads to the branch fixture.

        Parameters:
            path (str): API route.
            *args (Any): Optional write arguments.
        Returns:
            Any: Recorded response.
        Raises:
            HTTPError: API fixture refused the request.
        """
        return api.request(path, *args) if path.startswith("git/") else original(self, path, *args)

    monkeypatch.setattr(RecordingGitHub, "request", request)
    monkeypatch.setattr(pub, "datetime", FixedClock)
    summary = tmp_path / "summary"
    pub.publish(pr, pub.Run.parse(pr.data), POLICY, summary)
    body = pr.writes[-1][2]["body"]
    assert summary.read_text() == body + "\n"
    label = "Producer-reported main baseline (not independently verified):"
    assert f"{label} [`{BLOB}`](https://github.com/{REPO}/commit/{BLOB})" in body
    assert f"https://github.com/{REPO}/actions/runs/321/attempts/2" in body
    assert "vs measured main (producer-reported)" in body
    assert body.index(pub.PR_NOTICE) < body.index("Ubuntu enforced signals:")
    row = next(line for line in body.splitlines() if line.startswith("dev&#45;tools&#47;primary |"))
    assert row.rsplit(" | ", 1)[1] == expected
    assert pub.PR_NOTICE in body.splitlines()
    assert (
        "verified"
        not in "\n".join(
            line for line in body.splitlines() if line != pub.PR_NOTICE and not line.startswith(label)
        ).casefold()
    )


class FixedClock:
    """Freeze baseline freshness for the existing PR renderer."""

    @staticmethod
    def now(tz: object) -> datetime:
        """Return the fixed test time.

        Parameters:
            tz (object): Requested timezone.
        Returns:
            datetime: Fixed UTC time.
        Raises:
            None.
        """
        assert tz == UTC
        return NOW


@pytest.mark.parametrize(
    "override",
    [
        {"event": "pull_request"},
        {"event": "workflow_dispatch"},
        {"path": ".github/workflows/other.yml"},
        {"head_branch": "topic"},
        {"head_repository": {"id": 1, "full_name": REPO}},
        {"head_repository": {"id": 92, "full_name": "fork/pi-harness"}},
        {"repository": {"id": 92, "full_name": "fork/pi-harness"}},
        {"status": "queued"},
        {"conclusion": "cancelled"},
        {"pull_requests": [{"number": 42}]},
        {"run_started_at": "2026-01-01T00:00:00Z"},
        {"run_started_at": "2026-11-20T04:50:01+00:00"},
    ],
)
def test_untrusted_trigger_fails_before_io(override: dict[str, Any]) -> None:
    """Reject everything except a successful same-repository CI push to main.

    Parameters:
        override (dict[str, Any]): Trigger fields to replace.
    Returns:
        None.
    Raises:
        None.
    """
    api = MainGitHub()
    with pytest.raises(ValueError, match=r"CI run|main push|retention window|GitHub timestamp"):
        pub.publish_snapshot(api, api.data | override, NOW)
    assert not api.downloads
    assert not api.writes


@pytest.mark.parametrize(
    "case",
    [
        "owner",
        "size",
        "wrong-name",
        "ambiguous",
        "path",
        "attempt",
        "policy",
        "changed",
        "legacy",
        "mismatch",
        "malformed",
    ],
)
def test_invalid_evidence_never_writes(case: str) -> None:
    """Fail closed on incomplete, incorrectly bound or malformed producer evidence.

    Parameters:
        case (str): Broken evidence case.
    Returns:
        None.
    Raises:
        None.
    """
    api = MainGitHub()
    trigger = copy.deepcopy(api.data)
    artifact = api.artifacts[0]
    if case == "owner":
        artifact["workflow_run"]["head_repository_id"] = 42
    elif case == "size":
        artifact["size_in_bytes"] = pub.MAX_ARCHIVE_BYTES + 1
    elif case == "wrong-name":
        artifact["name"] += "-ts"
    elif case == "ambiguous":
        api.artifacts.append(artifact | {"id": 34})
    elif case == "policy":
        api.policy["type"] = "symlink"
    elif case == "changed":
        api.data["run_attempt"] = 3
    else:
        api.archive = case
    with pytest.raises(ValueError, match=r"Main |main coverage|tested policy|snapshot counter semantics"):
        pub.publish_snapshot(api, trigger, NOW)
    assert not api.writes
    if case in {"owner", "size", "wrong-name", "ambiguous"}:
        assert artifact["id"] not in api.downloads


@pytest.mark.parametrize("order", [(6, 9), (7, 1), (7, 2), (7, 3), (8, 1)])
def test_only_newer_executions_advance_tip(order: tuple[int, int]) -> None:
    """Compare run number before attempt, not SHA, ID or clock time, even at an expired tip.

    Parameters:
        order (tuple[int, int]): Prior run number and attempt.
    Returns:
        None.
    Raises:
        None.
    """
    api = MainGitHub()
    pub.publish_snapshot(api, api.data, NOW)
    old = json.loads(api.raw) | {
        "number": order[0],
        "attempt": order[1],
        "measured_at": "2026-01-01T00:00:00Z",
    }
    api.seed_snapshot(json.dumps(old).encode())
    api.writes.clear()
    pub.publish_snapshot(api, api.data, NOW)
    if order < (7, 2):
        assert api.writes[1][2]["parents"] == [TIP]
        assert api.writes[-1] == ("git/refs/heads/coverage-data", "PATCH", {"sha": HEAD, "force": False})
    else:
        assert not api.writes


@pytest.mark.parametrize("has_snapshot", [False, True])
def test_new_snapshot_preserves_sibling_file(has_snapshot: bool) -> None:
    """Overlay only the snapshot and retain the sibling's existing blob and mode.

    Parameters:
        has_snapshot (bool): Whether the branch already has a baseline.
    Returns:
        None.
    Raises:
        None.
    """
    api = MainGitHub()
    pub.publish_snapshot(api, api.data, NOW)
    api.seed_snapshot(json.dumps(json.loads(api.raw) | {"number": 6}).encode())
    if not has_snapshot:
        api.tree_entries.clear()
    api.tree_entries.insert(0, SIBLING)
    api.writes.clear()

    pub.publish_snapshot(api, api.data, NOW)

    assert api.writes[0][2]["base_tree"] == BASE_TREE
    assert api.tree_entries[1:] == [SIBLING]
    baseline = snap.baseline(api, NOW)
    assert baseline is not None
    assert baseline.order == (7, 2)


@pytest.mark.parametrize(
    ("race", "other_order", "expected_order", "writes"),
    [
        ("advance", 6, 7, 2),
        ("advance", 8, 8, 1),
        ("contended", 6, 6, 3),
    ],
)
@pytest.mark.parametrize("conflict_code", [422, 409])
def test_retry_when_existing_ref_advances(
    race: str, other_order: int, expected_order: int, writes: int, conflict_code: int
) -> None:
    """Rebase a still-newer snapshot, skip stale candidates, and bound retries.

    Parameters:
        race (str): Once or repeatedly advance the competing writer.
        other_order (int): Competing snapshot's run number.
        expected_order (int): Readable run number after the update.
        writes (int): Expected PATCH attempts.
        conflict_code (int): HTTP status used for the competing ref update.
    Returns:
        None.
    Raises:
        AssertionError: A conflicting update loses assets, retries without bounds, or publishes stale data.
    """
    api = MainGitHub()
    pub.publish_snapshot(api, api.data, NOW)
    api.seed_snapshot(json.dumps(json.loads(api.raw) | {"number": 5}).encode())
    api.writes.clear()
    api.race = race
    api.competing_order = other_order
    api.conflict_code = conflict_code
    if race == "contended":
        with pytest.raises(ValueError, match="changed on every write attempt"):
            pub.publish_snapshot(api, api.data, NOW)
    else:
        pub.publish_snapshot(api, api.data, NOW)
    assert [method for _, method, _ in api.writes].count("PATCH") == writes
    assert api.tree_entries[1:] == [SIBLING]
    baseline = snap.baseline(api, NOW)
    assert baseline is not None
    assert baseline.order == (expected_order, 2)


@pytest.mark.parametrize("conflict_code", [409, 422])
def test_conflict_with_unchanged_existing_tip_aborts(conflict_code: int) -> None:
    """Reread the ref and do not retry a rejected PATCH when the tip did not move.

    Parameters:
        conflict_code (int): HTTP status returned by the rejected PATCH.
    Returns:
        None.
    Raises:
        AssertionError: The publisher did not stop after rereading the unchanged ref.
    """
    api = MainGitHub()
    pub.publish_snapshot(api, api.data, NOW)
    api.seed_snapshot(json.dumps(json.loads(api.raw) | {"number": 6}).encode())
    api.reads.clear()
    api.writes.clear()
    api.race = "unchanged"
    api.conflict_code = conflict_code

    with pytest.raises(ValueError, match="Coverage snapshot ref update rejected without a concurrent change"):
        pub.publish_snapshot(api, api.data, NOW)

    assert api.reads.count(snap.REF_API) == 2
    assert [method for _, method, _ in api.writes] == ["POST", "POST", "PATCH"]
    assert api.ref["object"]["sha"] == TIP


def test_first_publish_conflict_preserves_newer_snapshot() -> None:
    """Yield to a newer snapshot installed before the first ref POST completes.

    Parameters:
        None.
    Returns:
        None.
    Raises:
        AssertionError: The publisher overwrote the newer snapshot or did not reread the new ref.
    """
    api = MainGitHub()
    api.race = "first-publish"

    pub.publish_snapshot(api, api.data, NOW)

    assert api.reads.count(snap.REF_API) == 2
    assert api.reads.count(f"git/commits/{TIP}") == 1
    assert [(path, method) for path, method, _ in api.writes] == [
        ("git/trees", "POST"),
        ("git/commits", "POST"),
        ("git/refs", "POST"),
    ]
    baseline = snap.baseline(api, NOW)
    assert baseline is not None
    assert (baseline.order, baseline.run_id, baseline.sha) == ((8, 2), 456, BLOB)


def test_rejected_update_keeps_old_baseline_readable() -> None:
    """Leave the old snapshot readable when the proposed ref update is denied.

    Parameters:
        None.
    Returns:
        None.
    Raises:
        AssertionError: The rejected update replaces the old snapshot.
    """
    api = MainGitHub()
    pub.publish_snapshot(api, api.data, NOW)
    api.seed_snapshot(json.dumps(json.loads(api.raw) | {"number": 6}).encode())
    before = snap.baseline(api, NOW)
    assert before is not None
    api.race = "forbidden"

    with pytest.raises(HTTPError, match="403"):
        pub.publish_snapshot(api, api.data, NOW)

    assert snap.baseline(api, NOW) == before


@pytest.mark.parametrize("race", ["ref", "attempt"])
def test_race_cannot_move_ref(race: str) -> None:
    """Reject concurrent ref creation and attempts that change after producing the commit.

    Parameters:
        race (str): Concurrent change to simulate.
    Returns:
        None.
    Raises:
        None.
    """
    api = MainGitHub()
    api.race = race
    with pytest.raises(
        (HTTPError, ValueError),
        match=r"Recording transport|changed during publication|without a concurrent change",
    ):
        pub.publish_snapshot(api, api.data, NOW)
    assert not api.ref
    if race == "attempt":
        assert [path for path, _, _ in api.writes] == ["git/trees", "git/commits"]


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("schema", True),
        ("repository", "fork/pi-harness"),
        ("sha", "../main"),
        ("run", 0),
        ("number", True),
        ("attempt", 10**20),
        ("hosts", {}),
    ],
)
def test_invalid_snapshot_identity(field: str, value: object) -> None:
    """Reject malformed or cross-repository stored identity.

    Parameters:
        field (str): Identity field to change.
        value (object): Invalid replacement.
    Returns:
        None.
    Raises:
        None.
    """
    api = MainGitHub()
    pub.publish_snapshot(api, api.data, NOW)
    with pytest.raises(ValueError, match=r"Invalid |Unexpected snapshot hosts|Cannot decode JSON"):
        snap.Snapshot.parse(json.dumps(json.loads(api.raw) | {field: value}).encode(), REPO)


@pytest.mark.parametrize(
    "case",
    [
        "truncated",
        "wrong-tree",
        "duplicate",
        "symlink",
        "oversized",
        "sha",
        "blob",
        "encoded",
        "decoded",
        "raw",
    ],
)
def test_invalid_stored_data_is_unavailable(case: str) -> None:
    """Handle short, hostile or malformed Git responses without rendering their numbers.

    Parameters:
        case (str): Invalid stored response case.
    Returns:
        None.
    Raises:
        None.
    """
    api = MainGitHub()
    pub.publish_snapshot(api, api.data, NOW)
    entry = api.tree_entries[0]
    if case == "truncated":
        api.tree_metadata["truncated"] = True
    elif case == "wrong-tree":
        api.tree_metadata["sha"] = TREE
    elif case == "duplicate":
        api.tree_entries.append(entry)
    elif case == "symlink":
        entry["mode"] = "120000"
    elif case == "oversized":
        entry["size"] = snap.MAX_BYTES + 1
        with pytest.raises(ValueError, match="byte limit"):
            snap.Snapshot.parse(b"x" * (snap.MAX_BYTES + 1), REPO)
    elif case == "sha":
        entry["sha"] = "../blob"
    elif case == "blob":
        api.blob["encoding"] = "utf-8"
    elif case in {"encoded", "decoded"}:
        entry["size"] = api.blob["size"] = 2
        api.blob["content"] = "YQ==" if case == "decoded" else ""
    else:
        api.seed_snapshot(b"{bad json}")
    assert snap.baseline(api, NOW) is None
    if case in {"truncated", "wrong-tree", "duplicate", "symlink", "oversized", "sha"}:
        assert not any(path.startswith("git/blobs/") for path in api.reads)
    api.writes.clear()
    with pytest.raises(ValueError, match=r"snapshot|Git object|Cannot decode JSON"):
        pub.publish_snapshot(api, api.data, NOW)
    assert not api.writes


@pytest.mark.parametrize(
    "entry",
    [
        {"state": "NOT RUN"},
        {"counters": {}},
        {"counters": {"invented": 1}},
        {"source_root": "foo"},
    ],
)
def test_invalid_snapshot_counters(entry: dict[str, Any]) -> None:
    """Do not let cached counters bypass typed, planned-signal validation.

    Parameters:
        entry (dict[str, Any]): Invalid signal fields.
    Returns:
        None.
    Raises:
        None.
    """
    value = {
        "enforcement": "enforced",
        "state": "planned",
        "semantics": "lcov",
        "counters": {"lines": 1, "uncovered_lines": 1},
    }
    with pytest.raises(ValueError, match="snapshot"):
        snap.snapshot_cell(
            "ubuntu-24.04", {SEMANTICS_FIELD: FINGERPRINT, "signals": {"p/primary": value | entry}}
        )


def test_empty_host_and_unexpected_ref() -> None:
    """Reject snapshots with no measurements and prefix matches from the ref endpoint.

    Parameters:
        None.
    Returns:
        None.
    Raises:
        None.
    """
    with pytest.raises(ValueError, match="Empty snapshot host"):
        snap.snapshot_cell("ubuntu-24.04", {SEMANTICS_FIELD: FINGERPRINT, "signals": {}})
    with pytest.raises(ValueError, match="Unexpected snapshot host fields"):
        snap.snapshot_cell("ubuntu-24.04", {SEMANTICS_FIELD: FINGERPRINT, "signals": {}, "extra": True})
    api = MainGitHub()
    api.ref.update(ref=snap.REF + "-unexpected", object={"type": "commit", "sha": TIP})
    with pytest.raises(ValueError, match="Unexpected coverage data ref"):
        snap.read_tip(api)


def test_snapshot_cli(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Use the snapshot entry point only when explicitly selected by the job.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): Scoped CLI environment.
        tmp_path (Path): Private event directory.
    Returns:
        None.
    Raises:
        None.
    """
    api = MainGitHub()
    event = tmp_path / "event"
    event.write_text(json.dumps({"workflow_run": api.data}))
    monkeypatch.setenv("GITHUB_REPOSITORY", REPO)
    monkeypatch.setenv("GITHUB_EVENT_PATH", str(event))
    monkeypatch.setenv("GH_TOKEN", "synthetic-token")
    monkeypatch.setenv("COVERAGE_SNAPSHOT", "1")
    monkeypatch.setattr(pub, "GitHub", lambda *_: api)
    monkeypatch.setattr(pub, "datetime", FixedClock)
    assert pub.main() == 0
    assert api.ref["ref"] == snap.REF
    api.ref.clear()
    monkeypatch.setattr(
        api.__class__, "request", lambda self, path: (_ for _ in ()).throw(http_error(path, 403))
    )
    assert pub.main() == 1
    assert not api.ref
