"""Lock down reviewed policy contracts, immutable-tree scope and independent counters.

References:
    ../../docs/coverage.md
"""

from __future__ import annotations

import ast
import json
import shutil
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from coverage_accounting import (
    Counts,
    Exclusion,
    Package,
    Policy,
    Reclassification,
    Signal,
    VerificationHelper,
    account,
    audit_inventory,
    check_inventory_ratchet,
    git_read,
    inventory,
    parse_lcov,
    repository_files,
)
from tests.test_coverage_accounting import FIXTURES, SCRIPT, policy, setup_report

ROOT = Path(__file__).resolve().parents[2]


def commit_base(root: Path, cfg: Policy) -> None:
    """Persist a miniature policy and its source in a real immutable Git commit.

    Parameters:
        root (Path): Disposable repository directory.
        cfg (Policy): Base ownership and coverage declarations.
    Returns:
        None: HEAD contains the base policy and original source.
    Raises:
        subprocess.CalledProcessError: A fixture Git operation fails.
    """
    (root / "coverage").mkdir(exist_ok=True)
    (root / "coverage/policy.json").write_text(cfg.model_dump_json())
    for args in [
        ["init", "-q"],
        ["add", "."],
        [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "Base",
        ],
    ]:
        git_read(root, args)


def scope_fixture(root: Path) -> Policy:
    """Create a two-file source inventory whose base survives working-tree mutation.

    Parameters:
        root (Path): Disposable repository directory.
    Returns:
        Policy: Policy committed alongside both original source files.
    Raises:
        OSError: Fixture files cannot be written.
        subprocess.CalledProcessError: Git cannot commit the base.
    """
    setup_report(root)
    (root / "packages/example/src/kept.ts").write_text("export const kept = 1;\n")
    cfg = policy()
    cfg.packages["example"].signals["primary"].files = None
    commit_base(root, cfg)
    return cfg


def test_git_commands_capture_stderr(tmp_path: Path) -> None:
    """Require the subprocess stderr contract on the actual common Git reader.

    Parameters:
        tmp_path (Path): Pytest temporary directory.
    Returns:
        None: Git is executed with combined output.
    Raises:
        AssertionError: The stderr contract regresses.
    """
    with patch("coverage_accounting.subprocess.check_output", wraps=subprocess.check_output) as command:
        assert git_read(tmp_path, ["--version"]).startswith("git version")
    assert command.call_args.kwargs.get("stderr") == subprocess.STDOUT
    assert command.call_args.kwargs.get("text") is True


def test_failed_git_diagnostics_reach_summary(tmp_path: Path) -> None:
    """Retain real failed-command diagnostics, not just the command's exit status.

    Parameters:
        tmp_path (Path): Disposable Git fixture root.
    Returns:
        None: The invalid base fails with a diagnostic summary.
    Raises:
        AssertionError: Fatal Git output is lost or accepted as success.
    """
    scope_fixture(tmp_path)
    summary = tmp_path / "summary.json"
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--root",
            str(tmp_path),
            "--base",
            "invalid-base",
            "--summary",
            str(summary),
        ],
        check=False,
        capture_output=True,
    )
    assert result.returncode == 1
    assert "fatal:" in json.loads(summary.read_text())["errors"][0]


def test_serialized_policy_fields_have_descriptions() -> None:
    """Check every serialized field, including inherited and newly added declarations.

    Parameters:
        None.
    Returns:
        None: All serialized fields carry substantive descriptions.
    Raises:
        AssertionError: A policy field lacks its documented contract.
    """
    for model in [Counts, Exclusion, Signal, Package, Policy, Reclassification, VerificationHelper]:
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
    paths = [SCRIPT, *Path(__file__).parent.glob("test_coverage_*.py")]
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


@pytest.mark.parametrize("change", ["owned", "exclusion", "root", "rename", "delete", "runtime", "test-path"])
def test_tree_ratchet_rejects_undeclared_membership_loss(tmp_path: Path, change: str) -> None:
    """Reject source-denominator changes even when budgets stay unchanged.

    Parameters:
        tmp_path (Path): Disposable repository root.
        change (str): Source membership bypass attempted against the committed tree.
    Returns:
        None: Every undeclared loss fails against the real base inventory.
    Raises:
        AssertionError: Current-only expansion hides a loss.
    """
    base = scope_fixture(tmp_path)
    if change == "runtime":
        base.packages["example"].signals["runtime"] = Signal.model_validate(
            {
                "report": "coverage/runtime.info",
                "files": ["src/index.ts", "src/kept.ts"],
                "max_uncovered": {
                    "darwin": {"lines": 0, "functions": 0},
                    "linux": {"lines": 0, "functions": 0},
                },
                "reporters": ["text", "lcov"],
            }
        )
        commit_base(tmp_path, base)
    current = base.model_copy(deep=True)
    package = current.packages["example"]
    source = tmp_path / "packages/example/src/index.ts"
    if change == "owned":
        package.owned = ["src/kept.ts"]
    elif change == "exclusion":
        package.exclusions.append(Exclusion(path="src/index.ts", kind="generated", reason="Generated claim."))
    elif change == "root":
        shutil.copytree(tmp_path / package.root, tmp_path / "packages/replacement")
        package.root = "packages/replacement"
    elif change in {"rename", "test-path"}:
        target = source.with_name("renamed.ts") if change == "rename" else source.parent / "fixtures/index.ts"
        target.parent.mkdir(exist_ok=True)
        source.rename(target)
    elif change == "delete":
        source.unlink()
    else:
        package.signals["runtime"].files = ["src/kept.ts"]
    with pytest.raises(ValueError, match="Inventory ratchet"):
        check_inventory_ratchet(tmp_path, current, base, "HEAD")


@pytest.mark.parametrize("operation", ["rename", "delete", "exclusion"])
def test_explicit_reasoned_reclassification_allows_legitimate_change(tmp_path: Path, operation: str) -> None:
    """Allow deliberate reviewed removals, moves and source-to-helper changes.

    Parameters:
        tmp_path (Path): Disposable repository root.
        operation (str): Legitimate ownership change with an explicit reason.
    Returns:
        None: The new reasoned declaration accounts for the exact lost base path.
    Raises:
        AssertionError: Valid reviewed source maintenance is rejected.
    """
    base = scope_fixture(tmp_path)
    current = base.model_copy(deep=True)
    path = "packages/example/src/index.ts"
    replacement = None
    if operation == "rename":
        replacement = "packages/example/src/renamed.ts"
        (tmp_path / path).rename(tmp_path / replacement)
    elif operation == "delete":
        (tmp_path / path).unlink()
    else:
        current.packages["example"].exclusions.append(
            Exclusion(path="src/index.ts", kind="test-helper", reason="Retained only as a fixture helper.")
        )
    current.reclassifications = [
        Reclassification(
            package="example",
            path=path,
            replacement=replacement,
            reason=f"Reviewed {operation} of obsolete implementation.",
        )
    ]
    check_inventory_ratchet(tmp_path, current, base, "HEAD")


@pytest.mark.parametrize("invalid", ["duplicate", "stale", "replacement"])
def test_invalid_reclassification_cannot_approve_loss(tmp_path: Path, invalid: str) -> None:
    """Reject ambiguous approvals and nonexistent replacement identities.

    Parameters:
        tmp_path (Path): Disposable repository root.
        invalid (str): Invalid declaration shape to introduce.
    Returns:
        None: The malformed approval does not authorize inventory loss.
    Raises:
        AssertionError: A duplicate, unrelated or invalid approval passes.
    """
    base = scope_fixture(tmp_path)
    current = base.model_copy(deep=True)
    (tmp_path / "packages/example/src/index.ts").unlink()
    entry = Reclassification(
        package="example", path="packages/example/src/index.ts", reason="Remove obsolete code."
    )
    current.reclassifications = [entry]
    if invalid == "duplicate":
        current.reclassifications.append(entry.model_copy(deep=True))
    elif invalid == "stale":
        entry.path = "packages/example/src/kept.ts"
    else:
        entry.replacement = "packages/example/src/nonexistent.ts"
    with pytest.raises(ValueError, match=r"reclassification|Replacement"):
        check_inventory_ratchet(tmp_path, current, base, "HEAD")


@pytest.mark.parametrize("path", ["/outside.ts", "../outside.ts"])
def test_reclassification_paths_must_be_repository_relative(path: str) -> None:
    """Prevent approval entries escaping the reviewed repository namespace.

    Parameters:
        path (str): Absolute or parent-traversing path.
    Returns:
        None: Declaration validation rejects the path.
    Raises:
        AssertionError: A nonrepository path is accepted.
    """
    with pytest.raises(ValidationError, match="repository-relative"):
        Reclassification(package="example", path=path, reason="Invalid namespace.")


@pytest.mark.parametrize("reason", ["", "   "])
def test_reclassification_requires_a_reason(reason: str) -> None:
    """Reject empty or whitespace-only source-membership approvals.

    Parameters:
        reason (str): Invalid approval justification.
    Returns:
        None: Validation rejects the declaration.
    Raises:
        AssertionError: An unreasoned reclassification is accepted.
    """
    with pytest.raises(ValidationError):
        Reclassification(package="example", path="packages/example/src/index.ts", reason=reason)


def test_historical_reclassification_cannot_authorize_a_new_loss(tmp_path: Path) -> None:
    """Require a newly reviewed entry rather than recycling a historical approval.

    Parameters:
        tmp_path (Path): Disposable repository root.
    Returns:
        None: Reusing the base's declaration fails for a new loss.
    Raises:
        AssertionError: A historical entry silently authorizes a second removal.
    """
    base = scope_fixture(tmp_path)
    base.reclassifications = [
        Reclassification(
            package="example",
            path="packages/example/src/index.ts",
            reason="An earlier removal, subsequently restored.",
        )
    ]
    commit_base(tmp_path, base)
    current = base.model_copy(deep=True)
    (tmp_path / "packages/example/src/index.ts").unlink()
    with pytest.raises(ValueError, match="Inventory ratchet"):
        check_inventory_ratchet(tmp_path, current, base, "HEAD")


def test_pending_inventory_still_requires_existing_sources(tmp_path: Path) -> None:
    """Validate pending source declarations without inventing a measured report.

    Parameters:
        tmp_path (Path): Disposable source and report root.
    Returns:
        None: A nonexistent pending source pattern fails before signal accounting.
    Raises:
        AssertionError: Pending status bypasses inventory validation.
    """
    setup_report(tmp_path)
    cfg = policy()
    package = cfg.packages["example"]
    package.status = "pending"
    package.note = "Coverage instrumentation follow-up."
    package.signals.clear()
    package.owned = ["missing.py"]
    with pytest.raises(ValueError, match="Owned pattern matches no files"):
        account(tmp_path, cfg)


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


def test_audit_detects_uninventoried_new_ts_and_python(tmp_path: Path) -> None:
    """Prove the scan fails on executable additions rather than only known filenames.

    Parameters:
        tmp_path (Path): Disposable repository root.
    Returns:
        None: Both newly created nonignored source paths are rejected.
    Raises:
        AssertionError: Untracked source evades the repository-wide scan.
    """
    cfg = scope_fixture(tmp_path)
    paths = {"scripts/unowned.py", "integration/providers/unowned.ts"}
    for path in paths:
        target = tmp_path / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("unowned executable source\n")
    assert audit_inventory(tmp_path, cfg, repository_files(tmp_path)) == paths


@pytest.mark.parametrize(
    "file",
    [
        "scripts/coverage_accounting.py",
        "integration/harness/paths.py",
        "integration/probes/latency.ts",
        "integration/probes/render.ts",
        "integration/probes/session-kit-child-scope.ts",
        "integration/probes/transcript-types.ts",
        "integration/providers/faux.ts",
        "integration/providers/usage_fixture.ts",
    ],
)
def test_reviewed_missing_source_is_explicitly_pending(file: str) -> None:
    """Keep the review's identified executable source visible without inventing baselines.

    Parameters:
        file (str): Previously unaccounted executable repository path.
    Returns:
        None: A named pending package owns the source and explains the follow-up.
    Raises:
        AssertionError: The source is omitted or silently treated as measured.
    """
    cfg = Policy.model_validate_json((ROOT / "coverage/policy.json").read_text())
    owners = [
        package
        for package in cfg.packages.values()
        if Path(file).is_relative_to(package.root)
        and Path(file).relative_to(package.root).as_posix() in inventory(ROOT, package)
    ]
    assert owners, file
    assert all(package.status == "pending" and package.note.strip() for package in owners)
    if file.endswith(".py"):
        assert all("pytest-cov" in package.note for package in owners)


@pytest.mark.parametrize(
    ("fixture", "lines", "functions"), [("function-only.info", 0, 1), ("line-only.info", 1, 0)]
)
def test_independent_counter_budget_is_enforced(
    tmp_path: Path, fixture: str, lines: int, functions: int
) -> None:
    """Catch deletion of either metric predicate independently of the other.

    Parameters:
        tmp_path (Path): Disposable report/source root.
        fixture (str): LCOV with exactly one failing metric.
        lines (int): Expected uncovered lines.
        functions (int): Expected uncovered functions.
    Returns:
        None: The independently exceeded budget fails with exact integer diagnostics.
    Raises:
        AssertionError: Either uncovered metric stops being enforced.
    """
    setup_report(tmp_path, fixture)
    results, errors = account(tmp_path, policy())
    assert results[0]["uncovered_lines"] == lines
    assert results[0]["uncovered_functions"] == functions
    assert errors == [f"example/primary: Budget exceeded: {lines} lines, {functions} functions"]


def test_valid_raw_report_filters_to_zero_owned_lines(tmp_path: Path) -> None:
    """Exercise the owned-zero guard separately from raw LCOV's zero-total rejection.

    Parameters:
        tmp_path (Path): Disposable report/source root.
    Returns:
        None: Valid positive-total LCOV with zero owned lines fails closed.
    Raises:
        AssertionError: Filtering nonowned counters can fabricate successful empty coverage.
    """
    report = setup_report(tmp_path)
    helper = (FIXTURES / "passing.info").read_text().replace("src/index.ts", "test/helper.ts")
    owned = "SF:src/index.ts\nFNF:0\nFNH:0\nLF:0\nLH:0\nend_of_record\n"
    report.write_text(helper + owned)
    assert sum(counter.lines for counter in parse_lcov(report.read_text()).values()) == 2
    assert account(tmp_path, policy())[1] == ["example/primary: Zero total owned lines"]
