"""Gate merges without mistaking superseded CI matrix placeholders for current jobs.

References:
    https://docs.github.com/en/rest/actions/workflow-runs
    https://docs.github.com/en/rest/actions/workflow-jobs
    https://docs.github.com/en/rest/checks/runs
    https://cli.github.com/manual/gh_pr_checks
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any
from urllib.parse import quote

LOGGER = logging.getLogger(__name__)
ACTIONS_APP = 15368
MATRIX = {
    "owned (${{ matrix.os }})": {f"owned ({os})" for os in ("ubuntu-24.04", "macos-14")},
    "contracts (${{ matrix.os }})": {f"contracts ({os})" for os in ("ubuntu-24.04", "macos-14")},
    "stack (${{ matrix.os }}, ${{ matrix.stack }})": {
        f"stack ({os}, {stack})" for os in ("ubuntu-24.04", "macos-14") for stack in ("personal", "local")
    },
}
EXPECTED_MATRIX = set.union(*MATRIX.values())


class CheckError(RuntimeError):
    """CI evidence is missing, ambiguous, pending, or unsuccessful."""


class GitHub:
    """Read GitHub evidence using the authenticated CLI, never mutate GitHub."""

    def __init__(self) -> None:
        """Resolve the CLI once to an absolute executable path."""
        binary = shutil.which("gh")
        if binary is None:
            raise CheckError("Cannot locate `gh`")
        self.binary = str(Path(binary).resolve())

    def command(self, *args: str) -> Any:
        """Decode one JSON CLI response, failing closed on CLI errors.

        Parameters:
            *args (str): Read-only CLI arguments.

        Returns:
            Any: Decoded GitHub JSON.

        Raises:
            CheckError: Execution, HTTP or JSON decoding failed.
        """
        try:
            result = subprocess.run([self.binary, *args], capture_output=True, text=True, check=False)
        except OSError as e:
            raise CheckError(f"Cannot execute `gh`: {e}") from e
        # `gh pr checks` returns 8 for pending checks; their states are still JSON.
        if result.returncode != 0 and not (args[:2] == ("pr", "checks") and result.returncode == 8):
            raise CheckError(f"`gh {' '.join(args)}` failed: {result.stderr.strip()}")
        try:
            return json.loads(result.stdout)
        except ValueError as e:
            raise CheckError(f"Invalid JSON from `gh {' '.join(args)}`: {e}") from e

    def api(self, endpoint: str) -> Any:
        """Read one REST object without a method override or request body.

        Parameters:
            endpoint (str): Repository-relative REST endpoint.

        Returns:
            Any: Decoded REST response.
        """
        return self.command("api", endpoint)

    def pages(self, endpoint: str, key: str) -> list[dict[str, Any]]:
        """Read every REST page before selecting evidence, independent of order.

        Parameters:
            endpoint (str): Repository-relative REST collection endpoint.
            key (str): Response property containing records.

        Returns:
            list[dict[str, Any]]: Records from all pages.
        """
        separator = "&" if "?" in endpoint else "?"
        pages = self.command("api", "--paginate", "--slurp", f"{endpoint}{separator}per_page=100")
        return [item for page in pages for item in (page[key] if key else page)]


def run_context(run: dict[str, Any]) -> tuple[Any, ...]:
    """Identify workflow, event and complete PR head/base context, not timestamps.

    Parameters:
        run (dict[str, Any]): Captured workflow execution.

    Returns:
        tuple[Any, ...]: Context identity including associated PR repository identities.

    Raises:
        CheckError: The execution has ambiguous or absent PR association.
    """
    prs = run["pull_requests"]
    if len(prs) != 1:
        raise CheckError("Supersession requires exactly one associated PR")
    pr = prs[0]
    return (
        run["workflow_id"],
        run["path"],
        run["event"],
        run["head_sha"],
        pr["number"],
        pr["head"],
        pr["base"],
    )


def run_order(run: dict[str, Any]) -> tuple[int, int]:
    """Order executions by workflow run number, then rerun attempt.

    Parameters:
        run (dict[str, Any]): Captured workflow execution.

    Returns:
        tuple[int, int]: Monotonic workflow execution order.
    """
    return int(run["run_number"]), int(run["run_attempt"])


def superseded(
    gh: GitHub,
    repo: str,
    pr: dict[str, Any],
    check: dict[str, Any],
    runs: list[dict[str, Any]],
) -> None:
    """Prove one zero-step cancelled CI placeholder has a complete green successor.

    Parameters:
        gh (GitHub): Read-only evidence client.
        repo (str): Owner/repository identifier.
        pr (dict[str, Any]): Current REST PR head/base identity.
        check (dict[str, Any]): Cancelled check reported by the CLI.
        runs (list[dict[str, Any]]): All executions reported for the reviewed SHA.

    Raises:
        CheckError: Any identity, context, freshness or matrix evidence is missing.
    """
    match = re.fullmatch(
        rf"https://github.com/{re.escape(repo)}/actions/runs/(\d+)/job/(\d+)",
        check["link"],
    )
    if repo != "nredd/pi-harness" or check["name"] not in MATRIX or match is None:
        raise CheckError(f"{check['state']} {check['name']}")
    run_id, job_id = match.groups()
    prefix = f"repos/{repo}"
    job = gh.api(f"{prefix}/actions/jobs/{job_id}")
    old = gh.api(f"{prefix}/actions/runs/{run_id}/attempts/{job['run_attempt']}")
    if (
        job["name"] != check["name"]
        or job["run_id"] != int(run_id)
        or job["head_sha"] != pr["head"]["sha"]
        or job["status"] != "completed"
        or job["conclusion"] != "cancelled"
        or job["steps"] != []
        or old["status"] != "completed"
        or old["conclusion"] != "cancelled"
        or old["path"] != ".github/workflows/ci.yml"
        or old["event"] != "pull_request"
    ):
        raise CheckError("Cancelled check is not an unexecuted CI matrix placeholder")
    # Do not fall back to an older green run when a later execution is bad or changes context.
    candidates = [r for r in runs if r["workflow_id"] == old["workflow_id"] and r["event"] == old["event"]]
    if not candidates:
        raise CheckError("No successor workflow execution")
    new = max(candidates, key=run_order)
    if (
        run_order(new) <= run_order(old)
        or run_context(new) != run_context(old)
        or new["head_sha"] != pr["head"]["sha"]
        or new["status"] != "completed"
        or new["conclusion"] != "success"
    ):
        raise CheckError("Latest workflow execution is not a later successful same-context replacement")
    association = new["pull_requests"][0]
    if (
        association["number"] != pr["number"]
        or any(
            association[side][field] != pr[side][field]
            for side in ("head", "base")
            for field in ("sha", "ref")
        )
        or any(association[side]["repo"]["id"] != pr[side]["repo"]["id"] for side in ("head", "base"))
    ):
        raise CheckError("Replacement does not match the current PR head/base")
    for run in (old, new):
        suite = gh.api(f"{prefix}/check-suites/{run['check_suite_id']}")
        if suite["app"]["id"] != ACTIONS_APP or suite["head_sha"] != pr["head"]["sha"]:
            raise CheckError("Replacement check-suite SHA/app mismatch")
    jobs = gh.pages(f"{prefix}/actions/runs/{new['id']}/attempts/{new['run_attempt']}/jobs", "jobs")
    green = {
        j["name"]
        for j in jobs
        if j["status"] == "completed"
        and j["conclusion"] == "success"
        and j["head_sha"] == pr["head"]["sha"]
        and j["run_id"] == new["id"]
        and j["run_attempt"] == new["run_attempt"]
    }
    if not green >= EXPECTED_MATRIX or any(
        j["status"] != "completed" or j["conclusion"] not in ("success", "skipped") for j in jobs
    ):
        raise CheckError("Replacement lacks complete successful CI matrix coverage")
    LOGGER.info(f"Superseded `{check['name']}`: run {old['id']} -> {new['id']}")


def require_contexts(
    gh: GitHub,
    repo: str,
    pr: dict[str, Any],
    reported: list[dict[str, Any]],
) -> None:
    """Require every configured ruleset check with its bound app on this SHA.

    Parameters:
        gh (GitHub): Read-only evidence client.
        repo (str): Owner/repository identifier.
        pr (dict[str, Any]): Current REST PR head/base identity.
        reported (list[dict[str, Any]]): CLI-selected current checks, including job URLs.

    Raises:
        CheckError: A required context is absent, ambiguous or unsuccessful.
    """
    prefix = f"repos/{repo}"
    rules = gh.api(f"{prefix}/rules/branches/{quote(pr['base']['ref'], safe='')}")
    required = [
        c
        for rule in rules
        if rule["type"] == "required_status_checks"
        for c in rule["parameters"]["required_status_checks"]
    ]
    if not required:
        raise CheckError("No required check rules found for pi-harness")
    checks = gh.pages(f"{prefix}/commits/{pr['head']['sha']}/check-runs?filter=latest", "check_runs")
    for requirement in required:
        matches = [
            c
            for c in checks
            if c["name"] == requirement["context"]
            and c["app"]["id"] == requirement["integration_id"]
            and any(r["name"] == c["name"] and r["link"] == c["html_url"] for r in reported)
        ]
        if len(matches) != 1 or any(
            c["head_sha"] != pr["head"]["sha"] or c["status"] != "completed" or c["conclusion"] != "success"
            for c in matches
        ):
            raise CheckError(f"Required context is not successful: {requirement['context']}")


def gate(gh: GitHub, repo: str, number: str, sha: str) -> None:
    """Preserve the all-checks gate, allowing only proved superseded placeholders.

    Parameters:
        gh (GitHub): Read-only evidence client.
        repo (str): Owner/repository identifier.
        number (str): PR number.
        sha (str): Exact reviewed commit SHA.

    Raises:
        CheckError: Head drift or unsuccessful CI prevents merging.
    """
    pr = gh.api(f"repos/{repo}/pulls/{number}")
    if pr["head"]["sha"] != sha:
        raise CheckError(f"PR head {pr['head']['sha']} != reviewed {sha}")
    checks = gh.command("pr", "checks", number, "--repo", repo, "--json", "name,state,link")
    if not checks:
        raise CheckError("No checks reported")
    if repo == "nredd/pi-harness":
        require_contexts(gh, repo, pr, checks)
    bad = [c for c in checks if c["state"] not in ("SUCCESS", "SKIPPED")]
    runs = gh.pages(f"repos/{repo}/actions/runs?head_sha={sha}", "workflow_runs") if bad else []
    for check in bad:
        if check["state"] != "CANCELLED":
            raise CheckError(f"{check['state']} {check['name']}")
        superseded(gh, repo, pr, check, runs)


def main() -> int:
    """Run the read-only gate; emit actionable errors and no success receipt.

    Returns:
        int: Zero on complete green evidence, one on refusal.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pr")
    parser.add_argument("sha")
    parser.add_argument("repo")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    try:
        gate(GitHub(), args.repo, args.pr, args.sha)
    except (CheckError, KeyError, TypeError, ValueError) as e:
        LOGGER.error(f"CI not green on {args.sha}: {e}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
