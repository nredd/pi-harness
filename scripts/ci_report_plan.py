"""Report one cell's classified CI decision without re-planning it.

If checkout fails, this script never writes the initial `run=false`. The
composite fails, and consumers only run for `steps.plan.outputs.run == 'true'`,
so the empty output cannot authorize work. Reasons are literal text, including
`-n`, `-e` and `-E`, which Bash `echo` treated as options.

References:
- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def append(path_var: str, text: str) -> None:
    """Append text to a runner file, opening it only when needed.

    Parameters:
        path_var (str): Environment variable naming the runner file.
        text (str): Text to append.
    """
    with Path(os.environ[path_var]).open("a", encoding="utf-8") as file:
        file.write(text)


def report(
    *,
    cell: str,
    classify_result: str,
    run: str,
    scenarios: str,
    gates: str,
    reason: str,
    blocked: str,
    changed_files: str,
) -> int:
    """Report the given decision, failing closed if it cannot authorize the cell.

    Parameters:
        cell (str): Required check name.
        classify_result (str): Classifier job outcome.
        run (str): Stringified per-cell run decision.
        scenarios (str): Stringified scenario decision.
        gates (str): Space-separated Make targets.
        reason (str): Decision explanation, if any.
        blocked (str): Stringified block decision.
        changed_files (str): Newline-delimited paths to include for a skipped cell.

    Returns:
        int: Zero for a valid decision, one for a failed or blocked plan.
    """
    # A required check that skips on classifier failure counts as a pass.
    append("GITHUB_OUTPUT", "run=false\n")
    if classify_result != "success":
        sys.stdout.write(
            f"::error title={cell} has no plan::classify finished with '{classify_result}', "
            "so no cell may report a pass\n"
        )
        append("GITHUB_STEP_SUMMARY", f"### {cell}: no plan (classify {classify_result})\n")
        return 1
    if blocked == "true":
        sys.stdout.write(f"::error title={cell} blocked::{reason}\n")
        append("GITHUB_STEP_SUMMARY", f"### {cell}: blocked\n{reason}\n")
        return 1
    if run not in {"true", "false"}:
        sys.stdout.write(
            f"::error title={cell} has no plan::classify published no run decision for this cell\n"
        )
        return 1

    append("GITHUB_OUTPUT", f"run={run}\nscenarios={scenarios}\ngates={gates}\n")
    if not reason:
        sys.stdout.write(f"{cell} will run\n")
        return 0
    title = f"{cell} scenarios NOT RUN" if run == "true" else f"{cell} NOT RUN"
    sys.stdout.write(f"::notice title={title}::{reason}\n")
    summary = f"### {title}\n{reason} This is not a pass.\n"
    if run == "false":
        summary += f"```text\n{changed_files}\n```\n"
    append("GITHUB_STEP_SUMMARY", summary)
    return 0


def main() -> int:
    """Parse the composite action's arguments and report its cell decision.

    Returns:
        int: Reporter exit status.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    for name in (
        "cell",
        "classify-result",
        "run",
        "scenarios",
        "gates",
        "reason",
        "blocked",
        "changed-files",
    ):
        parser.add_argument(f"--{name}", required=True)
    return report(**vars(parser.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
