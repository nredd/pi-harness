"""Test CI changed-path classification against real disposable Git repositories.

References:
    https://git-scm.com/docs/git-diff
    https://git-scm.com/docs/git-mv
"""

from __future__ import annotations

import json
import runpy
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ci_paths
import coverage_accounting
import merge_pr_checks

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
    if path.startswith("packages/"):
        classify_change(repo, {path: "seed\n"})  # editing a package doc, not adding one
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
    result = ci_paths.ChangeClassification(
        paths=("docs/ci.md", "PLAN.md"), docs_only=True, inputs={"wsl_inputs": False, "stack_inputs": False}
    )
    ci_paths.write_github_output(output, result, ci_paths.plan_cells(result, "push"))
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
    result = ci_paths.ChangeClassification(
        paths=("a",), docs_only=False, inputs={"wsl_inputs": wsl_inputs, "stack_inputs": stack_inputs}
    )
    ci_paths.write_github_output(output, result, ci_paths.plan_cells(result, "push"))
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
        "scripts/install_gh_linux.py",
        "scripts/install_gh_linux.sh",
        "scripts/install_wsl_owned_tools.sh",
        "Makefile",
        "package.json",
        ".npmrc",
        ".node-version",
        ".bun-version",
        ".python-version",
        ".gitattributes",
        ".gitmodules",
        "coverage/policy.json",
        "package-lock.json",
        "integration/pyproject.toml",
        "integration/uv.lock",
        "integration/probes/stack-resources.ts",
        "integration/providers/faux.ts",
        "scripts/check-biome-paths.mjs",
        "scripts/check-biome-paths.test.mjs",
        "scripts/coverage-configs.test.ts",
        "scripts/import_audit.test.ts",
        "scripts/import_audit.ts",
        "scripts/router_contract.mjs",
        "scripts/router_contract.test.mjs",
        "scripts/run-vitest.test.ts",
        "scripts/run-vitest.ts",
        "scripts/vitest.config.ts",
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
    assert classify_change(repo, {path: "input\n"}).inputs["wsl_inputs"]


@pytest.mark.parametrize(
    "path",
    [
        "docs/ci.md",
        "PLAN.md",
        "packages/dev-tools/src/index.ts",
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
    assert not classify_change(repo, {path: "input\n"}).inputs["wsl_inputs"]


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
        ".npmrc",
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
    assert classify_change(repo, {path: "input\n"}).inputs["stack_inputs"]


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
    assert not classify_change(repo, {path: "input\n"}).inputs["stack_inputs"]


@pytest.mark.parametrize(
    "path",
    [
        "benchmarks/comparison/src/pi_harness_benchmark/usage.py",
        "benchmarks/comparison/tests/test_usage.py",
        "benchmarks/comparison/pyproject.toml",
        "benchmarks/comparison/uv.lock",
        "benchmarks/comparison/results/runs/a/result.json",
        "Makefile",
        ".python-version",
        ".node-version",
        ".github/workflows/ci.yml",
        ".github/actions/setup-ci-tools/action.yml",
        "scripts/ci_paths.py",
    ],
)
def test_benchmark_inputs_accept_paths_the_unit_gate_reads(repo: Path, path: str) -> None:
    """Run the gate for its code, tests, lockfile, pins, Makefile recipes and workflow step.

    Parameters:
        repo (Path): Disposable repository.
        path (str): Path `check-benchmark` or its CI step reads.

    Returns:
        None: Assertions verify classification.
    """
    assert classify_change(repo, {path: "input\n"}).inputs["benchmark_inputs"]


@pytest.mark.parametrize(
    "path",
    [
        "packages/router/src/index.ts",
        "scripts/ci_guest_x.py",
        "integration/pyproject.toml",
        "integration/uv.lock",
        "package.json",
        ".bun-version",
        ".github/workflows/release.yml",
        ".github/actions/setup-ci-wsl/action.yml",
        "benchmarks/other/pyproject.toml",
        "benchmarks/comparison-notes.md",
        "docs/ci.md",
        "coverage/policy.json",
    ],
)
def test_benchmark_inputs_reject_paths_the_unit_gate_never_reads(repo: Path, path: str) -> None:
    """Skip the gate for product code, other Python projects, other workflows and docs.

    Parameters:
        repo (Path): Disposable repository.
        path (str): Path `check-benchmark` does not read.

    Returns:
        None: Assertions verify classification.
    """
    assert not classify_change(repo, {path: "input\n"}).inputs["benchmark_inputs"]


def test_benchmark_inputs_follow_any_changed_path(repo: Path) -> None:
    """Run the gate when one benchmark path rides along with unrelated changes.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify classification.
    """
    result = classify_change(repo, {"packages/router/a.ts": "x\n", "benchmarks/comparison/uv.lock": "lock\n"})
    assert result.inputs["benchmark_inputs"]
    assert not result.inputs["wsl_inputs"]


def test_mixed_change_reports_each_input_family(repo: Path) -> None:
    """Keep the input flags independent of `docs_only` and of each other.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify classification.
    """
    result = classify_change(repo, {"docs/ci.md": "docs\n", "scripts/ci_paths.py": "code\n"})
    assert (result.docs_only, result.inputs["wsl_inputs"], result.inputs["stack_inputs"]) == (
        False,
        True,
        False,
    )


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
    assert result.inputs["wsl_inputs"]
    assert result.inputs["stack_inputs"]
    assert result.inputs["benchmark_inputs"]


PULL_REQUEST = "pull_request"
PUSH = "push"
ALL_NATIVE_GATES = ("check-ts", "check-scripts", "check-integration")
# The macOS `python` shard also carries the benchmark steps, which read the plan's `skipped_gates`.
MAC_GATES = (*ALL_NATIVE_GATES, "check-benchmark")
WSL_GATES = ("check-ts", "check-probes", "check-providers", "check-import-audit")


def plan_change(repo: Path, files: dict[str, str], event: str) -> dict[str, ci_paths.CellPlan]:
    """Commit files and plan every cell for the resulting real Git diff.

    Parameters:
        repo (Path): Disposable repository.
        files (dict[str, str]): Relative paths and contents to commit.
        event (str): Triggering event name.

    Returns:
        dict[str, ci_paths.CellPlan]: The plan per required check name.
    """
    return ci_paths.plan_cells(classify_change(repo, files), event)


def test_plan_names_are_exactly_the_required_checks(repo: Path) -> None:
    """Report every ruleset context, bypass cells included, on every event.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the plan keys.
    """
    for event in (PULL_REQUEST, PUSH):
        assert set(plan_change(repo, {"a.txt": event}, event)) == merge_pr_checks.EXPECTED_MATRIX


def test_code_change_runs_every_native_cell_with_its_gates(repo: Path) -> None:
    """Run native `owned` with all three gates and keep WSL to its LCOV producers.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the plan.
    """
    plan = plan_change(repo, {"packages/dev-tools/src/index.ts": "x\n"}, PULL_REQUEST)
    ubuntu = plan["owned (ubuntu-24.04)"]
    assert ubuntu == ci_paths.CellPlan(
        True, True, ALL_NATIVE_GATES, "", shards=ubuntu.shards, guest="linux", coverage_os="linux"
    )
    assert len(ubuntu.shards) == 4
    assert plan["owned (macos-14)"].gates == MAC_GATES
    assert plan["contracts (macos-14)"] == ci_paths.CellPlan(True, True, (), "")
    assert plan["stack (macos-14, local)"].scenarios
    assert plan["stack (ubuntu-24.04, local)"].scenarios
    # `packages/` feeds `local` only: the personal stack runs setup without scenarios.
    assert plan["stack (ubuntu-24.04, personal)"].run
    assert not plan["stack (ubuntu-24.04, personal)"].scenarios
    assert "no stack inputs" in plan["stack (ubuntu-24.04, personal)"].reason
    # No WSL inputs: WSL bypasses on a PR, with the reason named per job.
    assert not plan["owned (wsl2)"].run
    assert plan["owned (wsl2)"].reason.startswith(
        "This pull request changes no CI or WSL inputs; owned (wsl2)"
    )
    assert plan["contracts (wsl2)"].reason.startswith(
        "This pull request changes no CI or WSL inputs; contracts"
    )


@pytest.mark.parametrize(
    "path",
    [
        "packages/x/AGENTS.md",
        "packages/x/NOTICE.md",
        "packages/x/docs/a.md",
        "packages/x/.hidden",
        "packages/x/src/shot.png",
        "packages/x/package.json",
        "packages/x/test/a.test.mjs",
        "integration/inprocess/biome.json",
        "scripts/package_layout.json",
    ],
)
def test_layout_relevant_changes_run_check_scripts_on_every_native_cell(repo: Path, path: str) -> None:
    """Never skip the layout gate (`scripts/package_layout.py`, in `check-scripts`) for a change it reads.

    Parameters:
        repo (Path): Disposable repository.
        path (str): Changed path that can add or remove a layout violation.

    Returns:
        None: Assertions verify the classification and the planned gates.
    """
    assert not classify_change(repo, {path: "x\n"}).docs_only
    plan = plan_change(repo, {path: "y\n"}, PULL_REQUEST)
    for cell in ("owned (ubuntu-24.04)", "owned (macos-14)"):
        assert plan[cell].run
        assert "check-scripts" in plan[cell].gates


@pytest.mark.parametrize("name", ["README.md", "CHANGELOG.md"])
def test_adding_or_deleting_a_package_doc_is_not_docs_only(repo: Path, name: str) -> None:
    """Run the layout gate when a package gains or loses a doc; editing the same doc stays docs-only.

    Parameters:
        repo (Path): Disposable repository.
        name (str): Package doc.

    Returns:
        None: Assertions verify each diff.
    """
    path = f"packages/x/{name}"
    added = classify_change(repo, {path: "one\n"})
    assert added.paths == (path,)
    assert not added.docs_only
    assert classify_change(repo, {path: "two\n"}).docs_only
    base = git(repo, "rev-parse", "HEAD")
    (repo / path).unlink()
    git(repo, "add", "--all")
    commit(repo, "delete the doc")
    result = ci_paths.classify(repo, base, "HEAD")
    assert result.paths == (path,)
    assert not result.docs_only


def test_classify_fails_closed_when_the_trees_cannot_be_listed(
    repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Treat a diff as code when the package-doc presence check cannot run.

    Parameters:
        repo (Path): Disposable repository.
        monkeypatch (pytest.MonkeyPatch): Makes the presence check fail.

    Returns:
        None: Assertions verify the classification.
    """

    def fail(*_args: object) -> bool:
        """Fail like a broken Git.

        Parameters:
            *_args (object): Ignored.

        Returns:
            bool: Never.

        Raises:
            ClassificationError: Always.
        """
        raise ci_paths.ClassificationError("boom")

    base = git(repo, "rev-parse", "HEAD")
    (repo / "packages" / "x").mkdir(parents=True)
    (repo / "packages/x/README.md").write_text("x\n", encoding="utf-8")
    git(repo, "add", "--all")
    commit(repo, "add doc")
    monkeypatch.setattr(ci_paths, "changes_package_doc_presence", fail)
    result = ci_paths.classify(repo, base, "HEAD")
    assert not result.docs_only
    assert result.paths == ()
    assert all(result.inputs.values())


def test_wsl_inputs_wake_wsl_with_only_the_lcov_producers(repo: Path) -> None:
    """Run WSL on a PR that changes its inputs, without the duplicate Python unit suites.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the plan.
    """
    plan = plan_change(repo, {".github/workflows/ci.yml": "x\n"}, PULL_REQUEST)
    wsl = plan["owned (wsl2)"]
    assert wsl == ci_paths.CellPlan(
        True, True, WSL_GATES, "", shards=wsl.shards, guest="wsl2", coverage_os="linux"
    )
    assert len(wsl.shards) == 2
    assert plan["contracts (wsl2)"].run
    assert plan["stack (ubuntu-24.04, personal)"].scenarios


def test_stack_inputs_wake_the_personal_scenarios(repo: Path) -> None:
    """Run personal scenarios on a PR that changes the stack harness.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the plan.
    """
    plan = plan_change(repo, {"integration/harness/stack.py": "x\n"}, PULL_REQUEST)
    assert plan["stack (ubuntu-24.04, personal)"] == ci_paths.CellPlan(True, True, (), "")
    assert not plan["owned (wsl2)"].run


@pytest.mark.parametrize("event", [PULL_REQUEST, PUSH])
def test_docs_only_change_bypasses_native_cells_and_wsl_runs_on_main(repo: Path, event: str) -> None:
    """Report NOT RUN for docs-only changes everywhere except a real WSL cell on `main`.

    Parameters:
        repo (Path): Disposable repository.
        event (str): Triggering event name.

    Returns:
        None: Assertions verify the plan.
    """
    plan = plan_change(repo, {"docs/ci.md": "x\n"}, event)
    for name in (
        "owned (ubuntu-24.04)",
        "owned (macos-14)",
        "contracts (ubuntu-24.04)",
        "contracts (macos-14)",
    ):
        assert plan[name] == ci_paths.CellPlan(False, False, (), ci_paths.NOT_RUN["docs_only"])
    assert plan["stack (ubuntu-24.04, personal)"].reason == ci_paths.NOT_RUN["docs_only"]
    assert plan["stack (macos-14, local)"].reason == ci_paths.NOT_RUN["docs_only"]
    assert plan["owned (wsl2)"].run is (event == PUSH)
    assert plan["contracts (wsl2)"].run is (event == PUSH)
    if event == PUSH:
        assert plan["owned (wsl2)"].gates == WSL_GATES


@pytest.mark.parametrize("event", [PULL_REQUEST, PUSH])
@pytest.mark.parametrize("stack_cell", [("macos-14", "personal"), ("wsl2", "personal"), ("wsl2", "local")])
def test_permanent_stack_bypass_cells_report_why_on_every_change(
    repo: Path, event: str, stack_cell: tuple[str, str]
) -> None:
    """Keep the three stack names that never run reporting NOT RUN, even for docs-only changes.

    Parameters:
        repo (Path): Disposable repository.
        event (str): Triggering event name.
        stack_cell (tuple[str, str]): Matrix `os` and `stack`.

    Returns:
        None: Assertions verify the plan.
    """
    for files in ({"docs/ci.md": "x\n"}, {".github/workflows/ci.yml": "x\n"}):
        plan = plan_change(repo, files, event)[f"stack ({stack_cell[0]}, {stack_cell[1]})"]
        assert plan == ci_paths.CellPlan(False, False, (), ci_paths.STACK_NOT_RUN[stack_cell])


def test_main_push_keeps_only_the_ubuntu_personal_smoke(repo: Path) -> None:
    """Run the merged-result smoke on `main` and skip the other running stack cells.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the plan.
    """
    plan = plan_change(repo, {"packages/dev-tools/src/index.ts": "x\n"}, PUSH)
    # `stack_inputs` is false here, yet `main` ignores it for the smoke cell.
    assert plan["stack (ubuntu-24.04, personal)"] == ci_paths.CellPlan(True, True, (), "")
    for name in ("stack (ubuntu-24.04, local)", "stack (macos-14, local)"):
        assert plan[name] == ci_paths.CellPlan(False, False, (), ci_paths.NOT_RUN["main_smoke"])
    assert plan["owned (macos-14)"].gates == MAC_GATES
    assert plan["owned (wsl2)"].gates == WSL_GATES


@pytest.mark.parametrize("case", ["invalid-base", "gitlink", "empty"])
def test_plan_fails_closed_to_running_everything(repo: Path, case: str) -> None:
    """Never bypass work when the comparison cannot name what changed.

    Parameters:
        repo (Path): Disposable repository.
        case (str): Comparison the classifier cannot trust.

    Returns:
        None: Assertions verify the plan.
    """
    base = git(repo, "rev-parse", "HEAD")
    if case == "invalid-base":
        base = "not-a-revision"
    elif case == "gitlink":
        git(repo, "update-index", "--add", "--cacheinfo", f"160000,{'1' * 40},forks/pi")
        commit(repo, "bump gitlink")
    plan = ci_paths.plan_cells(ci_paths.classify(repo, base, "HEAD"), PULL_REQUEST)
    assert plan["owned (wsl2)"].run
    assert plan["owned (macos-14)"].gates == MAC_GATES
    assert plan["stack (ubuntu-24.04, personal)"].scenarios


@pytest.mark.parametrize(
    ("title", "number", "blocked"),
    [
        ("A" * 65, 305, False),
        ("A" * 66, 305, True),
        ("Pin the benchmark gate interpreter so pydantic-core stops compiling", 305, True),
        ("Short title", 1234567, False),
    ],
)
def test_squash_subject_problem_counts_the_appended_pull_number(
    title: str, number: int, blocked: bool
) -> None:
    """Fail a PR title whose squash subject `<title> (#N)` is over 72 characters.

    Parameters:
        title (str): Pull request title.
        number (int): Pull request number.
        blocked (bool): Whether the subject is too long.

    Returns:
        None: Assertions verify the message.
    """
    problem = ci_paths.squash_subject_problem(title, number)
    assert bool(problem) is blocked
    if blocked:
        assert f"this one is {len(title) + len(f' (#{number})')};" in problem
        assert f"keep the title to {72 - len(f' (#{number})')})" in problem


def test_long_title_blocks_every_cell_before_any_slot_runs(repo: Path) -> None:
    """Fail all required names fast, on the cheap bypass path, with the same message.

    Parameters:
        repo (Path): Disposable repository.

    Returns:
        None: Assertions verify the plan.
    """
    result = classify_change(repo, {"packages/dev-tools/src/index.ts": "x\n"})
    plan = ci_paths.plan_cells(result, PULL_REQUEST, "too long")
    assert set(plan) == merge_pr_checks.EXPECTED_MATRIX
    assert all(cell == ci_paths.CellPlan(False, False, (), "too long", True) for cell in plan.values())


def test_input_registry_drives_classification_and_outputs(
    repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Add one input class with one registry entry, as the benchmark gate will.

    Parameters:
        repo (Path): Disposable repository.
        monkeypatch (pytest.MonkeyPatch): Registry override.

    Returns:
        None: Assertions verify classification and output.
    """
    monkeypatch.setitem(ci_paths.INPUT_CLASSES, "bench_inputs", lambda path: path.startswith("benchmarks/"))
    changed = classify_change(repo, {"benchmarks/comparison/x.py": "x\n"})
    other = classify_change(repo, {"packages/dev-tools/src/index.ts": "x\n"})
    assert changed.inputs["bench_inputs"]
    assert not other.inputs["bench_inputs"]
    output = repo / "output"
    ci_paths.write_github_output(output, changed, ci_paths.plan_cells(changed, PULL_REQUEST))
    assert "bench_inputs=true\n" in output.read_text(encoding="utf-8")


def test_write_github_output_publishes_one_line_plan_json(repo: Path, tmp_path: Path) -> None:
    """Publish the plan as a single JSON line keyed by check name.

    Parameters:
        repo (Path): Disposable repository.
        tmp_path (Path): Pytest temporary directory.

    Returns:
        None: Assertions verify workflow output.
    """
    result = classify_change(repo, {"integration/harness/stack.py": "x\n"})
    output = tmp_path / "out"
    ci_paths.write_github_output(output, result, ci_paths.plan_cells(result, PULL_REQUEST))
    plan = read_plan(output)
    split = {"packages/subagents", "packages/computer-use"}
    rest = " ".join(w for w in ci_paths.npm_workspaces(ci_paths.REPO_ROOT) if w not in split)
    assert plan["owned (macos-14)"] == {
        "run": True,
        "scenarios": True,
        "gates": "check-ts check-scripts check-integration check-benchmark",
        "reason": "",
        "blocked": False,
        "shards": [
            {
                "os": "macos-14",
                "shard": "subagents",
                "runner": "xcode-27",
                "guest": "macos",
                "gates": "check-ts",
                "workspaces": "packages/subagents",
                "skipped_gates": "",
            },
            {
                "os": "macos-14",
                "shard": "computer-use",
                "runner": "xcode-27",
                "guest": "macos",
                "gates": "check-ts",
                "workspaces": "packages/computer-use",
                "skipped_gates": "",
            },
            {
                "os": "macos-14",
                "shard": "ts",
                "runner": "xcode-27",
                "guest": "macos",
                "gates": "check-ts",
                "workspaces": rest,
                "skipped_gates": "",
            },
            {
                "os": "macos-14",
                "shard": "python",
                "runner": "xcode-27",
                "guest": "macos",
                "gates": "check-scripts check-integration check-benchmark",
                "workspaces": "",
                "skipped_gates": "check-benchmark",
            },
        ],
        "guest": "macos",
        "coverage_os": "darwin",
        "skipped_gates": "check-benchmark",
    }
    assert plan["contracts (macos-14)"]["shards"] == []
    assert (plan["contracts (macos-14)"]["guest"], plan["contracts (macos-14)"]["coverage_os"]) == ("", "")
    assert plan["stack (wsl2, local)"]["reason"] == ci_paths.STACK_NOT_RUN["wsl2", "local"]


def read_plan(output: Path) -> dict[str, dict[str, Any]]:
    """Return the plan JSON a run published.

    Parameters:
        output (Path): GitHub output file.

    Returns:
        dict[str, dict[str, Any]]: The plan keyed by check name.
    """
    (line,) = [line for line in output.read_text(encoding="utf-8").splitlines() if line.startswith("plan=")]
    return json.loads(line.removeprefix("plan="))


def run_cli(repo: Path, output: Path, *extra: str) -> int:
    """Run the command-line entry point over the repository's last commit.

    Parameters:
        repo (Path): Disposable repository with at least two commits.
        output (Path): GitHub output file.
        *extra (str): Additional arguments.

    Returns:
        int: Exit status.
    """
    return ci_paths.main(
        ["--repo", str(repo), "--base", "HEAD~1", "--head", "HEAD", "--github-output", str(output), *extra]
    )


def test_cli_plans_a_pull_request_and_a_push(repo: Path, tmp_path: Path) -> None:
    """Write the plan through the real entry point for both events.

    Parameters:
        repo (Path): Disposable repository.
        tmp_path (Path): Pytest temporary directory.

    Returns:
        None: Assertions verify workflow output.
    """
    classify_change(repo, {"integration/harness/stack.py": "x\n"})
    pr, push = tmp_path / "pr", tmp_path / "push"
    assert run_cli(repo, pr, "--event", PULL_REQUEST, "--pr-title", "Fix the thing", "--pr-number", "7") == 0
    assert run_cli(repo, push, "--event", PUSH) == 0
    pr_plan = read_plan(pr)
    push_plan = read_plan(push)
    assert pr_plan["stack (ubuntu-24.04, local)"]["run"]
    assert push_plan["stack (ubuntu-24.04, local)"]["run"] is False
    assert not any(cell["blocked"] for cell in pr_plan.values())


def test_cli_blocks_every_cell_for_a_long_title(repo: Path, tmp_path: Path) -> None:
    """Block a PR whose squash subject would fail on `main`, without failing `classify` itself.

    Parameters:
        repo (Path): Disposable repository.
        tmp_path (Path): Pytest temporary directory.

    Returns:
        None: Assertions verify workflow output.
    """
    classify_change(repo, {"integration/harness/stack.py": "x\n"})
    output = tmp_path / "out"
    assert run_cli(repo, output, "--event", PULL_REQUEST, "--pr-title", "A" * 70, "--pr-number", "305") == 0
    plan = read_plan(output)
    assert all(cell["blocked"] and "squash subject" in cell["reason"] for cell in plan.values())


def test_cli_blocks_every_cell_when_a_pull_request_has_no_title(repo: Path, tmp_path: Path) -> None:
    """Block, never skip, a pull_request plan that cannot check the squash subject.

    Parameters:
        repo (Path): Disposable repository.
        tmp_path (Path): Pytest temporary directory.

    Returns:
        None: Assertions verify the plan.
    """
    classify_change(repo, {"a.txt": "x\n"})
    output = tmp_path / "out"
    assert run_cli(repo, output, "--event", PULL_REQUEST) == 0
    plan = read_plan(output)
    assert set(plan) == merge_pr_checks.EXPECTED_MATRIX
    assert all(cell["blocked"] and "--pr-title" in cell["reason"] for cell in plan.values())


LINT = ci_paths.REPO_ROOT / "packages/computer-use/scripts/check-commit-messages.mjs"
SUBJECT_CASES = [
    ("Fix the thing", True),
    ("rtl: Preserve the root target", True),
    ("A" * 72, True),
    ("A" * 73, False),
    ("lowercase subject", False),
    ("fix(browser): stabilize targeting", False),
    ("Trailing period.", False),
    # 70 emoji-free chars plus one astral character: 71 code points, 72 UTF-16 units.
    ("A" * 70 + "\U0001f608", True),
    # Trailing characters JavaScript's `\s` treats differently from Python's.
    ("Trailing unit separator\x1f", True),
    ("Trailing file separator\x1c", True),
    ("Trailing next line\x85", True),
    ("Trailing no-break space\u00a0", False),
    ("Trailing line separator\u2028", False),
    ("Trailing byte order mark\ufeff", False),
    # 71 code points but 73 UTF-16 units: Python's len() would accept it, JS `.length` does not.
    ("A" * 71 + "\U0001f608", False),
]


@pytest.mark.parametrize(("subject", "valid"), SUBJECT_CASES)
def test_subject_rule_mirrors_the_commit_lint_for_each_rule(subject: str, valid: bool) -> None:
    """Pin each rule of `validSubject`: capitalization, trailing period, and UTF-16 length.

    Parameters:
        subject (str): Commit subject.
        valid (bool): Whether the lint accepts it.
    """
    assert ci_paths.is_valid_subject(subject) is valid


def test_utf16_length_counts_astral_characters_twice() -> None:
    """Match JavaScript `String.length` for an emoji."""
    assert ci_paths.utf16_length("a\U0001f608") == 3
    assert len("a\U0001f608") == 2


@pytest.mark.parametrize(("subject", "valid"), SUBJECT_CASES)
def test_subject_rule_agrees_with_the_real_lint(repo: Path, subject: str, valid: bool) -> None:
    """Run `check-commit-messages.mjs` itself over each subject, so the mirror cannot drift from it.

    Parameters:
        repo (Path): Disposable repository.
        subject (str): Commit subject.
        valid (bool): Whether the Python rule accepts it.
    """
    node = shutil.which("node")
    assert node, "node is required to run the real commit lint"
    # `--cleanup=verbatim` keeps trailing whitespace. The lint `.trim()`s the whole log, so the case sits
    # between two valid commits: neither end of the output is its own last character.
    git(repo, "commit", "-q", "--allow-empty", "-m", "Fix the thing")
    git(repo, "commit", "-q", "--allow-empty", "--cleanup=verbatim", "-m", subject)
    git(repo, "commit", "-q", "--allow-empty", "-m", "Fix the thing")
    result = subprocess.run(
        [node, str(LINT), "HEAD~3..HEAD"], cwd=repo, capture_output=True, text=True, check=False
    )
    assert (result.returncode == 0) is ci_paths.is_valid_subject(subject) is valid, result.stderr


@pytest.mark.parametrize(
    ("title", "fragment"),
    [
        ("lowercase title", "capital letter"),
        ("A" * 70, "UTF-16 units"),
        ("A" * 64 + "\U0001f608", "UTF-16 units"),
    ],
)
def test_squash_subject_problem_names_the_broken_rule(title: str, fragment: str) -> None:
    """Fail the squash subject `<title> (#N)` with a message that names what to fix.

    Parameters:
        title (str): Pull request title.
        fragment (str): Expected message fragment.
    """
    assert fragment in ci_paths.squash_subject_problem(title, 305)
    assert ci_paths.squash_subject_problem("Fix the thing", 305) == ""


def test_run_git_reports_a_missing_git_binary(repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Fail closed with a labelled error when Git cannot start.

    Parameters:
        repo (Path): Disposable repository.
        monkeypatch (pytest.MonkeyPatch): Missing Git override.

    Returns:
        None: Assertions verify the error and the failed-closed classification.
    """
    monkeypatch.setattr(ci_paths, "GIT", str(repo / "no-such-git"))
    with pytest.raises(ci_paths.ClassificationError, match="Cannot run `git`"):
        ci_paths.run_git(repo, "status")
    assert ci_paths.classify(repo, "HEAD", "HEAD").inputs == dict.fromkeys(ci_paths.INPUT_CLASSES, True)


@pytest.mark.parametrize(
    ("raw", "message"),
    [
        (":100644 100644 a b M\0a.txt", "unterminated record"),
        (":100644 100644 a b M\0", "incomplete record"),
        ("garbage\0a.txt\0", "malformed metadata"),
        ("100644 100644 a b M\0a.txt\0", "malformed metadata"),
    ],
)
def test_changed_paths_rejects_records_git_never_emits(
    repo: Path, monkeypatch: pytest.MonkeyPatch, raw: str, message: str
) -> None:
    """Refuse a malformed `git diff --raw -z` record instead of guessing paths.

    Parameters:
        repo (Path): Disposable repository.
        monkeypatch (pytest.MonkeyPatch): Canned Git output.
        raw (str): Output to feed the parser.
        message (str): Expected error fragment.

    Returns:
        None: Assertions verify the error.
    """
    real = ci_paths.run_git
    monkeypatch.setattr(
        ci_paths, "run_git", lambda root, *args: raw if args[0] == "diff" else real(root, *args)
    )
    with pytest.raises(ci_paths.ClassificationError, match=message):
        ci_paths.changed_paths(repo, "HEAD", "HEAD")


def test_script_entry_point_writes_the_plan(
    repo: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Run the file as the workflow does and exit with its status.

    Parameters:
        repo (Path): Disposable repository.
        tmp_path (Path): Pytest temporary directory.
        monkeypatch (pytest.MonkeyPatch): Argument override.

    Returns:
        None: Assertions verify exit status and output.
    """
    classify_change(repo, {"a.txt": "x\n"})
    output = tmp_path / "out"
    argv = ["ci_paths.py", "--repo", str(repo), "--base", "HEAD~1", "--head", "HEAD"]
    monkeypatch.setattr(sys, "argv", [*argv, "--event", PUSH, "--github-output", str(output)])
    with pytest.raises(SystemExit) as raised:
        runpy.run_path(ci_paths.__file__, run_name="__main__")
    assert raised.value.code == 0
    assert set(read_plan(output)) == merge_pr_checks.EXPECTED_MATRIX


def test_cli_full_plans_every_cell_to_run_without_reading_a_diff(tmp_path: Path) -> None:
    """Plan a frozen release candidate: no base or head, every input true, only permanent bypass cells skip.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
    """
    output = tmp_path / "out"
    assert ci_paths.main(["--full", "--event", "workflow_dispatch", "--github-output", str(output)]) == 0
    lines = output.read_text(encoding="utf-8").splitlines()
    for flag in ("docs_only=false", "wsl_inputs=true", "stack_inputs=true", "benchmark_inputs=true"):
        assert flag in lines
    assert ci_paths.FULL_RELEASE_CANDIDATE in lines
    plan = read_plan(output)
    assert {name for name, cell in plan.items() if not cell["run"]} == {
        "stack (macos-14, personal)",
        "stack (wsl2, personal)",
        "stack (wsl2, local)",
    }
    assert plan["owned (wsl2)"]["gates"] == " ".join(WSL_GATES)
    assert plan["stack (ubuntu-24.04, local)"]["scenarios"]


def test_cli_requires_a_revision_range_unless_full(capsys: pytest.CaptureFixture[str]) -> None:
    """Refuse to plan from nothing: a missing range is an error, not an empty diff.

    Parameters:
        capsys (pytest.CaptureFixture[str]): Captured usage error.
    """
    with pytest.raises(SystemExit) as raised:
        ci_paths.parse_args(["--event", "push", "--github-output", "out"])
    assert raised.value.code == 2
    assert "--base and --head are required unless --full" in capsys.readouterr().err


def test_main_publishes_every_flag_for_a_benchmark_diff(repo: Path, tmp_path: Path) -> None:
    """Drive the real command line over a `benchmarks/comparison/uv.lock` diff and read the output file.

    Parameters:
        repo (Path): Disposable repository.
        tmp_path (Path): Pytest temporary directory.
    """
    base = git(repo, "rev-parse", "HEAD")
    classify_change(repo, {"benchmarks/comparison/uv.lock": "lock\n"})
    output = tmp_path / "github-output"
    argv = ["--repo", str(repo), "--base", base, "--head", "HEAD", "--github-output", str(output)]
    assert ci_paths.main([*argv, "--event", PUSH]) == 0
    lines = output.read_text(encoding="utf-8").splitlines()
    assert "benchmark_inputs=true" in lines
    assert "docs_only=false" in lines
    assert "benchmarks/comparison/uv.lock" in lines
    assert "wsl_inputs=false" in lines


WORKSPACES = ci_paths.npm_workspaces(ci_paths.REPO_ROOT)
SHARD_NAMES = {
    "ubuntu-24.04": ("subagents", "computer-use", "ts", "python"),
    "macos-14": ("subagents", "computer-use", "ts", "python"),
    "wsl2": ("subagents-computer-use", "ts"),
}


def shard_outputs(plan: ci_paths.CellPlan) -> list[dict[str, str]]:
    """Return a cell's shards as the workflow's matrix `include` reads them.

    Parameters:
        plan (ci_paths.CellPlan): One `owned` cell.

    Returns:
        list[dict[str, str]]: The published shard entries.
    """
    return [shard.to_output() for shard in plan.shards]


@pytest.mark.parametrize("os_name", list(SHARD_NAMES))
def test_owned_shards_run_every_workspace_exactly_once_in_npm_order(repo: Path, os_name: str) -> None:
    """Split `check-ts` across a cell's shards without dropping, repeating or reordering a workspace.

    Parameters:
        repo (Path): Disposable repository.
        os_name (str): Matrix `os` value.
    """
    plan = plan_change(repo, {".github/workflows/ci.yml": "x\n"}, PUSH)[f"owned ({os_name})"]
    entries = shard_outputs(plan)
    assert tuple(entry["shard"] for entry in entries) == SHARD_NAMES[os_name]
    selected = [entry["workspaces"].split() for entry in entries if "check-ts" in entry["gates"].split()]
    flat = [workspace for workspaces in selected for workspace in workspaces]
    assert sorted(flat) == sorted(WORKSPACES)
    for workspaces in selected:
        assert workspaces == [workspace for workspace in WORKSPACES if workspace in workspaces]
    assert all(entry["workspaces"] == "" for entry in entries if "check-ts" not in entry["gates"].split())


def test_owned_shards_follow_the_issue_split_and_runner_budget(repo: Path) -> None:
    """Pin the shard split: four Ubuntu shards, four macOS shards, two WSL shards.

    Parameters:
        repo (Path): Disposable repository.
    """
    plan = plan_change(repo, {".github/workflows/ci.yml": "x\n"}, PUSH)
    ubuntu = {entry["shard"]: entry for entry in shard_outputs(plan["owned (ubuntu-24.04)"])}
    assert ubuntu["subagents"]["workspaces"] == "packages/subagents"
    assert ubuntu["computer-use"]["workspaces"] == "packages/computer-use"
    assert ubuntu["python"]["gates"] == "check-scripts check-integration"
    assert ubuntu["ts"]["workspaces"].split() == [
        workspace
        for workspace in WORKSPACES
        if workspace not in {"packages/subagents", "packages/computer-use"}
    ]
    mac = {entry["shard"]: entry for entry in shard_outputs(plan["owned (macos-14)"])}
    assert mac["subagents"]["workspaces"] == "packages/subagents"
    assert mac["computer-use"]["workspaces"] == "packages/computer-use"
    assert mac["ts"]["workspaces"].split() == [
        workspace
        for workspace in WORKSPACES
        if workspace not in {"packages/subagents", "packages/computer-use"}
    ]
    assert mac["python"]["gates"] == "check-scripts check-integration check-benchmark"
    wsl = {entry["shard"]: entry for entry in shard_outputs(plan["owned (wsl2)"])}
    assert wsl["subagents-computer-use"]["workspaces"] == "packages/computer-use packages/subagents"
    assert wsl["ts"]["gates"] == "check-ts check-probes check-providers check-import-audit"
    for os_name, entries in (("ubuntu-24.04", ubuntu), ("macos-14", mac), ("wsl2", wsl)):
        runner, guest = ci_paths.RUNNERS[os_name]
        assert all(entry["os"] == os_name for entry in entries.values())
        assert all((entry["runner"], entry["guest"]) == (runner, guest) for entry in entries.values())


@pytest.mark.parametrize("os_name", list(SHARD_NAMES))
def test_cell_gates_are_its_shards_gates_in_order(repo: Path, os_name: str) -> None:
    """Keep the cell's `gates` the ordered union of its shards' gates, so the fan-in and the shards agree.

    Parameters:
        repo (Path): Disposable repository.
        os_name (str): Matrix `os` value.
    """
    plan = plan_change(repo, {".github/workflows/ci.yml": "x\n"}, PUSH)[f"owned ({os_name})"]
    union = [gate for entry in shard_outputs(plan) for gate in entry["gates"].split()]
    assert plan.gates == tuple(dict.fromkeys(union))
    assert plan.gates == ci_paths.OWNED_GATES[os_name]


@pytest.mark.parametrize(
    ("os_name", "coverage_os"), [("ubuntu-24.04", "linux"), ("macos-14", "darwin"), ("wsl2", "linux")]
)
def test_owned_cells_publish_the_fan_ins_accounting_platform(
    repo: Path, monkeypatch: pytest.MonkeyPatch, os_name: str, coverage_os: str
) -> None:
    """Publish the `--os` and `--host` the Ubuntu fan-in accounts a cell with, from the plan alone.

    Parameters:
        repo (Path): Disposable repository.
        monkeypatch (pytest.MonkeyPatch): Sets `sys.argv` for the real accounting parser.
        os_name (str): Matrix `os` value.
        coverage_os (str): Platform whose floors that cell's reports are held to.
    """
    plan = plan_change(repo, {".github/workflows/ci.yml": "x\n"}, PUSH)[f"owned ({os_name})"]
    assert plan.coverage_os == coverage_os
    # One guest per cell: every shard ran there, so the cell's host class is theirs.
    assert {shard.guest for shard in plan.shards} == {plan.guest} == {ci_paths.RUNNERS[os_name][1]}
    argv = ["coverage_accounting.py", "--base", "x", "--os", plan.coverage_os, "--host", plan.guest]
    monkeypatch.setattr(sys, "argv", argv)
    args = coverage_accounting.parse_args()
    assert (args.os, args.host) == (coverage_os, plan.guest)


def test_gate_names_never_contain_one_another() -> None:
    """Keep `contains(<space-joined gates>, '<gate>')` in the workflow an exact membership test."""
    names = {gate for gates in ci_paths.OWNED_GATES.values() for gate in gates}
    assert not any(a != b and a in b for a in names for b in names)


def test_cells_that_do_not_run_plan_no_shards(repo: Path) -> None:
    """Plan no shard job for a bypass, contracts, stack or blocked cell.

    Parameters:
        repo (Path): Disposable repository.
    """
    docs = plan_change(repo, {"docs/ci.md": "x\n"}, PULL_REQUEST)
    assert docs["owned (ubuntu-24.04)"].shards == ()
    assert docs["owned (wsl2)"].shards == ()
    code = plan_change(repo, {"packages/dev-tools/src/index.ts": "x\n"}, PULL_REQUEST)
    assert code["owned (wsl2)"].shards == ()
    assert code["contracts (ubuntu-24.04)"].shards == ()
    assert code["stack (ubuntu-24.04, local)"].shards == ()
    assert code["owned (macos-14)"].shards
    assert all((cell.guest, cell.coverage_os) == ("", "") for cell in (*docs.values(), code["owned (wsl2)"]))
    blocked = ci_paths.plan_cells(classify_change(repo, {"b.txt": "x\n"}), PULL_REQUEST, "too long")
    assert all(cell.shards == () for cell in blocked.values())


def write_workspace(root: Path, relative: str) -> None:
    """Create one npm workspace directory with a manifest.

    Parameters:
        root (Path): Fixture repository root.
        relative (str): Workspace path.
    """
    (root / relative).mkdir(parents=True)
    (root / relative / "package.json").write_text("{}\n", encoding="utf-8")


def test_npm_workspaces_follow_the_manifest_patterns_in_order(tmp_path: Path) -> None:
    """Expand each `workspaces` pattern in turn, sorted within it, skipping directories without a manifest.

    Parameters:
        tmp_path (Path): Fixture repository root.
    """
    (tmp_path / "package.json").write_text(
        json.dumps({"workspaces": ["packages/*", "integration/inprocess"]}), encoding="utf-8"
    )
    for relative in ("packages/zeta", "packages/alpha", "integration/inprocess"):
        write_workspace(tmp_path, relative)
    (tmp_path / "packages/no-manifest").mkdir()
    assert ci_paths.npm_workspaces(tmp_path) == ("packages/alpha", "packages/zeta", "integration/inprocess")


@pytest.mark.parametrize(
    ("manifest", "message"),
    [
        (None, "Cannot read npm workspaces"),
        ("{", "Cannot read npm workspaces"),
        ("{}", "declares no workspaces"),
    ],
)
def test_npm_workspaces_fail_closed(tmp_path: Path, manifest: str | None, message: str) -> None:
    """Refuse to plan shards from a missing, malformed or workspace-free root manifest.

    Parameters:
        tmp_path (Path): Fixture repository root.
        manifest (str | None): Root `package.json` text, or None for no file.
        message (str): Expected error fragment.
    """
    if manifest is not None:
        (tmp_path / "package.json").write_text(manifest, encoding="utf-8")
    with pytest.raises(ci_paths.ClassificationError, match=message):
        ci_paths.npm_workspaces(tmp_path)


@pytest.mark.parametrize(
    ("shards", "message"),
    [
        ((ci_paths.Shard("x", ("check-ts",), ("packages/missing",)),), "names unknown workspaces"),
        (
            (ci_paths.Shard("all", ("check-ts",), ("packages/a",)), ci_paths.Shard("rest", ("check-ts",))),
            "no workspaces",
        ),
    ],
)
def test_shard_plans_refuse_a_broken_split(
    monkeypatch: pytest.MonkeyPatch, shards: tuple[ci_paths.Shard, ...], message: str
) -> None:
    """Refuse a shard naming a workspace that does not exist, or a `check-ts` shard left with nothing.

    `make check-ts WORKSPACES=` with an empty list would run every workspace, so it never reaches CI.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): Shard table override.
        shards (tuple[ci_paths.Shard, ...]): A broken split for `ubuntu-24.04`.
        message (str): Expected error fragment.
    """
    monkeypatch.setitem(ci_paths.OWNED_SHARDS, "ubuntu-24.04", shards)
    with pytest.raises(ci_paths.ClassificationError, match=message):
        ci_paths.shard_plans("ubuntu-24.04", ("packages/a",))


def test_main_fails_when_the_shard_plan_cannot_be_built(
    repo: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Fail `classify`, which turns every required check red, rather than publish a plan without shards.

    Parameters:
        repo (Path): Disposable repository.
        tmp_path (Path): Pytest temporary directory.
        monkeypatch (pytest.MonkeyPatch): Repository root override.
        caplog (pytest.LogCaptureFixture): Logged error.
    """
    classify_change(repo, {"a.txt": "x\n"})
    monkeypatch.setattr(ci_paths, "REPO_ROOT", tmp_path / "no-checkout")
    output = tmp_path / "out"
    output.write_text("", encoding="utf-8")
    assert run_cli(repo, output, "--event", PUSH) == 1
    assert "Cannot read npm workspaces" in caplog.text
    assert output.read_text(encoding="utf-8") == ""


@pytest.mark.parametrize(
    ("files", "event", "skips"),
    [
        ({"integration/harness/stack.py": "x\n"}, PULL_REQUEST, True),
        ({"benchmarks/comparison/tests/test_cli.py": "x\n"}, PULL_REQUEST, False),
        ({"integration/harness/stack.py": "x\n"}, PUSH, False),
    ],
)
def test_plan_skips_the_benchmark_gate_only_on_a_pull_request_without_its_inputs(
    repo: Path, files: dict[str, str], event: str, skips: bool
) -> None:
    """Publish one skip decision that the macOS shard steps and the fan-in accounting both read.

    Parameters:
        repo (Path): Disposable repository.
        files (dict[str, str]): Committed change.
        event (str): Triggering event name.
        skips (bool): Whether `check-benchmark` reports NOT RUN on this run.
    """
    plan = plan_change(repo, files, event)
    expected = ("check-benchmark",) if skips else ()
    mac = plan["owned (macos-14)"]
    assert mac.gates == MAC_GATES
    assert mac.skipped_gates == expected
    assert {shard.name: shard.skipped_gates for shard in mac.shards} == {
        "subagents": (),
        "computer-use": (),
        "ts": (),
        "python": expected,
    }
    # A cell never skips a gate it does not plan: Ubuntu and WSL have no benchmark producer at all.
    for os_name in ("ubuntu-24.04", "wsl2"):
        cell = plan[f"owned ({os_name})"]
        assert cell.skipped_gates == ()
        assert all(shard.skipped_gates == () for shard in cell.shards)


def test_full_verification_runs_every_path_gated_gate() -> None:
    """Skip nothing on a `workflow_dispatch` release verification, which has no diff to read."""
    plan = ci_paths.plan_cells(ci_paths.full_classification(), "workflow_dispatch")
    assert all(cell.skipped_gates == () for cell in plan.values())
    assert set(ci_paths.PATH_GATED_GATES.values()) <= set(ci_paths.INPUT_CLASSES)
    # Accounting rejects a skipped gate no policy signal declares, so every path-gated gate needs its signal.
    policy = json.loads((ci_paths.REPO_ROOT / "coverage/policy.json").read_text())
    declared = {
        signal.get("gate")
        for package in policy["packages"].values()
        for signal in package["signals"].values()
    }
    assert set(ci_paths.PATH_GATED_GATES) <= declared
