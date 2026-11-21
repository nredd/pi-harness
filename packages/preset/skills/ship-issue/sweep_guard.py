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
import shutil
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

TIMEOUT = 30
QUIET_SECONDS = 3600
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


def out(tool: str, *args: str, data: bytes = b"", missing: int = 0) -> bytes:
    """Run a bounded command; diagnostics or unexpected exit codes require keeping."""
    executable = shutil.which(tool)
    if executable is None:
        raise KeepError(f"missing `{tool}`")
    try:
        done = subprocess.run(
            [os.path.abspath(executable), *args],
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
        raise KeepError(f"`{tool}` timed out") from exc
    if done.stderr or done.returncode not in (0, missing):
        raise KeepError(
            f"`{tool}` {args[5:7] if tool == 'git' else args[:2]} failed ({done.returncode}): {done.stderr!r}"
        )
    return done.stdout


def git(path: Path, *args: str, data: bytes = b"", missing: int = 0) -> bytes:
    """Run Git without optional writes (including status index refresh)."""
    return out(
        "git",
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-C",
        str(path),
        *args,
        data=data,
        missing=missing,
    )


def present(path: Path) -> bool:
    """Count dangling symlinks as present; only ENOENT proves absence."""
    try:
        path.lstat()
    except OSError as exc:
        if exc.errno == errno.ENOENT:
            return False
        raise KeepError(f"cannot stat {str(path)!r}: {exc}") from exc
    return True


def inside(path: Path, root: Path) -> bool:
    """Test containment of already resolved paths."""
    return path == root or root in path.parents


def config(path: Path, key: str, *opts: str) -> str:
    """Read a single effective setting, allowing Git's missing-key status."""
    value = git(path, "config", *opts, "--get", key, missing=1).decode()
    return value[:-1]


def inventory(repo: Path) -> list[tuple[Path, list[bytes]]]:
    """Read NUL-delimited worktree metadata without interpreting path characters."""
    return [
        (Path(os.fsdecode(fields[0][len(b"worktree ") :])), fields[1:])
        for record in git(repo, "worktree", "list", "--porcelain", "-z").split(b"\0\0")
        if record
        for fields in [record.rstrip(b"\0").split(b"\0")]
    ]


def check_admin(
    repo: Path, common: Path, records: list[tuple[Path, list[bytes]]]
) -> None:
    """Keep globally when pruning could orphan an admin dir or Git reports prune output."""
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
    if git(repo, "worktree", "prune", "--dry-run", "--verbose"):
        raise KeepError("prune dry-run reported output")


def check_activity(path: Path, admin: Path, holds: set[Path], now: float) -> None:
    """Hold known owned work, active process cwd paths and recently touched worktrees."""
    if path in holds:
        raise KeepError("recorded owner or retained claimed directory")
    if inside(Path.cwd().resolve(), path):
        raise KeepError("current directory is inside worktree")
    cwd_fields = out("lsof", "-d", "cwd", "-F0n").split(b"\0")
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
    """Locate gitlinks even if the superproject config ignores submodule status."""
    return [
        path / os.fsdecode(record.split(b"\t", 1)[1])
        for record in git(path, "ls-files", "--stage", "-z").split(b"\0")
        if record.startswith(b"160000 ")
    ]


def check_status(path: Path, admin: Path) -> None:
    """Protect dirty, hidden, ignored and nested work; never authorize a forced removal."""
    for submodule in gitlinks(path):
        if present(submodule / ".git"):
            if git(
                submodule,
                "status",
                "--porcelain",
                "--ignored",
                "--untracked-files=all",
                "--ignore-submodules=none",
            ):
                raise KeepError(f"submodule dirty: {str(submodule)!r}")
            # Even a clean submodule can have unpublished refs or a reflog only in this gitdir.
            raise KeepError(
                f"initialized submodule may contain unpushed commits: {str(submodule)!r}"
            )
    if present(admin / "modules"):
        raise KeepError("retained submodule gitdir")
    status = git(
        path,
        "status",
        "--porcelain",
        "--ignored",
        "--untracked-files=all",
        "--ignore-submodules=none",
        "-z",
    )
    if status:
        raise KeepError(f"dirty or ignored paths: {status!r}")
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


def check_borrowed(
    path: Path, admin: Path, common: Path, records: list[tuple[Path, list[bytes]]]
) -> None:
    """Inspect registered checkouts and module stores for paths into the candidate."""
    roots = [common, common / "worktrees"]
    others = [
        other
        for other, fields in records
        if b"bare" not in fields and other.resolve() != path
    ]
    seen = set()
    while others:
        other = others.pop().resolve(strict=True)
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

    def fail(error: OSError) -> None:
        """Never interpret an incomplete filesystem walk as proof."""
        raise error

    for root in dict.fromkeys(roots):
        if not present(root):
            continue
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


def check_history(path: Path, admin: Path) -> None:
    """Protect worktree-local refs, operations, reflog-only commits and raw filtered files."""
    local_refs = git(
        path,
        "for-each-ref",
        "--format=%(refname)",
        "refs/worktree",
        "refs/bisect",
        "refs/rewritten",
    )
    if local_refs:
        raise KeepError(f"worktree-local refs: {local_refs!r}")
    for name in OPERATIONS:
        if present(admin / name):
            raise KeepError(f"in-progress operation `{name}`")
    git(path, "reflog", "exists", "HEAD")
    reflog = set(git(path, "reflog", "show", "--format=%H", "HEAD").splitlines())
    if not reflog:
        raise KeepError("empty HEAD reflog")
    missing = sorted(reflog.difference(git(path, "rev-list", "--all").splitlines()))
    if missing:
        raise KeepError(f"HEAD reflog commits outside refs: {missing!r}")
    attrs = git(
        path, "check-attr", "-z", "--stdin", "-a", data=git(path, "ls-files", "-z")
    )
    if attrs:
        fields = attrs.split(b"\0")
        if fields[-1] or (len(fields) - 1) % 3:
            raise KeepError("malformed attribute scan")
        filters = list(zip(fields[0:-1:3], fields[1::3], fields[2::3]))
        filtered = [(name, value) for name, attr, value in filters if attr == b"filter"]
        if filtered:
            raise KeepError(f"filter attributes on tracked paths: {filtered!r}")


def check_upstream(path: Path, branch: str) -> None:
    """Require the configured upstream to exist live at the local tracking tip."""
    remote = config(path, f"branch.{branch}.remote")
    merge = config(path, f"branch.{branch}.merge")
    if not remote or remote == "." or not merge.startswith("refs/heads/"):
        raise KeepError("missing configured remote upstream")
    live = git(path, "ls-remote", "--exit-code", "--refs", "--", remote, merge)
    tip, separator, ref = live.rstrip(b"\n").partition(b"\t")
    if not separator or not OID.fullmatch(tip) or ref != merge.encode():
        raise KeepError("upstream is unverifiable")
    if tip != git(path, "rev-parse", "--verify", "@{upstream}").strip():
        raise KeepError("local upstream is stale")
    if git(path, "rev-list", "@{upstream}..HEAD"):
        raise KeepError("unpushed commits")


def check_remote(path: Path, branch: str, base: str, *, no_pr: bool) -> str:
    """Require exact merged PR identity, or live upstream proof for an explicit no-PR candidate."""
    prs = json.loads(
        out(
            "gh",
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
        out("gh", "pr", "view", str(number), "--repo", base, "--json", PR_FIELDS)
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
        base.split("/")[0]
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
    """Require every per-worktree check before allowing the candidate."""
    branch_ref = git(path, "symbolic-ref", "--quiet", "HEAD", missing=1).rstrip(b"\n")
    if not branch_ref.startswith(b"refs/heads/"):
        raise KeepError("detached HEAD")
    admin = Path(
        os.fsdecode(git(path, "rev-parse", "--absolute-git-dir").rstrip(b"\n"))
    ).resolve(strict=True)
    if admin.parent != common / "worktrees":
        raise KeepError("not a linked worktree of this repository")
    check_history(path, admin)
    check_borrowed(path, admin, common, records)
    check_activity(path, admin, opts.hold, now)
    check_status(path, admin)
    return check_remote(
        path,
        os.fsdecode(branch_ref[len(b"refs/heads/") :]),
        opts.base_repo,
        no_pr=opts.no_pr,
    )


def verdict(path: Path, decision: str, reason: str) -> None:
    """Write one machine-readable verdict, escaping unusual path characters."""
    sys.stdout.write(
        json.dumps({"worktree": str(path), "verdict": decision, "reasons": [reason]})
        + "\n"
    )


def main() -> int:
    """Report scoped or repository-wide decisions; exit nonzero if inventory is unavailable."""
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
    if opts.no_pr and opts.worktree is None:
        parser.error("--no-pr requires --worktree")
    try:
        overrides = sorted(REPO_ENV.intersection(os.environ))
        if overrides:
            raise KeepError(
                f"unexpected Git repository overrides: {', '.join(overrides)}"
            )
        records = inventory(opts.repo)
        common = (
            opts.repo
            / os.fsdecode(git(opts.repo, "rev-parse", "--git-common-dir").rstrip(b"\n"))
        ).resolve(strict=True)
        opts.hold = {path.resolve() for path in opts.hold}
        selected = opts.worktree.resolve() if opts.worktree is not None else None
    except SCAN_ERRORS as exc:
        verdict(opts.worktree or opts.repo, "keep", f"cannot read inventory: {exc}")
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
            verdict(path, "keep", str(exc))
        else:
            verdict(path, "eligible", reason)
    if not matched:
        verdict(opts.worktree or opts.repo, "keep", "no matching registered worktree")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
