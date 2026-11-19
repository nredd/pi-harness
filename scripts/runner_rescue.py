"""Move CI cells stranded in a self-hosted pool queue back to hosted runners.

Only runs whose unfinished jobs are all unstarted may restart, with at least one stranded cell.
A fresh job snapshot is checked immediately before cancelling. GitHub has no atomic cancel-if-queued
API, so a cell can start between that read and cancellation. Running siblings observed in either
snapshot block rescue.
Retries exclude pools used by the previous attempt; the attempt cap also bounds old runs.
See `runner_pools.py` for admission and queue-window tradeoffs.

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

from runner_pools import (
    GH,
    PAGE_SIZE,
    POOLS,
    parse_heartbeats,
    pool_is_up,
)

LOGGER = logging.getLogger(__name__)

MIN_QUEUED_S = 300
LIVE_QUEUED_S = 600
# A run is rescued at most this many attempts in total, so a cell that cannot start anywhere cannot loop.
MAX_ATTEMPT = 3
# Per tick, so one outage cannot cancel the whole queue at once, and so a tick fits its job timeout.
MAX_RUNS_PER_TICK = 3
CANCEL_WAIT_S = 180
RERUN_TRIES = 3
RERUN_BACKOFF_S = 10
# The API's page size; a full page may hide more runs or jobs, which the next tick picks up.
POLL_S = 5
RERUN_EVENTS = frozenset({"pull_request", "push", "workflow_dispatch"})
POOL_LABELS = {pool.label: name for name, pool in POOLS.items()}
HOSTED_POOLS = {"ubuntu-24.04": "pi-linux", "xcode-27": "pi-macos"}


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
    *,
    hosted_unknown: bool = False,
) -> list[int]:
    """Pick the runs to cancel and rerun.

    Parameters:
        runs (Sequence[Mapping[str, Any]]): Unfinished workflow runs from the API.
        jobs_by_run (Mapping[int, Sequence[Mapping[str, Any]]]): Jobs of the candidate runs.
        heartbeats (Mapping[str, str]): Pool name -> heartbeat variable value; empty when pools are
            disabled, which makes every pool stale.
        now (float): Current epoch seconds.
        repo (str): `owner/name` of this repository.
        hosted_unknown (bool): Some run's jobs could not be read, so hosted load is unknown: no live-pool
            move is made (dead and draining pool moves still are).

    Returns:
        list[int]: Oldest eligible runs, capped at `MAX_RUNS_PER_TICK`. Every unfinished job must be
            unstarted, with at least one overdue pool cell. Never a hosted->pool move.
            Full job pages are refused because an unseen sibling could be running.
    """
    picked: list[int] = []
    for run in sorted(runs, key=lambda r: r["created_at"]):
        if not is_candidate(run, repo):
            continue
        jobs = jobs_by_run.get(run["id"], ())
        unfinished = [job for job in jobs if job["status"] != "completed"]
        if (
            len(jobs) >= PAGE_SIZE
            or not unfinished
            or not all(
                job["status"] in {"queued", "waiting", "pending", "requested"} and not job_started(job)
                for job in unfinished
            )
        ):
            continue
        # A queued hosted peer in ANOTHER run is evidence the destination has no immediate room. GitHub
        # does not expose hosted concurrency; this census is a conservative proxy. The run's own queued
        # siblings are what the restart would re-plan, so they do not count.
        hosted_busy = {
            label
            for other, other_jobs in jobs_by_run.items()
            if other != run["id"]
            for job in other_jobs
            if job["status"] == "queued"
            for label in job["labels"]
            if label in HOSTED_POOLS
        }
        if hosted_unknown:
            hosted_busy |= set(HOSTED_POOLS)
        if any(job_is_stranded(job, heartbeats, now, hosted_busy) for job in unfinished):
            picked.append(run["id"])
    return picked[:MAX_RUNS_PER_TICK]


def job_started(job: Mapping[str, Any]) -> bool:
    """Return whether a job has begun on a runner.

    Parameters:
        job (Mapping[str, Any]): API job object. A queued job reports `started_at` equal to
            `created_at`, so only the status and the runner assignment mean it started.

    Returns:
        bool: True for an in-progress or completed job, or one with a runner id or name.
    """
    return job["status"] in {"in_progress", "completed"} or bool(
        job.get("runner_id") or job.get("runner_name")
    )


def job_is_stranded(
    job: Mapping[str, Any],
    heartbeats: Mapping[str, str],
    now: float,
    hosted_busy: set[str] | None = None,
) -> bool:
    """Return whether a queued pool job has exceeded its takeover window.

    Only queued POOL cells are ever moved (to hosted). A hosted queue is never moved into a pool:
    planning at classify time is the balancing mechanism.

    Parameters:
        job (Mapping[str, Any]): API job object.
        heartbeats (Mapping[str, str]): Pool heartbeat values.
        now (float): Current epoch seconds.
        hosted_busy (set[str] | None): Hosted labels with queued jobs in OTHER runs.

    Returns:
        bool: True for an unstarted queued pool job past five minutes on a dead or draining pool, or past
            ten minutes on a live pool while no other run queues hosted jobs of that OS.
    """
    if job["status"] != "queued" or job_started(job):
        return False
    waited = now - parse_time(job["created_at"])
    busy = hosted_busy or set()
    pools = {POOL_LABELS[label] for label in job["labels"] if label in POOL_LABELS}
    return any(
        waited > MIN_QUEUED_S
        if not pool_is_up(heartbeats.get(pool, ""), now)
        else waited > LIVE_QUEUED_S and not any(HOSTED_POOLS.get(label) == pool for label in busy)
        for pool in pools
    )


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
    url = f"repos/{repo}/actions/runs/{run_id}/rerun"
    for attempt in range(1, RERUN_TRIES):
        try:
            gh_api(url, method="POST")
        except subprocess.CalledProcessError:
            time.sleep(RERUN_BACKOFF_S * attempt)
        else:
            return
    try:
        gh_api(url, method="POST")
    except subprocess.CalledProcessError:
        LOGGER.error(f"Run '{run_id}' is left cancelled: rerun failed {RERUN_TRIES} times")
        raise


def main(argv: list[str] | None = None) -> int:
    """Find stranded runs and restart them.

    Parameters:
        argv (list[str] | None): Arguments, or `sys.argv` when omitted.

    Returns:
        int: 0 when every picked run restarted (or none was picked) and every run's jobs were read, 1 when any
            restart failed or any run was skipped, so a total read failure is never a silent green.
    """
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(
        description="Move cells queued on a dead or backed-up self-hosted pool to hosted runners"
    )
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
        # Every unfinished run, candidate or not: its pooled jobs occupy the pools either way.
        runs = unfinished_runs(args.repo)
    except subprocess.CalledProcessError as e:
        LOGGER.error(f"Failed to read runs from the API: {e.stderr}")
        return 1
    jobs_by_run: dict[int, list[dict[str, Any]]] = {}
    skipped: list[int] = []
    for run in runs:
        try:
            jobs_by_run[run["id"]] = gh_api(
                f"repos/{args.repo}/actions/runs/{run['id']}/jobs?filter=latest&per_page={PAGE_SIZE}"
            )["jobs"]
        except subprocess.CalledProcessError as e:
            # One unreadable run (or a rate limit) must not stop the dead-pool rescue of the others.
            LOGGER.error(f"Skipping run '{run['id']}': its jobs could not be read: {e.stderr}")
            skipped.append(run["id"])
    unknown = bool(skipped)
    picked = stranded_runs(runs, jobs_by_run, heartbeats, time.time(), args.repo, hosted_unknown=unknown)
    LOGGER.info(f"Stranded runs: {picked}")
    failed = False
    for run_id in [] if args.dry_run else picked:
        try:
            # Re-read both attempt and jobs immediately before cancellation, not the tick's old snapshot.
            current = gh_api(f"repos/{args.repo}/actions/runs/{run_id}")
            fresh = gh_api(
                f"repos/{args.repo}/actions/runs/{run_id}/jobs?filter=latest&per_page={PAGE_SIZE}"
            )["jobs"]
            fresh_jobs = {**jobs_by_run, run_id: fresh}
            if not stranded_runs(
                [current], fresh_jobs, heartbeats, time.time(), args.repo, hosted_unknown=unknown
            ):
                LOGGER.info(f"Leaving run '{run_id}': no longer safe to restart")
                continue
            restart(args.repo, run_id)
            LOGGER.info(f"Restarted run '{run_id}'")
        except (subprocess.CalledProcessError, TimeoutError) as e:
            LOGGER.error(f"Failed to restart run '{run_id}': {e}")
            failed = True
    return 1 if failed or skipped else 0


if __name__ == "__main__":
    sys.exit(main())
