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
# Replay inputs: observed hosted median start delay, assumed hosted executors, and the bounds to hold.
HOSTED_MEDIAN_START_S = 215
HOSTED_EXECUTORS = 9
MAX_WAIT_S = 3000
MAX_TOTAL_WAIT_S = 80000


def census(count: int) -> tuple[list[dict[str, Any]], dict[int, list[dict[str, Any]]]]:
    """Build API-shaped snapshots of a same-heartbeat classification burst.

    Parameters:
        count (int): Number of runs, each still in its `classify` job.

    Returns:
        tuple[list[dict[str, Any]], dict[int, list[dict[str, Any]]]]: Runs and their jobs by run id.
    """
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
    cells = [
        key
        for key in runner_pools.CELL_SECONDS
        if key[1] == "macos-14" and key not in runner_pools.HOSTED_ONLY_CELLS
    ]
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
    lanes = [HOSTED_MEDIAN_START_S] * HOSTED_EXECUTORS
    waits = []
    for key in hosted:
        start = heapq.heappop(lanes)
        waits.append(start)
        heapq.heappush(lanes, start + runner_pools.CELL_SECONDS[key])
    assert max(waits) <= MAX_WAIT_S
    assert sum(waits) <= MAX_TOTAL_WAIT_S


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


@pytest.mark.parametrize("build_labels", [None, [], ["pi-macos"], ["xcode-27"]])
def test_native_helper_reserves_only_macos_even_with_windows_sibling(build_labels: list[str] | None) -> None:
    """A materializing native build is not invisible just because Windows started first."""
    runs, jobs = census(2)
    runs[0]["workflow_file"] = runner_pools.NATIVE_HELPER_WORKFLOW
    jobs[1] = [
        {"name": "route native helper", "status": "completed", "labels": ["ubuntu-24.04"]},
        {"name": "windows-helper", "status": "in_progress", "labels": ["windows-2025"]},
    ]
    if build_labels is not None:
        jobs[1].append({"name": "build", "status": "queued", "labels": build_labels})
    assert runner_pools.admit_capacity({"pi-macos": 1, "pi-linux": 2}, runs, jobs, 2, REPO) == {
        "pi-macos": int(build_labels == ["xcode-27"]),
        "pi-linux": 2,
    }


def fake_api(
    monkeypatch: pytest.MonkeyPatch, *, full: str = "", previous: list[dict[str, Any]] | None = None
) -> list[str]:
    """Install a bounded API transcript.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): Patches `runner_pools.gh_read`.
        full (str): Page kind (`runs`, `jobs`, `previous`) that reports a full page.
        previous (list[dict[str, Any]] | None): Jobs of the previous attempt.

    Returns:
        list[str]: Paths read, in order.
    """
    runs, jobs = census(1)
    native_runs, native_jobs = census(2)
    native_runs = native_runs[1:]
    native_jobs = {2: [{"name": "route native helper", "status": "in_progress", "labels": []}]}
    calls: list[str] = []

    def read(path: str) -> dict[str, Any]:
        calls.append(path)
        if "/attempts/" in path:
            return {"total_count": 100 if full == "previous" else 1, "jobs": previous or []}
        if "/runs/2/jobs?" in path:
            return {"total_count": 100 if full == "native-jobs" else 1, "jobs": native_jobs[2]}
        if "/jobs?" in path:
            return {"total_count": 100 if full == "jobs" else 1, "jobs": jobs[1]}
        if "/workflows/native-helper.yml/" in path:
            return {"total_count": 100 if full == "native-runs" else 1, "workflow_runs": native_runs}
        return {"total_count": 100 if full == "runs" else 1, "workflow_runs": runs}

    monkeypatch.setattr(runner_pools, "gh_read", read)
    return calls


def test_live_census_and_retry_do_not_return_to_a_previous_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    """A rescued run never returns to a pool that stranded an earlier attempt."""
    calls = fake_api(monkeypatch)
    assert runner_pools.live_capacity({"pi-macos": 1}, REPO, 1) == {"pi-macos": 1}
    assert len(calls) == 12
    assert sum("/workflows/native-helper.yml/" in path for path in calls) == 5
    assert any("/runs/2/jobs?" in path for path in calls)
    fake_api(monkeypatch, previous=[{"labels": ["pi-macos"]}])
    assert runner_pools.live_capacity({"pi-linux": 1, "pi-macos": 1}, REPO, 1, 2) == {
        "pi-linux": 1,
        "pi-macos": 0,
    }
    fake_api(monkeypatch, previous=[{"labels": ["xcode-27"]}])
    assert runner_pools.live_capacity({"pi-macos": 1}, REPO, 1, 2) == {"pi-macos": 1}
    assert runner_pools.live_capacity({}, REPO, 1) == {}
    assert runner_pools.live_capacity({"pi-macos": 0}, REPO, 1) == {}


def test_native_census_is_skipped_without_macos_capacity(monkeypatch: pytest.MonkeyPatch) -> None:
    """Only a macOS slot needs the native-helper workflow's runs."""
    calls = fake_api(monkeypatch)
    assert runner_pools.live_capacity({"pi-linux": 1, "pi-macos": 0}, REPO, 1) == {
        "pi-linux": 1,
        "pi-macos": 0,
    }
    assert not any("native-helper.yml" in path for path in calls)


@pytest.mark.parametrize("full", ["runs", "jobs", "previous", "native-runs", "native-jobs"])
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


@pytest.mark.parametrize("after", [1, 11])
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


REAL_QUEUED = {
    # Real API shape: a queued job reports started_at == created_at, runner_id 0 and no runner name.
    "status": "queued",
    "labels": ["pi-macos"],
    "name": "owned shard (macos-14, ts)",
    "created_at": "2027-01-15T07:00:00Z",
    "started_at": "2027-01-15T07:00:00Z",
    "runner_id": 0,
    "runner_name": "",
}
RUN = {
    "id": 1,
    "event": "pull_request",
    "run_attempt": 1,
    "created_at": "2027-01-15T07:00:00Z",
    "head_repository": {"full_name": REPO},
}


def test_a_real_queued_job_is_rescuable_and_a_runner_assignment_is_not() -> None:
    """Queued jobs carry a `started_at`; only a runner assignment means the job started."""
    assert runner_rescue.job_is_stranded(REAL_QUEUED, {}, NOW)
    assert runner_rescue.stranded_runs([RUN], {1: [REAL_QUEUED]}, {}, NOW, REPO) == [1]
    for started in ({"runner_id": 7}, {"runner_name": "pi-macos-1"}):
        job = REAL_QUEUED | started
        assert not runner_rescue.job_is_stranded(job, {}, NOW)
        assert runner_rescue.stranded_runs([RUN], {1: [job]}, {}, NOW, REPO) == []


def hosted_cell(name: str = "owned shard (macos-14, ts)") -> dict[str, Any]:
    """Build a real-shape hosted queued cell.

    Parameters:
        name (str): The job name.

    Returns:
        dict[str, Any]: A queued hosted job overdue for takeover.
    """
    return REAL_QUEUED | {"labels": ["xcode-27"], "name": name}


def test_a_newer_run_that_finished_classify_reserves_before_an_older_rerun() -> None:
    """Reserve by classify completion, not run id order."""
    runs, jobs = census(2)
    jobs[2] = [{"name": "classify changed paths", "status": "completed", "labels": []}]
    assert runner_pools.admit_capacity({"pi-macos": 1}, runs, jobs, 1, REPO) == {"pi-macos": 0}
    jobs[2] = [{"name": "classify changed paths", "status": "in_progress", "labels": []}]
    assert runner_pools.admit_capacity({"pi-macos": 1}, runs, jobs, 1, REPO) == {"pi-macos": 1}


def test_burst_over_both_pools_never_exceeds_either_capacity() -> None:
    """Replay nine runs reading linux free=2 and macOS free=5: both pools used, neither oversubscribed.

    A replay of progressively visible snapshots, not a feedback simulation: placed cells do not re-enter the
    census, and Linux has one listed cell per run, so its bound is the slot count.
    """
    runs, jobs = census(9)
    beats = {"pi-linux": f"{NOW - 30}:2", "pi-macos": f"{NOW - 30}:5"}
    capacity = runner_pools.pool_capacity(beats, NOW, trusted=True)
    cells = [key for key in runner_pools.CELL_SECONDS if key[1] in {"macos-14", "ubuntu-24.04"}]
    per_pool = {"pi-linux": 0, "pi-macos": 0}
    for run in runs:
        admitted = runner_pools.admit_capacity(capacity, runs[: run["id"]], jobs, run["id"], REPO)
        for pool in runner_pools.assign_cells(cells, admitted).values():
            per_pool[pool] += 1
    assert per_pool["pi-macos"] == 1
    assert 1 <= per_pool["pi-linux"] <= runner_pools.POOLS["pi-linux"].slots


def test_a_classifying_run_reserves_only_the_pools_its_cells_target() -> None:
    """An older run whose unlabeled cells are all macOS leaves the Linux pool free."""
    runs, jobs = census(3)
    for older in (1, 2):
        jobs[older] = [{"name": "owned shard (macos-14, ts)", "status": "queued", "labels": []}]
    got = runner_pools.admit_capacity({"pi-linux": 1, "pi-macos": 1}, runs, jobs, 3, REPO)
    assert got == {"pi-linux": 1, "pi-macos": 0}


def test_own_hosted_siblings_do_not_block_a_live_pool_rescue() -> None:
    """A cell queued 15 minutes on a fresh pool moves to hosted although its run has hosted siblings."""
    stuck = REAL_QUEUED | {"created_at": "2027-01-15T07:00:00Z"}
    sibling = hosted_cell("owned shard (macos-14, python)")
    beats = {"pi-macos": f"{NOW}:0"}
    assert runner_rescue.stranded_runs([RUN], {1: [stuck, sibling]}, beats, NOW, REPO) == [1]
    other = RUN | {"id": 2}
    assert runner_rescue.stranded_runs([RUN, other], {1: [stuck], 2: [sibling]}, beats, NOW, REPO) == []


def test_a_dead_pool_cell_is_rescued_while_another_run_classifies() -> None:
    """Another run's classify in progress does not delay the dead-pool takeover."""
    classifying = {"status": "in_progress", "labels": [], "name": "classify changed paths"}
    runs = [RUN, RUN | {"id": 2}]
    assert runner_rescue.stranded_runs(runs, {1: [REAL_QUEUED], 2: [classifying]}, {}, NOW, REPO) == [1]


def test_every_earlier_attempts_pools_are_excluded(monkeypatch: pytest.MonkeyPatch) -> None:
    """Attempt 1 stranded on `pi-macos`, attempt 2 ran hosted: attempt 3 must still avoid `pi-macos`."""
    attempts = {1: [{"labels": ["pi-macos"]}], 2: [{"labels": ["xcode-27"]}]}
    runs, jobs = census(1)

    def read(path: str) -> dict[str, Any]:
        if "/attempts/" in path:
            number = int(path.split("/attempts/")[1].split("/", maxsplit=1)[0])
            return {"total_count": 1, "jobs": attempts[number]}
        if "/jobs?" in path:
            return {"total_count": 1, "jobs": jobs[1]}
        return {"total_count": 1, "workflow_runs": runs}

    monkeypatch.setattr(runner_pools, "gh_read", read)
    assert runner_pools.live_capacity({"pi-macos": 1, "pi-linux": 1}, REPO, 1, 3) == {
        "pi-macos": 0,
        "pi-linux": 1,
    }


def test_a_changed_pre_cancel_snapshot_reads_only_the_picked_run(monkeypatch: pytest.MonkeyPatch) -> None:
    """The recheck swaps in the picked run's fresh jobs and keeps the tick's snapshot of the rest."""
    seen: list[str] = []
    runs = [RUN, RUN | {"id": 2, "run_attempt": runner_rescue.MAX_ATTEMPT}]

    def fake(*args: str, method: str = "GET") -> Any:
        """Answer one API call."""
        seen.append(args[0])
        if "runs?" in args[0]:
            return {"workflow_runs": runs if "status=queued" in args[0] else []}
        if args[0].endswith("/runs/1") or args[0].endswith("/runs/2"):
            return runs[int(args[0][-1]) - 1]
        return {"jobs": [REAL_QUEUED]}

    monkeypatch.setattr(runner_rescue, "gh_api", fake)
    monkeypatch.setattr(runner_rescue.time, "time", lambda: NOW)
    monkeypatch.setattr(runner_rescue, "restart", lambda *_: None)
    assert runner_rescue.main(["--repo", REPO]) == 0
    assert sum("/runs/2/jobs" in call for call in seen) == 1  # the census only, not the recheck
    assert sum("/runs/1/jobs" in call for call in seen) == 2  # census plus the picked run's recheck


def test_a_hosted_queue_is_never_moved_into_a_pool() -> None:
    """Hosted->pool rescue is intentionally not implemented: planning at classify balances the pools."""
    beats = {"pi-macos": f"{NOW}:5"}
    assert not runner_rescue.job_is_stranded(hosted_cell(), beats, NOW)
    assert runner_rescue.stranded_runs([RUN], {1: [hosted_cell()]}, beats, NOW, REPO) == []


def test_only_unstarted_queued_pool_cells_are_moved() -> None:
    """Pool cells move to hosted: a dead pool after 5 minutes, a live one only while hosted looks free."""
    assert runner_rescue.job_is_stranded(REAL_QUEUED, {}, NOW)
    assert not runner_rescue.job_is_stranded(REAL_QUEUED | {"status": "in_progress"}, {}, NOW)
    assert not runner_rescue.job_is_stranded(REAL_QUEUED | {"labels": ["ubuntu-24.04"]}, {}, NOW)
    live = {"pi-macos": f"{NOW}:5"}
    assert runner_rescue.job_is_stranded(REAL_QUEUED, live, NOW)
    assert not runner_rescue.job_is_stranded(REAL_QUEUED, live, NOW, {"xcode-27"})
    assert runner_rescue.job_is_stranded(REAL_QUEUED, {}, NOW, {"xcode-27"})
    assert runner_pools.cell_pool("contracts (macos-14)") == "pi-macos"
    assert runner_pools.cell_pool("stack (macos-14, local)") == "pi-macos"


def test_an_unreadable_run_does_not_stop_the_dead_pool_rescue(monkeypatch: pytest.MonkeyPatch) -> None:
    """One failing jobs read (or a rate limit) drops that run only; the stranded one is still restarted."""
    runs = [RUN, RUN | {"id": 2, "created_at": "2027-01-15T07:30:00Z"}]
    restarted: list[int] = []

    def fake(*args: str, method: str = "GET") -> Any:
        """Answer one API call, failing run 2's jobs."""
        if "runs?" in args[0]:
            return {"workflow_runs": runs if "status=queued" in args[0] else []}
        if "/runs/2/jobs" in args[0]:
            raise subprocess.CalledProcessError(1, "gh", stderr="HTTP 403 rate limit")
        if args[0].endswith("/runs/1"):
            return runs[0]
        return {"jobs": [REAL_QUEUED]}

    monkeypatch.setattr(runner_rescue, "gh_api", fake)
    monkeypatch.setattr(runner_rescue.time, "time", lambda: NOW)
    monkeypatch.setattr(runner_rescue, "restart", lambda _repo, run_id: restarted.append(run_id))
    assert runner_rescue.main(["--repo", REPO]) == 1  # red tick, but run 1 is still rescued
    assert restarted == [1]


def test_a_linux_heavy_burst_cannot_oversubscribe_the_two_slot_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    """Two listed Linux cells per run: a classifier with no cells yet reserves the pool's whole room."""
    table = {("owned", "ubuntu-24.04", "ts"): 430, ("stack", "ubuntu-24.04", "personal"): 940}
    monkeypatch.setattr(runner_pools, "CELL_SECONDS", table)
    runs, jobs = census(9)
    capacity = runner_pools.pool_capacity({"pi-linux": f"{NOW - 30}:2"}, NOW, trusted=True)
    placed = 0
    for run in runs:
        admitted = runner_pools.admit_capacity(capacity, runs[: run["id"]], jobs, run["id"], REPO)
        placed += len(runner_pools.assign_cells(list(table), admitted))
    assert placed == runner_pools.POOLS["pi-linux"].slots


def jobs_fail_for(
    monkeypatch: pytest.MonkeyPatch, failing: set[int], runs: list[dict[str, Any]]
) -> list[int]:
    """Serve `runs`, failing the jobs read of `failing` runs; return the list that collects restarts.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): Patches the API and `restart`.
        failing (set[int]): Run ids whose `/jobs` read raises.
        runs (list[dict[str, Any]]): Unfinished runs.

    Returns:
        list[int]: Ids passed to `restart`.
    """
    restarted: list[int] = []

    def fake(*args: str, method: str = "GET") -> Any:
        """Answer one API call."""
        if "runs?" in args[0]:
            return {"workflow_runs": runs if "status=queued" in args[0] else []}
        if "/jobs" in args[0] and int(args[0].split("/runs/")[1].split("/")[0]) in failing:
            raise subprocess.CalledProcessError(1, "gh", stderr="HTTP 403 rate limit")
        if "/jobs" in args[0]:
            return {"jobs": [REAL_QUEUED]}
        return runs[0]

    monkeypatch.setattr(runner_rescue, "gh_api", fake)
    monkeypatch.setattr(runner_rescue.time, "time", lambda: NOW)
    monkeypatch.setattr(runner_rescue, "restart", lambda _repo, run_id: restarted.append(run_id))
    return restarted


def test_a_total_jobs_read_failure_is_not_a_silent_green(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every `/jobs` read rate-limited: nothing is rescued and the tick exits red."""
    restarted = jobs_fail_for(monkeypatch, {1, 2}, [RUN, RUN | {"id": 2}])
    assert runner_rescue.main(["--repo", REPO]) == 1
    assert restarted == []


def test_an_unreadable_run_blocks_live_pool_moves_but_not_dead_pool_moves(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Hosted load is unknown while a run is unreadable: a fresh pool keeps its cell, a dead one loses it."""
    runs = [RUN, RUN | {"id": 2, "created_at": "2027-01-15T07:30:00Z"}]
    restarted = jobs_fail_for(monkeypatch, {2}, runs)
    assert runner_rescue.main(["--repo", REPO, "--pool-heartbeat", f"pi-macos={NOW}:5"]) == 1
    assert restarted == []
    assert runner_rescue.main(["--repo", REPO, "--pool-heartbeat", "pi-macos=0"]) == 1
    assert restarted == [1]
