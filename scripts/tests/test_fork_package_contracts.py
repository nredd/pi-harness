"""Test the real-fork gate's tooling against disposable Git repositories and synthetic Pi runs.

Everything here runs without an initialized `forks/` checkout, stock Pi or the npm registry; the real
gate is `make check-fork-package-contracts`. The fork preflight and archive use real throwaway
repositories shaped like the parent/submodule layout, the dependency install uses a fake `npm` that
records its argv, and the case assessment uses synthetic Pi events shaped like real ones.

References:
    https://git-scm.com/docs/git-archive
    https://docs.npmjs.com/cli/v11/commands/npm-ci
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
import shlex
import shutil
import stat
import sys
import textwrap
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import faux_provider as fp
import fork_package_contracts as fpc
import package_contracts as pc

PACKED_AGENT = (pc.REPO_ROOT / "packages" / "preset" / "agents" / "code-reviewer.md").read_text()
INTEGRITY = "sha512-" + "A" * 86 + "=="
LOCK: dict[str, Any] = {
    "lockfileVersion": 3,
    "packages": {
        "": {"name": "@tintinweb/pi-subagents", "dependencies": {"croner": "^10.0.1", "nanoid": "^5.1.16"}},
        "node_modules/croner": {"version": "10.0.1", "integrity": INTEGRITY},
        "node_modules/nanoid": {"version": "5.1.16", "integrity": INTEGRITY},
        "node_modules/typebox": {"version": "1.3.27", "integrity": INTEGRITY, "dev": True},
    },
}
MANIFEST: dict[str, Any] = {
    "name": "@tintinweb/pi-subagents",
    "version": "0.22.0",
    "dependencies": {"croner": "^10.0.1", "nanoid": "^5.1.16"},
    "pi": {"extensions": ["./src/index.ts"]},
}


@pytest.fixture
def sandbox(tmp_path: Path) -> pc.Sandbox:
    """Sandbox with real tools under a temporary root.

    Parameters:
        tmp_path (Path): Pytest temporary directory.

    Returns:
        pc.Sandbox: Scrubbed environment.
    """
    return pc.Sandbox(tmp_path / "sandbox", pc.locate_tools())


def git(sandbox: pc.Sandbox, repo: Path, *args: str) -> str:
    """Run git in a disposable repository with a fixed identity and no signing.

    Parameters:
        sandbox (pc.Sandbox): Scrubbed environment.
        repo (Path): Repository directory.
        *args (str): Git arguments.

    Returns:
        str: Stripped standard output.
    """
    identity = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"]
    return pc.run(
        [sandbox.tools.git, "-C", repo, *identity, *args], env=sandbox.env(), cwd=repo, timeout=60
    ).stdout.strip()


def commit_all(sandbox: pc.Sandbox, repo: Path, message: str) -> str:
    """Commit every change and return the new commit.

    Parameters:
        sandbox (pc.Sandbox): Scrubbed environment.
        repo (Path): Repository directory.
        message (str): Commit message.

    Returns:
        str: Commit SHA.
    """
    git(sandbox, repo, "add", "-A")
    git(sandbox, repo, "commit", "-q", "-m", message)
    return git(sandbox, repo, "rev-parse", "HEAD")


@dataclass(frozen=True)
class Parent:
    """A disposable parent repository with a nested fork shaped like `forks/pi-subagents`.

    Parameters:
        root (Path): Parent root.
        fork (Path): The nested fork repository.
        sha (str): Fork commit recorded as the Gitlink.
    """

    root: Path
    fork: Path
    sha: str


@pytest.fixture
def parent(tmp_path: Path, sandbox: pc.Sandbox) -> Parent:
    """Create the parent/fork pair with the Gitlink committed in the parent.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
        sandbox (pc.Sandbox): Scrubbed environment.

    Returns:
        Parent: Layout with a clean, matching fork.
    """
    root = tmp_path / "parent"
    fork = root / fpc.FORK_RELATIVE
    fork.mkdir(parents=True)
    git(sandbox, fork, "init", "-q", "-b", "main")
    (fork / "src").mkdir()
    (fork / "src" / "index.ts").write_text("export default 1;\n")
    (fork / "package.json").write_text(json.dumps(MANIFEST))
    (fork / "package-lock.json").write_text(json.dumps(LOCK))
    (fork / ".gitignore").write_text("node_modules/\n")
    sha = commit_all(sandbox, fork, "fork")
    git(sandbox, root, "init", "-q", "-b", "main")
    git(sandbox, root, "add", fpc.FORK_RELATIVE)
    git(sandbox, root, "commit", "-q", "-m", "gitlink")
    return Parent(root, fork, sha)


def snapshot(path: Path) -> dict[str, bytes]:
    """Read every file below a directory, `.git` excluded.

    Parameters:
        path (Path): Directory.

    Returns:
        dict[str, bytes]: Content by relative path.
    """
    return {
        p.relative_to(path).as_posix(): p.read_bytes()
        for p in sorted(path.rglob("*"))
        if p.is_file() and ".git" not in p.relative_to(path).parts
    }


# --- preflight ------------------------------------------------------------------------------------


def test_preflight_accepts_a_clean_matching_fork(parent: Parent, sandbox: pc.Sandbox) -> None:
    """HEAD, index Gitlink and HEAD Gitlink agree and the tree is clean.

    Parameters:
        parent (Parent): Disposable layout.
        sandbox (pc.Sandbox): Scrubbed environment.
    """
    source = fpc.preflight_fork(parent.root, sandbox)
    assert source == fpc.ForkSource(parent.fork, parent.sha)


def test_preflight_ignores_ignored_files_but_not_untracked(parent: Parent, sandbox: pc.Sandbox) -> None:
    """A gitignored `node_modules` is not dirt; an untracked source file is.

    Parameters:
        parent (Parent): Disposable layout.
        sandbox (pc.Sandbox): Scrubbed environment.
    """
    (parent.fork / "node_modules").mkdir()
    (parent.fork / "node_modules" / "x").write_text("x")
    fpc.preflight_fork(parent.root, sandbox)
    (parent.fork / "stray.ts").write_text("x")
    with pytest.raises(pc.ContractError, match=r"is dirty \(1 entries\)") as info:
        fpc.preflight_fork(parent.root, sandbox)
    assert "?? stray.ts" in str(info.value)


def test_preflight_refuses_missing_fork(tmp_path: Path, sandbox: pc.Sandbox) -> None:
    """A parent without the directory fails with the manual bootstrap hint.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
        sandbox (pc.Sandbox): Scrubbed environment.
    """
    with pytest.raises(pc.ContractError, match=r"is missing.*make bootstrap-forks.*never bootstraps"):
        fpc.preflight_fork(tmp_path, sandbox)


def test_preflight_refuses_uninitialized_fork_instead_of_resolving_the_parent(
    parent: Parent, sandbox: pc.Sandbox
) -> None:
    """An empty submodule directory must not make `git -C` silently inspect the PARENT repository.

    Parameters:
        parent (Parent): Disposable layout.
        sandbox (pc.Sandbox): Scrubbed environment.
    """
    shutil.rmtree(parent.fork)
    parent.fork.mkdir()
    with pytest.raises(pc.ContractError, match="not initialized"):
        fpc.preflight_fork(parent.root, sandbox)
    assert list(parent.fork.iterdir()) == []


def test_preflight_refuses_fork_that_is_not_its_own_repository(parent: Parent, sandbox: pc.Sandbox) -> None:
    """A `.git` marker that does not make the directory its own toplevel is rejected.

    Parameters:
        parent (Parent): Disposable layout.
        sandbox (pc.Sandbox): Scrubbed environment.
    """
    shutil.rmtree(parent.fork)
    (parent.fork / "sub").mkdir(parents=True)
    git_dir = parent.root / ".git"
    # A `.git` file pointing at the parent's gitdir makes the toplevel the parent root.
    (parent.fork / ".git").write_text(f"gitdir: {git_dir}\n")
    with pytest.raises(pc.ContractError, match="not its own repository"):
        fpc.preflight_fork(parent.root, sandbox)


def test_preflight_refuses_fork_head_that_moved(parent: Parent, sandbox: pc.Sandbox) -> None:
    """A fork commit newer than both Gitlinks is refused and left untouched.

    Parameters:
        parent (Parent): Disposable layout.
        sandbox (pc.Sandbox): Scrubbed environment.
    """
    (parent.fork / "src" / "index.ts").write_text("export default 2;\n")
    moved = commit_all(sandbox, parent.fork, "moved")
    before = snapshot(parent.fork)
    with pytest.raises(pc.ContractError, match=rf"HEAD '{moved}' differs.*index '{parent.sha}'"):
        fpc.preflight_fork(parent.root, sandbox)
    assert snapshot(parent.fork) == before
    assert git(sandbox, parent.fork, "rev-parse", "HEAD") == moved


def test_preflight_refuses_index_gitlink_that_differs_from_head_gitlink(
    parent: Parent, sandbox: pc.Sandbox
) -> None:
    """A staged-but-uncommitted Gitlink bump matches the fork HEAD yet not the parent `HEAD`.

    Parameters:
        parent (Parent): Disposable layout.
        sandbox (pc.Sandbox): Scrubbed environment.
    """
    (parent.fork / "src" / "index.ts").write_text("export default 2;\n")
    moved = commit_all(sandbox, parent.fork, "moved")
    git(sandbox, parent.root, "add", fpc.FORK_RELATIVE)
    assert git(sandbox, parent.root, "ls-files", "-s", "--", fpc.FORK_RELATIVE).split()[1] == moved
    with pytest.raises(pc.ContractError, match=rf"index '{moved}', HEAD '{parent.sha}'"):
        fpc.preflight_fork(parent.root, sandbox)


def test_preflight_refuses_dirty_tracked_and_staged_changes(parent: Parent, sandbox: pc.Sandbox) -> None:
    """Unstaged and staged edits are both dirt, and nothing is reverted.

    Parameters:
        parent (Parent): Disposable layout.
        sandbox (pc.Sandbox): Scrubbed environment.
    """
    target = parent.fork / "src" / "index.ts"
    target.write_text("export default 3;\n")
    with pytest.raises(pc.ContractError, match="is dirty"):
        fpc.preflight_fork(parent.root, sandbox)
    git(sandbox, parent.fork, "add", "src/index.ts")
    with pytest.raises(pc.ContractError, match="is dirty"):
        fpc.preflight_fork(parent.root, sandbox)
    assert target.read_text() == "export default 3;\n"


def test_preflight_refuses_a_path_that_is_not_a_gitlink(tmp_path: Path, sandbox: pc.Sandbox) -> None:
    """A parent that tracks plain files at the path (not a Gitlink) is rejected.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
        sandbox (pc.Sandbox): Scrubbed environment.
    """
    root = tmp_path / "plain"
    fork = root / fpc.FORK_RELATIVE
    fork.mkdir(parents=True)
    git(sandbox, fork, "init", "-q", "-b", "main")
    (fork / "a.txt").write_text("a")
    commit_all(sandbox, fork, "a")
    git(sandbox, root, "init", "-q", "-b", "main")
    with pytest.raises(pc.ContractError, match="has 0 entries in the parent index"):
        fpc.preflight_fork(root, sandbox)


@pytest.mark.parametrize(
    ("listing", "where", "expected"),
    [
        (f"160000 {'a' * 40} 0\t{fpc.FORK_RELATIVE}\n", "index", "a" * 40),
        (f"160000 commit {'b' * 40}\t{fpc.FORK_RELATIVE}\n", "HEAD", "b" * 40),
    ],
)
def test_gitlink_sha_parses_both_forms(listing: str, where: str, expected: str) -> None:
    """`ls-files -s` and `ls-tree` lines yield the commit.

    Parameters:
        listing (str): Command output.
        where (str): Source label.
        expected (str): Expected commit.
    """
    assert fpc.gitlink_sha(listing, fpc.FORK_RELATIVE, where) == expected


@pytest.mark.parametrize(
    ("listing", "needle"),
    [
        ("", "has 0 entries"),
        (
            f"160000 {'a' * 40} 0\t{fpc.FORK_RELATIVE}\n160000 {'a' * 40} 1\t{fpc.FORK_RELATIVE}\n",
            "has 2 entries",
        ),
        (f"160000 {'a' * 40} 2\t{fpc.FORK_RELATIVE}\n", "conflicted"),
        (f"100644 {'a' * 40} 0\t{fpc.FORK_RELATIVE}\n", "not a Gitlink"),
        (f"040000 tree {'a' * 40}\t{fpc.FORK_RELATIVE}\n", "not a Gitlink"),
    ],
)
def test_gitlink_sha_rejects(listing: str, needle: str) -> None:
    """Absent, duplicated, conflicted and non-Gitlink entries are refused.

    Parameters:
        listing (str): Command output.
        needle (str): Substring the diagnostic must contain.
    """
    with pytest.raises(pc.ContractError, match=needle):
        fpc.gitlink_sha(listing, fpc.FORK_RELATIVE, "index")


def test_gate_fails_before_any_setup_when_the_fork_is_unavailable(tmp_path: Path) -> None:
    """The fork preflight runs first: no stock Pi install, no scratch content, no bootstrap.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
    """
    work = tmp_path / "work"
    work.mkdir()
    stock = tmp_path / "stock"
    with pytest.raises(pc.ContractError, match=r"Fork .* is missing"):
        fpc.run_fork_gate(work, stock, repo_root=tmp_path / "no-parent")
    assert not stock.exists()
    assert list(work.iterdir()) == [work / "base"]
    assert not (tmp_path / "no-parent").exists()


# --- archive --------------------------------------------------------------------------------------


def test_archive_extracts_the_exact_commit_and_leaves_the_fork_alone(
    parent: Parent, sandbox: pc.Sandbox, tmp_path: Path
) -> None:
    """Only committed content lands in the copy; the real checkout is byte-identical afterwards.

    Parameters:
        parent (Parent): Disposable layout.
        sandbox (pc.Sandbox): Scrubbed environment.
        tmp_path (Path): Pytest temporary directory.
    """
    source = fpc.preflight_fork(parent.root, sandbox)
    (parent.fork / "node_modules").mkdir()
    (parent.fork / "node_modules" / "ignored").write_text("x")
    before = snapshot(parent.fork)
    dest = tmp_path / "copy"
    fpc.archive_fork(source, dest, sandbox)
    assert snapshot(dest) == {
        ".gitignore": b"node_modules/\n",
        "package-lock.json": json.dumps(LOCK).encode(),
        "package.json": json.dumps(MANIFEST).encode(),
        "src/index.ts": b"export default 1;\n",
    }
    assert snapshot(parent.fork) == before
    assert git(sandbox, parent.fork, "status", "--porcelain") == ""


def test_archive_refuses_an_existing_destination_and_missing_inputs(
    parent: Parent, sandbox: pc.Sandbox, tmp_path: Path
) -> None:
    """A reused destination and an archive lacking the lockfile are diagnostics.

    Parameters:
        parent (Parent): Disposable layout.
        sandbox (pc.Sandbox): Scrubbed environment.
        tmp_path (Path): Pytest temporary directory.
    """
    source = fpc.preflight_fork(parent.root, sandbox)
    existing = tmp_path / "exists"
    existing.mkdir()
    with pytest.raises(pc.ContractError, match="already exists"):
        fpc.archive_fork(source, existing, sandbox)
    git(sandbox, parent.fork, "rm", "-q", "package-lock.json")
    lockless = commit_all(sandbox, parent.fork, "no lock")
    with pytest.raises(pc.ContractError, match=r"lacks \['package-lock.json'\]"):
        fpc.archive_fork(fpc.ForkSource(parent.fork, lockless), tmp_path / "lockless", sandbox)


# --- dependency install ---------------------------------------------------------------------------

FAKE_NPM = textwrap.dedent(
    """\
    import json
    import os
    import shutil
    import sys
    from pathlib import Path

    Path(os.environ["FAKE_NPM_LOG"]).write_text("\\n".join(sys.argv[1:]))
    modules = Path.cwd() / "node_modules"
    for name, version in (("croner", "10.0.1"), ("nanoid", "5.1.16")):
        package = modules / name
        package.mkdir(parents=True)
        (package / "package.json").write_text(json.dumps({"version": version}))
    mode = os.environ["FAKE_NPM_MODE"]
    additions = {
        "extra": "left-pad",
        "host-top": "typebox",
        "host-nested": "croner/node_modules/@earendil-works/pi-ai",
        "nested": "croner/node_modules/unrecorded",
    }
    if mode in additions:
        (modules / additions[mode]).mkdir(parents=True)
    elif mode == "missing":
        shutil.rmtree(modules / "nanoid")
    elif mode == "skew":
        (modules / "croner/package.json").write_text('{"version": "9.9.9"}')
    elif mode == "touch-lock":
        lock = Path.cwd() / "package-lock.json"
        lock.write_text(lock.read_text() + "\\n")
    elif mode == "fail":
        sys.stderr.write("registry exploded\\n")
        sys.exit(1)
    """
)


@pytest.fixture
def fork_copy(tmp_path: Path) -> Path:
    """A fork-shaped directory holding only the files the install consumes.

    Parameters:
        tmp_path (Path): Pytest temporary directory.

    Returns:
        Path: Directory with `package.json` and `package-lock.json`.
    """
    copy_dir = tmp_path / "fork-copy"
    copy_dir.mkdir()
    (copy_dir / "package.json").write_text(json.dumps(MANIFEST))
    (copy_dir / "package-lock.json").write_text(json.dumps(LOCK))
    return copy_dir


def fake_npm_sandbox(tmp_path: Path, mode: str) -> tuple[pc.Sandbox, Path]:
    """Build a sandbox whose `npm` is a script recording its argv.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
        mode (str): `FAKE_NPM_MODE` selecting the misbehavior, or `ok`.

    Returns:
        tuple[pc.Sandbox, Path]: The sandbox and the file receiving the argv.
    """
    script = tmp_path / "fake-npm"
    script.write_text(f"#!{Path(sys.executable).resolve()}\n{FAKE_NPM}")
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    log = tmp_path / "npm-argv"
    real = pc.locate_tools()
    tools = pc.Tools(node=real.node, npm=script, git=real.git)
    return pc.Sandbox(tmp_path / "npm-sandbox", tools, {"FAKE_NPM_MODE": mode, "FAKE_NPM_LOG": str(log)}), log


def test_install_uses_the_locked_runtime_only_flags(tmp_path: Path, fork_copy: Path) -> None:
    """`npm ci` (not `install`) with scripts, dev and peers off; identity comes from the lockfile.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
        fork_copy (Path): Fork-shaped directory.
    """
    sandbox, log = fake_npm_sandbox(tmp_path, "ok")
    installed = fpc.install_fork_dependencies(fork_copy, sandbox)
    assert log.read_text().split() == [
        "ci",
        "--ignore-scripts",
        "--omit=dev",
        "--omit=peer",
        "--no-audit",
        "--no-fund",
    ]
    assert installed.version == "0.22.0"
    assert installed.lock_sha256 == hashlib.sha256(json.dumps(LOCK).encode()).hexdigest()
    assert [(d.name, d.version, d.integrity) for d in installed.dependencies] == [
        ("croner", "10.0.1", INTEGRITY),
        ("nanoid", "5.1.16", INTEGRITY),
    ]


@pytest.mark.parametrize(
    ("mode", "needle"),
    [
        ("extra", r"holds \['croner', 'left-pad', 'nanoid'\]"),
        ("missing", r"holds \['croner'\]"),
        ("host-top", "holds"),
        ("host-nested", "host packages installed into the fork copy"),
        ("nested", "unrecorded nested dependency trees"),
        ("skew", "installed 'croner' is 9.9.9, the lockfile says 10.0.1"),
        ("touch-lock", "modified the fork lockfile"),
        ("fail", "registry exploded"),
    ],
)
def test_install_rejects_deviations(tmp_path: Path, fork_copy: Path, mode: str, needle: str) -> None:
    """Extra or missing packages, duplicate host packages, version skew and a rewritten lock all fail.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
        fork_copy (Path): Fork-shaped directory.
        mode (str): Misbehavior of the fake `npm`.
        needle (str): Regex the diagnostic must match.
    """
    sandbox, _ = fake_npm_sandbox(tmp_path, mode)
    with pytest.raises(pc.ContractError, match=needle):
        fpc.install_fork_dependencies(fork_copy, sandbox)


@pytest.mark.parametrize(
    ("manifest_change", "lock_change", "needle"),
    [
        ({"name": "@someone/else"}, None, "expected '@tintinweb/pi-subagents'"),
        ({"pi": {"extensions": ["./src/other.ts"]}}, None, r"expected \['./src/index.ts'\]"),
        ({"dependencies": {"croner": "^10.0.1"}}, None, r"fork dependencies \['croner'\] differ"),
        ({"dependencies": {"croner": "^10.0.1", "nanoid": "^5", "x": "1"}}, None, "differ"),
        (None, {"packages": {"": {"dependencies": {"croner": "^10"}}}}, "root dependencies differ"),
        ({"version": 3}, None, "Malformed fork `package.json`"),
        ({"optionalDependencies": {"extra": "1.0.0"}}, None, "unsupported optional dependencies"),
        (None, {"packages": []}, "Malformed fork lockfile"),
    ],
)
def test_install_validates_manifest_and_lock_before_running_npm(
    tmp_path: Path,
    fork_copy: Path,
    manifest_change: dict[str, object] | None,
    lock_change: dict[str, object] | None,
    needle: str,
) -> None:
    """Consumed fork JSON is validated; a deviation stops the gate before any npm invocation.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
        fork_copy (Path): Fork-shaped directory.
        manifest_change (dict[str, object] | None): Fields overriding the fork manifest.
        lock_change (dict[str, object] | None): Fields overriding the lockfile.
        needle (str): Regex the diagnostic must match.
    """
    if manifest_change:
        (fork_copy / "package.json").write_text(json.dumps(MANIFEST | manifest_change))
    if lock_change:
        (fork_copy / "package-lock.json").write_text(json.dumps(LOCK | lock_change))
    sandbox, log = fake_npm_sandbox(tmp_path, "ok")
    with pytest.raises(pc.ContractError, match=needle):
        fpc.install_fork_dependencies(fork_copy, sandbox)
    assert not log.exists()


@pytest.mark.parametrize(
    ("field", "value"),
    [("integrity", None), ("integrity", "sha512-invalid"), ("version", "not-a-version")],
)
def test_invalid_runtime_identity_never_invokes_npm(
    tmp_path: Path, fork_copy: Path, field: str, value: str | None
) -> None:
    """Invalid runtime identities must fail before any registry-capable process starts.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
        fork_copy (Path): Fork-shaped directory.
        field (str): Identity field to corrupt.
        value (str | None): Malformed value, or `None` to remove the field.
    """
    lock = copy.deepcopy(LOCK)
    entry = lock["packages"]["node_modules/nanoid"]
    if value is None:
        del entry[field]
    else:
        entry[field] = value
    (fork_copy / "package-lock.json").write_text(json.dumps(lock))
    sandbox, log = fake_npm_sandbox(tmp_path, "ok")
    with pytest.raises(pc.ContractError):
        fpc.install_fork_dependencies(fork_copy, sandbox)
    assert not log.exists(), "npm ran before the lock identity was validated"


@pytest.mark.parametrize(
    ("path", "field"),
    [
        ("", "optionalDependencies"),
        ("node_modules/nanoid", "optionalDependencies"),
        ("node_modules/nanoid", "dependencies"),
    ],
)
def test_unsupported_runtime_edges_never_invoke_npm(
    tmp_path: Path, fork_copy: Path, path: str, field: str
) -> None:
    """An unmodeled dependency must not be downloaded before the installed-tree audit.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
        fork_copy (Path): Fork-shaped directory.
        path (str): Lock package entry to change.
        field (str): Dependency category to populate.
    """
    lock = copy.deepcopy(LOCK)
    lock["packages"][path][field] = {"unrecorded": "1.0.0"}
    (fork_copy / "package-lock.json").write_text(json.dumps(lock))
    sandbox, log = fake_npm_sandbox(tmp_path, "ok")
    with pytest.raises(pc.ContractError):
        fpc.install_fork_dependencies(fork_copy, sandbox)
    assert not log.exists()


def test_audit_fork_install_rejects_unversioned_lock_entries(fork_copy: Path) -> None:
    """A dependency without a locked integrity cannot be identified and is refused.

    Parameters:
        fork_copy (Path): Fork-shaped directory.
    """
    for name in fpc.FORK_RUNTIME_DEPENDENCIES:
        (fork_copy / "node_modules" / name).mkdir(parents=True)
        version = LOCK["packages"][f"node_modules/{name}"]["version"]
        (fork_copy / "node_modules" / name / "package.json").write_text(json.dumps({"version": version}))
    lock = json.loads(json.dumps(LOCK))
    del lock["packages"]["node_modules/nanoid"]["integrity"]
    parsed = fpc.ForkLockfile.model_validate(lock)
    with pytest.raises(pc.ContractError, match="no versioned, integrity-checked 'nanoid'"):
        fpc.audit_fork_install(fork_copy, parsed)


# --- agent files ----------------------------------------------------------------------------------


def test_the_real_packed_reviewer_grants_exactly_the_reviewer_tools() -> None:
    """The workspace `code-reviewer` frontmatter names read/grep/find plus four dev-tools git tools."""
    front, body = fpc.split_agent_markdown(PACKED_AGENT)
    assert fpc.declared_tools(front) == fpc.REVIEWER_TOOLS
    assert body.startswith("You review a change.")
    assert "extensions: [pi-dev-tools]" in front


@pytest.mark.parametrize(
    ("front", "expected"),
    [
        ("tools: read, grep", {"read", "grep"}),
        ("name: x\ntools: read, ext:pi-dev-tools/git_log,  ext:a/b ", {"read", "git_log", "b"}),
        ("tools:   read,,find", {"read", "find"}),
    ],
)
def test_declared_tools(front: str, expected: set[str]) -> None:
    """Built-ins stay, `ext:name/tool` yields the tool, blanks are ignored.

    Parameters:
        front (str): Frontmatter text.
        expected (set[str]): Expected tool names.
    """
    assert fpc.declared_tools(front) == frozenset(expected)


@pytest.mark.parametrize(
    ("front", "needle"),
    [("name: x", "no `tools:` line"), ("tools: ext:pi-dev-tools", "selects a whole extension")],
)
def test_declared_tools_rejects(front: str, needle: str) -> None:
    """A missing `tools:` line or a whole-extension selector is a diagnostic.

    Parameters:
        front (str): Frontmatter text.
        needle (str): Substring the diagnostic must contain.
    """
    with pytest.raises(pc.ContractError, match=needle):
        fpc.declared_tools(front)


def test_split_agent_markdown_requires_a_fence() -> None:
    """Content without `---` frontmatter is rejected; BOMs and CRLF are not silently accepted."""
    assert fpc.split_agent_markdown("---\na: 1\n---\n\nbody\n") == ("a: 1", "body")
    for bad in ("no front\n", "\ufeff---\na: 1\n---\nx", "---\r\na: 1\r\n---\r\nx"):
        with pytest.raises(pc.ContractError, match="frontmatter fence"):
            fpc.split_agent_markdown(bad)


def test_override_agent_is_a_valid_distinct_agent() -> None:
    """Overrides keep the agent type, carry their marker in the body, and parse like packaged files."""
    text = fpc.override_agent("MARK", "read, find", "false")
    front, body = fpc.split_agent_markdown(text)
    assert fpc.declared_tools(front) == {"read", "find"}
    assert "name: code-reviewer" in front
    assert "extensions: false" in front
    assert body.startswith("MARK:")


def case_named(name: str) -> fpc.CaseSpec:
    """One case built from the real packed agent.

    Parameters:
        name (str): Entry of `fpc.CASE_NAMES`.

    Returns:
        fpc.CaseSpec: The case.
    """
    return next(c for c in fpc.build_cases(PACKED_AGENT) if c.name == name)


def test_build_cases_derives_expectations_from_the_packed_file() -> None:
    """Named cases; package cases expect the packed body and tools plus the one fork helper."""
    cases = fpc.build_cases(PACKED_AGENT)
    assert tuple(c.name for c in cases) == fpc.CASE_NAMES
    package = case_named("package-default")
    global_case = case_named("global-override")
    project = case_named("project-override")
    missing = case_named("missing-dev-tools")
    assert package.expected_tools == fpc.REVIEWER_TOOLS | {"SubagentWorkflow"}
    assert package.prompt_marker == fpc.split_agent_markdown(PACKED_AGENT)[1]
    assert package.packaged_max_turns == 40
    assert global_case.expected_tools == {"read", "find"}
    assert project.expected_tools == {"read", "git_log", "SubagentWorkflow"}
    assert project.global_agent is not None
    assert project.project_agent is not None
    assert missing.with_dev_tools is False
    assert missing.expected_tools == {"read", "grep", "find", "SubagentWorkflow"}
    assert missing.extension_errors == 2
    # Precedence: each case must exclude every lower tier's marker.
    assert package.prompt_marker in global_case.absent_markers
    assert {package.prompt_marker, fpc.GLOBAL_MARKER} == set(project.absent_markers)
    # An untrusted project agent is ignored: the case is the global override with the project
    # marker excluded, not the project case under a different trust flag.
    untrusted = case_named("project-override-untrusted")
    assert untrusted.project_agent is not None
    assert untrusted.expected_tools == global_case.expected_tools
    assert untrusted.prompt_marker == fpc.GLOBAL_MARKER
    assert untrusted.allowed == "read"
    assert {package.prompt_marker, fpc.PROJECT_MARKER} == set(untrusted.absent_markers)


def test_build_cases_pins_trust_and_scope() -> None:
    """Every trust-sensitive case states its decision; only project-scope cases read `.pi/settings.json`."""
    cases = {c.name: c for c in fpc.build_cases(PACKED_AGENT)}
    assert {n: (c.trust, c.project_scope, c.agent) for n, c in cases.items()} == {
        "package-default": ("no-approve", False, "code-reviewer"),
        "global-override": ("no-approve", False, "code-reviewer"),
        "project-override": ("approve", False, "code-reviewer"),
        "project-override-untrusted": ("no-approve", False, "code-reviewer"),
        "missing-dev-tools": ("no-approve", False, "code-reviewer"),
        "project-package-trusted": ("approve", True, "code-reviewer"),
        "project-package-untrusted": ("no-approve", True, "general-purpose"),
    }
    assert cases["project-package-untrusted"].denied == ("git_status", "git_commit")


def test_denied_tools_are_the_ones_missing_from_the_allowlist() -> None:
    """The child tries every `DENIED_TOOLS` member its allowlist lacks, and only those."""
    assert case_named("package-default").denied == ("write", "bash", "git_commit")
    assert case_named("global-override").denied == fpc.DENIED_TOOLS
    assert case_named("project-override").denied == fpc.DENIED_TOOLS


def test_build_cases_rejects_a_reviewer_with_other_tools_or_no_turn_limit() -> None:
    """Drift in the packed agent's tools or `max_turns` fails before any Pi run."""
    wider = PACKED_AGENT.replace("tools: read,", "tools: read, bash,", 1)
    with pytest.raises(pc.ContractError, match="grants"):
        fpc.build_cases(wider)
    no_turns = PACKED_AGENT.replace("max_turns: 40\n", "")
    with pytest.raises(pc.ContractError, match="max_turns"):
        fpc.build_cases(no_turns)


# --- case assessment ------------------------------------------------------------------------------


TARGETS = fpc.Targets(Path("/t/repo"), Path("/t/s/w.txt"), Path("/t/s/b.txt"))


def calls_for(spec: fpc.CaseSpec) -> list[fpc.ChildCall]:
    """The child calls the spec derives for the fixed fake targets.

    Parameters:
        spec (fpc.CaseSpec): Case.

    Returns:
        list[fpc.ChildCall]: The allowed call, then the denied ones.
    """
    return fpc.child_calls(spec, TARGETS)


def assess(spec: fpc.CaseSpec, result: pc.PiRun, requests: list[fp.RecordedRequest]) -> fpc.CaseEvidence:
    """`fpc.assess_case` with the calls the spec derives.

    Parameters:
        spec (fpc.CaseSpec): Case.
        result (pc.PiRun): Synthetic run.
        requests (list[fp.RecordedRequest]): Synthetic provider requests.

    Returns:
        fpc.CaseEvidence: Evidence on success.
    """
    return fpc.assess_case(spec, result, requests, calls_for(spec))


def package_spec() -> fpc.CaseSpec:
    """The package-default case built from the real packed agent.

    Returns:
        fpc.CaseSpec: Spec under test.
    """
    return fpc.build_cases(PACKED_AGENT)[0]


def good_events(
    *,
    tool_uses: int = 4,
    status: str = "completed",
    text: str = fpc.CHILD_TEXT,
    is_error: bool = False,
    tags: tuple[str, ...] = ("thinking: off (asked medium)", "max turns: 40"),
) -> tuple[dict[str, Any], ...]:
    """Pi events of a successful parent run.

    Parameters:
        tool_uses (int): `details.toolUses`.
        status (str): `details.status`.
        text (str): Tail of the `Agent` result text.
        is_error (bool): Value of `isError`.
        tags (tuple[str, ...]): `details.tags`.

    Returns:
        tuple[dict[str, Any], ...]: Events in order.
    """
    return (
        {
            "type": "tool_execution_end",
            "toolName": "Agent",
            "isError": is_error,
            "result": {
                "content": [{"type": "text", "text": f"Agent completed in 0.1s.\n\n{text}"}],
                "details": {
                    "subagentType": "code-reviewer",
                    "status": status,
                    "toolUses": tool_uses,
                    "tags": list(tags),
                    "maxTurns": 40,
                },
            },
        },
        {
            "type": "message_end",
            "message": {"role": "assistant", "content": [{"type": "text", "text": fpc.PARENT_TEXT}]},
        },
    )


PARENT_TOOLS = (
    "read",
    "bash",
    "edit",
    "write",
    "Agent",
    "SubagentWorkflow",
    "get_subagent_result",
    "steer_subagent",
)


def good_requests(spec: fpc.CaseSpec) -> list[fp.RecordedRequest]:
    """Requests the provider sees in a successful run.

    Parameters:
        spec (fpc.CaseSpec): Case being simulated.

    Returns:
        list[fp.RecordedRequest]: Parent, one child request per call plus the answer, parent.
    """
    system = f'{spec.prompt_marker}\n<active_agent name="{spec.agent}"/>'
    outcomes = tuple(call.expect for call in calls_for(spec))
    child = [
        fp.RecordedRequest(
            "m",
            ("system", "user", *("assistant", "tool") * done),
            tuple(sorted(spec.expected_tools)),
            system,
            fpc.CHILD_MARKER,
            outcomes[:done],
        )
        for done in range(len(outcomes) + 1)
    ]
    return [
        fp.RecordedRequest("m", ("system", "user"), PARENT_TOOLS),
        *child,
        fp.RecordedRequest("m", ("system", "user", "assistant", "tool"), PARENT_TOOLS),
    ]


def run_of(events: tuple[dict[str, Any], ...], returncode: int = 0, stderr: str = "") -> pc.PiRun:
    """Wrap events in a `PiRun`.

    Parameters:
        events (tuple[dict[str, Any], ...]): Parsed events.
        returncode (int): Exit code.
        stderr (str): Standard error.

    Returns:
        pc.PiRun: The run.
    """
    return pc.PiRun(returncode, events, "", stderr)


def test_assess_case_accepts_the_expected_run() -> None:
    """A run matching every expectation yields sorted evidence."""
    spec = package_spec()
    evidence = assess(spec, run_of(good_events()), good_requests(spec))
    assert evidence["case"] == "package-default"
    assert evidence["child_tools"] == sorted(spec.expected_tools)
    assert evidence["child_text"] == fpc.CHILD_TEXT
    assert evidence["tool_uses"] == 4
    assert evidence["allowed_call"] == "git_status"
    assert evidence["denied_calls"] == ["write", "bash", "git_commit"]
    assert "Agent" in evidence["parent_tools"]
    assert len(evidence["prompt_marker"]) <= 80


def test_assess_case_records_the_degraded_missing_dependency_run() -> None:
    """The missing-dev-tools case passes with exactly the two diagnostics and built-in tools."""
    spec = case_named("missing-dev-tools")
    evidence = assess(spec, run_of(good_events(tool_uses=7)), good_requests(spec))
    assert evidence["child_tools"] == ["SubagentWorkflow", "find", "grep", "read"]
    assert evidence["denied_calls"] == ["write", "bash", "git_status", "git_commit"]
    assert evidence["tool_uses"] == 7  # 5 child calls + 2 extension diagnostics


def with_child_tools(requests: list[fp.RecordedRequest], tools: tuple[str, ...]) -> list[fp.RecordedRequest]:
    """Replace the child request's tool list.

    Parameters:
        requests (list[fp.RecordedRequest]): Requests from `good_requests`.
        tools (tuple[str, ...]): New child tools.

    Returns:
        list[fp.RecordedRequest]: Modified copy.
    """
    return [replace(r, tools=tools) if r.route else r for r in requests]


def test_assess_case_rejects_extra_missing_and_forbidden_child_tools() -> None:
    """The child tool set is exact; every forbidden tool is named when exposed."""
    spec = package_spec()
    base = sorted(spec.expected_tools)
    with pytest.raises(pc.ContractError, match=r"unexpected \['ssh_exec'\]"):
        assess(spec, run_of(good_events()), with_child_tools(good_requests(spec), (*base, "ssh_exec")))
    with pytest.raises(pc.ContractError, match=r"missing \['git_log'\]"):
        assess(
            spec,
            run_of(good_events()),
            with_child_tools(good_requests(spec), tuple(t for t in base if t != "git_log")),
        )
    wide = replace(spec, expected_tools=spec.expected_tools | {"edit", "bash"})
    with pytest.raises(pc.ContractError, match=r"forbidden tools \['bash', 'edit'\]"):
        assess(wide, run_of(good_events()), with_child_tools(good_requests(wide), tuple(wide.expected_tools)))


def test_assess_case_rejects_wrong_prompt_and_lower_precedence_leak() -> None:
    """The child prompt must hold the expected body and none of the shadowed ones."""
    spec = case_named("global-override")
    requests = good_requests(spec)
    with pytest.raises(pc.ContractError, match="lacks the expected agent body"):
        assess(
            replace(spec, prompt_marker="OTHER"),
            run_of(good_events()),
            [replace(r, system="nothing") if r.route else r for r in requests],
        )
    leaked = [replace(r, system=r.system + spec.absent_markers[0]) if r.route else r for r in requests]
    with pytest.raises(pc.ContractError, match="lower-precedence agent body reached"):
        assess(spec, run_of(good_events()), leaked)
    renamed = [replace(r, system=GOOD_RENAMED) if r.route else r for r in requests]
    with pytest.raises(pc.ContractError, match="names another agent"):
        assess(spec, run_of(good_events()), renamed)


GOOD_RENAMED = f'{fpc.GLOBAL_MARKER}\n<active_agent name="general-purpose"/>'


def test_assess_case_rejects_request_shape_and_parent_leaks() -> None:
    """Request counts, the fork's `Agent`, and `--no-extensions` leakage are checked."""
    spec = package_spec()
    good = good_requests(spec)
    with pytest.raises(pc.ContractError, match="2 parent requests, got 1"):
        assess(spec, run_of(good_events()), good[:-1])
    with pytest.raises(pc.ContractError, match=r"5 child requests .* got 0"):
        assess(spec, run_of(good_events()), [good[0], good[-1]])
    no_agent = [replace(r, tools=("read",)) if r.route is None else r for r in good]
    with pytest.raises(pc.ContractError, match="`Agent` tool is not loaded"):
        assess(spec, run_of(good_events()), no_agent)
    leaky = [replace(r, tools=(*PARENT_TOOLS, "git_status")) if r.route is None else r for r in good]
    with pytest.raises(pc.ContractError, match=r"did not keep installed packages out.*git_status"):
        assess(spec, run_of(good_events()), leaky)


@pytest.mark.parametrize(
    ("events", "needle"),
    [
        (lambda: good_events(tool_uses=1), "`toolUses` is 1, expected 4"),
        (lambda: good_events(status="error"), "ended as 'code-reviewer'/'error'"),
        (lambda: good_events(text="something else"), "does not end with the child's answer"),
        (lambda: good_events(is_error=True), "`Agent` failed"),
        (lambda: good_events(tags=()), "packaged metadata not applied"),
    ],
)
def test_assess_case_rejects_agent_result_deviations(
    events: Callable[[], tuple[dict[str, Any], ...]], needle: str
) -> None:
    """A diagnostic counted as a tool use, a failed child, wrong text, an error or lost metadata fail.

    Parameters:
        events (Callable[[], tuple[dict[str, Any], ...]]): Builds the deviating events.
        needle (str): Substring the diagnostic must contain.
    """
    spec = package_spec()
    with pytest.raises(pc.ContractError, match=re.escape(needle)):
        assess(spec, run_of(events()), good_requests(spec))


@pytest.mark.parametrize(
    "mutate",
    [
        lambda e: e[0].pop("result"),
        lambda e: e[0].__setitem__("result", {"content": [], "details": {"toolUses": "0"}}),
        lambda e: e[0].__setitem__("isError", "no"),
    ],
)
def test_assess_case_rejects_malformed_agent_events(mutate: Callable[[list[dict[str, Any]]], object]) -> None:
    """Newly consumed `Agent` result fields are validated with strict types.

    Parameters:
        mutate (Callable[[list[dict[str, Any]]], object]): Mutates the first event.
    """
    spec = package_spec()
    events: list[dict[str, Any]] = copy.deepcopy(list(good_events()))
    mutate(events)
    with pytest.raises(pc.ContractError, match=r"[Mm]alformed"):
        assess(spec, run_of(tuple(events)), good_requests(spec))


def test_assess_case_requires_a_clean_run_and_a_finishing_parent() -> None:
    """A nonzero exit, stderr noise, or a parent that never finished is a failure."""
    spec = package_spec()
    requests = good_requests(spec)
    with pytest.raises(pc.ContractError, match="pi exited 1"):
        assess(spec, run_of(good_events(), returncode=1), requests)
    with pytest.raises(pc.ContractError, match="unexpected stderr"):
        assess(spec, run_of(good_events(), stderr="warning"), requests)
    unfinished = (good_events()[0],)
    with pytest.raises(pc.ContractError, match="no well-formed final assistant message"):
        assess(spec, run_of(unfinished), requests)
    wrong_text = (
        good_events()[0],
        {"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "x"}]}},
    )
    with pytest.raises(pc.ContractError, match="did not finish with its scripted answer"):
        assess(spec, run_of(wrong_text), requests)


def test_agent_script_routes_the_child_by_its_task_marker() -> None:
    """The parent calls `Agent` for `code-reviewer` in the foreground; the child has its own script."""
    calls = calls_for(package_spec())
    parent, routes = fpc.agent_script(calls)
    step = parent[0]
    assert isinstance(step, fp.ToolStep)
    assert step.name == "Agent"
    assert step.arguments["subagent_type"] == "code-reviewer"
    assert step.arguments["run_in_background"] is False
    prompt = step.arguments["prompt"]
    assert isinstance(prompt, str)
    assert fpc.CHILD_MARKER in prompt
    assert [r.marker for r in routes] == [fpc.CHILD_MARKER]
    assert fpc.CHILD_MARKER not in fpc.CHILD_TEXT
    assert parent[-1] == fp.TextStep(fpc.PARENT_TEXT)
    assert list(routes[0].script) == [
        *(fp.ToolStep(c.tool, c.arguments) for c in calls),
        fp.TextStep(fpc.CHILD_TEXT),
    ]


# --- report ---------------------------------------------------------------------------------------


def valid_report() -> dict[str, Any]:
    """A report that satisfies every cross-check.

    Returns:
        dict[str, Any]: Raw report.
    """
    artifact = {
        "version": "0.1.0",
        "tarball": "nredd-pi-preset-0.1.0.tgz",
        "integrity": INTEGRITY,
        "shasum": "1" * 40,
        "size": 10,
        "files": ["package.json"],
    }
    dev = artifact | {"version": "0.4.0", "tarball": "nredd-pi-dev-tools-0.4.0.tgz"}
    cases = [
        {
            "case": name,
            "trust": "no-approve",
            "child_tools": ["read"],
            "prompt_marker": "m",
            "child_text": "c",
            "allowed_call": "read",
            "denied_calls": ["write"],
            "tool_uses": 2,
            "parent_tools": ["Agent"],
        }
        for name in fpc.CASE_NAMES
    ]
    return {
        "stock_pi": {
            "package": pc.STOCK_PI_PACKAGE,
            "version": pc.STOCK_PI_VERSION,
            "integrity": pc.STOCK_PI_INTEGRITY,
        },
        "node": "v26.12.0",
        "npm": "11.0.0",
        "fork": {
            "path": fpc.FORK_RELATIVE,
            "sha": "a" * 40,
            "version": "0.22.0",
            "lock_sha256": "b" * 64,
            "dependencies": [
                {"name": "croner", "version": "10.0.1", "integrity": INTEGRITY},
                {"name": "nanoid", "version": "5.1.16", "integrity": INTEGRITY},
            ],
        },
        "packages": {"@nredd/pi-preset": artifact, "@nredd/pi-dev-tools": dev},
        "cases": cases,
    }


def test_report_round_trips() -> None:
    """A complete report validates and serializes."""
    report = fpc.validate_fork_report(valid_report())
    assert report.fork.dependencies[0].name == "croner"
    assert json.loads(report.model_dump_json())["cases"][0]["case"] == "package-default"


@pytest.mark.parametrize(
    ("mutate", "needle"),
    [
        (lambda r: r["cases"].reverse(), "are not"),
        (lambda r: r["cases"].pop(), "are not"),
        (lambda r: r["packages"].pop("@nredd/pi-dev-tools"), "packages"),
        (
            lambda r: r["packages"].__setitem__("@nredd/pi-session-kit", r["packages"]["@nredd/pi-preset"]),
            "packages",
        ),
        (lambda r: r["fork"].__setitem__("sha", "abc"), "sha"),
        (lambda r: r["fork"].__setitem__("lock_sha256", "x"), "lock_sha256"),
        (lambda r: r["fork"]["dependencies"].pop(), "dependencies"),
        (lambda r: r["fork"]["dependencies"][0].__setitem__("integrity", "sha1-x"), "integrity"),
        (lambda r: r["fork"].__setitem__("extra", 1), "extra"),
        (lambda r: r["stock_pi"].__setitem__("version", "1.2.0"), "pinned"),
        (lambda r: r["cases"][0].__setitem__("case", "other"), "case"),
        (lambda r: r["cases"][0].__setitem__("tool_uses", "0"), "tool_uses"),
        (lambda r: r["cases"][0].__setitem__("child_tools", []), "child_tools"),
        (lambda r: r.__setitem__("node", "26"), "node"),
    ],
)
def test_report_rejects_malformed_or_incomplete(
    mutate: Callable[[dict[str, Any]], object], needle: str
) -> None:
    """Missing/extra/misordered cases and packages, bad identities and unpinned Pi are refused.

    Parameters:
        mutate (Callable[[dict[str, Any]], object]): Mutates a valid report.
        needle (str): Substring the diagnostic must contain.
    """
    raw = valid_report()
    mutate(raw)
    with pytest.raises(pc.ContractError, match=needle):
        fpc.validate_fork_report(raw)


def test_main_refuses_nonempty_work_dir(tmp_path: Path) -> None:
    """A reused scratch directory is a usage error, reported before any work.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
    """
    (tmp_path / "stale").write_text("x")
    assert fpc.main(["--work-dir", str(tmp_path)]) == 2


def test_main_reports_an_unavailable_fork_as_a_failure_without_side_effects(tmp_path: Path) -> None:
    """The CLI exits 1 with the diagnostic and leaves the stock prefix and scratch directory empty.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
    """
    work = tmp_path / "work"
    code = fpc.main(
        [
            "--repo-root",
            str(tmp_path / "no-parent"),
            "--work-dir",
            str(work),
            "--stock-prefix",
            str(tmp_path / "s"),
        ]
    )
    assert code == 1
    assert not (tmp_path / "s").exists()
    assert not work.exists()


# --- child calls ----------------------------------------------------------------------------------


def test_child_calls_run_the_allowed_tool_then_every_denied_one() -> None:
    """The allowed call targets the disposable repo; denied calls expect Pi's unknown-tool answer."""
    calls = calls_for(case_named("package-default"))
    assert [(c.tool, c.allowed) for c in calls] == [
        ("git_status", True),
        ("write", False),
        ("bash", False),
        ("git_commit", False),
    ]
    assert calls[0].arguments == {"cwd": "/t/repo"}
    assert calls[0].expect == fpc.UNTRACKED_NAME
    assert [c.expect for c in calls[1:]] == [f"Tool {t} not found" for t in ("write", "bash", "git_commit")]
    assert calls[1].arguments["path"] == "/t/s/w.txt"
    assert "/t/s/b.txt" in calls[2].arguments["command"]
    assert calls[3].arguments["push"] is False
    assert calls[3].arguments["cwd"] == "/t/repo"


def test_denied_bash_call_quotes_its_disposable_target() -> None:
    """A quote in the scratch path cannot turn the negative probe into another shell command."""
    path = Path("/tmp/contract's scratch/forbidden.txt")
    targets = replace(TARGETS, bash_sentinel=path)
    call = next(c for c in fpc.child_calls(package_spec(), targets) if c.tool == "bash")
    assert shlex.split(call.arguments["command"]) == ["/usr/bin/touch", str(path)]


def test_child_calls_refuse_an_allowed_tool_outside_the_allowlist() -> None:
    """A spec cannot call a tool its allowlist excludes as if it were allowed."""
    with pytest.raises(pc.ContractError, match="not granted"):
        calls_for(replace(case_named("global-override"), allowed="git_status"))


def test_assess_case_rejects_an_allowed_call_that_failed_or_a_denied_call_that_ran() -> None:
    """Each tool result must contain its expectation: results are matched call by call."""
    spec = package_spec()
    good = good_requests(spec)
    broken = [replace(r, tool_results=("boom", *r.tool_results[1:])) if r.tool_results else r for r in good]
    with pytest.raises(pc.ContractError, match=r"`git_status` \(allowed\) answered 'boom'"):
        assess(spec, run_of(good_events()), broken)
    ran = [
        replace(r, tool_results=(*r.tool_results[:1], "ok", *r.tool_results[2:]))
        if len(r.tool_results) > 1
        else r
        for r in good
    ]
    with pytest.raises(pc.ContractError, match=r"`write` \(denied\) answered 'ok'"):
        assess(spec, run_of(good_events()), ran)
    short = [r for r in good if len(r.tool_results) < 3]
    with pytest.raises(pc.ContractError, match="child requests"):
        assess(spec, run_of(good_events()), short)


def test_seed_targets_builds_a_real_disposable_repository(tmp_path: Path, sandbox: pc.Sandbox) -> None:
    """The seeded repo has one commit, one tracked and one untracked file; sentinels are absent."""
    targets = fpc.seed_targets(tmp_path / "targets", sandbox)
    assert git(sandbox, targets.repo, "log", "--format=%s").strip() == fpc.LOG_SUBJECT
    assert git(sandbox, targets.repo, "status", "--porcelain").strip() == f"?? {fpc.UNTRACKED_NAME}"
    assert targets.note.read_text().strip() == fpc.NOTE_TEXT
    assert not targets.write_sentinel.exists()
    assert not targets.bash_sentinel.exists()
    assert targets.write_sentinel.parent.is_dir()
    with pytest.raises(FileExistsError):
        fpc.seed_targets(tmp_path / "targets", sandbox)
