"""Report JSON Lines sweep verdicts; never remove, prune, fetch or update refs.

References:
- https://git-scm.com/docs/git-worktree
- https://git-scm.com/docs/gitrepository-layout
- https://cli.github.com/manual/gh_pr_list
"""

from __future__ import annotations

import argparse
import errno
import json
import os
import re
import subprocess
import sys
import time
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
GIT_BINARY: ContextVar[Path | None] = ContextVar("GIT_BINARY", default=None)
TIMEOUT = 30
MAX_TREE_ENTRIES = 100_000
QUIET_SECONDS = 3600
UNKNOWN_SCOPE = "cannot establish a complete external borrower scope"
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
    data: bytes = b"",
    missing: int = 0,
    silent: bool = False,
) -> bytes:
    """Run a bounded command; diagnostics or unexpected exit codes require keeping.

    Parameters:
        executable: Path, Absolute executable path.
        label: str, Name to use in diagnostics.
        args: str, Positional command arguments.
        data: bytes, Raw evidence or input bytes.
        missing: int, Additional accepted exit status.
        silent: bool, Require empty standard output.
    Returns:
        bytes: Command stdout
    Raises:
        KeepError: The command times out, fails or emits diagnostics.
    """
    try:
        done = subprocess.run(
            [str(executable), *args],
            input=data,
            capture_output=True,
            check=False,
            timeout=TIMEOUT,
            env={
                **os.environ,
                "GIT_NO_LAZY_FETCH": "1",
                "GIT_NO_REPLACE_OBJECTS": "1",
                "GIT_TERMINAL_PROMPT": "0",
                "GH_PROMPT_DISABLED": "1",
            },
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
    """Run Git without optional writes (including status index refresh).

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
    return out(
        GIT_BINARY.get() or binary(GIT_LOCATIONS, "git"),
        "git " + " ".join(args[:2]),
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-C",
        str(path),
        *args,
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
    storage = git(repo, "rev-parse", "--show-object-format").strip()
    oid_width = {b"sha1": 40, b"sha256": 64}[storage]
    return parse_inventory(
        git(repo, "worktree", "list", "--porcelain", "-z"), oid_width
    )


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
    if config(path, "core.trustctime", "--type=bool") == "false":
        raise KeepError(
            "`core.trustctime` is disabled; restored mtimes may hide content changes"
        )


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


def check_upstream(path: Path, branch: str) -> None:
    """Require the configured upstream to exist live at the local tracking tip.

    Parameters:
        path: Path, Path being checked or reported.
        branch: str, Checked-out branch name.
    Returns:
        None.
    Raises:
        KeepError: The evidence is unsafe or incomplete.
    """
    remote = config(path, f"branch.{branch}.remote")
    merge = config(path, f"branch.{branch}.merge")
    if not remote or remote == "." or not merge.startswith("refs/heads/"):
        raise KeepError("missing configured remote upstream")
    live = git(path, "ls-remote", "--exit-code", "--refs", "--", remote, merge)
    if (
        advertised_tip(live, merge)
        != git(path, "rev-parse", "--verify", "@{upstream}").strip()
    ):
        raise KeepError("local upstream is stale")
    if git(path, "rev-list", "@{upstream}..HEAD"):
        raise KeepError("unpushed commits")


def advertised_tip(live: bytes, merge: str) -> bytes:
    """Require one well-formed remote advertisement for the exact upstream ref.

    Parameters:
        live: bytes, Raw remote advertisement.
        merge: str, Exact upstream ref name.
    Returns:
        bytes: Remote object ID
    Raises:
        KeepError: The advertisement does not match the upstream ref.
    """
    tip, separator, ref = live.rstrip(b"\n").partition(b"\t")
    if not separator or not OID.fullmatch(tip) or ref != merge.encode():
        raise KeepError("upstream is unverifiable")
    return tip


def check_remote(path: Path, branch: str, base: str, gh: Path, *, no_pr: bool) -> str:
    """Require exact merged PR identity, or live upstream proof for an explicit no-PR candidate.

    Parameters:
        path: Path, Path being checked or reported.
        branch: str, Checked-out branch name.
        base: str, GitHub repository to query.
        gh: Path, Absolute GitHub evidence command.
        no_pr: bool, Permit upstream proof instead of a merged PR.
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
    if not prs and no_pr:
        check_upstream(path, branch)
        return "no PR and live upstream contains HEAD"
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
        no_pr=opts.no_pr,
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
        raise KeepError(
            "status not collected: tracked worktree changes were not compared"
        )
    return reason


def verdict(path: Path, decision: str, reason: str, *, scope_known: bool) -> None:
    """Write one machine-readable verdict, escaping unusual path characters.

    Parameters:
        path: Path, Path being checked or reported.
        decision: str, Verdict classification.
        reason: str, Explanation of the result.
        scope_known: bool, Whether the caller supplied a closed borrower scope.
    Returns:
        None.
    Raises:
        OSError: The output stream cannot be written.
    """
    reasons = [reason] if scope_known else list(dict.fromkeys((UNKNOWN_SCOPE, reason)))
    sys.stdout.write(
        json.dumps({"worktree": str(path), "verdict": decision, "reasons": reasons})
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
    parser.add_argument(
        "--no-pr",
        action="store_true",
        help="allow live upstream proof for a worktree with no PR; requires --worktree",
    )
    opts = parser.parse_args()
    opts.borrower_gitdirs = borrower_gitdirs
    scope_known = borrower_gitdirs is not None
    if opts.no_pr and opts.worktree is None:
        parser.error("--no-pr requires --worktree")
    try:
        overrides = sorted(REPO_ENV.intersection(os.environ))
        if overrides:
            raise KeepError(
                f"unexpected Git repository overrides: {', '.join(overrides)}"
            )
        GIT_BINARY.set(
            binary(GIT_LOCATIONS if git_binary is None else (git_binary,), "git")
        )
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
