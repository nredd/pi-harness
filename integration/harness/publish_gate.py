"""Standard-library-only gates for the write-privileged promotion job.

`attest-and-publish` holds `contents`/`attestations`/`id-token` write and installs no
dependencies, so everything it runs lives here and imports nothing outside the standard
library (and stays compatible with the runner's system Python).

References:
- https://docs.github.com/rest/git/refs#get-a-reference
- https://docs.github.com/rest/releases/releases#get-a-release-by-tag-name
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Literal


def release_state(existing: Path, rebuilt: Path) -> Literal["create", "resume"]:
    """Decide whether a snapshot release must be created or may be resumed.

    Parameters:
        existing (Path): the release's downloaded snapshot; absent when no release exists.
        rebuilt (Path): the snapshot rebuilt from the selected commit.

    Returns:
        Literal["create", "resume"]: `create` when no release asset exists, `resume` when it is byte-equal.

    Raises:
        ValueError: an existing snapshot differs from the rebuilt one.
    """
    if not existing.exists():
        return "create"
    if existing.read_bytes() != rebuilt.read_bytes():
        raise ValueError(
            "The existing release snapshot differs from the rebuilt one; refusing. "
            "Roll back to it or investigate"
        )
    return "resume"


def verify_tag_target(ref: object, source_sha: str) -> None:
    """Require the snapshot tag to point at the selected commit.

    Parameters:
        ref (object): `git/ref/tags/stack/<sha>` response.
        source_sha (str): selected commit.

    Raises:
        ValueError: the tag response is malformed or points elsewhere.
    """
    target = ref.get("object") if isinstance(ref, dict) else None
    tagged = target.get("sha") if isinstance(target, dict) else None
    if not isinstance(tagged, str):
        raise ValueError("Tag ref response has no `object.sha`")
    if tagged != source_sha:
        raise ValueError(f"Tag points at '{tagged}', not '{source_sha}'")


def _parser() -> argparse.ArgumentParser:
    """Build the subcommand parser.

    Returns:
        argparse.ArgumentParser: parser with `release-state` and `tag-target`.
    """
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    state = commands.add_parser("release-state", help="Print create or resume for the snapshot release")
    state.add_argument("--existing", type=Path, required=True)
    state.add_argument("--rebuilt", type=Path, required=True)
    tag = commands.add_parser("tag-target", help="Fail unless the snapshot tag points at the SHA")
    tag.add_argument("--ref", type=Path, required=True)
    tag.add_argument("--source-sha", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run one gate subcommand; refusals exit 1 with a one-line error.

    Parameters:
        argv (list[str] | None): arguments, or the process arguments.

    Returns:
        int: 0 on success, 1 on a failed gate.
    """
    args = _parser().parse_args(argv)
    try:
        if args.command == "release-state":
            sys.stdout.write(f"{release_state(args.existing, args.rebuilt)}\n")
        else:
            ref: Any = json.loads(args.ref.read_bytes())
            verify_tag_target(ref, args.source_sha)
    except (ValueError, OSError) as error:
        sys.stderr.write(f"FAILED: {error}\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
