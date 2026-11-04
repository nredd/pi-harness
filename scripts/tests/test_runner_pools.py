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


def test_parse_heartbeats_accepts_values_and_rejects_typos() -> None:
    """An empty value is unset; a missing `=` or an unknown pool is an error, never a silent miss."""
    assert runner_pools.parse_heartbeats(["pi-linux=1", "pi-macos="]) == {"pi-linux": "1", "pi-macos": ""}
    assert runner_pools.parse_heartbeats([]) == {}
    for bad in ("pi-linux", "pi-mac=1", "=1"):
        with pytest.raises(ValueError, match="known pool"):
            runner_pools.parse_heartbeats([bad])


def test_every_self_hosted_shard_names_a_real_pool_and_shard() -> None:
    """A typo in the table must not silently leave a cell hosted forever."""
    for (os_name, shard), pool in runner_pools.SELF_HOSTED_SHARDS.items():
        assert pool in runner_pools.POOLS
        assert shard in {s.name for s in ci_paths.OWNED_SHARDS[os_name]}


def shard_runners(pools: frozenset[str]) -> dict[tuple[str, str], str]:
    """Return every owned shard's runner for the given pools.

    Parameters:
        pools (frozenset[str]): Pools that are up.

    Returns:
        dict[tuple[str, str], str]: `(os, shard)` -> runner label.
    """
    return {
        (os_name, plan.name): plan.runner
        for os_name in ci_paths.OWNED_SHARDS
        for plan in ci_paths.shard_plans(os_name, WORKSPACES, pools=pools)
    }


def test_no_pools_means_every_shard_is_hosted_exactly_as_before() -> None:
    """With nothing up the runners equal the literal pre-pool table, with or without the argument."""
    assert shard_runners(frozenset()) == HOSTED_RUNNERS
    assert {
        (os_name, plan.name): plan.runner
        for os_name in ci_paths.OWNED_SHARDS
        for plan in ci_paths.shard_plans(os_name, WORKSPACES)
    } == HOSTED_RUNNERS


def test_a_pool_that_is_up_takes_only_its_assigned_shard() -> None:
    """Each pool takes one shard; WSL and the other shards stay hosted."""
    both = shard_runners(frozenset({"pi-linux", "pi-macos"}))
    assert both == HOSTED_RUNNERS | {("ubuntu-24.04", "ts"): "pi-linux", ("macos-14", "ts"): "pi-macos"}
    assert shard_runners(frozenset({"pi-linux"})) == HOSTED_RUNNERS | {("ubuntu-24.04", "ts"): "pi-linux"}


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
    """Drive the real CLI: fresh beats route; `--no-pools` and stale beats do not."""
    beat = str(int(time.time()))
    routed = plan_with(
        tmp_path, "a", "--pool-heartbeat", f"pi-linux={beat}", "--pool-heartbeat", f"pi-macos={beat}"
    )
    assert cell_runners(routed, "owned (ubuntu-24.04)")["ts"] == "pi-linux"
    assert cell_runners(routed, "owned (macos-14)")["ts"] == "pi-macos"
    blocked = plan_with(tmp_path, "b", "--pool-heartbeat", f"pi-linux={beat}", "--no-pools")
    assert set(cell_runners(blocked, "owned (ubuntu-24.04)").values()) == {"ubuntu-24.04"}
    stale = plan_with(tmp_path, "c", "--pool-heartbeat", "pi-macos=0", "--pool-heartbeat", "pi-linux=")
    assert set(cell_runners(stale, "owned (macos-14)").values()) == {"xcode-27"}
    assert stale == blocked == plan_with(tmp_path, "d")


def test_main_rejects_a_mistyped_heartbeat_argument(tmp_path: Path) -> None:
    """A typo'd pool name fails the classify step instead of quietly routing everything hosted."""
    out = tmp_path / "out"
    out.write_text("")
    argv = ["--full", "--event", "push", "--github-output", str(out), "--pool-heartbeat", "pi-mac=1"]
    assert ci_paths.main(argv) == 2
