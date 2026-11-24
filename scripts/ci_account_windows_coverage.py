"""Stage the native Windows x64 coverage producer's reports, then account for them separately.

The Ubuntu owned fan-in downloads the `computer-use Rust (windows-x64)` artifact into
`$RUNNER_TEMP/windows-coverage`. Exactly one `windows-*` producer entry must be there. Its
`lcov.info`, `coverage.json` and `metadata.json` are copied to the computer-use native Windows
report directory, then `scripts/coverage_accounting.py --os win32` writes the separate summary.

This ports the `Account for Windows x64 coverage separately` step's Bash. Python owns only the
decisions: the `windows-*` glob (any entry type, including a dangling symlink, or the unmatched
literal pattern), the count check and its annotation, and each command's exit status. `mkdir -p`,
`cp` and `uv` are the same platform commands with the same argv, so their output and failure
semantics are unchanged.

References:
- https://github.com/nredd/pi-harness/issues/695
- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

COUNT_ERROR = b"::error::Expected exactly one Windows coverage producer directory\n"
REPORTS = (b"lcov.info", b"coverage.json", b"metadata.json")
DESTINATION = b"/packages/computer-use/coverage/native-windows"


def producers(reports: bytes) -> list[bytes]:
    """Emulate `set -- "$reports"/windows-*`.

    Bash's glob lists directory entries whatever their type and keeps the pattern itself when
    nothing matches, including when the directory cannot be read. `Path.glob` also lists every
    entry type case-sensitively on POSIX and skips an unreadable directory; only its pattern
    argument is a pattern, so the prefix stays literal. The prefix is kept byte for byte, not
    normalized. Order is irrelevant: only a single match is ever used.

    Parameters:
        reports (bytes): Download directory, matched literally.

    Returns:
        list[bytes]: Matching paths, or the unmatched literal pattern.
    """
    names = [os.fsencode(path.name) for path in Path(os.fsdecode(reports)).glob("windows-*")]
    return [reports + b"/" + name for name in names] or [reports + b"/windows-*"]


def accounting(reports: bytes) -> list[bytes]:
    """Return the step's `coverage_accounting.py` argv.

    Parameters:
        reports (bytes): Download directory passed as `--reports-root`.

    Returns:
        list[bytes]: The `uv run` command, with `$BASE` read like Bash (unset is empty).
    """
    return [
        b"uv",
        b"run",
        b"--locked",
        b"--project",
        b"tests/integration",
        b"python",
        b"scripts/coverage_accounting.py",
        b"--os",
        b"win32",
        b"--base",
        os.environb.get(b"BASE", b""),
        b"--reports-root",
        reports,
        b"--summary",
        b"coverage/windows-x64-summary.json",
    ]


def main() -> int:
    """Stage the one producer's reports and run the separate Windows accounting.

    Returns:
        int: Zero on success, one on a producer count other than one, otherwise the failing
        command's status (`mkdir`, `cp`, then `uv`).
    """
    reports = os.environb.get(b"RUNNER_TEMP", b"") + b"/windows-coverage"
    destination = reports + DESTINATION
    status = subprocess.run([b"mkdir", b"-p", destination], check=False).returncode
    if status:
        return status
    found = producers(reports)
    if len(found) != 1:
        sys.stdout.buffer.write(COUNT_ERROR)
        return 1
    copy = [b"cp", *(found[0] + b"/" + name for name in REPORTS), destination + b"/"]
    status = subprocess.run(copy, check=False).returncode
    if status:
        return status
    return subprocess.run(accounting(reports), check=False).returncode


if __name__ == "__main__":
    sys.exit(main())
