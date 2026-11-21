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
import signal
import sys
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from http.client import HTTPException
from pathlib import Path
from tempfile import TemporaryDirectory
from time import monotonic
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from coverage_provenance_record import (
    COVERAGE_HOSTS,
    SAFE_REPOSITORY,
    SHA,
    Provenance,
    object_value,
    text_value,
)
from coverage_report import (
    HOSTS,
    MAX_ARCHIVE_BYTES,
    MAX_MARKDOWN,
    Evidence,
    Signal,
    load_evidence,
    read_host_summary,
    read_summary,
    render_markdown,
)

LOGGER = logging.getLogger(__name__)
API = "https://api.github.com"
WORKFLOW = ".github/workflows/ci.yml"
ARTIFACT = "coverage-{host}"
# Display names from ci.yml:630, :650 and :734; keep the publisher contract test in sync.
OWNED_JOB = "owned ({host})"
PLAN_STEP = "Report execution plan"
UPLOAD_STEP = "Preserve independent coverage reports and summary"
MARKER = "<!-- pi-harness:coverage:v1 -->"
ORDER = re.compile(r"<!-- ci:([1-9][0-9]{0,19}):([1-9][0-9]{0,19}) -->")
BOT_ID = 41898282  # github-actions[bot] user ID from GET /users/github-actions%5Bbot%5D.
MAX_METADATA_BYTES = 8 * 1024 * 1024
MAX_MAIN_RUNS = 10
MAIN_LOOKUP_SECONDS = 90
REQUEST_SECONDS = 30
BUDGET_NOTICE = "Main baseline lookup exhausted its 90-second budget."
BASELINE_NOTICE = "Main baselines are selected by CI run recency, not the PR merge base."
PR_NOTICE = (
    "Coverage numbers come from this PR's own CI run (PR-controlled code) and are not independently "
    "verified. Required checks, not this comment, are the merge gate."
)
SCHEDULE = "macOS: NOT RUN (main/dispatch only). WSL2: no longer scheduled."


class NoRedirect(HTTPRedirectHandler):
    """Never forward a request or its authorization automatically."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        """Return None so urllib surfaces the redirect without contacting its target."""


class BaselineTimeout(Exception):
    """Main baseline lookup exhausted its separate wall-clock budget."""


def expire_baselines(_signum: int, _frame: object) -> None:
    """Interrupt baseline work even when an HTTP peer keeps the socket active.

    Parameters:
        _signum (int): Alarm signal number.
        _frame (object): Interrupted frame, unused.
    Returns:
        None.
    Raises:
        BaselineTimeout: The publisher's baseline alarm expired.
    """
    raise BaselineTimeout


@dataclass(frozen=True)
class BaselineDeadline:
    """Absolute monotonic deadline for baseline requests."""

    end: float
    clock: Callable[[], float]

    def timeout(self) -> float:
        """Cap the next request's timeout by the remaining baseline budget.

        Parameters:
            None.
        Returns:
            float: Positive socket timeout in seconds.
        Raises:
            BaselineTimeout: No baseline time remains.
        """
        remaining = self.end - self.clock()
        if remaining <= 0:
            raise BaselineTimeout
        return min(REQUEST_SECONDS, remaining)


@dataclass(frozen=True)
class GitHub:
    """Repository-scoped GitHub API and anonymous signed-download transport."""

    repository: str
    token: str

    def request(
        self,
        path: str,
        method: str = "GET",
        body: dict[str, Any] | None = None,
        *,
        timeout: float = REQUEST_SECONDS,
    ) -> Any:
        """Read a bounded repository API response or surface its HTTP error.

        Parameters:
            path (str): Repository-relative API route.
            method (str): HTTP method.
            body (dict[str, Any] | None): Optional JSON write payload.
            timeout (float): Maximum socket wait in seconds.
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
        with build_opener(NoRedirect()).open(req, timeout=timeout) as response:
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

    def download(
        self, artifact_id: int, destination: Path, *, deadline: BaselineDeadline | None = None
    ) -> None:
        """Write bounded ZIP bytes, never extract, and keep the token off the signed URL.

        Parameters:
            artifact_id (int): GitHub artifact identity.
            destination (Path): Private path for the ZIP.
            deadline (BaselineDeadline | None): Optional shared main lookup budget.
        Returns:
            None: Downloaded ZIP is present.
        Raises:
            OSError: GitHub or storage request failed.
            ValueError: Download exceeded its bound or lacked a signed redirect.
            BaselineTimeout: The baseline lookup budget expired.
        """
        try:
            try:
                self.request(
                    f"actions/artifacts/{artifact_id}/zip",
                    timeout=REQUEST_SECONDS if deadline is None else deadline.timeout(),
                )
            except HTTPError as error:
                url = error.headers.get("Location", "")
                error.close()
                target = urlsplit(url)
                if error.code != 302 or target.scheme != "https" or not target.hostname or target.username:
                    raise
            else:
                raise ValueError("Expected a signed artifact redirect")
            with (
                build_opener(NoRedirect()).open(
                    url, timeout=REQUEST_SECONDS if deadline is None else deadline.timeout()
                ) as response,
                destination.open("wb") as out,
            ):
                remaining = MAX_ARCHIVE_BYTES
                while chunk := response.read(min(remaining + 1, 1024 * 1024)):
                    remaining -= len(chunk)
                    if remaining < 0:
                        raise ValueError("Coverage archive exceeds size limit")
                    out.write(chunk)
        except HTTPException as error:
            destination.unlink(missing_ok=True)
            raise OSError("Coverage artifact HTTP transfer failed") from error
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
    def parse(cls, data: Any, event: str = "pull_request") -> Run:
        """Validate run identity for the selected CI event.

        Parameters:
            data (Any): GitHub workflow run record.
            event (str): Expected trigger type.
        Returns:
            Run: Independently sourced run identity.
        Raises:
            ValueError: Run identity is invalid.
        """
        if data["event"] != event or data["path"] != WORKFLOW:
            raise ValueError("Unexpected CI run workflow or event")
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


@dataclass(frozen=True)
class Census:
    """Attempt-scoped jobs and run-wide artifacts returned by GitHub."""

    jobs: list[Any]
    artifacts: list[Any]


def uploaded_artifacts(upload: dict[str, Any], artifacts: list[Any], host: str) -> list[Any]:
    """Associate artifact rows with the attempt's upload step, including expired rows.

    Parameters:
        upload (dict[str, Any]): Upload step from the attempt job, or an empty record.
        artifacts (list[Any]): Run-wide artifact rows.
        host (str): Coverage artifact host.
    Returns:
        list[Any]: Rows named for the host and created during that upload step.
    Raises:
        ValueError: A relevant timestamp is malformed.
        KeyError: An artifact row lacks required metadata.
    """
    if not upload.get("started_at") or not upload.get("completed_at"):
        return []
    start, end = timestamp(upload["started_at"]), timestamp(upload["completed_at"])
    return [
        row
        for row in artifacts
        if row["name"] == ARTIFACT.format(host=host) and start <= timestamp(row["created_at"]) <= end
    ]


def fetch_evidence(
    api: GitHub,
    run: Run,
    directory: Path,
    host: str = "ubuntu-24.04",
    *,
    census: Census | None = None,
    repository_id: int | None = None,
    deadline: BaselineDeadline | None = None,
) -> str:
    """Determine NOT RUN from the attempt job, or download its unique bounded artifact.

    Upload time is only an extra ownership check; the renderer must still validate the
    full producer sidecar. Artifacts from another attempt are never a fallback.

    Parameters:
        api (GitHub): Repository-scoped transport.
        run (Run): Selected CI execution and attempt.
        directory (Path): Private download directory.
        host (str): Coverage artifact host.
        census (Census | None): Preloaded attempt jobs and run-wide artifacts; otherwise fetch on demand.
        repository_id (int | None): For main pushes, require a successful producer and bind the
            artifact to this repository ID, head repository ID, run, branch and head SHA.
        deadline (BaselineDeadline | None): Optional shared main lookup budget.
    Returns:
        str: One of `available`, `NOT RUN` or `unavailable`.
    Raises:
        OSError: A metadata request failed.
        KeyError: Required metadata is missing.
        TypeError: Metadata has an unexpected shape.
        ValueError: Metadata or the main producer binding is invalid.
        BaselineTimeout: The baseline lookup budget expired.
    """
    jobs = (
        api.pages(f"actions/runs/{run.id}/attempts/{run.attempt}/jobs", "jobs")
        if census is None
        else census.jobs
    )
    owned = [job for job in jobs if job["name"] == OWNED_JOB.format(host=host)]
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
    artifact = ARTIFACT.format(host=host)
    artifacts = (
        api.pages(f"actions/runs/{run.id}/artifacts", "artifacts") if census is None else census.artifacts
    )
    candidates = [row for row in uploaded_artifacts(upload, artifacts, host) if row["expired"] is False]
    if len(candidates) != 1 or positive_id(candidates[0]["size_in_bytes"]) > MAX_ARCHIVE_BYTES:
        return "unavailable"
    row = candidates[0]
    if repository_id is not None and (
        job["conclusion"] != "success"
        or row["workflow_run"]
        != {
            "id": run.id,
            "repository_id": repository_id,
            "head_repository_id": repository_id,
            "head_branch": "main",
            "head_sha": run.head,
        }
    ):
        raise ValueError("Main coverage artifact does not belong to its producer")
    try:
        api.download(positive_id(row["id"]), directory / f"{artifact}.zip", deadline=deadline)
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
    destination.write_text(
        json.dumps({"ubuntu-24.04": host_plan(read_summary(policy), "ubuntu-24.04", state)})
    )


def host_plan(policy: dict[str, object], host: str, state: str) -> dict[str, object]:
    """Build one OS plan using policy from the selected trusted revision.

    Parameters:
        policy (dict[str, object]): Tested revision policy.
        host (str): Coverage artifact host.
        state (str): Measurement availability.
    Returns:
        dict[str, object]: Trusted renderer plan for the host.
    Raises:
        None.
    """
    os_name = HOSTS[host][1]
    signals = {}
    for name, raw_package in object_value(policy["packages"]).items():
        package: Any = raw_package
        for label, cfg in package.get("signals", {}).items():
            if os_name not in cfg.get("platforms", ("darwin", "linux")):
                continue
            skipped = os_name in (*cfg.get("skip_hosts", []), *cfg.get("skip_os", []))
            signals[f"{name}/{label}"] = {
                "enforcement": cfg.get("enforcement", "enforced"),
                "reason": cfg.get("reason", ""),
                "semantics": cfg.get("producer", "lcov"),
                "state": "NOT RUN" if skipped else "planned",
                "source_root": "" if package["root"] == "." else package["root"],
            }
    return {"state": state, "signals": signals}


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
        baselines = {}
        if state == "available":
            prefix += BASELINE_NOTICE + "\n\n"
            try:
                baselines = main_baselines(api, run, read_summary(policy))
            except BaselineTimeout:
                prefix += BUDGET_NOTICE + "\n\n"
            for host in COVERAGE_HOSTS:
                entry = baselines.get(host)
                if entry is None:
                    prefix += f"{HOSTS[host][0]} measured main baseline: unavailable.\n\n"
                    continue
                source, _ = entry
                prefix += (
                    f"{HOSTS[host][0]} measured main baseline "
                    "(producer-reported, not independently verified): "
                    f"[`{source.head}`](https://github.com/{api.repository}/commit/{source.head}) "
                    f"([CI run {source.id}, attempt {source.attempt}]"
                    f"(https://github.com/{api.repository}/actions/runs/{source.id}/attempts/{source.attempt})).\n\n"
                )
        main_cells = tuple(cell for _, cell in baselines.values())
        return prefix + render_markdown(evidence, provenance, main_cells, limit=MAX_MARKDOWN - len(prefix))


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


def main_run(api: GitHub, data: Any, trigger: Run) -> tuple[Run, int]:
    """Bind an eligible main push to the same CI workflow and non-fork repository.

    Parameters:
        api (GitHub): Repository-scoped transport.
        data (Any): Workflow run listing row.
        trigger (Run): PR execution identifying the CI workflow.
    Returns:
        tuple[Run, int]: Eligible run and the common repository and head repository ID.
    Raises:
        KeyError: Required run metadata is missing.
        TypeError: Run metadata has an unexpected shape.
        ValueError: The row does not describe an eligible main push.
    """
    run = Run.parse(data, "push")
    repo_id = positive_id(data["repository"]["id"])
    if (
        run.id == trigger.id
        or run.workflow_id != trigger.workflow_id
        or run.branch != "main"
        or run.fork != api.repository
        or run.prs
        or data["repository"]["full_name"] != api.repository
        or data["repository"]["fork"] is not False
        or data["head_repository"]["fork"] is not False
        or positive_id(data["head_repository"]["id"]) != repo_id
        or run.status != "completed"
        or run.conclusion != "success"
    ):
        raise ValueError("Not a successful same-repository main push")
    return run, repo_id


def main_page(
    api: GitHub, path: str, key: str, deadline: BaselineDeadline, *, limit: int = 100, **params: str
) -> list[Any]:
    """Read one bounded page, requiring the full census for jobs and artifacts.

    Parameters:
        api (GitHub): Repository-scoped transport.
        path (str): Repository-relative listing route.
        key (str): GitHub list envelope key.
        deadline (BaselineDeadline): Shared main lookup budget.
        limit (int): Page size; the default of 100 requires a complete census.
        **params (str): Collection filters.
    Returns:
        list[Any]: Rows returned on the first page.
    Raises:
        OSError: The request failed.
        KeyError: The response is missing envelope fields.
        TypeError: The response does not have the expected shape.
        ValueError: The census is invalid or truncated.
        BaselineTimeout: The baseline lookup budget expired.
    """
    data = api.request(
        f"{path}?{urlencode(params | {'per_page': limit, 'page': 1})}", timeout=deadline.timeout()
    )
    deadline.timeout()
    rows = data[key]
    if not isinstance(rows, list) or len(rows) > limit or (limit == 100 and data["total_count"] != len(rows)):
        raise ValueError("Invalid or truncated main coverage census")
    return rows


def main_cell(
    api: GitHub,
    source: Run,
    repo_id: int,
    host: str,
    census: Census,
    *,
    policy: dict[str, object],
    deadline: BaselineDeadline,
) -> Evidence | None:
    """Read the main artifact through the same attempt, ZIP and sidecar validation as the PR.

    Parameters:
        api (GitHub): Repository-scoped transport.
        source (Run): Selected main push and attempt.
        repo_id (int): Verified repository and head repository ID for `source`.
        host (str): Coverage artifact host.
        census (Census): Attempt jobs and run-wide artifacts for `source`.
        policy (dict[str, object]): Trusted policy used to describe comparable signals.
        deadline (BaselineDeadline): Shared main lookup budget.
    Returns:
        Evidence | None: Validated measurement, or None for unavailable evidence.
    Raises:
        BaselineTimeout: The baseline lookup budget expired.
    """
    provenance = Provenance(
        api.repository,
        None,
        source.head,
        source.id,
        source.attempt,
        "push",
        f"{api.repository}/{WORKFLOW}@refs/heads/main",
    )
    try:
        with TemporaryDirectory() as temp:
            directory = Path(temp)
            if (
                fetch_evidence(
                    api, source, directory, host, census=census, repository_id=repo_id, deadline=deadline
                )
                != "available"
            ):
                return None
            summary = read_host_summary(directory, host, provenance)
        if summary is None or summary.os != HOSTS[host][1] or summary.measurement_only or summary.errors:
            return None
        # Only compare signals measured on main. The fingerprint binds the producer and policy;
        # a historical run need not cover the publisher checkout's entire current signal plan.
        signals = object_value(host_plan(policy, host, "available")["signals"])
        plan = tuple(
            Signal.parse(name, signals[name]) for name in sorted(signals.keys() & summary.packages.keys())
        )
        return Evidence(host, "available", plan, summary)
    except (KeyError, OSError, TypeError, ValueError):
        LOGGER.warning(f"Main coverage artifact unusable for {host}, run {source.id}")
        return None


def macos_cancelled(jobs: list[Any]) -> bool:
    """Recognize macOS main-push shard cancellation before fan-in.

    Parameters:
        jobs (list[Any]): Jobs returned for the selected attempt.
    Returns:
        bool: Whether a macOS shard was cancelled.
    Raises:
        KeyError: A required job field is missing.
        TypeError: Job metadata has an unexpected shape.
    """
    return any(
        job["name"].startswith("owned shard (macos-14, ") and job["conclusion"] == "cancelled" for job in jobs
    )


def main_baselines(
    api: GitHub, trigger: Run, policy: dict[str, object], *, clock: Callable[[], float] | None = None
) -> dict[str, tuple[Run, Evidence]]:
    """Select baselines by push recency under a publisher-only POSIX alarm.

    Called on the workflow's main thread; the publisher owns `ITIMER_REAL`.

    Parameters:
        api (GitHub): Repository-scoped transport.
        trigger (Run): PR execution identifying the CI workflow independently of its base branch.
        policy (dict[str, object]): Trusted signal policy.
        clock (Callable[[], float] | None): Monotonic clock; defaults to `monotonic`.
    Returns:
        dict[str, tuple[Run, Evidence]]: Validated main baselines keyed by coverage host.
    Raises:
        BaselineTimeout: The baseline lookup budget expired.
    """
    clock = monotonic if clock is None else clock
    deadline = BaselineDeadline(clock() + MAIN_LOOKUP_SECONDS, clock)
    previous_handler = signal.signal(signal.SIGALRM, expire_baselines)
    baselines = {}
    try:
        signal.setitimer(signal.ITIMER_REAL, MAIN_LOOKUP_SECONDS)
        rows = main_page(
            api,
            f"actions/workflows/{trigger.workflow_id}/runs",
            "workflow_runs",
            deadline,
            limit=MAX_MAIN_RUNS,
            event="push",
            branch="main",
            status="success",
        )
        runs = []
        for row in rows:
            try:
                runs.append(main_run(api, row, trigger))
            except (KeyError, TypeError, ValueError):
                continue
        hosts = tuple(COVERAGE_HOSTS)
        for source, repo_id in sorted(runs, key=lambda entry: entry[0].order, reverse=True):
            route = f"actions/runs/{source.id}"
            jobs = main_page(api, f"{route}/attempts/{source.attempt}/jobs", "jobs", deadline)
            artifacts = main_page(api, f"{route}/artifacts", "artifacts", deadline)
            census = Census(jobs=jobs, artifacts=artifacts)
            for host in hosts:
                cell = main_cell(api, source, repo_id, host, census, policy=policy, deadline=deadline)
                deadline.timeout()
                if cell is not None:
                    baselines[host] = source, cell
            # The artifact endpoint is run-wide. Only the selected attempt's upload window
            # can stop walk-back; do not skip an expired or invalid artifact in that window.
            if any(
                uploaded_artifacts(step, census.artifacts, "macos-14")
                for job in census.jobs
                if job["name"] == OWNED_JOB.format(host="macos-14")
                for step in job["steps"]
                if step["name"] == UPLOAD_STEP
            ):
                break
            if hosts != ("macos-14",) and not macos_cancelled(jobs):
                break
            hosts = ("macos-14",)
    except (KeyError, OSError, HTTPException, TypeError, ValueError):
        deadline.timeout()
        LOGGER.warning("Main coverage census unavailable")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
    return baselines


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
