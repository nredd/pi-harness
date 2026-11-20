"""Exercise the trusted publisher with a recording API and retained hosted coverage data.

References:
    https://github.com/nredd/pi-harness/actions/runs/44104072624
    https://github.com/nredd/pi-harness/issues/1001
"""

from __future__ import annotations

import copy
import io
import json
import runpy
import sys
from email.message import Message
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
from zipfile import ZipFile

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import coverage_publish as pub
from coverage_report import Provenance, producer_job

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).parent / "fixtures/coverage-report/coverage-ubuntu-24.04.json"
REPO = "nredd/pi-harness"
FORK = "contributor/pi-harness"
HEAD = "a" * 40
TESTED = "b" * 40
POLICY = ROOT / "coverage/policy.json"
UPLOAD = "Preserve independent coverage reports and summary"
STAMP = "2026-11-20T04:50:01Z"


def run_data(**overrides: Any) -> dict[str, Any]:
    """Build GitHub's fork run metadata with its empty PR array.

    Parameters:
        **overrides (Any): Input to the test fixture.
    Returns:
        dict[str, Any]: Test fixture result.
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
                "name": pub.ARTIFACT,
                "id": 8,
                "size_in_bytes": 9900,
                "expired": False,
                "created_at": STAMP,
            }
        ]
        self.record = Provenance(
            REPO, HEAD, TESTED, 123, 2, "pull_request", f"{REPO}/{pub.WORKFLOW}@refs/pull/4/merge"
        ).record(producer_job(pub.ARTIFACT, shard=False), pub.ARTIFACT)

    def request(self, path: str, method: str = "GET", body: dict[str, str] | None = None) -> Any:
        """Return resource data and apply sticky writes to the recording store.

        Parameters:
            path (str): Requested route.
            method (str): Input to the test fixture.
            body (dict[str, str] | None): Input to the test fixture.
        Returns:
            Any: Test fixture result.
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
        assert path == "actions/runs/123"
        return self.data

    def pages(self, path: str, key: str | None = None, **params: str) -> list[Any]:
        """Verify the publisher scopes every census to the expected resource.

        Parameters:
            path (str): Requested route.
            key (str | None): Input to the test fixture.
            **params (str): Input to the test fixture.
        Returns:
            list[Any]: Test fixture result.
        Raises:
            AssertionError: An expected contract does not hold.
        """
        if path == "pulls":
            assert params == {"head": "contributor:topic/fix", "state": "open"}
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
            artifact_id (int): Input to the test fixture.
            destination (Path): Input to the test fixture.
        Returns:
            None: Contract holds.
        Raises:
            AssertionError: An expected contract does not hold.
        """
        assert artifact_id == 8
        with ZipFile(destination, "w") as archive:
            archive.write(FIXTURE, "coverage/summary.json")
            if self.record is not None:
                archive.writestr("coverage/provenance.json", json.dumps(self.record))


def test_sticky_fork_comment_and_retry(tmp_path: Path) -> None:
    """Post once, then PATCH the bot's comment, never a user's copied marker.

    Parameters:
        tmp_path (Path): Isolated test directory.
    Returns:
        None: Contract holds.
    Raises:
        AssertionError: An expected contract does not hold.
    """
    api = RecordingGitHub()
    api.comments.append({"id": 10, "user": {"id": 99}, "body": pub.MARKER + "\ncopy"})
    run = pub.Run.parse(api.data)
    summary = tmp_path / "summary"
    pub.publish(api, run, POLICY, summary)
    pub.publish(api, run, POLICY, summary)
    assert len(api.comments) == 2
    assert [(path, method) for path, method, _ in api.writes] == [
        ("issues/4/comments", "POST"),
        ("issues/comments/17", "PATCH"),
    ]
    body = api.comments[-1]["body"]
    assert "Ubuntu enforced signals: 34/34 zero uncovered (measured counters only)" in body
    assert pub.SCHEDULE in body
    assert f"tested: {TESTED}" in body
    assert len(body) <= 60_000
    assert summary.read_text() == (body + "\n") * 2


@pytest.mark.parametrize(
    "case",
    [
        "ambiguous",
        "closed",
        "head",
        "repo",
        "ref",
        "fork",
        "attached",
        "no-sha",
        "head-sha",
        "invalid-sha",
    ],
)
def test_pr_identity(case: str) -> None:
    """Reject mismatched PR identity; missing merge identity never passes as tested SHA.

    Parameters:
        case (str): Scenario under test.
    Returns:
        None: Contract holds.
    Raises:
        AssertionError: An expected contract does not hold.
    """
    api = RecordingGitHub()
    pr = api.pulls[0]
    if case == "ambiguous":
        api.pulls.append(copy.deepcopy(pr))
    elif case == "closed":
        pr["state"] = "closed"
    elif case == "head":
        pr["head"]["sha"] = TESTED
    elif case == "repo":
        pr["base"]["repo"]["full_name"] = FORK
    elif case == "ref":
        pr["head"]["ref"] = "another-branch"
    elif case == "fork":
        pr["head"]["repo"]["full_name"] = REPO
    elif case == "attached":
        api.data["pull_requests"] = [{"number": 25}]
    else:
        pr["merge_commit_sha"] = {"no-sha": None, "head-sha": HEAD, "invalid-sha": "bad"}[case]
    expected = (4, None) if case in {"no-sha", "head-sha", "invalid-sha"} else None
    assert pub.current_pr(api, pub.Run.parse(api.data)) == expected


@pytest.mark.parametrize(
    "mutation",
    [
        {"event": "push"},
        {"path": "other.yml"},
        {"id": True},
        {"head_sha": "bad"},
        {"head_repository": {"full_name": "bad"}},
        {"head_branch": ""},
    ],
)
def test_invalid_run(mutation: dict[str, Any]) -> None:
    """Reject malformed identity instead of constructing API paths or links from it.

    Parameters:
        mutation (dict[str, Any]): Input to the test fixture.
    Returns:
        None: Contract holds.
    Raises:
        AssertionError: An expected contract does not hold.
    """
    with pytest.raises(ValueError, match=r"CI run|run identity"):
        pub.Run.parse(run_data(**mutation))


def test_latest_run_order() -> None:
    """Queued runs and reruns supersede older attempts regardless of completion order.

    Parameters:
        None.
    Returns:
        None: Contract holds.
    Raises:
        AssertionError: An expected contract does not hold.
    """
    api = RecordingGitHub()
    run = pub.Run.parse(api.data)
    api.peers.extend([run_data(head_repository=None), run_data(head_repository={"full_name": REPO})])
    assert pub.is_latest(api, run)
    api.peers.append(run_data(id=555, run_number=8, status="queued"))
    assert not pub.is_latest(api, run)
    api.data["run_attempt"] += 1
    assert not pub.is_latest(api, run)
    api.data["status"] = "queued"
    assert not pub.is_latest(api, pub.Run.parse(api.data))
    api.data["status"] = "completed"
    api.peers.clear()
    assert not pub.is_latest(api, pub.Run.parse(api.data))


@pytest.mark.parametrize(
    "case",
    [
        "none",
        "duplicate-job",
        "skipped",
        "failed",
        "cancelled",
        "no-start",
        "no-end",
        "wrong-name",
        "expired",
        "old",
        "oversize",
        "duplicate-artifact",
    ],
)
def test_artifact_attempt_filter(case: str, tmp_path: Path) -> None:
    """Missing, displaced and oversized archives cannot produce numeric evidence.

    Parameters:
        case (str): Scenario under test.
        tmp_path (Path): Isolated test directory.
    Returns:
        None: Contract holds.
    Raises:
        AssertionError: An expected contract does not hold.
    """
    api = RecordingGitHub()
    job = api.jobs[0]
    upload = job["steps"][1]
    row = api.artifacts[0]
    if case == "none":
        api.jobs.clear()
    elif case == "duplicate-job":
        api.jobs.append(job)
    elif case == "skipped":
        upload["conclusion"] = "skipped"
    elif case == "failed":
        job["conclusion"] = "failure"
        job["steps"].pop()
    elif case == "cancelled":
        upload["conclusion"] = "cancelled"
    elif case == "no-start":
        upload["started_at"] = None
    elif case == "no-end":
        upload["completed_at"] = None
    elif case == "wrong-name":
        row["name"] = "other"
    elif case == "expired":
        row["expired"] = True
    elif case == "old":
        row["created_at"] = "2026-11-19T00:00:00Z"
    elif case == "oversize":
        row["size_in_bytes"] = pub.MAX_ARCHIVE_BYTES + 1
    else:
        api.artifacts.append(row)
    expected = "NOT RUN" if case == "skipped" else "unavailable"
    assert pub.fetch_evidence(api, pub.Run.parse(api.data), tmp_path) == expected
    assert not list(tmp_path.iterdir())


def test_artifact_transport_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Gracefully handle expiry between listing and download.

    Parameters:
        tmp_path (Path): Isolated test directory.
        monkeypatch (pytest.MonkeyPatch): Scoped test overrides.
    Returns:
        None: Contract holds.
    Raises:
        AssertionError: An expected contract does not hold.
    """
    api = RecordingGitHub()
    monkeypatch.setattr(RecordingGitHub, "download", unavailable_download)
    assert pub.fetch_evidence(api, pub.Run.parse(api.data), tmp_path) == "unavailable"


def unavailable_download(*args: object) -> None:
    """Simulate expiry between listing and download.

    Parameters:
        *args (object): Input to the test fixture.
    Returns:
        None: Contract holds.
    Raises:
        AssertionError: An expected contract does not hold.
    """
    raise OSError("signed download expired")


@pytest.mark.parametrize("case", ["old-attempt", "different-tested-sha", "missing-record", "no-merge-sha"])
def test_artifact_sidecar_fails_closed(case: str) -> None:
    """An acceptable upload timestamp is not provenance.

    Parameters:
        case (str): Scenario under test.
    Returns:
        None: Contract holds.
    Raises:
        AssertionError: An expected contract does not hold.
    """
    api = RecordingGitHub()
    assert api.record is not None
    if case == "old-attempt":
        api.record["run_attempt"] = 1
    elif case == "different-tested-sha":
        api.record["tested_sha"] = HEAD
    elif case == "missing-record":
        api.record = None
    body = pub.render(api, pub.Run.parse(api.data), 4, None if case == "no-merge-sha" else TESTED, POLICY)
    assert "Ubuntu enforced signals: unavailable" in body
    assert "zero uncovered" not in body


@pytest.mark.parametrize(
    "case", ["old-sticky", "bad-marker", "duplicates", "new-head", "new-run", "no-pr", "stale-start"]
)
def test_no_unsafe_comment_write(case: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Recheck freshness at the write boundary and refuse ambiguous sticky identity.

    Parameters:
        case (str): Scenario under test.
        tmp_path (Path): Isolated test directory.
        monkeypatch (pytest.MonkeyPatch): Scoped test overrides.
    Returns:
        None: Contract holds.
    Raises:
        AssertionError: An expected contract does not hold.
    """
    api = RecordingGitHub()
    comment = {"id": 17, "user": {"id": pub.BOT_ID}, "body": pub.MARKER + "\n<!-- ci:8:1 -->"}
    api.comments.append(comment)
    if case == "duplicates":
        api.comments.append(comment)
    elif case == "bad-marker":
        comment["body"] = pub.MARKER + "\nbad"
    elif case == "no-pr":
        api.pulls.clear()
    elif case == "stale-start":
        api.peers.clear()
    elif case in {"new-head", "new-run"}:
        api.comments.clear()
        render = pub.render

        def race(*args: Any) -> str:
            """Advance a PR or run while the publisher builds its report.

            Parameters:
                *args (Any): Input to the test fixture.
            Returns:
                str: Test fixture result.
            Raises:
                AssertionError: An expected contract does not hold.
            """
            if case == "new-head":
                api.pulls[0]["head"]["sha"] = TESTED
            else:
                api.data["run_attempt"] = 3
            return render(*args)

        monkeypatch.setattr(pub, "render", race)
    run = pub.Run.parse(api.data)
    summary = tmp_path / "summary"
    if case in {"duplicates", "bad-marker"}:
        with pytest.raises(ValueError, match=r"sticky|Multiple"):
            pub.publish(api, run, POLICY, summary)
    else:
        pub.publish(api, run, POLICY, summary)
    assert not api.writes
    assert not summary.exists()


def test_workflow_contract() -> None:
    """Pin the only credential, checkout, trigger, writer and permission boundaries.

    Parameters:
        None.
    Returns:
        None: Contract holds.
    Raises:
        AssertionError: An expected contract does not hold.
    """
    text = (ROOT / ".github/workflows/coverage-publish.yml").read_text()
    workflow = yaml.safe_load(text)
    assert workflow[True] == {"workflow_run": {"workflows": ["CI"], "types": ["completed"]}}
    assert workflow["permissions"] == {}
    job = workflow["jobs"]["comment"]
    assert set(workflow["jobs"]) == {"comment"}
    assert job["if"] == "github.event.workflow_run.event == 'pull_request'"
    assert job["permissions"] == {"actions": "read", "contents": "read", "pull-requests": "write"}
    assert job["concurrency"]["cancel-in-progress"] is False
    assert job["concurrency"]["group"] == (
        "coverage-comment-${{ github.event.workflow_run.head_repository.id }}-"
        "${{ github.event.workflow_run.head_branch }}"
    )
    checkout, publish = job["steps"]
    assert checkout["uses"] == "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
    assert checkout["with"] == {"ref": "${{ github.sha }}", "persist-credentials": False}
    assert publish["env"] == {"GH_TOKEN": "${{ github.token }}"}
    assert publish["run"] == "python3 -B scripts/coverage_publish.py"
    assert "secrets" not in text
    assert "pull_request_target" not in text


@pytest.mark.parametrize("case", ["ok", "long"])
def test_api_request(case: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """Exercise real Request binding, the read cap and disabled redirects.

    Parameters:
        case (str): Scenario under test.
        monkeypatch (pytest.MonkeyPatch): Scoped test overrides.
    Returns:
        None: Contract holds.
    Raises:
        AssertionError: An expected contract does not hold.
    """

    class Open:
        """Capture a GitHub API request."""

        def open(self, req: Any, *, timeout: int) -> io.BytesIO:
            """Record token use only against the API host.

            Parameters:
                req (Any): Request under test.
                timeout (int): Network timeout in seconds.
            Returns:
                io.BytesIO: Test fixture result.
            Raises:
                AssertionError: An expected contract does not hold.
            """
            assert req.full_url == f"{pub.API}/repos/{REPO}/issues/4/comments"
            assert req.get_header("Authorization") == "Bearer token"
            assert req.get_method() == "POST"
            assert timeout == 30
            assert json.loads(req.data) == {"body": "message"}
            return io.BytesIO(b'{"id":17}')

    monkeypatch.setattr(pub, "build_opener", lambda handler: Open())
    assert pub.NoRedirect().redirect_request() is None
    client = pub.GitHub(REPO, "token")
    if case == "long":
        monkeypatch.setattr(pub, "MAX_ARCHIVE_BYTES", 1)
        with pytest.raises(ValueError, match="size limit"):
            client.request("issues/4/comments", "POST", {"body": "message"})
    else:
        assert client.request("issues/4/comments", "POST", {"body": "message"}) == {"id": 17}


@pytest.mark.parametrize("case", ["array", "envelope", "short", "bad", "overflow"])
def test_pagination(case: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """End at an actual final page, reject malformed or over-budget census data.

    Parameters:
        case (str): Scenario under test.
        monkeypatch (pytest.MonkeyPatch): Scoped test overrides.
    Returns:
        None: Contract holds.
    Raises:
        AssertionError: An expected contract does not hold.
    """

    def request(self: pub.GitHub, path: str) -> Any:
        """Return two recording pages or an invalid census.

        Parameters:
            self (pub.GitHub): Input to the test fixture.
            path (str): Requested route.
        Returns:
            Any: Test fixture result.
        Raises:
            AssertionError: An expected contract does not hold.
        """
        query = parse_qs(urlsplit(path).query)
        assert query["head"] == ["user:a&b"]
        assert query["per_page"] == ["100"]
        page = query["page"] == ["1"]
        batch = list(range(100)) if page or case == "overflow" else [100]
        if case == "array":
            return batch
        if case == "bad":
            return {"rows": 3}
        return {"rows": batch, "total_count": 100 if case == "envelope" else 2000}

    monkeypatch.setattr(pub.GitHub, "request", request)
    api = pub.GitHub(REPO, "token")
    key = None if case == "array" else "rows"
    if case in {"bad", "overflow"}:
        with pytest.raises(ValueError, match=r"Expected GitHub list|census exceeds"):
            api.pages("pulls", key, head="user:a&b")
    else:
        assert api.pages("pulls", key, head="user:a&b") == list(range(100 if case == "envelope" else 101))


@pytest.mark.parametrize(
    "case", ["ok", "too-big", "io-error", "status", "insecure", "no-host", "userinfo", "no-redirect"]
)
def test_signed_download(case: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Stream a signed URL without the repository token, bounded and never redirected.

    Parameters:
        case (str): Scenario under test.
        tmp_path (Path): Isolated test directory.
        monkeypatch (pytest.MonkeyPatch): Scoped test overrides.
    Returns:
        None: Contract holds.
    Raises:
        AssertionError: An expected contract does not hold.
    """
    url = {
        "insecure": "http://artifact.example/a",
        "no-host": "https:/a",
        "userinfo": "https://u@artifact.example/a",
    }.get(case, "https://artifact.example/a")

    def request(self: pub.GitHub, path: str) -> None:
        """Simulate GitHub's signed redirect response.

        Parameters:
            self (pub.GitHub): Input to the test fixture.
            path (str): Requested route.
        Returns:
            None: Contract holds.
        Raises:
            AssertionError: An expected contract does not hold.
        """
        assert path == "actions/artifacts/8/zip"
        if case != "no-redirect":
            headers = Message()
            headers["Location"] = url
            raise HTTPError("api", 301 if case == "status" else 302, "redirect", headers, None)

    class Open:
        """Record the actual anonymous request and serve archive bytes.

        Parameters:
            self (pub.GitHub): Input to the test fixture.
            path (str): Requested route.
        Returns:
            None: Contract holds.
        Raises:
            AssertionError: An expected contract does not hold.
        """

        def open(self, target: str, *, timeout: int) -> io.BytesIO:
            """Assert no authorization headers reach the anonymous host.

            Parameters:
                target (str): Input to the test fixture.
                timeout (int): Network timeout in seconds.
            Returns:
                io.BytesIO: Test fixture result.
            Raises:
                AssertionError: An expected contract does not hold.
            """
            assert target == url
            assert timeout == 30
            if case == "io-error":
                raise OSError("download failed")
            return io.BytesIO(b"abcd")

    monkeypatch.setattr(pub.GitHub, "request", request)
    monkeypatch.setattr(pub, "build_opener", lambda handler: Open())
    monkeypatch.setattr(pub, "MAX_ARCHIVE_BYTES", 3 if case == "too-big" else 4)
    path = tmp_path / "artifact.zip"
    api = pub.GitHub(REPO, "token")
    if case == "ok":
        api.download(8, path)
        assert path.read_bytes() == b"abcd"
    else:
        with pytest.raises((OSError, ValueError)):
            api.download(8, path)
        assert not path.exists()


@pytest.mark.parametrize("case", ["ok", "http", "invalid"])
def test_cli(case: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Use event-file identity and report errors without emitting authentication material.

    Parameters:
        case (str): Scenario under test.
        tmp_path (Path): Isolated test directory.
        monkeypatch (pytest.MonkeyPatch): Scoped test overrides.
    Returns:
        None: Contract holds.
    Raises:
        AssertionError: An expected contract does not hold.
    """
    event = tmp_path / "event.json"
    event.write_text(json.dumps({"workflow_run": run_data(), "repository": {"default_branch": "main"}}))
    monkeypatch.setenv("GITHUB_EVENT_PATH", str(event))
    monkeypatch.setenv("GITHUB_REPOSITORY", REPO if case != "invalid" else "not-a-repository")
    monkeypatch.setenv("GH_TOKEN", "synthetic-token")
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))

    def publish(api: pub.GitHub, run: pub.Run, policy: Path, output: Path) -> None:
        """Verify trusted paths and the write failure exit code.

        Parameters:
            api (pub.GitHub): Recording API transport.
            run (pub.Run): Triggering execution.
            policy (Path): Policy path.
            output (Path): Summary path.
        Returns:
            None: Contract holds.
        Raises:
            AssertionError: An expected contract does not hold.
        """
        assert (api.repository, run.id, policy, output) == (
            REPO,
            123,
            Path("coverage/policy.json"),
            summary,
        )
        if case == "http":
            raise HTTPError("hidden", 403, "denied", Message(), None)

    monkeypatch.setattr(pub, "publish", publish)
    assert pub.main() == (0 if case == "ok" else 1)


def test_entrypoint(monkeypatch: pytest.MonkeyPatch) -> None:
    """Use a failing executable invocation to verify the CLI exit status.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): Scoped test overrides.
    Returns:
        None: Contract holds.
    Raises:
        AssertionError: An expected contract does not hold.
    """
    monkeypatch.delenv("GITHUB_EVENT_PATH", raising=False)
    with pytest.raises(SystemExit, match="1"):
        runpy.run_path(str(ROOT / "scripts/coverage_publish.py"), run_name="__main__")
