"""Initialize or update fork submodules after a dirty-checkout preflight.

Every gitlink recorded in the parent index is discovered (no pin list is duplicated here). Before
`git submodule update --init --recursive` runs, every *initialized* submodule, nested ones included,
is checked for tracked, staged, and untracked changes. Any dirt aborts the whole run before a single
fork is touched. Nothing is forced, cleaned, or discarded.

A clean fork whose HEAD differs from its gitlink is moved by the update, as `git submodule update`
always does. Unpublished commits on a detached HEAD are not detected; keep such work on a branch.

References:
    https://git-scm.com/docs/git-submodule
    https://git-scm.com/docs/git-status#_porcelain_format_version_1
"""

from __future__ import annotations

import argparse
import logging
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

LOGGER = logging.getLogger(__name__)

GIT = "/usr/bin/git"
GITLINK_MODE = "160000"
EXIT_OK = 0
EXIT_DIRTY = 1
EXIT_ERROR = 2
MAX_LISTED_ENTRIES = 20


class BootstrapError(RuntimeError):
    """A git invocation or repository precondition failed (not a dirty-state refusal)."""


@dataclass(frozen=True)
class Dirt:
    """Local state in a submodule checkout that an update could overwrite.

    Parameters:
        path (Path): Absolute path of the submodule checkout.
        entries (tuple[str, ...]): Porcelain status lines, or a single explanatory line.
    """

    path: Path
    entries: tuple[str, ...]


def _git(repo: Path, *args: str) -> str:
    """Run `git -C repo ...` and return stdout.

    Parameters:
        repo (Path): Directory to run in.
        *args (str): Git arguments.

    Returns:
        str: Captured stdout.

    Raises:
        BootstrapError: If git cannot run or exits non-zero.
    """
    cmd = [GIT, "-C", str(repo), *args]
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, check=False)
    except OSError as e:
        raise BootstrapError(f"Cannot run `git` for '{repo}': {e}") from e
    if done.returncode != 0:
        raise BootstrapError(f"`git {' '.join(args)}` failed in '{repo}': {done.stderr.strip()}")
    return done.stdout


def repo_root(start: Path) -> Path:
    """Return the top-level directory of the repository containing `start`.

    Parameters:
        start (Path): Any directory inside the repository.

    Returns:
        Path: Resolved top-level directory.

    Raises:
        BootstrapError: If `start` is not inside a git work tree.
    """
    if not start.is_dir():
        raise BootstrapError(f"Not a directory: '{start}'")
    return Path(_git(start, "rev-parse", "--show-toplevel").strip()).resolve()


def gitlink_paths(repo: Path) -> list[Path]:
    """List the gitlink (submodule) paths recorded in `repo`'s index.

    Parameters:
        repo (Path): Repository top-level.

    Returns:
        list[Path]: Absolute submodule paths, sorted.
    """
    out = _git(repo, "ls-files", "--stage", "-z")
    paths: list[Path] = []
    for record in out.split("\0"):
        meta, _, name = record.partition("\t")
        if meta.startswith(GITLINK_MODE):
            paths.append(repo / name)
    return sorted(paths)


def _is_initialized(path: Path) -> bool:
    """Return whether `path` is the root of its own checkout.

    Parameters:
        path (Path): Candidate submodule directory.

    Returns:
        bool: Whether the directory contains a `.git` entry.
    """
    return (path / ".git").exists()


def _status_entries(path: Path) -> tuple[str, ...]:
    """Read porcelain status, including untracked files and nested-submodule changes.

    Parameters:
        path (Path): Initialized submodule checkout.

    Returns:
        tuple[str, ...]: Status entries, with rename origins joined to their destination.

    Raises:
        BootstrapError: If git cannot inspect the checkout.
    """
    out = _git(path, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none")
    tokens = out.split("\0")
    entries: list[str] = []
    i = 0
    while i < len(tokens):
        token = tokens[i]
        i += 1
        if not token:
            continue
        # Renames and copies carry the origin path as a separate token.
        if token[0] in "RC" or token[1:2] in ("R", "C"):
            origin = tokens[i] if i < len(tokens) else ""
            i += 1
            token = f"{token} <- {origin}"
        entries.append(token)
    return tuple(entries)


def find_dirt(repo: Path) -> list[Dirt]:
    """Preflight every initialized submodule below `repo`, recursively.

    Parameters:
        repo (Path): Repository top-level (parent or an initialized submodule).

    Returns:
        list[Dirt]: One record per dirty checkout; empty when everything is clean.

    Raises:
        BootstrapError: If git status fails for any checkout.
    """
    found: list[Dirt] = []
    for path in gitlink_paths(repo):
        if path.is_symlink() or (path.exists() and not path.is_dir()):
            found.append(Dirt(path, ("submodule path is not a real directory",)))
        elif _is_initialized(path):
            entries = _status_entries(path)
            if entries:
                found.append(Dirt(path, entries))
            found.extend(find_dirt(path))
        elif path.exists() and any(path.iterdir()):
            found.append(Dirt(path, ("uninitialized submodule directory is not empty",)))
    return found


def _report(dirt: list[Dirt], root: Path) -> None:
    """Log bounded dirty-checkout details without changing any files.

    Parameters:
        dirt (list[Dirt]): Dirty checkouts found during preflight.
        root (Path): Parent checkout used to display relative paths.

    Returns:
        None: Details are emitted through the module logger.
    """
    LOGGER.error("Refusing to update: local changes would be at risk. Nothing was modified.")
    for item in dirt:
        LOGGER.error(f"- `{item.path.relative_to(root)}`")
        for entry in item.entries[:MAX_LISTED_ENTRIES]:
            LOGGER.error(f"    {entry}")
        if len(item.entries) > MAX_LISTED_ENTRIES:
            LOGGER.error(f"    ... {len(item.entries) - MAX_LISTED_ENTRIES} more")
    LOGGER.error("Commit, stash, or move the work out of the fork checkout, then rerun.")


def bootstrap(root: Path, *, check_only: bool = False) -> int:
    """Preflight all initialized submodules, then initialize/update them.

    Parameters:
        root (Path): Repository top-level.
        check_only (bool): Run the preflight only; never invoke `git submodule update`.

    Returns:
        int: `EXIT_OK` or `EXIT_DIRTY`.

    Raises:
        BootstrapError: If git fails.
    """
    links = gitlink_paths(root)
    if not links:
        LOGGER.info("No submodules recorded in the index; nothing to do.")
        return EXIT_OK
    dirt = find_dirt(root)
    if dirt:
        _report(dirt, root)
        return EXIT_DIRTY
    if check_only:
        LOGGER.info(f"Preflight clean for {len(links)} submodule(s); not updating (`--check`).")
        return EXIT_OK
    _git(root, "submodule", "update", "--init", "--recursive")
    LOGGER.info(f"Initialized/updated {len(links)} submodule(s) to the recorded gitlinks.")
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    """CLI entry point.

    Parameters:
        argv (list[str] | None): Arguments; defaults to `sys.argv[1:]`.

    Returns:
        int: Process exit code (0 ok, 1 dirty refusal, 2 error).
    """
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--repo", type=Path, default=Path.cwd(), help="Any directory in the parent repo.")
    parser.add_argument("--check", action="store_true", help="Preflight only; do not update.")
    opts = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)
    try:
        return bootstrap(repo_root(opts.repo), check_only=opts.check)
    except (BootstrapError, OSError) as e:
        LOGGER.error(f"bootstrap-forks failed: {e}")
        return EXIT_ERROR


if __name__ == "__main__":
    raise SystemExit(main())
