"""Pin the real repository's policy, source classification and documented contracts.

References:
    ../../docs/coverage.md
"""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from coverage_fixtures import (
    JS_SUFFIXES,
    ROOT,
    SCRIPT,
)

from coverage_accounting import (
    Counts,
    EnforcementChange,
    Exclusion,
    Package,
    Policy,
    Reclassification,
    Signal,
    VerificationHelper,
    account,
    audit_inventory,
    inventory,
    inventory_scopes,
    is_test_path,
    repository_files,
)


def test_serialized_policy_fields_have_descriptions() -> None:
    """Check every serialized field, including inherited and newly added declarations.

    Parameters:
        None.
    Returns:
        None: All serialized fields carry substantive descriptions.
    Raises:
        AssertionError: A policy field lacks its documented contract.
    """
    for model in [
        Counts,
        EnforcementChange,
        Exclusion,
        Signal,
        Package,
        Policy,
        Reclassification,
        VerificationHelper,
    ]:
        for name, field in model.model_fields.items():
            assert field.description, f"{model.__name__}.{name}"
            assert field.description.strip(), f"{model.__name__}.{name}"


def test_accounting_function_contracts_are_typed_and_sectioned() -> None:
    """Keep callable documentation in the required typed contract form.

    Parameters:
        None.
    Returns:
        None: Every source function has Parameters, Returns and Raises sections.
    Raises:
        AssertionError: A function contract is incomplete.
    """
    tests = Path(__file__).parent
    paths = [SCRIPT, tests / "coverage_fixtures.py", *tests.glob("test_coverage_*.py")]
    for path in paths:
        assert_documented_functions(path)


def assert_documented_functions(path: Path) -> None:
    """Validate every function's typed documentation without importing the module.

    Parameters:
        path (Path): Coverage implementation or regression test module.
    Returns:
        None: All declared callables satisfy the contract-documentation requirements.
    Raises:
        AssertionError: A function lacks a required section, parameter type or return annotation.
    """
    tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
        if not isinstance(node, ast.FunctionDef):
            continue
        doc = ast.get_docstring(node)
        assert doc, node.name
        for section in ["Parameters:", "Returns:", "Raises:"]:
            assert section in doc, f"{node.name}: {section}"
        for arg in node.args.args:
            if arg.arg != "self":
                assert f"{arg.arg} (" in doc, f"{node.name}: {arg.arg}"
        assert node.returns is not None, node.name


def test_repository_owned_source_inventory_is_complete() -> None:
    """Scan the actual repository, including untracked nonignored TS and Python files.

    Parameters:
        None.
    Returns:
        None: Every executable candidate is measured, pending or explicitly excluded with a reason.
    Raises:
        AssertionError: Source exists outside reviewed coverage accounting.
    """
    cfg = Policy.model_validate_json((ROOT / "coverage/policy.json").read_text())
    assert not audit_inventory(ROOT, cfg, repository_files(ROOT))


@pytest.mark.parametrize(
    "file",
    [
        "scripts/coverage_accounting.py",
        "integration/harness/paths.py",
        "integration/probes/anthropic-block-types.mjs",
        "integration/probes/latency.ts",
        "integration/probes/render.ts",
        "integration/probes/session-kit-child-scope.ts",
        "integration/probes/stack-resources.ts",
    ],
)
def test_reviewed_missing_source_is_explicitly_accounted(file: str) -> None:
    """Keep the review's identified executable source visible without inventing baselines.

    Parameters:
        file (str): Previously unaccounted executable repository path.
    Returns:
        None: A package owns the source: measured by a real producer.
    Raises:
        AssertionError: The source is omitted or treated as measured without a producer.
    """
    cfg = Policy.model_validate_json((ROOT / "coverage/policy.json").read_text())
    owners = [
        package
        for package in cfg.packages.values()
        if Path(file).is_relative_to(package.root)
        and Path(file).relative_to(package.root).as_posix() in inventory(ROOT, package)
    ]
    assert owners, file
    # Python has a pytest-cov LCOV producer and, since #377, every probe runs in process under
    # `check-probes`: each is measured and enforced at 0/0 like every owned package.
    assert all(
        package.status == "measured"
        and package.goal == "100-percent"
        and package.signals["primary"].enforcement == "enforced"
        for package in owners
    )


def test_providers_are_measured_in_the_goal_at_zero() -> None:
    """Hold the synthetic providers and auth preloads to the enforced 0/0 goal (#378).

    Parameters:
        None.
    Returns:
        None: Every provider source is owned by one enforced primary signal with zero budgets.
    Raises:
        AssertionError: A provider leaves the inventory, the goal or the zero budget.
    """
    cfg = Policy.model_validate_json((ROOT / "coverage/policy.json").read_text())
    providers = cfg.packages["providers"]
    sources = {
        path.name
        for path in (ROOT / "integration/providers").iterdir()
        if path.suffix in {".ts", ".mjs"}
        and not path.name.endswith(".test.ts")
        and path.name != "vitest.config.ts"
    }
    assert inventory(ROOT, providers) == sources
    assert providers.status == "measured"
    assert providers.goal == "100-percent"
    primary = providers.signals["primary"]
    assert primary.enforcement == "enforced"
    assert {os: (budget.lines, budget.functions) for os, budget in primary.max_uncovered.items()} == {
        "darwin": (0, 0),
        "linux": (0, 0),
    }
    helpers = {helper.path for helper in cfg.verification_helpers}
    assert not any(path.startswith("integration/providers/") for path in helpers)


def test_root_script_helpers_are_measured_by_import_audit_at_zero() -> None:
    """Hold the root `scripts/` Node helpers to the enforced import-audit 0/0 goal (#379).

    Parameters:
        None.
    Returns:
        None: The launcher, path preflight and router fixture are owned, measured and not helpers.
    Raises:
        AssertionError: A root script falls back to a verification-helper row or leaves the goal.
    """
    cfg = Policy.model_validate_json((ROOT / "coverage/policy.json").read_text())
    audit = cfg.packages["import-audit"]
    configs = {
        path.relative_to(ROOT).as_posix()
        for pattern in [
            "packages/*/vitest*.config.ts",
            "packages/todo/.vitest.config.ts",
            "integration/*/vitest.config.ts",
            "scripts/vitest.config.ts",
            "tests/lib/vitest.config.ts",
        ]
        for path in ROOT.glob(pattern)
    }
    assert inventory(ROOT, audit) == {
        "scripts/check-biome-paths.mjs",
        "scripts/import_audit.ts",
        "scripts/merge-pr.ts",
        "scripts/router_contract.mjs",
        "scripts/run-vitest.ts",
        *configs,
    }
    assert len(configs) == 18, configs
    assert "coverage-configurations" not in cfg.packages
    assert audit.goal == "100-percent"
    primary = audit.signals["primary"]
    assert primary.enforcement == "enforced"
    assert {os: (budget.lines, budget.functions) for os, budget in primary.max_uncovered.items()} == {
        "darwin": (0, 0),
        "linux": (0, 0),
    }
    helpers = {helper.path for helper in cfg.verification_helpers}
    assert {"scripts/check-biome-paths.test.mjs", "scripts/router_contract.test.mjs"} == {
        path for path in helpers if path.startswith("scripts/") and "/" not in path.removeprefix("scripts/")
    }


def published_path(relative: Path, patterns: list[str]) -> bool:
    """Match this package's explicit files entries, including recursively included directories.

    Parameters:
        relative (Path): Package-relative source file.
        patterns (list[str]): Actual npm files entries from the computer-use manifest.
    Returns:
        bool: Whether the manifest explicitly distributes this source path.
    Raises:
        None.
    """
    return any(
        not pattern.startswith("!") and (relative.full_match(pattern) or relative.is_relative_to(pattern))
        for pattern in patterns
    )


def test_shipped_computer_javascript_is_pending_production_not_verification() -> None:
    """Tie shipped JavaScript classification to the real npm publication manifest.

    Parameters:
        None.
    Returns:
        None: Every shipped JS source file is owned pending production source, never a helper.
    Raises:
        AssertionError: Shipped setup, build or runtime source is misclassified.
    """
    cfg = Policy.model_validate_json((ROOT / "coverage/policy.json").read_text())
    package = cfg.packages["computer-use"]
    directory = ROOT / package.root
    manifest = json.loads((directory / "package.json").read_text())
    owned = inventory(ROOT, package)
    helpers = {helper.path for helper in cfg.verification_helpers}
    shipped = {
        Path(path).relative_to(package.root).as_posix()
        for path in repository_files(ROOT)
        if Path(path).is_relative_to(package.root)
        and Path(path).suffix in JS_SUFFIXES
        and published_path(Path(path).relative_to(package.root), manifest["files"])
    }
    assert "scripts/setup-helper.mjs" in shipped
    assert "scripts/build-native.mjs" in shipped
    assert "src/platform/macos/helper-path.mjs" in shipped
    assert package.status == "pending"
    assert package.goal == "excluded"
    assert "Owner explicitly excludes computer-use" in package.goal_reason
    assert shipped.issubset(owned)
    assert not {(Path(package.root) / path).as_posix() for path in shipped} & helpers


def test_async_helper_is_independently_measured_at_zero() -> None:
    """Keep the full async helper measured separately from the runtime inventory.

    Parameters:
        None.
    Returns:
        None: The exact source, mandatory report and per-OS zero caps stay pinned.
    Raises:
        AssertionError: The helper disappears, rejoins verification exclusions or loses enforcement.
    """
    cfg = Policy.model_validate_json((ROOT / "coverage/policy.json").read_text())
    package = cfg.packages["computer-use-async"]
    assert package.status == "measured"
    assert package.goal == "report-only"
    assert package.root == "packages/computer-use"
    assert package.owned == ["scripts/check-async.mjs"]
    assert not package.exclusions
    assert "scripts/check-async.mjs" not in inventory(ROOT, cfg.packages["computer-use-vitest"])
    assert not any(helper.path.endswith("/check-async.mjs") for helper in cfg.verification_helpers)
    signal = package.signals["primary"]
    assert signal.report == "coverage/async/lcov.info"
    assert signal.enforcement == "report-only"
    assert signal.reason.strip()
    assert not signal.skip_hosts
    assert not signal.gate
    assert set(signal.max_uncovered) == {"darwin", "linux"}
    for counts in signal.max_uncovered.values():
        assert counts.lines == counts.functions == counts.branches == 0
    manifest = json.loads((ROOT / package.root / "package.json").read_text())
    assert "npm run test:async" in manifest["scripts"]["check"]
    assert "--config vitest.async.config.ts --coverage" in manifest["scripts"]["test:async"]


@pytest.mark.parametrize(("runner_os", "host"), [("darwin", "macos"), ("linux", "ubuntu"), ("linux", "wsl2")])
def test_async_helper_missing_host_report_fails(tmp_path: Path, runner_os: str, host: str) -> None:
    """Reject missing selected-host artifacts instead of reporting a false zero.

    Parameters:
        tmp_path (Path): Empty report-artifact directory.
        runner_os (str): Declared measurement platform.
        host (str): Selected CI guest class.
    Returns:
        None: Every declared host fails accounting without its async report.
    Raises:
        AssertionError: Missing coverage is silently skipped or represented by zero counters.
    """
    cfg = Policy.model_validate_json((ROOT / "coverage/policy.json").read_text())
    cfg.packages = {"computer-use-async": cfg.packages["computer-use-async"]}
    results, errors = account(ROOT, cfg, runner_os, tmp_path, host=host)
    assert results == []
    assert len(errors) == 1
    assert errors[0].startswith("computer-use-async/primary:")
    assert "coverage/async/lcov.info" in errors[0]


def test_subagents_runtime_scripts_are_measured_at_zero() -> None:
    """Keep the complete runtime script measured by a mandatory zero-floor producer.

    Parameters:
        None.
    Returns:
        None: Actual sources, CI command and per-OS counters remain pinned.
    Raises:
        AssertionError: A script becomes an unmeasured helper or loses its producer.
    """
    cfg = Policy.model_validate_json((ROOT / "coverage/policy.json").read_text())
    package = cfg.packages["subagents-runtime-tooling"]
    assert package.status == "measured"
    assert package.goal == "100-percent"
    assert package.root == "packages/subagents"
    assert package.owned == ["scripts/build-runtime.mjs"]
    assert not package.exclusions
    assert not any(
        helper.path.startswith("packages/subagents/scripts/") for helper in cfg.verification_helpers
    )
    signal = package.signals["primary"]
    assert signal.report == "coverage/runtime-build-tooling/lcov.info"
    assert signal.enforcement == "enforced"
    assert signal.reporters == ["text", "lcov", "json-summary"]
    assert not signal.skip_hosts
    assert not signal.skip_os
    assert not signal.gate
    assert set(signal.max_uncovered) == {"darwin", "linux"}
    for counts in signal.max_uncovered.values():
        assert counts.lines == counts.functions == counts.branches == counts.statements == 0
    manifest = json.loads((ROOT / package.root / "package.json").read_text())
    assert "npm run test:runtime-scripts" in manifest["scripts"]["check"]
    assert manifest["scripts"]["test:runtime-scripts"] == (
        "node ../../scripts/run-vitest.ts node --config vitest.runtime-build.config.ts --coverage"
    )


@pytest.mark.parametrize(("runner_os", "host"), [("darwin", "macos"), ("linux", "ubuntu"), ("linux", "wsl2")])
def test_subagents_runtime_scripts_missing_host_report_fails(
    tmp_path: Path, runner_os: str, host: str
) -> None:
    """Reject absent runtime-script producer data on every selected host.

    Parameters:
        tmp_path (Path): Empty artifact root, not the real producer directory.
        runner_os (str): Declared measurement platform.
        host (str): Selected CI guest class.
    Returns:
        None: No missing report can be represented by zero counters.
    Raises:
        AssertionError: Missing producer data silently passes accounting.
    """
    cfg = Policy.model_validate_json((ROOT / "coverage/policy.json").read_text())
    cfg.packages = {"subagents-runtime-tooling": cfg.packages["subagents-runtime-tooling"]}
    results, errors = account(ROOT, cfg, runner_os, tmp_path, host=host)
    assert results == []
    assert len(errors) == 1
    assert errors[0].startswith("subagents-runtime-tooling/primary:")
    assert "coverage/runtime-build-tooling/lcov.info" in errors[0]


def test_unshipped_computer_checks_have_individual_verification_reasons() -> None:
    """Require concrete classifications for every non-shipped computer-use check harness.

    Parameters:
        None.
    Returns:
        None: All current check scripts have per-file verification reasons.
    Raises:
        AssertionError: A verification script is omitted or represented by a blanket rule.
    """
    cfg = Policy.model_validate_json((ROOT / "coverage/policy.json").read_text())
    directory = ROOT / "packages/computer-use"
    manifest = json.loads((directory / "package.json").read_text())
    helpers = {helper.path: helper.reason for helper in cfg.verification_helpers}
    measured = {
        (Path(cfg.packages["computer-use-async"].root) / path).as_posix()
        for package in ["computer-use-async", "computer-use-vitest"]
        for path in inventory(ROOT, cfg.packages[package])
    }
    unclassified = [
        relative
        for path in directory.glob("scripts/check-*.mjs")
        if not published_path(path.relative_to(directory), manifest["files"])
        and not helpers.get(relative := path.relative_to(ROOT).as_posix(), "").strip()
        and relative not in measured
    ]
    assert not unclassified, unclassified


@pytest.mark.parametrize(
    "path",
    [
        "packages/computer-use/scripts/pi-cubench-agent.mjs",
        "packages/computer-use/scripts/check-linux-live.mjs",
    ],
)
def test_reviewed_javascript_harnesses_are_explicitly_classified(path: str) -> None:
    """Keep the independently reported omissions explicitly classified by exact filename.

    Parameters:
        path (str): Previously omitted JavaScript verification harness.
    Returns:
        None: An exact per-file helper declaration explains its non-production role.
    Raises:
        AssertionError: A known omission disappears from explicit classification.
    """
    cfg = Policy.model_validate_json((ROOT / "coverage/policy.json").read_text())
    helpers = {helper.path: helper.reason for helper in cfg.verification_helpers}
    assert helpers.get(path, "").strip(), path


@pytest.mark.parametrize(
    "name",
    [
        "check-commit-messages",
        "check-docs-platform",
        "check-docs",
        "check-package-assets",
        "check-sync-ledger",
        "check-sync-reverts",
        "check-upstream-sync",
    ],
)
def test_retained_computer_use_gates_are_measured(name: str) -> None:
    """Keep executable repository gates in both inventories, not helper exemptions.

    Parameters:
        name (str): Retained gate module measured under computer-use Vitest.
    Returns:
        None: Both inventories contain the gate and no helper exemption remains.
    Raises:
        AssertionError: A gate silently leaves the measured producer.
    """
    cfg = Policy.model_validate_json((ROOT / "coverage/policy.json").read_text())
    source = f"scripts/{name}.mjs"
    for package in ["computer-use", "computer-use-vitest"]:
        assert source in inventory(ROOT, cfg.packages[package])
    assert not any(helper.path == f"packages/computer-use/{source}" for helper in cfg.verification_helpers)


def test_pytest_conftest_is_a_conventional_test_file_without_an_exclusion() -> None:
    """Keep `integration/conftest.py` in test scope (#386) instead of a `test-helper` exclusion.

    Parameters:
        None.
    Returns:
        None: Any `conftest.py` is test scope and `python-harness` declares no exclusions.
    Raises:
        AssertionError: Pytest fixture modules become implementation inventory or regain an exclusion.
    """
    cfg = Policy.model_validate_json((ROOT / "coverage/policy.json").read_text())
    assert not cfg.packages["python-harness"].exclusions
    assert not cfg.packages["python-scripts"].exclusions
    assert is_test_path(Path("integration/conftest.py"))
    assert not is_test_path(Path("integration/harness/conftest_like.py"))


def test_ported_computer_suites_are_conventional_tests() -> None:
    """Keep the computer-use Vitest suites (#347) in test scope instead of helper classification.

    Parameters:
        None.
    Returns:
        None: Every ported suite is a conventional test file with no stale helper entry.
    Raises:
        AssertionError: A suite leaves `test/`, or a helper entry still names its old script.
    """
    cfg = Policy.model_validate_json((ROOT / "coverage/policy.json").read_text())
    helpers = {helper.path for helper in cfg.verification_helpers}
    suites = sorted((ROOT / "packages/computer-use/test").glob("*.test.mjs"))
    # The 26 ported suites plus #551, #637, #672, #646 and #648, by name: losing or renaming any fails,
    # while new suites (the #645 coverage work adds many) need no edit here.
    required = {
        "act-outcomes.test.mjs",
        "app-policy.test.mjs",
        "async.test.mjs",
        "bounded-output.test.mjs",
        "cleanup.test.mjs",
        "commit-messages.test.mjs",
        "desktop-tools.test.mjs",
        "find-params.test.mjs",
        "invariants.test.mjs",
        "linux-build-scripts.test.mjs",
        "linux-live.test.mjs",
        "linux-native.test.mjs",
        "local-signing.test.mjs",
        "macos-helper-live.test.mjs",
        "macos-helper-path.test.mjs",
        "macos-native-pure.test.mjs",
        "macos-observe-target.test.mjs",
        "managed-browser-headless.test.mjs",
        "managed-browser-profile.test.mjs",
        "outline-store.test.mjs",
        "platform-linux.test.mjs",
        "platform-windows.test.mjs",
        "runtime-concurrency.test.mjs",
        "rust-coverage.test.mjs",
        "session-lifecycle.test.mjs",
        "swift-sdk.test.mjs",
        "sync-ledger.test.mjs",
        "tool-schemas.test.mjs",
        "unpaired-act.test.mjs",
        "windows-build-scripts.test.mjs",
        "wsl2-diagnostics.test.mjs",
    }
    assert required <= {suite.name for suite in suites}
    for suite in suites:
        assert is_test_path(suite.relative_to(ROOT))
    for moved in [
        "check-linux-build-scripts.mjs",
        "check-platform-linux.mjs",
        "check-cleanup.test.mjs",
        "check-linux-native.mjs",
        "check-macos-helper-live.mjs",
        "check-windows-build-scripts.mjs",
    ]:
        assert f"packages/computer-use/scripts/{moved}" not in helpers
        assert not (ROOT / "packages/computer-use/scripts" / moved).exists()


def test_unaudited_languages_are_owned_pending_or_tracked_unmeasured() -> None:
    """Pin the #694 classification of previously invisible Swift, shell and fork source.

    Parameters:
        None.
    Returns:
        None: Every Swift/shell/PowerShell file is inventoried or test scope, and forks stay tracked.
    Raises:
        AssertionError: A language slipped out of the inventory or the fork skip lost its issue.
    """
    cfg = Policy.model_validate_json((ROOT / "coverage/policy.json").read_text())
    covered = {file for scope in inventory_scopes(ROOT, cfg).values() for file in scope}
    trees = [tree.path for tree in cfg.unmeasured_trees]
    files = repository_files(ROOT)
    for suffix in (".swift", ".sh", ".ps1"):
        for file in {
            f for f in files if f.endswith(suffix) and not any(Path(f).is_relative_to(t) for t in trees)
        }:
            assert file in covered or is_test_path(Path(file)), file
    assert "packages/computer-use/native/macos/agent_cursor_tests.swift" not in covered
    assert "packages/computer-use/scripts/make-signing-cert.sh" in covered
    assert "scripts/merge-pr.sh" in covered
    assert cfg.packages["shell-scripts"].status == "pending"
    assert "#695" in cfg.packages["shell-scripts"].note
    assert [(t.path, t.issue) for t in cfg.unmeasured_trees] == [("forks", 693)]


INERT_BY_DECISION = {
    ".github/actions/capture-ci-wsl/action.yml",
    ".github/actions/report-plan/action.yml",
    ".github/actions/setup-ci-tools/action.yml",
    ".github/actions/setup-ci-wsl/action.yml",
    ".github/workflows/ci.yml",
    ".github/workflows/forks.yml",
    ".github/workflows/installer.yml",
    ".github/workflows/native-helper.yml",
    ".github/workflows/promote-stack.yml",
    ".github/workflows/publish.yml",
    ".github/workflows/runner-rescue.yml",
    ".github/workflows/runner-smoke.yml",
    ".github/workflows/wsl-watchdog.yml",
    "Makefile",
    "benchmarks/comparison/Makefile",
    "integration/Makefile",
    "packages/computer-use/.github/FUNDING.yml",
    "packages/computer-use/.github/dependabot.yml",
    "packages/computer-use/.github/workflows/ci.yml",
    "packages/computer-use/.github/workflows/docs.yml",
    "packages/computer-use/.github/workflows/npm-audit.yml",
    "packages/computer-use/.github/workflows/publish-npm.yml",
    "packages/subagents/.github/FUNDING.yml",
    "packages/subagents/.github/workflows/ci.yml",
}


def test_makefiles_and_yaml_are_inert_by_decision_until_695() -> None:
    """Pin the Makefiles and YAML the audit treats as inert, so adding one is a deliberate choice.

    Parameters:
        None.
    Returns:
        None: The tracked Makefile and YAML set equals the pinned list (#695).
    Raises:
        AssertionError: A new Makefile or workflow appeared, or one was removed, without updating the pin.
    """
    found = {
        file
        for file in repository_files(ROOT)
        if not file.startswith("forks/")
        and (Path(file).name == "Makefile" or Path(file).suffix in {".yml", ".yaml"})
    }
    assert found == INERT_BY_DECISION
    doc = (ROOT / "docs/coverage.md").read_text()
    assert "inert by decision" in doc
    assert "#695" in doc
