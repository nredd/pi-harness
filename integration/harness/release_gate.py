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
# One `ci.yml` step per owned gate. Each `owned (<os>)` check is a fan-in over `owned shard (<os>, <shard>)`
# jobs, and `scripts/ci_paths.py` `OWNED_SHARDS` plans which gates each shard runs: native cells run the
# Python suites, WSL keeps only the LCOV producers, and the macOS `python` shard carries the benchmark gate.
# Tests pin both tables to the plan and the step names to `ci.yml`.
OWNED_GATE_STEPS = {
    "check-ts": "Owned gate check-ts (biome, tsc, Vitest on Node and Bun, computer-use checks)",
    "check-scripts": "Owned gate check-scripts (ruff, ty, pytest scripts, import audit)",
    "check-integration": "Owned gate check-integration (ruff, ty, pytest integration units, probes)",
    "check-probes": "Owned gate check-probes (WSL LCOV producer)",
    "check-import-audit": "Owned gate check-import-audit (WSL LCOV producer)",
    "check-benchmark": "Benchmark unit gate",
}
OWNED_SHARDS = {
    "ubuntu-24.04": {
        "subagents": ("check-ts",),
        "computer-use": ("check-ts",),
        "ts": ("check-ts",),
        "python": ("check-scripts", "check-integration"),
    },
    "macos-14": {
        "ts": ("check-ts",),
        "python": ("check-scripts", "check-integration", "check-benchmark"),
    },
    "wsl2": {
        "subagents-computer-use": ("check-ts",),
        "ts": ("check-ts", "check-probes", "check-import-audit"),
    },
}
# The fan-in proves every shard succeeded, then accounts for the merged coverage reports.
OWNED_FAN_IN_STEPS = (
    "Require every planned shard to succeed",
    "Coverage accounting (existing reports, including test failures)",
)
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
# required-check name with no work behind it (`STACK_NOT_RUN` in `scripts/ci_paths.py`) and is never evidence.
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
    started_at: AwareDatetime = Field(strict=False, description="Start of the attempt that ran this job")
    completed_at: AwareDatetime | None = Field(strict=False, description="End of that execution")
    steps: list[Step] = Field(description="Executed step records")


class Artifact(Record):
    name: str = Field(description="Producer artifact name")
    expired: bool = Field(description="Whether bytes remain downloadable")
    size_in_bytes: int = Field(ge=0, description="Retained artifact size")
    workflow_run: Origin = Field(description="Artifact's source run and SHA")
    created_at: AwareDatetime = Field(strict=False, description="Upload time inside its producing job")


class RunsPage(Record):
    workflow_runs: list[Origin] = Field(description="Listed candidate executions")


class JobsPage(Record):
    jobs: list[dict[str, Any]] = Field(description="Current-attempt job records")


class ArtifactsPage(Record):
    artifacts: list[dict[str, Any]] = Field(description="Run artifact records")


def expected_jobs() -> dict[str, set[str]]:
    """Return required jobs and steps that must actually execute successfully.

    Returns:
        dict[str, set[str]]: Every owned fan-in and its shards, every contracts cell, each stack cell
        that runs one, and the Gitlinked core gate. Each shard names its planned gate steps. Stack
        cells the plan never runs are excluded.
    """
    expected = {}
    for system in SYSTEMS:
        expected[f"owned ({system})"] = set(OWNED_FAN_IN_STEPS)
        for shard, gates in OWNED_SHARDS[system].items():
            expected[f"owned shard ({system}, {shard})"] = {OWNED_GATE_STEPS[gate] for gate in gates}
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


def expected_artifacts() -> dict[str, str]:
    """Return the complete matrix's retained execution artifacts and the job that uploads each.

    Returns:
        dict[str, str]: Coverage, packed contracts, Node and standalone stack evidence, each mapped
        to its producing job name.
    """
    return {
        **{f"coverage-{system}": f"owned ({system})" for system in SYSTEMS},
        **{f"contract-reports-{system}": f"contracts ({system})" for system in SYSTEMS},
        **{f"stack-{system}-{stack}": f"stack ({system}, {stack})" for system, stack, _ in STACK_CELLS},
        **{
            f"standalone-{platform}-{stack}": f"stack ({system}, {stack})"
            for system, stack, platform in STACK_CELLS
        },
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
    admitted: dict[str, Job] = {}
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
        admitted[name] = job
    missing = []
    for name, producer_name in expected_artifacts().items():
        # Artifacts are per run, with no attempt field. "Re-run failed jobs" carries earlier
        # successful jobs, and their uploads, into the new attempt, while a re-run job leaves the
        # failed attempt's same-named upload behind. Bind each upload to its producing job's window.
        producer = admitted[producer_name]
        uploads = [
            artifact
            for artifact in validated_artifacts
            if artifact.name == name
            and not artifact.expired
            and artifact.size_in_bytes > 0
            and artifact.workflow_run.id == execution.id
            and artifact.workflow_run.head_sha == source_sha
            and producer.completed_at is not None
            and producer.started_at <= artifact.created_at <= producer.completed_at
        ]
        if len(uploads) != 1:
            missing.append(name)
    if missing:
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
