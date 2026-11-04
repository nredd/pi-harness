"""Which self-hosted runner pools are up, and which CI cells they take when they are.

A pool's host writes the current epoch seconds into a repo variable every few seconds (`ci-runners`
supervisors) and writes `0` on a clean stop. `ci_paths.py` reads the values at classify time: a pool
with a fresh heartbeat takes its assigned cells, anything else (missing, `0`, stale, garbled, from the
future) leaves them on the hosted runner, which is also what an untrusted event always gets. The rescue
workflow (`runner_rescue.py`) uses the same freshness rule to find jobs stranded on a dead pool.

A custom label alone is enough for `runs-on`: GitHub matches a runner that carries every listed label,
and each pool's runners carry its label, so a cell's runner stays a plain string.

References:
    https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/using-self-hosted-runners-in-a-workflow
    https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/store-information-in-variables
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

# A heartbeat is written every ~45 s; two minutes tolerates a missed write or two without routing long
# to a dead pool.
HEARTBEAT_TTL_S = 120
# Tolerated clock skew between a pool host and the classify runner.
CLOCK_SKEW_S = 30


@dataclass(frozen=True)
class Pool:
    """One self-hosted runner pool.

    Parameters:
        label (str): Custom runner label, also the `runs-on` value of its cells.
        variable (str): Repo variable its host writes the heartbeat to.
    """

    label: str
    variable: str


POOLS = {
    "pi-linux": Pool("pi-linux", "PI_LINUX_HEARTBEAT"),
    "pi-macos": Pool("pi-macos", "PI_MACOS_HEARTBEAT"),
}

# `(matrix os, owned shard)` -> pool. One long shard per host: a pool runs jobs one at a time, so giving
# it more cells lengthens the critical path. Everything absent here, WSL included, is always hosted.
SELF_HOSTED_SHARDS = {
    ("ubuntu-24.04", "python"): "pi-linux",
    ("macos-14", "ts"): "pi-macos",
}


def is_fresh(value: str, now: float, ttl_s: int = HEARTBEAT_TTL_S) -> bool:
    """Return whether a heartbeat value says its pool is up.

    Parameters:
        value (str): The variable's value; epoch seconds, `0`, empty or garbage.
        now (float): Current epoch seconds.
        ttl_s (int): Maximum age in seconds.

    Returns:
        bool: True for a positive integer that is neither older than `ttl_s` nor ahead by more than the
            skew allowance.
    """
    try:
        beat = int(value.strip())
    except ValueError:
        return False
    return beat > 0 and -CLOCK_SKEW_S <= now - beat <= ttl_s


def parse_heartbeats(items: Sequence[str]) -> dict[str, str]:
    """Parse repeated `POOL=VALUE` command-line items.

    Parameters:
        items (Sequence[str]): e.g. `["pi-linux=1799999990", "pi-macos="]`; an empty value means unset.

    Returns:
        dict[str, str]: Pool name -> raw heartbeat value.

    Raises:
        ValueError: An item has no `=` or names a pool that does not exist, so a typo cannot silently
            leave a pool looking down.
    """
    beats: dict[str, str] = {}
    for item in items:
        name, sep, value = item.partition("=")
        if not sep or name not in POOLS:
            raise ValueError(f"Expected 'POOL=VALUE' for a known pool, got '{item}'")
        beats[name] = value
    return beats


def available_pools(heartbeats: Mapping[str, str], now: float, *, trusted: bool) -> frozenset[str]:
    """Return the pools whose cells may run self-hosted on this run.

    Parameters:
        heartbeats (Mapping[str, str]): Pool name -> heartbeat variable value; absent means no heartbeat.
        now (float): Current epoch seconds.
        trusted (bool): False for a fork PR, or when the maintainer kill switch `PI_POOLS_DISABLED` is set:
            no pool, whatever the heartbeats say.

    Returns:
        frozenset[str]: Names of the fresh pools, empty when `trusted` is false.
    """
    if not trusted:
        return frozenset()
    return frozenset(name for name in POOLS if is_fresh(heartbeats.get(name, ""), now))


def pool_for_shard(os_name: str, shard: str) -> str | None:
    """Return the pool assigned to an owned shard.

    Parameters:
        os_name (str): Matrix `os` value.
        shard (str): Shard name.

    Returns:
        str | None: Pool name, or None when the shard is always hosted.
    """
    return SELF_HOSTED_SHARDS.get((os_name, shard))
