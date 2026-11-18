"""Which self-hosted runner pools are up, and which CI cells they take when they are.

A pool's host writes `<epoch seconds>:<free slots>` into a repo variable every ~45 s (`ci-runners`
supervisors) and writes `0` on a clean stop. `ci_paths.py` reads the values at classify time and hands the
longest running cells to each live pool while it has free slots. Everything else, and every cell when a
pool's beat is missing, `0`, stale, garbled or from the future, stays on the hosted runner, which is also
what an untrusted event always gets. The rescue workflow (`runner_rescue.py`) uses the same freshness
rule to find pool cells stranded in a queue. CI also reads an unfinished-run census before admission:
older classifiers reserve shared capacity before their cell jobs appear. Legacy macOS heartbeats are
capped at one usable account, with no speculative queue. The remaining cells overflow immediately.
GitHub read snapshots are not atomic leases; unseen jobs and API propagation remain a residual.

A custom label alone is enough for `runs-on`: GitHub matches a runner that carries every listed label,
and each pool's runners carry its label, so a cell's runner stays a plain string.

References:
    https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/using-self-hosted-runners-in-a-workflow
    https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/store-information-in-variables
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
import time
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

LOGGER = logging.getLogger(__name__)
GH = "/usr/bin/gh"
PAGE_SIZE = 100
GH_TIMEOUT_S = 10
CENSUS_TIMEOUT_S = 30
ACTIVE_STATUSES = ("queued", "in_progress", "pending", "waiting", "requested")

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
        slots (int): Conservative working-slot ceiling, not the configured account count.
        queue_depth (int): Cells beyond its free slots a run may queue on the pool. Zero (every pool today)
            keeps it strict: a busy pool overflows to hosted immediately.
        run_cap (int): Most cells one run may take, 0 for no cap. The rest of the run's heavy cells stay on
            the hosted runner, so both pools work on the same run.
    """

    label: str
    variable: str
    slots: int
    queue_depth: int = 0
    run_cap: int = 0


# Legacy heartbeats count configured slots, not healthy accounts. Until working-account counts are
# published, macOS is conservatively one usable slot and no queue allowance. Admission below shares
# these slots across runs instead of allowing every classifier to spend the same heartbeat again.
POOLS = {
    "pi-linux": Pool("pi-linux", "PI_LINUX_HEARTBEAT", 2),
    "pi-macos": Pool("pi-macos", "PI_MACOS_HEARTBEAT", 1, run_cap=1),
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
    # Known macOS work, ranked by expected completion time so the longest admitted cell starts locally
    # while shorter peers execute hosted. The macOS `scripts`
    # shard (~1140 s, run 44008954118) is deliberately NOT listed: it has not passed on the pool image (only
    # `ts` is known to), and as the longest cell it would take the first slot. List it after one pool pass.
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


def cell_pool(name: str) -> str | None:
    """Return the pool a CI job can run on, from its check name.

    Parameters:
        name (str): A job name such as `owned shard (macos-14, ts)` or `contracts (macos-14)`.

    Returns:
        str | None: The pool for a listed cell at least `MIN_HEAVY_S` long, else None (never migrate an
            unlisted or unproven cell).
    """
    for (kind, os_name, variant), seconds in CELL_SECONDS.items():
        suffix = f", {variant}" if variant else ""
        label = f"owned shard ({os_name}, {variant})" if kind == "owned" else f"{kind} ({os_name}{suffix})"
        if name == label and seconds >= MIN_HEAVY_S:
            return OS_POOLS[os_name]
    return None


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
    """Return trusted fresh capacity, bounded by conservative working-slot counts.

    Parameters:
        heartbeats (Mapping[str, str]): Raw heartbeat values.
        now (float): Current epoch seconds.
        trusted (bool): False for forks or the kill switch.

    Returns:
        dict[str, int]: Nonnegative slots available before cross-run admission. Legacy macOS beats
            cannot prove that more than one account works; positive free counts are capped at one.
            Busy pools overflow immediately to hosted, with no speculative queue allowance.
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


def admit_capacity(
    capacity: Mapping[str, int],
    runs: Sequence[Mapping[str, Any]],
    jobs_by_run: Mapping[int, Sequence[Mapping[str, Any]]],
    run_id: int,
    repo: str,
) -> dict[str, int]:
    """Reserve a burst's shared slots before this run assigns its longest cells.

    Parameters:
        capacity (Mapping[str, int]): Fresh heartbeat capacity, already limited to working slots.
        runs (Sequence[Mapping[str, Any]]): Complete unfinished CI-run census.
        jobs_by_run (Mapping[int, Sequence[Mapping[str, Any]]]): Latest-attempt jobs for every run.
        run_id (int): The classifying run's immutable GitHub id.
        repo (str): The repository; fork runs never reserve capacity.

    Returns:
        dict[str, int]: Per pool, the heartbeat capacity minus the pool's observed unfinished jobs and, for
            each other run still classifying or finished with `classify` but without cells, the pool's whole
            run-placeable room, in the pools its unlabeled cells target (else every pool). A snapshot
            missing a run fails closed to `{}`. API visibility is not an atomic lease.
    """
    if run_id not in {run["id"] for run in runs} or any(run["id"] not in jobs_by_run for run in runs):
        return {}
    used = dict.fromkeys(capacity, 0)
    for run in runs:
        if run["id"] == run_id or (run.get("head_repository") or {}).get("full_name") != repo:
            continue
        jobs = jobs_by_run[run["id"]]
        unfinished = [job for job in jobs if job["status"] != "completed"]
        classified = any(
            job.get("name") == "classify changed paths" and job["status"] == "completed" for job in jobs
        )
        planning = (
            not jobs
            or all(job.get("name") == "classify changed paths" for job in jobs)
            or any(
                job.get("name") == "classify changed paths"
                or (
                    job.get("name", "").startswith(("owned shard (", "stack (", "contracts ("))
                    and not job.get("labels")
                )
                for job in unfinished
            )
        )
        # Cells without runner labels name the pools they target; a run with no cells yet could use any.
        named = {p for job in unfinished if not job.get("labels") and (p := cell_pool(job.get("name", "")))}
        targeted = named or set(used)
        for pool, occupied_slots in used.items():
            # A run with no cells yet may materialise the pool's whole run-placeable room.
            reserve = _cap(POOLS[pool].slots, POOLS[pool].run_cap)
            occupied = sum(POOLS[pool].label in job.get("labels", ()) for job in unfinished)
            reserved = reserve if planning and pool in targeted and (run["id"] < run_id or classified) else 0
            used[pool] = occupied_slots + max(occupied, reserved)
    # Reported free already subtracts older running jobs. Take the minimum of independently observed
    # headroom and the heartbeat, rather than subtracting those jobs from the free count twice.
    return {
        pool: _cap(min(slots, max(0, POOLS[pool].slots - used[pool])), POOLS[pool].run_cap)
        for pool, slots in capacity.items()
    }


def gh_read(path: str) -> Any:
    """Read one GitHub API page; failures propagate to admission's hosted fallback.

    `gh` stderr is merged into the output, so a warning or error text is not JSON: it raises `ValueError`
    and admission fails closed to hosted instead of parsing a partial page.

    Parameters:
        path (str): Repository-scoped REST path.

    Returns:
        Any: Decoded JSON page.

    Raises:
        subprocess.SubprocessError: The bounded read failed or timed out.
        ValueError: The response was not JSON.
    """
    return json.loads(
        subprocess.check_output(
            [GH, "api", "--method", "GET", path], text=True, stderr=subprocess.STDOUT, timeout=GH_TIMEOUT_S
        )
    )


def live_capacity(capacity: Mapping[str, int], repo: str, run_id: int, attempt: int = 1) -> dict[str, int]:
    """Read a bounded unfinished-run census, then admit this run or fall back hosted.

    Parameters:
        capacity (Mapping[str, int]): Heartbeat capacity.
        repo (str): GitHub repository.
        run_id (int): Classifying run.
        attempt (int): Current attempt; pools used by any earlier attempt are excluded.

    Returns:
        dict[str, int]: Admitted capacity, empty on incomplete or unavailable API evidence.
    """
    if not capacity or not any(capacity.values()):
        return {}
    deadline = time.monotonic() + CENSUS_TIMEOUT_S
    try:
        runs: dict[int, Mapping[str, Any]] = {}
        for status in ACTIVE_STATUSES:
            if time.monotonic() > deadline:
                raise TimeoutError("Pool run census exceeded its admission deadline")
            page = gh_read(f"repos/{repo}/actions/workflows/ci.yml/runs?status={status}&per_page={PAGE_SIZE}")
            if page["total_count"] >= PAGE_SIZE:
                return {}
            runs |= {run["id"]: run for run in page["workflow_runs"]}
        jobs: dict[int, list[dict[str, Any]]] = {}
        for ident in runs:
            if time.monotonic() > deadline:
                raise TimeoutError("Pool job census exceeded its admission deadline")
            page = gh_read(f"repos/{repo}/actions/runs/{ident}/jobs?filter=latest&per_page={PAGE_SIZE}")
            if page["total_count"] >= PAGE_SIZE:
                return {}
            jobs[ident] = page["jobs"]
        available = dict(capacity)
        for earlier in range(1, attempt):
            page = gh_read(f"repos/{repo}/actions/runs/{run_id}/attempts/{earlier}/jobs?per_page={PAGE_SIZE}")
            if page["total_count"] >= PAGE_SIZE:
                return {}
            # Never send a rescued run back to a pool that stranded ANY earlier attempt.
            for pool in available:
                if any(POOLS[pool].label in job["labels"] for job in page["jobs"]):
                    available[pool] = 0
        return admit_capacity(available, list(runs.values()), jobs, run_id, repo)
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError) as e:
        LOGGER.warning(f"Pool admission unavailable; using hosted runners: {e}")
        return {}


def _cap(cells: int, run_cap: int) -> int:
    """Return `cells` limited to `run_cap`, where 0 means no limit."""
    return min(cells, run_cap) if run_cap else cells


def assign_cells(running: Iterable[CellKey], capacity: Mapping[str, int]) -> dict[CellKey, str]:
    """Hand the longest running cells to the pools that will take them.

    Parameters:
        running (Iterable[CellKey]): Cells this run actually executes, with their full work.
        capacity (Mapping[str, int]): Pool name -> cells it will take, from `pool_capacity` (free
            working slots after admission, held to its run cap).

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
