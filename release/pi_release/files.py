"""Nonblocking regular-file reads shared by stack lookup and installation.

References:
- https://docs.python.org/3/library/os.html#os.open
"""

from __future__ import annotations

import os
import stat
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pathlib import Path


class NonRegularFileError(ValueError):
    """A read encountered a special file or a disallowed symlink."""


def read_regular(path: Path, *, follow: bool) -> str | None:
    """Read a regular file without blocking on a special-file replacement.

    Parameters:
        path (Path): file to read.
        follow (bool): allow a final symlink to a regular file.

    Returns:
        str | None: contents, or `None` when absent.

    Raises:
        NonRegularFileError: the entry or opened descriptor is not regular.
        OSError: opening or reading failed.
    """
    kind = entry_kind(path)
    if kind == "symlink" and follow:
        try:
            kind = mode_kind(path.stat().st_mode)
        except FileNotFoundError:
            return None
    if kind is None:
        return None
    accepted = "a regular file or a link to one" if follow else "a regular file"
    if kind != "file":
        raise NonRegularFileError(
            f"'{path}' is a {kind}; the installer only reads {accepted} there. "
            "Move it aside yourself, nothing changed"
        )
    flags = os.O_RDONLY | os.O_NONBLOCK | os.O_NOCTTY | (0 if follow else os.O_NOFOLLOW)
    with os.fdopen(os.open(path, flags)) as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise NonRegularFileError(
                f"'{path}' stopped being a regular file while it was read; the installer only reads "
                f"{accepted} there. Move it aside yourself, nothing changed"
            )
        return handle.read()


def read_regular_bytes(path: Path) -> bytes:
    """Read raw diagnostic bytes without following a final link or blocking on a FIFO.

    Parameters:
        path (Path): candidate file; parent policy belongs to the calling collector.

    Returns:
        bytes: unmodified contents of the opened regular file.

    Raises:
        NonRegularFileError: the entry or opened descriptor is not regular.
        OSError: the path disappears or opening/reading fails.
    """
    if entry_kind(path) != "file":
        raise NonRegularFileError("Diagnostic candidate is not a regular file")
    flags = os.O_RDONLY | os.O_NONBLOCK | os.O_NOCTTY | os.O_NOFOLLOW
    with os.fdopen(os.open(path, flags), "rb") as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise NonRegularFileError("Diagnostic candidate stopped being a regular file")
        return handle.read()


def entry_kind(path: Path) -> str | None:
    """Classify a path without following a final symlink.

    Parameters:
        path (Path): entry.

    Returns:
        str | None: the entry's kind, or `None` when absent.
    """
    try:
        return mode_kind(path.lstat().st_mode)
    except FileNotFoundError:
        return None


def mode_kind(mode: int) -> str:
    """Name the kind of entry a `stat` mode describes.

    Parameters:
        mode (int): `st_mode`.

    Returns:
        str: `symlink`, `directory`, `file`, `fifo`, `socket`, `device` or `other`.
    """
    kinds = (
        (stat.S_ISLNK, "symlink"),
        (stat.S_ISDIR, "directory"),
        (stat.S_ISREG, "file"),
        (stat.S_ISFIFO, "fifo"),
        (stat.S_ISSOCK, "socket"),
        (stat.S_ISCHR, "device"),
        (stat.S_ISBLK, "device"),
    )
    return next((name for test, name in kinds if test(mode)), "other")
