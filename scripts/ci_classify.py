"""Wire the CI classify job to the planner and publish its summary.

References:
- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands
- https://git-scm.com/docs/git-merge-base
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

import ci_paths


def classify() -> int:
    """Publish the plan for the current event, rejecting unfrozen dispatch inputs.

    Returns:
        int: Planner or ancestry-check exit status.
    """
    env = os.environ
    event = env["EVENT"]
    args = [
        "--event",
        event,
        "--github-output",
        env["GITHUB_OUTPUT"],
        "--pool-run-id",
        env.get("GITHUB_RUN_ID") or "0",
        "--pool-repository",
        env.get("GITHUB_REPOSITORY", ""),
        "--pool-attempt",
        env.get("GITHUB_RUN_ATTEMPT") or "1",
    ]
    for pool in ("linux", "macos"):
        args += ["--pool-heartbeat", f"pi-{pool}={env.get(f'PI_{pool.upper()}_HEARTBEAT', '')}"]
    if env.get("UNTRUSTED") or env.get("PI_POOLS_DISABLED"):
        args.append("--no-pools")
    if event != "workflow_dispatch":
        return ci_paths.main(
            [
                *args,
                "--base",
                env["BASE"],
                "--head",
                env["HEAD"],
                f"--pr-title={env.get('PR_TITLE', '')}",
                "--pr-number",
                env.get("PR_NUMBER") or "0",
            ]
        )
    sha = env["GITHUB_SHA"]
    if env["GITHUB_REF"] not in {"refs/heads/main", f"refs/heads/release-verification/{sha}"}:
        sys.stderr.write("Full verification requires main or an exact frozen candidate ref\n")
        return 1
    result = subprocess.run([ci_paths.GIT, "merge-base", "--is-ancestor", sha, "origin/main"], check=False)
    if result.returncode:
        return result.returncode
    return ci_paths.main([*args, "--full"])


def report() -> None:
    """Write the changed-path classification and benchmark disclosure to the runner."""
    env = os.environ
    docs, stack = env["DOCS_ONLY"], env["STACK_INPUTS"]
    macos_skip = (
        "macOS PR skip: macOS cells are not in the PR matrix.\n\n"
        if env["GITHUB_EVENT_NAME"] == "pull_request"
        else ""
    )
    sys.stdout.write(
        f"Changed-path classification: docs-only={docs} stack-inputs={stack}\n"
        "::notice title=bench not run::No quiet self-hosted runner yet; "
        "hosted runners cannot meet the bench admission policy\n"
    )
    with Path(env["GITHUB_STEP_SUMMARY"]).open("a", encoding="utf-8") as summary:
        summary.write(
            "### CI path classification\n\n"
            f"Docs-only: `{docs}`\n\nStack inputs: `{stack}`\n\n{macos_skip}"
            f"Changed files:\n```text\n{env['CHANGED_FILES']}\n```\n\n"
            "### bench: NOT RUN\n"
            "No quiet self-hosted runner exists yet (migration plan section 7). This is not a pass.\n"
        )


def main() -> int:
    """Run the requested classify job step.

    Returns:
        int: Process exit status.
    """
    parser = argparse.ArgumentParser(description="Plan CI jobs or report their path classification")
    parser.add_argument("step", choices=("plan", "report"))
    if parser.parse_args().step == "plan":
        return classify()
    report()
    return 0


if __name__ == "__main__":
    sys.exit(main())
