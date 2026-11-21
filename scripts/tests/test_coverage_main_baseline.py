"""Exercise retained main coverage selection without network writes or a clock.

References:
    https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow
    https://github.com/nredd/pi-harness/pull/1165
"""

from __future__ import annotations

import io
import json
import signal
from email.message import Message
from http.client import IncompleteRead
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
from zipfile import ZipFile

import pytest
from coverage_publish_fixtures import (
    FINGERPRINT,
    FIXTURE,
    FORK,
    POLICY,
    REPO,
    STAMP,
    UPLOAD,
    RecordingGitHub,
    run_data,
)

import coverage_publish as pub
from coverage_provenance_record import SEMANTICS_FIELD, Provenance, producer_job

REPOSITORY = {"id": 92, "full_name": REPO, "fork": False}
UBUNTU = "ubuntu-24.04"
MACOS = "macos-14"
HOSTS = (UBUNTU, MACOS)


def main_push(number: int, **overrides: Any) -> dict[str, Any]:
    """Build a main run listing entry; ordinals describe push order, not finish order.

    Parameters:
        number (int): Push ordinal.
        **overrides (Any): Replacement API fields.
    Returns:
        dict[str, Any]: Workflow run metadata.
    Raises:
        None.
    """
    return run_data(
        **(
            {
                "id": 200 + number,
                "run_number": number,
                "head_sha": f"{number:040x}",
                "event": "push",
                "head_branch": "main",
                "repository": REPOSITORY,
                "head_repository": REPOSITORY,
                "created_at": f"2026-11-20T04:40:{number:02}Z",
                "updated_at": f"2026-11-20T04:51:{59 - number:02}Z",
            }
            | overrides
        )
    )


class MainGitHub(RecordingGitHub):
    """Serve bounded GitHub listing envelopes and realistic attempt artifacts."""

    def __init__(self) -> None:
        """Seed a main run with two fan-ins and a fork PR with its own artifact.

        Parameters:
            None.
        Returns:
            None.
        Raises:
            None.
        """
        super().__init__()
        self.runs: list[dict[str, Any]] = []
        self.listed: dict[str, dict[str, Any]] = {}
        self.reads: list[str] = []
        self.downloads: list[int] = []
        self.archives: dict[int, tuple[dict[str, Any], str]] = {}
        self.failure = ""
        self.fingerprint = FINGERPRINT

    def add(self, run: dict[str, Any], *, cancelled: bool = False) -> tuple[list[Any], list[Any]]:
        """Add a run and its attempt-specific producer jobs and retained artifacts.

        Parameters:
            run (dict[str, Any]): Workflow run metadata.
            cancelled (bool): Omit the macOS artifact and cancel a shard.
        Returns:
            tuple[list[Any], list[Any]]: Job and artifact lists.
        Raises:
            None.
        """
        self.runs.append(run)
        jobs: list[Any] = []
        artifacts: list[Any] = []
        for index, host in enumerate(HOSTS):
            if cancelled and host == MACOS:
                jobs.extend(
                    [
                        {"name": "owned shard (macos-14, ts)", "conclusion": "cancelled", "steps": []},
                        {"name": "owned (macos-14)", "conclusion": "skipped", "steps": []},
                    ]
                )
                continue
            jobs.append(
                {
                    "name": f"owned ({host})",
                    "conclusion": "success",
                    "steps": [
                        {
                            "name": UPLOAD,
                            "conclusion": "success",
                            "started_at": "2026-11-20T04:50:00Z",
                            "completed_at": STAMP,
                        }
                    ],
                }
            )
            artifact_id = run["id"] * 10 + index
            self.archives[artifact_id] = run, host
            artifacts.append(
                {
                    "name": f"coverage-{host}",
                    "id": artifact_id,
                    "size_in_bytes": 10_000,
                    "expired": False,
                    "created_at": STAMP,
                    "expires_at": "2027-02-18T04:50:01Z",
                    "workflow_run": {
                        "id": run["id"],
                        "head_sha": run["head_sha"],
                        "head_branch": "main",
                        "repository_id": 92,
                        "head_repository_id": 92,
                    },
                }
            )
        route = f"actions/runs/{run['id']}"
        self.listed[f"{route}/attempts/{run['run_attempt']}/jobs"] = {"jobs": jobs}
        self.listed[f"{route}/artifacts"] = {"artifacts": artifacts}
        return jobs, artifacts

    def request(
        self,
        path: str,
        method: str = "GET",
        body: dict[str, Any] | None = None,
        *,
        timeout: float = pub.REQUEST_SECONDS,
    ) -> Any:
        """Check query bounds and reject any unexpected read or non-comment write.

        Parameters:
            path (str): Requested API route.
            method (str): HTTP verb.
            body (dict[str, Any] | None): Comment payload.
        Returns:
            Any: GitHub-style response envelope.
        Raises:
            AssertionError: Fixture or contract did not match.
        """
        route = urlsplit(path).path
        if route == "actions/runs/123" or method != "GET":
            return super().request(path, method, body)
        self.reads.append(route)
        params = parse_qs(urlsplit(path).query)
        if route == "actions/workflows/12/runs":
            assert params == {
                "event": ["push"],
                "branch": ["main"],
                "status": ["success"],
                "per_page": ["10"],
                "page": ["1"],
            }
            # Newest first, with tests able to inject unexpected rows independently of filters.
            return {"total_count": len(self.runs), "workflow_runs": self.runs[:10]}
        assert params == {"per_page": ["100"], "page": ["1"]}
        listing = self.listed[route]
        (rows,) = listing.values()
        return {"total_count": len(rows), **listing}

    def download(
        self, artifact_id: int, destination: Path, *, deadline: pub.BaselineDeadline | None = None
    ) -> None:
        """Write a producer ZIP or simulate one selected archive failure.

        Parameters:
            artifact_id (int): Artifact from the listing.
            destination (Path): Download target.
        Returns:
            None.
        Raises:
            HTTPError: Injected transport failure.
        """
        self.downloads.append(artifact_id)
        if artifact_id == 8:
            super().download(artifact_id, destination)
            return
        run, host = self.archives[artifact_id]
        summary = json.loads(FIXTURE.read_text())
        if host == MACOS:
            summary["os"] = "darwin"
            for row in summary["files"]:
                row["os"] = "darwin"
        cell = f"coverage-{host}"
        provenance = Provenance(
            REPO,
            None,
            run["head_sha"],
            run["id"],
            run["run_attempt"],
            "push",
            f"{REPO}/{pub.WORKFLOW}@refs/heads/main",
        )
        record = dict(provenance.record(producer_job(host, shard=False), cell))
        summary[SEMANTICS_FIELD] = record[SEMANTICS_FIELD] = FINGERPRINT
        if host == UBUNTU:
            if self.failure == "download":
                raise HTTPError("hidden", 410, "expired", Message(), None)
            if self.failure == "sidecar":
                record["run_attempt"] = 1
            record[SEMANTICS_FIELD] = {"fingerprint": "f" * 64, "malformed-fingerprint": "invalid"}.get(
                self.failure, FINGERPRINT
            )
            if self.failure == "legacy":
                del summary[SEMANTICS_FIELD], record[SEMANTICS_FIELD]
            if self.failure == "os":
                summary["os"] = "darwin"
                for row in summary["files"]:
                    row["os"] = "darwin"
            if self.failure == "diagnostic":
                summary["measurement_only"] = True
            if self.failure == "errors":
                summary["errors"] = ["accounting failed"]
        with ZipFile(destination, "w") as archive:
            archive.writestr("coverage/summary.json", json.dumps(summary))
            archive.writestr("coverage/provenance.json", json.dumps(record))


def test_recency_and_cancelled_mac_walkback(tmp_path: Path) -> None:
    """Link independent hosts on the sticky comment and summary, ignoring newer ineligible runs.

    Parameters:
        tmp_path (Path): Isolated summary directory.
    Returns:
        None.
    Raises:
        AssertionError: Fixture or contract did not match.
    """
    api = MainGitHub()
    newest, older = main_push(20, run_attempt=3, created_at="2026-11-20T04:40:01Z"), main_push(18)
    api.runs.extend(
        [
            main_push(30, status="in_progress", conclusion=None),
            main_push(29, conclusion="failure"),
            main_push(28, conclusion="cancelled"),
            main_push(27, event="pull_request"),
            main_push(26, head_repository={"id": 90, "full_name": FORK, "fork": True}),
        ]
    )
    _, retained = api.add(newest, cancelled=True)
    jobs, gap = api.add(main_push(19))
    jobs[-1]["steps"].append({"name": UPLOAD, "conclusion": "skipped"})
    gap.pop()  # No macOS artifact, even though this intermediate run has no cancellation.
    _, earlier = api.add(older)
    retained.append(
        earlier[-1]
        | {
            "id": 2201,
            "created_at": "2026-11-20T04:49:59Z",
            "workflow_run": retained[0]["workflow_run"],
        }
    )  # Retained from attempt 1; GitHub lists artifacts across all attempts.
    api.runs[-3:] = [older, newest, api.runs[-2]]
    summary = tmp_path / "summary.md"
    pub.publish(api, pub.Run.parse(api.data), POLICY, summary)
    (write,) = api.writes
    assert write[:2] == ("issues/4/comments", "POST")
    body = write[2]["body"]
    for label, run in [("Ubuntu", newest), ("macOS", older)]:
        assert (
            f"{label} measured main baseline (producer-reported, not independently verified): "
            f"[`{run['head_sha']}`](https://github.com/{REPO}/commit/{run['head_sha']}) "
            f"([CI run {run['id']}, attempt {run['run_attempt']}]"
            f"(https://github.com/{REPO}/actions/runs/{run['id']}/attempts/{run['run_attempt']}))."
        ) in body
    assert "not the PR merge base" in body
    assert pub.PR_NOTICE in body
    assert pub.SCHEDULE in body
    assert "lines +0, functions +0, branches +0" in body
    assert api.downloads == [8, 2200, 2181]
    assert api.reads == [
        "actions/workflows/12/runs",
        "actions/runs/220/attempts/3/jobs",
        "actions/runs/220/artifacts",
        "actions/runs/219/attempts/2/jobs",
        "actions/runs/219/artifacts",
        "actions/runs/218/attempts/2/jobs",
        "actions/runs/218/artifacts",
    ]
    assert summary.read_text() == body + "\n"


@pytest.mark.parametrize(
    "mutation",
    [
        {"id": 123},
        {"workflow_id": 99},
        {"path": ".github/workflows/other.yml"},
        {"event": "workflow_dispatch"},
        {"status": "in_progress"},
        {"head_branch": "topic"},
        {"head_repository": REPOSITORY | {"full_name": FORK}},
        {"pull_requests": [{"number": 4}]},
        {"repository": REPOSITORY | {"full_name": FORK}},
        {"repository": REPOSITORY | {"fork": True}},
        {"head_repository": REPOSITORY | {"fork": True}},
        {"head_repository": REPOSITORY | {"id": 93}},
        {"head_repository": None},
        {"repository": REPOSITORY | {"id": True}},
        {"repository": REPOSITORY | {"id": 0}},
    ],
)
def test_rejects_ineligible_run(mutation: dict[str, Any]) -> None:
    """Reject the PR run itself and invalid identities before looking up any artifacts.

    Parameters:
        mutation (dict[str, Any]): Ineligible run metadata overrides.
    Returns:
        None.
    Raises:
        AssertionError: Fixture or contract did not match.
    """
    api = MainGitHub()
    api.runs.append(main_push(20, **mutation))
    assert not pub.main_baselines(api, pub.Run.parse(api.data), pub.read_summary(POLICY))
    assert api.reads == ["actions/workflows/12/runs"]
    assert not api.downloads


def test_non_main_pr_base_still_compares_to_main(tmp_path: Path) -> None:
    """Compare a same-repository PR targeting another branch to the main push.

    Parameters:
        tmp_path (Path): Isolated summary directory.
    Returns:
        None.
    Raises:
        AssertionError: Publication used a different baseline.
    """
    api = MainGitHub()
    api.data["head_repository"] = REPOSITORY
    api.pulls[0]["head"]["repo"] = REPOSITORY
    api.pulls[0]["base"]["ref"] = "maintenance"
    source = main_push(20)
    api.add(source)
    pub.publish(api, pub.Run.parse(api.data), POLICY, tmp_path / "summary.md")
    (write,) = api.writes
    assert f"/commit/{source['head_sha']}" in write[2]["body"]
    assert "lines +0, functions +0, branches +0" in write[2]["body"]


@pytest.mark.parametrize(
    "failure",
    [
        "expired",
        "missing",
        "duplicate",
        "foreign",
        "download",
        "sidecar",
        "fingerprint",
        "malformed-fingerprint",
        "os",
        "diagnostic",
        "errors",
        "job",
        "timestamp",
        "timezone",
        "no-zip",
    ],
)
def test_invalid_host_does_not_fail_or_reuse_older_ubuntu(
    failure: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Degrade only the damaged host and still write the sticky comment and step summary.

    Parameters:
        failure (str): Evidence corruption to simulate.
        tmp_path (Path): Isolated summary directory.
        monkeypatch (pytest.MonkeyPatch): Scoped test override.
    Returns:
        None.
    Raises:
        AssertionError: Fixture or contract did not match.
    """
    api = MainGitHub()
    api.failure = failure
    jobs, artifacts = api.add(main_push(20))
    api.add(main_push(19))
    if failure == "expired":
        artifacts[0]["expired"] = True
    elif failure == "missing":
        del artifacts[0]
    elif failure == "duplicate":
        artifacts.append(artifacts[0] | {"id": 999})
    elif failure == "foreign":
        artifacts[0]["workflow_run"]["head_repository_id"] = 93
    elif failure == "job":
        jobs[0]["conclusion"] = "failure"
    elif failure == "timestamp":
        artifacts[0]["created_at"] = "2026-11-20T04:49:59Z"
    elif failure == "timezone":
        artifacts[0]["created_at"] = "2026-11-20T04:50:01+01:00"
    elif failure == "no-zip":
        monkeypatch.setattr(pub, "read_host_summary", lambda *args: None)
    summary = tmp_path / "summary.md"
    pub.publish(api, pub.Run.parse(api.data), POLICY, summary)
    body = api.comments[0]["body"]
    assert "Ubuntu measured main baseline: unavailable." in body
    if failure != "no-zip":
        assert "macOS measured main baseline (producer-reported" in body
    assert "Ubuntu enforced signals: 34/34 zero uncovered" in body
    assert summary.read_text() == body + "\n"
    assert len(api.reads) == 3


@pytest.mark.parametrize("status", [302, 404])
def test_baseline_http_failure_still_posts(
    status: int, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Use the real downloader and fail after writing a chunk, or on a deleted artifact.

    Parameters:
        status (int): Artifact endpoint response status.
        tmp_path (Path): Isolated summary directory.
        monkeypatch (pytest.MonkeyPatch): Scoped test override.
    Returns:
        None.
    Raises:
        AssertionError: The comment did not degrade only the affected host.
    """
    api = MainGitHub()
    api.add(main_push(20))
    request = api.request
    download = api.download

    def artifact_request(path: str, *args: Any, **kwargs: Any) -> Any:
        """Serve a signed redirect or a 404 for the Ubuntu baseline."""
        if path == "actions/artifacts/2200/zip":
            headers = Message()
            headers["Location"] = "https://artifact.example/coverage.zip"
            raise HTTPError(path, status, "fixture", headers, None)
        return request(path, *args, **kwargs)

    def download_ubuntu(artifact_id: int, destination: Path, **kwargs: Any) -> None:
        """Exercise the normal transport boundary only for the affected artifact."""
        if artifact_id == 2200:
            try:
                pub.GitHub.download(api, artifact_id, destination, **kwargs)
            finally:
                assert not destination.exists()
        else:
            download(artifact_id, destination, **kwargs)

    class Truncated(io.BytesIO):
        """Return one chunk, then fail on the next incomplete chunk."""

        def read(self, size: int | None = -1, /) -> bytes:
            """Read the first chunk before raising a transport-level error."""
            if self.tell():
                raise IncompleteRead(b"partial bytes", 100)
            return super().read(size)

        def open(self, url: str, *, timeout: float) -> Truncated:
            """Act as the anonymous storage opener."""
            assert url == "https://artifact.example/coverage.zip"
            assert 0 < timeout <= 30
            return self

    monkeypatch.setattr(
        MainGitHub, "request", lambda self, *args, **kwargs: artifact_request(*args, **kwargs)
    )
    monkeypatch.setattr(
        MainGitHub, "download", lambda self, *args, **kwargs: download_ubuntu(*args, **kwargs)
    )
    monkeypatch.setattr(pub, "build_opener", lambda _: Truncated(b"first chunk"))
    pub.publish(api, pub.Run.parse(api.data), POLICY, tmp_path / "summary.md")
    (write,) = api.writes
    assert "Ubuntu measured main baseline: unavailable." in write[2]["body"]
    assert "macOS measured main baseline (producer-reported" in write[2]["body"]


@pytest.mark.parametrize("failure", ["http", "bad-list", "oversized", "incomplete"])
def test_bad_census(failure: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """Fail closed on broken and truncated API listings without propagating errors.

    Parameters:
        failure (str): Listing failure to simulate.
        monkeypatch (pytest.MonkeyPatch): Scoped test override.
    Returns:
        None.
    Raises:
        AssertionError: Fixture or contract did not match.
    """
    api = MainGitHub()
    api.add(main_push(20))
    read = MainGitHub.request

    def request(self: MainGitHub, path: str, *, timeout: float) -> Any:
        """Corrupt the requested bounded response.

        Parameters:
            path (str): Requested listing route.
        Returns:
            Any: Corrupted response.
        Raises:
            HTTPError: Injected transport failure.
        """
        data = read(self, path, timeout=timeout)
        if failure == "http":
            raise HTTPError(path, 403, "denied", Message(), None)
        if failure == "bad-list":
            return {"workflow_runs": {}}
        if failure == "oversized":
            return {"workflow_runs": self.runs * 11}
        return data | {"total_count": data["total_count"] + 1}

    monkeypatch.setattr(MainGitHub, "request", request)
    assert not pub.main_baselines(api, pub.Run.parse(api.data), pub.read_summary(POLICY))
    assert not api.downloads


def test_missing_mac_without_cancellation_does_not_walk_back() -> None:
    """Missing macOS evidence alone does not allow an older baseline.

    Parameters:
        None.
    Returns:
        None.
    Raises:
        AssertionError: Fixture or contract did not match.
    """
    api = MainGitHub()
    _, artifacts = api.add(main_push(20))
    artifacts.pop()
    api.add(main_push(19))
    baselines = pub.main_baselines(api, pub.Run.parse(api.data), pub.read_summary(POLICY))
    assert set(baselines) == {UBUNTU}
    assert len(api.reads) == 3


def test_walkback_does_not_reuse_evidence_past_an_expired_artifact() -> None:
    """The first earlier listing with a macOS artifact is authoritative even if expired.

    Parameters:
        None.
    Returns:
        None.
    Raises:
        AssertionError: Fixture or contract did not match.
    """
    api = MainGitHub()
    api.add(main_push(20), cancelled=True)
    _, artifacts = api.add(main_push(19))
    artifacts[-1]["expired"] = True
    api.add(main_push(18))
    baselines = pub.main_baselines(api, pub.Run.parse(api.data), pub.read_summary(POLICY))
    assert set(baselines) == {UBUNTU}
    assert len(api.reads) == 5
    assert api.downloads == [2200]


def test_cancellation_bound() -> None:
    """Cap the walk-back at one run page and two lists per candidate.

    Parameters:
        None.
    Returns:
        None.
    Raises:
        AssertionError: Fixture or contract did not match.
    """
    api = MainGitHub()
    for number in range(30, 20, -1):
        api.add(main_push(number), cancelled=True)
    api.add(main_push(20))
    baselines = pub.main_baselines(api, pub.Run.parse(api.data), pub.read_summary(POLICY), clock=lambda: 0)
    assert set(baselines) == {UBUNTU}
    assert baselines[UBUNTU][0].id == 230
    assert len(api.reads) == 21
    assert api.downloads == [2300]


@pytest.mark.parametrize("interrupt", [False, True])
def test_slow_main_lookup_still_posts(
    interrupt: bool, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Leave time to recheck freshness and post despite a slow baseline census.

    Parameters:
        interrupt (bool): Fire the hard alarm mid-request instead of advancing the clock.
        tmp_path (Path): Isolated summary directory.
        monkeypatch (pytest.MonkeyPatch): Scoped clock and transport overrides.
    Returns:
        None.
    Raises:
        AssertionError: The budget did not cap the lookup or prevent a stale alarm.
    """
    api = MainGitHub()
    for number in range(30, 20, -1):
        api.add(main_push(number), cancelled=True)
    elapsed = 0
    timeouts: list[float] = []
    request = MainGitHub.request
    handler = signal.getsignal(signal.SIGALRM)

    def slow_request(
        self: MainGitHub,
        path: str,
        method: str = "GET",
        body: dict[str, Any] | None = None,
        *,
        timeout: float = 30,
    ) -> Any:
        """Charge 15 seconds for each baseline listing, not for PR requests."""
        nonlocal elapsed
        if "?" in path:
            timeouts.append(timeout)
            if interrupt:
                assert signal.getitimer(signal.ITIMER_REAL)[0] > 0
                signal.raise_signal(signal.SIGALRM)
            elapsed += 15
        return request(self, path, method, body, timeout=timeout)

    monkeypatch.setattr(pub, "monotonic", lambda: elapsed)
    monkeypatch.setattr(MainGitHub, "request", slow_request)
    summary = tmp_path / "summary.md"
    pub.publish(api, pub.Run.parse(api.data), POLICY, summary)
    (write,) = api.writes
    assert timeouts == ([30] if interrupt else [30, 30, 30, 30, 30, 15])
    assert signal.getsignal(signal.SIGALRM) == handler
    assert signal.getitimer(signal.ITIMER_REAL) == (0, 0)
    assert "Main baseline lookup exhausted its 90-second budget." in write[2]["body"]
    for host in ("Ubuntu", "macOS"):
        assert f"{host} measured main baseline: unavailable." in write[2]["body"]
    assert summary.read_text() == write[2]["body"] + "\n"


def test_legacy_baseline_still_has_identity() -> None:
    """Link a legacy baseline but explain why the instruments cannot be compared.

    Parameters:
        None.
    Returns:
        None.
    Raises:
        AssertionError: Fixture or contract did not match.
    """
    api = MainGitHub()
    api.failure = "legacy"
    api.add(main_push(20))
    body = pub.render(api, pub.Run.parse(api.data), 4, api.pulls[0]["merge_commit_sha"], POLICY)
    assert "Ubuntu measured main baseline (producer-reported" in body
    assert "not comparable: missing instrumentation fingerprint" in body
