"""Keep owner-approved goal scope separate from mandatory source/report accounting.

References:
    ../../docs/coverage.md
"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError
from test_coverage_accounting import policy, setup_report

from coverage_accounting import Policy, account, check_ratchet


def report_only_policy() -> Policy:
    """Return a reasoned verification-only policy with the global goal enabled.

    Parameters:
        None.
    Returns:
        Policy: Validated report-only fixture policy.
    Raises:
        ValidationError: The fixture declaration is invalid.
    """
    data = policy().model_dump()
    data["enforce_target"] = True
    package = data["packages"]["example"]
    package["goal"] = "report-only"
    package["goal_reason"] = "Verification-only fixture, outside the owned package goal."
    package["signals"]["primary"]["enforcement"] = "report-only"
    package["signals"]["primary"]["reason"] = "Diagnostic verification coverage."
    return Policy.model_validate(data)


def test_report_only_primary_still_validates_missing_reports(tmp_path: Path) -> None:
    """Require reports outside the global goal, without enforcing uncovered counters.

    Parameters:
        tmp_path (Path): Disposable report root.
    Returns:
        None: Uncovered diagnostics pass and a missing report fails closed.
    Raises:
        AssertionError: Diagnostics enforce budgets or waive report validation.
    """
    report = setup_report(tmp_path, "passing.info")
    report.write_text(report.read_text().replace("DA:1,1", "DA:1,0").replace("LH:2", "LH:1"))
    cfg = report_only_policy()
    assert not account(tmp_path, cfg)[1]
    report.unlink()
    assert account(tmp_path, cfg)[1]


def test_excluded_pending_inventory_does_not_block_target(tmp_path: Path) -> None:
    """Keep excluded source visible without inventing measurements or blocking the goal.

    Parameters:
        tmp_path (Path): Disposable source root.
    Returns:
        None: Excluded pending source passes; eligible pending source fails.
    Raises:
        AssertionError: Pending scope is ignored or misapplied.
    """
    setup_report(tmp_path)
    data = report_only_policy().model_dump()
    package = data["packages"]["example"]
    package |= {"goal": "excluded", "status": "pending", "note": "Owner exclusion.", "signals": {}}
    assert not account(tmp_path, Policy.model_validate(data))[1]
    package |= {"goal": "100-percent", "goal_reason": ""}
    assert "Unmeasured package" in account(tmp_path, Policy.model_validate(data))[1][0]


def test_goal_downgrade_cannot_bypass_base_ratchet() -> None:
    """Reject removal of eligible packages from an established global goal.

    Parameters:
        None.
    Returns:
        None: A scope downgrade cannot waive an enforced or pending package.
    Raises:
        AssertionError: The base goal can be silently weakened.
    """
    data = policy().model_dump()
    data["packages"]["example"] |= {"status": "pending", "note": "Awaiting clean producer.", "signals": {}}
    previous = Policy.model_validate(data)
    data["packages"]["example"] |= {"goal": "excluded", "goal_reason": "Attempt to bypass pending source."}
    with pytest.raises(ValueError, match="Cannot remove package from global goal"):
        check_ratchet(Policy.model_validate(data), previous)


def test_goal_exceptions_require_reason_and_report_only_signals() -> None:
    """Reject blank scope explanations and enforced signals outside the goal.

    Parameters:
        None.
    Returns:
        None: Invalid scope declarations fail schema validation.
    Raises:
        AssertionError: Invalid declarations pass schema validation.
    """
    data = report_only_policy().model_dump()
    package = data["packages"]["example"]
    package["goal_reason"] = " "
    with pytest.raises(ValidationError, match="goal_reason"):
        Policy.model_validate(data)
    package["goal_reason"] = "Verification infrastructure."
    package["signals"]["primary"]["enforcement"] = "enforced"
    with pytest.raises(ValidationError, match="outside the global goal"):
        Policy.model_validate(data)
