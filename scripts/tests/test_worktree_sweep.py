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
from collections.abc import Callable
from pathlib import Path
from shlex import quote
from textwrap import dedent
from typing import Any, NamedTuple
from unittest.mock import Mock

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.append(str(ROOT / "tests/integration"))
from harness.git_fixture import GIT_IDENTITY, git_env

GUARD = ROOT / "packages/preset/skills/ship-issue/sweep_guard.py"
BASE = "owner/project"
GUARD_MODULE = runpy.run_path(str(GUARD))
GIT = GUARD_MODULE["binary"](GUARD_MODULE["GIT_LOCATIONS"], "git")
TIMEOUT = 45
Hook = Callable[..., Any]


class Worktrees(NamedTuple):
    """Real Git paths plus external evidence provided by fixture adapters."""

    repo: Path
    path: Path
    admin: Path
    bin: Path
    pr: dict[str, object]


def git(path: Path, *args: str) -> bytes:
    """Run real Git with disposable identity and no inherited repository.

    Parameters:
        path: Path, Directory to run Git in.
        args: str, Git arguments.
    Returns:
        bytes: Combined stdout and stderr.
    Raises:
        subprocess.CalledProcessError: Git failed.
        subprocess.TimeoutExpired: Git exceeded the fixture timeout.
    """
    return subprocess.check_output(
        [str(GIT), *GIT_IDENTITY, "-C", str(path), *args],
        env=git_env(),
        timeout=TIMEOUT,
        stderr=subprocess.STDOUT,
    )


def init(path: Path) -> None:
    """Create a repository with a tracked file and an ignored path.

    Parameters:
        path: Path, New fixture repository root.
    Returns:
        None.
    Raises:
        OSError: The fixture paths could not be created.
        subprocess.SubprocessError: Git setup failed.
    """
    path.mkdir()
    git(path, "init", "--template=")
    (path / "tracked").write_text("saved\n")
    (path / ".gitignore").write_text("/ignored\n")
    git(path, "add", ".")
    git(path, "commit", "-m", "Base")


def adapter(path: Path, name: str, body: str) -> None:
    """Install a disposable non-Git evidence provider.

    Parameters:
        path: Path, Directory for the executable.
        name: str, Executable name.
        body: str, Python source after the shebang.
    Returns:
        None.
    Raises:
        OSError: The adapter could not be written or made executable.
    """
    cmd = path / name
    cmd.write_text(f"#!{sys.executable}\n" + dedent(body))
    cmd.chmod(0o755)


@pytest.fixture
def wt(tmp_path: Path) -> Worktrees:
    """Create a linked worktree with a strict GH CLI adapter and a process snapshot.

    Parameters:
        tmp_path: Path, Disposable fixture root.
    Returns:
        Worktrees: Paths and merged PR evidence.
    Raises:
        OSError: A fixture file could not be prepared.
        subprocess.SubprocessError: Git setup failed.
    """
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
        import json
        import os
        import sys
        from pathlib import Path

        evidence = json.loads(Path(__file__).with_name("evidence.json").read_text())
        base = evidence["SWEEP_BASE"]
        args = sys.argv[1:]
        list_args = ["pr", "list", "--repo", base, "--state", "all", "--head", "merged",
                     "--limit", "100", "--json", "number,state"]
        view_fields = "headRefName,headRepository,headRepositoryOwner,headRefOid,state,url"
        if args == list_args:
            print(evidence["SWEEP_LIST"])
        elif args == ["pr", "view", "123", "--repo", base, "--json", view_fields]:
            if recovery := evidence.get("SWEEP_WRITE_DURING_VIEW"):
                target = Path(recovery)
                target.write_text("recovery")
                os.utime(target.parent, (1, 1))
            if locked := evidence.get("SWEEP_LOCK_DURING_VIEW"):
                Path(locked).write_text("locked during remote proof")
            print(evidence["SWEEP_PR"])
        else:
            sys.exit(f"unexpected arguments: {args!r}")
        sys.stderr.write(evidence.get("SWEEP_WARNING", ""))
        """,
    )
    adapter(
        bin_dir,
        "lsof",
        """
        import json
        import os
        import sys
        from pathlib import Path

        evidence = json.loads(Path(__file__).with_name("evidence.json").read_text())
        sys.stdout.buffer.write(b"p123\\0\\nn" + os.fsencode(evidence["SWEEP_CWD"]) + b"\\0\\n")
        """,
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
    """Set activity markers far outside the quiet period without sleeping.

    Parameters:
        wt: Worktrees, Candidate checkout and metadata.
    Returns:
        None.
    Raises:
        OSError: A fixture timestamp could not be changed.
    """
    for path in (wt.path, wt.admin / "index", wt.admin / "HEAD", wt.admin / "logs/HEAD"):
        if path.exists():
            os.utime(path, (1, 1))


def adapter_evidence(wt: Worktrees, base: str) -> dict[str, str]:
    """Return the explicit evidence used by the disposable gh and lsof adapters."""
    return {
        "SWEEP_BASE": base,
        "SWEEP_LIST": '[{"number": 123, "state": "MERGED"}]',
        "SWEEP_PR": json.dumps(wt.pr),
        "SWEEP_CWD": str(wt.repo),
    }


def run(
    wt: Worktrees,
    *args: str,
    all_paths: bool = False,
    cwd: Path | None = None,
    base: str = BASE,
    variables: dict[str, str] | None = None,
    borrower_gitdirs: tuple[Path, ...] | None = None,
    inventory_suffix: bytes = b"",
) -> tuple[int, list[dict[str, object]]]:
    """Run with evidence adapters; expose the future assessment seam only with explicit scope.

    Parameters:
        wt: Worktrees, Checkout and evidence fixture.
        args: str, Extra CLI arguments.
        all_paths: bool, Scan all registered paths instead of just the candidate.
        cwd: Path | None, Override the process working directory.
        base: str, Base GitHub repository identity.
        variables: dict[str, str] | None, Explicit fixture controls.
        borrower_gitdirs: tuple[Path, ...] | None, Closed scope for internal assessment only.
        inventory_suffix: bytes, Optional corruption appended to the inventory record.
    Returns:
        tuple[int, list[dict[str, object]]]: Exit status and decoded verdict records.
    Raises:
        subprocess.TimeoutExpired: The guard exceeded the fixture timeout.
        AssertionError: The child wrote unexpected diagnostics.
        json.JSONDecodeError: A record is not JSON.
    """
    env = {key: value for key, value in git_env().items() if not key.startswith("SWEEP_")}
    env.pop("GH_HOST", None)
    env |= {"PATH": f"{wt.bin}{os.pathsep}{env['PATH']}"} | (variables or {})
    evidence = adapter_evidence(wt, base) | {
        key: env[key]
        for key in (
            "SWEEP_CWD",
            "SWEEP_LIST",
            "SWEEP_WARNING",
            "SWEEP_WRITE_DURING_VIEW",
            "SWEEP_LOCK_DURING_VIEW",
        )
        if key in env
    }
    (wt.bin / "evidence.json").write_text(json.dumps(evidence))
    if borrower_gitdirs is not None:
        env["SWEEP_SCOPE"] = json.dumps(list(map(str, borrower_gitdirs)))
    if inventory_suffix:
        env["SWEEP_INVENTORY_SUFFIX"] = inventory_suffix.hex()
    scope = [] if all_paths else ["--worktree", str(wt.path)]
    done = subprocess.run(
        [
            sys.executable,
            "-c",
            "import json, os, runpy, subprocess, sys; from pathlib import Path; "
            "source, git, gh, lsof = sys.argv[1:5]; sys.argv[1:5] = []; "
            "scope = os.getenv('SWEEP_SCOPE'); "
            "scope_kwargs = {} if scope is None else "
            "{'borrower_gitdirs': tuple(map(Path, json.loads(scope)))}; "
            "receipt = os.getenv('SWEEP_RECORD_GIT'); run = subprocess.run; "
            "record = lambda cmd: Path(receipt).open('a').write(json.dumps(cmd) + '\\n'); "
            "subprocess.run = lambda cmd, *args, **kw: "
            "((record(cmd) if receipt and cmd[0] == git else None), run(cmd, *args, **kw))[1]; "
            "module = runpy.run_path(source); main = module['main']; "
            "parse = module['parse_inventory']; "
            "globals_ = main.__globals__; "
            "limit = 'MAX_TREE_ENTRIES'; "
            "globals_[limit] = int(os.getenv('SWEEP_ENTRY_LIMIT', globals_[limit])); "
            "byte_limit = 'MAX_CONTENT_BYTES'; "
            "globals_[byte_limit] = int(os.getenv('SWEEP_CONTENT_BYTE_LIMIT', globals_[byte_limit])); "
            "suffix = bytes.fromhex(os.getenv('SWEEP_INVENTORY_SUFFIX', '')); "
            "main.__globals__['parse_inventory'] = "
            "lambda raw, width: parse(raw[:-1] + suffix if suffix else raw, width); "
            "attrs = os.getenv('SWEEP_ACTIVATE_FILTER'); "
            "check_status = globals_['check_status']; "
            "globals_['check_status'] = check_status if attrs is None else "
            "lambda path, admin: (Path(attrs).write_text('tracked filter=mark\\n'), "
            "check_status(path, admin))[1]; "
            "if_fixture = (lambda path, decision, reason, **_: "
            "print(json.dumps(dict(worktree=str(path), verdict=decision, reasons=[reason])))); "
            "globals_['verdict'] = if_fixture if scope_kwargs else globals_['verdict']; "
            "globals_['assess'] = (lambda *args: 'eligible') "
            "if os.getenv('SWEEP_FORCE_ASSESS') else globals_['assess']; "
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
    """Assert the selected candidate has a specific keep reason, not an unrelated failure.

    Parameters:
        wt: Worktrees, Candidate and evidence fixture.
        reason: str, Required fragment of a keep reason.
        args: str, Extra CLI arguments.
        variables: str, Explicit fixture controls.
    Returns:
        None.
    Raises:
        AssertionError: The expected keep verdict was not reported.
    """
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
def test_future_seam_allows_clean_merged_tree_without_upstream(wt: Worktrees, url: str) -> None:
    git(wt.path, "remote", "set-url", "origin", url)
    quiet(wt)
    code, (main, result) = run(wt, all_paths=True, borrower_gitdirs=())
    assert code == 0
    assert main["verdict"] == "keep"
    assert "main or bare" in str(main["reasons"])
    assert result["verdict"] == "eligible", result
    assert "#123" in str(result["reasons"])
    assert wt.path.is_dir()
    assert wt.admin.is_dir()
    assert git(wt.repo, "show-ref", "--verify", "refs/heads/merged")


@pytest.mark.parametrize("case", ["clean", "borrowed scratch", "inventory error", "no match"])
def test_unknown_scope_is_keep_only_with_fixture_evidence(wt: Worktrees, case: str) -> None:
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
    code, results = run(wt, *args, all_paths=case == "clean", variables=variables)
    assert code == (1 if case in {"inventory error", "no match"} else 0)
    assert len(results) == (2 if case == "clean" else 1)
    for result in results:
        assert result["verdict"] == "keep"
        reasons = tuple(map(str, result["reasons"])) if isinstance(result["reasons"], list) else ()
        assert reasons[0] == "cannot establish a complete external borrower scope"
    if case == "clean":
        assert results[-1]["reasons"] == [
            "cannot establish a complete external borrower scope",
            "status not collected: `git status` was not run",
        ]
    if case == "borrowed scratch":
        assert "untracked or ignored paths" in str(results[0]["reasons"])
        assert "cache.git/" in str(results[0]["reasons"])


def test_shipped_cli_is_keep_only(wt: Worktrees) -> None:
    quiet(wt)
    receipt = wt.bin / "gh-calls"
    # Enter through the real __main__; replace only the two external evidence
    # providers. Git, argument parsing, assessment and verdict output stay real.
    (wt.bin / "sitecustomize.py").write_text(
        dedent(
            """\
            import subprocess
            from pathlib import Path

            run = subprocess.run
            fixtures = Path(__file__).parent

            def with_evidence_provider(cmd, *args, **kwargs):
                name = Path(cmd[0]).name
                if name in {"gh", "lsof"}:
                    if name == "gh":
                        with (fixtures / "gh-calls").open("a") as receipt:
                            receipt.write(cmd[2] + "\\n")
                    cmd = [str(fixtures / name), *cmd[1:]]
                return run(cmd, *args, **kwargs)

            subprocess.run = with_evidence_provider
            """
        )
    )
    (wt.bin / "evidence.json").write_text(json.dumps(adapter_evidence(wt, BASE)))
    env = git_env() | {
        "PYTHONPATH": str(wt.bin),
        "GH_HOST": "github.com",
        "SWEEP_SCOPE": "[]",
        "SWEEP_FORCE_ASSESS": "1",
    }
    done = subprocess.run(
        [sys.executable, str(GUARD), str(wt.repo), BASE, "--worktree", str(wt.path)],
        cwd=wt.repo,
        env=env,
        capture_output=True,
        check=False,
        text=True,
        timeout=TIMEOUT,
    )
    assert done.returncode == 0, done.stderr
    assert not done.stderr
    assert json.loads(done.stdout) == {
        "worktree": str(wt.path.resolve()),
        "verdict": "keep",
        "reasons": [
            "cannot establish a complete external borrower scope",
            "status not collected: `git status` was not run",
        ],
    }
    assert receipt.read_text().splitlines() == ["list", "view"]


def test_fixture_launcher_scrubs_inherited_assessment_controls(
    wt: Worktrees, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("SWEEP_SCOPE", "[]")
    monkeypatch.setenv("SWEEP_FORCE_ASSESS", "1")
    (wt.path / "untracked").touch()
    quiet(wt)
    code, (result,) = run(wt)
    assert code == 0
    assert result["verdict"] == "keep"
    reasons = result["reasons"]
    assert isinstance(reasons, list)
    assert reasons[0] == "cannot establish a complete external borrower scope"
    assert "untracked or ignored paths" in str(reasons)


def test_cli_output_cannot_emit_eligible_when_assess_returns_eligible(wt: Worktrees) -> None:
    code, (result,) = run(wt, variables={"SWEEP_FORCE_ASSESS": "1"})
    assert code == 0
    assert result["verdict"] == "keep"
    assert result["reasons"] == [
        "cannot establish a complete external borrower scope",
        "status not collected: `git status` was not run",
    ]


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
    code, (result,) = run(wt, borrower_gitdirs=None)
    assert code == 0
    assert result["verdict"] == "keep"
    expected = "tracked content or mode differs from index: b'tracked'" if name == "tracked" else name
    assert expected in str(result["reasons"])


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


def closed_scope(wt: Worktrees) -> dict[str, object]:
    """Return the internal assessment for the candidate under an explicit closed scope.

    Parameters:
        wt: Worktrees, Candidate and evidence fixture.
    Returns:
        dict[str, object]: The single fixture verdict record.
    Raises:
        AssertionError: The scan did not produce exactly one record.
    """
    code, (result,) = run(wt, borrower_gitdirs=())
    assert code == 0
    return result


@pytest.mark.parametrize("edited", [False, True])
def test_disabled_trustctime_same_size_edit_with_restored_mtime(wt: Worktrees, edited: bool) -> None:
    git(wt.path, "config", "core.trustctime", "false")
    target = wt.path / "tracked"
    os.utime(target, (1, 1))
    git(wt.path, "update-index", "--refresh")
    original = target.stat()
    target.write_text("other\n" if edited else "saved\n")
    os.utime(target, ns=(original.st_atime_ns, original.st_mtime_ns))
    assert git(wt.path, "status", "--porcelain") == b""
    raw = git(wt.path, "hash-object", "--no-filters", "tracked")
    assert (raw != git(wt.path, "rev-parse", "HEAD:tracked")) is edited
    quiet(wt)
    os.utime(wt.admin / "index", (10, 10))
    assert git(wt.path, "--no-optional-locks", "status", "--porcelain") == b""
    result = closed_scope(wt)
    if edited:
        assert result["verdict"] == "keep"
        assert result["reasons"] == ["tracked content or mode differs from index: b'tracked'"]
    else:
        assert result["verdict"] == "eligible", result


@pytest.mark.parametrize("change", ["executable", "link target"])
def test_tracked_mode_or_link_change_keeps(wt: Worktrees, change: str) -> None:
    name = "tracked"
    if change == "executable":
        (wt.path / name).chmod(0o755)
    else:
        name = "link"
        (wt.path / name).symlink_to("aaaa")
        git(wt.path, "add", name)
        git(wt.path, "commit", "-m", "Link")
        wt.pr["headRefOid"] = git(wt.path, "rev-parse", "HEAD").decode().strip()
        (wt.path / name).unlink()
        (wt.path / name).symlink_to("bbbb")
    quiet(wt)
    result = closed_scope(wt)
    assert result["verdict"] == "keep"
    assert result["reasons"] == [f"tracked content or mode differs from index: b'{name}'"]


@pytest.mark.parametrize("change", ["symlink to copy", "fifo", "deleted", "symlinked parent"])
def test_content_check_alone_keeps_replaced_entries(
    wt: Worktrees, monkeypatch: pytest.MonkeyPatch, change: str
) -> None:
    # Earlier line-ending and untracked checks also keep these end to end.
    target = wt.path / "tracked"
    copy = wt.repo.parent / "copy"
    copy.mkdir()
    (copy / "tracked").write_bytes(target.read_bytes())
    target.unlink()
    expected = "tracked content or mode differs from index: b'tracked'"
    if change == "symlink to copy":
        target.symlink_to(copy / "tracked")
    elif change == "fifo":
        os.mkfifo(target)
    elif change == "deleted":
        expected = "No such file"
    else:
        expected = "cannot open tracked parent without following links: b'dir/tracked'"
        git(wt.path, "update-index", "--force-remove", "tracked")
        blob = git(wt.repo, "rev-parse", "HEAD:tracked").decode().strip()
        git(wt.path, "update-index", "--add", "--cacheinfo", f"100644,{blob},dir/tracked")
        (wt.path / "dir").symlink_to(copy)
    monkeypatch.setattr(os, "environ", git_env())
    with pytest.raises((GUARD_MODULE["KeepError"], OSError), match=expected) as caught:
        GUARD_MODULE["check_content"](wt.path.resolve())
    if change == "symlinked parent":
        cause = caught.value.__cause__
        assert isinstance(cause, OSError)
        assert str(caught.value).endswith(f": {cause}")


def test_unchanged_tracked_symlink_and_executable_are_clean(wt: Worktrees) -> None:
    (wt.path / "link").symlink_to("tracked")
    (wt.path / "tool").write_text("#!/bin/sh\n")
    (wt.path / "tool").chmod(0o755)
    git(wt.path, "add", "link", "tool")
    git(wt.path, "commit", "-m", "Link and tool")
    wt.pr["headRefOid"] = git(wt.path, "rev-parse", "HEAD").decode().strip()
    quiet(wt)
    result = closed_scope(wt)
    assert result["verdict"] == "eligible", result


def test_sha256_content_check(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "--template=", "--object-format=sha256")
    (repo / "tracked").write_text("saved\n")
    git(repo, "add", "tracked")
    monkeypatch.setattr(os, "environ", git_env())
    GUARD_MODULE["check_content"](repo.resolve())
    (repo / "tracked").write_text("other\n")
    with pytest.raises(GUARD_MODULE["KeepError"], match="tracked content or mode differs from index"):
        GUARD_MODULE["check_content"](repo.resolve())


def test_unmerged_index_entry_keeps(wt: Worktrees, monkeypatch: pytest.MonkeyPatch) -> None:
    git(wt.path, "switch", "-c", "side")
    (wt.path / "tracked").write_text("side\n")
    git(wt.path, "commit", "-am", "Side")
    git(wt.path, "switch", "merged")
    (wt.path / "tracked").write_text("main\n")
    git(wt.path, "commit", "-am", "Main")
    with pytest.raises(subprocess.CalledProcessError):
        git(wt.path, "merge", "side")
    monkeypatch.setattr(os, "environ", git_env())
    with pytest.raises(GUARD_MODULE["KeepError"], match="unsupported index entry"):
        GUARD_MODULE["check_content"](wt.path.resolve())


@pytest.mark.parametrize(
    ("stage", "reason"),
    [
        (b"100644 " + b"a" * 40 + b" 0\ttracked", "incomplete index inventory"),
        (b"100644 " + b"a" * 64 + b" 0\ttracked\0", "unsupported index entry"),
        (b"100644 " + b"a" * 40 + b" 0\tdir/../tracked\0", "unsupported index path"),
    ],
)
def test_malformed_index_inventory_keeps(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stage: bytes, reason: str
) -> None:
    replies = {"rev-parse": b"sha1\n", "ls-files": stage}
    check = GUARD_MODULE["check_content"]
    monkeypatch.setitem(check.__globals__, "git", lambda _path, command, *_args: replies[command])
    with pytest.raises(GUARD_MODULE["KeepError"], match=reason):
        check(tmp_path)


def fail_read(message: str) -> bytes:
    """Fail a test that reads when the scan budget says it must not.

    Parameters:
        message: str, Assertion text.
    Returns:
        bytes: Never returns.
    Raises:
        AssertionError: Always.
    """
    raise AssertionError(message)


def hash_with(
    root: Path, name: bytes, monkeypatch: pytest.MonkeyPatch, **hooks: Callable[[Hook], Hook]
) -> tuple[bytes, str]:
    """Hash one entry directly with `os` calls wrapped to inject a concurrent change.

    Parameters:
        root: Path, Resolved fixture root.
        name: bytes, Entry path relative to the root.
        monkeypatch: pytest.MonkeyPatch, Fixture patcher.
        hooks: Callable[[Hook], Hook], Wrappers keyed by `os` function name; each receives the original.
    Returns:
        tuple[bytes, str]: Git mode and raw blob object ID.
    Raises:
        KeepError: The guard keeps the entry.
    """
    blob = GUARD_MODULE["blob"]
    monkeypatch.setitem(blob.__globals__, "CHUNK", 4)
    for attr, wrap in hooks.items():
        monkeypatch.setattr(os, attr, wrap(getattr(os, attr)))
    mode, oid, _ = blob(
        root, name, "sha1", remaining=GUARD_MODULE["MAX_CONTENT_BYTES"], deadline=float("inf")
    )
    return mode, oid


def test_fifo_swapped_in_after_stat_keeps(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    target = tmp_path / "tracked"
    target.write_text("saved\n")

    def swap(real: Hook) -> Hook:
        def opened(path: object, flags: int, *args: object, **kwargs: object) -> int:
            if path == b"tracked":
                assert flags & os.O_NONBLOCK
                target.unlink()
                os.mkfifo(target)
            return real(path, flags, *args, **kwargs)

        return opened

    read = Mock(side_effect=AssertionError("read called on swapped FIFO"))
    with pytest.raises(GUARD_MODULE["KeepError"], match="tracked entry is not a regular file: b'tracked'"):
        hash_with(tmp_path.resolve(), b"tracked", monkeypatch, open=swap, read=lambda _real: read)
    read.assert_not_called()


@pytest.mark.parametrize(
    "change", ["rewrite consumed chunk", "replace after read", "rewrite after fstat", "chmod after fstat"]
)
def test_edit_consumed_chunk_during_hash_keeps(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, change: str
) -> None:
    target = tmp_path / "tracked"
    target.write_bytes(b"0123456789abcdef")
    original = target.stat()
    calls = {"read": 0, "fstat": 0}

    def rewrite(real: Hook) -> Hook:
        def read(descriptor: int, size: int) -> bytes:
            calls["read"] += 1
            if calls["read"] == 2:
                with target.open("r+b") as handle:
                    handle.write(b"WXYZ")
                os.utime(target, ns=(original.st_atime_ns, original.st_mtime_ns))
            return real(descriptor, size)

        return read

    def replace(real: Hook) -> Hook:
        def fstat(descriptor: int) -> os.stat_result:
            result = real(descriptor)
            calls["fstat"] += 1
            if calls["fstat"] == 2:
                if change == "replace after read":
                    copy = tmp_path / "copy"
                    copy.write_bytes(b"0123456789abcdef")
                    copy.replace(target)
                elif change == "rewrite after fstat":
                    target.write_bytes(b"abcdefghijklmnop")
                    os.utime(target, ns=(original.st_atime_ns, original.st_mtime_ns + 1_000_000_000))
                else:
                    target.chmod(0o755)
            return result

        return fstat

    hooks = {"read": rewrite} if change == "rewrite consumed chunk" else {"fstat": replace}
    with pytest.raises(GUARD_MODULE["KeepError"], match="tracked entry changed during hash: b'tracked'"):
        hash_with(tmp_path.resolve(), b"tracked", monkeypatch, **hooks)
    assert calls["read" if change == "rewrite consumed chunk" else "fstat"] >= 2


def test_multi_chunk_hash_matches_git(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    target = tmp_path / "tracked"
    target.write_bytes(b"0123456789abcdef!")
    expected = git(tmp_path, "hash-object", "--no-filters", "tracked").decode().strip()
    assert hash_with(tmp_path.resolve(), b"tracked", monkeypatch) == (b"100644", expected)


def test_parent_swap_during_hash_keeps(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    for parent in (tmp_path / "dir", tmp_path / "outside"):
        parent.mkdir()
        (parent / "tracked").write_text("saved\n")

    def swap(real: Hook) -> Hook:
        def opened(path: object, flags: int, *args: object, **kwargs: object) -> int:
            if path == b"tracked":
                (tmp_path / "dir").rename(tmp_path / "moved")
                (tmp_path / "dir").symlink_to(tmp_path / "outside")
            return real(path, flags, *args, **kwargs)

        return opened

    with pytest.raises(GUARD_MODULE["KeepError"], match="tracked parent changed during hash: b'dir/tracked'"):
        hash_with(tmp_path.resolve(), b"dir/tracked", monkeypatch, open=swap)


def test_symlink_replaced_after_readlink_keeps(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    target = tmp_path / "tracked"
    target.symlink_to("same")

    def replace(real: Hook) -> Hook:
        def readlink(*args: object, **kwargs: object) -> bytes:
            result = real(*args, **kwargs)
            target.unlink()
            target.symlink_to("same")
            return result

        return readlink

    with pytest.raises(GUARD_MODULE["KeepError"], match="tracked entry changed during hash"):
        hash_with(tmp_path.resolve(), b"tracked", monkeypatch, readlink=replace)


def test_outer_parent_replaced_during_recheck_keeps(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    inner = tmp_path / "outer" / "inner"
    inner.mkdir(parents=True)
    (inner / "tracked").write_text("saved")

    def swap(real: Hook) -> Hook:
        def checked(path: object, *args: object, **kwargs: object) -> os.stat_result:
            result = real(path, *args, **kwargs)
            if path == b"inner":
                (tmp_path / "outer").rename(tmp_path / "moved")
                (tmp_path / "outer").symlink_to(tmp_path / "moved")
            return result

        return checked

    with pytest.raises(GUARD_MODULE["KeepError"], match="tracked parent changed during hash"):
        hash_with(tmp_path.resolve(), b"outer/inner/tracked", monkeypatch, stat=swap)


def test_directory_cleanup_continues_after_close_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    directory = tmp_path / "dir"
    directory.mkdir()
    (directory / "tracked").write_text("saved")
    opened: list[int] = []
    closed: list[int] = []

    def record_open(real: Hook) -> Hook:
        def opened_fd(path: object, flags: int, *args: object, **kwargs: object) -> int:
            fd = real(path, flags, *args, **kwargs)
            if flags & os.O_DIRECTORY:
                opened.append(fd)
            return fd

        return opened_fd

    def fail_close(real: Hook) -> Hook:
        def close(fd: int) -> None:
            closed.append(fd)
            real(fd)
            if fd == opened[-1]:
                raise OSError("injected close failure")

        return close

    with pytest.raises(OSError, match="injected close failure"):
        hash_with(tmp_path.resolve(), b"dir/tracked", monkeypatch, open=record_open, close=fail_close)
    assert closed[-2:] == list(reversed(opened))


@pytest.mark.parametrize(
    "overrun",
    [
        "entry limit",
        "symlink bytes",
        "file size before read",
        "cumulative bytes across files",
        "grown file during read",
    ],
)
def test_content_scan_entry_or_byte_overrun_keeps(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, overrun: str
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "--template=")
    (repo / "a").write_bytes(b"01234567")
    (repo / "b").write_bytes(b"89abcdef")
    (repo / "link").symlink_to("target")
    git(repo, "add", "a", "b", "link")
    monkeypatch.setattr(os, "environ", git_env())
    check = GUARD_MODULE["check_content"]
    globals_ = check.__globals__
    monkeypatch.setitem(globals_, "CHUNK", 4)
    if overrun == "entry limit":
        monkeypatch.setitem(globals_, "MAX_TREE_ENTRIES", 2)
    elif overrun == "symlink bytes":
        (repo / "a").unlink()
        (repo / "b").unlink()
        git(repo, "rm", "--quiet", "a", "b")
        monkeypatch.setitem(globals_, "MAX_CONTENT_BYTES", 5)
    elif overrun == "file size before read":
        monkeypatch.setitem(globals_, "MAX_CONTENT_BYTES", 7)
        real_read = os.read
        monkeypatch.setattr(
            os,
            "read",
            lambda fd, size: (
                fail_read("read called past preflight size budget") if size == 4 else real_read(fd, size)
            ),
        )
    elif overrun == "cumulative bytes across files":
        monkeypatch.setitem(globals_, "MAX_CONTENT_BYTES", 12)
    else:
        monkeypatch.setitem(globals_, "MAX_CONTENT_BYTES", 8)
        real_read = os.read
        calls = {"read": 0}

        def grow_on_first_chunk(descriptor: int, size: int) -> bytes:
            calls["read"] += 1
            if calls["read"] == 1:
                with (repo / "a").open("ab") as handle:
                    handle.write(b"extra")
            return real_read(descriptor, size)

        monkeypatch.setattr(os, "read", grow_on_first_chunk)
    with pytest.raises(GUARD_MODULE["KeepError"], match=r"^incomplete tracked content scan$"):
        check(repo.resolve())


@pytest.mark.parametrize(
    ("overrun", "ticks"),
    [
        # Every case starts with the scan-start read (10.0); 41.0 is past the 30s deadline.
        # start, top-of-loop
        ("entry deadline", (10.0, 41.0)),
        # start, top-of-loop, symlink check in leaf_blob
        ("symlink deadline", (10.0, 20.0, 41.0)),
        # start, top-of-loop, size/deadline check before the first read
        ("file deadline before read", (10.0, 20.0, 41.0)),
        # start, top-of-loop, preflight, first chunk check
        ("chunk deadline during read", (10.0, 20.0, 25.0, 41.0)),
    ],
)
def test_content_scan_deadline_overrun_keeps(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, overrun: str, ticks: tuple[float, ...]
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "--template=")
    if overrun == "symlink deadline":
        (repo / "link").symlink_to("target")
        git(repo, "add", "link")
    else:
        (repo / "a").write_bytes(b"01234567")
        git(repo, "add", "a")
    if overrun == "file deadline before read":
        real_read = os.read
        monkeypatch.setattr(
            os,
            "read",
            lambda fd, size: (
                fail_read("read called past preflight deadline") if size == 4 else real_read(fd, size)
            ),
        )
    monkeypatch.setattr(os, "environ", git_env())
    check = GUARD_MODULE["check_content"]
    globals_ = check.__globals__
    monkeypatch.setitem(globals_, "CHUNK", 4)
    clock = iter(ticks)
    monkeypatch.setattr(globals_["time"], "monotonic", lambda: next(clock))
    with pytest.raises(GUARD_MODULE["KeepError"], match=r"^incomplete tracked content scan$"):
        check(repo.resolve())


def test_content_scan_deadline_expiring_in_last_entry_revalidation_keeps(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "--template=")
    (repo / "a").write_bytes(b"01234567")
    git(repo, "add", "a")
    monkeypatch.setattr(os, "environ", git_env())
    check = GUARD_MODULE["check_content"]
    globals_ = check.__globals__
    monkeypatch.setitem(globals_, "CHUNK", 4)
    now = [10.0]
    armed = [False]
    monkeypatch.setattr(globals_["time"], "monotonic", lambda: now[0])
    real_blob = globals_["blob"]

    def arm(*args: Any, **kwargs: Any) -> Any:
        armed[0] = True
        return real_blob(*args, **kwargs)

    real_stat = os.stat

    def expire_on_revalidation(*args: Any, **kwargs: Any) -> os.stat_result:
        # Only the root parent revalidation passes no dir_fd; it runs after the
        # leaf was read, so the clock crosses the deadline with no next entry.
        if armed[0] and kwargs.get("dir_fd") is None:
            now[0] = 41.0
        return real_stat(*args, **kwargs)

    monkeypatch.setitem(globals_, "blob", arm)
    monkeypatch.setattr(os, "stat", expire_on_revalidation)
    with pytest.raises(GUARD_MODULE["KeepError"], match=r"^incomplete tracked content scan$"):
        check(repo.resolve())


def test_content_scan_exact_byte_budget_allows_clean_worktree(wt: Worktrees) -> None:
    (wt.path / "link").symlink_to("tracked")
    git(wt.path, "add", "link")
    git(wt.path, "commit", "-m", "Add link")
    wt.pr["headRefOid"] = git(wt.path, "rev-parse", "HEAD").decode().strip()
    exact_bytes = sum(
        len(os.fsencode(entry.readlink())) if entry.is_symlink() else entry.stat().st_size
        for entry in (wt.path / ".gitignore", wt.path / "tracked", wt.path / "link")
    )
    quiet(wt)
    code, (result,) = run(wt, borrower_gitdirs=(), variables={"SWEEP_CONTENT_BYTE_LIMIT": str(exact_bytes)})
    assert code == 0
    assert result["verdict"] == "eligible", result
    code, (result,) = run(
        wt, borrower_gitdirs=(), variables={"SWEEP_CONTENT_BYTE_LIMIT": str(exact_bytes - 1)}
    )
    assert code == 0
    assert result["verdict"] == "keep", result
    assert result["reasons"] == ["incomplete tracked content scan"]


@pytest.mark.parametrize("kind", ["modified", "deleted", "intent-to-add"])
def test_staged_change_keeps_under_closed_scope(wt: Worktrees, kind: str) -> None:
    if kind == "modified":
        (wt.path / "tracked").write_text("staged only\n")
        git(wt.path, "add", "tracked")
    elif kind == "deleted":
        git(wt.path, "rm", "--quiet", "tracked")
    else:
        (wt.path / "new").write_bytes(b"")
        git(wt.path, "add", "--intent-to-add", "new")
    assert git(wt.path, "ls-files", "--others") == b""
    quiet(wt)
    code, (result,) = run(wt, borrower_gitdirs=())
    assert code == 0
    assert result["verdict"] == "keep", result
    assert result["reasons"] == ["staged changes: index differs from HEAD"]


def test_staged_change_check_runs_no_configured_diff_program(wt: Worktrees) -> None:
    marker = wt.bin / "diff-program-ran"
    adapter(
        wt.bin,
        "mark-diff",
        f"""
        import sys
        from pathlib import Path

        with Path({str(marker)!r}).open("a") as log:
            log.write(f"{{len(sys.argv) - 1}}\\n")
        print("diff program ran")
        if len(sys.argv) == 2:
            print(Path(sys.argv[1]).read_text(), end="")
        """,
    )
    program = quote(str(wt.bin / "mark-diff"))
    git(wt.path, "config", "diff.external", program)
    git(wt.path, "config", "diff.mark.textconv", program)
    (wt.repo / ".git/info").mkdir(parents=True, exist_ok=True)
    (wt.repo / ".git/info/attributes").write_text("tracked diff=mark\n")
    (wt.path / "tracked").write_text("staged only\n")
    git(wt.path, "add", "tracked")
    quiet(wt)
    code, (result,) = run(wt, borrower_gitdirs=())
    assert not marker.exists()
    assert code == 0
    assert result["reasons"] == ["staged changes: index differs from HEAD"]
    # Positive controls: porcelain diffs of the same index run both programs, which succeed.
    assert b"diff program ran" in git(wt.path, "diff", "--cached")
    assert marker.read_text().split() == ["7"]
    assert b"diff program ran" in git(wt.path, "diff", "--cached", "--no-ext-diff")
    assert set(marker.read_text().split()[1:]) == {"1"}


@pytest.mark.parametrize("head", ["unborn", "missing branch", "missing object"])
def test_staged_check_keeps_when_head_cannot_be_compared(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, head: str
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    repo = tmp_path / "repo"
    if head == "unborn":
        repo.mkdir()
        git(repo, "init", "--template=")
    else:
        init(repo)
    if head == "missing branch":
        git(repo, "symbolic-ref", "HEAD", "refs/heads/gone")
    elif head == "missing object":
        (repo / ".git/refs/heads/main").write_text("1" * 40 + "\n")
    # Every check before the comparison passes; only diff-index can fail here.
    with pytest.raises(GUARD_MODULE["KeepError"], match=r"`git diff-index --cached` failed \(128\)"):
        GUARD_MODULE["check_status"](repo, repo / ".git")


def test_unresolvable_head_in_linked_worktree_keeps(wt: Worktrees) -> None:
    git(wt.path, "symbolic-ref", "HEAD", "refs/heads/gone")
    quiet(wt)
    # End to end, assess fails on HEAD before the status checks; the unit test above
    # proves the comparison itself keeps when HEAD cannot be read.
    code, (result,) = run(wt, borrower_gitdirs=())
    assert code == 0
    assert result["verdict"] == "keep", result
    assert "`git rev-parse --verify` failed (128)" in str(result["reasons"])


def test_unmerged_index_keeps_after_merge_markers_are_gone(wt: Worktrees) -> None:
    (wt.repo / "tracked").write_text("main side\n")
    git(wt.repo, "commit", "--quiet", "-am", "Main side")
    (wt.path / "tracked").write_text("merged side\n")
    git(wt.path, "commit", "--quiet", "-am", "Merged side")
    wt.pr["headRefOid"] = git(wt.path, "rev-parse", "HEAD").decode().strip()
    with pytest.raises(subprocess.CalledProcessError, match="returned non-zero exit status 1"):
        git(wt.path, "merge", "--no-edit", "main")
    assert git(wt.path, "ls-files", "--unmerged")
    quiet(wt)
    code, (result,) = run(wt, borrower_gitdirs=())
    assert code == 0
    assert result["reasons"] == ["in-progress operation `MERGE_HEAD`"]
    for name in ("MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "AUTO_MERGE"):
        (wt.admin / name).unlink(missing_ok=True)
    assert git(wt.path, "ls-files", "--unmerged")
    quiet(wt)
    code, (result,) = run(wt, borrower_gitdirs=())
    assert code == 0
    assert result["verdict"] == "keep", result
    assert result["reasons"] == ["staged changes: index differs from HEAD"]


@pytest.mark.parametrize("flag", ["--assume-unchanged", "--skip-worktree"])
def test_flagged_entry_with_staged_blob_keeps_as_staged(wt: Worktrees, flag: str) -> None:
    (wt.path / "tracked").write_text("staged only\n")
    git(wt.path, "add", "tracked")
    git(wt.path, "update-index", flag, "tracked")
    # The worktree matches HEAD again; only the index blob differs.
    (wt.path / "tracked").write_text("saved\n")
    quiet(wt)
    code, (result,) = run(wt, borrower_gitdirs=())
    assert code == 0
    assert result["verdict"] == "keep", result
    assert result["reasons"] == ["staged changes: index differs from HEAD"]


@pytest.mark.parametrize("change", ["added", "removed"])
def test_staged_gitlink_change_keeps(wt: Worktrees, change: str) -> None:
    oid = git(wt.path, "rev-parse", "HEAD").decode().strip()
    git(wt.path, "update-index", "--add", "--cacheinfo", f"160000,{oid},module")
    if change == "removed":
        git(wt.path, "commit", "--quiet", "-m", "Gitlink")
        wt.pr["headRefOid"] = git(wt.path, "rev-parse", "HEAD").decode().strip()
        git(wt.path, "rm", "--cached", "--quiet", "module")
    quiet(wt)
    code, (result,) = run(wt, borrower_gitdirs=())
    assert code == 0
    assert result["verdict"] == "keep", result
    if change == "removed":
        assert result["reasons"] == ["staged changes: index differs from HEAD"]
    else:
        # A gitlink in the index is held earlier; the comparison still sees it.
        assert "registered submodule" in str(result["reasons"])
        with pytest.raises(GUARD_MODULE["KeepError"], match="staged changes"):
            GUARD_MODULE["check_staged"](wt.path)


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


def test_future_seam_calls_git_prune_only_in_dry_run_mode(wt: Worktrees) -> None:
    trace = wt.bin / "commands.jsonl"
    quiet(wt)
    code, (result,) = run(wt, variables={"SWEEP_RECORD_GIT": str(trace)}, borrower_gitdirs=())
    assert code == 0
    assert result["verdict"] == "eligible", result
    starts = [json.loads(line) for line in trace.read_text().splitlines()]
    assert starts[0] == [str(GIT), "--version"]
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
        ("[]", "upstream not checked"),
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
def test_future_seam_accepts_enterprise_pr_host(wt: Worktrees, base: str, variables: dict[str, str]) -> None:
    git(wt.path, "remote", "set-url", "origin", "git@forge.example:source/project.git")
    wt.pr["url"] = "https://forge.example/owner/project/pull/123"
    quiet(wt)
    code, (result,) = run(wt, base=base, variables=variables, borrower_gitdirs=())
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


@pytest.mark.parametrize(
    ("url", "pr_list", "reason"),
    [
        ("git@github.com:source/project.git", "[]", "upstream not checked"),
        ("https://github.com/source/project.git", "[]", "upstream not checked"),
        (
            "git@github.com:source/project.git",
            '[{"number": 123, "state": "MERGED"}]',
            "`git status` was not run",
        ),
    ],
)
def test_remote_bearing_candidate_never_runs_configured_programs(
    wt: Worktrees, url: str, pr_list: str, reason: str
) -> None:
    git(wt.path, "remote", "set-url", "origin", url)
    git(wt.path, "config", "branch.merged.remote", "origin")
    git(wt.path, "config", "branch.merged.merge", "refs/heads/merged")
    markers = []
    for key in ("core.sshCommand", "credential.helper", "core.fsmonitor"):
        marker = wt.bin / f"{key}.ran"
        markers.append(marker)
        adapter(
            wt.bin,
            key,
            f"from pathlib import Path\nPath({str(marker)!r}).touch()\n",
        )
        git(wt.path, "config", key, str(wt.bin / key))
    quiet(wt)
    code, (result,) = run(wt, variables={"SWEEP_LIST": pr_list})
    assert not [marker for marker in markers if marker.exists()]
    assert code == 0
    assert result["verdict"] == "keep"
    assert reason in str(result["reasons"])


def test_open_pr_remains_a_hold(wt: Worktrees) -> None:
    quiet(wt)
    keep(wt, "open PR", SWEEP_LIST='[{"state":"OPEN"}]')


def track_upstream(wt: Worktrees, remote: str = "origin") -> None:
    """Configure `merged` to track `<remote>/merged` without fetching.

    Parameters:
        wt: Worktrees, Candidate checkout.
        remote: str, Configured upstream remote name.
    Returns:
        None.
    Raises:
        subprocess.SubprocessError: Git setup failed.
    """
    git(wt.path, "config", "branch.merged.remote", remote)
    git(wt.path, "config", "branch.merged.merge", "refs/heads/merged")


@pytest.mark.parametrize(
    ("setup", "reason"),
    [
        ("none", "local upstream unavailable: no configured remote upstream"),
        ("dot", "local upstream unavailable: no configured remote upstream"),
        ("tag merge", "local upstream unavailable: no configured remote upstream"),
        ("not fetched", "local upstream unavailable: `git rev-parse --symbolic-full-name` failed (128)"),
        (
            "local mapping",
            "local upstream unavailable: upstream is not a remote-tracking ref: 'refs/heads/mirror/merged'",
        ),
        ("ahead", "local graph: HEAD has commits outside fetched `refs/remotes/origin/merged`"),
        ("non-UTF-8 merge", "local upstream unavailable: non-UTF-8 upstream config or ref"),
        ("missing object", "local upstream unavailable: `git rev-list --end-of-options` failed (128)"),
        ("contains", "local graph: fetched `refs/remotes/origin/merged` contains HEAD"),
    ],
)
def test_no_pr_reports_fetched_upstream_evidence(wt: Worktrees, setup: str, reason: str) -> None:
    head = git(wt.path, "rev-parse", "HEAD").decode().strip()
    if setup == "dot":
        track_upstream(wt, ".")
    elif setup == "tag merge":
        track_upstream(wt)
        git(wt.path, "config", "branch.merged.merge", "refs/tags/merged")
    elif setup == "local mapping":
        track_upstream(wt)
        git(wt.path, "config", "remote.origin.fetch", "+refs/heads/*:refs/heads/mirror/*")
        git(wt.repo, "update-ref", "refs/heads/mirror/merged", head)
    elif setup == "non-UTF-8 merge":
        track_upstream(wt)
        git(wt.path, "config", "branch.merged.merge", os.fsdecode(b"refs/heads/\xff"))
    elif setup != "none":
        track_upstream(wt)
    if setup in {"ahead", "contains"}:
        git(wt.repo, "update-ref", "refs/remotes/origin/merged", head)
    if setup == "ahead":
        git(wt.path, "commit", "--allow-empty", "-m", "Not fetched upstream")
    if setup == "missing object":
        (wt.repo / ".git/refs/remotes/origin").mkdir(parents=True)
        (wt.repo / ".git/refs/remotes/origin/merged").write_text("1" * len(head) + "\n")
    quiet(wt)
    keep(wt, f"no PR; live upstream not checked; {reason}", SWEEP_LIST="[]")


def test_no_pr_with_fetched_upstream_stays_keep_under_closed_scope(wt: Worktrees) -> None:
    track_upstream(wt)
    git(wt.repo, "update-ref", "refs/remotes/origin/merged", "HEAD")
    quiet(wt)
    code, (result,) = run(wt, variables={"SWEEP_LIST": "[]"}, borrower_gitdirs=())
    assert code == 0
    assert result["verdict"] == "keep", result
    assert "contains HEAD" in str(result["reasons"])


@pytest.mark.parametrize("upstream_ahead", [True, False])
def test_fetched_upstream_containment_follows_descendant_direction(
    wt: Worktrees, upstream_ahead: bool
) -> None:
    """Upstream descending from HEAD contains it; HEAD descending from upstream does not."""
    track_upstream(wt)
    head = git(wt.path, "rev-parse", "HEAD").decode().strip()
    tree = git(wt.path, "rev-parse", "HEAD^{tree}").decode().strip()
    child = git(wt.path, "commit-tree", tree, "-p", head, "-m", "Descendant").decode().strip()
    if upstream_ahead:
        git(wt.repo, "update-ref", "refs/remotes/origin/merged", child)
        reason = "local graph: fetched `refs/remotes/origin/merged` contains HEAD"
    else:
        git(wt.repo, "update-ref", "refs/remotes/origin/merged", head)
        git(wt.path, "update-ref", "refs/heads/merged", child)
        reason = "local graph: HEAD has commits outside fetched `refs/remotes/origin/merged`"
    quiet(wt)
    keep(wt, f"no PR; live upstream not checked; {reason}", SWEEP_LIST="[]")


def test_fetched_upstream_check_runs_no_configured_transport(wt: Worktrees) -> None:
    """No configured transport, helper or askpass runs while reading fetched evidence.

    Note: every marker adapter only touches its file and speaks no Git protocol, so the
    positive-control `git ls-remote` fails by design. Only `core.sshCommand` is proven live
    there; the other keys guard against future code paths, not this control.
    """
    git(wt.path, "remote", "set-url", "origin", "ssh://git@forge.example/source/project.git")
    track_upstream(wt)
    git(wt.repo, "update-ref", "refs/remotes/origin/merged", "HEAD")
    markers = {}
    for key in ("core.sshCommand", "credential.helper", "core.askPass", "remote.origin.uploadpack"):
        marker = wt.bin / f"{key}.ran"
        markers[key] = marker
        adapter(wt.bin, key, f"from pathlib import Path\nPath({str(marker)!r}).touch()\n")
        git(wt.path, "config", key, str(wt.bin / key))
    quiet(wt)
    keep(wt, "local graph: fetched `refs/remotes/origin/merged` contains HEAD", SWEEP_LIST="[]")
    assert not [marker for marker in markers.values() if marker.exists()]
    # Positive control: a live upstream probe in the same checkout runs the configured transport.
    live = subprocess.run(
        [str(GIT), "-C", str(wt.path), "ls-remote", "origin"],
        env=git_env(),
        timeout=TIMEOUT,
        capture_output=True,
        check=False,
    )
    assert live.returncode != 0
    assert markers["core.sshCommand"].exists()


@pytest.mark.parametrize("version", ["git version 2.35.1", "unknown"])
def test_unsafe_git_keeps_before_inventory(
    wt: Worktrees,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    version: str,
) -> None:
    guard = runpy.run_path(str(GUARD))
    calls = wt.bin / "git-calls"
    adapter(
        wt.bin,
        "git",
        "import json, sys\nfrom pathlib import Path\n"
        f"with Path({str(calls)!r}).open('a') as receipt:\n"
        "    receipt.write(json.dumps(sys.argv[1:]) + '\\n')\n"
        f"print({version!r})\n",
    )
    monkeypatch.setattr(os, "environ", git_env())
    monkeypatch.setattr(sys, "argv", [str(GUARD), str(wt.repo), BASE, "--worktree", str(wt.path)])
    assert (
        guard["main"](
            git_binary=str(wt.bin / "git"),
            gh_binary=str(wt.bin / "gh"),
            lsof_binary=str(wt.bin / "lsof"),
        )
        == 1
    )
    assert [json.loads(line) for line in calls.read_text().splitlines()] == [["--version"]]
    record = json.loads(capsys.readouterr().out)
    assert record["verdict"] == "keep"
    assert "git too old to neutralize fsmonitor safely" in str(record["reasons"])


def test_child_path_contains_only_absolute_entries(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PATH", os.pathsep.join((".", "/usr/bin", "", "tools", "/usr/sbin")))
    value = GUARD_MODULE["out"](
        Path(sys.executable), "capture child PATH", "-c", "import os; print(os.environ['PATH'])"
    )
    assert value.decode().strip() == os.pathsep.join(("/usr/bin", "/usr/sbin"))


@pytest.mark.parametrize("tool", ["git", "gh", "lsof"])
def test_child_does_not_inherit_injection_variables(
    monkeypatch: pytest.MonkeyPatch, tool: str, tmp_path: Path
) -> None:
    vars_to_drop = {
        "GIT_TRACE2_EVENT": "/unused/trace.json",
        "GIT_EXTERNAL_DIFF": "/unused/diff",
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "core.fsmonitor",
        "GIT_DIR": "/unused/repo",
        "GIT_WORK_TREE": "/unused/worktree",
        "GIT_INDEX_FILE": "/unused/index",
        "GIT_EXEC_PATH": "/unused/tools",
        "LD_PRELOAD": "/unused/library.so",
        "DYLD_INSERT_LIBRARIES": "/unused/library.dylib",
        "PYTHONPATH": "/unused/python",
    }
    common = {
        "PATH": "/usr/bin",
        "HOME": str(tmp_path / "fixture-home"),
        "LANG": "C",
        "LC_ALL": "C",
        "TMPDIR": "/tmp",
    }
    gh_auth = {
        "GH_TOKEN": "synthetic-token",
        "GITHUB_TOKEN": "synthetic-fallback",
        "GH_HOST": "example.invalid",
        "GH_CONFIG_DIR": "/unused/gh",
        "HTTPS_PROXY": "http://proxy.invalid",
        "HTTP_PROXY": "http://proxy.invalid",
        "NO_PROXY": "localhost",
    }
    git_safety = {
        "GIT_NO_LAZY_FETCH": "1",
        "GIT_ALLOW_PROTOCOL": "",
        "GIT_NO_REPLACE_OBJECTS": "1",
        "GIT_TERMINAL_PROMPT": "0",
    }
    monkeypatch.setattr(os, "environ", common | gh_auth | vars_to_drop | {"GIT_ALLOW_PROTOCOL": "ssh"})
    extra = {"git": git_safety, "gh": gh_auth | {"GH_PROMPT_DISABLED": "1"}, "lsof": {}}

    def capture_env(
        cmd: list[str], *, env: dict[str, str], **kwargs: object
    ) -> subprocess.CompletedProcess[bytes]:
        assert env == common | extra[tool]
        return subprocess.CompletedProcess(cmd, 0, b"", b"")

    monkeypatch.setattr(subprocess, "run", capture_env)
    GUARD_MODULE["out"](Path(sys.executable), "capture child environment", "-V", tool=tool)


def test_command_boundary(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    guard = runpy.run_path(str(GUARD))
    with pytest.raises(guard["KeepError"], match="missing"):
        guard["binary"](("git", str(tmp_path / "not-installed")), "git")
    with pytest.raises(guard["KeepError"], match=r"explicit label.*failed"):
        guard["out"](Path(sys.executable), "explicit label", "-c", "print(' ')", silent=True)

    def timed_out(*args: object, **kwargs: object) -> None:
        """Simulate a timeout at the subprocess boundary.

        Parameters:
            args: object, Ignored positional arguments.
            kwargs: object, Ignored keyword arguments.
        Returns:
            None.
        Raises:
            subprocess.TimeoutExpired: Always.
        """
        raise subprocess.TimeoutExpired(sys.executable, 30)

    with monkeypatch.context() as patch:
        patch.setattr(subprocess, "run", timed_out)
        with pytest.raises(guard["KeepError"], match="timed out"):
            guard["out"](Path(sys.executable), "python", "-V")


def test_malformed_evidence_parsers() -> None:
    guard = runpy.run_path(str(GUARD))
    with pytest.raises(guard["KeepError"], match="malformed attribute scan"):
        guard["check_attributes"](b"broken\0")


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


def test_future_seam_accepts_valid_nonborrowing_alternate(wt: Worktrees) -> None:
    info = wt.repo / ".git/objects/info"
    (info / "alternates").write_text(f"{wt.bin}\n")
    quiet(wt)
    code, (result,) = run(wt, borrower_gitdirs=())
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


def test_future_seam_git_resolution_never_uses_path(wt: Worktrees) -> None:
    marker = wt.bin / "fake-git-ran"
    adapter(wt.bin, "git", f"from pathlib import Path\nPath({str(marker)!r}).touch()\n")
    quiet(wt)
    code, (result,) = run(wt, borrower_gitdirs=())
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


def test_filter_activated_after_attribute_scan_is_not_run(wt: Worktrees) -> None:
    marker = wt.bin / "clean-filter-ran"
    adapter(
        wt.bin,
        "mark-clean",
        f"import sys\nfrom pathlib import Path\nPath({str(marker)!r}).touch()\n"
        "sys.stdout.buffer.write(sys.stdin.buffer.read())\n",
    )
    git(wt.path, "config", "filter.mark.clean", quote(str(wt.bin / "mark-clean")))
    (wt.path / "tracked").write_text("changed after checkout\n")
    attributes = wt.repo / ".git/info/attributes"
    attributes.parent.mkdir(exist_ok=True)
    quiet(wt)
    code, (result,) = run(
        wt,
        borrower_gitdirs=None,
        variables={"SWEEP_ACTIVATE_FILTER": str(attributes)},
    )
    assert attributes.read_text().strip() == "tracked filter=mark"
    assert not marker.exists()
    assert code == 0
    assert result["verdict"] == "keep"
    assert "tracked content or mode differs from index: b'tracked'" in str(result["reasons"])


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


@pytest.mark.parametrize("non_lf", [b"one\r\ntwo\r\n", b"one\r\ntwo\n"])
@pytest.mark.parametrize("reverse", [False, True])
def test_index_and_worktree_line_endings_differ_without_attributes(
    wt: Worktrees, non_lf: bytes, reverse: bool
) -> None:
    target = wt.path / "tracked"
    lf = b"one\ntwo\n"
    indexed, current = (non_lf, lf) if reverse else (lf, non_lf)
    target.write_bytes(indexed)
    git(wt.path, "add", "tracked")
    git(wt.path, "commit", "-m", "Record raw line endings")
    wt.pr["headRefOid"] = git(wt.path, "rev-parse", "HEAD").decode().strip()
    target.write_bytes(current)
    quiet(wt)
    keep(wt, "index and worktree line endings differ: b'tracked'")


@pytest.mark.parametrize(
    ("raw", "reason"),
    [(b"truncated", "incomplete"), (b"bad\tpath\0", "malformed"), (b"i/lf w/lf attr/\t\0", "malformed")],
)
def test_malformed_line_ending_inventory_keeps(raw: bytes, reason: str) -> None:
    with pytest.raises(GUARD_MODULE["KeepError"], match=f"{reason} line-ending inventory"):
        GUARD_MODULE["check_eol"](raw)


@pytest.mark.parametrize(("key", "value"), [("autocrlf", "input"), ("eol", "crlf"), ("safecrlf", "warn")])
def test_effective_conversion_cfg_keeps(wt: Worktrees, key: str, value: str) -> None:
    git(wt.path, "config", f"core.{key}", value)
    quiet(wt)
    keep(wt, f"conversion config: core.{key}")


def test_file_written_during_pr_view_keeps(wt: Worktrees) -> None:
    recovery = wt.path / "ignored"
    quiet(wt)
    keep(wt, "untracked or ignored paths", SWEEP_WRITE_DURING_VIEW=str(recovery))
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
        guard["parse_inventory"](raw, 40)


@pytest.mark.parametrize("separator", [b"\n", b"\r", b"\0"])
def test_inventory_ref_name_rejects_embedded_separator(separator: bytes) -> None:
    oid = b"HEAD " + b"1" * 40
    branch = b"branch refs/heads/left" + separator + b"right"
    raw = b"worktree /absolute\0" + oid + b"\0" + branch + b"\0\0"
    with pytest.raises(GUARD_MODULE["KeepError"], match="ref-name separator"):
        GUARD_MODULE["validate_fields"]([oid, branch], 40)
    with pytest.raises(GUARD_MODULE["KeepError"], match="worktree inventory"):
        GUARD_MODULE["parse_inventory"](raw, 40)


@pytest.mark.parametrize(("storage", "width", "wrong_width"), [("sha1", 40, 64), ("sha256", 64, 40)])
def test_inventory_requires_storage_oid_width(
    tmp_path: Path, storage: str, width: int, wrong_width: int
) -> None:
    git(tmp_path, "init", "--template=", f"--object-format={storage}")
    git(tmp_path, "commit", "--allow-empty", "-m", "Base")
    raw = git(tmp_path, "worktree", "list", "--porcelain", "-z")
    assert GUARD_MODULE["inventory"](tmp_path) == GUARD_MODULE["parse_inventory"](raw, width)
    with pytest.raises(GUARD_MODULE["KeepError"], match="inventory identity"):
        GUARD_MODULE["parse_inventory"](raw, wrong_width)


def test_shipped_skills_keep_claimed_scratch_at_handback() -> None:
    skills = GUARD.parent.parent
    worker = (GUARD.parent / "SKILL.md").read_text()
    parent = (skills / "get-it-merged/SKILL.md").read_text()
    assert "Before handback, leave scratch in place" in worker
    assert "Before handback, remove" not in worker
    assert "With the shipped guard, do not delete scratch" in parent

    for skill, handback in (
        (worker, "report the path and only the guard's reasons and any status evidence it already collected"),
        (parent, "report only the guard's reasons and any status evidence it already collected"),
    ):
        prose = " ".join(skill.replace("`", "").split())
        assert handback in prose
        warning = (
            "Never run a standalone git status (or git diff) on a retained worktree to fill in "
            "evidence: it can run configured filters."
        )
        assert warning in prose
        remaining = prose.replace(warning, "")
        assert "git status" not in remaining
        assert "git diff" not in remaining


def test_shipped_program_uses_python_38_grammar() -> None:
    ast.parse(GUARD.read_text(), feature_version=(3, 8))
