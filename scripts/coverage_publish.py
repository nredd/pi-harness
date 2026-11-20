"""Publish a sticky coverage report from a completed CI run, using trusted checkout code only.

References:
    https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run
    https://docs.github.com/en/rest/actions/artifacts
    https://github.com/nredd/pi-harness/issues/1001
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from coverage_report import (
    MAX_ARCHIVE_BYTES,
    MAX_MARKDOWN,
    SAFE_REPOSITORY,
    SHA,
    Provenance,
    load_evidence,
    object_value,
    read_summary,
    render_markdown,
)

LOGGER = logging.getLogger(__name__)
API = "https://api.github.com"
WORKFLOW = ".github/workflows/ci.yml"
ARTIFACT = "coverage-ubuntu-24.04"
# Display names from ci.yml:630, :650 and :734; keep the publisher contract test in sync.
OWNED_JOB = "owned (ubuntu-24.04)"
PLAN_STEP = "Report execution plan"
UPLOAD_STEP = "Preserve independent coverage reports and summary"
MARKER = "<!-- pi-harness:coverage:v1 -->"
ORDER = re.compile(r"<!-- ci:([1-9][0-9]{0,19}):([1-9][0-9]{0,19}) -->")
BOT_ID = 41898282  # github-actions[bot] user ID from GET /users/github-actions%5Bbot%5D.
MAX_METADATA_BYTES = 8 * 1024 * 1024
PR_NOTICE = (
    "Coverage numbers come from this PR's own CI run (PR-controlled code) and are not independently "
    "verified. Required checks, not this comment, are the merge gate."
)
SCHEDULE = "macOS: NOT RUN (main/dispatch only). WSL2: no longer scheduled."


class NoRedirect(HTTPRedirectHandler):
    """Never forward a request or its authorization automatically."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        """Return None so urllib surfaces the redirect without contacting its target."""


@dataclass(frozen=True)
class GitHub:
    """Repository-scoped GitHub API and anonymous signed-download transport."""

    repository: str
    token: str

    def request(self, path: str, method: str = "GET", body: dict[str, str] | None = None) -> Any:
        """Read a bounded repository API response or surface its HTTP error.

        Parameters:
            path (str): Repository-relative API route.
            method (str): HTTP method.
            body (dict[str, str] | None): Optional JSON write payload.
        Returns:
            Any: Decoded response.
        Raises:
            OSError: GitHub request failed.
            ValueError: Invalid JSON or oversized response.
        """
        req = Request(
            f"{API}/repos/{self.repository}/{path}",
            data=None if body is None else json.dumps(body).encode(),
            headers={
                "Authorization": f"Bearer {self.token}",
                "Accept": "application/vnd.github+json",
                "Content-Type": "application/json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            method=method,
        )
        with build_opener(NoRedirect()).open(req, timeout=30) as response:
            raw = response.read(MAX_METADATA_BYTES + 1)
        if len(raw) > MAX_METADATA_BYTES:
            raise ValueError("GitHub response exceeds size limit")
        return json.loads(raw)

    def pages(self, path: str, key: str | None = None, **params: str) -> list[Any]:
        """Read bounded pages; never decide from a silently truncated census.

        Parameters:
            path (str): Repository-relative collection.
            key (str | None): Envelope key, or None for a top-level array.
            **params (str): Collection filters.
        Returns:
            list[Any]: All rows in API order.
        Raises:
            ValueError: Invalid or oversized census.
        """
        rows = []
        for page in range(1, 11):
            query = urlencode(params | {"per_page": 100, "page": page})
            data = self.request(f"{path}?{query}")
            batch = data if key is None else data[key]
            if not isinstance(batch, list):
                raise ValueError("Expected GitHub list")
            rows.extend(batch)
            if len(batch) < 100 or (key is not None and len(rows) == data["total_count"]):
                return rows
        raise ValueError("GitHub census exceeds page limit")

    def download(self, artifact_id: int, destination: Path) -> None:
        """Write bounded ZIP bytes, never extract, and keep the token off the signed URL.

        Parameters:
            artifact_id (int): GitHub artifact identity.
            destination (Path): Private path for the ZIP.
        Returns:
            None: Downloaded ZIP is present.
        Raises:
            OSError: GitHub or storage request failed.
            ValueError: Download exceeded its bound or lacked a signed redirect.
        """
        try:
            self.request(f"actions/artifacts/{artifact_id}/zip")
        except HTTPError as error:
            url = error.headers.get("Location", "")
            error.close()
            target = urlsplit(url)
            if error.code != 302 or target.scheme != "https" or not target.hostname or target.username:
                raise
        else:
            raise ValueError("Expected a signed artifact redirect")
        try:
            with build_opener(NoRedirect()).open(url, timeout=30) as response, destination.open("wb") as out:
                remaining = MAX_ARCHIVE_BYTES
                while chunk := response.read(min(remaining + 1, 1024 * 1024)):
                    remaining -= len(chunk)
                    if remaining < 0:
                        raise ValueError("Coverage archive exceeds size limit")
                    out.write(chunk)
        except (OSError, ValueError):
            destination.unlink(missing_ok=True)
            raise


@dataclass(frozen=True)
class Run:
    """Run identity from GitHub, never an artifact manifest."""

    id: int
    number: int
    attempt: int
    workflow_id: int
    head: str
    branch: str
    fork: str
    status: str
    conclusion: str | None
    prs: tuple[int, ...]

    @classmethod
    def parse(cls, data: Any) -> Run:
        """Validate run identity and reject non-PR CI workflows.

        Parameters:
            data (Any): GitHub workflow run record.
        Returns:
            Run: Independently sourced run identity.
        Raises:
            ValueError: Run identity is invalid.
        """
        if data["event"] != "pull_request" or data["path"] != WORKFLOW:
            raise ValueError("Not a pull request CI run")
        numbers = tuple(data[key] for key in ("id", "run_number", "run_attempt", "workflow_id"))
        fork = data["head_repository"]["full_name"]
        if (
            not all(type(n) is int and 0 < n < 10**20 for n in numbers)
            or not SHA.fullmatch(data["head_sha"])
            or not SAFE_REPOSITORY.fullmatch(fork)
            or not data["head_branch"]
        ):
            raise ValueError("Invalid GitHub run identity")
        return cls(
            numbers[0],
            numbers[1],
            numbers[2],
            numbers[3],
            data["head_sha"],
            data["head_branch"],
            fork,
            data["status"],
            data["conclusion"],
            tuple(pr["number"] for pr in data["pull_requests"]),
        )

    @property
    def order(self) -> tuple[int, int]:
        """Order executions without using timestamps."""
        return self.number, self.attempt


def current_pr(api: GitHub, run: Run) -> tuple[int, str | None] | None:
    """Resolve the unique live PR, including forks with an empty run PR array.

    The open PR merge SHA is independently sourced. If GitHub has regenerated the
    merge commit since CI, the sidecar won't match and the evidence fails closed.
    """
    pulls = api.pages("pulls", head=f"{run.fork.split('/')[0]}:{run.branch}", state="open")
    matches = [
        pr
        for pr in pulls
        if pr["state"] == "open"
        and pr["base"]["repo"]["full_name"] == api.repository
        and pr["head"]["ref"] == run.branch
        and pr["head"]["repo"]["full_name"] == run.fork
        and pr["head"]["sha"] == run.head
    ]
    if len(matches) != 1:
        return None
    pr = matches[0]
    number = pr["number"]
    if run.prs and run.prs != (number,):
        return None
    tested = pr["merge_commit_sha"]
    return number, tested if tested and SHA.fullmatch(tested) and tested != run.head else None


def is_latest(api: GitHub, run: Run) -> bool:
    """Check for newer runs including queued replacements and newer attempts.

    Parameters:
        api (GitHub): Repository-scoped transport.
        run (Run): Completed triggering run.
    Returns:
        bool: Exact execution is still the latest eligible one.
    Raises:
        OSError: Metadata fetch failed.
    """
    current = Run.parse(api.request(f"actions/runs/{run.id}"))
    if current != run or current.status != "completed":
        return False
    rows = api.pages(
        f"actions/workflows/{run.workflow_id}/runs",
        "workflow_runs",
        event="pull_request",
        branch=run.branch,
        head_sha=run.head,
    )
    peers = [
        Run.parse(row)
        for row in rows
        if row["head_repository"] and row["head_repository"]["full_name"] == run.fork
    ]
    return run in peers and max(peer.order for peer in peers) == run.order


def fetch_evidence(api: GitHub, run: Run, directory: Path) -> str:
    """Determine NOT RUN from the attempt job, or download its unique bounded artifact.

    Upload time is only an extra ownership check; the renderer must still validate the
    full producer sidecar. Artefacts from another attempt are never a fallback.
    """
    jobs = api.pages(f"actions/runs/{run.id}/attempts/{run.attempt}/jobs", "jobs")
    owned = [job for job in jobs if job["name"] == OWNED_JOB]
    if len(owned) != 1:
        return "unavailable"
    job = owned[0]
    steps = {step["name"]: step for step in job["steps"]}
    plan = steps.get(PLAN_STEP, {})
    upload = steps.get(UPLOAD_STEP, {})
    if (
        job["conclusion"] == "success"
        and plan.get("conclusion") == "success"
        and upload.get("conclusion") == "skipped"
    ):
        return "NOT RUN"
    if (
        upload.get("conclusion") != "success"
        or not upload.get("started_at")
        or not upload.get("completed_at")
    ):
        return "unavailable"
    start, end = upload["started_at"], upload["completed_at"]
    candidates = [
        row
        for row in api.pages(f"actions/runs/{run.id}/artifacts", "artifacts")
        if row["name"] == ARTIFACT and not row["expired"] and start <= row["created_at"] <= end
    ]
    if len(candidates) != 1 or not 0 < candidates[0]["size_in_bytes"] <= MAX_ARCHIVE_BYTES:
        return "unavailable"
    try:
        api.download(candidates[0]["id"], directory / f"{ARTIFACT}.zip")
    except (OSError, ValueError):
        # Signed URLs can expire and downloads can race artifact deletion. Never log the URL.
        LOGGER.warning("Coverage artifact download unavailable")
        return "unavailable"
    return "available"


def write_plan(policy: Path, destination: Path, state: str) -> None:
    """Build an independent Ubuntu denominator from the trusted checkout's policy.

    Parameters:
        policy (Path): Policy in the default-branch checkout.
        destination (Path): Temporary renderer manifest.
        state (str): Ubuntu availability.
    Returns:
        None: Manifest is written.
    Raises:
        OSError: Input or manifest could not be accessed.
    """
    signals = {}
    for name, raw_package in object_value(read_summary(policy)["packages"]).items():
        package: Any = raw_package
        for label, signal in package.get("signals", {}).items():
            skipped = "linux" in (*signal.get("skip_hosts", []), *signal.get("skip_os", []))
            signals[f"{name}/{label}"] = {
                "enforcement": signal.get("enforcement", "enforced"),
                "reason": signal.get("reason", ""),
                "semantics": signal.get("producer", "lcov"),
                "state": "NOT RUN" if skipped else "planned",
                "source_root": "" if package["root"] == "." else package["root"],
            }
    destination.write_text(json.dumps({"ubuntu-24.04": {"state": state, "signals": signals}}))


def render(api: GitHub, run: Run, number: int, tested: str | None, policy: Path) -> str:
    """Render PR-reported measurements after sidecar consistency checks, or show unavailable.

    Parameters:
        api (GitHub): Repository-scoped transport.
        run (Run): Triggering execution.
        number (int): Resolved PR.
        tested (str | None): Independently resolved checkout SHA.
        policy (Path): Trusted policy file.
    Returns:
        str: Bounded sticky comment and summary content.
    Raises:
        OSError: Metadata or renderer files could not be accessed.
    """
    prefix = (
        f"{MARKER}\n<!-- ci:{run.number}:{run.attempt} -->\nCoverage for PR #{number} "
        f"([CI run {run.id}, attempt {run.attempt}](https://github.com/{api.repository}/actions/runs/"
        f"{run.id}/attempts/{run.attempt}); CI status: {run.conclusion}).\n\n{PR_NOTICE}\n\n{SCHEDULE}\n\n"
    )
    if tested is None:
        return (
            prefix
            + f"Head: `{run.head}`. Tested checkout unavailable.\n\nUbuntu enforced signals: unavailable"
        )
    provenance = Provenance(
        api.repository,
        run.head,
        tested,
        run.id,
        run.attempt,
        "pull_request",
        f"{api.repository}/{WORKFLOW}@refs/pull/{number}/merge",
    )
    with TemporaryDirectory() as temp:
        directory = Path(temp)
        manifest = directory / "plan.json"
        state = fetch_evidence(api, run, directory)
        write_plan(policy, manifest, state)
        evidence = load_evidence(directory, manifest, provenance)
        return prefix + render_markdown(evidence, provenance, limit=MAX_MARKDOWN - len(prefix))


def publish(api: GitHub, run: Run, policy: Path, summary: Path) -> None:
    """Recheck freshness immediately before a single serialized sticky write.

    Parameters:
        api (GitHub): Repository-scoped transport.
        run (Run): Triggering execution.
        policy (Path): Trusted policy file.
        summary (Path): GitHub step-summary file.
    Returns:
        None: Publication wrote or safely skipped.
    Raises:
        ValueError: Sticky state was ambiguous or malformed.
        OSError: Publication request or output failed.
    """
    target = current_pr(api, run)
    if target is None or not is_latest(api, run):
        LOGGER.info("No unique current PR or newer CI execution exists; skip publication")
        return
    number, tested = target
    body = render(api, run, number, tested, policy)
    comments = f"issues/{number}/comments"
    sticky = [
        comment
        for comment in api.pages(comments)
        if comment["user"]["id"] == BOT_ID and comment["body"].startswith(f"{MARKER}\n")
    ]
    if len(sticky) > 1:
        raise ValueError("Multiple coverage comments by the expected bot")
    if sticky:
        order = ORDER.fullmatch(sticky[0]["body"].split("\n", 2)[1])
        if order is None:
            raise ValueError("Malformed sticky comment identity")
        if (int(order[1]), int(order[2])) > run.order:
            return
    if not is_latest(api, run) or current_pr(api, run) != target:
        LOGGER.info("CI execution or PR changed during rendering; skip publication")
        return
    with summary.open("a", encoding="utf-8") as output:
        output.write(body + "\n")
    if sticky:
        api.request(f"issues/comments/{sticky[0]['id']}", "PATCH", {"body": body})
    else:
        api.request(comments, "POST", {"body": body})


def main() -> int:
    """Read the trusted workflow event and fail visibly without leaking API URLs or tokens.

    Parameters:
        None.
    Returns:
        int: Zero on success or safe stale skip; one on publication error.
    Raises:
        None.
    """
    try:
        event = read_summary(Path(os.environ["GITHUB_EVENT_PATH"]))
        repository = os.environ["GITHUB_REPOSITORY"]
        if not SAFE_REPOSITORY.fullmatch(repository):
            raise ValueError("Invalid target repository")
        api = GitHub(repository, os.environ["GH_TOKEN"])
        publish(
            api,
            Run.parse(event["workflow_run"]),
            Path("coverage/policy.json"),
            Path(os.environ["GITHUB_STEP_SUMMARY"]),
        )
    except HTTPError as error:
        LOGGER.error(f"Coverage publication failed: GitHub HTTP {error.code}")
        return 1
    except (KeyError, OSError, ValueError, TypeError) as error:
        LOGGER.error(f"Coverage publication failed: {type(error).__name__}")
        return 1
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    sys.exit(main())
