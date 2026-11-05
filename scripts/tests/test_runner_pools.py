"""Test which self-hosted pools take CI cells.

References:
    https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/using-self-hosted-runners-in-a-workflow
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ci_paths
import runner_pools

NOW = 1_800_000_000.0
FRESH = str(int(NOW) - 30)
WORKSPACES = ci_paths.npm_workspaces(ci_paths.REPO_ROOT)

# Every owned shard's runner before self-hosted pools existed, written out so the all-hosted plan cannot
# drift with the code under test.
HOSTED_RUNNERS = {
    ("ubuntu-24.04", "subagents"): "ubuntu-24.04",
    ("ubuntu-24.04", "computer-use"): "ubuntu-24.04",
    ("ubuntu-24.04", "ts"): "ubuntu-24.04",
    ("ubuntu-24.04", "python"): "ubuntu-24.04",
    ("macos-14", "ts"): "xcode-27",
    ("macos-14", "python"): "xcode-27",
    ("wsl2", "subagents-computer-use"): "windows-2025",
    ("wsl2", "ts"): "windows-2025",
}


@pytest.mark.parametrize(
    ("value", "fresh"),
    [
        (FRESH, True),
        (f"{FRESH}:2", True),
        (str(int(NOW) - runner_pools.HEARTBEAT_TTL_S), True),
        (str(int(NOW) - runner_pools.HEARTBEAT_TTL_S - 1), False),
        (str(int(NOW) + runner_pools.CLOCK_SKEW_S), True),
        (str(int(NOW) + runner_pools.CLOCK_SKEW_S + 1), False),
        (f" {FRESH}\n", True),
        ("0", False),
        ("0:2", False),
        ("-5", False),
        ("", False),
        ("abc", False),
        ("1.5e9", False),
    ],
)
def test_is_fresh(value: str, fresh: bool) -> None:
    """Accept only a recent positive integer epoch, with or without a free count."""
    assert runner_pools.is_fresh(value, NOW) is fresh


LINUX = runner_pools.POOLS["pi-linux"]
MACOS = runner_pools.POOLS["pi-macos"]


@pytest.mark.parametrize(
    ("value", "pool", "free"),
    [
        (f"{FRESH}:2", LINUX, 2),
        (f"{FRESH}:0", LINUX, 0),
        (f"{FRESH}:9", LINUX, LINUX.slots),
        (f"{FRESH}:1", MACOS, 1),
        (FRESH, LINUX, 1),
        (FRESH, MACOS, 1),
        (f"{FRESH}:-1", LINUX, -1),
        (f"{FRESH}:-7", MACOS, -7),
        (f"{FRESH}:drain", LINUX, None),
        (f"{FRESH}:drain", MACOS, None),
        (f"{FRESH}:x", LINUX, None),
        (f"{FRESH}:", LINUX, None),
        ("0", LINUX, None),
        ("", LINUX, None),
        (str(int(NOW) - 500) + ":2", LINUX, None),
    ],
)
def test_free_slots(value: str, pool: runner_pools.Pool, free: int | None) -> None:
    """A stale, stopped, draining or garbled beat is down (None); a live one reports its free count,
    negative while jobs wait, capped at the pool's slots."""
    assert runner_pools.free_slots(value, NOW, pool) == free


def test_pool_capacity_needs_a_live_beat_and_a_trusted_event() -> None:
    """Never offer a pool to a fork PR; a dead one is absent; a strict full pool maps to 0."""
    beats = {"pi-linux": f"{FRESH}:2", "pi-macos": "0"}
    assert runner_pools.pool_capacity(beats, NOW, trusted=True) == {"pi-linux": 2}
    assert runner_pools.pool_capacity(beats, NOW, trusted=False) == {}
    assert runner_pools.pool_capacity({"pi-linux": f"{FRESH}:0"}, NOW, trusted=True) == {"pi-linux": 0}


@pytest.mark.parametrize(
    ("beat", "capacity"),
    [
        (f"{FRESH}:2", 3),  # two free plus the one queued cell the pool allows
        (f"{FRESH}:0", 1),  # full, but one may wait
        (f"{FRESH}:-1", 0),  # one already waits: the allowed queue is taken
        (f"{FRESH}:-5", 0),  # deeper backlog never goes negative
        (f"{FRESH}:drain", None),  # draining: starts nothing, so nothing may be queued on it
        ("0", None),
    ],
)
def test_a_queue_depth_pool_allows_one_waiting_cell_and_no_more(beat: str, capacity: int | None) -> None:
    """The macOS pool lets one cell wait beyond its free slots; the backlog the pool reports caps it."""
    got = runner_pools.pool_capacity({"pi-macos": beat}, NOW, trusted=True)
    assert got.get("pi-macos") == capacity
    assert runner_pools.POOLS["pi-macos"].queue_depth == 1
    assert runner_pools.POOLS["pi-linux"].queue_depth == 0


def test_pool_is_up_means_fresh_and_not_draining() -> None:
    """A draining pool still beats, but its queued jobs are stranded, so it does not count as up."""
    assert runner_pools.pool_is_up(f"{FRESH}:2", NOW)
    assert runner_pools.pool_is_up(FRESH, NOW)
    assert not runner_pools.pool_is_up(f"{FRESH}:drain", NOW)
    assert not runner_pools.pool_is_up("0", NOW)
    assert not runner_pools.pool_is_up(str(int(NOW) - 500), NOW)
    assert runner_pools.pool_capacity({}, NOW, trusted=True) == {}
    assert runner_pools.pool_capacity({"other": FRESH}, NOW, trusted=True) == {}


def test_parse_heartbeats_accepts_values_and_rejects_typos() -> None:
    """An empty value is unset; a missing `=` or an unknown pool is an error, never a silent miss."""
    assert runner_pools.parse_heartbeats(["pi-linux=1:2", "pi-macos="]) == {"pi-linux": "1:2", "pi-macos": ""}
    assert runner_pools.parse_heartbeats([]) == {}
    for bad in ("pi-linux", "pi-mac=1", "=1"):
        with pytest.raises(ValueError, match="known pool"):
            runner_pools.parse_heartbeats([bad])


def test_the_tables_name_real_pools_and_cells() -> None:
    """A typo in a table must not silently leave a cell hosted forever."""
    assert set(runner_pools.OS_POOLS.values()) <= set(runner_pools.POOLS)
    shards = {(os_name, s.name) for os_name, group in ci_paths.OWNED_SHARDS.items() for s in group}
    for job, os_name, variant in runner_pools.CELL_SECONDS:
        assert os_name in runner_pools.OS_POOLS
        assert job in {"owned", "contracts", "stack"}
        if job == "owned":
            assert (os_name, variant) in shards
        elif job == "stack":
            assert variant in ci_paths.STACKS
        else:
            assert variant == ""


TABLE = {
    ("owned", "macos-14", "ts"): 900,
    ("owned", "macos-14", "python"): 460,
    ("contracts", "macos-14", ""): 330,
    ("owned", "ubuntu-24.04", "ts"): 430,
    ("stack", "ubuntu-24.04", "personal"): 940,
    ("owned", "ubuntu-24.04", "subagents"): 240,
    ("contracts", "ubuntu-24.04", ""): 110,
}


@pytest.fixture
def table(monkeypatch: pytest.MonkeyPatch) -> dict[runner_pools.CellKey, int]:
    """Swap in a rich duration table so the algorithm is tested independent of what is enabled today."""
    monkeypatch.setattr(runner_pools, "CELL_SECONDS", TABLE)
    return TABLE


def test_assign_cells_gives_each_pool_its_longest_cells_up_to_its_free_slots(table: dict[Any, int]) -> None:
    """Longest first per OS pool, bounded by free slots; short and unlisted cells stay hosted."""
    running = [*table, ("owned", "macos-14", "unlisted"), ("owned", "wsl2", "ts")]
    chosen = runner_pools.assign_cells(running, {"pi-linux": 2, "pi-macos": 1})
    assert chosen == {
        ("owned", "macos-14", "ts"): "pi-macos",
        ("stack", "ubuntu-24.04", "personal"): "pi-linux",
        ("owned", "ubuntu-24.04", "ts"): "pi-linux",
    }
    assert runner_pools.assign_cells(running, {"pi-linux": 1, "pi-macos": 0}) == {
        ("stack", "ubuntu-24.04", "personal"): "pi-linux"
    }
    assert runner_pools.assign_cells(running, {"pi-macos": 2}) == {
        ("owned", "macos-14", "ts"): "pi-macos",
        ("owned", "macos-14", "python"): "pi-macos",
    }
    assert runner_pools.assign_cells(running, {}) == {}


def test_assign_cells_only_considers_cells_that_run(table: dict[Any, int]) -> None:
    """A cell absent from `running` (bypass, NOT RUN) is never assigned; the next-longest takes the slot."""
    running = [("owned", "macos-14", "python"), ("contracts", "macos-14", "")]
    assert runner_pools.assign_cells(running, {"pi-macos": 1}) == {
        ("owned", "macos-14", "python"): "pi-macos"
    }


def test_assign_cells_skips_cells_under_the_heavy_threshold(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A self-hosted job pays VM boot time, so a cell under `MIN_HEAVY_S` stays hosted."""
    short = runner_pools.MIN_HEAVY_S - 1
    monkeypatch.setattr(runner_pools, "CELL_SECONDS", {("contracts", "ubuntu-24.04", ""): short})
    assert runner_pools.assign_cells([("contracts", "ubuntu-24.04", "")], {"pi-linux": 2}) == {}


def full_plan(**kwargs: Any) -> dict[str, ci_paths.CellPlan]:
    """Plan every cell for a full-verification dispatch.

    Parameters:
        **kwargs (Any): Passed to `plan_cells` (e.g. `capacity`).

    Returns:
        dict[str, ci_paths.CellPlan]: The plan per check name.
    """
    return ci_paths.plan_cells(ci_paths.full_classification(), "workflow_dispatch", **kwargs)


def plan_runners(plan: dict[str, ci_paths.CellPlan]) -> dict[tuple[str, str, str], str]:
    """Flatten a plan into `(job, os, variant)` -> the runner each cell would use ('' means its matrix's).

    Parameters:
        plan (dict[str, ci_paths.CellPlan]): The plan per check name.

    Returns:
        dict[tuple[str, str, str], str]: Runner labels, shard runners for `owned`.
    """
    out: dict[tuple[str, str, str], str] = {}
    for os_name in ci_paths.OWNED_SHARDS:
        out |= {("owned", os_name, s.name): s.runner for s in plan[f"owned ({os_name})"].shards}
        out[("contracts", os_name, "")] = plan[f"contracts ({os_name})"].runner
        for stack in ci_paths.STACKS:
            out[("stack", os_name, stack)] = plan[f"stack ({os_name}, {stack})"].runner
    return out


def test_no_capacity_means_the_plan_is_exactly_the_all_hosted_plan(table: dict[Any, int]) -> None:
    """With no pool up, every shard has its literal pre-pool runner and no cell carries a runner."""
    for plan in (full_plan(), full_plan(capacity={}), full_plan(capacity=None)):
        runners = plan_runners(plan)
        assert {k[1:]: v for k, v in runners.items() if k[0] == "owned"} == HOSTED_RUNNERS
        assert all(v == "" for k, v in runners.items() if k[0] != "owned")
        assert all("runner" not in cell.to_output() for cell in plan.values())


def test_capacity_moves_only_the_chosen_cells_and_keeps_check_names(table: dict[Any, int]) -> None:
    """Pool-routed shards and cells change runner; every check name and every other cell is untouched."""
    hosted = full_plan()
    routed = full_plan(capacity={"pi-linux": 2, "pi-macos": 1})
    assert routed.keys() == hosted.keys()
    runners = plan_runners(routed)
    assert runners[("owned", "macos-14", "ts")] == "pi-macos"
    assert runners[("stack", "ubuntu-24.04", "personal")] == "pi-linux"
    assert runners[("owned", "ubuntu-24.04", "ts")] == "pi-linux"
    pooled = {k for k, v in runners.items() if v in {"pi-linux", "pi-macos"}}
    assert pooled == {
        ("owned", "macos-14", "ts"),
        ("stack", "ubuntu-24.04", "personal"),
        ("owned", "ubuntu-24.04", "ts"),
    }
    assert routed["stack (ubuntu-24.04, personal)"].to_output()["runner"] == "pi-linux"
    assert all(
        routed[n] == hosted[n]
        for n in hosted
        if n not in {"owned (macos-14)", "owned (ubuntu-24.04)", "stack (ubuntu-24.04, personal)"}
    )


def test_a_setup_only_stack_is_never_routed(table: dict[Any, int]) -> None:
    """The personal stack on a PR without stack inputs only runs setup, which is short."""
    inputs = dict.fromkeys(ci_paths.INPUT_CLASSES, False)
    result = ci_paths.ChangeClassification(paths=("README.md",), docs_only=False, inputs=inputs)
    plan = ci_paths.plan_cells(result, "pull_request", capacity={"pi-linux": 2, "pi-macos": 1})
    assert plan["stack (ubuntu-24.04, personal)"].scenarios is False
    assert plan["stack (ubuntu-24.04, personal)"].runner == ""


def test_a_blocked_title_routes_nothing(table: dict[Any, int]) -> None:
    """A blocked plan never starts a self-hosted job."""
    plan = ci_paths.plan_cells(ci_paths.full_classification(), "pull_request", "bad title", {"pi-linux": 2})
    assert {c.runner for c in plan.values()} == {""}


def plan_with(tmp_path: Path, name: str, *extra: str) -> dict[str, Any]:
    """Run the real CLI for a dispatch event and return the published plan.

    Parameters:
        tmp_path (Path): Directory for the output file.
        name (str): Output file name, unique per call.
        *extra (str): Extra CLI arguments.

    Returns:
        dict[str, Any]: The decoded `plan` output.
    """
    out = tmp_path / name
    out.write_text("")
    argv = ["--full", "--event", "workflow_dispatch", "--github-output", str(out), *extra]
    assert ci_paths.main(argv) == 0
    line = next(x for x in out.read_text().splitlines() if x.startswith("plan="))
    return json.loads(line.removeprefix("plan="))


def cell_runners(plan: dict[str, Any], cell: str) -> dict[str, str]:
    """Return a published cell's shard -> runner.

    Parameters:
        plan (dict[str, Any]): The published plan.
        cell (str): Check name, e.g. `owned (macos-14)`.

    Returns:
        dict[str, str]: Shard name -> runner label.
    """
    return {s["shard"]: s["runner"] for s in plan[cell]["shards"]}


def test_main_routes_with_fresh_beats_and_never_with_no_pools(tmp_path: Path) -> None:
    """Drive the real CLI: live pools with room route; `--no-pools`, stale and full pools do not."""
    beat = str(int(time.time()))
    routed = plan_with(
        tmp_path, "a", "--pool-heartbeat", f"pi-linux={beat}:2", "--pool-heartbeat", f"pi-macos={beat}:1"
    )
    assert cell_runners(routed, "owned (ubuntu-24.04)")["ts"] == "pi-linux"
    assert cell_runners(routed, "owned (macos-14)")["ts"] == "pi-macos"
    blocked = plan_with(tmp_path, "b", "--pool-heartbeat", f"pi-linux={beat}:2", "--no-pools")
    assert set(cell_runners(blocked, "owned (ubuntu-24.04)").values()) == {"ubuntu-24.04"}
    stale = plan_with(tmp_path, "c", "--pool-heartbeat", "pi-macos=0", "--pool-heartbeat", "pi-linux=")
    assert set(cell_runners(stale, "owned (macos-14)").values()) == {"xcode-27"}
    full = plan_with(
        tmp_path, "e", "--pool-heartbeat", f"pi-linux={beat}:0", "--pool-heartbeat", f"pi-macos={beat}:-1"
    )
    assert full == stale == blocked == plan_with(tmp_path, "d")


def test_main_rejects_a_mistyped_heartbeat_argument(tmp_path: Path) -> None:
    """A typo'd pool name fails the classify step instead of quietly routing everything hosted."""
    out = tmp_path / "out"
    out.write_text("")
    argv = ["--full", "--event", "push", "--github-output", str(out), "--pool-heartbeat", "pi-mac=1"]
    assert ci_paths.main(argv) == 2
