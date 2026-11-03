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

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, TypeAdapter

from harness.promotion import SHA_PATTERN, EvidenceError, run_command

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
STARTUP_STEP = "Strict standalone startup with failure-only diagnostics"
# Cells that run a stack, as (system, stack, standalone platform). Every other stack cell is a
# required-check name with no work behind it (`not_run` in ci.yml) and is never evidence.
STACK_CELLS = (
    ("ubuntu-24.04", "personal", "linux-x64"),
    ("ubuntu-24.04", "local", "linux-x64"),
    ("macos-14", "local", "darwin-arm64"),
)


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
    run_started_at: AwareDatetime = Field(strict=False, description="Start of the current attempt")


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
    created_at: AwareDatetime = Field(strict=False, description="Upload time, bounding the producing attempt")


class RunsPage(Record):
    workflow_runs: list[Origin] = Field(description="Listed candidate executions")


class JobsPage(Record):
    jobs: list[dict[str, Any]] = Field(description="Current-attempt job records")


class ArtifactsPage(Record):
    artifacts: list[dict[str, Any]] = Field(description="Run artifact records")


def expected_jobs() -> dict[str, set[str]]:
    """Return required jobs and steps that must actually execute successfully.

    Returns:
        dict[str, set[str]]: Every owned and contracts cell, each stack cell that runs one, and the
        Gitlinked core gate. `not_run` stack cells are excluded.
    """
    expected = {}
    for system in SYSTEMS:
        owned = {OWNED_STEP, "Coverage accounting (existing reports, including test failures)"}
        if system == "macos-14":
            owned.add("Benchmark unit gate")
        expected[f"owned ({system})"] = owned
        expected[f"contracts ({system})"] = set(CONTRACT_STEPS)
    for system, stack, platform in STACK_CELLS:
        steps = {
            STACK_STEP,
            f"Standalone D and E ({stack})",
            f"Candidate compiled-core auth adapter ({stack})",
        }
        if platform == "linux-x64" and stack == "personal":
            steps.add(STARTUP_STEP)
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
        *[f"stack-{system}-{stack}" for system, stack, _ in STACK_CELLS],
        *[f"standalone-{platform}-{stack}" for _, stack, platform in STACK_CELLS],
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
        # The artifacts API has no attempt field; an upload before this attempt started is stale.
        and artifact.created_at >= execution.run_started_at
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
        ValueError: No complete evidence exists, or a response is malformed. Historical main-smoke
            runs cannot qualify.
        EvidenceError: GitHub evidence could not be read.
    """
    if SHA_PATTERN.fullmatch(source_sha) is None:
        raise ValueError("Release candidate must be a full lowercase commit SHA")
    prefix = f"repos/{repo}/actions"
    listed = api(f"{prefix}/workflows/ci.yml/runs?head_sha={source_sha}&event=workflow_dispatch&per_page=100")
    for page in TypeAdapter(list[RunsPage]).validate_python(listed):
        for entry in page.workflow_runs:
            (run,) = TypeAdapter(tuple[dict[str, Any]]).validate_python(api(f"{prefix}/runs/{entry.id}"))
            execution = Execution.model_validate(run)
            if execution.status != "completed" or execution.conclusion != "success":
                continue
            run_path = f"{prefix}/runs/{execution.id}"
            jobs = TypeAdapter(list[JobsPage]).validate_python(
                api(f"{run_path}/attempts/{execution.run_attempt}/jobs?per_page=100")
            )
            artifacts = TypeAdapter(list[ArtifactsPage]).validate_python(
                api(f"{run_path}/artifacts?per_page=100")
            )
            try:
                return validate_execution(
                    source_sha,
                    run,
                    [job for p in jobs for job in p.jobs],
                    [artifact for p in artifacts for artifact in p.artifacts],
                )
            except ValueError as error:
                LOGGER.info(f"CI run {execution.id} does not qualify: {error}")
    raise ValueError(f"No executed full release verification for '{source_sha}'; dispatch `ci.yml` on `main`")


def main(argv: list[str] | None = None) -> int:
    """Run the fail-closed publication/promotion barrier.

    Parameters:
        argv (list[str] | None): Arguments, `sys.argv` when omitted.

    Returns:
        int: Zero only with full execution evidence, one when refused. A harness bug raises.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--source-sha", required=True)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    try:
        run_id = require_full_verification(args.repo, args.source_sha)
    except (ValueError, EvidenceError) as error:
        LOGGER.error(f"Release verification refused: {error}")
        return 1
    LOGGER.info(f"Full frozen candidate verification: {args.source_sha}, CI run {run_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
