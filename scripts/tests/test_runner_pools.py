"""Test which self-hosted pools take CI cells, and which runs the rescue re-routes.

References:
    https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/using-self-hosted-runners-in-a-workflow
"""

from __future__ import annotations

import json
import runpy
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ci_paths
import runner_pools
import runner_rescue

NOW = 1_800_000_000.0
FRESH = str(int(NOW) - 30)
WORKSPACES = ci_paths.npm_workspaces(ci_paths.REPO_ROOT)


@pytest.mark.parametrize(
    ("value", "fresh"),
    [
        (FRESH, True),
        (str(int(NOW) - runner_pools.HEARTBEAT_TTL_S), True),
        (str(int(NOW) - runner_pools.HEARTBEAT_TTL_S - 1), False),
        (str(int(NOW) + runner_pools.CLOCK_SKEW_S), True),
        (str(int(NOW) + runner_pools.CLOCK_SKEW_S + 1), False),
        (f" {FRESH}\n", True),
        ("0", False),
        ("-5", False),
        ("", False),
        ("abc", False),
        ("1.5e9", False),
    ],
)
def test_is_fresh(value: str, fresh: bool) -> None:
    """Accept only a recent positive integer; stopped, stale, future and garbled values mean down."""
    assert runner_pools.is_fresh(value, NOW) is fresh


def test_available_pools_needs_a_fresh_beat_and_a_trusted_event() -> None:
    """Never offer a pool to a fork PR, and only offer the pools whose own beat is fresh."""
    beats = {"pi-linux": FRESH, "pi-macos": "0"}
    assert runner_pools.available_pools(beats, NOW, trusted=True) == {"pi-linux"}
    assert runner_pools.available_pools(beats, NOW, trusted=False) == frozenset()
    assert runner_pools.available_pools({}, NOW, trusted=True) == frozenset()
    assert runner_pools.available_pools({"other": FRESH}, NOW, trusted=True) == frozenset()


def test_every_self_hosted_shard_names_a_real_pool_and_shard() -> None:
    """A typo in the table must not silently leave a cell hosted forever."""
    for (os_name, shard), pool in runner_pools.SELF_HOSTED_SHARDS.items():
        assert pool in runner_pools.POOLS
        assert shard in {s.name for s in ci_paths.OWNED_SHARDS[os_name]}


def shard_runners(pools: frozenset[str]) -> dict[tuple[str, str], str]:
    """Return every owned shard's runner for the given pools."""
    return {
        (os_name, plan.name): plan.runner
        for os_name in ci_paths.OWNED_SHARDS
        for plan in ci_paths.shard_plans(os_name, WORKSPACES, pools=pools)
    }


def test_no_pools_means_every_shard_is_hosted_exactly_as_before() -> None:
    """With nothing up the plan is byte-identical to the all-hosted plan."""
    runners = shard_runners(frozenset())
    assert runners == {
        (os_name, plan.name): ci_paths.RUNNERS[os_name][0]
        for os_name in ci_paths.OWNED_SHARDS
        for plan in ci_paths.shard_plans(os_name, WORKSPACES)
    }


def test_a_pool_that_is_up_takes_only_its_assigned_shard() -> None:
    """Each pool takes one shard; WSL and the other shards stay hosted."""
    both = shard_runners(frozenset({"pi-linux", "pi-macos"}))
    assert both[("ubuntu-24.04", "python")] == "pi-linux"
    assert both[("macos-14", "ts")] == "pi-macos"
    self_hosted = {key for key, runner in both.items() if runner in runner_pools.POOLS}
    assert self_hosted == {("ubuntu-24.04", "python"), ("macos-14", "ts")}
    linux_only = shard_runners(frozenset({"pi-linux"}))
    assert linux_only[("macos-14", "ts")] == ci_paths.RUNNERS["macos-14"][0]
    assert not any(runner in runner_pools.POOLS for (os_name, _), runner in both.items() if os_name == "wsl2")


def test_main_routes_with_fresh_beats_and_never_for_an_untrusted_event(tmp_path: Path) -> None:
    """Drive the real CLI: fresh beats route, `--untrusted` and stale beats do not."""
    beat = str(int(time.time()))

    def plan(*extra: str) -> dict[str, Any]:
        out = tmp_path / f"out-{len(extra)}-{extra!r}".replace("/", "_").replace(" ", "")[:60]
        out.write_text("")
        argv = ["--full", "--event", "workflow_dispatch", "--github-output", str(out), *extra]
        assert ci_paths.main(argv) == 0
        line = next(x for x in out.read_text().splitlines() if x.startswith("plan="))
        return json.loads(line.removeprefix("plan="))

    def runners(plan_json: dict[str, Any], cell: str) -> dict[str, str]:
        return {s["shard"]: s["runner"] for s in plan_json[cell]["shards"]}

    routed = plan("--pool-heartbeat", f"pi-linux={beat}", "--pool-heartbeat", f"pi-macos={beat}")
    assert runners(routed, "owned (ubuntu-24.04)")["python"] == "pi-linux"
    assert runners(routed, "owned (macos-14)")["ts"] == "pi-macos"
    fork = plan("--pool-heartbeat", f"pi-linux={beat}", "--untrusted")
    assert set(runners(fork, "owned (ubuntu-24.04)").values()) == {"ubuntu-24.04"}
    stale = plan("--pool-heartbeat", "pi-macos=0", "--pool-heartbeat", "pi-linux=")
    assert set(runners(stale, "owned (macos-14)").values()) == {ci_paths.RUNNERS["macos-14"][0]}


def job(status: str, labels: list[str], queued_s: float) -> dict[str, Any]:
    """Build an API-shaped job queued `queued_s` seconds before NOW."""
    stamp = _iso(NOW - queued_s)
    return {"status": status, "labels": labels, "created_at": stamp}


def _iso(epoch: float) -> str:
    """Format epoch seconds the way the API does."""
    return datetime.fromtimestamp(epoch, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def run(run_id: int, age_s: float = 900, event: str = "pull_request", attempt: int = 1) -> dict[str, Any]:
    """Build an API-shaped run."""
    return {"id": run_id, "event": event, "run_attempt": attempt, "created_at": _iso(NOW - age_s)}


STALE = {"pi-linux": "0", "pi-macos": ""}
LATE = runner_rescue.MIN_QUEUED_S + 60


@pytest.mark.parametrize(
    ("jobs", "beats", "picked"),
    [
        ([job("queued", ["pi-macos"], LATE)], STALE, [1]),
        ([job("queued", ["self-hosted", "pi-linux"], LATE)], STALE, [1]),
        ([job("queued", ["pi-macos"], LATE)], {"pi-macos": FRESH}, []),
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
    assert runner_rescue.stranded_runs([run(1)], {1: jobs}, beats, NOW) == picked


def test_stranded_runs_skip_exhausted_and_unrerunnable_runs_and_cap_the_batch() -> None:
    """Stop at `MAX_ATTEMPT`, ignore events we cannot rerun, rescue oldest first, bounded per tick."""
    dead = [job("queued", ["pi-linux"], LATE)]
    runs = [run(i, age_s=10_000 - i) for i in range(10, 20)]
    runs += [run(1, attempt=runner_rescue.MAX_ATTEMPT), run(2, event="schedule")]
    jobs = {r["id"]: dead for r in runs}
    picked = runner_rescue.stranded_runs(runs, jobs, STALE, NOW)
    assert picked == list(range(10, 10 + runner_rescue.MAX_RUNS_PER_TICK))


class FakeGh:
    """Record `gh api` calls and answer run status from a script."""

    def __init__(self, statuses: list[str]) -> None:
        self.statuses = statuses
        self.calls: list[tuple[str, str]] = []

    def __call__(self, *args: str, method: str = "GET") -> Any:
        self.calls.append((method, args[0]))
        if method == "GET":
            return {"status": self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]}
        return None


def test_restart_cancels_waits_then_reruns(monkeypatch: pytest.MonkeyPatch) -> None:
    """Rerun only after the cancel has completed, so the new attempt does not race the old one."""
    fake = FakeGh(["in_progress", "completed"])
    monkeypatch.setattr(runner_rescue, "gh_api", fake)
    monkeypatch.setattr(runner_rescue.time, "sleep", lambda _s: None)
    runner_rescue.restart("o/r", 7)
    assert [m for m, _ in fake.calls if m == "POST"] == ["POST", "POST"]
    assert fake.calls[0] == ("POST", "repos/o/r/actions/runs/7/cancel")
    assert fake.calls[-1] == ("POST", "repos/o/r/actions/runs/7/rerun")


def test_restart_force_cancels_once_then_gives_up(monkeypatch: pytest.MonkeyPatch) -> None:
    """A run that will not cancel is force-cancelled, then reported rather than looped on."""
    fake = FakeGh(["in_progress"])
    monkeypatch.setattr(runner_rescue, "gh_api", fake)
    monkeypatch.setattr(runner_rescue.time, "sleep", lambda _s: None)
    clock = iter(range(0, 10_000, 100))
    monkeypatch.setattr(runner_rescue.time, "monotonic", lambda: float(next(clock)))
    with pytest.raises(TimeoutError, match="force-cancel"):
        runner_rescue.restart("o/r", 7)
    assert ("POST", "repos/o/r/actions/runs/7/force-cancel") in fake.calls
    assert ("POST", "repos/o/r/actions/runs/7/rerun") not in fake.calls


def test_main_dry_run_reports_and_changes_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    """`--dry-run` must not cancel or rerun anything."""
    seen: list[str] = []

    def fake_gh(*args: str, method: str = "GET") -> Any:
        seen.append(f"{method} {args[0]}")
        if "actions/runs?" in args[0]:
            return {"workflow_runs": [run(1, age_s=5000)] if "queued" in args[0] else []}
        return {"jobs": [job("queued", ["pi-macos"], 4000)]}

    monkeypatch.setattr(runner_rescue, "gh_api", fake_gh)
    monkeypatch.setattr(runner_rescue.time, "time", lambda: NOW)
    assert runner_rescue.main(["--repo", "o/r", "--dry-run", "--pool-heartbeat", "pi-macos=0"]) == 0
    assert not [c for c in seen if c.startswith("POST")]


def test_main_restarts_and_reports_a_failed_restart(monkeypatch: pytest.MonkeyPatch) -> None:
    """A restart error is logged and turns the exit status red, without skipping later runs."""

    def fake_gh(*args: str, method: str = "GET") -> Any:
        if "actions/runs?" in args[0]:
            return {"workflow_runs": [run(1, 5000), run(2, 4000)] if "queued" in args[0] else []}
        return {"jobs": [job("queued", ["pi-linux"], 4000)]}

    restarted: list[int] = []

    def fake_restart(_repo: str, run_id: int) -> None:
        if run_id == 1:
            raise subprocess.CalledProcessError(1, "gh")
        restarted.append(run_id)

    monkeypatch.setattr(runner_rescue, "gh_api", fake_gh)
    monkeypatch.setattr(runner_rescue, "restart", fake_restart)
    monkeypatch.setattr(runner_rescue.time, "time", lambda: NOW)
    assert runner_rescue.main(["--repo", "o/r"]) == 1
    assert restarted == [2]


def test_main_rejects_a_bad_repo() -> None:
    """Refuse anything but `owner/name` before calling the API."""
    with pytest.raises(SystemExit):
        runner_rescue.main(["--repo", "nope"])


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


def test_script_entry_point_exits_through_main(monkeypatch: pytest.MonkeyPatch) -> None:
    """Run the file as `__main__` so its exit guard runs, failing before any API call."""
    monkeypatch.setattr(sys, "argv", ["runner_rescue.py", "--repo", "nope"])
    with pytest.raises(SystemExit) as exit_info:
        runpy.run_path(str(Path(runner_rescue.__file__)), run_name="__main__")
    assert exit_info.value.code == 2
