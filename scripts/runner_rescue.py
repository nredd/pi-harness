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

from runner_pools import POOLS, parse_heartbeats, pool_is_up

LOGGER = logging.getLogger(__name__)

GH = "/usr/bin/gh"
MIN_QUEUED_S = 300
# A run is rescued at most this many attempts in total, so a cell that cannot start anywhere cannot loop.
MAX_ATTEMPT = 3
# Per tick, so one outage cannot cancel the whole queue at once, and so a tick fits its job timeout.
MAX_RUNS_PER_TICK = 3
CANCEL_WAIT_S = 180
RERUN_TRIES = 3
RERUN_BACKOFF_S = 10
# The API's page size; a full page may hide more runs or jobs, which the next tick picks up.
PAGE_SIZE = 100
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


def is_candidate(run: Mapping[str, Any], repo: str) -> bool:
    """Return whether a run may be rescued at all.

    Parameters:
        run (Mapping[str, Any]): A workflow run from the API.
        repo (str): `owner/name` of this repository.

    Returns:
        bool: True for a rerunnable event with attempts left whose head is in this repo. A fork never
            legitimately gets a pool, so a fork run naming a pool label is left alone rather than rerun.
    """
    head = (run.get("head_repository") or {}).get("full_name")
    return run["event"] in RERUN_EVENTS and run.get("run_attempt", 1) < MAX_ATTEMPT and head == repo


def stranded_runs(
    runs: Sequence[Mapping[str, Any]],
    jobs_by_run: Mapping[int, Sequence[Mapping[str, Any]]],
    heartbeats: Mapping[str, str],
    now: float,
    repo: str,
) -> list[int]:
    """Pick the runs to cancel and rerun.

    Parameters:
        runs (Sequence[Mapping[str, Any]]): Unfinished workflow runs from the API.
        jobs_by_run (Mapping[int, Sequence[Mapping[str, Any]]]): Jobs of the candidate runs.
        heartbeats (Mapping[str, str]): Pool name -> heartbeat variable value; empty when pools are
            disabled, which makes every pool stale.
        now (float): Current epoch seconds.
        repo (str): `owner/name` of this repository.

    Returns:
        list[int]: Ids of candidate runs with a job queued past `MIN_QUEUED_S` on a pool label whose
            heartbeat is stale, oldest first, capped at `MAX_RUNS_PER_TICK`.
    """
    picked: list[int] = []
    for run in sorted(runs, key=lambda r: r["created_at"]):
        if not is_candidate(run, repo):
            continue
        for job in jobs_by_run.get(run["id"], ()):
            pools = {POOL_LABELS[label] for label in job["labels"] if label in POOL_LABELS}
            waited = now - parse_time(job["created_at"])
            if (
                job["status"] == "queued"
                and waited > MIN_QUEUED_S
                and any(not pool_is_up(heartbeats.get(pool, ""), now) for pool in pools)
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
        page = gh_api(f"repos/{repo}/actions/runs?status={status}&per_page={PAGE_SIZE}")["workflow_runs"]
        if len(page) == PAGE_SIZE:
            LOGGER.warning(f"Only the first {PAGE_SIZE} '{status}' runs were read")
        runs += page
    return list({run["id"]: run for run in runs}.values())


def restart(repo: str, run_id: int) -> None:
    """Cancel a run, wait for it to finish, then rerun it from the start.

    Parameters:
        repo (str): `owner/name`.
        run_id (int): The run.

    Raises:
        TimeoutError: The run is still unfinished `CANCEL_WAIT_S` after a force-cancel.
    """
    LOGGER.info(f"Restarting run '{run_id}': cancel, wait, rerun")
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
    rerun(repo, run_id)


def rerun(repo: str, run_id: int) -> None:
    """Rerun a finished run, retrying a transient API failure.

    A run left cancelled is never retried by anyone, so this is worth a few attempts.

    Parameters:
        repo (str): `owner/name`.
        run_id (int): The run.

    Raises:
        subprocess.CalledProcessError: Every attempt failed.
    """
    for attempt in range(1, RERUN_TRIES + 1):
        try:
            gh_api(f"repos/{repo}/actions/runs/{run_id}/rerun", method="POST")
        except subprocess.CalledProcessError:
            if attempt == RERUN_TRIES:
                LOGGER.error(f"Run '{run_id}' is left cancelled: rerun failed {RERUN_TRIES} times")
                raise
            time.sleep(RERUN_BACKOFF_S * attempt)
        else:
            return


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
    parser.add_argument(
        "--pools-disabled",
        action="store_true",
        help="The PI_POOLS_DISABLED kill switch is set: treat every pool as down",
    )
    parser.add_argument("--dry-run", action="store_true", help="Report the runs, change nothing")
    args = parser.parse_args(argv)
    if args.repo.count("/") != 1:
        parser.error(f"--repo must be 'owner/name', got '{args.repo}'")
    try:
        heartbeats = {} if args.pools_disabled else parse_heartbeats(args.pool_heartbeat)
    except ValueError as e:
        parser.error(str(e))
    try:
        runs = [run for run in unfinished_runs(args.repo) if is_candidate(run, args.repo)]
        jobs_by_run = {
            run["id"]: gh_api(
                f"repos/{args.repo}/actions/runs/{run['id']}/jobs?filter=latest&per_page={PAGE_SIZE}"
            )["jobs"]
            for run in runs
        }
    except subprocess.CalledProcessError as e:
        LOGGER.error(f"Failed to read runs from the API: {e.stderr}")
        return 1
    picked = stranded_runs(runs, jobs_by_run, heartbeats, time.time(), args.repo)
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
