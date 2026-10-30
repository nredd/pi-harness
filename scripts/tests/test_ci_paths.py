"""Test CI changed-path classification against real disposable Git repositories.

References:
    https://git-scm.com/docs/git-diff
    https://git-scm.com/docs/git-mv
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ci_paths

GIT = ci_paths.GIT


def git(repo: Path, *args: str) -> str:
    """Run Git in a disposable repository.

    Parameters:
        repo (Path): Repository to operate in.
        *args (str): Git arguments after `-C <repo>`.

    Returns:
        str: Stripped standard output.
    """
    completed = subprocess.run([GIT, "-C", str(repo), *args], check=True, capture_output=True, text=True)
    return completed.stdout.strip()


def commit(repo: Path, message: str) -> str:
    """Commit all staged fixture changes and return the resulting revision.

    Parameters:
        repo (Path): Repository containing staged changes.
        message (str): Commit subject.

    Returns:
        str: Full commit revision.
    """
    git(repo, "commit", "-q", "-m", message)
    return git(repo, "rev-parse", "HEAD")


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """Create a real repository with an initial commit.

    Parameters:
        tmp_path (Path): Pytest temporary directory.

    Returns:
        Path: Initialized repository.
    """
    git(tmp_path, "init", "-q", "-b", "main")
    git(tmp_path, "config", "user.email", "t@example.invalid")
    git(tmp_path, "config", "user.name", "t")
    git(tmp_path, "config", "commit.gpgsign", "false")
    (tmp_path / "tracked.txt").write_text("initial\n", encoding="utf-8")
    git(tmp_path, "add", ".")
    commit(tmp_path, "initial")
    return tmp_path


def classify_change(repo: Path, files: dict[str, str]) -> ci_paths.ChangeClassification:
    """Commit changed files and classify the resulting real Git diff.

    Parameters:
        repo (Path): Disposable repository.
        files (dict[str, str]): Relative paths and contents to commit.

    Returns:
        ci_paths.ChangeClassification: CI classification for the new commit.
    """
    base = git(repo, "rev-parse", "HEAD")
    for relative, content in files.items():
        target = repo / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    git(repo, "add", ".")
    commit(repo, "change")
    return ci_paths.classify(repo, base, "HEAD")


@pytest.mark.parametrize(
    "path",
    [
        "docs/ci.md",
        "CONTRIBUTING.md",
        "PLAN.md",
        "packages/dev-tools/README.md",
        "packages/session-kit/CHANGELOG.md",
    ],
)
def test_classify_accepts_documentation_paths(repo: Path, path: str) -> None:
    """Classify the explicitly allowed documentation path families as docs-only.

    Parameters:
        repo (Path): Disposable repository.
        path (str): Documentation path to change.

    Returns:
        None: Assertions verify classification.
    """
    result = classify_change(repo, {path: "documentation\n"})
    assert result.docs_only
    assert result.paths == (path,)


@pytest.mark.parametrize(
    "path",
    [
        "README.md",
        "packages/preset/README.md",
        ".github/workflows/ci.yml",
        "package-lock.json",
        "forks/pi",
        "integration/README.md",
        "scripts/ci_paths.py",
        "releases/example.json",
        "packages/session-kit/docs/stats-snapshots.md",
    ],
)
def test_classify_rejects_code_and_tested_documentation(repo: Path, path: str) -> None:
    """Classify workflow, runtime, identity, and test-read documentation as code.

    Parameters:
        repo (Path): Disposable repository.
        path (str): Code or tested-documentation path to change.

    Returns:
        None: Assertions verify classification.
    """
    result = classify_change(repo, {path: "input\n"})
    assert not result.docs_only
    assert result.paths == (path,)


def test_classify_rejects_mixed_changes(repo: Path) -> None:
    """Require every changed file to be an allowed documentation path.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify classification.
    """
    result = classify_change(repo, {"docs/ci.md": "docs\n", "packages/dev-tools/src/index.ts": "code\n"})
    assert not result.docs_only
    assert result.paths == ("docs/ci.md", "packages/dev-tools/src/index.ts")


def test_classify_rejects_empty_diff(repo: Path) -> None:
    """Do not bypass CI if Git reports no changed paths.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify classification.
    """
    head = git(repo, "rev-parse", "HEAD")
    result = ci_paths.classify(repo, head, head)
    assert not result.docs_only
    assert result.paths == ()


def test_classify_rejects_renamed_tested_documentation(repo: Path) -> None:
    """Keep a tested source endpoint visible when it is renamed into documentation.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify classification.
    """
    (repo / "README.md").write_text("tested input\n", encoding="utf-8")
    git(repo, "add", "README.md")
    base = commit(repo, "add readme")
    (repo / "docs").mkdir()
    git(repo, "mv", "README.md", "docs/readme.md")
    commit(repo, "move readme")
    result = ci_paths.classify(repo, base, "HEAD")
    assert not result.docs_only
    assert result.paths == ("README.md", "docs/readme.md")


@pytest.mark.parametrize("operation", ["add", "change", "delete"])
def test_classify_rejects_gitlink_at_documentation_path(repo: Path, operation: str) -> None:
    """Treat every Gitlink endpoint as code, even at an allowed documentation path.

    Parameters:
        repo (Path): Disposable repository.
        operation (str): Gitlink transition to compare.

    Returns:
        None: Assertions verify classification.
    """
    path = "docs/example.md"
    initial_gitlink = "1" * 40
    changed_gitlink = "2" * 40
    if operation != "add":
        git(repo, "update-index", "--add", "--cacheinfo", f"160000,{initial_gitlink},{path}")
        commit(repo, "add gitlink")
    base = git(repo, "rev-parse", "HEAD")
    if operation == "delete":
        git(repo, "update-index", "--force-remove", path)
    else:
        git(repo, "update-index", "--add", "--cacheinfo", f"160000,{changed_gitlink},{path}")
    commit(repo, f"{operation} gitlink")

    result = ci_paths.classify(repo, base, "HEAD")

    assert not result.docs_only
    assert result.paths == ()


def test_classify_rejects_deleted_code(repo: Path) -> None:
    """Treat deletion of a code input as code rather than an empty diff.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify classification.
    """
    target = repo / "scripts" / "input.py"
    target.parent.mkdir()
    target.write_text("code\n", encoding="utf-8")
    git(repo, "add", "scripts/input.py")
    base = commit(repo, "add code")
    target.unlink()
    git(repo, "add", "--all")
    commit(repo, "delete code")
    result = ci_paths.classify(repo, base, "HEAD")
    assert not result.docs_only
    assert result.paths == ("scripts/input.py",)


def test_classify_fails_closed_for_invalid_base(repo: Path) -> None:
    """Treat an unresolvable revision as code rather than documentation-only.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify classification.
    """
    result = ci_paths.classify(repo, "not-a-revision", "HEAD")
    assert not result.docs_only
    assert result.paths == ()


def test_classify_fails_closed_for_missing_repository(tmp_path: Path) -> None:
    """Treat a missing repository directory as code rather than documentation-only.

    Parameters:
        tmp_path (Path): Pytest temporary directory.

    Returns:
        None: Assertions verify classification.
    """
    result = ci_paths.classify(tmp_path / "missing", "HEAD", "HEAD")
    assert not result.docs_only
    assert result.paths == ()


def test_write_github_output_preserves_changed_file_list(tmp_path: Path) -> None:
    """Publish boolean and newline-delimited paths through Actions output syntax.

    Parameters:
        tmp_path (Path): Pytest temporary directory.

    Returns:
        None: Assertions verify workflow output.
    """
    output = tmp_path / "output"
    ci_paths.write_github_output(
        output,
        ci_paths.ChangeClassification(
            paths=("docs/ci.md", "PLAN.md"), docs_only=True, wsl_inputs=False, stack_inputs=False
        ),
    )
    contents = output.read_text(encoding="utf-8")
    assert "docs_only=true\n" in contents
    assert "wsl_inputs=false\n" in contents
    assert "stack_inputs=false\n" in contents
    assert "docs/ci.md\nPLAN.md\n" in contents


@pytest.mark.parametrize(
    ("wsl_inputs", "stack_inputs"), [(True, False), (False, True), (True, True), (False, False)]
)
def test_write_github_output_keeps_input_flags_independent(
    tmp_path: Path, wsl_inputs: bool, stack_inputs: bool
) -> None:
    """Publish each input flag from its own field.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
        wsl_inputs (bool): Whether the fixture touches WSL inputs.
        stack_inputs (bool): Whether the fixture touches stack inputs.

    Returns:
        None: Assertions verify workflow output.
    """
    output = tmp_path / "output"
    ci_paths.write_github_output(
        output,
        ci_paths.ChangeClassification(
            paths=("a",), docs_only=False, wsl_inputs=wsl_inputs, stack_inputs=stack_inputs
        ),
    )
    lines = output.read_text(encoding="utf-8").splitlines()
    assert f"wsl_inputs={str(wsl_inputs).lower()}" in lines
    assert f"stack_inputs={str(stack_inputs).lower()}" in lines


@pytest.mark.parametrize(
    "path",
    [
        ".github/workflows/ci.yml",
        ".github/actions/setup-ci-wsl/action.yml",
        "scripts/wsl2_setup.sh",
        "scripts/wsl2_shell.ps1",
        "scripts/ci_paths.py",
        "scripts/install_gh_linux.sh",
        "scripts/install_wsl_owned_tools.sh",
        "Makefile",
        "package.json",
        ".node-version",
        ".bun-version",
        ".python-version",
        ".gitattributes",
        ".gitmodules",
    ],
)
def test_wsl_inputs_accept_paths_the_guest_path_reads(repo: Path, path: str) -> None:
    """Run WSL on a PR whenever setup, adapter, make or tool pins change.

    Parameters:
        repo (Path): Disposable repository.
        path (str): WSL path input.

    Returns:
        None: Assertions verify classification.
    """
    assert classify_change(repo, {path: "input\n"}).wsl_inputs


@pytest.mark.parametrize(
    "path",
    [
        "docs/ci.md",
        "PLAN.md",
        "packages/dev-tools/src/index.ts",
        "package-lock.json",
        "integration/harness/stack.py",
        "scripts/merge_pr_checks.py",
        "scripts/tests/test_wsl2_workflow.py",
        "scripts/tests/ci_helper.py",
        "docs/.github/notes.md",
    ],
)
def test_wsl_inputs_reject_paths_outside_the_guest_path(repo: Path, path: str) -> None:
    """Bypass WSL on a PR that only changes ordinary package or test sources.

    Parameters:
        repo (Path): Disposable repository.
        path (str): Path the WSL path does not depend on.

    Returns:
        None: Assertions verify classification.
    """
    assert not classify_change(repo, {path: "input\n"}).wsl_inputs


@pytest.mark.parametrize(
    "path",
    [
        "integration/stacks/personal.json",
        "integration/harness/stack.py",
        "integration/scenarios/test_stack.py",
        "integration/providers/auth_guard.mjs",
        "integration/golden/personal-tools.txt",
        "integration/probes/stack-resources.ts",
        "integration/conftest.py",
        "integration/pyproject.toml",
        "integration/uv.lock",
        "Makefile",
        ".github/workflows/ci.yml",
        "forks/pi/README.md",
        "package.json",
        "package-lock.json",
        ".gitmodules",
        ".node-version",
        ".bun-version",
        ".python-version",
        "scripts/wsl2_run.sh",
    ],
)
def test_stack_inputs_accept_paths_the_personal_stack_reads(repo: Path, path: str) -> None:
    """Keep the personal scenarios on any change to their real inputs.

    Parameters:
        repo (Path): Disposable repository.
        path (str): Personal stack input.

    Returns:
        None: Assertions verify classification.
    """
    assert classify_change(repo, {path: "input\n"}).stack_inputs


@pytest.mark.parametrize(
    "path",
    [
        "docs/ci.md",
        "packages/session-kit/src/index.ts",
        "packages/preset/package.json",
        "integration/README.md",
        "integration/tests/test_stack.py",
        "integration/inprocess/support.ts",
        "scripts/merge_pr_checks.py",
        "integration/stacksy/x.json",
    ],
)
def test_stack_inputs_reject_local_only_and_unrelated_paths(repo: Path, path: str) -> None:
    """Treat `packages/` as `local` input only, the personal stack installs published bytes.

    Parameters:
        repo (Path): Disposable repository.
        path (str): Path the personal stack does not read.

    Returns:
        None: Assertions verify classification.
    """
    assert not classify_change(repo, {path: "input\n"}).stack_inputs


def test_mixed_change_reports_each_input_family(repo: Path) -> None:
    """Keep the input flags independent of `docs_only` and of each other.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify classification.
    """
    result = classify_change(repo, {"docs/ci.md": "docs\n", "scripts/ci_paths.py": "code\n"})
    assert (result.docs_only, result.wsl_inputs, result.stack_inputs) == (False, True, False)


@pytest.mark.parametrize("case", ["invalid-base", "gitlink", "empty"])
def test_input_flags_fail_closed(repo: Path, case: str) -> None:
    """Never bypass real work when the comparison cannot name what changed.

    Parameters:
        repo (Path): Disposable repository.
        case (str): Comparison the classifier cannot trust.

    Returns:
        None: Assertions verify classification.
    """
    base = git(repo, "rev-parse", "HEAD")
    if case == "invalid-base":
        base = "not-a-revision"
    elif case == "gitlink":
        git(repo, "update-index", "--add", "--cacheinfo", f"160000,{'1' * 40},forks/pi")
        commit(repo, "bump gitlink")
    result = ci_paths.classify(repo, base, "HEAD")
    assert result.wsl_inputs
    assert result.stack_inputs
