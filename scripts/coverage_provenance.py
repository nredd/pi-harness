"""Write producer-owned provenance beside existing CI coverage reports.

References:
    https://docs.github.com/en/actions/reference/workflows-and-actions/variables
    https://github.com/nredd/pi-harness/issues/1001
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

from coverage_report import Provenance, producer_job, read_record, validate_record

LOGGER = logging.getLogger(__name__)


def attest_shards(directory: Path, run: Provenance, cell: str) -> None:
    """Refuse to label merged reports as current if any input lacks matching provenance.

    Parameters:
        directory (Path): Download directory containing one directory per shard artifact.
        run (Provenance): The fan-in's independently known run and checkout identity.
        cell (str): The fan-in's declared coverage artifact name.
    Returns:
        None: Every downloaded shard agrees with the fan-in.
    Raises:
        ValueError: No shards were found, or a shard has missing or mismatched provenance.
        OSError: An input could not be read.
    """
    shards = sorted(directory.glob(f"{cell}-*/"))
    if not shards:
        raise ValueError("No downloaded coverage shards to verify")
    for shard in shards:
        shard_name = shard.name.removeprefix(f"{cell}-")
        record = read_record(shard / "coverage" / f"provenance-{shard_name}.json")
        validate_record(record, run.record(producer_job(cell, shard=True), shard.name))


def main(argv: list[str] | None = None) -> int:
    """Write a sidecar from the producer's runtime identity, or refuse to stamp the artifact.

    Parameters:
        argv (list[str] | None): CLI arguments, otherwise process arguments.
    Returns:
        int: Zero on success, one if provenance cannot be written.
    Raises:
        SystemExit: Required CLI arguments were missing.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--tested-sha", required=True)
    parser.add_argument("--cell", required=True)
    parser.add_argument("--shards", type=Path)
    args = parser.parse_args(argv)
    try:
        run = Provenance(
            os.environ["GITHUB_REPOSITORY"],
            os.environ.get("COVERAGE_PR_HEAD_SHA") or None,
            args.tested_sha,
            int(os.environ["GITHUB_RUN_ID"]),
            int(os.environ["GITHUB_RUN_ATTEMPT"]),
            os.environ["GITHUB_EVENT_NAME"],
            os.environ["GITHUB_WORKFLOW_REF"],
        )
        job = os.environ["GITHUB_JOB"]
        if args.shards is not None:
            attest_shards(args.shards, run, args.cell)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(run.record(job, args.cell)) + "\n", encoding="utf-8")
    except (KeyError, OSError, ValueError) as error:
        LOGGER.error(f"Cannot write coverage provenance: '{error}'")
        return 1
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    sys.exit(main())
