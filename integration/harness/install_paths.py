"""Descriptor-relative installer mutations on admitted POSIX directory trees.

References:
- https://docs.python.org/3/library/os.html#paths-relative-to-directory-descriptors
- https://docs.python.org/3/library/shutil.html#shutil.rmtree
"""

from __future__ import annotations

import os
import shutil
import stat
from contextlib import suppress
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pathlib import Path
    from types import TracebackType


RMTREE_SAFE = shutil.rmtree.avoids_symlink_attacks


class AnchoredStore:
    """Hold every ancestor from `/` to each accessed parent until the operation ends.

    Inputs are canonical absolute paths. Explicit symlinked roots must be resolved by the
    layout resolver first; a later symlink substitution is never followed. This constrains
    pathname redirection, not arbitrary code or file edits by the same uid.
    """

    def __init__(self) -> None:
        """Start with no open descriptors."""
        self.directories: dict[Path, int] = {}

    def __enter__(self) -> AnchoredStore:
        """Return the descriptor owner."""
        return self

    def __exit__(
        self, kind: type[BaseException] | None, error: BaseException | None, tb: TracebackType | None
    ) -> None:
        """Close all descriptors, including after a partial traversal failure."""
        for descriptor in reversed(self.directories.values()):
            os.close(descriptor)
        self.directories.clear()

    def directory(self, path: Path, *, create: bool = False) -> int:
        """Open a canonical directory one no-follow component at a time.

        Parameters:
            path (Path): absolute directory with no `..` components.
            create (bool): create missing directories relative to their held parents.

        Returns:
            int: borrowed directory descriptor, owned until context exit.

        Raises:
            ValueError: the path is not canonical and absolute.
            OSError: a component cannot be created or opened without following links.
        """
        if not path.is_absolute() or ".." in path.parts:
            raise ValueError(f"Directory '{path}' is not canonical and absolute")
        if path in self.directories:
            return self.directories[path]
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY
        if path == path.parent:
            descriptor = os.open(path, flags)
        else:
            parent = self.directory(path.parent, create=create)
            if create:
                with suppress(FileExistsError):
                    os.mkdir(path.name, dir_fd=parent)
            descriptor = os.open(path.name, flags, dir_fd=parent)
        self.directories[path] = descriptor
        return descriptor

    def check(self) -> None:
        """Refuse a namespace no longer naming any of the held directory identities.

        Raises:
            OSError: an ancestor disappeared, changed identity or is no longer a real directory.
        """
        for path, descriptor in self.directories.items():
            actual = path.lstat()
            opened = os.fstat(descriptor)
            if not stat.S_ISDIR(actual.st_mode) or (actual.st_dev, actual.st_ino) != (
                opened.st_dev,
                opened.st_ino,
            ):
                raise OSError(f"Install directory '{path}' changed during the operation")

    def info(self, path: Path) -> os.stat_result | None:
        """Stat a leaf through its held parent, preserving absence.

        Parameters:
            path (Path): entry to inspect without following its final link.

        Returns:
            os.stat_result | None: entry metadata, or absence.

        Raises:
            OSError: the parent cannot be opened or the entry cannot be inspected.
        """
        try:
            return os.stat(path.name, dir_fd=self.directory(path.parent), follow_symlinks=False)
        except FileNotFoundError:
            return None

    def rename(self, source: Path, target: Path) -> None:
        """Replace a leaf using held source AND destination parents.

        Parameters:
            source (Path): entry to move.
            target (Path): replacement destination.

        Raises:
            OSError: either parent cannot be anchored or the rename fails.
        """
        source_fd = self.directory(source.parent)
        target_fd = self.directory(target.parent, create=True)
        os.replace(source.name, target.name, src_dir_fd=source_fd, dst_dir_fd=target_fd)

    def discard(self, path: Path) -> None:
        """Release directories deliberately removed by this owner, retaining other anchors.

        Parameters:
            path (Path): removed subtree.
        """
        for directory in reversed(tuple(self.directories)):
            if directory == path or directory.is_relative_to(path):
                os.close(self.directories.pop(directory))

    def remove(self, path: Path) -> None:
        """Remove a leaf without following substituted ancestors or directory symlinks.

        Parameters:
            path (Path): file, symlink or tree to remove if present.

        Raises:
            OSError: safe tree removal is unavailable or an entry cannot be removed.
        """
        info = self.info(path)
        if info is None:
            return
        parent = self.directory(path.parent)
        if stat.S_ISDIR(info.st_mode):
            if not RMTREE_SAFE:
                raise OSError("Descriptor-relative tree removal is unavailable")
            shutil.rmtree(path.name, dir_fd=parent)
        else:
            os.unlink(path.name, dir_fd=parent)
        self.discard(path)
