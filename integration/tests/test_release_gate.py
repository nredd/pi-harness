"""Synthetic counterexamples for the frozen full execution barrier.

References:
    https://docs.github.com/en/rest/actions/workflow-jobs
"""

from __future__ import annotations

import copy
import runpy
import sys
from pathlib import Path
from typing import Any

import pytest
import yaml

from harness import release_gate as gate

SHA = "a" * 40
ROOT = Path(__file__).resolve().parents[2]


def evidence() -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    """Build explicit synthetic evidence, never a hosted execution receipt.

    Returns:
        tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]: Run, jobs and artifacts.
    """
    run = {
        "id": 42,
        "run_attempt": 2,
        "head_sha": SHA,
        "head_branch": "main",
        "event": "workflow_dispatch",
        "path": ".github/workflows/ci.yml",
        "status": "completed",
        "conclusion": "success",
        "run_started_at": "2026-11-03T10:00:00Z",
    }
    jobs = [
        {
            "name": name,
            "run_id": 42,
            "run_attempt": 2,
            "head_sha": SHA,
            "status": "completed",
            "conclusion": "success",
            "steps": [{"name": step, "status": "completed", "conclusion": "success"} for step in steps],
        }
        for name, steps in gate.expected_jobs().items()
    ]
    artifacts = [
        {
            "name": name,
            "expired": False,
            "size_in_bytes": 1,
            "workflow_run": {"id": 42, "head_sha": SHA},
            "created_at": "2026-11-03T10:30:00Z",
        }
        for name in gate.expected_artifacts()
    ]
    return run, jobs, artifacts


def test_exact_frozen_candidate() -> None:
    """A full execution needs no comparison against the moving current main tip.

    Returns:
        None: The exact immutable candidate is accepted.
    """
    assert gate.validate_execution(SHA, *evidence()) == 42


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("head_sha", "b" * 40),
        ("head_branch", "feature"),
        ("event", "push"),
        ("event", "pull_request"),
        ("status", "in_progress"),
        ("conclusion", "failure"),
        ("path", ".github/workflows/other.yml"),
    ],
)
def test_reject_other_or_incomplete_run(field: str, value: str) -> None:
    """Reject PR green checks, selective main smoke and different candidates.

    Parameters:
        field (str): Run field to corrupt.
        value (str): Invalid value.

    Returns:
        None: Admission refuses the execution.
    """
    run, jobs, artifacts = evidence()
    run[field] = value
    with pytest.raises(ValueError, match="successful exact-SHA"):
        gate.validate_execution(SHA, run, jobs, artifacts)


@pytest.mark.parametrize(
    "change",
    [
        "missing",
        "duplicate",
        "skipped_step",
        "missing_steps",
        "old_attempt",
        "wrong_sha",
        "failed_job",
        "foreign_run",
        "in_progress",
    ],
)
def test_every_job_actually_executed(change: str) -> None:
    """Successful job labels alone cannot turn bypassed cells into release evidence.

    Parameters:
        change (str): Missing or invalid job mutation.

    Returns:
        None: Admission refuses incomplete execution.
    """
    run, jobs, artifacts = evidence()
    if change == "missing":
        jobs.pop()
    elif change == "duplicate":
        jobs.append(copy.deepcopy(jobs[0]))
    elif change == "skipped_step":
        jobs[0]["steps"][0]["conclusion"] = "skipped"
    elif change == "missing_steps":
        jobs[0]["steps"] = []
    elif change == "old_attempt":
        jobs[0]["run_attempt"] = 1
    elif change == "failed_job":
        # Every required step is green, but the job itself failed, e.g. a later unnamed step.
        jobs[0]["conclusion"] = "failure"
    elif change == "foreign_run":
        jobs[0]["run_id"] = 43
    elif change == "in_progress":
        jobs[0]["status"] = "in_progress"
    else:
        jobs[0]["head_sha"] = "b" * 40
    with pytest.raises(ValueError, match=r"verification (job|steps)"):
        gate.validate_execution(SHA, run, jobs, artifacts)


@pytest.mark.parametrize("change", ["missing", "expired", "wrong_run", "wrong_sha", "empty", "older_attempt"])
def test_complete_retained_artifacts(change: str) -> None:
    """Retained machine evidence is mandatory for every native cell.

    Parameters:
        change (str): Missing or invalid artifact mutation.

    Returns:
        None: Admission refuses missing or unrelated artifacts.
    """
    run, jobs, artifacts = evidence()
    if change == "missing":
        artifacts.pop()
    elif change == "expired":
        artifacts[0]["expired"] = True
    elif change == "wrong_run":
        artifacts[0]["workflow_run"]["id"] = 99
    elif change == "wrong_sha":
        artifacts[0]["workflow_run"]["head_sha"] = "b" * 40
    elif change == "older_attempt":
        artifacts[0]["created_at"] = "2026-11-03T09:59:59Z"
    else:
        artifacts[0]["size_in_bytes"] = 0
    with pytest.raises(ValueError, match="Missing retained"):
        gate.validate_execution(SHA, run, jobs, artifacts)


def test_required_job_names_are_pinned() -> None:
    """Name every required cell literally, so dropping one cannot pass via `expected_jobs()` fixtures.

    Returns:
        None: The admission set is exactly the full lane.
    """
    assert set(gate.expected_jobs()) == {
        "owned (ubuntu-24.04)",
        "owned (macos-14)",
        "owned (wsl2)",
        "contracts (ubuntu-24.04)",
        "contracts (macos-14)",
        "contracts (wsl2)",
        "stack (ubuntu-24.04, personal)",
        "stack (ubuntu-24.04, local)",
        "stack (macos-14, local)",
        "release-core / core (forks/pi)",
    }
    assert gate.expected_jobs()["release-core / core (forks/pi)"] == {
        "Build",
        "Check without rewriting",
        "Build the pi-env daemon",
        "Test (isolated HOME, no credentials)",
    }


def test_workflow_execution_names_and_barriers() -> None:
    """Bind the bounded verifier to real producers and both privileged entrypoints.

    Returns:
        None: Step contracts and before-write workflow ordering agree.
    """
    ci = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())
    fork = yaml.safe_load((ROOT / ".github/workflows/forks.yml").read_text())
    for name, required in gate.expected_jobs().items():
        job = fork["jobs"]["core"] if name.startswith("release-core") else ci["jobs"][name.split(" ")[0]]
        assert required <= {step.get("name") for step in job["steps"]}
    assert ci["jobs"]["release-core"]["uses"] == "./.github/workflows/forks.yml"
    for workflow, job_names in [("publish.yml", ["verify", "publish"]), ("promote-stack.yml", ["verify"])]:
        cfg = yaml.safe_load((ROOT / ".github/workflows" / workflow).read_text())
        for name in job_names:
            steps = cfg["jobs"][name]["steps"]
            barriers = [i for i, step in enumerate(steps) if "-m harness.release_gate" in step.get("run", "")]
            assert len(barriers) == 1
            assert cfg["jobs"][name]["permissions"]["actions"] == "read"
            protected = [
                i
                for i, step in enumerate(steps)
                if "npm publish" in step.get("run", "")
                or "-m harness.promotion_verify" in step.get("run", "")
            ]
            assert all(barriers[0] < index for index in protected)


def test_stack_cells_are_exactly_the_executing_matrix() -> None:
    """Require every stack cell that runs, and never a `not_run` required-check name.

    Returns:
        None: The verifier's stack cells and platforms match `ci.yml`.
    """
    matrix = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())["jobs"]["stack"]["strategy"][
        "matrix"
    ]
    include = matrix["include"]
    idle = {(entry["os"], entry["stack"]) for entry in include if "not_run" in entry and "stack" in entry}
    idle |= {
        (entry["os"], stack)
        for entry in include
        if "not_run" in entry and "stack" not in entry
        for stack in matrix["stack"]
    }
    platform = {entry["os"]: entry["platform"] for entry in include if "not_run" not in entry}
    executing = {
        (os, stack, platform[os])
        for os in matrix["os"]
        for stack in matrix["stack"]
        if (os, stack) not in idle
    }
    assert {name for name in gate.expected_jobs() if name.startswith("stack ")} == {
        f"stack ({os}, {stack})" for os, stack, _ in executing
    }
    assert set(gate.STACK_CELLS) == executing


def test_discovery_reads_all_pages(monkeypatch: pytest.MonkeyPatch) -> None:
    """Select qualified exact evidence after an unsuitable old execution.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): Isolated API replacement.

    Returns:
        None: Paged evidence is flattened and a complete execution qualifies.
    """
    run, jobs, artifacts = evidence()
    paths: list[str] = []

    def api(path: str) -> Any:
        """Replay paginated run, current-attempt job and artifact responses.

        Parameters:
            path (str): Read-only Actions endpoint requested by the real verifier.

        Returns:
            Any: Slurped synthetic REST pages for the requested collection or detail.
        """
        paths.append(path)
        if "/workflows/" in path:
            return [
                {"workflow_runs": [{"id": 1, "head_sha": SHA}]},
                {"workflow_runs": [{"id": 42, "head_sha": SHA}]},
            ]
        if path.endswith("/runs/1"):
            return [run | {"id": 1, "conclusion": "failure"}]
        if path.endswith("/runs/42"):
            return [run]
        if "/jobs?" in path:
            return [{"jobs": jobs[:3]}, {"jobs": jobs[3:]}]
        return [{"artifacts": artifacts}]

    monkeypatch.setattr(gate, "api", api)
    assert gate.require_full_verification("nredd/pi-harness", SHA) == 42
    assert paths[0] == (
        f"repos/nredd/pi-harness/actions/workflows/ci.yml/runs?head_sha={SHA}&event=workflow_dispatch&per_page=100"
    )
    assert not any("/runs/1/" in path for path in paths)


def test_discovery_skips_a_successful_but_incomplete_run(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """A green dispatch missing a cell is logged and skipped, and a later complete one qualifies.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): Isolated API replacement.
        caplog (pytest.LogCaptureFixture): Captured skip diagnostics.

    Returns:
        None: The complete execution is selected.
    """
    run, jobs, artifacts = evidence()
    first = run | {"id": 7}

    def api(path: str) -> Any:
        """Serve one successful run lacking a job, then a complete run.

        Parameters:
            path (str): Read-only Actions endpoint.

        Returns:
            Any: Slurped synthetic pages.
        """
        if "/workflows/" in path:
            return [{"workflow_runs": [{"id": 7, "head_sha": SHA}, {"id": 42, "head_sha": SHA}]}]
        if path.endswith("/runs/7"):
            return [first]
        if path.endswith("/runs/42"):
            return [run]
        if "/runs/7/" in path and "/jobs?" in path:
            return [{"jobs": [job | {"run_id": 7} for job in jobs[1:]]}]
        if "/jobs?" in path:
            return [{"jobs": jobs}]
        return [{"artifacts": artifacts}]

    monkeypatch.setattr(gate, "api", api)
    with caplog.at_level("INFO", logger=gate.LOGGER.name):
        assert gate.require_full_verification("nredd/pi-harness", SHA) == 42
    assert "CI run 7 does not qualify: Missing or ambiguous full verification job" in caplog.text


@pytest.mark.parametrize(
    "pages",
    [[{}], [{"workflow_runs": [{"id": "42", "head_sha": SHA}]}], [{"workflow_runs": [{"id": 42}]}]],
)
def test_malformed_pages_refuse(monkeypatch: pytest.MonkeyPatch, pages: list[dict[str, Any]]) -> None:
    """A malformed REST page is a validation refusal, never a raw `KeyError`.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): Isolated API replacement.
        pages (list[dict[str, Any]]): Broken run listing.

    Returns:
        None: Validation refuses.
    """
    monkeypatch.setattr(gate, "api", lambda _path: pages)
    with pytest.raises(ValueError, match="validation error"):
        gate.require_full_verification("nredd/pi-harness", SHA)


def test_main_exit_codes(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    """Zero with evidence, one when refused, and a harness bug is a traceback, not a refusal.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): Isolated barrier replacement.
        caplog (pytest.LogCaptureFixture): Captured barrier diagnostics.

    Returns:
        None: Each outcome is distinguishable.
    """
    argv = ["--repo", "nredd/pi-harness", "--source-sha", SHA]
    caplog.set_level("INFO", logger=gate.LOGGER.name)
    monkeypatch.setattr(gate, "require_full_verification", lambda _repo, _sha: 42)
    assert gate.main(argv) == 0
    assert f"Full frozen candidate verification: {SHA}, CI run 42" in caplog.text
    for refusal in (ValueError("no run"), gate.EvidenceError("gh failed")):

        def refuse(_repo: str, _sha: str, error: Exception = refusal) -> int:
            """Refuse with one expected error.

            Parameters:
                _repo (str): Unused repository.
                _sha (str): Unused candidate.
                error (Exception): Refusal to raise.

            Returns:
                int: Never returns.

            Raises:
                Exception: Always, the given refusal.
            """
            raise error

        monkeypatch.setattr(gate, "require_full_verification", refuse)
        assert gate.main(argv) == 1
        assert f"Release verification refused: {refusal}" in caplog.text

    def bug(_repo: str, _sha: str) -> int:
        """Simulate a harness defect.

        Parameters:
            _repo (str): Unused repository.
            _sha (str): Unused candidate.

        Returns:
            int: Never returns.

        Raises:
            KeyError: Always.
        """
        raise KeyError("workflow_runs")

    monkeypatch.setattr(gate, "require_full_verification", bug)
    with pytest.raises(KeyError):
        gate.main(argv)


def test_frozen_ref_survives_unrelated_main_advancement() -> None:
    """An older main candidate can run on its SHA-encoded frozen ref.

    Returns:
        None: The fixed candidate qualifies without newest-tip identity.
    """
    run, jobs, artifacts = evidence()
    run["head_branch"] = f"release-verification/{SHA}"
    assert gate.validate_execution(SHA, run, jobs, artifacts) == 42
    run["head_branch"] = f"release-verification/{'b' * 40}"
    with pytest.raises(ValueError, match="successful exact-SHA"):
        gate.validate_execution(SHA, run, jobs, artifacts)


@pytest.mark.parametrize("invalid", ["short", "A" * 40, "g" * 40])
def test_invalid_candidate_refuses_before_api(invalid: str) -> None:
    """Validate the candidate before any API query.

    Parameters:
        invalid (str): Malformed candidate identity.

    Returns:
        None: Refuses without external work.
    """
    with pytest.raises(ValueError, match="full lowercase"):
        gate.require_full_verification("nredd/pi-harness", invalid)


def test_typed_evidence_rejects_coercion() -> None:
    """A stringified run ID cannot establish machine execution identity.

    Returns:
        None: Strict Pydantic validation refuses malformed evidence.
    """
    run, jobs, artifacts = evidence()
    run["id"] = "42"
    with pytest.raises(ValueError, match="valid integer"):
        gate.validate_execution(SHA, run, jobs, artifacts)


def test_api_uses_explicit_absolute_executable(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A poisoned PATH cannot replace the release-barrier evidence client.

    Parameters:
        tmp_path (Path): Disposable executables.
        monkeypatch (pytest.MonkeyPatch): Isolated executable configuration.

    Returns:
        None: Production subprocess adapter uses only the chosen trusted path.
    """
    trusted = tmp_path / "trusted-gh"
    trusted.write_text("#!/bin/sh\nprintf '[{\"fixture\": true}]\\n'\n")
    trusted.chmod(0o700)
    poison = tmp_path / "gh"
    poison.write_text("#!/bin/sh\nexit 99\n")
    poison.chmod(0o700)
    monkeypatch.setenv("PATH", str(tmp_path))
    monkeypatch.setenv("RELEASE_GATE_GH", str(trusted))
    assert gate.api("repos/nredd/pi-harness/actions/runs") == [{"fixture": True}]
    monkeypatch.chdir(tmp_path)
    for untrusted in ("trusted-gh", str(tmp_path / "missing-gh")):
        monkeypatch.setenv("RELEASE_GATE_GH", untrusted)
        with pytest.raises(gate.EvidenceError, match="Invalid trusted"):
            gate.api("repos/nredd/pi-harness/actions/runs")


def test_no_evidence_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    """Historical green PRs or main pushes are not fallback release receipts.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): Isolated API replacement.

    Returns:
        None: Missing dispatch evidence refuses publication.
    """
    monkeypatch.setattr(gate, "api", lambda _: [{"workflow_runs": []}])
    with pytest.raises(ValueError, match="No executed full"):
        gate.require_full_verification("nredd/pi-harness", SHA)


def test_module_entrypoint_refuses_a_malformed_candidate(monkeypatch: pytest.MonkeyPatch) -> None:
    """`python -m harness.release_gate` exits 1 before any GitHub read.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): Isolated argv and executable.

    Returns:
        None: The real entrypoint's exit status is the refusal code.
    """
    monkeypatch.setenv("RELEASE_GATE_GH", "/nonexistent/gh")
    monkeypatch.setattr(sys, "argv", ["release_gate", "--repo", "nredd/pi-harness", "--source-sha", "short"])
    monkeypatch.delitem(sys.modules, "harness.release_gate")
    with pytest.raises(SystemExit) as exit_info:
        runpy.run_module("harness.release_gate", run_name="__main__")
    assert exit_info.value.code == 1
