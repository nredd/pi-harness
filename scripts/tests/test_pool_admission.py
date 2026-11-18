"""Exercise burst admission at the planner's public capacity boundary.

References:
    https://docs.github.com/en/rest/actions/workflow-runs
"""

from __future__ import annotations

import heapq
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ci_paths
import runner_pools
import runner_rescue

REPO = "example/project"
NOW = 1_800_000_000


def census(count: int) -> tuple[list[dict[str, Any]], dict[int, list[dict[str, Any]]]]:
    """Build API-shaped snapshots of a same-heartbeat classification burst."""
    runs = [{"id": i, "head_repository": {"full_name": REPO}} for i in range(1, count + 1)]
    jobs = {
        i: [{"name": "classify changed paths", "status": "in_progress", "labels": []}]
        for i in range(1, count + 1)
    }
    return runs, jobs


def test_nine_run_burst_uses_both_pools_without_reusing_free_five() -> None:
    """Replay incident free=5, with timestamps normalized and one working account.

    Hosted simulation has nine executors and the observed 215-second median start delay. The old
    planner sent 54 cells to one working account; this policy must not queue any of them there.
    """
    runs, jobs = census(9)
    capacity = runner_pools.pool_capacity({"pi-macos": f"{NOW - 30}:5"}, NOW, trusted=True)
    cells = [key for key in runner_pools.CELL_SECONDS if key[1] == "macos-14"]
    pooled: list[runner_pools.CellKey] = []
    hosted: list[runner_pools.CellKey] = []
    # Even progressively visible snapshots cannot let a later classifier spend the same slot.
    for run in runs:
        prefix = runs[: run["id"]]
        admitted = runner_pools.admit_capacity(capacity, prefix, jobs, run["id"], REPO)
        chosen = runner_pools.assign_cells(cells, admitted)
        pooled.extend(chosen)
        hosted.extend(key for key in cells if key not in chosen)
    assert pooled == [("stack", "macos-14", "local")]
    assert len(hosted) == 53
    lanes = [215] * 9
    waits = []
    for key in hosted:
        start = heapq.heappop(lanes)
        waits.append(start)
        heapq.heappush(lanes, start + runner_pools.CELL_SECONDS[key])
    assert max(waits) <= 3000
    assert sum(waits) <= 80000
    assert len(pooled) <= 1  # No self-hosted queue, even with nine reads of the same free=5 beat.


def test_admission_accounts_for_jobs_and_unmaterialized_older_runs() -> None:
    """Running/queued pool jobs reserve capacity, but hosted jobs and forks do not."""
    runs, jobs = census(3)
    jobs[1] = [{"name": "owned", "status": "queued", "labels": ["pi-linux"]}]
    jobs[2] = [{"name": "owned", "status": "in_progress", "labels": ["xcode-27"]}]
    assert runner_pools.admit_capacity({"pi-linux": 2, "pi-macos": 1}, runs, jobs, 3, REPO) == {
        "pi-linux": 1,
        "pi-macos": 1,
    }
    assert runner_pools.admit_capacity({"pi-linux": 1}, runs, jobs, 3, REPO) == {"pi-linux": 1}
    jobs[1] = [{"name": "classify changed paths", "status": "completed", "labels": []}]
    assert runner_pools.admit_capacity({"pi-macos": 1}, runs, jobs, 3, REPO) == {"pi-macos": 0}
    jobs[1] = [{"name": "owned shard (macos-14, ts)", "status": "queued", "labels": []}]
    assert runner_pools.admit_capacity({"pi-macos": 1}, runs, jobs, 3, REPO) == {"pi-macos": 0}
    jobs[1] = []
    assert runner_pools.admit_capacity({"pi-macos": 1}, runs, jobs, 3, REPO) == {"pi-macos": 0}
    runs[0]["head_repository"] = {"full_name": "fork/project"}
    assert runner_pools.admit_capacity({"pi-macos": 1}, runs, jobs, 3, REPO) == {"pi-macos": 1}
    assert runner_pools.admit_capacity({"pi-macos": 1}, runs, {}, 3, REPO) == {}
    assert runner_pools.admit_capacity({"pi-macos": 1}, runs, jobs, 10, REPO) == {}


def fake_api(
    monkeypatch: pytest.MonkeyPatch, *, full: str = "", previous: list[dict[str, Any]] | None = None
) -> list[str]:
    """Install a bounded API transcript, including duplicate status-page entries."""
    runs, jobs = census(1)
    calls: list[str] = []

    def read(path: str) -> dict[str, Any]:
        calls.append(path)
        if "/attempts/" in path:
            return {"total_count": 100 if full == "previous" else 1, "jobs": previous or []}
        if "/jobs?" in path:
            return {"total_count": 100 if full == "jobs" else 1, "jobs": jobs[1]}
        return {"total_count": 100 if full == "runs" else 1, "workflow_runs": runs}

    monkeypatch.setattr(runner_pools, "gh_read", read)
    return calls


def test_live_census_and_retry_do_not_return_to_a_previous_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    """A hosted queue can migrate to a pool; a rescued pool cannot attract it back."""
    calls = fake_api(monkeypatch)
    assert runner_pools.live_capacity({"pi-macos": 1}, REPO, 1) == {"pi-macos": 1}
    assert len(calls) == 6
    fake_api(monkeypatch, previous=[{"labels": ["pi-macos"]}])
    assert runner_pools.live_capacity({"pi-linux": 1, "pi-macos": 1}, REPO, 1, 2) == {
        "pi-linux": 1,
        "pi-macos": 0,
    }
    fake_api(monkeypatch, previous=[{"labels": ["xcode-27"]}])
    assert runner_pools.live_capacity({"pi-macos": 1}, REPO, 1, 2) == {"pi-macos": 1}
    assert runner_pools.live_capacity({}, REPO, 1) == {}
    assert runner_pools.live_capacity({"pi-macos": 0}, REPO, 1) == {}


@pytest.mark.parametrize("full", ["runs", "jobs", "previous"])
def test_incomplete_census_fails_closed(monkeypatch: pytest.MonkeyPatch, full: str) -> None:
    """Unseen jobs or runs could own every slot."""
    fake_api(monkeypatch, full=full)
    assert runner_pools.live_capacity({"pi-macos": 1}, REPO, 1, 2) == {}


@pytest.mark.parametrize(
    "error",
    [
        OSError("offline"),
        subprocess.CalledProcessError(1, "gh"),
        subprocess.TimeoutExpired("gh", 10),
        ValueError("bad JSON"),
        KeyError("jobs"),
        TypeError("bad page"),
    ],
)
def test_unavailable_census_overflows_hosted(monkeypatch: pytest.MonkeyPatch, error: Exception) -> None:
    """An API problem cannot strand jobs or block required checks."""

    def fail(_path: str) -> Any:
        raise error

    monkeypatch.setattr(runner_pools, "gh_read", fail)
    assert runner_pools.live_capacity({"pi-macos": 1}, REPO, 1) == {}


@pytest.mark.parametrize("after", [1, 6])
def test_census_deadline_preserves_time_for_classification(
    monkeypatch: pytest.MonkeyPatch, after: int
) -> None:
    """Slow run pages and slow job pages both fall back before the classify job times out."""
    fake_api(monkeypatch)
    ticks = iter([0] * after + [31])
    monkeypatch.setattr(runner_pools.time, "monotonic", lambda: next(ticks))
    assert runner_pools.live_capacity({"pi-macos": 1}, REPO, 1) == {}


def test_api_reader_is_get_only(monkeypatch: pytest.MonkeyPatch) -> None:
    """Admission never changes variables, runs, or repository configuration."""

    def output(argv: list[str], *, text: bool, stderr: int, timeout: int) -> str:
        assert argv == ["/usr/bin/gh", "api", "--method", "GET", "repos/example/project/actions/runs"]
        assert text
        assert stderr == subprocess.STDOUT
        assert timeout == 10
        return '{"total_count":0}'

    monkeypatch.setattr(runner_pools.subprocess, "check_output", output)
    assert runner_pools.gh_read("repos/example/project/actions/runs") == {"total_count": 0}


def test_cli_admits_capacity_at_the_real_plan_boundary(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The actual classify CLI forwards its identity and uses admitted capacity."""

    def live(capacity: dict[str, int], repo: str, ident: int, attempt: int) -> dict[str, int]:
        assert capacity == {"pi-macos": 1}
        assert (repo, ident, attempt) == (REPO, 42, 2)
        return {}

    monkeypatch.setattr(ci_paths, "live_capacity", live)
    monkeypatch.setattr(ci_paths.time, "time", lambda: NOW)
    assert (
        ci_paths.main(
            [
                "--full",
                "--event",
                "workflow_dispatch",
                "--github-output",
                str(tmp_path / "output"),
                "--pool-heartbeat",
                f"pi-macos={NOW}:5",
                "--pool-run-id",
                "42",
                "--pool-attempt",
                "2",
                "--pool-repository",
                REPO,
            ]
        )
        == 0
    )


def test_hosted_queue_rescue_at_the_run_selection_boundary() -> None:
    """A pending fan-in is safe, but a running sibling or a queued destination blocks rescue."""
    run = {
        "id": 1,
        "event": "pull_request",
        "run_attempt": 1,
        "created_at": "2027-01-15T07:00:00Z",
        "head_repository": {"full_name": REPO},
    }
    queued = {
        "status": "queued",
        "labels": ["xcode-27"],
        "name": "owned shard (macos-14, ts)",
        "created_at": "2027-01-15T07:00:00Z",
    }
    pending = {"status": "waiting", "labels": [], "name": "owned (macos-14)"}
    beats = {"pi-macos": f"{NOW}:5"}
    jobs = {1: [queued, pending]}
    assert runner_rescue.stranded_runs([run], jobs, beats, NOW, REPO) == [1]
    assert runner_rescue.stranded_runs([run], jobs, {}, NOW, REPO) == []
    assert runner_rescue.stranded_runs([run | {"run_attempt": 3}], jobs, beats, NOW, REPO) == []
    assert (
        runner_rescue.stranded_runs(
            [run | {"head_repository": {"full_name": "fork/project"}}], jobs, beats, NOW, REPO
        )
        == []
    )
    assert (
        runner_rescue.stranded_runs(
            [run], {1: [queued, pending | {"status": "in_progress"}]}, beats, NOW, REPO
        )
        == []
    )
    assert (
        runner_rescue.stranded_runs([run], jobs | {2: [queued | {"labels": ["pi-macos"]}]}, beats, NOW, REPO)
        == []
    )


def test_bilateral_rescue_requires_room_and_a_supported_cell() -> None:
    """Hosted queue moves only to a proven idle pool; a busy destination blocks takeover."""
    queued = {
        "status": "queued",
        "labels": ["xcode-27"],
        "name": "owned shard (macos-14, ts)",
        "created_at": "2027-01-15T07:00:00Z",
    }
    beats = {"pi-macos": f"{NOW}:5"}
    assert runner_rescue.job_is_stranded(queued, beats, NOW)
    assert not runner_rescue.job_is_stranded(queued | {"status": "in_progress"}, beats, NOW)
    assert not runner_rescue.job_is_stranded(queued | {"started_at": "2027-01-15T07:00:01Z"}, beats, NOW)
    assert not runner_rescue.job_is_stranded(queued, beats, NOW, pool_busy={"pi-macos"})
    assert not runner_rescue.job_is_stranded(queued, {"pi-macos": f"{NOW}:0"}, NOW)
    assert not runner_rescue.job_is_stranded(queued, {}, NOW)
    assert not runner_rescue.job_is_stranded(queued | {"name": "unlisted"}, beats, NOW)
    assert not runner_rescue.job_is_stranded(queued | {"name": "owned shard (macos-14, scripts)"}, beats, NOW)
    assert not runner_rescue.job_is_stranded(queued | {"labels": ["ubuntu-24.04"]}, beats, NOW)
    assert not runner_rescue.job_is_stranded(queued | {"labels": ["pi-macos"]}, beats, NOW, {"xcode-27"})
    assert runner_rescue.eligible_pool(queued | {"name": "contracts (macos-14)"}) == "pi-macos"
    assert runner_rescue.eligible_pool(queued | {"name": "stack (macos-14, local)"}) == "pi-macos"
