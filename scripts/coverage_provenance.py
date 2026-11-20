"""Write producer-owned provenance beside existing CI coverage reports.

References:
    https://docs.github.com/en/actions/reference/workflows-and-actions/variables
    https://github.com/nredd/pi-harness/issues/1001
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import shutil
import subprocess
import sys
from fnmatch import fnmatchcase
from pathlib import Path

from coverage_provenance_record import (
    MAX_JSON_BYTES,
    SEMANTICS_FIELD,
    SHA,
    Provenance,
    decode_json,
    is_producer_job,
    producer_job_for_cell,
    read_record,
    validate_record,
)

LOGGER = logging.getLogger(__name__)
# Hash committed measurement inputs, not the measured source files or generated reports.
SEMANTICS_PATHS = (
    ".github/actions/*",
    ".github/workflows/ci.yml",
    "coverage/policy.json",
    "scripts/*",
    "forks/pi",
    "packages/*/scripts/*",
    "*/.cargo/*",
    ".cargo/*",
    "*/.swiftpm/*",
    ".swiftpm/*",
)
SEMANTICS_FILENAMES = (
    # CI setup actions, npm workspace builds, and the Makefile's owned gates.
    ".node-version",
    ".bun-version",
    ".python-version",
    ".npmrc",
    "Makefile",
    "*.mk",
    "package*.json",
    "*config*",  # Vitest, Istanbul/V8 overrides, TypeScript and native configuration.
    "vitest.*",  # Includes setup files used from a Vitest config.
    ".nycrc*",
    # pytest-cov in scripts/, release/ and tests/integration; also uv and pytest discovery.
    ".coveragerc",
    "pyproject.toml",
    "setup.cfg",
    "tox.ini",
    "pytest.ini",
    "uv.lock",
    "uv.toml",
    "conftest.py",
    # Native coverage scripts use Cargo/LLVM and Swift/Xcode settings.
    "Cargo.*",
    "build.rs",
    "rust-toolchain*",
    "Package.swift",
    "Package.resolved",
    "project.pbxproj",
    "*.xcconfig",
    "*.xcscheme",
    "*.xctestplan",
)


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
        job = producer_job_for_cell(cell, shard=True)
        validate_record(record, run.record(job, shard.name))


def checkout_sha() -> str:
    """Read the checked-out commit from the producer working directory.

    Parameters:
        None.
    Returns:
        str: Commit SHA reported by Git, to be validated by `Provenance`.
    Raises:
        FileNotFoundError: Git is unavailable.
        ValueError: Git failed to resolve `HEAD` or did not return a single commit SHA.
    """
    git = shutil.which("git")
    if git is None:
        raise FileNotFoundError("Cannot locate `git`")
    try:
        # Leave stderr on the job log so warnings do not contaminate the SHA.
        stdout = subprocess.check_output(
            [str(Path(git).resolve()), "rev-parse", "--verify", "HEAD"], text=True
        )
    except subprocess.CalledProcessError as error:
        raise ValueError(
            f"Cannot resolve checkout `HEAD`: Git exited with code {error.returncode}"
        ) from error
    sha = stdout.removesuffix("\n")
    if not SHA.fullmatch(sha):
        raise ValueError("Expected a single 40-character checkout SHA on Git stdout")
    return sha


def semantics_fingerprint(tested_sha: str) -> str:
    """Fingerprint the tested revision's instrumentation and toolchain inputs.

    Parameters:
        tested_sha (str): Validated checkout commit.
    Returns:
        str: Versioned schema's SHA-256 hex digest of Git tree entries.
    Raises:
        ValueError: Instrumentation inputs could not be enumerated.
        FileNotFoundError: Git is unavailable.
    """
    git = shutil.which("git")
    if git is None:
        raise FileNotFoundError("Cannot locate `git`")
    try:
        inputs = subprocess.check_output(
            [str(Path(git).resolve()), "ls-tree", "-r", "-z", tested_sha],
            timeout=30,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise ValueError("Cannot enumerate coverage instrumentation inputs") from error
    entries = [
        entry for entry in inputs.split(b"\0") if entry and instrumentation_path(entry.split(b"\t", 1)[1])
    ]
    if not entries:
        raise ValueError("Missing coverage instrumentation inputs")
    return hashlib.sha256(b"\0".join(entries)).hexdigest()


def instrumentation_path(raw: bytes) -> bool:
    """Select committed instrumentation and toolchain inputs, excluding fixture tests.

    Parameters:
        raw (bytes): Git tree path.
    Returns:
        bool: Whether the path participates in counter semantics.
    Raises:
        None.
    """
    path = os.fsdecode(raw)
    name = path.rsplit("/", 1)[-1]
    return not path.startswith("scripts/tests/") and (
        any(fnmatchcase(path, pattern) for pattern in SEMANTICS_PATHS)
        or any(fnmatchcase(name, pattern) for pattern in SEMANTICS_FILENAMES)
    )


def stamp_summary(path: Path, tested_sha: str) -> str:
    """Store the producer semantics in the accounting summary before writing the sidecar.

    Parameters:
        path (Path): Producer accounting summary.
        tested_sha (str): Validated checkout commit.
    Returns:
        str: Fingerprint to include in matching provenance.
    Raises:
        OSError: The summary could not be read or written.
        ValueError: The summary or instrumentation inputs were invalid.
    """
    with path.open("rb") as stream:
        summary = decode_json(stream.read(MAX_JSON_BYTES + 1))
    fingerprint = semantics_fingerprint(tested_sha)
    path.write_text(json.dumps(summary | {SEMANTICS_FIELD: fingerprint}) + "\n", encoding="utf-8")
    return fingerprint


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
    parser.add_argument("--cell", required=True)
    parser.add_argument("--shards", type=Path)
    parser.add_argument("--summary", type=Path)
    args = parser.parse_args(argv)
    try:
        args.output.unlink(missing_ok=True)
        run = Provenance(
            os.environ["GITHUB_REPOSITORY"],
            os.environ.get("COVERAGE_PR_HEAD_SHA") or None,
            checkout_sha(),
            int(os.environ["GITHUB_RUN_ID"]),
            int(os.environ["GITHUB_RUN_ATTEMPT"]),
            os.environ["GITHUB_EVENT_NAME"],
            os.environ["GITHUB_WORKFLOW_REF"],
        )
        job = os.environ["GITHUB_JOB"]
        if not is_producer_job(job):
            raise ValueError(f"Unknown coverage producer job: '{job}'")
        if args.shards is not None:
            attest_shards(args.shards, run, args.cell)
        record: dict[str, object] = dict(run.record(job, args.cell))
        if args.summary is not None:
            record[SEMANTICS_FIELD] = stamp_summary(args.summary, run.tested_sha)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(record) + "\n", encoding="utf-8")
    except (KeyError, OSError, ValueError) as error:
        LOGGER.error(f"Cannot write coverage provenance: '{error}'")
        return 1
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    sys.exit(main())
