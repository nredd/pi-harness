"""Report JSON Lines sweep verdicts; never remove, prune, fetch or update refs.

References:
- https://git-scm.com/docs/git-worktree
- https://git-scm.com/docs/gitrepository-layout
- https://cli.github.com/manual/gh_pr_list
"""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import time
from contextlib import ExitStack
from contextvars import ContextVar
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit

GIT_LOCATIONS = ("/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git")
BIN_DIRS = (
    Path("/usr/bin"),
    Path("/opt/homebrew/bin"),
    Path("/usr/local/bin"),
    Path("/usr/sbin"),
)
CHILD_ENV = ("HOME", "LANG", "LC_ALL", "TMPDIR")
GH_ENV = (
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_HOST",
    "GH_CONFIG_DIR",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
)
CHILD_OVERRIDES = {
    "git": {
        "GIT_NO_LAZY_FETCH": "1",
        "GIT_ALLOW_PROTOCOL": "",
        "GIT_NO_REPLACE_OBJECTS": "1",
        "GIT_TERMINAL_PROMPT": "0",
    },
    "gh": {"GH_PROMPT_DISABLED": "1"},
    "lsof": {},
}
GIT_BINARY: ContextVar[Path | None] = ContextVar("GIT_BINARY", default=None)
TIMEOUT = 30
MAX_TREE_ENTRIES = 100_000
QUIET_SECONDS = 3600
UNKNOWN_SCOPE = "cannot establish a complete external borrower scope"
STATUS_NOT_COLLECTED = "status not collected: `git status` was not run"
CHUNK = 1 << 20
HASHES = {b"sha1": ("sha1", 40), b"sha256": ("sha256", 64)}
STAGE = re.compile(rb"(100644|100755|120000) ([a-f0-9]+) 0\t(.+)", re.DOTALL)
PR_FIELDS = "headRefName,headRepository,headRepositoryOwner,headRefOid,state,url"
OPERATIONS = (
    "rebase-apply",
    "rebase-merge",
    "sequencer",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
)
SOURCE = re.compile(
    r"^(?:[a-z+]+://)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/]([^/]+)/([^/]+?)(?:\.git)?/?$"
)
GIT_VERSION = re.compile(
    rb"git version ([0-9]{1,3})\.([0-9]{1,3})\.[0-9]+(?: \([^\r\n]+\))?\n?"
)
EOL_HEADER = re.compile(rb"i/([^ ]*) +w/([^ ]*) +attr/[^\t]*")
OID = re.compile(rb"(?:[a-f0-9]{40}|[a-f0-9]{64})")
REFLOG = re.compile(
    rb"([a-f0-9]+) ([a-f0-9]+) [^\n\0<>]+ <[^\n\0<>]*> [0-9]+ [+-][0-9]{4}(?:\t[^\n\0]*)?"
)
REPO_ENV = {
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_NAMESPACE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_SHALLOW_FILE",
    "GIT_CONFIG",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_REPLACE_REF_BASE",
    "GIT_GRAFT_FILE",
    "GIT_QUARANTINE_PATH",
}


class KeepError(Exception):
    """A failed or unverifiable safety check."""


SCAN_ERRORS = (
    KeepError,
    OSError,
    ValueError,
    KeyError,
    TypeError,
    AttributeError,
    RuntimeError,
)


@lru_cache(maxsize=16)
def binary(locations: tuple[str, ...], label: str) -> Path:
    """Resolve an executable from explicit absolute candidate locations.

    Parameters:
        locations: tuple[str, ...], Candidate executable paths.
        label: str, Name to use in diagnostics.
    Returns:
        Path: Resolved executable
    Raises:
        KeepError: No trusted executable is available.
    """
    for location in locations:
        path = Path(location)
        if path.is_absolute() and path.is_file() and os.access(path, os.X_OK):
            return path.resolve(strict=True)
    raise KeepError(f"missing trusted executable for `{label}`")


def out(
    executable: Path,
    label: str,
    *args: str,
    tool: str = "lsof",
    data: bytes = b"",
    missing: int = 0,
    silent: bool = False,
) -> bytes:
    """Run a bounded command; diagnostics or unexpected exit codes require keeping.

    Parameters:
        executable: Path, Absolute executable path.
        label: str, Name to use in diagnostics.
        args: str, Positional command arguments.
        tool: str, Environment policy for Git, gh or lsof.
        data: bytes, Raw evidence or input bytes.
        missing: int, Additional accepted exit status.
        silent: bool, Require empty standard output.
    Returns:
        bytes: Command stdout
    Raises:
        KeepError: The command times out, fails or emits diagnostics.
    """
    path_entries = os.environ.get("PATH", "").split(os.pathsep)
    child_path = [entry for entry in path_entries if Path(entry).is_absolute()]
    allowed = CHILD_ENV + (GH_ENV if tool == "gh" else ())
    env = {key: os.environ[key] for key in allowed if key in os.environ}
    env["PATH"] = os.pathsep.join(child_path or map(str, BIN_DIRS))
    env.update(CHILD_OVERRIDES[tool])
    try:
        done = subprocess.run(
            [str(executable), *args],
            input=data,
            capture_output=True,
            check=False,
            timeout=TIMEOUT,
            env=env,
        )
    except subprocess.TimeoutExpired as exc:
        raise KeepError(f"`{label}` timed out") from exc
    if done.stderr or done.returncode not in (0, missing) or (silent and done.stdout):
        raise KeepError(
            f"`{label}` failed ({done.returncode}): {done.stderr!r}"
            + (f" {done.stdout!r}" if silent else "")
        )
    return done.stdout


def git(
    path: Path, *args: str, data: bytes = b"", missing: int = 0, silent: bool = False
) -> bytes:
    """Run local Git reads without optional writes or configured helpers.

    The fixed builtins read refs, config, worktree inventory and the raw index;
    prune is dry-run only. Attribute and EOL queries do not run filters, the
    reflog is read directly, and remote get-url only resolves config. The only diff
    is a cached `diff-index` of object IDs. No status, worktree diff, textconv,
    signature checks or submodule commands run. Transport (even
    for a missing promisor object) and paging are disabled; Git never needs
    SSH, credentials or askpass. Only the explicit gh PR queries use the network.

    Parameters:
        path: Path, Candidate checkout.
        args: str, Positional command arguments.
        data: bytes, Raw evidence or input bytes.
        missing: int, Additional accepted exit status.
        silent: bool, Require empty standard output.
    Returns:
        bytes: Git stdout
    Raises:
        KeepError: Git cannot establish the requested evidence.
    """
    # The version gate makes this a boolean, not a hook command.
    return out(
        GIT_BINARY.get() or binary(GIT_LOCATIONS, "git"),
        "git " + " ".join(args[:2]),
        "--no-optional-locks",
        "--no-pager",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-C",
        str(path),
        *args,
        tool="git",
        data=data,
        missing=missing,
        silent=silent,
    )


def present(path: Path) -> bool:
    """Count dangling symlinks as present; only ENOENT proves absence.

    Parameters:
        path: Path, Path being checked or reported.
    Returns:
        bool: Whether the directory entry exists
    Raises:
        KeepError: Absence cannot be established.
    """
    try:
        path.lstat()
    except OSError as exc:
        if exc.errno == errno.ENOENT:
            return False
        raise KeepError(f"cannot stat {str(path)!r}: {exc}") from exc
    return True


def inside(path: Path, root: Path) -> bool:
    """Test containment of already resolved paths.

    Parameters:
        path: Path, Path being checked or reported.
        root: Path, Resolved containment root.
    Returns:
        bool: Whether the path lies within the root
    Raises:
        None.
    """
    return path == root or root in path.parents


def config(path: Path, key: str, *opts: str) -> str:
    """Read a single effective setting, allowing Git's missing-key status.

    Parameters:
        path: Path, Path being checked or reported.
        key: str, Configuration key.
        opts: str, Additional scan or command options.
    Returns:
        str: Effective configuration value, or empty if absent
    Raises:
        KeepError: Git cannot read the value.
    """
    value = git(path, "config", *opts, "--get", key, missing=1).decode()
    return value[:-1]


def inventory(repo: Path) -> list[tuple[Path, list[bytes]]]:
    """Read NUL-delimited worktree metadata without interpreting path characters.

    Parameters:
        repo: Path, Repository owning the worktrees.
    Returns:
        list[tuple[Path, list[bytes]]]: Validated worktree paths and records
    Raises:
        KeepError: Git cannot produce a valid inventory.
    """
    # Git reports the storage format from extensions.objectFormat, defaulting to SHA-1.
    _, oid_width = object_format(repo)
    return parse_inventory(
        git(repo, "worktree", "list", "--porcelain", "-z"), oid_width
    )


def object_format(path: Path) -> tuple[str, int]:
    """Read the repository object hash algorithm and its hexadecimal width.

    Parameters:
        path: Path, Repository or checkout.
    Returns:
        tuple[str, int]: `hashlib` algorithm name and object ID width
    Raises:
        KeepError: Git cannot report the storage format.
        KeyError: The storage format is not supported.
    """
    return HASHES[git(path, "rev-parse", "--show-object-format").strip()]


def parse_inventory(data: bytes, oid_width: int) -> list[tuple[Path, list[bytes]]]:
    """Validate every record before allowing any candidate.

    Parameters:
        data: bytes, Raw evidence or input bytes.
        oid_width: int, Hexadecimal width of a storage object ID.
    Returns:
        list[tuple[Path, list[bytes]]]: Validated worktree paths and records
    Raises:
        KeepError: A record is incomplete, duplicate or malformed.
    """
    if not data.endswith(b"\0\0"):
        raise KeepError("incomplete worktree inventory")
    records = []
    seen = set()
    for record in data[:-2].split(b"\0\0"):
        location, *fields = record.split(b"\0")
        path = Path(os.fsdecode(location[9:]))
        if (
            not location.startswith(b"worktree ")
            or not path.is_absolute()
            or path in seen
        ):
            raise KeepError("invalid worktree inventory path")
        validate_fields(fields, oid_width)
        seen.add(path)
        records.append((path, fields))
    return records


def validate_fields(fields: list[bytes], oid_width: int) -> None:
    """Require documented porcelain fields in their published order.

    Parameters:
        fields: list[bytes], Porcelain fields for one record.
        oid_width: int, Hexadecimal width of a storage object ID.
    Returns:
        None.
    Raises:
        KeepError: The evidence is unsafe or incomplete.
    """
    core = fields[:1] if fields[:1] == [b"bare"] else fields[:2]
    if core != [b"bare"] and (
        len(core) != 2
        or not core[0].startswith(b"HEAD ")
        or not OID.fullmatch(core[0][5:])
        or len(core[0][5:]) != oid_width
        or not (
            core[1] == b"detached"
            or (core[1].startswith(b"branch refs/heads/") and len(core[1]) > 18)
        )
    ):
        raise KeepError("invalid worktree inventory identity")
    if any(byte in core[-1] for byte in (b"\n", b"\r", b"\0")):
        raise KeepError("invalid worktree inventory ref-name separator")
    try:
        core[-1].decode("utf-8")
    except UnicodeDecodeError as exc:
        raise KeepError("invalid worktree inventory branch encoding") from exc
    tags = [field.partition(b" ")[0] for field in fields[len(core) :]]
    if tags not in ([], [b"locked"], [b"prunable"], [b"locked", b"prunable"]):
        raise KeepError("unknown or duplicate worktree inventory field")


def check_admin(
    repo: Path, common: Path, records: list[tuple[Path, list[bytes]]]
) -> None:
    """Keep globally when pruning could orphan an admin dir or Git reports prune output.

    Parameters:
        repo: Path, Repository owning the worktrees.
        common: Path, Common Git metadata directory.
        records: list[tuple[Path, list[bytes]]], Original worktree inventory.
    Returns:
        None.
    Raises:
        KeepError: The evidence is unsafe or incomplete.
    """
    for path, fields in records:
        if any(
            field == b"prunable" or field.startswith(b"prunable ") for field in fields
        ):
            raise KeepError(f"Git reports {str(path)!r} prunable")
    root = common / "worktrees"
    if present(root):
        for admin in sorted(root.iterdir()):
            gitdir = os.fsdecode((admin / "gitdir").read_bytes().rstrip(b"\n"))
            if not gitdir:
                raise KeepError(f"admin dir {str(admin)!r} has an empty gitdir")
            dotgit = admin / gitdir
            target = dotgit.read_bytes().rstrip(b"\n")
            if (
                not target.startswith(b"gitdir: ")
                or (dotgit.parent / os.fsdecode(target[8:])).resolve()
                != admin.resolve()
            ):
                raise KeepError(f"admin dir {str(admin)!r} has no matching `.git` file")
    git(repo, "worktree", "prune", "--dry-run", "--verbose", silent=True)


def check_activity(
    path: Path, admin: Path, holds: set[Path], now: float, lsof: Path
) -> None:
    """Hold known owned work, active process cwd paths and recently touched worktrees.

    Parameters:
        path: Path, Candidate checkout.
        admin: Path, Candidate metadata directory.
        holds: set[Path], Known ownership and retention holds.
        now: float, Scan start time in epoch seconds.
        lsof: Path, Absolute process snapshot command.
    Returns:
        None.
    Raises:
        KeepError: The evidence is unsafe or incomplete.
    """
    if path in holds:
        raise KeepError("recorded owner or retained claimed directory")
    if inside(Path.cwd().resolve(), path):
        raise KeepError("current directory is inside worktree")
    cwd_fields = out(lsof, "lsof cwd", "-d", "cwd", "-F0n").split(b"\0")
    cwd_paths = [
        field[1:]
        for item in cwd_fields
        if (field := item.lstrip(b"\n")).startswith(b"n/")
    ]
    if not cwd_paths:
        raise KeepError("no process cwd evidence")
    if any(inside(Path(os.fsdecode(cwd)).resolve(), path) for cwd in cwd_paths):
        raise KeepError("a process has its cwd inside")
    for marker in (path, admin / "HEAD", admin / "index", admin / "logs" / "HEAD"):
        if present(marker) and marker.stat().st_mtime >= now - QUIET_SECONDS:
            raise KeepError("recent activity (less than one hour of quiet)")


def gitlinks(path: Path) -> list[Path]:
    """Locate gitlinks even if the superproject config ignores submodule status.

    Parameters:
        path: Path, Path being checked or reported.
    Returns:
        list[Path].
    Raises:
        KeepError: The evidence is unsafe or incomplete.
    """
    return [
        path / os.fsdecode(record.split(b"\t", 1)[1])
        for record in git(path, "ls-files", "--stage", "-z").split(b"\0")
        if record.startswith(b"160000 ")
    ]


def check_status(path: Path, admin: Path) -> None:
    """Collect index and untracked-path evidence without refreshing tracked files.

    Parameters:
        path: Path, Path being checked or reported.
        admin: Path, Candidate metadata directory.
    Returns:
        None.
    Raises:
        KeepError: The evidence is unsafe or incomplete.
    """
    if present(admin / "modules"):
        raise KeepError("retained submodule gitdir")
    # Even a clean submodule can have unpublished refs; status could run its filters.
    modules = gitlinks(path)
    if modules:
        raise KeepError(f"registered submodule: {modules!r}")
    check_nested(path)
    # Omit status: attributes or driver configuration can change after any preflight.
    # Without exclude rules, ls-files reports ignored as well as other untracked paths.
    untracked = git(path, "ls-files", "--others", "-z")
    if untracked:
        raise KeepError(f"untracked or ignored paths: {untracked!r}")
    check_staged(path)
    # ls-files --eol classifies raw index blobs and worktree bytes; it does not convert them.
    check_eol(git(path, "ls-files", "--eol", "-z"))
    flags = [
        entry
        for entry in git(path, "ls-files", "-v", "-z").split(b"\0")
        if entry[:1].islower() or entry[:2] == b"S "
    ]
    if flags:
        raise KeepError(f"index flags hide paths: {flags!r}")
    for key in ("core.sparseCheckout", "core.ignoreStat"):
        if config(path, key, "--type=bool") == "true":
            raise KeepError(f"`{key}` is enabled")
    if config(path, "core.filemode", "--type=bool") == "false":
        raise KeepError(
            "`core.filemode` is disabled; executable-bit changes may be hidden"
        )
    check_content(path)


def check_content(path: Path) -> None:
    """Hash tracked worktree entries raw and compare them with their index blobs.

    Object IDs are computed in process from unfollowed directory descriptors,
    `lstat`, `readlink` and raw reads, so no clean filter, textconv or stat cache
    (`core.trustctime`) is consulted. Unmerged, gitlink or other unexpected index
    entries keep. The scan stops at the first entry that keeps.

    Parameters:
        path: Path, Resolved candidate checkout.
    Returns:
        None.
    Raises:
        KeepError: An entry is unsupported, changed during the scan, or its raw
            content or mode differs.
        OSError: A tracked entry cannot be read.
    """
    algorithm, width = object_format(path)
    records = git(path, "ls-files", "--stage", "-z").split(b"\0")
    if records[-1]:
        raise KeepError("incomplete index inventory")
    for record in records[:-1]:
        match = STAGE.fullmatch(record)
        if match is None or len(match[2]) != width:
            raise KeepError(f"unsupported index entry: {record!r}")
        if blob(path, match[3], algorithm) != (match[1], match[2].decode()):
            raise KeepError(f"tracked content differs from index: {match[3]!r}")


def entry_mode(info: os.stat_result) -> bytes:
    """Map a stat result to the index mode Git would record for it.

    Parameters:
        info: os.stat_result, Unfollowed or open-file stat result.
    Returns:
        bytes: Git mode, or `unsupported` for any other file type
    Raises:
        None.
    """
    if stat.S_ISLNK(info.st_mode):
        return b"120000"
    if stat.S_ISREG(info.st_mode):
        return b"100755" if info.st_mode & stat.S_IXUSR else b"100644"
    return b"unsupported"


def identity(info: os.stat_result) -> tuple[int, int]:
    """Return the device and inode that name one filesystem object.

    Parameters:
        info: os.stat_result, Stat result.
    Returns:
        tuple[int, int]: Device and inode
    Raises:
        None.
    """
    return info.st_dev, info.st_ino


def blob(root: Path, name: bytes, algorithm: str) -> tuple[bytes, str]:
    """Hash one worktree entry as a Git blob through unfollowed parent descriptors.

    Every parent component is opened with `O_DIRECTORY | O_NOFOLLOW` relative
    to the previous one and the leaf is read relative to the last. After hashing,
    each component must still name the descriptor that was walked.

    Parameters:
        root: Path, Resolved candidate checkout.
        name: bytes, Index path relative to the checkout.
        algorithm: str, Repository object hash algorithm.
    Returns:
        tuple[bytes, str]: Git mode and raw blob object ID
    Raises:
        KeepError: A component is unsafe, or the entry changed while hashed.
        OSError: The entry cannot be read without following a symlink.
    """
    *parents, leaf = name.split(b"/")
    if any(part in (b"", b".", b"..") for part in (*parents, leaf)):
        raise KeepError(f"unsupported index path: {name!r}")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    with ExitStack() as stack:
        root_fd = os.open(root, flags)
        stack.callback(os.close, root_fd)
        walked = [(bytes(root), -1, root_fd)]
        try:
            for part in parents:
                parent_fd = walked[-1][2]
                descriptor = os.open(part, flags, dir_fd=parent_fd)
                stack.callback(os.close, descriptor)
                walked.append((part, parent_fd, descriptor))
        except OSError as exc:
            raise KeepError(
                f"cannot open tracked parent without following links: {name!r}"
            ) from exc
        result = leaf_blob(walked[-1][2], leaf, algorithm)
        for part, parent, descriptor in reversed(walked):
            current = os.stat(
                part, dir_fd=None if parent < 0 else parent, follow_symlinks=False
            )
            if identity(current) != identity(os.fstat(descriptor)):
                raise KeepError(f"tracked parent changed during hash: {name!r}")
        return result


def leaf_blob(directory: int, leaf: bytes, algorithm: str) -> tuple[bytes, str]:
    """Hash one entry relative to a verified directory descriptor.

    Parameters:
        directory: int, Descriptor of the entry's walked parent.
        leaf: bytes, Final path component.
        algorithm: str, Repository object hash algorithm.
    Returns:
        tuple[bytes, str]: Git mode and raw blob object ID
    Raises:
        KeepError: The opened entry is not regular, or it changed while hashed.
        OSError: The entry cannot be read without following a symlink.
    """
    initial = os.stat(leaf, dir_fd=directory, follow_symlinks=False)
    mode = entry_mode(initial)
    if mode == b"120000":
        link = os.readlink(leaf, dir_fd=directory)
        digest = hashlib.new(algorithm, b"blob %d\0%s" % (len(link), link)).hexdigest()
        current = os.stat(leaf, dir_fd=directory, follow_symlinks=False)
        if stamp(initial) != stamp(current):
            raise KeepError(f"tracked entry changed during hash: {leaf!r}")
        return mode, digest
    if mode == b"unsupported":
        return mode, ""
    # Never block on a FIFO or follow a symlink swapped in after the stat.
    descriptor = os.open(
        leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory
    )
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise KeepError(f"tracked entry is not a regular file: {leaf!r}")
        digest = hashlib.new(algorithm, b"blob %d\0" % before.st_size)
        size = 0
        while chunk := os.read(descriptor, CHUNK):
            size += len(chunk)
            digest.update(chunk)
        after = os.fstat(descriptor)
        result = digest.hexdigest()
        current = os.stat(leaf, dir_fd=directory, follow_symlinks=False)
        if (
            size != before.st_size
            or stamp(before) != stamp(after)
            or stamp(before) != stamp(current)
        ):
            raise KeepError(f"tracked entry changed during hash: {leaf!r}")
        return entry_mode(before), result
    finally:
        os.close(descriptor)


def stamp(info: os.stat_result) -> tuple[int, ...]:
    """Return the fields that change when an open file is rewritten.

    Parameters:
        info: os.stat_result, Open-file stat result.
    Returns:
        tuple[int, ...]: Device, inode, mode, size, mtime and ctime in nanoseconds
    Raises:
        None.
    """
    return (
        *identity(info),
        info.st_mode,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )


def check_staged(path: Path) -> None:
    """Hold if any index entry, including intent-to-add, differs from HEAD.

    The plumbing cached comparison reads only tree and index object IDs; it never
    reads worktree files or blob content, so no filter, textconv or external diff runs.

    Parameters:
        path: Path, Candidate checkout.
    Returns:
        None.
    Raises:
        KeepError: The index differs from HEAD or Git cannot compare them.
    """
    if git(path, "diff-index", "--cached", "--name-only", "-z", "HEAD", "--"):
        raise KeepError("staged changes: index differs from HEAD")


def check_eol(data: bytes) -> None:
    """Hold if raw index and worktree line-ending classifications differ.

    Parameters:
        data: bytes, NUL-delimited Git line-ending inventory.
    Returns:
        None.
    Raises:
        KeepError: A record is malformed or its classifications disagree.
    """
    records = data.split(b"\0")
    if records[-1]:
        raise KeepError("incomplete line-ending inventory")
    for record in records[:-1]:
        header, _, name = record.partition(b"\t")
        match = EOL_HEADER.fullmatch(header)
        if match is None or not name:
            raise KeepError("malformed line-ending inventory")
        if match[1] != match[2]:
            raise KeepError(f"index and worktree line endings differ: {name!r}")


def check_nested(path: Path) -> None:
    """Bound a no-symlink walk independently of Git's status traversal.

    Parameters:
        path: Path, Path being checked or reported.
    Returns:
        None.
    Raises:
        KeepError: The evidence is unsafe or incomplete.
    """
    pending = [path]
    entries = 0
    deadline = time.monotonic() + TIMEOUT
    while pending:
        directory = pending.pop()
        with os.scandir(directory) as children:
            for entry in children:
                entries += 1
                if entries > MAX_TREE_ENTRIES or time.monotonic() > deadline:
                    raise KeepError("incomplete nested repository scan")
                if directory != path and entry.name.lower() == ".git":
                    raise KeepError(f"nested Git metadata: {entry.path!r}")
                if entry.name.lower() != ".git" and entry.is_dir(follow_symlinks=False):
                    pending.append(Path(entry.path))


def check_borrowed(
    path: Path,
    admin: Path,
    common: Path,
    records: list[tuple[Path, list[bytes]]],
    borrower_gitdirs: tuple[Path, ...] = (),
) -> None:
    """Inspect registered checkouts and module stores for paths into the candidate.

    Parameters:
        path: Path, Candidate checkout.
        admin: Path, Candidate metadata directory.
        common: Path, Common Git metadata directory.
        records: list[tuple[Path, list[bytes]]], Original worktree inventory.
        borrower_gitdirs: tuple[Path, ...], External metadata roots from a closed fixture scope.
    Returns:
        None.
    Raises:
        KeepError: The evidence is unsafe or incomplete.
    """
    roots = [common, common / "worktrees", *borrower_gitdirs]
    others = [
        other
        for other, fields in records
        if b"bare" not in fields and other.resolve() != path
    ]
    seen = set()
    while others:
        other = others.pop().resolve(strict=True)
        if inside(other, path):
            raise KeepError(f"another checkout is inside the candidate: {str(other)!r}")
        if other in seen:
            continue
        seen.add(other)
        other_admin = Path(
            os.fsdecode(git(other, "rev-parse", "--absolute-git-dir").rstrip(b"\n"))
        ).resolve(strict=True)
        if inside(other_admin, admin) or inside(other_admin, path):
            raise KeepError(f"another checkout uses gitdir {str(other_admin)!r}")
        roots.append(other_admin)
        others.extend(
            submodule for submodule in gitlinks(other) if present(submodule / ".git")
        )

    check_stores(path, admin, roots)


def fail(error: OSError) -> None:
    """Never interpret an incomplete filesystem walk as proof.

    Parameters:
        error: OSError, Directory traversal failure.
    Returns:
        None.
    Raises:
        OSError: The original filesystem error.
    """
    raise error


def check_stores(path: Path, admin: Path, roots: list[Path]) -> None:
    """Verify the known Git metadata roots, without following filesystem aliases.

    Parameters:
        path: Path, Path being checked or reported.
        admin: Path, Candidate metadata directory.
        roots: list[Path], Metadata roots to scan.
    Returns:
        None.
    Raises:
        KeepError: The evidence is unsafe or incomplete.
    """
    for root in dict.fromkeys(roots):
        for directory, dirs, names in os.walk(root, onerror=fail):
            current = Path(directory)
            # Only Git metadata directories are relevant below a recognized gitdir.
            if current.name == "objects":
                dirs[:] = [name for name in dirs if name == "info"]
            elif "HEAD" in names:
                dirs[:] = [name for name in dirs if name in {"objects", "modules"}]
            if any((current / name).is_symlink() for name in dirs):
                raise KeepError(
                    f"cannot verify symlinked Git metadata under {str(current)!r}"
                )
            if {"objects", "HEAD", "config"}.issubset(
                set(dirs) | set(names)
            ) and inside(current.resolve(), admin):
                target = config(
                    path, "core.worktree", "--file", str(current / "config")
                )
                if target and not inside((current / target).resolve(), path):
                    raise KeepError(f"another checkout uses gitdir {str(current)!r}")
            alternates = current / "alternates"
            if (
                current.parts[-2:] == ("objects", "info")
                and "alternates" in names
                and not inside(current.resolve(), admin)
            ):
                for line in alternates.read_bytes().split(b"\n"):
                    if line:
                        target_path = (current.parent / os.fsdecode(line)).resolve()
                        if inside(target_path, admin) or inside(target_path, path):
                            raise KeepError(
                                f"another checkout borrows objects via {str(alternates)!r}"
                            )


def check_history(path: Path, admin: Path, oid_width: int) -> None:
    """Protect worktree-local refs, operations, reflog-only commits and raw filtered files.

    Parameters:
        path: Path, Path being checked or reported.
        admin: Path, Candidate metadata directory.
        oid_width: int, Hexadecimal object ID width in this repository.
    Returns:
        None.
    Raises:
        KeepError: The evidence is unsafe or incomplete.
    """
    local_refs = git(
        path,
        "for-each-ref",
        "--format=%(refname)",
        "refs/worktree",
        "refs/bisect",
        "refs/rewritten",
        "refs/stash",
    )
    if local_refs:
        raise KeepError(f"worktree-local refs or stash: {local_refs!r}")
    for name in OPERATIONS:
        if present(admin / name):
            raise KeepError(f"in-progress operation `{name}`")
    reflog = reflog_oids((admin / "logs" / "HEAD").read_bytes(), oid_width)
    missing = sorted(reflog.difference(git(path, "rev-list", "--all").splitlines()))
    if missing:
        raise KeepError(f"HEAD reflog commits outside refs: {missing!r}")
    attrs = git(
        path, "check-attr", "-z", "--stdin", "-a", data=git(path, "ls-files", "-z")
    )
    check_attributes(attrs)
    if git(
        path, "config", "--null", "--get", "core.autocrlf", missing=1
    ).lower() not in (b"", b"false\0"):
        raise KeepError("conversion config: core.autocrlf")
    for key in ("core.eol", "core.safecrlf"):
        if git(path, "config", "--null", "--get", key, missing=1):
            raise KeepError(f"conversion config: {key}")


def reflog_oids(data: bytes, oid_width: int) -> set[bytes]:
    """Read both old and new object IDs without Git dropping malformed records.

    Parameters:
        data: bytes, Raw evidence or input bytes.
        oid_width: int, Hexadecimal object ID width in this repository.
    Returns:
        set[bytes]: Nonzero old and new object IDs
    Raises:
        KeepError: The log is incomplete or malformed.
    """
    if not data:
        raise KeepError("empty HEAD reflog")
    if not data.endswith(b"\n"):
        raise KeepError("incomplete HEAD reflog")
    try:
        data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise KeepError("non-UTF-8 HEAD reflog") from exc
    oids = set()
    for record in data[:-1].split(b"\n"):
        match = REFLOG.fullmatch(record)
        if match is None:
            raise KeepError("malformed HEAD reflog record")
        for oid in match.groups():
            if len(oid) != oid_width:
                raise KeepError("malformed HEAD reflog OID")
            if oid.strip(b"0"):
                oids.add(oid)
    if not oids:
        raise KeepError("no HEAD reflog commit evidence")
    return oids


def check_attributes(attrs: bytes) -> None:
    """Reject invalid NUL-delimited attribute records or any filter attribute.

    Parameters:
        attrs: bytes, NUL-delimited attribute triples.
    Returns:
        None.
    Raises:
        KeepError: The evidence is unsafe or incomplete.
    """
    fields = attrs.split(b"\0")
    if fields[-1] or (len(fields) - 1) % 3:
        raise KeepError("malformed attribute scan")
    filters = zip(fields[0:-1:3], fields[1::3], fields[2::3])
    filtered = [(name, value) for name, attr, value in filters if attr == b"filter"]
    if filtered:
        raise KeepError(f"filter attributes on tracked paths: {filtered!r}")
    conversions = {b"text", b"eol", b"crlf", b"ident", b"working-tree-encoding"}
    if any(attr in conversions for attr in fields[1::3]):
        raise KeepError("built-in conversion attributes on tracked paths")


def check_remote(path: Path, branch: str, base: str, gh: Path) -> str:
    """Require exact merged PR identity without probing the upstream transport.

    Parameters:
        path: Path, Path being checked or reported.
        branch: str, Checked-out branch name.
        base: str, GitHub repository to query.
        gh: Path, Absolute GitHub evidence command.
    Returns:
        str: Description of remote proof
    Raises:
        KeepError: Remote evidence cannot establish eligibility.
    """
    prs = json.loads(
        out(
            gh,
            "gh pr list",
            "pr",
            "list",
            "--repo",
            base,
            "--state",
            "all",
            "--head",
            branch,
            "--limit",
            "100",
            "--json",
            "number,state",
            tool="gh",
        )
    )
    if (
        not isinstance(prs, list)
        or len(prs) >= 100
        or any(pr["state"] not in {"OPEN", "CLOSED", "MERGED"} for pr in prs)
    ):
        raise KeepError("PR list is incomplete or invalid")
    if any(pr["state"] == "OPEN" for pr in prs):
        raise KeepError("open PR")
    if not prs:
        raise KeepError("no PR; upstream not checked")
    merged = [pr["number"] for pr in prs if pr["state"] == "MERGED"]
    if len(merged) != 1:
        raise KeepError("no unique merged PR")
    number = merged[0]
    if type(number) is not int or number <= 0:
        raise KeepError("invalid PR number")
    info = json.loads(
        out(
            gh,
            "gh pr view",
            "pr",
            "view",
            str(number),
            "--repo",
            base,
            "--json",
            PR_FIELDS,
            tool="gh",
        )
    )
    remote = (
        config(path, f"branch.{branch}.pushRemote")
        or config(path, "remote.pushDefault")
        or config(path, f"branch.{branch}.remote")
        or "origin"
    )
    url = (
        git(path, "remote", "get-url", "--push", "--all", "--", remote)
        .decode()
        .rstrip("\n")
    )
    source = SOURCE.fullmatch(url) if "\n" not in url else None
    host = (
        base.partition("/")[0]
        if base.count("/") == 2
        else os.environ.get("GH_HOST", "github.com")
    )
    head = git(path, "rev-parse", "--verify", "HEAD").strip()
    actual = (
        info["state"],
        info["headRefName"],
        info["headRepositoryOwner"]["login"],
        info["headRepository"]["name"],
        info["headRefOid"],
    )
    if (
        not source
        or not OID.fullmatch(head)
        or source[1].lower() != host.lower()
        or actual != ("MERGED", branch, source[2], source[3], head.decode())
    ):
        raise KeepError("PR identity mismatch (state, branch, source or HEAD)")
    parsed = urlsplit(info["url"])
    if parsed.scheme not in ("http", "https") or parsed.hostname != source[1].lower():
        raise KeepError("PR URL host mismatch")
    return f"merged PR #{number} matches HEAD"


def assess(
    path: Path,
    common: Path,
    records: list[tuple[Path, list[bytes]]],
    opts: argparse.Namespace,
    now: float,
) -> str:
    """Require every per-worktree check before allowing the candidate.

    Parameters:
        path: Path, Candidate checkout.
        common: Path, Common Git metadata directory.
        records: list[tuple[Path, list[bytes]]], Original worktree inventory.
        opts: argparse.Namespace, Additional scan or command options.
        now: float, Scan start time in epoch seconds.
    Returns:
        str: Description of remote proof
    Raises:
        KeepError: A local or remote predicate failed.
    """
    branch_ref = git(path, "symbolic-ref", "--quiet", "HEAD", missing=1).rstrip(b"\n")
    if not branch_ref.startswith(b"refs/heads/"):
        raise KeepError("detached HEAD")
    admin = Path(
        os.fsdecode(git(path, "rev-parse", "--absolute-git-dir").rstrip(b"\n"))
    ).resolve(strict=True)
    if admin.parent != common / "worktrees":
        raise KeepError("not a linked worktree of this repository")
    head = git(path, "rev-parse", "--verify", "HEAD")
    reason = check_remote(
        path,
        branch_ref[len(b"refs/heads/") :].decode("utf-8"),
        opts.base_repo,
        opts.gh,
    )
    fresh = inventory(opts.repo)
    if fresh != records or head != git(path, "rev-parse", "--verify", "HEAD"):
        raise KeepError("worktree inventory or HEAD changed during remote proof")
    check_admin(opts.repo, common, fresh)
    check_borrowed(path, admin, common, records, opts.borrower_gitdirs or ())
    check_activity(path, admin, opts.hold, now, opts.lsof)
    check_history(path, admin, len(head.strip()))
    check_status(path, admin)
    if opts.borrower_gitdirs is None:
        raise KeepError(STATUS_NOT_COLLECTED)
    return reason


def verdict(path: Path, decision: str, reason: str, *, scope_known: bool) -> None:
    """Write one machine-readable verdict, escaping unusual path characters.

    Parameters:
        path: Path, Path being checked or reported.
        decision: str, Internal classification, never a deletion authorization.
        reason: str, Explanation of the result.
        scope_known: bool, Whether the caller supplied a closed borrower scope.
    Returns:
        None.
    Raises:
        OSError: The output stream cannot be written.
    """
    if decision == "eligible":
        reason = STATUS_NOT_COLLECTED
    reasons = [reason] if scope_known else list(dict.fromkeys((UNKNOWN_SCOPE, reason)))
    sys.stdout.write(
        json.dumps({"worktree": str(path), "verdict": "keep", "reasons": reasons})
        + "\n"
    )


def main(
    *,
    git_binary: str | None = None,
    gh_binary: str | None = None,
    lsof_binary: str | None = None,
    borrower_gitdirs: tuple[Path, ...] | None = None,
) -> int:
    """Report scoped or repository-wide decisions; exit nonzero if inventory is unavailable.

    Parameters:
        git_binary: str | None, Absolute fixture override for Git.
        gh_binary: str | None, Absolute fixture adapter for GitHub.
        lsof_binary: str | None, Absolute fixture adapter for process evidence.
        borrower_gitdirs: tuple[Path, ...] | None, External metadata roots from a closed fixture scope.
    Returns:
        int: Exit status
    Raises:
        SystemExit: Invalid CLI arguments.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", type=Path)
    parser.add_argument("base_repo", help="owner/repo or host/owner/repo for GitHub")
    parser.add_argument(
        "--worktree", type=Path, help="evaluate only this exact registered path"
    )
    parser.add_argument(
        "--hold",
        type=Path,
        action="append",
        default=[],
        help="exact worktree with a known owner or retained claimed directory; repeatable",
    )
    opts = parser.parse_args()
    opts.borrower_gitdirs = borrower_gitdirs
    scope_known = borrower_gitdirs is not None
    try:
        overrides = sorted(REPO_ENV.intersection(os.environ))
        if overrides:
            raise KeepError(
                f"unexpected Git repository overrides: {', '.join(overrides)}"
            )
        executable = binary(
            GIT_LOCATIONS if git_binary is None else (git_binary,), "git"
        )
        version = GIT_VERSION.fullmatch(
            out(executable, "git --version", "--version", tool="git")
        )
        if version is None or (int(version[1]), int(version[2])) < (2, 36):
            raise KeepError("git too old to neutralize fsmonitor safely")
        GIT_BINARY.set(executable)
        opts.gh = binary(
            tuple(str(path / "gh") for path in BIN_DIRS)
            if gh_binary is None
            else (gh_binary,),
            "gh",
        )
        opts.lsof = binary(
            tuple(str(path / "lsof") for path in BIN_DIRS)
            if lsof_binary is None
            else (lsof_binary,),
            "lsof",
        )
        records = inventory(opts.repo)
        common = (
            opts.repo
            / os.fsdecode(git(opts.repo, "rev-parse", "--git-common-dir").rstrip(b"\n"))
        ).resolve(strict=True)
        opts.hold = {path.resolve() for path in opts.hold}
        selected = opts.worktree.resolve() if opts.worktree is not None else None
    except SCAN_ERRORS as exc:
        verdict(
            opts.worktree or opts.repo,
            "keep",
            f"cannot read inventory: {exc}",
            scope_known=scope_known,
        )
        return 1
    global_hold = None
    try:
        check_admin(opts.repo, common, records)
    except SCAN_ERRORS as exc:
        global_hold = f"cannot verify prune safety: {exc}"
    now = time.time()
    matched = False
    for index, (path, fields) in enumerate(records):
        try:
            if selected is not None and path.resolve() != selected:
                continue
            matched = True
            if index == 0 or b"bare" in fields:
                raise KeepError("main or bare checkout")
            if any(
                field == b"locked" or field.startswith(b"locked ") for field in fields
            ):
                raise KeepError("locked")
            if global_hold is not None:
                raise KeepError(global_hold)
            reason = assess(path.resolve(strict=True), common, records, opts, now)
        except SCAN_ERRORS as exc:
            verdict(path, "keep", str(exc), scope_known=scope_known)
        else:
            verdict(path, "eligible", reason, scope_known=scope_known)
    if not matched:
        verdict(
            opts.worktree or opts.repo,
            "keep",
            "no matching registered worktree",
            scope_known=scope_known,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
