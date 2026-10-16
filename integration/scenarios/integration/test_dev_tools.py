"""pi-dev-tools end to end: the installed (or `HARNESS_LOCAL`) extension, real git, real pi.

Each group gets a fixture under the sandbox workdir and one headless run that issues every call
as a faux tool call, so the assertions see what the tool returned through pi's pipeline:
`structuredContent` states, `isError`, and the one-line text the model reads.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest

from harness.headless import ToolOutcome, run_headless
from harness.paths import GIT_BIN

if TYPE_CHECKING:
    from harness.sandbox import Sandbox

pytestmark = pytest.mark.integration

# `search_tools` promotes a handful per call, so ask for the worktree tools two at a time.
PROMOTE_WORKTREES = ["git_worktree_list git_worktree_add", "git_worktree_remove git_worktree_prune"]
GUARD_MARKER = "pi-dev-tools blocks this git command"
GIT_IDENTITY = [
    "-c",
    "user.name=h",
    "-c",
    "user.email=h@h",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "init.defaultBranch=main",
]


def git(cwd: Path, *args: str) -> str:
    """Run git in `cwd` with a fixed identity and no signing.

    Parameters:
        cwd (Path): repository directory.
        *args (str): git arguments.

    Returns:
        str: stdout.
    """
    return subprocess.check_output([GIT_BIN, *GIT_IDENTITY, *args], cwd=cwd, text=True)


def make_git_fixture(root: Path) -> tuple[Path, Path]:
    """Create a clone with a bare remote and one of every working-tree state.

    Parameters:
        root (Path): directory to create under.

    Returns:
        tuple[Path, Path]: (repo, bare remote).
    """
    remote = root / "remote.git"
    repo = root / "repo"
    subprocess.check_call([GIT_BIN, "init", "-q", "--bare", "-b", "main", str(remote)])
    subprocess.check_call([GIT_BIN, *GIT_IDENTITY, "clone", "-q", str(remote), str(repo)])
    for key, value in (("user.name", "h"), ("user.email", "h@h"), ("commit.gpgsign", "false")):
        git(repo, "config", key, value)
    (repo / "a.txt").write_text("one\n")
    (repo / "b.txt").write_text("b\n")
    (repo / "old.txt").write_text("same\n")
    git(repo, "add", "a.txt", "b.txt", "old.txt")
    git(repo, "commit", "-q", "-m", "Initial")
    git(repo, "push", "-q", "-u", "origin", "main")
    (repo / "a.txt").write_text("one\ntwo\n")
    (repo / "c.txt").write_text("c\n")
    (repo / "spaced name.txt").write_text("n\n")
    git(repo, "mv", "old.txt", "renamed.txt")
    git(repo, "add", "c.txt")
    return repo, remote


def run_tools(
    sandbox: Sandbox, cwd: Path, calls: list[dict[str, Any]], promote: list[str] | None = None
) -> list[ToolOutcome]:
    """Issue `calls` as one faux turn in `cwd` and return one outcome per call, in call order.

    Tools in one turn may settle in any order, so outcomes are matched back by name and args.

    Parameters:
        sandbox (Sandbox): pi home.
        cwd (Path): working directory for pi.
        calls (list[dict[str, Any]]): `{"name": ..., "args": {...}}` entries.
        promote (list[str] | None): `search_tools` queries to run first, one step each, for deferred tools.

    Returns:
        list[ToolOutcome]: aligned with `calls`.
    """
    steps: list[dict[str, Any]] = [{"tools": calls}, {"text": "DONE"}]
    for query in reversed(promote or []):
        steps.insert(0, {"tools": [{"name": "search_tools", "args": {"query": query}}]})
    result = run_headless(
        sandbox,
        {"providers": {"faux": {"models": ["main"], "steps": steps}}},
        ["go"],
        cwd=cwd,
    )
    assert result.returncode == 0, result.transcript()
    pending = result.tool_outcomes()
    aligned: list[ToolOutcome] = []
    for call in calls:
        match = next((o for o in pending if o.name == call["name"] and o.args == call["args"]), None)
        assert match is not None, f"{call} never settled\n{result.transcript()}"
        pending.remove(match)
        aligned.append(match)
    return aligned


@pytest.fixture
def git_repo(sandbox: Sandbox) -> tuple[Path, Path]:
    return make_git_fixture(sandbox.workdir)


# Stand-in for ssh inside the sandbox: accepts the real argv shape, runs the stdin script locally.
# Host `down` fails like a dead connection (exit 255, nothing run).
FAKE_SSH = """#!/bin/sh
host=""
while [ $# -gt 0 ]; do
  case "$1" in
    --) shift; host="$1"; shift; break ;;
    -o) shift 2 ;;
    -*) shift ;;
    *) host="$1"; shift; break ;;
  esac
done
[ "$host" = "down" ] && { echo "ssh: connect to host down port 22: Operation timed out" >&2; exit 255; }
[ "$1" = "exec sh -s" ] || { echo "unexpected remote command: $1" >&2; exit 254; }
exec sh -s
"""


@pytest.fixture
def fake_ssh(sandbox: Sandbox) -> None:
    """Give the sandbox a `~/.ssh/config` with two hosts and an `ssh` that runs scripts locally."""
    ssh_dir = sandbox.home / ".ssh"
    ssh_dir.mkdir(mode=0o700, exist_ok=True)
    (ssh_dir / "config").write_text("Host home\n  HostName 127.0.0.1\nHost down\n  HostName 127.0.0.2\n")
    shim = sandbox.shims_dir / "ssh"
    shim.write_text(FAKE_SSH)
    shim.chmod(0o755)


def test_git_reads(sandbox: Sandbox, git_repo: tuple[Path, Path]) -> None:
    """Reads return parsed state and compact text, and failures carry a named state."""
    repo, _ = git_repo
    outcomes = run_tools(
        sandbox,
        repo,
        [
            {"name": "git_status", "args": {}},
            {"name": "git_diff", "args": {}},
            {"name": "git_diff", "args": {"staged": True, "stat": True}},
            {"name": "git_log", "args": {"max_count": 5}},
            {"name": "git_show", "args": {"rev": "HEAD", "stat": True}},
            {"name": "git_show", "args": {"rev": "not-a-ref"}},
        ],
    )
    status, tree, staged, log, shown, missing = outcomes
    assert not status.is_error, status.text
    assert status.structured["branch"] == "main"
    staged_entries = {e["path"]: e for e in status.structured["staged"]}
    assert set(staged_entries) == {"renamed.txt", "c.txt"}
    assert staged_entries["renamed.txt"]["from"] == "old.txt"
    assert [e["path"] for e in status.structured["unstaged"]] == ["a.txt"]
    assert status.structured["untracked"] == ["spaced name.txt"]
    assert "R old.txt -> renamed.txt" in status.text

    assert "+two" in tree.text
    assert tree.structured["changed"] is True
    assert "c.txt" in staged.text
    assert "+two" not in staged.text

    assert [c["subject"] for c in log.structured["commits"]] == ["Initial"]

    assert not shown.is_error
    assert shown.structured["subject"] == "Initial"
    assert missing.is_error
    assert missing.text.startswith("git show: unknown revision")


def test_git_commit_and_guard(sandbox: Sandbox, git_repo: tuple[Path, Path]) -> None:
    """`git_commit` stages only what it is told, writes house style, pushes; the guard blocks bash."""
    repo, remote = git_repo
    outcomes = run_tools(
        sandbox,
        repo,
        [
            {"name": "git_commit", "args": {"subject": "lowercase subject", "paths": ["a.txt"]}},
            {"name": "git_commit", "args": {"subject": "Sweep everything", "paths": ["."]}},
            {
                "name": "git_commit",
                "args": {
                    "subject": "Extend a and add c",
                    "changes": ["Append two to `a.txt`"],
                    "paths": ["a.txt", "c.txt"],
                },
            },
            {"name": "bash", "args": {"command": "git commit --no-verify -m x"}},
            {"name": "bash", "args": {"command": "git push --force"}},
            {"name": "bash", "args": {"command": "git push --force-with-lease --dry-run"}},
        ],
    )
    bad_subject, broad, committed, no_verify, force, lease = outcomes
    assert bad_subject.is_error
    assert bad_subject.structured["stage"] == "validate"
    assert broad.is_error
    assert "repository root" in broad.text
    assert not committed.is_error, committed.text
    assert committed.structured["stage"] == "done"
    assert committed.structured["pushed"] is True
    message = git(repo, "log", "-1", "--format=%B").rstrip("\n")
    expected = "\n".join(
        [
            "Extend a and add c",
            "",
            "Changes:",
            "- Append two to `a.txt`",
            "",
            "Co-Authored-By: Claude <noreply@anthropic.com>",
        ]
    )
    assert message == expected
    assert git(remote, "log", "-1", "--format=%s").strip() == "Extend a and add c"
    # The rename was staged before the call and the untracked file was never named: the rename is
    # still staged, not committed, and the untracked file is untouched.
    assert "renamed.txt" not in git(repo, "show", "--stat", "--format=", "HEAD")
    porcelain = git(repo, "status", "--porcelain")
    assert "R  old.txt -> renamed.txt" in porcelain
    assert "spaced name.txt" in porcelain

    assert no_verify.is_error
    assert GUARD_MARKER in no_verify.text
    assert "no-verify" in no_verify.text
    assert force.is_error
    assert GUARD_MARKER in force.text
    assert "force-push" in force.text
    assert GUARD_MARKER not in lease.text


def test_git_worktrees(sandbox: Sandbox, git_repo: tuple[Path, Path]) -> None:
    """`git_worktree_*` are deferred: promoted via `search_tools`, then add, list, refuse and remove."""
    repo, _ = git_repo
    wt = repo.parent / "repo-feat-x"
    other = repo.parent / "elsewhere"
    outcomes = run_tools(
        sandbox,
        repo,
        [
            {"name": "git_worktree_add", "args": {"branch": "feat/x"}},
            {"name": "git_worktree_add", "args": {"branch": "main", "path": str(other)}},
        ],
        promote=PROMOTE_WORKTREES,
    )
    added, elsewhere = outcomes
    assert not added.is_error, added.text
    assert added.structured["created"] is True
    assert Path(added.structured["path"]).resolve() == wt.resolve()
    assert elsewhere.is_error
    assert "branch checked out elsewhere" in elsewhere.text
    assert not other.exists()

    (wt / "scratch.txt").write_text("x\n")
    outcomes = run_tools(
        sandbox,
        repo,
        [
            {"name": "git_worktree_list", "args": {}},
            {"name": "git_worktree_remove", "args": {"path": str(wt)}},
            {"name": "git_worktree_remove", "args": {"path": str(repo)}},
        ],
        promote=PROMOTE_WORKTREES,
    )
    listed, dirty, main = outcomes
    assert not listed.is_error, listed.text
    branches = {w["branch"]: w for w in listed.structured["worktrees"]}
    assert branches["main"]["main"] is True
    assert branches["feat/x"]["main"] is False
    assert dirty.is_error
    assert "dirty worktree" in dirty.text
    assert main.is_error
    assert "main worktree" in main.text

    outcomes = run_tools(
        sandbox,
        repo,
        [
            {"name": "git_worktree_remove", "args": {"path": str(wt), "force": True}},
            {"name": "git_worktree_prune", "args": {"dry_run": True}},
        ],
        promote=PROMOTE_WORKTREES,
    )
    removed, pruned = outcomes
    assert not removed.is_error, removed.text
    assert not wt.exists()
    assert git(repo, "branch", "--list", "feat/x").strip() == "feat/x"
    assert pruned.structured == {"dryRun": True, "pruned": []}
    assert pruned.text == "nothing to prune"


def test_git_commit_relays_hook_failure(sandbox: Sandbox, git_repo: tuple[Path, Path]) -> None:
    """A failing hook fails the commit with its output and the re-stage hint; nothing is committed."""
    repo, _ = git_repo
    hook = repo / ".git" / "hooks" / "pre-commit"
    hook.write_text(
        "#!/bin/sh\necho 'lint...Failed' >&2\necho 'files were modified by this hook' >&2\nexit 1\n"
    )
    hook.chmod(0o755)
    outcomes = run_tools(
        sandbox, repo, [{"name": "git_commit", "args": {"subject": "Extend a", "paths": ["a.txt"]}}]
    )
    (failed,) = outcomes
    assert failed.is_error
    assert failed.structured["stage"] == "commit"
    assert failed.structured["hookModifiedFiles"] is True
    assert "lint...Failed" in failed.text
    assert "re-stage" in failed.text
    assert git(repo, "log", "-1", "--format=%s").strip() == "Initial"


@pytest.mark.usefixtures("fake_ssh")
def test_ssh_exec(sandbox: Sandbox) -> None:
    """`ssh_exec` validates the host, runs the script, and separates remote from ssh failures."""
    marker = sandbox.workdir / "touched"
    outcomes = run_tools(
        sandbox,
        sandbox.workdir,
        [
            {"name": "ssh_exec", "args": {"host": "home", "command": "echo hi; exit 4"}},
            {
                "name": "ssh_exec",
                "args": {"host": "home", "command": f"touch {marker}", "cwd": str(sandbox.workdir)},
            },
            {"name": "ssh_exec", "args": {"host": "down", "command": "id"}},
            {"name": "ssh_exec", "args": {"host": "evil", "command": "id"}},
            {"name": "ssh_exec", "args": {"host": "-oProxyCommand=id", "command": "id"}},
        ],
    )
    failing, ok, down, unknown, injected = outcomes
    # A non-zero remote exit is a normal result (think `grep`), not a tool error.
    assert not failing.is_error
    assert failing.structured == {
        "host": "home",
        "remoteExit": 4,
        "sshExit": 0,
        "state": "command-failed",
        "truncated": False,
    }
    assert "hi" in failing.text
    assert not ok.is_error, ok.text
    assert ok.structured["state"] == "ok"
    assert marker.exists()
    assert down.is_error
    assert down.is_error
    assert down.structured["state"] == "ssh-failed"
    assert down.structured["remoteExit"] is None
    assert "may not have run" in down.text
    for outcome in (unknown, injected):
        assert outcome.is_error
        assert "not a Host entry" in outcome.text or "not a plain host alias" in outcome.text


PYPROJECT = """[project]
name = "pt"
version = "0.0.0"
requires-python = ">=3.12"
dependencies = []

[dependency-groups]
dev = ["pytest", "ruff", "ty"]

[tool.ruff.lint]
select = ["E", "F", "I"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
"""


@pytest.fixture
def uv_project(sandbox: Sandbox) -> Path:
    """A uv project with one lint, format, type and test failure, synced with the real uv cache.

    The sync runs outside the sandbox environment so the real `~/.cache/uv` and managed Pythons
    are used; inside the sandbox pi only needs the existing `.venv` (`uv run --frozen`).
    """
    if shutil.which("uv") is None:
        pytest.skip("uv not installed")
    root = sandbox.workdir / "pyproj"
    (root / "src" / "pt").mkdir(parents=True)
    (root / "tests").mkdir()
    (root / "pyproject.toml").write_text(PYPROJECT)
    (root / "src" / "pt" / "__init__.py").write_text("")
    (root / "src" / "pt" / "bad.py").write_text("import os,sys\ndef f( x:int )->str:\n    return x\n")
    (root / "src" / "pt" / "good.py").write_text("def add(a: int, b: int) -> int:\n    return a + b\n")
    (root / "tests" / "test_a.py").write_text(
        "from pt.good import add\n\n\ndef test_ok():\n    assert add(1, 2) == 3\n\n\n"
        "def test_fail():\n    assert add(1, 2) == 4, 'math is hard'\n"
    )
    subprocess.check_call(["uv", "sync", "--all-groups", "-q"], cwd=root)
    return root


def test_py_tools(sandbox: Sandbox, uv_project: Path) -> None:
    """`py_*` are deferred: found via `search_tools`, then they map exit codes to named states."""
    sandbox.env_overrides["UV_CACHE_DIR"] = str(Path.home() / ".cache" / "uv")
    sandbox.env_overrides["UV_PYTHON_INSTALL_DIR"] = str(Path.home() / ".local" / "share" / "uv" / "python")
    calls = [
        {"name": "py_lint", "args": {}},
        {"name": "py_format", "args": {}},
        {"name": "py_typecheck", "args": {}},
        {"name": "py_test", "args": {}},
        {"name": "py_test", "args": {"k": "test_ok"}},
    ]
    result = run_headless(
        sandbox,
        {
            "providers": {
                "faux": {
                    "models": ["main"],
                    "steps": [
                        # `search_tools` promotes a handful per call; name the tools the way a model would.
                        {"tools": [{"name": "search_tools", "args": {"query": "py_lint py_format ruff"}}]},
                        {
                            "tools": [
                                {"name": "search_tools", "args": {"query": "py_test py_typecheck pytest"}}
                            ]
                        },
                        {"tools": calls},
                        {"text": "DONE"},
                    ],
                }
            }
        },
        ["go"],
        cwd=uv_project,
        timeout_s=300,
    )
    assert result.returncode == 0, result.transcript()
    by_call = {(o.name, o.args.get("k")): o for o in result.tool_outcomes() if o.name != "search_tools"}
    assert len(by_call) == len(calls), result.transcript()
    lint = by_call[("py_lint", None)]
    assert lint.is_error
    assert lint.structured["state"] == "findings"
    assert {d["code"] for d in lint.structured["diagnostics"]} >= {"F401", "I001"}
    assert lint.structured["unparsed"] == []
    fmt = by_call[("py_format", None)]
    assert fmt.structured["state"] == "would-reformat"
    assert "src/pt/bad.py" in fmt.structured["files"]
    types = by_call[("py_typecheck", None)]
    assert types.structured["state"] == "findings"
    assert types.structured["diagnostics"][0]["code"] == "invalid-return-type"
    failed = by_call[("py_test", None)]
    assert failed.structured["state"] == "failed"
    assert failed.structured["counts"] == {"failed": 1, "passed": 1}
    assert [f["nodeid"] for f in failed.structured["failures"]] == ["tests/test_a.py::test_fail"]
    assert "math is hard" in failed.text
    passed = by_call[("py_test", "test_ok")]
    assert not passed.is_error
    assert passed.structured["state"] == "passed"


GOOD_LIB = """//! good
/// Adds.
///
/// ```
/// assert_eq!(good::add(1, 2), 3);
/// ```
#[must_use]
pub fn add(a: u64, b: u64) -> u64 {
    a + b
}

/// Casts (pedantic lint).
#[must_use]
pub fn cast(x: u64) -> u32 {
    x as u32
}

#[cfg(test)]
mod tests {
    #[test]
    fn passes() {
        assert_eq!(super::add(1, 2), 3);
    }
    #[test]
    fn fails() {
        assert_eq!(super::add(1, 2), 4, "math is hard");
    }
}
"""


@pytest.fixture
def cargo_workspace(sandbox: Sandbox) -> Path:
    """Two crates: `good` (pedantic lint, one failing test, a doctest) and `bad` (type error)."""
    if shutil.which("cargo") is None or shutil.which("cargo-nextest") is None:
        pytest.skip("cargo or cargo-nextest not installed")
    root = sandbox.workdir / "ws"
    (root / "good" / "src").mkdir(parents=True)
    (root / "bad" / "src").mkdir(parents=True)
    (root / "Cargo.toml").write_text('[workspace]\nmembers = ["good", "bad"]\nresolver = "3"\n')
    (root / "good" / "Cargo.toml").write_text(
        '[package]\nname = "good"\nversion = "0.1.0"\nedition = "2024"\n'
    )
    (root / "good" / "src" / "lib.rs").write_text(GOOD_LIB)
    (root / "bad" / "Cargo.toml").write_text('[package]\nname = "bad"\nversion = "0.1.0"\nedition = "2024"\n')
    (root / "bad" / "src" / "lib.rs").write_text("pub fn f() -> u32 {\n    let s: String = 42;\n    7\n}\n")
    return root


def test_cargo_tools(sandbox: Sandbox, cargo_workspace: Path) -> None:
    """`cargo_*` are deferred: found via `search_tools`, then diagnostics dedupe and tests map states."""
    for key in ("CARGO_HOME", "RUSTUP_HOME"):
        if key in os.environ:
            sandbox.env_overrides[key] = os.environ[key]
    sandbox.env_overrides.setdefault("CARGO_HOME", str(Path.home() / ".cargo"))
    sandbox.env_overrides.setdefault("RUSTUP_HOME", str(Path.home() / ".rustup"))
    calls = [
        {"name": "cargo_check", "args": {}},
        {"name": "cargo_clippy", "args": {"package": "good"}},
        {"name": "cargo_test", "args": {"package": "good"}},
        {"name": "cargo_test", "args": {"package": "good", "filter": "nothing_here", "doc": False}},
    ]
    result = run_headless(
        sandbox,
        {
            "providers": {
                "faux": {
                    "models": ["main"],
                    "steps": [
                        {
                            "tools": [
                                {"name": "search_tools", "args": {"query": "cargo_check cargo_clippy clippy"}}
                            ]
                        },
                        {"tools": [{"name": "search_tools", "args": {"query": "cargo_test nextest"}}]},
                        {"tools": calls},
                        {"text": "DONE"},
                    ],
                }
            }
        },
        ["go"],
        cwd=cargo_workspace,
        timeout_s=600,
    )
    assert result.returncode == 0, result.transcript()
    by_call = {(o.name, o.args.get("filter")): o for o in result.tool_outcomes() if o.name != "search_tools"}
    assert len(by_call) == len(calls), result.transcript()
    check = by_call[("cargo_check", None)]
    assert check.is_error
    assert check.structured["state"] == "errors"
    assert check.structured["errors"] == 1
    assert [d["code"] for d in check.structured["diagnostics"] if d["level"] == "error"] == ["E0308"]
    clippy = by_call[("cargo_clippy", None)]
    assert clippy.structured["state"] == "warnings"
    assert [d["code"] for d in clippy.structured["diagnostics"]] == ["clippy::cast_possible_truncation"]
    tests = by_call[("cargo_test", None)]
    assert tests.is_error
    assert tests.structured["state"] == "failed"
    assert tests.structured["tests"] == 2
    assert [f["name"] for f in tests.structured["failed"]] == ["good tests::fails"]
    assert tests.structured["doctests"] == {"passed": 1, "failed": 0, "failedNames": []}
    assert "math is hard" in tests.text
    none = by_call[("cargo_test", "nothing_here")]
    assert none.structured["state"] == "no-tests"
