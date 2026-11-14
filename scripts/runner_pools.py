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

import re
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
        queue_depth (int): Cells beyond its free slots a run may still queue on the pool. Zero keeps a
            pool strict; a positive depth pays off where the hosted runner of that OS queues for longer
            than a slot takes to free up (macOS), and is bounded by the backlog the pool reports.
        run_cap (int): Most cells one run may take, 0 for no cap. The rest of the run's heavy cells stay on
            the hosted runner, so both pools work on the same run.
    """

    label: str
    variable: str
    slots: int
    queue_depth: int = 0
    run_cap: int = 0


# Hosted macOS jobs wait a median 215 s but p90 ~1 h under load (156 jobs, 2026-11-13), while `pi-macos` jobs
# started in a median 30 s (p90 141 s). An idle `pi-macos` takes up to three cells from a run (two free slots
# plus one queued); a busy one queues only one more, so a host death strands little. Disk pressure is not
# modelled here: the host publishes `<epoch>:drain` when storage is low (nredd/ci-runners#5), which already
# fails closed to hosted. Hosted Linux queues for seconds: strict.
POOLS = {
    "pi-linux": Pool("pi-linux", "PI_LINUX_HEARTBEAT", 2),
    "pi-macos": Pool("pi-macos", "PI_MACOS_HEARTBEAT", 2, queue_depth=1, run_cap=3),
    # One ARM64 WSL2 slot and strict: nothing else can run that guest, and the hosted x64 `windows-2025`
    # cell keeps the required check names green whenever the pool is down or busy.
    "pi-wsl2": Pool("pi-wsl2", "PI_WSL2_HEARTBEAT", 1),
}

# Matrix `os` value -> the pool that can run that OS. A `wsl2` cell that takes the pool runs natively on its
# linux-arm64 runner (`host` "native" in the plan); otherwise it stays on the hosted Windows guest.
OS_POOLS = {"ubuntu-24.04": "pi-linux", "macos-14": "pi-macos", "wsl2": "pi-wsl2"}

# A cell's identity: `(job, matrix os, variant)` where variant is the owned shard or the stack name, and
# empty for `contracts`.
CellKey = tuple[str, str, str]

# Seconds a cell runs on a hosted runner (the clean `main` run 41914882314, #463; the macOS `check-ts`
# shards from run 42799667706, #660). Only a cell listed here and at least `MIN_HEAVY_S` long is ever sent
# to a pool: a self-hosted job pays ~25 s to clone and boot a VM, so short jobs lose, and an unlisted cell
# is not known to pass on the pool images.
CELL_SECONDS: dict[CellKey, int] = {
    # Every macOS cell that does real work. Hosted macOS is the longest pole (p90 queue ~1 h), and
    # `pi-macos` has two slots plus a queue (`POOLS`), and one PR takes at most `run_cap` of them.
    ("owned", "macos-14", "subagents"): 680,
    ("owned", "macos-14", "computer-use"): 360,
    ("owned", "macos-14", "ts"): 480,
    ("stack", "macos-14", "local"): 711,
    ("owned", "macos-14", "python"): 462,
    ("contracts", "macos-14", ""): 331,
    ("owned", "ubuntu-24.04", "ts"): 428,
    # UNMEASURED best estimates for the ARM64 WSL2 pool (#736): a pooled cell skips the ~3.5 min guest setup
    # but runs on a laptop VM capped at 4 cores. Replace with measured seconds after the first green jobs.
    ("owned", "wsl2", "subagents-computer-use"): 600,
    ("owned", "wsl2", "ts"): 600,
    ("contracts", "wsl2", ""): 400,
}
MIN_HEAVY_S = 240


DRAINING = "drain"

# The one grammar of a heartbeat value, ASCII only: `<epoch>`, `<epoch>:<free>` (free may be negative) or
# `<epoch>:drain`. `int()` alone also takes `+3`, `1_0`, padded text and non-ASCII digits, which a writer
# never sends; anything else is garbled, and routing and the rescue must agree on that.
BEAT = re.compile(r"(?P<epoch>[0-9]+)(?::(?P<free>-?[0-9]+|drain))?", re.ASCII)


def parse_beat(value: str) -> tuple[int, int | str | None] | None:
    """Parse a heartbeat value with the strict grammar.

    Parameters:
        value (str): The variable's value, surrounding whitespace allowed (as GitHub may store it).

    Returns:
        tuple[int, int | str | None] | None: `(epoch, free)` where free is None for a plain epoch, an int,
            or `DRAINING`; None when the value does not match, which counts as down.
    """
    match = BEAT.fullmatch(value.strip())
    if match is None:
        return None
    free = match["free"]
    if free is None:
        return int(match["epoch"]), None
    return int(match["epoch"]), free if free == DRAINING else int(free)


def is_fresh(value: str, now: float, ttl_s: int = HEARTBEAT_TTL_S) -> bool:
    """Return whether a heartbeat value says its pool is up.

    Parameters:
        value (str): The variable's value; `<epoch>`, `<epoch>:<free>`, `<epoch>:drain`, `0`, empty or
            garbage.
        now (float): Current epoch seconds.
        ttl_s (int): Maximum age in seconds.

    Returns:
        bool: True for a well-formed value whose epoch is positive and neither older than `ttl_s` nor ahead
            by more than the skew allowance.
    """
    parsed = parse_beat(value)
    if parsed is None:
        return False
    return parsed[0] > 0 and -CLOCK_SKEW_S <= now - parsed[0] <= ttl_s


def pool_is_up(value: str, now: float) -> bool:
    """Return whether a pool is up AND will start the jobs queued on its label.

    A draining pool beats but starts nothing new, so a job queued on it is stranded until it exits:
    routing must not send work there and the rescue must not wait for a stale beat to move it.

    Parameters:
        value (str): The pool's heartbeat value.
        now (float): Current epoch seconds.

    Returns:
        bool: True for a well-formed, fresh beat that is not `<epoch>:drain`.
    """
    parsed = parse_beat(value)
    return parsed is not None and is_fresh(value, now) and parsed[1] != DRAINING


def free_slots(value: str, now: float, pool: Pool) -> int | None:
    """Return a live pool's free slots, negative while jobs wait on it, or None when it is down.

    Parameters:
        value (str): The pool's heartbeat value.
        now (float): Current epoch seconds.
        pool (Pool): The pool, for its slot count.

    Returns:
        int | None: None for a stale, stopped, draining or garbled beat. A plain epoch (no count) means
            one free slot. Otherwise slots minus running minus queued jobs, capped at `pool.slots`; it
            is negative when more jobs wait than the pool can start, which is how a run knows the
            queue is already deep.
    """
    parsed = parse_beat(value)
    if parsed is None or not pool_is_up(value, now):
        return None
    free = parsed[1]
    if free is None:
        return min(1, pool.slots)
    return min(int(free), pool.slots)


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
    """Return how many cells each live pool can take from this run.

    Parameters:
        heartbeats (Mapping[str, str]): Pool name -> heartbeat variable value; absent means no heartbeat.
        now (float): Current epoch seconds.
        trusted (bool): False for a fork PR, or when the maintainer kill switch `PI_POOLS_DISABLED` is set:
            no pool, whatever the heartbeats say.

    Returns:
        dict[str, int]: Pool name -> free slots plus the pool's `queue_depth`, floored at 0 and capped at its
            `run_cap` when it has one, for every pool that is up (a live, full pool maps to 0 unless it
            allows queueing); empty when `trusted` is false. A beat without a count reports no backlog, so
            it earns no queue allowance: capacity is its one free slot. The negative backlog in a counted
            beat limits runs that classify after the writer publishes it, but runs inside one beat interval
            all read the same count, so a burst of N runs can still put up to N times that capacity on the
            pool; the per-run cap and small depth bound each run's share, not the burst.
    """
    if not trusted:
        return {}
    result: dict[str, int] = {}
    for name, pool in POOLS.items():
        value = heartbeats.get(name, "")
        free = free_slots(value, now, pool)
        if free is None:
            continue
        parsed = parse_beat(value)
        counted = parsed is not None and parsed[1] is not None
        result[name] = _cap(max(0, free + (pool.queue_depth if counted else 0)), pool.run_cap)
    return result


def _cap(cells: int, run_cap: int) -> int:
    """Return `cells` limited to `run_cap`, where 0 means no limit."""
    return min(cells, run_cap) if run_cap else cells


def assign_cells(running: Iterable[CellKey], capacity: Mapping[str, int]) -> dict[CellKey, str]:
    """Hand the longest running cells to the pools that will take them.

    Parameters:
        running (Iterable[CellKey]): Cells this run actually executes, with their full work.
        capacity (Mapping[str, int]): Pool name -> cells it will take, from `pool_capacity` (free
            slots plus its queue depth, held to its run cap).

    Returns:
        dict[CellKey, str]: Cell -> pool for each cell sent to a pool. Cells that are short, unlisted, on an
            OS with no pool, or past a pool's capacity stay hosted.
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
