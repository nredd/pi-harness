"""Give the required-check verdict for a fan-in cell's planned owned shards.

References:
- https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#needs-context
- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands
"""

from __future__ import annotations

import os
import sys


def main() -> int:
    """Check the fan-in's runner environment and write its verdict to stdout.

    Returns:
        int: Zero when all required producers succeeded, one otherwise.
    """
    cell = os.environ["CELL"]
    shards_result = os.environ.get("SHARDS_RESULT", "")
    if shards_result != "success":
        sys.stdout.write(
            f"::error title={cell} shards {shards_result}::The plan runs this cell, but its shard jobs "
            f"finished '{shards_result}'; see the 'owned shard' jobs\n"
        )
        return 1

    windows_required = os.environ.get("WINDOWS_REQUIRED", "")
    if windows_required not in {"true", "false"}:
        sys.stdout.write(f"::error title={cell} invalid plan::WINDOWS_REQUIRED must be true or false\n")
        return 1
    windows_result = os.environ.get("WINDOWS_RESULT", "")
    if windows_required == "true" and windows_result != "success":
        sys.stdout.write(
            f"::error title=Windows native producer {windows_result}::"
            "Native Windows x64 compiler, tests, reports and build scripts must succeed\n"
        )
        return 1

    sys.stdout.write(f"Every planned shard of {cell} succeeded\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
