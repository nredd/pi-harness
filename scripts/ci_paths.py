"""Classify a Git diff for CI capacity controls.

References:
    https://git-scm.com/docs/git-diff
    https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/passing-information-between-jobs
"""

from __future__ import annotations

import argparse
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
TESTED_DOCUMENTATION = frozenset({"README.md", "packages/preset/README.md"})


@dataclass(frozen=True)
class ChangeClassification:
    """The paths changed by a comparison and their CI classification."""

    paths: tuple[str, ...]
    docs_only: bool


def changed_paths(repo: Path, base: str, head: str) -> tuple[str, ...]:
    """Return the tracked paths changed between two Git revisions.

    Parameters:
        repo: Existing Git working tree.
        base: Earlier Git revision.
        head: Later Git revision.

    Returns:
        Sorted, duplicate-free paths relative to `repo`.

    Raises:
        subprocess.CalledProcessError: Git cannot compare the revisions.
    """
    completed = subprocess.run(
        ["git", "-C", str(repo), "diff", "--name-only", "--diff-filter=ACDMRTUXB", base, head],
        check=True,
        capture_output=True,
        text=True,
    )
    return tuple(sorted(path for path in completed.stdout.splitlines() if path))


def is_documentation_path(path: str) -> bool:
    """Return whether one changed path is safe to bypass expensive CI.

    Parameters:
        path: Git-relative path with POSIX separators.

    Returns:
        Whether the path is documentation that no repository test reads as input.
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
    """Classify a real Git diff conservatively.

    Parameters:
        repo: Existing Git working tree.
        base: Earlier Git revision.
        head: Later Git revision.

    Returns:
        Changed paths and whether all are safe documentation paths.
    """
    paths = changed_paths(repo, base, head)
    return ChangeClassification(paths=paths, docs_only=bool(paths) and all(map(is_documentation_path, paths)))


def write_github_output(path: Path, result: ChangeClassification) -> None:
    """Append the classification to a GitHub Actions output file.

    Parameters:
        path: Existing GitHub Actions output file.
        result: Classification to publish.
    """
    delimiter = f"CI_PATHS_{uuid.uuid4().hex}"
    changed = "\n".join(result.paths)
    with path.open("a", encoding="utf-8") as output:
        output.write(f"docs_only={'true' if result.docs_only else 'false'}\n")
        output.write(f"changed_files<<{delimiter}\n{changed}\n{delimiter}\n")


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments.

    Returns:
        Parsed arguments.
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
        Process exit status.
    """
    args = parse_args()
    write_github_output(args.github_output, classify(args.repo.resolve(), args.base, args.head))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
