"""Classify a Git diff for CI capacity controls.

References:
    https://git-scm.com/docs/git-diff
    https://git-scm.com/docs/git-rev-parse
    https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/passing-information-between-jobs
"""

from __future__ import annotations

import argparse
import logging
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path

LOGGER = logging.getLogger(__name__)

GIT = "/usr/bin/git"
REPO_ROOT = Path(__file__).resolve().parents[1]
TESTED_DOCUMENTATION = frozenset({"README.md", "packages/preset/README.md"})


class ClassificationError(RuntimeError):
    """A repository precondition or Git comparison failed."""


@dataclass(frozen=True)
class ChangeClassification:
    """The paths changed by a comparison and their CI classification.

    Parameters:
        paths (tuple[str, ...]): Changed paths relative to the repository root.
        docs_only (bool): Whether every changed path is safe documentation.
    """

    paths: tuple[str, ...]
    docs_only: bool


def run_git(repo: Path, *args: str) -> str:
    """Run Git in a repository and return standard output.

    Parameters:
        repo (Path): Existing repository directory.
        *args (str): Arguments after `git -C <repo>`.

    Returns:
        str: Captured Git standard output.

    Raises:
        ClassificationError: Git cannot start or exits unsuccessfully.
    """
    try:
        completed = subprocess.run([GIT, "-C", str(repo), *args], check=False, capture_output=True, text=True)
    except OSError as e:
        raise ClassificationError(f"Cannot run `git` in '{repo}': {e}") from e
    if completed.returncode != 0:
        raise ClassificationError(f"`git {' '.join(args)}` failed in '{repo}': {completed.stderr.strip()}")
    return completed.stdout


def repo_root(start: Path) -> Path:
    """Return the resolved top-level directory containing a repository path.

    Parameters:
        start (Path): Existing directory inside the repository.

    Returns:
        Path: Resolved repository top-level directory.

    Raises:
        ClassificationError: `start` is missing, not a directory, or outside a Git work tree.
    """
    if not start.is_dir():
        raise ClassificationError(f"Not a directory: '{start}'")
    return Path(run_git(start, "rev-parse", "--show-toplevel").strip()).resolve()


def changed_paths(repo: Path, base: str, head: str) -> tuple[str, ...]:
    """Return all tracked paths changed between two Git revisions.

    Parameters:
        repo (Path): Existing Git working tree.
        base (str): Earlier Git revision.
        head (str): Later Git revision.

    Returns:
        tuple[str, ...]: Sorted, duplicate-free paths relative to `repo`.

    Raises:
        ClassificationError: The repository or revisions cannot be compared, or a Gitlink changed.
    """
    root = repo_root(repo)
    output = run_git(root, "diff", "--raw", "--no-renames", "-z", "--diff-filter=ACDMRTUXB", base, head)
    fields = output.split("\0")
    if fields[-1]:
        raise ClassificationError("`git diff --raw -z` returned an unterminated record")
    entries = fields[:-1]
    if len(entries) % 2:
        raise ClassificationError("`git diff --raw -z` returned an incomplete record")

    paths: set[str] = set()
    for metadata, path in zip(entries[::2], entries[1::2], strict=True):
        parts = metadata.split()
        if len(parts) != 5 or not parts[0].startswith(":"):
            raise ClassificationError(f"`git diff --raw -z` returned malformed metadata: '{metadata}'")
        old_mode, new_mode = parts[0][1:], parts[1]
        if old_mode == "160000" or new_mode == "160000":
            raise ClassificationError(f"Gitlink changed at '{path}'")
        paths.add(path)
    return tuple(sorted(paths))


def is_documentation_path(path: str) -> bool:
    """Return whether one changed path is safe to bypass expensive CI.

    Parameters:
        path (str): Git-relative path with POSIX separators.

    Returns:
        bool: Whether the path is documentation that no repository test reads as input.
    """
    if path in TESTED_DOCUMENTATION:
        return False
    if path == "PLAN.md" or (path.startswith("docs/") and path.endswith(".md")):
        return True
    if "/" not in path and path.endswith(".md"):
        return True
    parts = path.split("/")
    return len(parts) == 3 and parts[0] == "packages" and parts[2] in {"README.md", "CHANGELOG.md"}


def classify(repo: Path, base: str, head: str) -> ChangeClassification:
    """Classify a real Git diff conservatively, failing closed on errors.

    Parameters:
        repo (Path): Existing Git working tree.
        base (str): Earlier Git revision.
        head (str): Later Git revision.

    Returns:
        ChangeClassification: Changed paths and whether all are safe documentation paths.
    """
    try:
        paths = changed_paths(repo, base, head)
    except ClassificationError as e:
        LOGGER.error(f"Failed to classify changed paths: {e}")
        return ChangeClassification(paths=(), docs_only=False)
    return ChangeClassification(paths=paths, docs_only=bool(paths) and all(map(is_documentation_path, paths)))


def write_github_output(path: Path, result: ChangeClassification) -> None:
    """Append the classification to a GitHub Actions output file.

    Parameters:
        path (Path): Existing GitHub Actions output file.
        result (ChangeClassification): Classification to publish.

    Returns:
        None: The function appends workflow output.
    """
    delimiter = f"CI_PATHS_{uuid.uuid4().hex}"
    changed = "\n".join(result.paths)
    with path.open("a", encoding="utf-8") as output:
        output.write(f"docs_only={'true' if result.docs_only else 'false'}\n")
        output.write(f"changed_files<<{delimiter}\n{changed}\n{delimiter}\n")


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments.

    Returns:
        argparse.Namespace: Parsed arguments.
    """
    parser = argparse.ArgumentParser(description="Classify changed paths for CI")
    parser.add_argument("--repo", type=Path, default=REPO_ROOT)
    parser.add_argument("--base", required=True)
    parser.add_argument("--head", required=True)
    parser.add_argument("--github-output", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    """Classify a diff and publish workflow outputs.

    Returns:
        int: Process exit status.
    """
    args = parse_args()
    write_github_output(args.github_output, classify(args.repo, args.base, args.head))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
