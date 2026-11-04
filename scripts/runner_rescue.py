"""Re-route CI runs stranded on a self-hosted pool that went away.

`ci_paths.py` sends a cell to a pool only while its heartbeat is fresh, but a pool can die after a run was
classified (NAS power cut, laptop lid closed). Its queued jobs then wait for a runner that never comes, and
`timeout-minutes` does not apply to queued jobs. This script finds runs with a job queued on a dead pool's
label for longer than `MIN_QUEUED_S`, cancels each run and starts it over; the rerun's `classify` job sees the
stale heartbeat and puts the cells back on hosted runners.

It only reads runs and cancels/reruns them: no secret, and the workflow token needs `actions: write` alone.

References:
    https://docs.github.com/en/rest/actions/workflow-runs#cancel-a-workflow-run
    https://docs.github.com/en/rest/actions/workflow-runs#re-run-a-workflow
    https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
import time
from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any

from runner_pools import POOLS, is_fresh

LOGGER = logging.getLogger(__name__)

GH = os.environ.get("GH_BIN", "/usr/bin/gh")
MIN_QUEUED_S = 300
# A run is rescued at most this many attempts in total, so a cell that cannot start anywhere cannot loop.
MAX_ATTEMPT = 3
# Per tick, so one outage cannot cancel the whole queue at once.
MAX_RUNS_PER_TICK = 5
CANCEL_WAIT_S = 180
POLL_S = 5
RERUN_EVENTS = frozenset({"pull_request", "push", "workflow_dispatch"})
POOL_LABELS = {pool.label: name for name, pool in POOLS.items()}


def parse_time(stamp: str) -> float:
    """Convert a GitHub ISO timestamp to epoch seconds.

    Parameters:
        stamp (str): e.g. `2026-11-04T17:27:17Z`.

    Returns:
        float: Epoch seconds.
    """
    return datetime.fromisoformat(stamp).timestamp()


def stranded_runs(
    runs: Sequence[Mapping[str, Any]],
    jobs_by_run: Mapping[int, Sequence[Mapping[str, Any]]],
    heartbeats: Mapping[str, str],
    now: float,
) -> list[int]:
    """Pick the runs to cancel and rerun.

    Parameters:
        runs (Sequence[Mapping[str, Any]]): Unfinished workflow runs from the API.
        jobs_by_run (Mapping[int, Sequence[Mapping[str, Any]]]): Each run's jobs from the API.
        heartbeats (Mapping[str, str]): Pool name -> heartbeat variable value.
        now (float): Current epoch seconds.

    Returns:
        list[int]: Ids of runs with a job queued past `MIN_QUEUED_S` on a pool label whose heartbeat is stale,
            oldest first, capped at `MAX_RUNS_PER_TICK`. A run already at `MAX_ATTEMPT` or from an event we
            cannot rerun is left alone.
    """
    picked: list[int] = []
    for run in sorted(runs, key=lambda r: r["created_at"]):
        if run["event"] not in RERUN_EVENTS or run.get("run_attempt", 1) >= MAX_ATTEMPT:
            continue
        for job in jobs_by_run.get(run["id"], ()):
            pools = {POOL_LABELS[label] for label in job["labels"] if label in POOL_LABELS}
            waited = now - parse_time(job["created_at"])
            if (
                job["status"] == "queued"
                and waited > MIN_QUEUED_S
                and any(not is_fresh(heartbeats.get(pool, ""), now) for pool in pools)
            ):
                picked.append(run["id"])
                break
    return picked[:MAX_RUNS_PER_TICK]


def gh_api(*args: str, method: str = "GET") -> Any:
    """Call the GitHub REST API through `gh`.

    Parameters:
        *args (str): Path (and `-f` style flags) after `gh api`.
        method (str): HTTP verb.

    Returns:
        Any: Decoded JSON, or None for an empty body.

    Raises:
        subprocess.CalledProcessError: `gh` exited non-zero.
    """
    done = subprocess.run([GH, "api", "--method", method, *args], check=True, capture_output=True, text=True)
    return json.loads(done.stdout) if done.stdout.strip() else None


def unfinished_runs(repo: str) -> list[dict[str, Any]]:
    """List queued and in-progress runs.

    Parameters:
        repo (str): `owner/name`.

    Returns:
        list[dict[str, Any]]: Run objects.
    """
    runs: list[dict[str, Any]] = []
    for status in ("queued", "in_progress"):
        runs += gh_api(f"repos/{repo}/actions/runs?status={status}&per_page=100")["workflow_runs"]
    return list({run["id"]: run for run in runs}.values())


def restart(repo: str, run_id: int) -> None:
    """Cancel a run, wait for it to finish, then rerun it from the start.

    Parameters:
        repo (str): `owner/name`.
        run_id (int): The run.

    Raises:
        TimeoutError: The run is still unfinished `CANCEL_WAIT_S` after a force-cancel.
    """
    gh_api(f"repos/{repo}/actions/runs/{run_id}/cancel", method="POST")
    deadline = time.monotonic() + CANCEL_WAIT_S
    forced = False
    while gh_api(f"repos/{repo}/actions/runs/{run_id}")["status"] != "completed":
        if time.monotonic() > deadline:
            if forced:
                raise TimeoutError(f"Run '{run_id}' did not finish after a force-cancel")
            gh_api(f"repos/{repo}/actions/runs/{run_id}/force-cancel", method="POST")
            forced = True
            deadline = time.monotonic() + CANCEL_WAIT_S
        time.sleep(POLL_S)
    gh_api(f"repos/{repo}/actions/runs/{run_id}/rerun", method="POST")


def main(argv: list[str] | None = None) -> int:
    """Find stranded runs and restart them.

    Parameters:
        argv (list[str] | None): Arguments, or `sys.argv` when omitted.

    Returns:
        int: 0 when every picked run restarted (or none was picked), 1 when any restart failed.
    """
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description="Re-route runs stranded on a dead self-hosted pool")
    parser.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", ""))
    parser.add_argument("--pool-heartbeat", action="append", default=[], metavar="POOL=VALUE")
    parser.add_argument("--dry-run", action="store_true", help="Report the runs, change nothing")
    args = parser.parse_args(argv)
    if args.repo.count("/") != 1:
        parser.error(f"--repo must be 'owner/name', got '{args.repo}'")
    heartbeats = dict(item.partition("=")[::2] for item in args.pool_heartbeat)
    runs = unfinished_runs(args.repo)
    jobs_by_run = {
        run["id"]: gh_api(f"repos/{args.repo}/actions/runs/{run['id']}/jobs?filter=latest&per_page=100")[
            "jobs"
        ]
        for run in runs
    }
    picked = stranded_runs(runs, jobs_by_run, heartbeats, time.time())
    LOGGER.info(f"Stranded runs: {picked}")
    failed = False
    for run_id in [] if args.dry_run else picked:
        try:
            restart(args.repo, run_id)
            LOGGER.info(f"Restarted run '{run_id}'")
        except (subprocess.CalledProcessError, TimeoutError) as e:
            LOGGER.error(f"Failed to restart run '{run_id}': {e}")
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
