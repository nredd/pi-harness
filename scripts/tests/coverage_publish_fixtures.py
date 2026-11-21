"""Share the recording publisher API and retained coverage fixtures.

References:
    https://github.com/nredd/pi-harness/actions/runs/44104072624
    https://github.com/nredd/pi-harness/issues/1001
"""

from __future__ import annotations

import json
import sys
from email.message import Message
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from zipfile import ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import coverage_publish as pub
from coverage_provenance_record import SEMANTICS_FIELD, Provenance, producer_job

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).parent / "fixtures/coverage-report/coverage-ubuntu-24.04.json"
REPO = "nredd/pi-harness"
FORK = "contributor/pi-harness"
HEAD = "a" * 40
TESTED = "b" * 40
POLICY = ROOT / "coverage/policy.json"
UPLOAD = "Preserve independent coverage reports and summary"
ARTIFACT = pub.ARTIFACT.format(host="ubuntu-24.04")
FINGERPRINT = "e" * 64
STAMP = "2026-11-20T04:50:01Z"


def run_data(**overrides: Any) -> dict[str, Any]:
    """Build GitHub's fork run metadata with its empty PR array.

    Parameters:
        **overrides (Any): Fields replacing the default run metadata.
    Returns:
        dict[str, Any]: GitHub run metadata with the requested overrides.
    Raises:
        AssertionError: An expected contract does not hold.
    """
    return {
        "id": 123,
        "run_number": 7,
        "run_attempt": 2,
        "workflow_id": 12,
        "status": "completed",
        "conclusion": "success",
        "head_sha": HEAD,
        "head_branch": "topic/fix",
        "event": "pull_request",
        "path": pub.WORKFLOW,
        "head_repository": {"full_name": FORK},
        "pull_requests": [],
    } | overrides


class RecordingGitHub(pub.GitHub):
    """Record exact API writes while exercising real rendering and archive validation."""

    data: dict[str, Any]
    peers: list[Any]
    pulls: list[Any]
    comments: list[Any]
    writes: list[tuple[str, str, dict[str, str]]]
    jobs: list[Any]
    artifacts: list[Any]
    record: dict[str, object] | None
    fingerprint: str | None

    def __init__(self) -> None:
        """Seed one current attempt, PR and artifact.

        Parameters:
            None.
        Returns:
            None: Contract holds.
        Raises:
            AssertionError: An expected contract does not hold.
        """
        super().__init__(REPO, "synthetic-token")
        self.data = run_data()
        self.peers = [self.data, run_data(id=222, run_number=6)]
        self.pulls = [
            {
                "number": 4,
                "state": "open",
                "merge_commit_sha": TESTED,
                "head": {"ref": "topic/fix", "sha": HEAD, "repo": {"full_name": FORK}},
                "base": {"ref": "main", "repo": {"full_name": REPO}},
            }
        ]
        self.comments = []
        self.writes = []
        self.jobs = [
            {
                "name": "owned (ubuntu-24.04)",
                "conclusion": "success",
                "steps": [
                    {"name": "Report execution plan", "conclusion": "success"},
                    {"name": UPLOAD, "conclusion": "success", "started_at": STAMP, "completed_at": STAMP},
                ],
            }
        ]
        self.artifacts = [
            {
                "name": ARTIFACT,
                "id": 8,
                "size_in_bytes": 9900,
                "expired": False,
                "created_at": STAMP,
            }
        ]
        run = Provenance(
            REPO, HEAD, TESTED, 123, 2, "pull_request", f"{REPO}/{pub.WORKFLOW}@refs/pull/4/merge"
        )
        self.record = dict(run.record(producer_job("ubuntu-24.04", shard=False), ARTIFACT))
        self.fingerprint = None

    def request(self, path: str, method: str = "GET", body: dict[str, str] | None = None) -> Any:
        """Return resource data and apply sticky writes to the recording store.

        Parameters:
            path (str): Requested route.
            method (str): Expected HTTP verb.
            body (dict[str, str] | None): Comment payload, if writing.
        Returns:
            Any: Recorded comment or current run metadata.
        Raises:
            AssertionError: An expected contract does not hold.
        """
        if body is not None:
            self.writes.append((path, method, body))
            current = {"id": 17, "user": {"id": pub.BOT_ID}, "body": body["body"]}
            if method == "POST":
                self.comments.append(current)
            else:
                self.comments[-1] = current
            return current
        if path == "git/ref/heads/coverage-data":
            raise HTTPError(path, 404, "Missing branch", Message(), None)
        assert path == "actions/runs/123"
        return self.data

    def pages(self, path: str, key: str | None = None, **params: str) -> list[Any]:
        """Verify the publisher scopes every census to the expected resource.

        Parameters:
            path (str): Requested route.
            key (str | None): Optional list envelope key.
            **params (str): Expected API query filters.
        Returns:
            list[Any]: Rows for the requested GitHub collection.
        Raises:
            AssertionError: An expected contract does not hold.
        """
        if path == "pulls":
            owner = self.data["head_repository"]["full_name"].split("/")[0]
            assert params == {"head": f"{owner}:topic/fix", "state": "open"}
            return self.pulls
        if path == "actions/workflows/12/runs":
            assert params == {"event": "pull_request", "branch": "topic/fix", "head_sha": HEAD}
            return self.peers
        return {
            "actions/runs/123/attempts/2/jobs": self.jobs,
            "actions/runs/123/artifacts": self.artifacts,
            "issues/4/comments": self.comments,
        }[path]

    def download(self, artifact_id: int, destination: Path) -> None:
        """Package real fixture counts with the synthetic attempt metadata.

        Parameters:
            artifact_id (int): Expected artifact ID from the listing.
            destination (Path): ZIP path the renderer will read.
        Returns:
            None: Contract holds.
        Raises:
            AssertionError: An expected contract does not hold.
        """
        assert artifact_id == 8
        with ZipFile(destination, "w") as archive:
            summary = json.loads(FIXTURE.read_text())
            semantics = {} if self.fingerprint is None else {SEMANTICS_FIELD: self.fingerprint}
            archive.writestr("coverage/summary.json", json.dumps(summary | semantics))
            if self.record is not None:
                archive.writestr("coverage/provenance.json", json.dumps(self.record | semantics))
