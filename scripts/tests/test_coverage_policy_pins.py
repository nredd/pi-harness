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
    audit_inventory,
    inventory,
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
        None: A package owns the source: measured by a real producer, or pending with a follow-up.
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
    if file.endswith(".py"):
        # Python has a pytest-cov LCOV producer: measured and held at its per-OS floor (`ratchet`).
        assert all(
            package.status == "measured"
            and package.goal == "ratchet"
            and package.goal_reason.strip()
            and package.signals["primary"].enforcement == "enforced"
            for package in owners
        )
    elif file.startswith("integration/probes/"):
        # Since #377 every probe runs in process under `check-probes`: measured and enforced at 0/0.
        assert all(
            package.status == "measured"
            and package.goal == "100-percent"
            and package.signals["primary"].enforcement == "enforced"
            for package in owners
        )
    else:
        assert all(package.status == "pending" and package.note.strip() for package in owners)


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
        ]
        for path in ROOT.glob(pattern)
    }
    assert inventory(ROOT, audit) == {
        "scripts/check-biome-paths.mjs",
        "scripts/import_audit.ts",
        "scripts/router_contract.mjs",
        "scripts/run-vitest.ts",
        *configs,
    }
    assert len(configs) == 15, configs
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
    for path in directory.glob("scripts/check-*.mjs"):
        if published_path(path.relative_to(directory), manifest["files"]):
            continue
        relative = path.relative_to(ROOT).as_posix()
        assert helpers.get(relative, "").strip(), relative


@pytest.mark.parametrize(
    "path",
    [
        "packages/computer-use/scripts/pi-cubench-agent.mjs",
        "packages/computer-use/scripts/check-linux-live.mjs",
        "packages/computer-use/scripts/check-package-assets.mjs",
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
    # The 26 ported suites plus #551's SDK preparation regression suite.
    assert len(suites) == 27
    assert (ROOT / "packages/computer-use/test/swift-sdk.test.mjs") in suites
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
