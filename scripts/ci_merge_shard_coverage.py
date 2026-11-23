"""Merge each downloaded owned shard's coverage reports back into the checkout.

The owned fan-in downloads every shard artifact into its own directory under
`$RUNNER_TEMP/shard-coverage`. A report path that two shards both produced would let one copy
silently replace the other, so that refuses before anything is copied. Each shard tree is then
copied over `$GITHUB_WORKSPACE` with the same `cp -R` the original Bash step ran.

Paths are sorted and printed as file system bytes. The hosted runner's `C.UTF-8` collation orders
by code point, which is UTF-8 byte order, so `sorted()` matches the step's `sort` and glob order.

References:
- https://github.com/nredd/pi-harness/issues/695
- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands
"""

from __future__ import annotations

import os
import stat
import subprocess
import sys
from collections import Counter
from pathlib import Path

DUPLICATE_ERROR = b"::error title=duplicate shard coverage::More than one shard produced: "


def report_lines() -> list[bytes]:
    """Emulate `find . -mindepth 2 -type f | cut -d/ -f3-` in the current directory.

    `find` lists regular files without following symlinks, and `cut` works on lines, so a newline
    inside a file name splits it the same way here. An unreadable subdirectory is skipped silently
    (`find` also printed a diagnostic on stderr; the pipeline status ignored it either way).

    Returns:
        list[bytes]: Each output line, unsorted.
    """
    listing = bytearray()
    top = Path()
    for directory, _, files in top.walk():
        if directory == top:
            continue
        for name in files:
            path = directory / name
            if stat.S_ISREG(path.lstat().st_mode):
                listing += b"./" + os.fsencode(path) + b"\n"
    lines = []
    for line in bytes(listing).split(b"\n")[:-1]:
        fields = line.split(b"/")
        # `cut` prints a line without the delimiter whole.
        lines.append(line if len(fields) == 1 else b"/".join(fields[2:]))
    return lines


def duplicates() -> bytes:
    """Emulate `$(... | sort | uniq -d)`.

    An empty line sorts first, so the trailing newlines command substitution drops can only be the
    final newline, which the join never adds.

    Returns:
        bytes: Repeated report paths in byte order, one per line, or empty.
    """
    counts = Counter(report_lines())
    return b"\n".join(sorted(line for line, count in counts.items() if count > 1))


def shards() -> list[bytes]:
    """Emulate the Bash `*/` glob: visible directories, including symlinks to them.

    Returns:
        list[bytes]: Shard names in byte order, or the unmatched literal pattern's `*`.
    """
    names = [
        os.fsencode(path.name) for path in Path().iterdir() if not path.name.startswith(".") and path.is_dir()
    ]
    return sorted(names) or [b"*"]


def main() -> int:
    """Refuse duplicate reports, then merge each shard into the workspace.

    Returns:
        int: Zero on success, one on a bad download directory or duplicate, otherwise `cp`'s status.
    """
    source = os.environb.get(b"RUNNER_TEMP", b"") + b"/shard-coverage"
    try:
        os.chdir(source)
    except OSError as error:
        sys.stderr.write(f"cd: {os.fsdecode(source)}: {error.strerror}\n")
        return 1
    found = duplicates()
    if found:
        sys.stdout.buffer.write(DUPLICATE_ERROR + found.replace(b"\n", b" ") + b"\n")
        return 1
    workspace = os.environb.get(b"GITHUB_WORKSPACE", b"") + b"/"
    for shard in shards():
        sys.stdout.buffer.write(b"Merging " + shard + b"\n")
        sys.stdout.buffer.flush()
        status = subprocess.run([b"cp", b"-R", shard + b"/.", workspace], check=False).returncode
        if status:
            return status
    return 0


if __name__ == "__main__":
    sys.exit(main())
