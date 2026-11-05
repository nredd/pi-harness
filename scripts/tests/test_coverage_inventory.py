"""Expand owned inventories, exclusions, verification helpers and the membership ratchet.

References:
    ../../docs/coverage.md
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from coverage_fixtures import (
    FIXTURES,
    JS_SUFFIXES,
    commit_base,
    policy,
    scope_fixture,
    setup_report,
)

from coverage_accounting import (
    Exclusion,
    Package,
    Policy,
    Reclassification,
    Signal,
    VerificationHelper,
    account,
    audit_inventory,
    check_inventory_ratchet,
    inventory,
    repository_files,
)


@pytest.mark.parametrize("reason", ["", "   "])
def test_exclusion_requires_a_reason(reason: str) -> None:
    """Require substantive exclusion explanations.

    Parameters:
        reason (str): Empty or whitespace-only justification.
    Returns:
        None: Policy validation rejects the exclusion.
    Raises:
        AssertionError: An unreasoned exclusion passes.
    """
    data = policy().model_dump()
    data["packages"]["example"]["exclusions"] = [
        {"path": "src/types.ts", "kind": "type-only", "reason": reason},
    ]
    with pytest.raises(ValidationError):
        Policy.model_validate(data)


def test_excluded_declaration_is_not_executable_scope(tmp_path: Path) -> None:
    """Keep genuine declarations outside executable measurement.

    Parameters:
        tmp_path (Path): Disposable source and report root.
    Returns:
        None: A reasoned declaration exclusion leaves executable accounting intact.
    Raises:
        AssertionError: A declaration is measured as production execution.
    """
    setup_report(tmp_path)
    (tmp_path / "packages/example/src/types.ts").write_text("export type Value = string;\n")
    data = policy().model_dump()
    data["packages"]["example"]["exclusions"] = [
        {"path": "src/types.ts", "kind": "type-only", "reason": "No executable JavaScript."},
    ]
    cfg = Policy.model_validate(data)
    assert inventory(tmp_path, cfg.packages["example"]) == {"src/index.ts"}
    assert not account(tmp_path, cfg)[1]


def test_new_owned_file_requires_measurement(tmp_path: Path) -> None:
    """Detect never-imported source newly matched by ownership.

    Parameters:
        tmp_path (Path): Disposable source and report root.
    Returns:
        None: An incomplete primary measurement fails.
    Raises:
        AssertionError: Newly owned source silently disappears from the denominator.
    """
    setup_report(tmp_path)
    (tmp_path / "packages/example/src/new.ts").write_text("export const value = 0;\n")
    assert "Primary signal must measure every owned" in account(tmp_path, policy())[1][0]


def test_unknown_sibling_is_not_silently_discarded(tmp_path: Path) -> None:
    """Require reviewed ownership for imported sibling source.

    Parameters:
        tmp_path (Path): Disposable report and source root.
    Returns:
        None: Unknown sibling production source fails.
    Raises:
        AssertionError: Uninventoried imported source is discarded silently.
    """
    report = setup_report(tmp_path)
    report.write_text(report.read_text().replace("src/index.ts", "../unknown/src/index.ts"))
    assert "Report file not in policy" in account(tmp_path, policy())[1][0]


def test_generated_artifact_exclusions_need_not_be_owned_source(tmp_path: Path) -> None:
    """Allow reviewed generated-output duplicates outside production scope.

    Parameters:
        tmp_path (Path): Disposable report and source root.
    Returns:
        None: Generated output is not added to production counters.
    Raises:
        AssertionError: A justified generated duplicate corrupts accounting.
    """
    report = setup_report(tmp_path)
    generated = report.read_text().replace("src/index.ts", "dist/chunks/generated.ts")
    report.write_text(report.read_text() + generated)
    data = policy().model_dump()
    data["packages"]["example"]["exclusions"] = [
        {"path": "dist/**/*.ts", "kind": "generated", "reason": "Builder duplicates src/."},
    ]
    assert not account(tmp_path, Policy.model_validate(data))[1]


def test_test_helper_cannot_overlap_owned_inventory(tmp_path: Path) -> None:
    """Reject overlap between explicit helper and production declarations.

    Parameters:
        tmp_path (Path): Disposable report and source root.
    Returns:
        None: Inventory validation rejects the overlap.
    Raises:
        AssertionError: A helper declaration bypasses owned production scope.
    """
    setup_report(tmp_path)
    cfg = policy()
    cfg.packages["example"].test_helpers = ["src/index.ts"]
    with pytest.raises(ValueError, match="overlap"):
        inventory(tmp_path, cfg.packages["example"])


@pytest.mark.parametrize(
    "change", ["owned", "exclusion", "facade", "root", "rename", "delete", "runtime", "test-path"]
)
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
    elif change == "facade":
        source.write_text('export { answer } from "./kept.js";\n')
        package.exclusions.append(
            Exclusion(path="src/index.ts", kind="non-executable-facade", reason="Re-export only facade.")
        )
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


@pytest.mark.parametrize("operation", ["rename", "delete", "exclusion", "facade"])
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
    elif operation == "facade":
        (tmp_path / path).write_text('export { answer } from "./kept.js";\n')
        current.packages["example"].exclusions.append(
            Exclusion(path="src/index.ts", kind="non-executable-facade", reason="Re-export only facade.")
        )
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


def test_removed_pending_package_still_needs_a_reclassification_per_file(tmp_path: Path) -> None:
    """Prove `check_ratchet` skipping a removed pending package does not drop its sources silently.

    Parameters:
        tmp_path (Path): Disposable repository root.
    Returns:
        None: Each file the deleted pending package owned needs its own reasoned entry.
    Raises:
        AssertionError: A pending package and its source can vanish without a declaration.
    """
    setup_report(tmp_path)
    (tmp_path / "packages/pending").mkdir(parents=True)
    for name in ["a.ts", "b.ts"]:
        (tmp_path / "packages/pending" / name).write_text("export const probe = 1;\n")
    base = policy()
    base.packages["pending"] = Package(
        root="packages/pending", owned=["*.ts"], exclusions=[], status="pending", note="Later.", signals={}
    )
    commit_base(tmp_path, base)
    current = policy()
    with pytest.raises(ValueError, match="Inventory ratchet requires"):
        check_inventory_ratchet(tmp_path, current, base, "HEAD")
    entries = [
        Reclassification(package="pending", path=f"packages/pending/{name}", reason="Measured elsewhere now.")
        for name in ["a.ts", "b.ts"]
    ]
    for kept in entries:
        current.reclassifications = [kept]
        with pytest.raises(ValueError, match="Inventory ratchet requires"):
            check_inventory_ratchet(tmp_path, current, base, "HEAD")
    current.reclassifications = entries
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


def write_script(root: Path, relative: str) -> None:
    """Create an untracked executable-language source fixture.

    Parameters:
        root (Path): Disposable repository root.
        relative (str): Repository-relative script path.
    Returns:
        None: A JavaScript fixture exists without automatic classification.
    Raises:
        OSError: The fixture cannot be written.
    """
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("globalThis.verificationRan = true;\n")


@pytest.mark.parametrize("suffix", sorted(JS_SUFFIXES))
@pytest.mark.parametrize(
    "stem",
    [
        "scripts/unclassified",
        "integration/providers/unclassified",
        "packages/example/unclassified",
        "scripts/vitest.config",
    ],
)
def test_unclassified_javascript_fails_the_git_listed_scan(tmp_path: Path, suffix: str, stem: str) -> None:
    """Detect JavaScript additions in every existing scanned root, including configs.

    Parameters:
        tmp_path (Path): Disposable repository root.
        suffix (str): Executable JavaScript file extension.
        stem (str): New unclassified source location.
    Returns:
        None: The exact new nonignored path is rejected by the real Git-listed traversal.
    Raises:
        AssertionError: An extension, root or configuration filename escapes the audit.
    """
    cfg = scope_fixture(tmp_path)
    path = stem + suffix
    write_script(tmp_path, path)
    assert audit_inventory(tmp_path, cfg, repository_files(tmp_path)) == {path}


@pytest.mark.parametrize("suffix", sorted(JS_SUFFIXES))
def test_reasoned_verification_classification_passes(tmp_path: Path, suffix: str) -> None:
    """Allow an exact reasoned verification-only file without calling it production.

    Parameters:
        tmp_path (Path): Disposable repository root.
        suffix (str): Executable JavaScript file extension.
    Returns:
        None: Explicit verification classification accounts for the new harness path.
    Raises:
        AssertionError: Reasoned verification infrastructure remains unclassified.
    """
    cfg = scope_fixture(tmp_path)
    path = "scripts/verify-contract" + suffix
    write_script(tmp_path, path)
    cfg.verification_helpers = [
        VerificationHelper(path=path, reason="Synthetic contract assertion harness; not shipped.")
    ]
    assert not audit_inventory(tmp_path, cfg, repository_files(tmp_path))


def test_configurations_require_an_explicit_reasoned_classification(tmp_path: Path) -> None:
    """Require policy evidence for configuration files rather than an implicit suffix exemption.

    Parameters:
        tmp_path (Path): Disposable repository root.
    Returns:
        None: A configuration fails until explicitly classified with its tool-only role.
    Raises:
        AssertionError: Configuration naming alone suppresses executable source.
    """
    cfg = scope_fixture(tmp_path)
    path = "scripts/biome.config.js"
    write_script(tmp_path, path)
    files = repository_files(tmp_path)
    assert audit_inventory(tmp_path, cfg, files) == {path}
    cfg.verification_helpers = [
        VerificationHelper(path=path, reason="Tool configuration for this verification fixture; not shipped.")
    ]
    assert not audit_inventory(tmp_path, cfg, files)


@pytest.mark.parametrize("reason", ["", "   "])
def test_verification_helpers_require_a_per_file_reason(reason: str) -> None:
    """Reject empty verification-only explanations.

    Parameters:
        reason (str): Invalid per-file justification.
    Returns:
        None: Classification validation fails.
    Raises:
        AssertionError: An unexplained helper entry is accepted.
    """
    with pytest.raises(ValidationError):
        VerificationHelper(path="scripts/verify.mjs", reason=reason)


@pytest.mark.parametrize("path", ["scripts/*.mjs", "scripts/check-?.mjs", "../verify.mjs", "/verify.mjs"])
def test_verification_helpers_cannot_be_blanket_or_escaping_paths(path: str) -> None:
    """Keep helper classifications exact, repository-relative and individually reviewable.

    Parameters:
        path (str): Invalid wildcard or escaping declaration.
    Returns:
        None: Invalid declarations fail before filesystem traversal.
    Raises:
        AssertionError: A blanket or escaping helper rule passes validation.
    """
    with pytest.raises(ValidationError, match="exact repository-relative"):
        VerificationHelper(path=path, reason="Verification fixture.")


@pytest.mark.parametrize("invalid", ["duplicate", "missing", "production"])
def test_helper_classification_cannot_hide_invalid_or_owned_source(tmp_path: Path, invalid: str) -> None:
    """Reject stale, duplicated or production-overlapping helper declarations.

    Parameters:
        tmp_path (Path): Disposable repository root.
        invalid (str): Invalid classification state.
    Returns:
        None: The audit rejects ambiguous or unsafe classifications.
    Raises:
        AssertionError: A verification label bypasses source ownership.
    """
    cfg = scope_fixture(tmp_path)
    path = "scripts/verify.mjs"
    write_script(tmp_path, path)
    helper = VerificationHelper(path=path, reason="Fixture assertions, not shipped code.")
    cfg.verification_helpers = [helper]
    if invalid == "duplicate":
        cfg.verification_helpers.append(helper.model_copy(deep=True))
    elif invalid == "missing":
        (tmp_path / path).unlink()
    else:
        (tmp_path / path).unlink()
        helper.path = "packages/example/src/index.ts"
    with pytest.raises(ValueError, match=r"Verification helpers|verification_helpers"):
        audit_inventory(tmp_path, cfg, repository_files(tmp_path))


def test_verification_classification_does_not_bypass_the_tree_ratchet(tmp_path: Path) -> None:
    """Require a separate reviewed reclassification when production becomes verification.

    Parameters:
        tmp_path (Path): Disposable repository root.
    Returns:
        None: A helper label alone fails; an explicit reasoned ownership change passes.
    Raises:
        AssertionError: New helper declarations erase previous production membership silently.
    """
    base = scope_fixture(tmp_path)
    current = base.model_copy(deep=True)
    current.packages["example"].owned = ["src/kept.ts"]
    path = "packages/example/src/index.ts"
    current.verification_helpers = [
        VerificationHelper(path=path, reason="Now used only for fixture assertions.")
    ]
    assert not audit_inventory(tmp_path, current, repository_files(tmp_path))
    with pytest.raises(ValueError, match="Inventory ratchet"):
        check_inventory_ratchet(tmp_path, current, base, "HEAD")
    current.reclassifications = [
        Reclassification(
            package="example",
            path=path,
            reason="Move the obsolete implementation into verification-only fixtures.",
        )
    ]
    check_inventory_ratchet(tmp_path, current, base, "HEAD")


def test_classified_report_helpers_do_not_pollute_production_counters(tmp_path: Path) -> None:
    """Use the same exact helper classification when scoping imported LCOV records.

    Parameters:
        tmp_path (Path): Disposable source and report root.
    Returns:
        None: Explicit verification source is outside production counters.
    Raises:
        AssertionError: A classified helper creates an unknown-source failure or changes counters.
    """
    report = setup_report(tmp_path)
    cfg = policy()
    path = "scripts/verify.mjs"
    write_script(tmp_path, path)
    cfg.verification_helpers = [
        VerificationHelper(path=path, reason="Synthetic report verification fixture.")
    ]
    helper = (FIXTURES / "passing.info").read_text().replace("src/index.ts", "../../scripts/verify.mjs")
    report.write_text(report.read_text() + helper)
    results, errors = account(tmp_path, cfg)
    assert not errors
    assert len(results) == 1
    assert results[0]["lines"] == 2
