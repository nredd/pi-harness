"""Test which runs the rescue re-routes and how it restarts them.

References:
    https://docs.github.com/en/rest/actions/workflow-runs#re-run-a-workflow
"""

from __future__ import annotations

import runpy
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import runner_rescue

NOW = 1_800_000_000.0
FRESH = str(int(NOW) - 30)
REPO = "o/r"
STALE = {"pi-linux": "0", "pi-macos": ""}
LATE = runner_rescue.MIN_QUEUED_S + 60


def iso(epoch: float) -> str:
    """Format epoch seconds the way the API does.

    Parameters:
        epoch (float): Epoch seconds.

    Returns:
        str: e.g. `2026-11-04T17:27:17Z`.
    """
    return datetime.fromtimestamp(epoch, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def job(status: str, labels: list[str], queued_s: float) -> dict[str, Any]:
    """Build an API-shaped job queued `queued_s` seconds before NOW.

    Parameters:
        status (str): `queued`, `in_progress` or `completed`.
        labels (list[str]): The job's `runs-on` labels.
        queued_s (float): Seconds it has been queued.

    Returns:
        dict[str, Any]: The job object.
    """
    return {"status": status, "labels": labels, "created_at": iso(NOW - queued_s)}


def run(
    run_id: int,
    age_s: float = 900,
    event: str = "pull_request",
    attempt: int = 1,
    head: str = REPO,
) -> dict[str, Any]:
    """Build an API-shaped run.

    Parameters:
        run_id (int): Run id.
        age_s (float): Seconds since creation.
        event (str): Triggering event.
        attempt (int): `run_attempt`.
        head (str): Head repository `owner/name`.

    Returns:
        dict[str, Any]: The run object.
    """
    return {
        "id": run_id,
        "event": event,
        "run_attempt": attempt,
        "created_at": iso(NOW - age_s),
        "head_repository": {"full_name": head},
    }


@pytest.mark.parametrize(
    ("jobs", "beats", "picked"),
    [
        ([job("queued", ["pi-macos"], LATE)], STALE, [1]),
        ([job("queued", ["self-hosted", "pi-linux"], LATE)], STALE, [1]),
        ([job("queued", ["pi-macos"], LATE)], {"pi-macos": FRESH}, []),
        ([job("queued", ["pi-macos"], LATE)], {"pi-macos": f"{FRESH}:2"}, []),
        ([job("queued", ["pi-macos"], LATE)], {"pi-macos": f"{FRESH}:-3"}, []),
        # A draining pool beats but starts nothing: its queued job is stranded despite the fresh beat.
        ([job("queued", ["pi-macos"], LATE)], {"pi-macos": f"{FRESH}:drain"}, [1]),
        ([job("queued", ["pi-macos"], 10)], STALE, []),
        ([job("in_progress", ["pi-macos"], LATE)], STALE, []),
        ([job("queued", ["ubuntu-24.04"], LATE)], STALE, []),
        ([job("queued", ["pi-macos"], LATE), job("completed", ["xcode-27"], LATE)], STALE, [1]),
    ],
)
def test_stranded_runs_need_a_late_queued_job_on_a_dead_pool(
    jobs: list[dict[str, Any]], beats: dict[str, str], picked: list[int]
) -> None:
    """Only a job that has waited, on a pool label whose beat is not fresh, strands its run."""
    assert runner_rescue.stranded_runs([run(1)], {1: jobs}, beats, NOW, REPO) == picked


def test_stranded_runs_skip_ineligible_runs_and_cap_the_batch() -> None:
    """Skip exhausted, unrerunnable and fork runs; rescue oldest first, bounded per tick."""
    dead = [job("queued", ["pi-linux"], LATE)]
    runs = [run(i, age_s=10_000 - i) for i in range(10, 20)]
    runs += [
        run(1, attempt=runner_rescue.MAX_ATTEMPT),
        run(2, event="schedule"),
        run(3, head="fork/r"),
    ]
    runs[0]["head_repository"] = None
    jobs = {r["id"]: dead for r in runs}
    picked = runner_rescue.stranded_runs(runs, jobs, STALE, NOW, REPO)
    assert picked == [11, 12, 13][: runner_rescue.MAX_RUNS_PER_TICK]


class FakeGh:
    """Record `gh api` calls and answer run status from a script."""

    def __init__(self, statuses: list[str], rerun_failures: int = 0) -> None:
        """Script the run statuses and how many reruns fail first.

        Parameters:
            statuses (list[str]): Statuses returned by successive GETs; the last repeats.
            rerun_failures (int): Rerun POSTs that fail before one succeeds.
        """
        self.statuses = statuses
        self.rerun_failures = rerun_failures
        self.calls: list[tuple[str, str]] = []

    def __call__(self, *args: str, method: str = "GET") -> Any:
        """Answer one API call.

        Parameters:
            *args (str): API path.
            method (str): HTTP verb.

        Returns:
            Any: A status object for GET, else None.

        Raises:
            subprocess.CalledProcessError: A scripted rerun failure.
        """
        self.calls.append((method, args[0]))
        if method == "GET":
            return {"status": self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]}
        if args[0].endswith("/rerun") and self.rerun_failures:
            self.rerun_failures -= 1
            raise subprocess.CalledProcessError(1, "gh")
        return None


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    """Never really wait in the restart loops."""
    monkeypatch.setattr(runner_rescue.time, "sleep", lambda _s: None)


def test_restart_cancels_waits_then_reruns(monkeypatch: pytest.MonkeyPatch) -> None:
    """Rerun only after the cancel has completed, so the new attempt does not race the old one."""
    fake = FakeGh(["in_progress", "completed"])
    monkeypatch.setattr(runner_rescue, "gh_api", fake)
    runner_rescue.restart(REPO, 7)
    assert [m for m, _ in fake.calls if m == "POST"] == ["POST", "POST"]
    assert fake.calls[0] == ("POST", "repos/o/r/actions/runs/7/cancel")
    assert fake.calls[-1] == ("POST", "repos/o/r/actions/runs/7/rerun")


def test_rerun_retries_a_transient_failure_then_succeeds(monkeypatch: pytest.MonkeyPatch) -> None:
    """A run left cancelled is never retried by anyone, so a flaky rerun gets more attempts."""
    fake = FakeGh(["completed"], rerun_failures=runner_rescue.RERUN_TRIES - 1)
    monkeypatch.setattr(runner_rescue, "gh_api", fake)
    runner_rescue.restart(REPO, 7)
    assert [c for c in fake.calls if c[1].endswith("/rerun")] == [
        ("POST", "repos/o/r/actions/runs/7/rerun")
    ] * runner_rescue.RERUN_TRIES


def test_rerun_gives_up_loudly_after_the_last_try(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Say the run is left cancelled, then raise so the job turns red."""
    monkeypatch.setattr(runner_rescue, "gh_api", FakeGh(["completed"], rerun_failures=99))
    with pytest.raises(subprocess.CalledProcessError), caplog.at_level("ERROR"):
        runner_rescue.restart(REPO, 7)
    assert "left cancelled" in caplog.text


def test_restart_force_cancels_once_then_gives_up(monkeypatch: pytest.MonkeyPatch) -> None:
    """A run that will not cancel is force-cancelled, then reported rather than looped on."""
    fake = FakeGh(["in_progress"])
    monkeypatch.setattr(runner_rescue, "gh_api", fake)
    clock = iter(range(0, 10_000, 100))
    monkeypatch.setattr(runner_rescue.time, "monotonic", lambda: float(next(clock)))
    with pytest.raises(TimeoutError, match="force-cancel"):
        runner_rescue.restart(REPO, 7)
    assert ("POST", "repos/o/r/actions/runs/7/force-cancel") in fake.calls
    assert ("POST", "repos/o/r/actions/runs/7/rerun") not in fake.calls


def api(runs: list[dict[str, Any]], jobs: list[dict[str, Any]], seen: list[str] | None = None) -> Any:
    """Build a fake `gh_api` serving one queued page of runs and a fixed job list.

    Parameters:
        runs (list[dict[str, Any]]): Runs returned for `status=queued`.
        jobs (list[dict[str, Any]]): Jobs returned for every run.
        seen (list[str] | None): Collects `METHOD path` of each call.

    Returns:
        Any: The fake.
    """

    def fake(*args: str, method: str = "GET") -> Any:
        """Answer one API call."""
        if seen is not None:
            seen.append(f"{method} {args[0]}")
        if "actions/runs?" in args[0]:
            return {"workflow_runs": runs if "status=queued" in args[0] else []}
        return {"jobs": jobs}

    return fake


def test_main_dry_run_reports_and_changes_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    """`--dry-run` must not cancel or rerun anything."""
    seen: list[str] = []
    monkeypatch.setattr(
        runner_rescue, "gh_api", api([run(1, 5000)], [job("queued", ["pi-macos"], 4000)], seen)
    )
    monkeypatch.setattr(runner_rescue.time, "time", lambda: NOW)
    assert runner_rescue.main(["--repo", REPO, "--dry-run", "--pool-heartbeat", "pi-macos=0"]) == 0
    assert not [c for c in seen if c.startswith("POST")]


def test_pools_disabled_makes_a_fresh_pool_count_as_down(monkeypatch: pytest.MonkeyPatch) -> None:
    """With the kill switch set, a pool that still beats is rescued from anyway."""
    restarted: list[int] = []
    monkeypatch.setattr(runner_rescue, "gh_api", api([run(1, 5000)], [job("queued", ["pi-macos"], 4000)]))
    monkeypatch.setattr(runner_rescue, "restart", lambda _r, run_id: restarted.append(run_id))
    monkeypatch.setattr(runner_rescue.time, "time", lambda: NOW)
    args = ["--repo", REPO, "--pool-heartbeat", f"pi-macos={FRESH}"]
    assert runner_rescue.main(args) == 0
    assert restarted == []
    assert runner_rescue.main([*args, "--pools-disabled"]) == 0
    assert restarted == [1]


def test_main_restarts_and_reports_a_failed_restart(monkeypatch: pytest.MonkeyPatch) -> None:
    """A restart error is logged and turns the exit status red, without skipping later runs."""
    restarted: list[int] = []

    def fake_restart(_repo: str, run_id: int) -> None:
        """Fail the first run, record the rest."""
        if run_id == 1:
            raise subprocess.CalledProcessError(1, "gh")
        restarted.append(run_id)

    monkeypatch.setattr(
        runner_rescue, "gh_api", api([run(1, 5000), run(2, 4000)], [job("queued", ["pi-linux"], 4000)])
    )
    monkeypatch.setattr(runner_rescue, "restart", fake_restart)
    monkeypatch.setattr(runner_rescue.time, "time", lambda: NOW)
    assert runner_rescue.main(["--repo", REPO]) == 1
    assert restarted == [2]


def test_main_logs_an_api_failure_instead_of_a_traceback(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """An API blip while listing runs is one logged error and a red exit."""

    def broken(*_a: str, method: str = "GET") -> Any:
        """Always fail like `gh` would."""
        raise subprocess.CalledProcessError(1, "gh", stderr="HTTP 502")

    monkeypatch.setattr(runner_rescue, "gh_api", broken)
    with caplog.at_level("ERROR"):
        assert runner_rescue.main(["--repo", REPO]) == 1
    assert "Failed to read runs" in caplog.text


def test_unfinished_runs_warns_when_a_page_is_full(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """A full page may hide more runs; say so rather than pretend the list is complete."""
    page = [run(i) for i in range(runner_rescue.PAGE_SIZE)]
    monkeypatch.setattr(runner_rescue, "gh_api", api(page, []))
    with caplog.at_level("WARNING"):
        assert len(runner_rescue.unfinished_runs(REPO)) == runner_rescue.PAGE_SIZE
    assert "first 100 'queued' runs" in caplog.text


def test_main_fetches_jobs_only_for_candidate_runs(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fork, exhausted and scheduled runs cost no jobs call."""
    seen: list[str] = []
    runs = [run(1, head="fork/r"), run(2, event="schedule"), run(3, attempt=9), run(4)]
    monkeypatch.setattr(runner_rescue, "gh_api", api(runs, [], seen))
    monkeypatch.setattr(runner_rescue.time, "time", lambda: NOW)
    assert runner_rescue.main(["--repo", REPO, "--dry-run"]) == 0
    assert [c for c in seen if "/jobs" in c] == [
        "GET repos/o/r/actions/runs/4/jobs?filter=latest&per_page=100"
    ]


def test_gh_api_decodes_json_and_empty_bodies_through_the_real_subprocess(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Run the actual `subprocess.run` path against a stub `gh` that echoes its arguments."""
    stub = tmp_path / "gh"
    stub.write_text('#!/bin/sh\n[ "$4" = empty ] && exit 0\nprintf \'{"argv": "%s"}\' "$*"\n')
    stub.chmod(0o755)
    monkeypatch.setattr(runner_rescue, "GH", str(stub))
    assert runner_rescue.gh_api("repos/o/r") == {"argv": "api --method GET repos/o/r"}
    assert runner_rescue.gh_api("empty", method="POST") is None
    stub.write_text("#!/bin/sh\nexit 3\n")
    with pytest.raises(subprocess.CalledProcessError):
        runner_rescue.gh_api("repos/o/r")


@pytest.mark.parametrize("argv", [["--repo", "nope"], ["--repo", REPO, "--pool-heartbeat", "pi-mac=1"]])
def test_main_rejects_bad_arguments_before_calling_the_api(
    argv: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Refuse a bad repo or a mistyped pool before any API call."""
    monkeypatch.setattr(runner_rescue, "gh_api", lambda *_a, **_k: pytest.fail("must not call the API"))
    with pytest.raises(SystemExit):
        runner_rescue.main(argv)


def test_script_entry_point_exits_through_main(monkeypatch: pytest.MonkeyPatch) -> None:
    """Run the file as `__main__` so its exit guard runs, failing before any API call."""
    monkeypatch.setattr(sys, "argv", ["runner_rescue.py", "--repo", "nope"])
    with pytest.raises(SystemExit) as exit_info:
        runpy.run_path(str(Path(runner_rescue.__file__)), run_name="__main__")
    assert exit_info.value.code == 2
