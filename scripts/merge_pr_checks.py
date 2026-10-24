"""Gate merges with validated execution identity and complete matrix evidence.

References:
    https://docs.github.com/en/rest/actions/workflow-runs
    https://docs.github.com/en/rest/actions/workflow-jobs
    https://docs.github.com/en/rest/checks/runs
    https://cli.github.com/manual/gh_pr_checks
"""

from __future__ import annotations

import argparse
import logging
import os
import re
import subprocess
from pathlib import Path
from urllib.parse import quote

from pydantic import BaseModel, ConfigDict, Field, JsonValue, TypeAdapter

LOGGER = logging.getLogger(__name__)
ACTIONS_APP = 15368
JOB_URL = re.compile(r"https://github.com/nredd/pi-harness/actions/runs/(\d+)/job/(\d+)")
MATRIX = {
    "owned (${{ matrix.os }})": {f"owned ({os})" for os in ("ubuntu-24.04", "macos-14")},
    "contracts (${{ matrix.os }})": {f"contracts ({os})" for os in ("ubuntu-24.04", "macos-14")},
    "stack (${{ matrix.os }}, ${{ matrix.stack }})": {
        f"stack ({os}, {stack})" for os in ("ubuntu-24.04", "macos-14") for stack in ("personal", "local")
    },
}
EXPECTED_MATRIX = set.union(*MATRIX.values())
JSON = TypeAdapter(JsonValue)
PAGES = TypeAdapter(list[dict[str, JsonValue]])


class Record(BaseModel):
    model_config = ConfigDict(strict=True, frozen=True)


class Identity(Record):
    id: int = Field(gt=0, description="GitHub repository, app or execution identifier")


class Side(Record):
    ref: str = Field(min_length=1, description="PR branch ref")
    sha: str = Field(min_length=1, description="PR branch commit SHA")
    repo: Identity = Field(description="Repository identity, not its mutable name")


class PullRequest(Record):
    number: int = Field(gt=0, description="Associated pull request number")
    head: Side = Field(description="PR source repository, ref and SHA")
    base: Side = Field(description="PR target repository, ref and SHA")


class Run(Identity):
    workflow_id: int = Field(gt=0, description="Stable workflow identifier")
    path: str = Field(min_length=1, description="Workflow file path")
    event: str = Field(min_length=1, description="Workflow trigger event")
    head_sha: str = Field(min_length=1, description="Execution source SHA")
    run_number: int = Field(gt=0, description="Monotonic workflow execution number")
    run_attempt: int = Field(gt=0, description="Monotonic attempt within one execution")
    check_suite_id: int = Field(gt=0, description="Suite binding execution to app and SHA")
    status: str = Field(description="Execution lifecycle status")
    conclusion: str | None = Field(description="Terminal execution outcome, absent while pending")
    pull_requests: list[PullRequest] = Field(description="Associated PR head/base identities")


class Step(Record):
    name: str = Field(description="Only presence matters when proving an unexecuted job")


class Job(Identity):
    name: str = Field(description="Literal or expanded workflow job name")
    run_id: int = Field(gt=0, description="Owning workflow execution")
    run_attempt: int = Field(gt=0, description="Owning execution attempt")
    head_sha: str = Field(description="Execution source SHA")
    status: str = Field(description="Job lifecycle status")
    conclusion: str | None = Field(description="Terminal outcome, absent while pending")
    steps: list[Step] = Field(description="Executed steps; placeholders must have none")


class Suite(Record):
    app: Identity = Field(description="App that produced this suite")
    head_sha: str = Field(description="Suite commit SHA")


class CheckRun(Suite):
    name: str = Field(description="Branch protection context")
    html_url: str = Field(description="Exact check selected by the CLI")
    status: str = Field(description="Check lifecycle status")
    conclusion: str | None = Field(description="Terminal check outcome")


class ReportedCheck(Record):
    name: str = Field(description="CLI-selected check name")
    state: str = Field(description="CLI-selected check outcome")
    link: str = Field(description="Exact check URL, not merely its display name")


class Requirement(Record):
    context: str = Field(min_length=1, description="Required branch protection context")
    integration_id: int = Field(gt=0, description="Required producing app")


class RuleParameters(Record):
    required_status_checks: list[Requirement] = Field(default_factory=list, description="App-bound contexts")


class Rule(Record):
    type: str = Field(description="Effective ruleset rule type")
    parameters: RuleParameters = Field(
        default_factory=RuleParameters, description="Required context parameters"
    )


class CheckError(RuntimeError):
    """CI evidence is missing, ambiguous, pending, or unsuccessful."""


class GitHub:
    """Read GitHub through an explicitly selected trusted executable."""

    def __init__(self, binary: Path) -> None:
        """Validate a caller-selected executable, never search PATH.

        Parameters:
            binary (Path): Trusted absolute CLI executable selected by the operator.

        Raises:
            CheckError: The path is relative, missing or not executable.
        """
        if not binary.is_absolute() or not binary.is_file() or not os.access(binary, os.X_OK):
            raise CheckError(f"Invalid trusted `gh` executable: '{binary}'")
        self.binary = str(binary.resolve())

    def command(self, *args: str) -> JsonValue:
        """Decode JSON CLI output while preserving the pending-check exit code.

        Parameters:
            *args (str): Read-only CLI arguments.

        Returns:
            JsonValue: Validated JSON response.

        Raises:
            CheckError: Execution or HTTP failed.
        """
        cmd = [self.binary, *args]
        try:
            output = subprocess.check_output(cmd, text=True, stderr=subprocess.STDOUT)
        except subprocess.CalledProcessError as e:
            if args[:2] != ("pr", "checks") or e.returncode != 8:
                raise CheckError(f"`gh {' '.join(args)}` failed: {e.output.strip()}") from e
            output = e.output
        except OSError as e:
            raise CheckError(f"Cannot execute `gh`: {e}") from e
        return JSON.validate_json(output)

    def api(self, endpoint: str) -> JsonValue:
        """Read one REST object without a method override or request body.

        Parameters:
            endpoint (str): Repository-relative REST endpoint.

        Returns:
            JsonValue: Decoded REST response, validated as a specific record by its caller.
        """
        return self.command("api", endpoint)

    def pages(self, endpoint: str, key: str) -> list[JsonValue]:
        """Read every REST page before selecting evidence, independent of order.

        Parameters:
            endpoint (str): Repository-relative REST collection endpoint.
            key (str): Required response property containing records.

        Returns:
            list[JsonValue]: Records from all pages, validated by the consuming endpoint.

        Raises:
            CheckError: Any page lacks the requested record list.
        """
        separator = "&" if "?" in endpoint else "?"
        pages = PAGES.validate_python(
            self.command("api", "--paginate", "--slurp", f"{endpoint}{separator}per_page=100")
        )
        records: list[JsonValue] = []
        for page in pages:
            items = page.get(key)
            if not isinstance(items, list):
                raise CheckError(f"Missing REST collection: '{key}'")
            records.extend(items)
        return records


def run_context(run: Run) -> tuple[int, str, str, str, PullRequest]:
    """Identify the complete execution context, never timestamps.

    Parameters:
        run (Run): Validated workflow execution.

    Returns:
        tuple[int, str, str, str, PullRequest]: Workflow/event/SHA and complete PR identity.

    Raises:
        CheckError: PR association is absent or ambiguous.
    """
    if len(run.pull_requests) != 1:
        raise CheckError("Supersession requires exactly one associated PR")
    return run.workflow_id, run.path, run.event, run.head_sha, run.pull_requests[0]


def run_order(run: Run) -> tuple[int, int]:
    """Return workflow run number and attempt for monotonic ordering.

    Parameters:
        run (Run): Validated workflow execution.

    Returns:
        tuple[int, int]: Execution order within one workflow.
    """
    return run.run_number, run.run_attempt


def superseded(gh: GitHub, repo: str, pr: PullRequest, check: ReportedCheck, runs: list[Run]) -> None:
    """Require a complete green successor for a zero-step cancelled CI placeholder.

    Parameters:
        gh (GitHub): Read-only evidence client.
        repo (str): Owner/repository identifier.
        pr (PullRequest): Current PR identity.
        check (ReportedCheck): Cancelled check selected by the CLI.
        runs (list[Run]): All executions reported for the reviewed SHA.

    Raises:
        CheckError: Any identity, freshness or matrix evidence is missing.
    """
    match = JOB_URL.fullmatch(check.link)
    if repo != "nredd/pi-harness" or check.name not in MATRIX or match is None:
        raise CheckError(f"{check.state} {check.name}")
    run_id, job_id = match.groups()
    prefix = f"repos/{repo}"
    job = Job.model_validate(gh.api(f"{prefix}/actions/jobs/{job_id}"))
    old = Run.model_validate(gh.api(f"{prefix}/actions/runs/{run_id}/attempts/{job.run_attempt}"))
    if (
        job.name != check.name
        or job.run_id != int(run_id)
        or job.head_sha != pr.head.sha
        or job.status != "completed"
        or job.conclusion != "cancelled"
        or job.steps
        or old.status != "completed"
        or old.conclusion != "cancelled"
        or old.path != ".github/workflows/ci.yml"
        or old.event != "pull_request"
    ):
        raise CheckError("Cancelled check is not an unexecuted CI matrix placeholder")
    candidates = [r for r in runs if r.workflow_id == old.workflow_id and r.event == old.event]
    if not candidates:
        raise CheckError("No successor workflow execution")
    new = max(candidates, key=run_order)
    if (
        run_order(new) <= run_order(old)
        or run_context(new) != run_context(old)
        or new.head_sha != pr.head.sha
        or new.status != "completed"
        or new.conclusion != "success"
    ):
        raise CheckError("Latest workflow execution is not a later successful same-context replacement")
    if new.pull_requests[0] != pr:
        raise CheckError("Replacement does not match the current PR head/base")
    for run in (old, new):
        suite = Suite.model_validate(gh.api(f"{prefix}/check-suites/{run.check_suite_id}"))
        if suite.app.id != ACTIONS_APP or suite.head_sha != pr.head.sha:
            raise CheckError("Replacement check-suite SHA/app mismatch")
    jobs = [
        Job.model_validate(j)
        for j in gh.pages(
            f"{prefix}/actions/runs/{new.id}/attempts/{new.run_attempt}/jobs",
            "jobs",
        )
    ]
    green = {
        j.name
        for j in jobs
        if j.status == "completed"
        and j.conclusion == "success"
        and j.head_sha == pr.head.sha
        and j.run_id == new.id
        and j.run_attempt == new.run_attempt
    }
    if not green >= EXPECTED_MATRIX or any(
        j.status != "completed" or j.conclusion not in ("success", "skipped") for j in jobs
    ):
        raise CheckError("Replacement lacks complete successful CI matrix coverage")
    LOGGER.info(f"Superseded `{check.name}`: run {old.id} -> {new.id}")


def require_contexts(gh: GitHub, repo: str, pr: PullRequest, reported: list[ReportedCheck]) -> None:
    """Require every ruleset context with its bound app on this SHA.

    Parameters:
        gh (GitHub): Read-only evidence client.
        repo (str): Owner/repository identifier.
        pr (PullRequest): Current PR identity.
        reported (list[ReportedCheck]): Current CLI checks, including exact job URLs.

    Raises:
        CheckError: A required context is absent, ambiguous or unsuccessful.
    """
    prefix = f"repos/{repo}"
    rules = TypeAdapter(list[Rule]).validate_python(
        gh.api(f"{prefix}/rules/branches/{quote(pr.base.ref, safe='')}")
    )
    required = [
        c for r in rules if r.type == "required_status_checks" for c in r.parameters.required_status_checks
    ]
    if not required:
        raise CheckError("No required check rules found for pi-harness")
    checks = [
        CheckRun.model_validate(c)
        for c in gh.pages(
            f"{prefix}/commits/{pr.head.sha}/check-runs?filter=latest",
            "check_runs",
        )
    ]
    for requirement in required:
        matches = [
            c
            for c in checks
            if c.name == requirement.context
            and c.app.id == requirement.integration_id
            and any(r.name == c.name and r.link == c.html_url for r in reported)
        ]
        if len(matches) != 1 or any(
            c.head_sha != pr.head.sha or c.status != "completed" or c.conclusion != "success" for c in matches
        ):
            raise CheckError(f"Required context is not successful: {requirement.context}")


def gate(gh: GitHub, repo: str, number: str, sha: str) -> None:
    """Preserve the all-checks gate, admitting only proved superseded placeholders.

    Parameters:
        gh (GitHub): Read-only evidence client.
        repo (str): Owner/repository identifier.
        number (str): PR number.
        sha (str): Exact reviewed SHA.

    Raises:
        CheckError: Head drift or unsuccessful CI prevents merging.
        ValueError: GitHub returned malformed evidence.
    """
    pr = PullRequest.model_validate(gh.api(f"repos/{repo}/pulls/{number}"))
    if pr.head.sha != sha:
        raise CheckError(f"PR head {pr.head.sha} != reviewed {sha}")
    checks = TypeAdapter(list[ReportedCheck]).validate_python(
        gh.command("pr", "checks", number, "--repo", repo, "--json", "name,state,link"),
    )
    if not checks:
        raise CheckError("No checks reported")
    if repo == "nredd/pi-harness":
        require_contexts(gh, repo, pr, checks)
    bad = [c for c in checks if c.state not in ("SUCCESS", "SKIPPED")]
    runs = (
        [
            Run.model_validate(r)
            for r in gh.pages(
                f"repos/{repo}/actions/runs?head_sha={sha}",
                "workflow_runs",
            )
        ]
        if bad
        else []
    )
    for check in bad:
        if check.state != "CANCELLED":
            raise CheckError(f"{check.state} {check.name}")
        superseded(gh, repo, pr, check, runs)


def main() -> int:
    """Run the read-only gate using explicit operator-selected executable input.

    Returns:
        int: Zero for green CI, one on refusal.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pr")
    parser.add_argument("sha")
    parser.add_argument("repo")
    parser.add_argument("--gh", type=Path, default=os.environ.get("MERGE_PR_GH"))
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    try:
        if args.gh is None:
            raise CheckError("Set `MERGE_PR_GH` or `--gh` to the trusted absolute executable")
        gate(GitHub(args.gh), args.repo, args.pr, args.sha)
    except (CheckError, ValueError) as e:
        LOGGER.error(f"CI not green on {args.sha}: {e}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
