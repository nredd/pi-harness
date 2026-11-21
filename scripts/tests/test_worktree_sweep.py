"""Exercise the shipped sweep verdict command against disposable Git repositories.

References:
- https://git-scm.com/docs/git-worktree
- https://cli.github.com/manual/gh_pr_view
"""

from __future__ import annotations

import ast
import json
import os
import runpy
import subprocess
import sys
from pathlib import Path
from shlex import quote
from textwrap import dedent
from typing import NamedTuple

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.append(str(ROOT / "tests/integration"))
from harness.git_fixture import GIT_IDENTITY, git_env

GUARD = ROOT / "packages/preset/skills/ship-issue/sweep_guard.py"
BASE = "owner/project"
GUARD_MODULE = runpy.run_path(str(GUARD))
GIT = GUARD_MODULE["binary"](GUARD_MODULE["GIT_LOCATIONS"], "git")
TIMEOUT = 45


class Worktrees(NamedTuple):
    """Real Git paths plus external evidence provided by fixture adapters."""

    repo: Path
    path: Path
    admin: Path
    bin: Path
    pr: dict[str, object]


def git(path: Path, *args: str) -> bytes:
    """Run real Git with disposable identity and no inherited repository."""
    return subprocess.check_output(
        [str(GIT), *GIT_IDENTITY, "-C", str(path), *args],
        env=git_env(),
        timeout=TIMEOUT,
        stderr=subprocess.STDOUT,
    )


def init(path: Path) -> None:
    """Create a repository with a tracked file and an ignored path."""
    path.mkdir()
    git(path, "init", "--template=")
    (path / "tracked").write_text("saved\n")
    (path / ".gitignore").write_text("/ignored\n")
    git(path, "add", ".")
    git(path, "commit", "-m", "Base")


def adapter(path: Path, name: str, body: str) -> None:
    """Install a disposable non-Git evidence provider."""
    cmd = path / name
    cmd.write_text(f"#!{sys.executable}\n" + dedent(body))
    cmd.chmod(0o755)


@pytest.fixture
def wt(tmp_path: Path) -> Worktrees:
    """Create a linked worktree with a strict GH CLI adapter and a process snapshot."""
    repo = tmp_path / "repo"
    init(repo)
    git(repo, "remote", "add", "origin", "git@github.com:source/project.git")
    path = tmp_path / "linked worktree"
    git(repo, "worktree", "add", "-b", "merged", str(path))
    admin = Path(os.fsdecode(git(path, "rev-parse", "--absolute-git-dir").strip()))
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    adapter(
        bin_dir,
        "gh",
        """
        import os
        import sys
        from pathlib import Path

        base = os.environ["SWEEP_BASE"]
        args = sys.argv[1:]
        list_args = ["pr", "list", "--repo", base, "--state", "all", "--head", "merged",
                     "--limit", "100", "--json", "number,state"]
        view_fields = "headRefName,headRepository,headRepositoryOwner,headRefOid,state,url"
        if args == list_args:
            print(os.environ["SWEEP_LIST"])
        elif args == ["pr", "view", "123", "--repo", base, "--json", view_fields]:
            if recovery := os.environ.get("SWEEP_WRITE_DURING_VIEW"):
                target = Path(recovery)
                target.write_text("recovery")
                os.utime(target.parent, (1, 1))
            if locked := os.environ.get("SWEEP_LOCK_DURING_VIEW"):
                Path(locked).write_text("locked during remote proof")
            print(os.environ["SWEEP_PR"])
        else:
            sys.exit(f"unexpected arguments: {args!r}")
        sys.stderr.write(os.environ.get("SWEEP_WARNING", ""))
        """,
    )
    adapter(
        bin_dir,
        "lsof",
        'import os, sys\nsys.stdout.buffer.write(b"p123\\0\\nn" + os.environb[b"SWEEP_CWD"] + b"\\0\\n")\n',
    )
    return Worktrees(
        repo,
        path,
        admin,
        bin_dir,
        {
            "state": "MERGED",
            "headRefName": "merged",
            "headRepositoryOwner": {"login": "source"},
            "headRepository": {"name": "project"},
            "headRefOid": git(path, "rev-parse", "HEAD").decode().strip(),
            "url": "https://github.com/owner/project/pull/123",
        },
    )


def quiet(wt: Worktrees) -> None:
    """Set activity markers far outside the quiet period without waiting on the clock."""
    for path in (wt.path, wt.admin / "index", wt.admin / "HEAD", wt.admin / "logs/HEAD"):
        if path.exists():
            os.utime(path, (1, 1))


def run(
    wt: Worktrees,
    *args: str,
    all_paths: bool = False,
    cwd: Path | None = None,
    base: str = BASE,
    variables: dict[str, str] | None = None,
    borrower_gitdirs: tuple[Path, ...] | None = (),
    inventory_suffix: bytes = b"",
) -> tuple[int, list[dict[str, object]]]:
    """Run the CLI with evidence adapters and optionally inject a closed scope."""
    env = git_env()
    env.pop("GH_HOST", None)
    env |= {
        "PATH": f"{wt.bin}{os.pathsep}{env['PATH']}",
        "SWEEP_BASE": base,
        "SWEEP_LIST": '[{"number": 123, "state": "MERGED"}]',
        "SWEEP_PR": json.dumps(wt.pr),
        "SWEEP_CWD": str(wt.repo),
        **(variables or {}),
    }
    if borrower_gitdirs is not None:
        env["SWEEP_SCOPE"] = json.dumps(list(map(str, borrower_gitdirs)))
    if inventory_suffix:
        env["SWEEP_INVENTORY_SUFFIX"] = inventory_suffix.hex()
    scope = [] if all_paths else ["--worktree", str(wt.path)]
    done = subprocess.run(
        [
            sys.executable,
            "-c",
            "import json, os, runpy, sys; from pathlib import Path; "
            "source, git, gh, lsof = sys.argv[1:5]; sys.argv[1:5] = []; "
            "scope = os.getenv('SWEEP_SCOPE'); "
            "scope_kwargs = {} if scope is None else "
            "{'borrower_gitdirs': tuple(map(Path, json.loads(scope)))}; "
            "module = runpy.run_path(source); main = module['main']; "
            "parse = module['parse_inventory']; "
            "globals_ = main.__globals__; "
            "limit = 'MAX_TREE_ENTRIES'; "
            "globals_[limit] = int(os.getenv('SWEEP_ENTRY_LIMIT', globals_[limit])); "
            "suffix = bytes.fromhex(os.getenv('SWEEP_INVENTORY_SUFFIX', '')); "
            "main.__globals__['parse_inventory'] = "
            "lambda raw: parse(raw[:-1] + suffix if suffix else raw); "
            "sys.exit(main(git_binary=git, gh_binary=gh, lsof_binary=lsof, **scope_kwargs))",
            str(GUARD),
            str(GIT),
            str(wt.bin / "gh"),
            str(wt.bin / "lsof"),
            str(wt.repo),
            base,
            *scope,
            *args,
        ],
        cwd=cwd or wt.repo,
        env=env,
        timeout=TIMEOUT,
        capture_output=True,
        check=False,
        text=True,
    )
    assert not done.stderr, done.stderr
    return done.returncode, [json.loads(line) for line in done.stdout.splitlines()]


def keep(wt: Worktrees, reason: str, *args: str, **variables: str) -> None:
    """Assert the scoped candidate has a specific keep reason, not an unrelated failure."""
    code, (result,) = run(wt, *args, variables=variables)
    assert code == 0
    assert Path(str(result["worktree"])).resolve() == wt.path.resolve()
    assert result["verdict"] == "keep"
    assert reason in str(result["reasons"])


@pytest.mark.parametrize(
    "url",
    [
        "git@github.com:source/project.git",
        "https://github.com/source/project",
        "ssh://git@github.com:2222/source/project.git",
    ],
)
def test_injected_scope_allows_clean_merged_tree_without_upstream(wt: Worktrees, url: str) -> None:
    git(wt.path, "remote", "set-url", "origin", url)
    quiet(wt)
    code, (main, result) = run(wt, all_paths=True)
    assert code == 0
    assert main["verdict"] == "keep"
    assert "main or bare" in str(main["reasons"])
    assert result["verdict"] == "eligible", result
    assert "#123" in str(result["reasons"])
    assert wt.path.is_dir()
    assert wt.admin.is_dir()
    assert git(wt.repo, "show-ref", "--verify", "refs/heads/merged")


@pytest.mark.parametrize("case", ["clean", "borrowed scratch", "inventory error", "no match"])
def test_shipped_cli_is_keep_only(wt: Worktrees, case: str) -> None:
    args = ()
    variables = {}
    if case == "borrowed scratch":
        cache = wt.path / "cache.git"
        git(wt.path, "init", "--bare", "--template=", str(cache))
        borrower = wt.repo.parent / "borrower"
        init(borrower)
        (borrower / ".git/objects/info/alternates").write_text(f"{cache / 'objects'}\n")
        unique = wt.repo.parent / "unique"
        unique.write_text("Only stored in the bare cache\n")
        oid = git(cache, "hash-object", "-w", str(unique)).decode().strip()
        git(borrower, "tag", "borrowed", oid)
        assert git(borrower, "cat-file", "blob", "borrowed") == unique.read_bytes()
    elif case == "inventory error":
        variables["GIT_INDEX_FILE"] = str(wt.repo / ".git/index")
    elif case == "no match":
        args = ("--worktree", str(wt.bin))
    quiet(wt)
    code, results = run(wt, *args, all_paths=case == "clean", variables=variables, borrower_gitdirs=None)
    assert code == (1 if case in {"inventory error", "no match"} else 0)
    assert len(results) == (2 if case == "clean" else 1)
    for result in results:
        assert result["verdict"] == "keep"
        reasons = tuple(map(str, result["reasons"])) if isinstance(result["reasons"], list) else ()
        assert reasons[0] == "cannot establish a complete external borrower scope"
    if case == "clean":
        assert results[-1]["reasons"] == ["cannot establish a complete external borrower scope"]
    if case == "borrowed scratch":
        assert "dirty or ignored paths" in str(results[0]["reasons"])
        assert "cache.git/objects/" in str(results[0]["reasons"])


def test_worktree_scope_never_accepts_unregistered_directory(wt: Worktrees) -> None:
    code, (result,) = run(wt, "--worktree", str(wt.bin))
    assert code == 1
    assert result["verdict"] == "keep"
    assert "no matching" in str(result["reasons"])


def test_alternate_index_cannot_hide_edits(wt: Worktrees) -> None:
    quiet(wt)
    code, (result,) = run(wt, variables={"GIT_INDEX_FILE": str(wt.repo / ".git/index")})
    assert code == 1
    assert result["verdict"] == "keep"
    assert "unexpected Git repository overrides: GIT_INDEX_FILE" in str(result["reasons"])


def test_locked(wt: Worktrees) -> None:
    git(wt.repo, "worktree", "lock", "--reason", "Retain", str(wt.path))
    quiet(wt)
    keep(wt, "locked")


def test_detached(wt: Worktrees) -> None:
    git(wt.path, "switch", "--detach")
    quiet(wt)
    keep(wt, "detached HEAD")


@pytest.mark.parametrize("name", ["tracked", "untracked", "ignored"])
def test_dirty_or_ignored(wt: Worktrees, name: str) -> None:
    (wt.path / name).write_text("unsaved\n")
    quiet(wt)
    keep(wt, name)


@pytest.mark.parametrize("flag", ["--assume-unchanged", "--skip-worktree"])
def test_hidden_index_edit(wt: Worktrees, flag: str) -> None:
    git(wt.path, "update-index", flag, "tracked")
    (wt.path / "tracked").write_text("hidden\n")
    quiet(wt)
    keep(wt, "index flags")


@pytest.mark.parametrize("key", ["core.sparseCheckout", "core.ignoreStat"])
def test_hidden_status_configuration(wt: Worktrees, key: str) -> None:
    git(wt.path, "config", key, "true")
    quiet(wt)
    keep(wt, key)


def test_disabled_filemode_hides_executable_bit_change(wt: Worktrees) -> None:
    git(wt.path, "config", "core.filemode", "false")
    (wt.path / "tracked").chmod(0o755)
    assert git(wt.path, "status", "--porcelain") == b""
    assert b"mode change 100644 => 100755" in git(wt.path, "-c", "core.filemode=true", "diff", "--summary")
    quiet(wt)
    keep(wt, "core.filemode")


def test_disabled_trustctime_hides_same_size_edit_with_restored_mtime(wt: Worktrees) -> None:
    git(wt.path, "config", "core.trustctime", "false")
    target = wt.path / "tracked"
    os.utime(target, (1, 1))
    git(wt.path, "update-index", "--refresh")
    original = target.stat()
    target.write_text("other\n")
    os.utime(target, ns=(original.st_atime_ns, original.st_mtime_ns))
    assert git(wt.path, "status", "--porcelain") == b""
    assert git(wt.path, "hash-object", "--no-filters", "tracked") != git(wt.path, "rev-parse", "HEAD:tracked")
    quiet(wt)
    os.utime(wt.admin / "index", (10, 10))
    assert git(wt.path, "--no-optional-locks", "status", "--porcelain") == b""
    keep(wt, "core.trustctime")


def test_known_owner_or_retained_empty_claim(wt: Worktrees) -> None:
    (wt.path / "retained-empty").mkdir()
    quiet(wt)
    assert git(wt.path, "status", "--porcelain", "--ignored") == b""
    keep(wt, "recorded owner or retained claimed directory", "--hold", str(wt.path))


def test_live_cwd(wt: Worktrees) -> None:
    nested = wt.path / "deep\npath"
    nested.mkdir()
    quiet(wt)
    keep(wt, "a process has its cwd inside", SWEEP_CWD=str(nested))
    code, (result,) = run(wt, cwd=nested)
    assert code == 0
    assert result["verdict"] == "keep"
    assert "current directory" in str(result["reasons"])


def test_unusable_process_snapshot_does_not_allow_removal(wt: Worktrees) -> None:
    quiet(wt)
    keep(wt, "no process cwd evidence", SWEEP_CWD="")


def test_recent_activity(wt: Worktrees) -> None:
    quiet(wt)
    os.utime(wt.admin / "index", (4_102_444_800, 4_102_444_800))
    keep(wt, "recent activity")


@pytest.mark.parametrize("ref", ["refs/worktree/wip", "refs/bisect/wip", "refs/rewritten/wip", "refs/stash"])
def test_local_ref(wt: Worktrees, ref: str) -> None:
    git(wt.path, "update-ref", ref, "HEAD")
    quiet(wt)
    keep(wt, "worktree-local refs")


def test_reflog_only_commit(wt: Worktrees) -> None:
    git(wt.path, "switch", "--detach")
    git(wt.path, "commit", "--allow-empty", "-m", "Reflog only")
    git(wt.path, "switch", "merged")
    quiet(wt)
    keep(wt, "HEAD reflog commits outside refs")


@pytest.mark.parametrize("absent", [True, False], ids=["absent", "empty"])
def test_empty_reflog(wt: Worktrees, absent: bool) -> None:
    path = wt.admin / "logs/HEAD"
    if absent:
        path.unlink()
    else:
        path.write_bytes(b"")
    quiet(wt)
    keep(wt, "/logs/HEAD" if absent else "empty HEAD reflog")


@pytest.mark.parametrize(
    "marker",
    [
        "rebase-apply",
        "rebase-merge",
        "sequencer",
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "BISECT_LOG",
    ],
)
def test_dangling_operation_marker(wt: Worktrees, marker: str) -> None:
    (wt.admin / marker).symlink_to("missing")
    quiet(wt)
    keep(wt, f"in-progress operation `{marker}`")


def test_non_enoent_marker_error(wt: Worktrees) -> None:
    # A non-directory intermediate component reproduces ENOTDIR even when run as root.
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import runpy, sys; from pathlib import Path; "
            "runpy.run_path(sys.argv[1])['present'](Path(sys.argv[2]))",
            str(GUARD),
            str(wt.admin / "HEAD/marker"),
        ],
        env=git_env(),
        capture_output=True,
        text=True,
        timeout=TIMEOUT,
        check=False,
    )
    assert result.returncode != 0
    assert "cannot stat" in result.stderr


def test_stopped_am(wt: Worktrees) -> None:
    base = git(wt.path, "rev-parse", "HEAD").decode().strip()
    (wt.repo / "tracked").write_text("patch\n")
    git(wt.repo, "commit", "-am", "Patch")
    patch = wt.repo / "patch.mbox"
    patch.write_bytes(git(wt.repo, "format-patch", "--stdout", "-1"))
    (wt.path / "tracked").write_text("conflict\n")
    git(wt.path, "commit", "-am", "Conflict")
    with pytest.raises(subprocess.CalledProcessError):
        git(wt.path, "am", str(patch))
    assert git(wt.path, "status", "--porcelain") == b""
    quiet(wt)
    wt.pr["headRefOid"] = git(wt.path, "rev-parse", "HEAD").decode().strip()
    assert wt.pr["headRefOid"] != base
    keep(wt, "in-progress operation `rebase-apply`")


def test_filter_hides_raw_bytes(wt: Worktrees) -> None:
    name = "filtered\nname.txt"
    (wt.path / ".gitattributes").write_text("*.txt filter=constant\n")
    git(wt.path, "config", "filter.constant.clean", "sed 's/^scratch$/tracked/'")
    (wt.path / name).write_text("tracked\n")
    git(wt.path, "add", ".")
    git(wt.path, "commit", "-m", "Filter")
    wt.pr["headRefOid"] = git(wt.path, "rev-parse", "HEAD").decode().strip()
    (wt.path / name).write_text("scratch\n")
    assert git(wt.path, "status", "--porcelain", "--ignored") == b""
    quiet(wt)
    keep(wt, "filter attributes")


@pytest.mark.parametrize("kind", ["missing-tree", "missing-dotgit", "empty-admin", "wrong-target"])
def test_prune_keeps_unsafe_registration(wt: Worktrees, kind: str) -> None:
    other = wt.repo.parent / "other checkout"
    git(wt.repo, "worktree", "add", "-b", "other", str(other))
    gitdir = Path(os.fsdecode(git(other, "rev-parse", "--absolute-git-dir").strip())) / "gitdir"
    if kind == "missing-tree":
        other.rename(wt.repo.parent / "unmounted")
    elif kind == "missing-dotgit":
        git(wt.repo, "worktree", "lock", str(other))
        (other / ".git").unlink()
    elif kind == "empty-admin":
        gitdir.write_bytes(b"")
    else:
        (other / ".git").write_text(f"gitdir: {wt.admin}\n")
    quiet(wt)
    expected = {
        "missing-tree": "prunable",
        "missing-dotgit": "/.git'",
        "empty-admin": "empty gitdir",
        "wrong-target": "no matching `.git` file",
    }
    keep(wt, expected[kind])
    assert gitdir.exists()


def test_inventory_without_any_linked_worktrees(wt: Worktrees) -> None:
    git(wt.repo, "worktree", "remove", str(wt.path))
    code, (result,) = run(wt, all_paths=True)
    assert code == 0
    assert result["verdict"] == "keep"
    assert "main or bare" in str(result["reasons"])


def test_git_prune_is_only_ever_called_in_dry_run_mode(wt: Worktrees) -> None:
    trace = wt.bin / "commands.jsonl"
    quiet(wt)
    code, (result,) = run(wt, variables={"GIT_TRACE2_EVENT": str(trace)})
    assert code == 0
    assert result["verdict"] == "eligible", result
    starts = [
        event["argv"]
        for line in trace.read_text().splitlines()
        if (event := json.loads(line))["event"] == "start"
    ]
    prunes = [argv[-4:] for argv in starts if "prune" in argv]
    assert prunes
    assert all(argv == ["worktree", "prune", "--dry-run", "--verbose"] for argv in prunes)


@pytest.mark.parametrize("dependency", ["alternates", "gitdir"])
def test_borrowed_submodule_metadata(wt: Worktrees, dependency: str) -> None:
    other = wt.repo.parent / "borrowing checkout"
    git(wt.repo, "worktree", "add", "-b", "borrowing", str(other))
    git(other, "-c", "protocol.file.allow=always", "submodule", "add", str(wt.repo), "sub")
    sub = other / "sub"
    admin = Path(os.fsdecode(git(sub, "rev-parse", "--absolute-git-dir").strip()))
    if dependency == "alternates":
        objects = wt.admin / "objects"
        objects.mkdir()
        (admin / "objects/info/alternates").write_text(f"\n{admin / 'objects'}\n{objects}\n")
        reason = "another checkout borrows objects"
    else:
        target = wt.admin / "borrowed-submodule"
        git(sub, "config", "core.worktree", str(sub))
        admin.rename(target)
        (sub / ".git").write_text(f"gitdir: {target}\n")
        reason = "another checkout uses gitdir"
    quiet(wt)
    keep(wt, reason)


@pytest.mark.parametrize("state", ["filter", "clean", "deinitialized"])
def test_submodule_work_is_kept(wt: Worktrees, state: str) -> None:
    source = wt.repo.parent / "module-source"
    init(source)
    sub = wt.path / "sub"
    git(wt.path, "-c", "protocol.file.allow=always", "submodule", "add", str(source), "sub")
    git(wt.path, "commit", "-m", "Add module")
    wt.pr["headRefOid"] = git(wt.path, "rev-parse", "HEAD").decode().strip()
    marker = wt.repo.parent / "clean-filter-ran"
    if state == "filter":
        attrs = wt.repo.parent / "submodule-attributes"
        attrs.write_text("tracked filter=marker\n")
        git(sub, "config", "core.attributesFile", str(attrs))
        git(sub, "config", "filter.marker.clean", f"touch {quote(str(marker))}; cat")
        (sub / "tracked").write_text("wip!!\n")
    elif state == "deinitialized":
        git(wt.path, "submodule", "deinit", "sub")
    quiet(wt)
    expected = {
        "filter": "retained submodule gitdir",
        "clean": "retained submodule gitdir",
        "deinitialized": "retained submodule gitdir",
    }
    code, (result,) = run(wt)
    assert not marker.exists(), "the guard ran the submodule clean filter"
    assert code == 0
    assert result["verdict"] == "keep"
    assert expected[state] in str(result["reasons"])


@pytest.mark.parametrize(
    ("states", "reason"),
    [
        ("[]", "no unique merged PR"),
        ('[{"state":"CLOSED"}]', "no unique merged PR"),
        ('[{"state":"MERGED","number":123},{"state":"OPEN","number":456}]', "open PR"),
    ],
)
def test_only_a_unique_merged_pr_can_authorize(wt: Worktrees, states: str, reason: str) -> None:
    quiet(wt)
    keep(wt, reason, SWEEP_LIST=states)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("state", "CLOSED"),
        ("headRefName", "another"),
        ("headRepository", {"name": "another"}),
        ("headRepositoryOwner", {"login": "fork"}),
        ("headRefOid", "bad-oid"),
    ],
)
def test_pr_identity_mismatch(wt: Worktrees, field: str, value: object) -> None:
    wt.pr[field] = value
    quiet(wt)
    keep(wt, "PR identity mismatch")


@pytest.mark.parametrize(
    "field", ["state", "headRefName", "headRepository", "headRepositoryOwner", "headRefOid", "url"]
)
def test_pr_identity_missing_field(wt: Worktrees, field: str) -> None:
    del wt.pr[field]
    quiet(wt)
    keep(wt, field)


def test_pr_head_cannot_hide_unpushed_commit(wt: Worktrees) -> None:
    git(wt.path, "commit", "--allow-empty", "-m", "Not pushed")
    quiet(wt)
    keep(wt, "PR identity mismatch")


def test_pr_url_host_must_agree(wt: Worktrees) -> None:
    wt.pr["url"] = "https://another.example/owner/project/pull/123"
    quiet(wt)
    keep(wt, "PR URL host mismatch")


def test_actual_push_host_not_fetch_host_is_checked(wt: Worktrees) -> None:
    git(wt.path, "remote", "set-url", "--push", "origin", "git@another.example:source/project.git")
    quiet(wt)
    keep(wt, "PR identity mismatch")


@pytest.mark.parametrize(
    ("base", "variables"), [("forge.example/owner/project", {}), (BASE, {"GH_HOST": "forge.example"})]
)
def test_enterprise_pr_host(wt: Worktrees, base: str, variables: dict[str, str]) -> None:
    git(wt.path, "remote", "set-url", "origin", "git@forge.example:source/project.git")
    wt.pr["url"] = "https://forge.example/owner/project/pull/123"
    quiet(wt)
    code, (result,) = run(wt, base=base, variables=variables)
    assert code == 0
    assert result["verdict"] == "eligible", result


@pytest.mark.parametrize(
    ("states", "reason"),
    [("{}", "PR list is incomplete"), ('[{"state":"MERGED","number":0}]', "invalid PR number")],
)
def test_unverifiable_pr_info_keeps(wt: Worktrees, states: str, reason: str) -> None:
    quiet(wt)
    keep(wt, reason, SWEEP_LIST=states)


def test_command_diagnostics_including_whitespace_keep(wt: Worktrees) -> None:
    quiet(wt)
    keep(wt, "failed (0)", SWEEP_WARNING=" \n")


@pytest.mark.parametrize("state", ["current", "missing", "stale", "ahead"])
def test_no_pr_needs_live_current_upstream_containing_head(wt: Worktrees, state: str) -> None:
    upstream = wt.repo.parent / "upstream.git"
    upstream.mkdir()
    git(upstream, "init", "--bare", "--template=")
    git(wt.path, "remote", "add", "parked", str(upstream))
    git(wt.path, "push", "-u", "parked", "merged")
    if state == "missing":
        git(upstream, "update-ref", "-d", "refs/heads/merged")
    elif state == "stale":
        git(wt.repo, "commit", "--allow-empty", "-m", "Remote change")
        git(wt.repo, "push", str(upstream), "HEAD:refs/heads/merged")
    elif state == "ahead":
        git(wt.path, "commit", "--allow-empty", "-m", "Unpushed")
    quiet(wt)
    code, (result,) = run(wt, "--no-pr", variables={"SWEEP_LIST": "[]"})
    assert code == 0
    if state == "current":
        assert result["verdict"] == "eligible", result
    else:
        assert result["verdict"] == "keep", result
        assert {"missing": "ls-remote", "stale": "local upstream is stale", "ahead": "unpushed commits"}[
            state
        ] in str(result["reasons"])
    assert wt.admin.is_dir()


def test_no_pr_never_ignores_open_pr(wt: Worktrees) -> None:
    quiet(wt)
    keep(wt, "open PR", "--no-pr", SWEEP_LIST='[{"state":"OPEN"}]')


def test_no_pr_without_configured_upstream(wt: Worktrees) -> None:
    quiet(wt)
    keep(wt, "missing configured remote upstream", "--no-pr", SWEEP_LIST="[]")


def test_no_pr_requires_scope(wt: Worktrees) -> None:
    done = subprocess.run(
        [sys.executable, str(GUARD), str(wt.repo), BASE, "--no-pr"],
        env=git_env(),
        capture_output=True,
        check=False,
        text=True,
        timeout=TIMEOUT,
    )
    assert done.returncode == 2
    assert "--no-pr requires --worktree" in done.stderr


def test_command_boundary(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    guard = runpy.run_path(str(GUARD))
    with pytest.raises(guard["KeepError"], match="missing"):
        guard["binary"](("git", str(tmp_path / "not-installed")), "git")
    with pytest.raises(guard["KeepError"], match=r"explicit label.*failed"):
        guard["out"](Path(sys.executable), "explicit label", "-c", "print(' ')", silent=True)

    def timed_out(*args: object, **kwargs: object) -> None:
        raise subprocess.TimeoutExpired(sys.executable, 30)

    with monkeypatch.context() as patch:
        patch.setattr(subprocess, "run", timed_out)
        with pytest.raises(guard["KeepError"], match="timed out"):
            guard["out"](Path(sys.executable), "python", "-V")


def test_malformed_evidence_parsers() -> None:
    guard = runpy.run_path(str(GUARD))
    with pytest.raises(guard["KeepError"], match="malformed attribute scan"):
        guard["check_attributes"](b"broken\0")
    with pytest.raises(guard["KeepError"], match="upstream is unverifiable"):
        guard["advertised_tip"](b"broken", "refs/heads/main")


def test_incomplete_borrower_scan_keeps(wt: Worktrees, monkeypatch: pytest.MonkeyPatch) -> None:
    guard = runpy.run_path(str(GUARD))
    with monkeypatch.context() as patch:
        patch.setattr(os, "environ", git_env())
        with pytest.raises(OSError, match="No such file or directory"):
            guard["check_borrowed"](wt.path, wt.admin, wt.bin / "missing", [])
        records = [(wt.repo, []), (wt.repo, []), (wt.path, [])]
        guard["check_borrowed"](wt.path, wt.admin, wt.repo / ".git", records)
        with pytest.raises(guard["KeepError"], match="not a linked worktree"):
            guard["assess"](wt.path, wt.bin, records, None, 0)


def test_borrower_named_in_disconnected_module_config(wt: Worktrees) -> None:
    module = wt.admin / "modules/disconnected"
    module.mkdir(parents=True)
    git(module, "init", "--bare", "--template=")
    git(module, "config", "core.worktree", str(wt.repo))
    quiet(wt)
    keep(wt, "another checkout uses gitdir")


def test_valid_nonborrowing_alternate_does_not_block(wt: Worktrees) -> None:
    info = wt.repo / ".git/objects/info"
    (info / "alternates").write_text(f"{wt.bin}\n")
    quiet(wt)
    code, (result,) = run(wt)
    assert code == 0
    assert result["verdict"] == "eligible", result


def test_symlinked_borrower_store_keeps(wt: Worktrees) -> None:
    (wt.admin / "modules").symlink_to(wt.bin)
    quiet(wt)
    keep(wt, "cannot verify symlinked Git metadata")


@pytest.mark.parametrize("suffix", [b"lock damaged\0\0", b"locked\0locked\0\0", b"truncated"])
def test_unrecognized_inventory_evidence_keeps(wt: Worktrees, suffix: bytes) -> None:
    # Mutate actual Git output at the parser boundary, not the Git executable.
    quiet(wt)
    code, (result,) = run(wt, inventory_suffix=suffix)
    assert code == 1
    assert result["verdict"] == "keep"
    assert "inventory" in str(result["reasons"])


def test_git_resolution_never_uses_path(wt: Worktrees) -> None:
    marker = wt.bin / "fake-git-ran"
    adapter(wt.bin, "git", f"from pathlib import Path\nPath({str(marker)!r}).touch()\n")
    quiet(wt)
    code, (result,) = run(wt)
    assert not marker.exists()
    assert code == 0
    assert result["verdict"] == "eligible", result


def test_external_borrower_scope_is_required(wt: Worktrees) -> None:
    borrower = wt.repo.parent / "external"
    init(borrower)
    objects = wt.admin / "objects"
    objects.mkdir()
    gitdir = borrower / ".git"
    (gitdir / "objects/info/alternates").write_text(f"{objects}\n")
    assert os.fsencode(borrower) not in git(wt.repo, "worktree", "list", "--porcelain", "-z")
    quiet(wt)
    for roots, reason in [(None, "complete external borrower scope"), ((gitdir,), "borrows objects")]:
        code, (result,) = run(wt, borrower_gitdirs=roots)
        assert code == 0
        assert result["verdict"] == "keep"
        assert reason in str(result["reasons"])


@pytest.mark.parametrize("kind", ["file", "directory"])
def test_nested_repo_stash_is_not_visible_to_outer_status(wt: Worktrees, kind: str) -> None:
    src = wt.path / "src"
    src.mkdir()
    tracked = src / "tracked"
    tracked.write_text("saved\n")
    git(wt.path, "add", "src")
    git(wt.path, "commit", "-m", "Track src")
    wt.pr["headRefOid"] = git(wt.path, "rev-parse", "HEAD").decode().strip()
    opts = ("--separate-git-dir", str(wt.repo.parent / "nested-admin")) if kind == "file" else ()
    git(src, "init", "--template=", *opts)
    git(src, "add", "tracked")
    git(src, "commit", "-m", "Nested base")
    tracked.write_text("stash this\n")
    git(src, "stash", "push")
    assert git(src, "stash", "list")
    assert git(wt.path, "status", "--porcelain", "--ignored") == b""
    quiet(wt)
    keep(wt, "nested Git metadata")


@pytest.mark.parametrize("attr", ["text eol=lf", "text=auto"])
def test_mixed_endings_are_hidden_by_status(wt: Worktrees, attr: str) -> None:
    attrs = wt.path / ".gitattributes"
    attrs.write_text(f"tracked {attr}\n")
    target = wt.path / "tracked"
    target.write_bytes(b"one\ntwo\n")
    git(wt.path, "add", ".")
    git(wt.path, "commit", "-m", "Normalize line endings")
    wt.pr["headRefOid"] = git(wt.path, "rev-parse", "HEAD").decode().strip()
    target.write_bytes(b"one\r\ntwo\n")
    git(wt.path, "-c", "core.safecrlf=false", "add", "--renormalize", "tracked")
    assert git(wt.path, "-c", "core.safecrlf=false", "status", "--porcelain") == b""
    quiet(wt)
    keep(wt, "built-in conversion attributes")


@pytest.mark.parametrize(("key", "value"), [("autocrlf", "input"), ("eol", "crlf"), ("safecrlf", "warn")])
def test_effective_conversion_cfg_keeps(wt: Worktrees, key: str, value: str) -> None:
    git(wt.path, "config", f"core.{key}", value)
    quiet(wt)
    keep(wt, f"conversion config: core.{key}")


def test_file_written_during_pr_view_keeps(wt: Worktrees) -> None:
    recovery = wt.path / "ignored"
    quiet(wt)
    keep(wt, "dirty or ignored paths", SWEEP_WRITE_DURING_VIEW=str(recovery))
    assert recovery.read_text() == "recovery"


def test_old_reflog_oid_protects_detached_commit(wt: Worktrees) -> None:
    git(wt.path, "switch", "--detach")
    git(wt.path, "commit", "--allow-empty", "-m", "Detached work")
    oid = git(wt.path, "rev-parse", "HEAD").strip()
    git(wt.path, "switch", "merged")
    git(wt.path, "reflog", "delete", "HEAD@{1}")
    assert oid not in git(wt.path, "reflog", "show", "--format=%H", "HEAD")
    assert any(line.startswith(oid + b" ") for line in (wt.admin / "logs/HEAD").read_bytes().splitlines())
    quiet(wt)
    keep(wt, "HEAD reflog commits outside refs")


@pytest.mark.parametrize(
    ("data", "reason"),
    [
        (b"truncated", "incomplete"),
        (b"garbage\n", "malformed HEAD reflog record"),
        (b"0 0 name <a@b> 123 +0000\n", "malformed HEAD reflog OID"),
        (b"0" * 64 + b" {head} name <a@b> 123 +0000\n", "malformed HEAD reflog OID"),
        (b"0" * 40 + b" {head} name <a@b> 123 +0000\t\xff\n", "non-UTF-8 HEAD reflog"),
        (b"0" * 40 + b" {head} n\0ame <a@b> 123 +0000\n", "malformed HEAD reflog record"),
        (b"0" * 40 + b" " + b"0" * 40 + b" name <a@b> 123 +0000\n", "no HEAD reflog commit evidence"),
    ],
)
def test_incomplete_nonempty_head_reflog_keeps(wt: Worktrees, data: bytes, reason: str) -> None:
    (wt.admin / "logs/HEAD").write_bytes(data.replace(b"{head}", git(wt.path, "rev-parse", "HEAD").strip()))
    if data == b"garbage\n":
        branch_log = wt.repo / ".git/logs/refs/heads/merged"
        branch_log.unlink()
        assert git(wt.path, "reflog", "show", "--format=%H", "HEAD") == b""
    quiet(wt)
    keep(wt, reason)


def test_incomplete_nested_scan_keeps(wt: Worktrees) -> None:
    quiet(wt)
    keep(wt, "incomplete nested repository scan", SWEEP_ENTRY_LIMIT="1")


def test_nested_registered_checkout_keeps(wt: Worktrees) -> None:
    git(wt.repo, "worktree", "add", "-b", "nested", str(wt.path / "nested"))
    quiet(wt)
    keep(wt, "another checkout is inside the candidate")


def test_uninitialized_gitlink_keeps(wt: Worktrees) -> None:
    head = str(wt.pr["headRefOid"])
    git(wt.path, "update-index", "--add", "--cacheinfo", f"160000,{head},sub")
    git(wt.path, "commit", "-m", "Record a gitlink")
    wt.pr["headRefOid"] = git(wt.path, "rev-parse", "HEAD").decode().strip()
    quiet(wt)
    keep(wt, "registered submodule")


def test_lock_during_remote_proof_keeps(wt: Worktrees) -> None:
    quiet(wt)
    keep(wt, "inventory or HEAD changed", SWEEP_LOCK_DURING_VIEW=str(wt.admin / "locked"))
    assert b"\0locked locked during remote proof\0" in git(wt.repo, "worktree", "list", "--porcelain", "-z")


@pytest.mark.parametrize(
    "raw",
    [
        b"worktree Relative\0bare\0\0",
        b"worktree /absolute\0HEAD bad\0\0",
        b"worktree /absolute\0HEAD " + b"1" * 40 + b"\0branch refs/heads/\0\0",
        b"worktree /absolute\0HEAD " + b"1" * 40 + b"\0branch refs/heads/bad-\xff\0\0",
    ],
)
def test_invalid_inventory_identity_keeps(raw: bytes) -> None:
    guard = runpy.run_path(str(GUARD))
    with pytest.raises(guard["KeepError"], match="invalid worktree inventory"):
        guard["parse_inventory"](raw)


def test_shipped_skills_keep_claimed_scratch_at_handback() -> None:
    skills = GUARD.parent.parent
    worker = (GUARD.parent / "SKILL.md").read_text()
    parent = (skills / "get-it-merged/SKILL.md").read_text()
    assert "Before handback, leave scratch in place" in worker
    assert "Before handback, remove" not in worker
    assert "With the shipped guard, do not delete scratch" in parent


def test_shipped_program_uses_python_38_grammar() -> None:
    ast.parse(GUARD.read_text(), feature_version=(3, 8))
