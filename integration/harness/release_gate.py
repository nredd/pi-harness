"""Require executed full CI evidence for a frozen combined main candidate.

References:
    https://docs.github.com/en/rest/actions/workflow-runs
    https://docs.github.com/en/rest/actions/workflow-jobs
    https://docs.github.com/en/rest/actions/artifacts
"""

from __future__ import annotations

import argparse
import json
import logging
import os
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

from harness.promotion import EvidenceError, run_command

LOGGER = logging.getLogger(__name__)
SYSTEMS = ("ubuntu-24.04", "macos-14", "wsl2")
OWNED_STEP = "Owned gates (biome, tsc, Vitest on Node and Bun, scripts, integration units)"
CONTRACT_STEPS = (
    "Packed plugins alone on exact stock Pi, plus packed preset audit",
    "Packed pi-plan-mode with its registry dependency on exact stock Pi",
    "Packed pi-computer-use on exact stock Pi (native desktop not run)",
    "Packed pi-subagents with its registry dependencies on exact stock Pi",
    "Packed pi-todo with its registry dependencies on exact stock Pi",
)
STACK_STEP = "Assembled D and E boundaries (explicit stack, no machine config)"


class Record(BaseModel):
    model_config = ConfigDict(strict=True, frozen=True)


class Origin(Record):
    id: int = Field(gt=0, description="Owning Actions run identifier")
    head_sha: str = Field(description="Immutable source commit")


class Execution(Origin):
    run_attempt: int = Field(gt=0, description="Current Actions attempt")
    head_branch: str = Field(description="Main or exact frozen candidate ref")
    event: str = Field(description="Workflow trigger")
    path: str = Field(description="Workflow source path")
    status: str = Field(description="Execution lifecycle")
    conclusion: str | None = Field(description="Terminal outcome")


class Step(Record):
    name: str = Field(description="Producer execution step")
    status: str = Field(description="Step lifecycle")
    conclusion: str | None = Field(description="Actual execution outcome")


class Job(Record):
    name: str = Field(description="Expanded matrix or reusable job name")
    run_id: int = Field(gt=0, description="Owning Actions run")
    run_attempt: int = Field(gt=0, description="Owning run attempt")
    head_sha: str = Field(description="Source commit")
    status: str = Field(description="Job lifecycle")
    conclusion: str | None = Field(description="Job outcome")
    steps: list[Step] = Field(description="Executed step records")


class Artifact(Record):
    name: str = Field(description="Producer artifact name")
    expired: bool = Field(description="Whether bytes remain downloadable")
    size_in_bytes: int = Field(ge=0, description="Retained artifact size")
    workflow_run: Origin = Field(description="Artifact's source run and SHA")


def expected_jobs() -> dict[str, set[str]]:
    """Return required jobs and steps that must actually execute successfully.

    Returns:
        dict[str, set[str]]: Full native matrix plus the Gitlinked core gate.
    """
    expected = {}
    for system in SYSTEMS:
        owned = {OWNED_STEP, "Coverage accounting (existing reports, including test failures)"}
        if system == "macos-14":
            owned.add("Benchmark unit gate")
        expected[f"owned ({system})"] = owned
        expected[f"contracts ({system})"] = set(CONTRACT_STEPS)
        for stack in ("personal", "local"):
            steps = {STACK_STEP}
            if stack == "personal":
                steps |= {"Standalone D and E (personal)", "Standalone D and E (local)"}
            expected[f"stack ({system}, {stack})"] = steps
    expected["release-core / core (forks/pi)"] = {
        "Build",
        "Check without rewriting",
        "Build the pi-env daemon",
        "Test (isolated HOME, no credentials)",
    }
    return expected


def expected_artifacts() -> set[str]:
    """Return the complete matrix's retained execution artifacts.

    Returns:
        set[str]: Coverage, packed contracts, Node and standalone stack evidence.
    """
    return {
        *[f"coverage-{system}" for system in SYSTEMS],
        *[f"contract-reports-{system}" for system in SYSTEMS],
        *[f"stack-{system}-{stack}" for system in SYSTEMS for stack in ("personal", "local")],
        "standalone-linux-x64",
        "standalone-darwin-arm64",
        "standalone-wsl2-linux-x64",
    }


def validate_execution(
    source_sha: str, run: dict[str, Any], jobs: list[dict[str, Any]], artifacts: list[dict[str, Any]]
) -> int:
    """Validate one exact dispatch, never a PR run or selective main-push smoke.

    Parameters:
        source_sha (str): Frozen combined candidate commit.
        run (dict[str, Any]): Actions run detail.
        jobs (list[dict[str, Any]]): All jobs from its current attempt.
        artifacts (list[dict[str, Any]]): All artifacts from the same run.

    Returns:
        int: Qualified CI run identifier.

    Raises:
        ValueError: Identity, executed steps or retained artifacts are missing.
    """
    execution = Execution.model_validate(run)
    validated_jobs = TypeAdapter(list[Job]).validate_python(jobs)
    validated_artifacts = TypeAdapter(list[Artifact]).validate_python(artifacts)
    if not (
        execution.head_sha == source_sha
        and execution.head_branch in ("main", f"release-verification/{source_sha}")
        and execution.event == "workflow_dispatch"
        and execution.path == ".github/workflows/ci.yml"
        and execution.status == "completed"
        and execution.conclusion == "success"
    ):
        raise ValueError(
            "Full verification requires a successful exact-SHA CI dispatch "
            "on `main` or its frozen candidate ref"
        )
    for name, required_steps in expected_jobs().items():
        matches = [job for job in validated_jobs if job.name == name]
        if len(matches) != 1:
            raise ValueError(f"Missing or ambiguous full verification job: '{name}'")
        job = matches[0]
        executed = {
            step.name for step in job.steps if step.status == "completed" and step.conclusion == "success"
        }
        if not (
            job.head_sha == source_sha
            and job.run_id == execution.id
            and job.run_attempt == execution.run_attempt
            and job.status == "completed"
            and job.conclusion == "success"
            and required_steps <= executed
        ):
            raise ValueError(f"Full verification steps did not execute: '{name}'")
    retained = {
        artifact.name
        for artifact in validated_artifacts
        if not artifact.expired
        and artifact.size_in_bytes > 0
        and artifact.workflow_run.id == execution.id
        and artifact.workflow_run.head_sha == source_sha
    }
    if missing := expected_artifacts() - retained:
        raise ValueError(f"Missing retained full verification artifacts: {sorted(missing)}")
    return execution.id


def api(path: str) -> Any:
    """Read paginated GitHub evidence using the existing trusted runner adapter.

    Parameters:
        path (str): GitHub REST endpoint.

    Returns:
        Any: Decoded slurped response pages.

    Raises:
        EvidenceError: The trusted absolute executable is unavailable or GitHub fails.
        ValueError: The response is not JSON.
    """
    binary = Path(os.environ.get("RELEASE_GATE_GH", "/usr/bin/gh"))
    if not binary.is_absolute() or not binary.is_file() or not os.access(binary, os.X_OK):
        raise EvidenceError(f"Invalid trusted `gh` executable: '{binary}'")
    return json.loads(run_command(str(binary.resolve()), "api", "--paginate", "--slurp", path).stdout)


def require_full_verification(repo: str, source_sha: str) -> int:
    """Require a complete full dispatch of this candidate, regardless of later main advances.

    Parameters:
        repo (str): GitHub repository.
        source_sha (str): Exact selected main commit, validated for ancestry by the caller.

    Returns:
        int: Qualifying full verification run ID.

    Raises:
        ValueError: No complete evidence exists. Historical main-smoke runs cannot qualify.
        EvidenceError: GitHub evidence could not be read.
    """
    if len(source_sha) != 40 or any(char not in "0123456789abcdef" for char in source_sha):
        raise ValueError("Release candidate must be a full lowercase commit SHA")
    prefix = f"repos/{repo}/actions"
    pages = api(f"{prefix}/workflows/ci.yml/runs?head_sha={source_sha}&event=workflow_dispatch&per_page=100")
    for page in pages:
        for entry in page["workflow_runs"]:
            run = api(f"{prefix}/runs/{entry['id']}")[0]
            if run.get("status") != "completed" or run.get("conclusion") != "success":
                continue
            jobs = [
                job
                for p in api(f"{prefix}/runs/{run['id']}/attempts/{run['run_attempt']}/jobs?per_page=100")
                for job in p["jobs"]
            ]
            artifacts = [
                artifact
                for p in api(f"{prefix}/runs/{run['id']}/artifacts?per_page=100")
                for artifact in p["artifacts"]
            ]
            try:
                return validate_execution(source_sha, run, jobs, artifacts)
            except ValueError as error:
                LOGGER.info(f"CI run {run['id']} does not qualify: {error}")
    raise ValueError(f"No executed full release verification for '{source_sha}'; dispatch `ci.yml` on `main`")


def main() -> int:
    """Run the fail-closed publication/promotion barrier.

    Returns:
        int: Zero only with full execution evidence.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--source-sha", required=True)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    try:
        run_id = require_full_verification(args.repo, args.source_sha)
    except (ValueError, EvidenceError, KeyError, TypeError) as error:
        LOGGER.error(f"Release verification refused: {error}")
        return 1
    LOGGER.info(f"Full frozen candidate verification: {args.source_sha}, CI run {run_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
