"""Which self-hosted runner pools are up, and which CI cells they take when they are.

A pool's host writes `<epoch seconds>:<free slots>` into a repo variable every ~45 s (`ci-runners`
supervisors) and writes `0` on a clean stop. `ci_paths.py` reads the values at classify time and hands the
longest running cells to each live pool while it has free slots. Everything else, and every cell when a
pool's beat is missing, `0`, stale, garbled or from the future, stays on the hosted runner, which is also
what an untrusted event always gets. The rescue workflow (`runner_rescue.py`) uses the same freshness
rule to find jobs stranded on a dead pool.

A custom label alone is enough for `runs-on`: GitHub matches a runner that carries every listed label,
and each pool's runners carry its label, so a cell's runner stays a plain string.

References:
    https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/using-self-hosted-runners-in-a-workflow
    https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/store-information-in-variables
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
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
        slots (int): Jobs the pool runs at once.
    """

    label: str
    variable: str
    slots: int


POOLS = {
    "pi-linux": Pool("pi-linux", "PI_LINUX_HEARTBEAT", 2),
    "pi-macos": Pool("pi-macos", "PI_MACOS_HEARTBEAT", 1),
}

# Matrix `os` value -> the pool that can run that OS. WSL has no pool and is always hosted.
OS_POOLS = {"ubuntu-24.04": "pi-linux", "macos-14": "pi-macos"}

# A cell's identity: `(job, matrix os, variant)` where variant is the owned shard or the stack name, and
# empty for `contracts`.
CellKey = tuple[str, str, str]

# Seconds a cell runs on a hosted runner (the clean `main` run 41914882314, #463). Only a cell listed here
# and at least `MIN_HEAVY_S` long is ever sent to a pool: a self-hosted job pays ~25 s to clone and boot a
# VM, so short jobs lose, and an unlisted cell is not known to pass on the pool images.
CELL_SECONDS: dict[CellKey, int] = {
    ("owned", "macos-14", "ts"): 937,
    ("owned", "ubuntu-24.04", "ts"): 428,
}
MIN_HEAVY_S = 240


def _split_beat(value: str) -> tuple[str, str | None]:
    """Split a heartbeat value into its epoch and optional free-slot parts.

    Parameters:
        value (str): `<epoch>` or `<epoch>:<free>`.

    Returns:
        tuple[str, str | None]: The epoch text and the free-slot text, None when absent.
    """
    epoch, sep, free = value.strip().partition(":")
    return epoch, free if sep else None


def is_fresh(value: str, now: float, ttl_s: int = HEARTBEAT_TTL_S) -> bool:
    """Return whether a heartbeat value says its pool is up.

    Parameters:
        value (str): The variable's value; `<epoch>`, `<epoch>:<free>`, `0`, empty or garbage.
        now (float): Current epoch seconds.
        ttl_s (int): Maximum age in seconds.

    Returns:
        bool: True for a positive integer epoch that is neither older than `ttl_s` nor ahead by more than
            the skew allowance. The free-slot part is not judged here.
    """
    try:
        beat = int(_split_beat(value)[0])
    except ValueError:
        return False
    return beat > 0 and -CLOCK_SKEW_S <= now - beat <= ttl_s


def free_slots(value: str, now: float, pool: Pool) -> int | None:
    """Return how many jobs a pool can take right now, or None when it is down.

    Parameters:
        value (str): The pool's heartbeat value.
        now (float): Current epoch seconds.
        pool (Pool): The pool, for its slot count.

    Returns:
        int | None: None for a stale, stopped or garbled beat. A plain epoch (no free count) means one slot.
            Otherwise the free count clamped to `[0, pool.slots]`; a negative or non-integer count is
            garbled and counts as down.
    """
    if not is_fresh(value, now):
        return None
    free = _split_beat(value)[1]
    if free is None:
        return min(1, pool.slots)
    try:
        count = int(free)
    except ValueError:
        return None
    return min(count, pool.slots) if count >= 0 else None


def parse_heartbeats(items: Sequence[str]) -> dict[str, str]:
    """Parse repeated `POOL=VALUE` command-line items.

    Parameters:
        items (Sequence[str]): e.g. `["pi-linux=1799999990:2", "pi-macos="]`; an empty value means unset.

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


def pool_capacity(heartbeats: Mapping[str, str], now: float, *, trusted: bool) -> dict[str, int]:
    """Return each live pool's free slots for this run.

    Parameters:
        heartbeats (Mapping[str, str]): Pool name -> heartbeat variable value; absent means no heartbeat.
        now (float): Current epoch seconds.
        trusted (bool): False for a fork PR, or when the maintainer kill switch `PI_POOLS_DISABLED` is set:
            no pool, whatever the heartbeats say.

    Returns:
        dict[str, int]: Pool name -> free slots for every pool that is up (a live pool with none free maps
            to 0); empty when `trusted` is false.
    """
    if not trusted:
        return {}
    capacity = {name: free_slots(heartbeats.get(name, ""), now, pool) for name, pool in POOLS.items()}
    return {name: free for name, free in capacity.items() if free is not None}


def assign_cells(running: Iterable[CellKey], capacity: Mapping[str, int]) -> dict[CellKey, str]:
    """Hand the longest running cells to the pools that have free slots.

    Parameters:
        running (Iterable[CellKey]): Cells this run actually executes, with their full work.
        capacity (Mapping[str, int]): Pool name -> free slots, from `pool_capacity`.

    Returns:
        dict[CellKey, str]: Cell -> pool for each cell sent to a pool. Cells that are short, unlisted, on an
            OS with no pool, or past a pool's free slots stay hosted.
    """
    free = dict(capacity)
    heavy = sorted(
        (key for key in running if CELL_SECONDS.get(key, 0) >= MIN_HEAVY_S and OS_POOLS.get(key[1]) in free),
        key=lambda key: (-CELL_SECONDS[key], key),
    )
    chosen: dict[CellKey, str] = {}
    for key in heavy:
        pool = OS_POOLS[key[1]]
        if free[pool] > 0:
            chosen[key] = pool
            free[pool] -= 1
    return chosen
