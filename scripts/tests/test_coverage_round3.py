"""Cover executable JavaScript ownership and exact verification-only classifications.

References:
    ../../docs/coverage.md
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from coverage_accounting import (
    Policy,
    Reclassification,
    VerificationHelper,
    account,
    audit_inventory,
    check_inventory_ratchet,
    inventory,
    repository_files,
)
from tests.test_coverage_accounting import FIXTURES, policy, setup_report
from tests.test_coverage_round2 import scope_fixture

ROOT = Path(__file__).resolve().parents[2]
JS_SUFFIXES = {".mjs", ".cjs", ".js"}


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
        "scripts/router_contract.mjs",
        "packages/computer-use/scripts/pi-cubench-agent.mjs",
        "packages/computer-use/scripts/check-linux-build-scripts.mjs",
        "packages/computer-use/scripts/check-linux-native.mjs",
        "packages/computer-use/scripts/check-platform-linux.mjs",
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
